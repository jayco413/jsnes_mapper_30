import CPU from "./cpu.js";
import Controller from "./controller.js";
import PPU from "./ppu/index.js";
import PAPU from "./papu/index.js";
import GameGenie from "./gamegenie.js";
import ROM from "./rom.js";
import { SECTOR_SIZE } from "./mappers/flash39sf040.js";

class NES {
  constructor(opts) {
    this.opts = {
      onFrame: function () {},
      onAudioSample: null,
      onStatusUpdate: function () {},
      onBatteryRamWrite: function () {},
      // Called when a self-flashing cartridge's flash actually changes, with
      // the index of the 4 KB sector affected. This is how a host page knows
      // the player's saved game moved and should be written somewhere that
      // outlives the tab. See the flash API below and
      // src/mappers/flash39sf040.js for what "actually changes" excludes.
      onFlashChange: null,

      emulateSound: true,
      sampleRate: 48000, // Sound sample rate in hz

      ...opts,
    };

    this.ui = {
      writeFrame: this.opts.onFrame,
      updateStatus: this.opts.onStatusUpdate,
    };
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.papu = new PAPU(this);
    this.gameGenie = new GameGenie();
    this.gameGenie.onChange = () => this.cpu._updateCartridgeLoader();
    this.mmap = null;
    this.controllers = {
      1: new Controller(),
      2: new Controller(),
    };

    this.fpsFrameCount = 0;
    this.romData = null;

    this.ui.updateStatus("Ready to load a ROM.");
  }

  // Resets the system
  reset() {
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.papu = new PAPU(this);

    if (this.mmap !== null) {
      this.mmap = this.rom.createMapper();
    }

    this.lastFpsTime = null;
    this.fpsFrameCount = 0;

    this.crashed = false;
  }

  // The frame loop. PPU is advanced inline after every CPU bus operation
  // (in cpu.load/write/push/pull). APU is clocked in bulk after each
  // instruction for compatibility with its sample timing logic.
  frame = () => {
    if (this.crashed) {
      throw new Error(
        "Game has crashed. Call reset() or loadROM() to restart.",
      );
    }
    this.controllers[1].clock();
    this.controllers[2].clock();
    this.ppu.startFrame();
    let cycles;
    const cpu = this.cpu;
    const ppu = this.ppu;
    const papu = this.papu;
    try {
      for (;;) {
        if (cpu.cyclesToHalt === 0) {
          // Execute a CPU instruction. PPU advancement happens inline
          // inside the bus operations (load/write/push/pull).
          cycles = cpu.emulate();

          // Clock APU with the full cycle count. The frame counter portion
          // subtracts any cycles already advanced by APU catch-up.
          papu.clockFrameCounter(cycles, cpu.apuCatchupCycles);
          cpu.apuCatchupCycles = 0;

          // Check if VBlank fired during inline PPU stepping.
          if (ppu.frameEnded) {
            ppu.frameEnded = false;
            break;
          }
        } else {
          // DMA halt cycles: step PPU per cycle. APU is clocked in bulk.
          let chunk = Math.min(cpu.cyclesToHalt, 8);
          for (let i = 0; i < chunk; i++) {
            ppu.advanceDots(3);
          }
          papu.clockFrameCounter(chunk);
          cpu.cyclesToHalt -= chunk;
          cpu._cpuCycleBase += chunk;

          if (ppu.frameEnded) {
            ppu.frameEnded = false;
            break;
          }
        }
      }
    } catch (e) {
      this.crashed = true;
      throw e;
    }
    this.fpsFrameCount++;
  };

  buttonDown = (controller, button) => {
    this.controllers[controller].buttonDown(button);
  };

  buttonUp = (controller, button) => {
    this.controllers[controller].buttonUp(button);
  };

  zapperMove = (x, y) => {
    if (!this.mmap) return;
    this.mmap.zapperX = x;
    this.mmap.zapperY = y;
  };

  zapperFireDown = () => {
    if (!this.mmap) return;
    this.mmap.zapperFired = true;
  };

  zapperFireUp = () => {
    if (!this.mmap) return;
    this.mmap.zapperFired = false;
  };

  getFPS() {
    const now = Date.now();
    let fps = null;
    if (this.lastFpsTime) {
      fps = this.fpsFrameCount / ((now - this.lastFpsTime) / 1000);
    }
    this.fpsFrameCount = 0;
    this.lastFpsTime = now;
    return fps;
  }

  reloadROM() {
    if (this.romData !== null) {
      this.loadROM(this.romData);
    }
  }

  // Loads a ROM file into the CPU and PPU.
  // The ROM file is validated first.
  loadROM(data) {
    // Load ROM file:
    this.rom = new ROM(this);
    this.rom.load(data);

    this.reset();
    this.mmap = this.rom.createMapper();
    this.mmap.loadROM();
    this.ppu.setMirroring(this.rom.getMirroringType());
    this.romData = data;
  }

  // Adjust audio sample timing for a non-standard host frame rate. At the
  // default 60fps each frame() produces ~800 samples at 48kHz. If the host
  // calls frame() less often (e.g. 30fps), the sample timer must fire more
  // frequently per CPU cycle so each frame still fills the audio buffer.
  setFramerate(rate) {
    this.papu.setFrameRate(rate);
  }

  // ------------------------------------------------------------------
  // Cartridge flash: reading and restoring the player's saved game.
  //
  // Games on UNROM 512 boards have no battery-backed RAM. They save by
  // rewriting a spare corner of their own program flash, which on real
  // hardware simply stays written. In an emulator it does not: the banks live
  // in memory that vanishes with the page. These methods are the way out and
  // back in.
  //
  // The unit is the chip's 4 KB SECTOR, because that is the smallest region
  // flash can erase and therefore the smallest region a game can rewrite from
  // scratch. A save is usually one or two of them, so persisting sectors
  // costs a few kilobytes where persisting the whole chip would cost half a
  // megabyte.
  //
  // Typical use by a host page:
  //
  //   const nes = new NES({ onFlashChange: () => scheduleSave() });
  //   // ... later, once the ROM is loaded and a save exists on the server:
  //   for (const { index, bytes } of saved) nes.writeFlashSector(index, bytes);
  //   // ... and when scheduleSave() finally fires:
  //   const sectors = nes.getDirtyFlashSectors()
  //     .map((index) => ({ index, bytes: nes.readFlashSector(index) }));
  //   nes.clearDirtyFlashSectors();
  //
  // Every method here returns a harmless value (false, 0, an empty array)
  // rather than throwing when the loaded cartridge has no flash, so a host
  // does not have to branch on the mapper before asking.
  // ------------------------------------------------------------------

  /** The flash chip, or null if this cartridge has none. */
  getFlash() {
    return this.mmap && this.mmap.flash ? this.mmap.flash : null;
  }

  /** True when the loaded cartridge can rewrite its own flash, i.e. can save. */
  hasFlash() {
    return this.getFlash() !== null;
  }

  /** Bytes per sector, the unit every sector method below works in. */
  getFlashSectorSize() {
    const flash = this.getFlash();
    return flash === null ? 0 : SECTOR_SIZE;
  }

  /** How many sectors the cartridge's flash has. */
  getFlashSectorCount() {
    const flash = this.getFlash();
    return flash === null ? 0 : flash.sectorCount;
  }

  /**
   * Sectors the running game has modified since clearDirtyFlashSectors().
   *
   * @returns {number[]} ascending sector indices; empty if there is no flash.
   */
  getDirtyFlashSectors() {
    const flash = this.getFlash();
    return flash === null ? [] : flash.getDirtySectors();
  }

  /** Forget the dirty set, once a host has persisted those sectors. */
  clearDirtyFlashSectors() {
    const flash = this.getFlash();
    if (flash !== null) {
      flash.clearDirtySectors();
    }
  }

  /**
   * Read one sector out, to be saved.
   *
   * @param {number} sectorIndex
   * @returns {Uint8Array|null} a copy, or null if there is no flash.
   */
  readFlashSector(sectorIndex) {
    const flash = this.getFlash();
    return flash === null ? null : flash.readSector(sectorIndex);
  }

  /**
   * Write one sector back, restoring a save.
   *
   * Restoring does not mark the sector dirty: the host already holds these
   * bytes, and marking them would have the very next save write them straight
   * back out again.
   *
   * @param {number} sectorIndex
   * @param {ArrayLike<number>} bytes - exactly getFlashSectorSize() bytes.
   * @returns {boolean} false if this cartridge has no flash to restore into.
   */
  writeFlashSector(sectorIndex, bytes) {
    const flash = this.getFlash();
    if (flash === null) {
      return false;
    }
    flash.writeSector(sectorIndex, bytes);
    return true;
  }

  /**
   * The whole chip, for a host that would rather hold one blob.
   *
   * @returns {Uint8Array|null}
   */
  getFlashData() {
    const flash = this.getFlash();
    return flash === null ? null : flash.snapshot();
  }

  /**
   * Replace the whole chip's contents.
   *
   * @param {ArrayLike<number>} bytes - exactly as long as getFlashData().
   * @returns {boolean} false if this cartridge has no flash.
   */
  setFlashData(bytes) {
    const flash = this.getFlash();
    if (flash === null) {
      return false;
    }
    flash.restore(bytes);
    return true;
  }

  toJSON() {
    return {
      // romData: this.romData,
      cpu: this.cpu.toJSON(),
      mmap: this.mmap.toJSON(),
      ppu: this.ppu.toJSON(),
      papu: this.papu.toJSON(),
      controllers: {
        1: this.controllers[1].toJSON(),
        2: this.controllers[2].toJSON(),
      },
    };
  }

  fromJSON(s) {
    this.reset();
    // this.romData = s.romData;
    this.cpu.fromJSON(s.cpu);
    this.mmap.fromJSON(s.mmap);
    this.ppu.fromJSON(s.ppu);
    this.papu.fromJSON(s.papu);
    if (s.controllers) {
      if (s.controllers[1]) this.controllers[1].fromJSON(s.controllers[1]);
      if (s.controllers[2]) this.controllers[2].fromJSON(s.controllers[2]);
    }
  }
}

export default NES;

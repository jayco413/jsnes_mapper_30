import Mapper0 from "./mapper0.js";
import Tile from "../tile.js";
import { copyArrayElements } from "../utils.js";
import Flash39SF040 from "./flash39sf040.js";

const CHR_RAM_BANK_SIZE = 0x2000;
const DEFAULT_CHR_RAM_BANK_COUNT = 4;
const MAX_CHR_RAM_BANK_COUNT = 4;

// UNROM 512 / Mapper 30
// 16 KB switchable PRG-ROM bank at $8000, last 16 KB bank fixed at $C000.
// Register bits 0-4 select PRG, bits 5-6 select an 8 KB CHR-RAM bank, and
// bit 7 controls mapper-provided mirroring modes on boards that support it.
// See https://www.nesdev.org/wiki/UNROM_512
class Mapper30 extends Mapper0 {
  static mapperName = "UNROM 512";

  constructor(nes) {
    super(nes);

    this.prgBank = 0;
    this.chrBankSelect = 0;
    this.chrBank = 0;
    this.chrRamMapped = false;
    this.mirroringBit = 0;
    this.leds = 0xff;

    // Self-flashing (see writeRegister below). Only built when the ROM says
    // the board supports it, so a plain mapper-30 ROM behaves exactly as it
    // did before this existed.
    this.flash = this.createFlash();

    this.chrRamBankCount = this.getChrRamBankCount();
    this.chrRam = new Uint8Array(this.chrRamBankCount * CHR_RAM_BANK_SIZE);
    this.chrRamTiles = new Array(this.chrRamBankCount);

    for (let bank = 0; bank < this.chrRamBankCount; bank++) {
      this.chrRamTiles[bank] = new Array(512);
      for (let tile = 0; tile < 512; tile++) {
        this.chrRamTiles[bank][tile] = new Tile();
      }
    }
  }

  getChrRamBankCount() {
    const requestedSize = this.nes.rom.chrRamSize || 0;
    if (requestedSize <= 0) {
      return DEFAULT_CHR_RAM_BANK_COUNT;
    }

    return Math.max(
      1,
      Math.min(
        MAX_CHR_RAM_BANK_COUNT,
        Math.ceil(requestedSize / CHR_RAM_BANK_SIZE),
      ),
    );
  }

  /**
   * Decides whether this cartridge can rewrite its own flash.
   *
   * UNROM 512 boards come in variants, and only some of them can self-flash.
   * NESdev's rule: flash saving is available on submappers 0, 1 and 4 with the
   * battery bit set, and requires a board WITHOUT bus conflicts - submapper 2
   * declares bus conflicts and is explicitly incompatible with self-flashing.
   *
   * Gating on that matters for correctness here, not just tidiness: without
   * it, every ordinary mapper-30 ROM would suddenly have its $8000-$BFFF
   * writes inspected by a flash state machine, and this emulator's existing
   * behaviour for those ROMs must not change at all.
   */
  createFlash() {
    const rom = this.nes.rom;
    if (!rom || !rom.batteryRam) {
      return null;
    }
    // A ROM with no banks loaded yet cannot be flashed; this also keeps the
    // minimal mocks used by unit tests from constructing a zero-sized chip.
    if (!Array.isArray(rom.rom) || rom.rom.length === 0) {
      return null;
    }
    const subMapper = rom.subMapper ?? 0;
    if (subMapper !== 0 && subMapper !== 1 && subMapper !== 4) {
      return null;
    }
    if (this.hasBusConflicts()) {
      return null;
    }
    return new Flash39SF040(rom.rom, {
      bankSize: 0x4000,
      // Forwarded from the NES options so a host page can persist the
      // player's save. Read from `nes.opts` at construction time rather than
      // captured once, because reset() rebuilds the mapper - and therefore
      // this flash - while the option stays put.
      onChange: (sectorIndex, flash) => {
        const handler = this.nes.opts.onFlashChange;
        if (typeof handler === "function") {
          handler(sectorIndex, flash);
        }
      },
    });
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }

    value &= 0xff;

    // ---- Self-flashing boards split the cartridge write space in two ----
    //
    // On an ordinary UNROM 512, every write in $8000-$FFFF clocks the mapper
    // latch. A self-flashable board wires it differently: $8000-$BFFF drives
    // the flash chip's write-enable, and ONLY $C000-$FFFF clocks the latch.
    //
    // That split is what makes flash commands expressible at all. A game has
    // to aim the chip's upper address lines - which come from the bank
    // register - while sending command bytes to specific low addresses. If
    // command writes also moved the bank, every command would move the target
    // out from under itself, and a game could not flash without destroying its
    // own memory map. NESdev's documented sequences show this directly: the
    // bank is always set through $C000, never through the command window.
    //
    //     $C000:$01  $9555:$AA      ; bank 1, so $9555 is chip address $5555
    //     $C000:$00  $AAAA:$55      ; bank 0, so $AAAA is chip address $2AAA
    //     $C000:$01  $9555:$A0      ; "the next write is data"
    //     $C000:BANK ADDR:DATA
    //
    // An earlier version of this file sent flash-window writes to the latch as
    // well, which happened to produce the right chip addresses for the
    // documented sequences - each step re-sets the bank anyway - while
    // silently corrupting the running game's bank state. An independent
    // review caught it.
    if (this.latchesFromEntireCartridgeWindow()) {
      // Boards in this group behave the classic UxROM way: any write in
      // $8000-$FFFF clocks the latch, and there is no flash to talk to.
      this.writeRegister(address, value);
      return;
    }

    if (address < 0xc000) {
      if (this.nes.rom.subMapper === 4) {
        // Submapper 4 adds a cartridge-shell LED register in this window. It
        // does not take the window away from the flash: the write reaches
        // both.
        this.leds = value;
      }
      if (this.flash) {
        const chipAddress = this.prgBank * 0x4000 + (address - 0x8000);
        this.flash.write(chipAddress, value);
        // A programmed or erased byte may be inside a bank the CPU can
        // currently see, so re-present the mapped windows.
        this.refreshMappedBanks();
      }
      // Either way this half of the window does NOT reach the latch.
      return;
    }

    this.writeRegister(address, value);
  }

  /**
   * Which addresses clock the mapper's bank/CHR/mirroring latch.
   *
   * UNROM 512 boards are wired one of two ways, and NESdev's register table
   * splits them by submapper and battery bit rather than by whether a given
   * ROM happens to use flash:
   *
   *   $8000-$FFFF latches - submapper 0 without the battery bit, submapper 2
   *   $C000-$FFFF latches - submapper 0 with the battery bit, submappers 1, 3, 4
   *
   * On the second group the $8000-$BFFF half of the window belongs to the
   * flash chip's write-enable (and, on submapper 4, to the LED register)
   * instead. Keying this on the documented rule rather than on "did we
   * construct a flash chip" matters for the boards in between: submapper 3
   * never self-flashes but still latches only from $C000, and submapper 1
   * without a battery bit likewise. An earlier version keyed it on chip
   * existence and got all three of those wrong.
   */
  latchesFromEntireCartridgeWindow() {
    const subMapper = this.nes.rom.subMapper ?? 0;
    if (subMapper === 2) {
      return true;
    }
    if (subMapper === 0) {
      return !this.nes.rom.batteryRam;
    }
    return false;
  }

  /**
   * Re-copies the currently visible PRG banks out of the cartridge arrays,
   * so bytes the game just programmed are what the CPU reads back. Without
   * this, a save would appear to work and then read as stale data.
   */
  refreshMappedBanks() {
    this.loadRomBank(this.prgBank, 0x8000);
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000);
  }

  /**
   * Reads in $8000-$FFFF normally come straight from the mapped bank, but a
   * flash chip that is mid-program answers with status bits instead of data,
   * and that is what game code polls to know the write has finished.
   */
  load(address) {
    if (this.flash && address >= 0x8000) {
      const bank = address < 0xc000 ? this.prgBank : this.nes.rom.romCount - 1;
      const windowBase = address < 0xc000 ? 0x8000 : 0xc000;
      const status = this.flash.read(bank * 0x4000 + (address - windowBase));
      if (status !== null) {
        return status;
      }
    }
    return super.load(address);
  }

  writeRegister(address, value) {
    const registerValue = this.applyBusConflict(address, value);

    this.prgBank = registerValue & 0x1f;
    this.loadRomBank(this.prgBank, 0x8000);
    this.loadChrRamBank((registerValue >> 5) & 0x03);
    this.mirroringBit = (registerValue >> 7) & 1;
    this.applyMapperMirroring();
  }

  applyBusConflict(address, value) {
    if (!this.hasBusConflicts()) {
      return value;
    }

    return value & (this.nes.cpu.mem[address] ?? 0xff);
  }

  hasBusConflicts() {
    return this.nes.rom.isNES2 && this.nes.rom.subMapper === 2;
  }

  applyMapperMirroring() {
    if (this.nes.rom.subMapper === 3) {
      this.nes.ppu.setMirroring(
        this.mirroringBit
          ? this.nes.rom.VERTICAL_MIRRORING
          : this.nes.rom.HORIZONTAL_MIRRORING,
      );
      return;
    }

    if (!this.hasSwitchableOneScreenMirroring()) {
      return;
    }

    this.nes.ppu.setMirroring(
      this.mirroringBit
        ? this.nes.rom.SINGLESCREEN_MIRRORING2
        : this.nes.rom.SINGLESCREEN_MIRRORING,
    );
  }

  hasSwitchableOneScreenMirroring() {
    return this.nes.rom.fourScreen && this.nes.rom.mirroring === 0;
  }

  flushChrRamBank() {
    if (!this.chrRamMapped) {
      return;
    }

    copyArrayElements(
      this.nes.ppu.vramMem,
      0,
      this.chrRam,
      this.chrBank * CHR_RAM_BANK_SIZE,
      CHR_RAM_BANK_SIZE,
    );
  }

  loadChrRamBank(bankSelect) {
    bankSelect &= 0x03;
    const bank = bankSelect % this.chrRamBankCount;

    if (this.chrRamMapped && bank === this.chrBank) {
      this.chrBankSelect = bankSelect;
      return;
    }

    this.nes.ppu.triggerRendering();
    this.flushChrRamBank();

    this.chrBankSelect = bankSelect;
    this.chrBank = bank;
    this.chrRamMapped = true;

    copyArrayElements(
      this.chrRam,
      bank * CHR_RAM_BANK_SIZE,
      this.nes.ppu.vramMem,
      0,
      CHR_RAM_BANK_SIZE,
    );

    this.rebuildChrRamTiles(bank);
    copyArrayElements(this.chrRamTiles[bank], 0, this.nes.ppu.ptTile, 0, 512);
  }

  rebuildChrRamTiles(bank) {
    const bankOffset = bank * CHR_RAM_BANK_SIZE;
    const tiles = this.chrRamTiles[bank];

    for (let i = 0; i < CHR_RAM_BANK_SIZE; i++) {
      const tileIndex = i >> 4;
      const leftOver = i & 0x0f;
      if (leftOver < 8) {
        tiles[tileIndex].setScanline(
          leftOver,
          this.chrRam[bankOffset + i],
          this.chrRam[bankOffset + i + 8],
        );
      } else {
        tiles[tileIndex].setScanline(
          leftOver - 8,
          this.chrRam[bankOffset + i - 8],
          this.chrRam[bankOffset + i],
        );
      }
    }
  }

  canWriteChr(address) {
    return address < 0x2000;
  }

  loadROM() {
    if (!this.nes.rom.valid || this.nes.rom.romCount < 1) {
      throw new Error("Mapper 30: Invalid ROM! Unable to load.");
    }

    this.loadRomBank(0, 0x8000);
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000);
    this.loadChrRamBank(0);
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }

  toJSON() {
    this.flushChrRamBank();
    const s = super.toJSON();
    s.prgBank = this.prgBank;
    s.chrBankSelect = this.chrBankSelect;
    s.chrBank = this.chrBank;
    s.mirroringBit = this.mirroringBit;
    s.leds = this.leds;
    s.chrRam = Array.from(this.chrRam);
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.prgBank = s.prgBank ?? 0;
    this.chrBankSelect = s.chrBankSelect ?? s.chrBank ?? 0;
    this.chrBank = s.chrBank ?? 0;
    this.mirroringBit = s.mirroringBit ?? 0;
    this.leds = s.leds ?? 0xff;

    this.chrRam.fill(0);
    if (Array.isArray(s.chrRam)) {
      this.chrRam.set(s.chrRam.slice(0, this.chrRam.length));
    }

    for (let bank = 0; bank < this.chrRamBankCount; bank++) {
      this.rebuildChrRamTiles(bank);
    }

    this.chrRamMapped = false;
    this.loadRomBank(this.prgBank, 0x8000);
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000);
    this.loadChrRamBank(this.chrBankSelect);
    this.applyMapperMirroring();
  }
}

export default Mapper30;

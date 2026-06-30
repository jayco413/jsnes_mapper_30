import Mapper0 from "./mapper0.js";
import Tile from "../tile.js";
import { copyArrayElements } from "../utils.js";

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

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }

    value &= 0xff;

    if (this.nes.rom.subMapper === 4 && address < 0xc000) {
      this.leds = value;
      return;
    }

    this.writeRegister(address, value);
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

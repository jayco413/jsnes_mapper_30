import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import Mappers from "../src/mappers/index.js";
import Flash39SF040, { SECTOR_SIZE } from "../src/mappers/flash39sf040.js";
import NameTable from "../src/ppu/nametable.js";
import Tile from "../src/tile.js";

// UNROM 512 boards can rewrite their own program flash, and that is the only
// way games on them save progress - there is no battery-backed RAM. These
// tests cover the flash chip on its own, and then the exact command sequences
// NESdev documents for driving it from an NES game.

function createNes({ batteryRam = true, subMapper = 1, romCount = 32 } = {}) {
  const rom = {
    valid: true,
    romCount,
    vromCount: 0,
    rom: [],
    vrom: [],
    vromTile: [],
    chrRamSize: 32768,
    batteryRam,
    subMapper,
    isNES2: true,
    fourScreen: false,
    mirroring: 0,
    HORIZONTAL_MIRRORING: 1,
    VERTICAL_MIRRORING: 0,
    FOURSCREEN_MIRRORING: 2,
    SINGLESCREEN_MIRRORING: 3,
    SINGLESCREEN_MIRRORING2: 4,
  };
  for (let bank = 0; bank < romCount; bank += 1) {
    // Every byte starts at $FF, the state flash is in after an erase. That is
    // the realistic starting point for a freshly written cartridge's spare
    // banks, and it makes "programming cleared these bits" easy to see.
    rom.rom[bank] = new Uint8Array(16384).fill(0xff);
  }
  return {
    cpu: {
      mem: new Array(0x10000).fill(0),
      dataBus: 0,
      IRQ_NORMAL: 0,
      IRQ_RESET: 2,
      requestIrq() {},
    },
    ppu: {
      vramMem: new Uint8Array(0x8000),
      vramMirrorTable: new Uint16Array(0x8000),
      ptTile: new Array(512).fill(null).map(() => new Tile()),
      scanline: 0,
      f_bgVisibility: 0,
      f_spVisibility: 0,
      f_spriteSize: 0,
      nameTable: [
        new NameTable(32, 32, "Nt0"),
        new NameTable(32, 32, "Nt1"),
        new NameTable(32, 32, "Nt2"),
        new NameTable(32, 32, "Nt3"),
      ],
      triggerRendering() {},
      setMirroring() {},
    },
    rom,
    opts: { onBatteryRamWrite() {} },
  };
}

// The two sequences NESdev documents for UNROM 512. The bank is set through
// the FIXED window at $C000, which the flash never sees; the command itself
// goes through $8000-$BFFF, which it does.
function programByte(mapper, bank, address, data) {
  mapper.write(0xc000, 0x01);
  mapper.write(0x9555, 0xaa);
  mapper.write(0xc000, 0x00);
  mapper.write(0xaaaa, 0x55);
  mapper.write(0xc000, 0x01);
  mapper.write(0x9555, 0xa0);
  mapper.write(0xc000, bank);
  mapper.write(address, data);
}

function eraseSector(mapper, bank, address) {
  mapper.write(0xc000, 0x01);
  mapper.write(0x9555, 0xaa);
  mapper.write(0xc000, 0x00);
  mapper.write(0xaaaa, 0x55);
  mapper.write(0xc000, 0x01);
  mapper.write(0x9555, 0x80);
  mapper.write(0xc000, 0x01);
  mapper.write(0x9555, 0xaa);
  mapper.write(0xc000, 0x00);
  mapper.write(0xaaaa, 0x55);
  mapper.write(0xc000, bank);
  mapper.write(address, 0x30);
}

// Polls the chip until it stops reporting "busy", the way game code must.
// This is not test scaffolding for its own sake: while an operation is in
// progress the chip rejects further commands and answers reads with status
// bits, so a game that skips this step gets neither its data nor its next
// write. Leaving it out of these tests would be modelling a chip that does
// not exist.
function waitReady(mapper) {
  for (let attempt = 0; attempt < 32 && mapper.flash.isBusy(); attempt += 1) {
    mapper.load(0x8000);
  }
}

function readWhenReady(mapper, address) {
  waitReady(mapper);
  return mapper.load(address);
}

describe("SST39SF040 flash chip", function () {
  let banks = null;
  let flash = null;

  beforeEach(function () {
    banks = [
      new Uint8Array(16384).fill(0xff),
      new Uint8Array(16384).fill(0xff),
    ];
    flash = new Flash39SF040(banks, { bankSize: 0x4000, busyReads: 0 });
  });

  function unlock(command) {
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x5555, command);
  }

  it("ignores writes that are not part of a command sequence", function () {
    // This is the property that makes flash safe to have in the CPU's address
    // space: a crashed game spraying writes cannot corrupt the cartridge.
    flash.write(0x0100, 0x00);
    flash.write(0x5555, 0x12);
    flash.write(0x2aaa, 0x34);
    assert.strictEqual(banks[0][0x0100], 0xff);
    assert.ok(flash.rejectedWriteCount > 0);
  });

  it("programs a byte only after the full unlock sequence", function () {
    unlock(0xa0);
    flash.write(0x0123, 0x5a);
    assert.strictEqual(banks[0][0x0123], 0x5a);
    assert.strictEqual(flash.programCount, 1);
  });

  it("can only clear bits, never set them", function () {
    // The defining flash behaviour, and the reason a save system has to
    // append records rather than rewrite one in place.
    unlock(0xa0);
    flash.write(0x0200, 0xa5);
    assert.strictEqual(banks[0][0x0200], 0xa5);

    unlock(0xa0);
    flash.write(0x0200, 0x5a);
    // $A5 AND $5A is $00 - the bits the second write wanted set stay clear.
    assert.strictEqual(banks[0][0x0200], 0x00);
  });

  it("erases a 4 KB sector back to $FF without touching its neighbour", function () {
    unlock(0xa0);
    flash.write(0x0010, 0x00);
    unlock(0xa0);
    flash.write(SECTOR_SIZE + 0x0010, 0x00);

    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x5555, 0x80);
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x0010, 0x30);

    assert.strictEqual(banks[0][0x0010], 0xff, "the erased sector is blank");
    assert.strictEqual(
      banks[0][SECTOR_SIZE + 0x0010],
      0x00,
      "the next sector is untouched",
    );
    assert.strictEqual(flash.sectorEraseCount, 1);
  });

  it("aborts a command whose unlock sequence is wrong", function () {
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x99); // wrong second unlock byte
    flash.write(0x5555, 0xa0); // would have been "program"
    flash.write(0x0300, 0x00);
    assert.strictEqual(banks[0][0x0300], 0xff, "nothing was programmed");
  });

  it("reports busy after a program, then returns data", function () {
    const busy = new Flash39SF040(banks, { bankSize: 0x4000, busyReads: 2 });
    busy.write(0x5555, 0xaa);
    busy.write(0x2aaa, 0x55);
    busy.write(0x5555, 0xa0);
    busy.write(0x0400, 0x0f);

    assert.ok(busy.isBusy(), "the chip is busy immediately after a program");
    // While busy, DQ7 reads back as the complement of the programmed value -
    // game code polls this. A game that skipped the poll would read these
    // status bytes as if they were its data.
    const first = busy.read(0x0400);
    assert.notStrictEqual(first, 0x0f);
    busy.read(0x0400);
    assert.strictEqual(busy.isBusy(), false);
    assert.strictEqual(busy.read(0x0400), null, "reads fall through to data");
    assert.strictEqual(banks[0][0x0400], 0x0f);
  });

  it("erases the whole chip, and only from the command address", function () {
    // Chip erase is the one command that can wipe the game's own code off the
    // cartridge, and it had no coverage at all until an independent review
    // mutation-tested this file and found that deleting eraseChip() entirely
    // left every test passing.
    unlock(0xa0);
    flash.write(0x0010, 0x00);
    unlock(0xa0);
    flash.write(0x4010, 0x11); // a different bank

    // $10 at any address other than $5555 is not a chip erase.
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x5555, 0x80);
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x1234, 0x10);
    assert.strictEqual(flash.chipEraseCount, 0, "wrong address, no chip erase");
    assert.strictEqual(banks[0][0x0010], 0x00, "and nothing was erased");

    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x5555, 0x80);
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x5555, 0x10);
    assert.strictEqual(flash.chipEraseCount, 1);
    assert.strictEqual(banks[0][0x0010], 0xff, "first bank erased");
    assert.strictEqual(banks[1][0x0010], 0xff, "second bank erased too");
  });

  it("recognises a command sequence issued from a high bank", function () {
    // Only A14-A0 take part in command decoding; the upper address lines are
    // don't-care. A game issuing the sequence from bank 3 therefore writes
    // chip address $D555, which must still be seen as $5555. Without this,
    // widening COMMAND_ADDRESS_MASK went undetected.
    const high = 3 * 0x4000; // $C000, whose low 15 bits are $4000
    flash.write(high + 0x1555, 0xaa); // chip $D555 -> command $5555
    flash.write(0x2aaa, 0x55);
    flash.write(high + 0x1555, 0xa0);
    flash.write(0x0500, 0x33);
    assert.strictEqual(banks[0][0x0500], 0x33, "the high-bank unlock worked");
  });

  it("ignores every write while busy, including the reset command", function () {
    // The SST39SF040 has no erase-suspend, and the datasheet says the software
    // reset command is ignored during an internal program or erase. The code
    // was already right; nothing pinned it.
    const busy = new Flash39SF040(banks, { bankSize: 0x4000, busyReads: 4 });
    busy.write(0x5555, 0xaa);
    busy.write(0x2aaa, 0x55);
    busy.write(0x5555, 0xa0);
    busy.write(0x0600, 0x77);
    assert.ok(busy.isBusy());

    busy.write(0x5555, 0xf0); // reset, which must NOT take effect
    assert.ok(busy.isBusy(), "reset cannot abort an operation in flight");
  });

  it("checks the address on the erase sequence's own unlock cycles", function () {
    flash.write(0x5555, 0xaa);
    flash.write(0x2aaa, 0x55);
    flash.write(0x5555, 0x80);
    flash.write(0x1111, 0xaa); // wrong address for the 4th cycle
    flash.write(0x2aaa, 0x55);
    flash.write(0x0010, 0x30);
    assert.strictEqual(flash.sectorEraseCount, 0, "the sequence was aborted");
  });

  it("answers the software ID query", function () {
    unlock(0x90);
    assert.strictEqual(flash.read(0x0000), 0xbf, "SST manufacturer id");
    assert.strictEqual(flash.read(0x0001), 0xb7, "SST39SF040 device id");
    // The datasheet scopes the identity to those two addresses. Everywhere
    // else still reads as ordinary data, which is what lets the CPU keep
    // fetching its own vectors while ID mode is active.
    assert.strictEqual(flash.read(0x0002), null, "other addresses are data");
  });
});

describe("UNROM 512 self-flashing", function () {
  it("programs a byte through the documented NESdev sequence", function () {
    const nes = createNes();
    const mapper = new Mappers[30](nes);
    mapper.loadROM();

    programByte(mapper, 28, 0x8123, 0x42);
    assert.strictEqual(nes.rom.rom[28][0x0123], 0x42);

    // And the CPU can read it back once the chip stops reporting busy.
    waitReady(mapper);
    mapper.write(0xc000, 28);
    assert.strictEqual(readWhenReady(mapper, 0x8123), 0x42);
  });

  it("erases a sector through the documented NESdev sequence", function () {
    const nes = createNes();
    const mapper = new Mappers[30](nes);
    mapper.loadROM();

    programByte(mapper, 28, 0x8010, 0x00);
    assert.strictEqual(nes.rom.rom[28][0x0010], 0x00);
    waitReady(mapper);

    eraseSector(mapper, 28, 0x8010);
    waitReady(mapper);
    assert.strictEqual(nes.rom.rom[28][0x0010], 0xff);
  });

  it("leaves the bank alone when a flash command goes through $8000-$BFFF", function () {
    // On a self-flashing board only $C000-$FFFF clocks the mapper latch;
    // $8000-$BFFF drives the flash chip instead. This is the property that
    // lets a game flash without destroying its own memory map, and an
    // earlier version of this code got it backwards - command writes moved
    // the bank, which happened to still produce the right chip addresses for
    // the documented sequences because each step re-sets the bank anyway.
    const nes = createNes();
    const mapper = new Mappers[30](nes);
    mapper.loadROM();

    mapper.write(0xc000, 0x01);
    assert.strictEqual(mapper.prgBank, 0x01, "$C000 does set the bank");
    mapper.write(0x9555, 0xaa);
    assert.strictEqual(
      mapper.prgBank,
      0x01,
      "a command write must not move the bank",
    );
  });

  // Which addresses clock the latch is a property of the BOARD, not of
  // whether a particular ROM uses flash. NESdev splits them by submapper and
  // battery bit, and an earlier version of this code keyed it on "did we
  // build a flash chip", which got three configurations wrong. Both groups
  // are pinned here.
  const latchesFromWholeWindow = [
    { name: "submapper 0 without a battery", subMapper: 0, batteryRam: false },
    { name: "submapper 2 (bus conflicts)", subMapper: 2, batteryRam: true },
  ];
  for (const board of latchesFromWholeWindow) {
    it(`latches from $8000-$BFFF on ${board.name}`, function () {
      const nes = createNes(board);
      const mapper = new Mappers[30](nes);
      mapper.loadROM();
      mapper.write(0x9555, 0xaa);
      assert.strictEqual(mapper.prgBank, 0xaa & 0x1f);
    });
  }

  const latchesFromFixedWindowOnly = [
    { name: "submapper 0 with a battery", subMapper: 0, batteryRam: true },
    { name: "submapper 1 without a battery", subMapper: 1, batteryRam: false },
    { name: "submapper 3 with a battery", subMapper: 3, batteryRam: true },
    { name: "submapper 3 without a battery", subMapper: 3, batteryRam: false },
    { name: "submapper 4 with a battery", subMapper: 4, batteryRam: true },
  ];
  for (const board of latchesFromFixedWindowOnly) {
    it(`does not latch from $8000-$BFFF on ${board.name}`, function () {
      const nes = createNes(board);
      const mapper = new Mappers[30](nes);
      mapper.loadROM();
      mapper.write(0xc000, 0x03);
      mapper.write(0x9555, 0xaa);
      assert.strictEqual(
        mapper.prgBank,
        0x03,
        "only $C000-$FFFF may clock the latch on this board",
      );
    });
  }

  it("reaches both the LEDs and the flash on submapper 4", function () {
    // Submapper 4 adds a cartridge-shell LED register in the same window the
    // flash uses. It does not take the window away from the flash; an earlier
    // version returned after setting the LEDs and silently disabled saving on
    // exactly the boards that advertise it.
    const nes = createNes({ subMapper: 4 });
    const mapper = new Mappers[30](nes);
    mapper.loadROM();
    assert.notStrictEqual(mapper.flash, null, "submapper 4 can self-flash");

    programByte(mapper, 28, 0x8123, 0x42);
    assert.strictEqual(nes.rom.rom[28][0x0123], 0x42, "the flash saw it");
    assert.strictEqual(mapper.leds, 0x42, "and so did the LED register");
  });

  it("refuses a second command while the previous one is still busy", function () {
    // Discovered by these tests failing: after a program the chip is busy and
    // rejects commands, so a game MUST poll between operations. Pinning it
    // here means the emulation cannot quietly become more forgiving than the
    // hardware, which would let a game with a missing poll pass its tests.
    const nes = createNes();
    const mapper = new Mappers[30](nes);
    mapper.loadROM();

    programByte(mapper, 28, 0x8200, 0x11);
    assert.ok(mapper.flash.isBusy());

    programByte(mapper, 28, 0x8201, 0x22);
    assert.strictEqual(
      nes.rom.rom[28][0x0201],
      0xff,
      "the second program was refused while the chip was busy",
    );

    waitReady(mapper);
    programByte(mapper, 28, 0x8201, 0x22);
    assert.strictEqual(
      nes.rom.rom[28][0x0201],
      0x22,
      "and works after polling",
    );
  });

  it("makes an erase take far longer than a program", function () {
    // A save system's wear behaviour depends on this asymmetry, so the model
    // keeps the datasheet's relative costs even though it counts reads rather
    // than microseconds.
    const nes = createNes();
    const mapper = new Mappers[30](nes);
    mapper.loadROM();

    programByte(mapper, 28, 0x8300, 0x00);
    let programReads = 0;
    while (mapper.flash.isBusy()) {
      mapper.load(0x8300);
      programReads += 1;
    }

    eraseSector(mapper, 28, 0x8300);
    let eraseReads = 0;
    while (mapper.flash.isBusy()) {
      mapper.load(0x8300);
      eraseReads += 1;
    }

    assert.ok(
      eraseReads > programReads * 4,
      `an erase (${eraseReads} reads) must cost far more than a program (${programReads})`,
    );
  });

  it("does not flash when the ROM has no battery bit", function () {
    // Without the battery bit the board is not a self-flashing one, and every
    // write must behave exactly as it did before flash support existed.
    const nes = createNes({ batteryRam: false });
    const mapper = new Mappers[30](nes);
    mapper.loadROM();
    assert.strictEqual(mapper.flash, null);

    programByte(mapper, 28, 0x8123, 0x42);
    assert.strictEqual(nes.rom.rom[28][0x0123], 0xff, "ROM is unchanged");
  });

  it("does not flash on a bus-conflict board (submapper 2)", function () {
    // NESdev is explicit: submapper 2 declares bus conflicts and is
    // incompatible with self-flashing.
    const nes = createNes({ subMapper: 2 });
    const mapper = new Mappers[30](nes);
    mapper.loadROM();
    assert.strictEqual(mapper.flash, null);
  });
});

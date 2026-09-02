/**
 * SST39SF040 flash memory emulation.
 *
 * WHY THIS EXISTS
 *
 * Most NES cartridges hold their program in mask ROM: the console can only
 * read it. A few homebrew boards - notably UNROM 512 (iNES mapper 30) - put
 * the program in *flash* memory instead, which the running game can rewrite.
 * That is how those games save: there is no battery-backed RAM, so the game
 * writes the player's progress back into a spare corner of its own cartridge.
 *
 * Flash memory does not behave like RAM. Two rules drive this whole file:
 *
 *   1. Writing can only turn 1 bits into 0 bits. To turn a 0 back into a 1
 *      you must ERASE, and erasing works on a whole 4 KB sector at a time,
 *      setting every byte in it to $FF.
 *   2. The chip ignores plain writes. It only acts on recognised COMMAND
 *      SEQUENCES - specific values written to specific addresses in order.
 *      That is a safety feature: a game that crashes and writes wild data is
 *      very unlikely to spell out a valid command sequence by accident.
 *
 * Emulating this faithfully matters more than it might look. A save system
 * tested against a flash model that is too permissive - one that lets any
 * write through, or that never reports "busy" - will pass its tests and then
 * fail on real hardware. So this models the command state machine and the
 * busy period, and refuses writes that do not follow the protocol.
 *
 * Reference: the SST39SF040 datasheet's command table, and NESdev's UNROM 512
 * page, which documents the exact sequences an NES game must use.
 *
 * REPORTING CHANGES, AND WHY A HOST NEEDS IT
 *
 * On a real cartridge the flash IS the save file: it keeps its contents when
 * the console is switched off, and there is nothing else to store. An
 * emulator has no such luxury. Its "cartridge" is an array that disappears
 * when the page closes, so unless something copies the changed bytes out and
 * puts them back next time, the player's saved game is lost every session -
 * the game saves correctly, and the save evaporates.
 *
 * Copying the bytes out needs two things this file did not previously offer:
 *
 *   A SIGNAL. A host cannot poll half a megabyte every frame looking for a
 *   difference. So `onChange` is called whenever a program or erase actually
 *   modifies stored data, with the index of the 4 KB sector that changed.
 *
 *   A UNIT. Persisting the whole chip to save a few hundred bytes of progress
 *   is wasteful, so changes are tracked and exposed per SECTOR - the chip's
 *   own erase granularity, and therefore the smallest region a game can
 *   rewrite from scratch. `getDirtySectors` says which ones the game has
 *   touched; `readSector`/`writeSector` move one out and back.
 *
 * One rule decides when the signal fires, and it is worth stating plainly
 * because the obvious implementation gets it wrong: the signal reports
 * CHANGED DATA, not attempted writes. Programming $FF over a byte is a legal,
 * common no-op on flash (it clears no bits), and a game's save routine may
 * issue a great many of them. Reporting those would have a host writing an
 * identical save to the server over and over. So every path below compares
 * before and after, and stays silent when nothing moved.
 *
 * The reverse direction - a host calling `writeSector` or `restore` to put a
 * previous session's save back - deliberately does NOT mark anything dirty
 * and does NOT fire `onChange`. Dirty means "the emulated game changed this",
 * and restoring is the host putting back what it already holds. Marking it
 * would make every page load look like a fresh save and write it straight
 * back out again.
 */

// Commands are recognised on these addresses. Only address lines A14-A0
// participate in command decoding on this chip; the higher lines (which
// select which 16 KB bank is visible to the CPU) are "don't care". That is
// why a game can issue the same command sequence from any bank.
const COMMAND_ADDRESS_MASK = 0x7fff;
const COMMAND_ADDRESS_1 = 0x5555;
const COMMAND_ADDRESS_2 = 0x2aaa;

const UNLOCK_1 = 0xaa;
const UNLOCK_2 = 0x55;
const COMMAND_PROGRAM = 0xa0;
const COMMAND_ERASE_PREFIX = 0x80;
const COMMAND_SOFTWARE_ID = 0x90;
const COMMAND_READ_RESET = 0xf0;
const COMMAND_SECTOR_ERASE = 0x30;
const COMMAND_CHIP_ERASE = 0x10;

const SECTOR_SIZE = 0x1000; // 4 KB, per the datasheet's erase granularity.
const ERASED_BYTE = 0xff;

// How long a program or erase appears to take, measured in reads of the chip.
//
// The real part is busy for very different lengths of time depending on the
// operation - roughly 20 microseconds to program one byte, 25 milliseconds to
// erase a sector, 100 milliseconds to erase the whole chip - and during that
// window reads return status bits instead of data. Well-written game code
// polls until the data reads back correctly, which is exactly what NESdev's
// UNROM 512 note tells NES programmers to do.
//
// Modelling that as a number of READS rather than elapsed CPU cycles is a
// deliberate limitation, and worth being honest about. It catches the bug that
// actually matters for a polling game - code that never polls, or polls once,
// reads status bytes as if they were its data, exactly as it would on
// hardware. It does NOT catch a game that waits a fixed, too-short delay
// instead of polling, because there is no emulated clock here for such a delay
// to be short against. A cycle-accurate model would need a monotonic cycle
// counter in the CPU core; that is a change to a hot loop and is left as
// follow-up rather than smuggled in here.
//
// The ORDERING is kept - an erase costs far more polls than a program, which
// a save system's wear behaviour depends on - but the magnitudes are heavily
// compressed. The datasheet's maxima are about 20 microseconds, 25
// milliseconds and 70 milliseconds, a ratio near 1 : 1250 : 3500; these
// constants are 1 : 8 : 32. Do not read a real duration out of them.
//
// The consequence worth naming: a sector erase on hardware is 18-25 ms, which
// is longer than a whole frame, and for all of it every read of $8000-$FFFF
// returns status rather than data. Real flashing code must therefore run from
// internal RAM with NMI disabled, or its handler and vectors will be fetched
// from a chip that is answering with status bits. This model finishes an erase
// after a couple of dozen reads, so it CANNOT catch a game that leaves NMI
// enabled during one. That has to be proved on the game's side.
const BUSY_READS_PROGRAM = 3;
const BUSY_READS_SECTOR_ERASE = 24;
const BUSY_READS_CHIP_ERASE = 96;

// Command state machine positions.
const STATE_READ = 0; // idle: reads return data, writes may start a command
const STATE_UNLOCK_2 = 1; // saw $AA at $5555
const STATE_COMMAND = 2; // saw $55 at $2AAA, waiting for the command byte
const STATE_PROGRAM = 3; // saw $A0, the next write is the byte to program
const STATE_ERASE_UNLOCK_1 = 4; // saw $80, waiting for the second unlock pair
const STATE_ERASE_UNLOCK_2 = 5;
const STATE_ERASE_COMMAND = 6; // waiting for $30 (sector) or $10 (chip)

class Flash39SF040 {
  /**
   * @param {Uint8Array[]} banks - the cartridge's 16 KB PRG banks, exactly the
   *   arrays the mapper reads from, so a programmed byte is visible to the
   *   emulated CPU without copying anything back and forth.
   * @param {object} [options]
   * @param {number} [options.bankSize] - bytes per bank (16384 on this board).
   * @param {number} [options.busyReads] - see DEFAULT_BUSY_READS.
   * @param {(sectorIndex: number, flash: Flash39SF040) => void} [options.onChange]
   *   called when a program or erase actually modifies stored data. See
   *   "REPORTING CHANGES" above: it fires per changed sector, and never for a
   *   write that left the data as it was.
   */
  constructor(banks, options = {}) {
    this.banks = banks;
    this.bankSize = options.bankSize ?? 0x4000;
    // A test can shorten these; nothing else should.
    this.busyReadsProgram = options.busyReads ?? BUSY_READS_PROGRAM;
    this.busyReadsSectorErase = options.busyReads ?? BUSY_READS_SECTOR_ERASE;
    this.busyReadsChipErase = options.busyReads ?? BUSY_READS_CHIP_ERASE;

    this.state = STATE_READ;
    this.softwareIdMode = false;

    // Set while a program or erase is "in progress". While busy, every read
    // returns status bits instead of data - see read().
    this.busyRemaining = 0;
    this.busyToggle = false;
    this.busyExpectedValue = 0;

    // Counters purely for tests and debugging: they make it possible to assert
    // "this test performed exactly one sector erase", which is the kind of
    // thing a save system's wear behaviour depends on.
    this.programCount = 0;
    this.sectorEraseCount = 0;
    this.chipEraseCount = 0;
    this.rejectedWriteCount = 0;

    // How a host learns that the player's save changed. Null by default, so a
    // caller that does not care pays nothing.
    this.onChange = options.onChange ?? null;

    // Which sectors the emulated game has modified since the host last
    // cleared this. A Set, so a save routine that programs two hundred bytes
    // into one sector still records exactly one sector to persist.
    this.dirtySectors = new Set();
  }

  /** How many 4 KB sectors this chip has. */
  get sectorCount() {
    return Math.floor(this.size / SECTOR_SIZE);
  }

  /** Which sector a chip address falls in. */
  sectorIndexOf(chipAddress) {
    return Math.floor((chipAddress % this.size) / SECTOR_SIZE);
  }

  /**
   * Record that the game changed a sector, and tell the host.
   *
   * Only ever called from a path that has already established that the data
   * really did change - see the file header.
   */
  noteSectorChanged(sectorIndex) {
    this.dirtySectors.add(sectorIndex);
    if (this.onChange !== null) {
      this.onChange(sectorIndex, this);
    }
  }

  /**
   * Sectors modified by the emulated game since clearDirtySectors().
   *
   * @returns {number[]} ascending sector indices.
   */
  getDirtySectors() {
    return [...this.dirtySectors].sort((a, b) => a - b);
  }

  /** Forget which sectors are dirty, after a host has persisted them. */
  clearDirtySectors() {
    this.dirtySectors.clear();
  }

  /**
   * Copy one sector out, for saving.
   *
   * Returns a COPY rather than a view into the bank, because the caller is
   * about to hold these bytes while the game keeps running, and a view would
   * keep changing underneath them.
   *
   * @param {number} sectorIndex
   * @returns {Uint8Array} SECTOR_SIZE bytes.
   */
  readSector(sectorIndex) {
    this.assertSectorIndex(sectorIndex);
    const start = sectorIndex * SECTOR_SIZE;
    const out = new Uint8Array(SECTOR_SIZE);
    for (let offset = 0; offset < SECTOR_SIZE; offset += 1) {
      out[offset] = this.byteAt(start + offset);
    }
    return out;
  }

  /**
   * Put one sector back, restoring a previous session's save.
   *
   * This writes straight into the banks rather than going through the command
   * state machine, and that is deliberate: it is the host loading a cartridge
   * that already held this data, not the game programming it. The
   * program-only-clears-bits rule therefore does not apply and must not be
   * imposed - applying it would corrupt every restore, because a saved $FF
   * cannot be programmed back over a stored $00.
   *
   * Does not mark the sector dirty - see the file header.
   *
   * @param {number} sectorIndex
   * @param {ArrayLike<number>} bytes - exactly SECTOR_SIZE bytes.
   */
  writeSector(sectorIndex, bytes) {
    this.assertSectorIndex(sectorIndex);
    if (!bytes || bytes.length !== SECTOR_SIZE) {
      throw new Error(
        "Flash sector data must be " +
          SECTOR_SIZE +
          " bytes, got " +
          (bytes ? bytes.length : "nothing"),
      );
    }
    const start = sectorIndex * SECTOR_SIZE;
    for (let offset = 0; offset < SECTOR_SIZE; offset += 1) {
      this.setByteAt(start + offset, bytes[offset]);
    }
  }

  assertSectorIndex(sectorIndex) {
    if (
      !Number.isInteger(sectorIndex) ||
      sectorIndex < 0 ||
      sectorIndex >= this.sectorCount
    ) {
      throw new Error(
        "Flash sector " +
          sectorIndex +
          " is out of range 0.." +
          (this.sectorCount - 1),
      );
    }
  }

  /**
   * The entire chip as one array, for a whole-cartridge save.
   *
   * Sector at a time is the cheaper way to persist progress; this exists for
   * callers that would rather hold the lot, such as a test or a tool writing
   * a .nes file back out.
   *
   * @returns {Uint8Array} a copy, `size` bytes long.
   */
  snapshot() {
    const out = new Uint8Array(this.size);
    for (let bank = 0; bank < this.banks.length; bank += 1) {
      out.set(this.banks[bank], bank * this.bankSize);
    }
    return out;
  }

  /**
   * Replace the entire chip's contents. Does not mark anything dirty.
   *
   * @param {ArrayLike<number>} bytes - exactly `size` bytes.
   */
  restore(bytes) {
    if (!bytes || bytes.length !== this.size) {
      throw new Error(
        "Flash image must be " +
          this.size +
          " bytes, got " +
          (bytes ? bytes.length : "nothing"),
      );
    }
    for (let bank = 0; bank < this.banks.length; bank += 1) {
      const start = bank * this.bankSize;
      for (let offset = 0; offset < this.bankSize; offset += 1) {
        this.banks[bank][offset] = bytes[start + offset] & 0xff;
      }
    }
  }

  get size() {
    return this.banks.length * this.bankSize;
  }

  /** Returns true while a program or erase is still completing. */
  isBusy() {
    return this.busyRemaining > 0;
  }

  /** Puts the chip back in read mode, as a hardware reset would. */
  reset() {
    this.state = STATE_READ;
    this.softwareIdMode = false;
    this.busyRemaining = 0;
  }

  byteAt(chipAddress) {
    const address = chipAddress % this.size;
    return this.banks[Math.floor(address / this.bankSize)][
      address % this.bankSize
    ];
  }

  setByteAt(chipAddress, value) {
    const address = chipAddress % this.size;
    this.banks[Math.floor(address / this.bankSize)][address % this.bankSize] =
      value & 0xff;
  }

  /**
   * A read from the cartridge, as the CPU sees it.
   *
   * Returns null when the chip is idle, meaning "there is nothing special
   * here, use the normal ROM data". Returns a byte when the chip is busy or
   * in software-ID mode, because then the chip is answering with status or
   * identity bytes rather than with stored data.
   *
   * @param {number} chipAddress - full address within the chip.
   * @returns {number|null}
   */
  read(chipAddress) {
    if (this.busyRemaining > 0) {
      this.busyRemaining -= 1;
      this.busyToggle = !this.busyToggle;

      // DQ7 reads back as the COMPLEMENT of the value being written until the
      // operation finishes, and DQ6 toggles on every read. Game code polls one
      // or both of these to know when it may carry on.
      const complementedBit7 = (~this.busyExpectedValue & 0x80) | 0;
      const toggleBit6 = this.busyToggle ? 0x40 : 0x00;
      return complementedBit7 | toggleBit6;
    }

    if (this.softwareIdMode) {
      // Manufacturer (SST = $BF) then device ID ($B7 for the SST39SF040).
      // The datasheet scopes these to addresses $0000 and $0001 - every other
      // address still reads as ordinary data even in ID mode - so this checks
      // the whole address rather than just its low bit. Returning the ID
      // everywhere would mean the CPU could not even fetch its own reset
      // vectors while ID mode was active.
      if (chipAddress === 0x0000) {
        return 0xbf;
      }
      if (chipAddress === 0x0001) {
        return 0xb7;
      }
      return null;
    }

    return null;
  }

  /**
   * A write from the CPU to the cartridge.
   *
   * Every write is offered to the command state machine. Writes that are not
   * part of a recognised sequence change nothing - which is the property that
   * makes flash safe to have in the CPU's address space at all.
   *
   * @param {number} chipAddress - full address within the chip.
   * @param {number} value
   */
  write(chipAddress, value) {
    const commandAddress = chipAddress & COMMAND_ADDRESS_MASK;
    const data = value & 0xff;

    // A busy chip ignores EVERY write, including the read/reset command: the
    // SST39SF040 has no erase-suspend and no way to abort an operation in
    // flight. Confirmed against the datasheet during independent review, which
    // is worth recording because the opposite - letting reset through - is the
    // intuitive guess and would be wrong.
    if (this.busyRemaining > 0) {
      this.rejectedWriteCount += 1;
      return;
    }

    switch (this.state) {
      case STATE_READ:
        if (commandAddress === COMMAND_ADDRESS_1 && data === UNLOCK_1) {
          this.state = STATE_UNLOCK_2;
        } else if (data === COMMAND_READ_RESET) {
          this.softwareIdMode = false;
        } else {
          this.rejectedWriteCount += 1;
        }
        return;

      case STATE_UNLOCK_2:
        if (commandAddress === COMMAND_ADDRESS_2 && data === UNLOCK_2) {
          this.state = STATE_COMMAND;
        } else {
          this.abort();
        }
        return;

      case STATE_COMMAND:
        if (commandAddress !== COMMAND_ADDRESS_1) {
          this.abort();
          return;
        }
        if (data === COMMAND_PROGRAM) {
          this.state = STATE_PROGRAM;
        } else if (data === COMMAND_ERASE_PREFIX) {
          this.state = STATE_ERASE_UNLOCK_1;
        } else if (data === COMMAND_SOFTWARE_ID) {
          this.softwareIdMode = true;
          this.state = STATE_READ;
        } else if (data === COMMAND_READ_RESET) {
          this.softwareIdMode = false;
          this.state = STATE_READ;
        } else {
          this.abort();
        }
        return;

      case STATE_PROGRAM: {
        // The defining flash behaviour: programming can only clear bits.
        // Writing $FF over a byte leaves it unchanged; writing $00 clears it
        // completely; anything else ANDs. A save system that assumes it can
        // overwrite a record in place gets caught here rather than on
        // hardware.
        const previous = this.byteAt(chipAddress);
        const programmed = previous & data;
        this.setByteAt(chipAddress, programmed);
        this.programCount += 1;
        // Only a program that cleared at least one bit changed anything.
        // Writing $FF, or re-writing a byte's existing value, is a legal
        // no-op that a save routine may perform in bulk, and reporting those
        // would have a host re-persisting an identical save. The operation
        // still costs its busy period either way: the chip does not shortcut
        // it, and a game polling for completion must still poll.
        if (programmed !== previous) {
          this.noteSectorChanged(this.sectorIndexOf(chipAddress));
        }
        this.beginBusy(programmed, this.busyReadsProgram);
        this.state = STATE_READ;
        return;
      }

      case STATE_ERASE_UNLOCK_1:
        if (commandAddress === COMMAND_ADDRESS_1 && data === UNLOCK_1) {
          this.state = STATE_ERASE_UNLOCK_2;
        } else {
          this.abort();
        }
        return;

      case STATE_ERASE_UNLOCK_2:
        if (commandAddress === COMMAND_ADDRESS_2 && data === UNLOCK_2) {
          this.state = STATE_ERASE_COMMAND;
        } else {
          this.abort();
        }
        return;

      case STATE_ERASE_COMMAND:
        if (data === COMMAND_SECTOR_ERASE) {
          this.eraseSector(chipAddress);
          this.sectorEraseCount += 1;
          this.beginBusy(ERASED_BYTE, this.busyReadsSectorErase);
        } else if (
          data === COMMAND_CHIP_ERASE &&
          commandAddress === COMMAND_ADDRESS_1
        ) {
          this.eraseChip();
          this.chipEraseCount += 1;
          this.beginBusy(ERASED_BYTE, this.busyReadsChipErase);
        } else {
          this.abort();
          return;
        }
        this.state = STATE_READ;
        return;

      default:
        this.abort();
    }
  }

  abort() {
    this.state = STATE_READ;
    this.rejectedWriteCount += 1;
  }

  beginBusy(expectedValue, reads) {
    this.busyRemaining = reads;
    this.busyToggle = false;
    this.busyExpectedValue = expectedValue & 0xff;
  }

  /**
   * Sets every byte of the containing 4 KB sector to $FF.
   *
   * Reports the sector as changed only if some byte in it was not already
   * $FF. Erasing an already-erased sector is something a save system does
   * routinely - it is how it prepares space it has not used yet - and it
   * leaves the data identical, so it is not a change worth persisting.
   */
  eraseSector(chipAddress) {
    const address = chipAddress % this.size;
    const start = address - (address % SECTOR_SIZE);
    let changed = false;
    for (let offset = 0; offset < SECTOR_SIZE; offset += 1) {
      if (this.byteAt(start + offset) !== ERASED_BYTE) {
        changed = true;
        this.setByteAt(start + offset, ERASED_BYTE);
      }
    }
    if (changed) {
      this.noteSectorChanged(Math.floor(start / SECTOR_SIZE));
    }
  }

  /**
   * Sets the whole chip to $FF, reporting each sector that was not already.
   *
   * Written in terms of eraseSector rather than filling the banks directly,
   * so that the "only report what actually changed" rule lives in exactly one
   * place and a host sees the same per-sector shape from every path.
   */
  eraseChip() {
    for (let sector = 0; sector < this.sectorCount; sector += 1) {
      this.eraseSector(sector * SECTOR_SIZE);
    }
  }
}

export default Flash39SF040;
export { SECTOR_SIZE, ERASED_BYTE };

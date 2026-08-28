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

// How many reads a program or erase appears to take. The real chip is busy
// for microseconds (program) or milliseconds (erase), during which reads
// return status bits rather than data, and well-written game code polls until
// the data reads back correctly. Emulating that as "a few reads" rather than
// "instantly" is deliberate: a game that forgets to poll will read status
// bytes instead of its data and misbehave here, which is exactly what it
// would do on hardware. Completing instantly would hide that bug.
const DEFAULT_BUSY_READS = 3;

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
   */
  constructor(banks, options = {}) {
    this.banks = banks;
    this.bankSize = options.bankSize ?? 0x4000;
    this.busyReads = options.busyReads ?? DEFAULT_BUSY_READS;

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
      // Manufacturer (SST = $BF) at even addresses, device ID ($B7 for the
      // SST39SF040) at odd. Games use this to confirm which chip they are
      // talking to before risking a write.
      return (chipAddress & 1) === 0 ? 0xbf : 0xb7;
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

    // A program or erase in progress ignores everything except the reset
    // command, exactly as the datasheet specifies.
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
        this.beginBusy(programmed);
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
          this.beginBusy(ERASED_BYTE);
        } else if (
          data === COMMAND_CHIP_ERASE &&
          commandAddress === COMMAND_ADDRESS_1
        ) {
          this.eraseChip();
          this.chipEraseCount += 1;
          this.beginBusy(ERASED_BYTE);
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

  beginBusy(expectedValue) {
    this.busyRemaining = this.busyReads;
    this.busyToggle = false;
    this.busyExpectedValue = expectedValue & 0xff;
  }

  /** Sets every byte of the containing 4 KB sector to $FF. */
  eraseSector(chipAddress) {
    const address = chipAddress % this.size;
    const start = address - (address % SECTOR_SIZE);
    for (let offset = 0; offset < SECTOR_SIZE; offset += 1) {
      this.setByteAt(start + offset, ERASED_BYTE);
    }
  }

  eraseChip() {
    for (const bank of this.banks) {
      bank.fill(ERASED_BYTE);
    }
  }
}

export default Flash39SF040;
export { SECTOR_SIZE, ERASED_BYTE };

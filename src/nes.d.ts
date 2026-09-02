import { ButtonKey } from "./controller";
import { GameGenie } from "./gamegenie";

export type ControllerId = 1 | 2;

export interface EmulatorData {
  cpu: object;
  mmap: object;
  ppu: object;
  papu: object;
}

export interface NESOptions {
  onFrame?: (buffer: Uint32Array) => void;
  onAudioSample?: (left: number, right: number) => void;
  onStatusUpdate?: (status: string) => void;
  onBatteryRamWrite?: (address: number, value: number) => void;
  /**
   * Called when a self-flashing cartridge's flash actually changes, with the
   * index of the 4 KB sector affected. This is how a host learns the player's
   * saved game moved. It reports CHANGED DATA, not attempted writes: a
   * program that clears no bits is a legal no-op and is not reported.
   */
  onFlashChange?: (sectorIndex: number, flash: Flash39SF040) => void;
  emulateSound?: boolean;
  sampleRate?: number;
}

/**
 * The SST39SF040 flash chip on a UNROM 512 board, which is where games on
 * that board keep their saves - there is no battery-backed RAM.
 */
export interface Flash39SF040 {
  readonly size: number;
  readonly sectorCount: number;
  isBusy: () => boolean;
  sectorIndexOf: (chipAddress: number) => number;
  getDirtySectors: () => number[];
  clearDirtySectors: () => void;
  readSector: (sectorIndex: number) => Uint8Array;
  writeSector: (sectorIndex: number, bytes: ArrayLike<number>) => void;
  snapshot: () => Uint8Array;
  restore: (bytes: ArrayLike<number>) => void;
}

export class NES {
  constructor(opts: NESOptions);
  gameGenie: GameGenie;
  reset: () => void;
  frame: () => void;
  buttonDown: (controller: ControllerId, button: ButtonKey) => void;
  buttonUp: (controller: ControllerId, button: ButtonKey) => void;
  zapperMove: (x: number, y: number) => void;
  zapperFireDown: () => void;
  zapperFireUp: () => void;
  getFPS: () => number;
  reloadROM: () => void;
  loadROM: (data: string | Buffer | Uint8Array | ArrayBuffer) => void;
  setFramerate: (rate: number) => void;
  toJSON: () => EmulatorData;
  fromJSON: (data: EmulatorData) => void;

  // Cartridge flash: reading and restoring the player's saved game. Each of
  // these is harmless on a cartridge with no flash, so a host does not have
  // to inspect the mapper before asking.
  getFlash: () => Flash39SF040 | null;
  hasFlash: () => boolean;
  getFlashSectorSize: () => number;
  getFlashSectorCount: () => number;
  getDirtyFlashSectors: () => number[];
  clearDirtyFlashSectors: () => void;
  readFlashSector: (sectorIndex: number) => Uint8Array | null;
  writeFlashSector: (sectorIndex: number, bytes: ArrayLike<number>) => boolean;
  getFlashData: () => Uint8Array | null;
  setFlashData: (bytes: ArrayLike<number>) => boolean;
}

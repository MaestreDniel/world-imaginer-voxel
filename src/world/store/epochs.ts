/**
 * Per-scope epoch cells (SP3a spec §3.4, master §2.3, §4.3): one Int32 per pipeline phase in its own buffer (a
 * `SharedArrayBuffer` when `shared`, an `ArrayBuffer` otherwise), read and written with Atomics. Built in SP3a; SP4
 * wires them into the worker pool in place of the pool-wide abort cell.
 */

/** Cell index per pipeline phase. */
export const EPOCH_CELL = { terrain: 0, decorate: 1, light: 2, mesh: 3 } as const;
export const EPOCH_CELL_COUNT = 4;

export interface EpochCells {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  readonly cells: Int32Array;
  get(cell: number): number;
  set(cell: number, epoch: number): void;
  /** `Atomics.add` of 1; returns the new epoch. */
  bump(cell: number): number;
}

export function createEpochCells(shared: boolean): EpochCells {
  const bytes = 4 * EPOCH_CELL_COUNT;
  return attachEpochCells(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
}

/** The cells over an existing buffer (`createEpochCells(...).buffer`, possibly from another thread). */
export function attachEpochCells(buffer: SharedArrayBuffer | ArrayBuffer): EpochCells {
  if (buffer.byteLength !== 4 * EPOCH_CELL_COUNT) {
    throw new RangeError(`epochs: buffer of ${buffer.byteLength} bytes, expected ${4 * EPOCH_CELL_COUNT}`);
  }
  const cells = new Int32Array(buffer);
  const check = (cell: number): number => {
    if (!Number.isInteger(cell) || cell < 0 || cell >= EPOCH_CELL_COUNT) throw new RangeError(`epochs: no cell ${cell}`);
    return cell;
  };
  return {
    buffer,
    cells,
    get: (cell) => Atomics.load(cells, check(cell)),
    set(cell, epoch) {
      Atomics.store(cells, check(cell), epoch);
    },
    bump: (cell) => Atomics.add(cells, check(cell), 1) + 1,
  };
}

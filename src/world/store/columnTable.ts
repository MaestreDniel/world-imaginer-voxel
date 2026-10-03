/**
 * The column table (SP3a spec §3.2, master §2.3): a fixed buffer of 64 × 64 records of 160 int32, one per torus
 * slot `(cx & 63) + 64·(cz & 63)`. A record holds at most one column; `claimed` (int 11) says whether it is held,
 * and cx, cz say by which column. `status`, `epoch`, `claimed` and the versions are read and written with Atomics.
 *
 * Record layout: 0-3 cx, cz, status, epoch; 4-5 blockVersion, lightVersion; 6 protoFlags; 7-8 aux A and aux B
 * slots (−1 when not allocated); 9-10 unsettledCount, diffFlag; 11 claimed; 12-15 unassigned; 16-111 the final
 * section descriptors (24 × 4: blocks, light, fluid, meta); 112-159 the proto descriptors (24 × 2: blocks, fluid).
 *
 * A free record has cx = cz = `NO_COLUMN`, and a claim writes cx and cz only after it holds the record, so `find`
 * never matches a record that is free or being taken by another column.
 *
 * The table only keeps records: releasing the slots a record references is the store's job (`section.ts`), done
 * before `unclaim`.
 */

export const TORUS = 64;
export const RECORD_INTS = 160;
export const RECORD_COUNT = TORUS * TORUS;
export const COLUMN_TABLE_BYTES = RECORD_COUNT * RECORD_INTS * 4;
/** Sections per column (y −64 … 319). */
export const SECTIONS = 24;

export const REC_CX = 0;
export const REC_CZ = 1;
export const REC_STATUS = 2;
export const REC_EPOCH = 3;
export const REC_BLOCK_VERSION = 4;
export const REC_LIGHT_VERSION = 5;
export const REC_PROTO_FLAGS = 6;
export const REC_AUX_A = 7;
export const REC_AUX_B = 8;
export const REC_UNSETTLED = 9;
export const REC_DIFF_FLAG = 10;
export const REC_CLAIMED = 11;
export const REC_FINAL = 16;
export const REC_PROTO = 112;

export const STATUS_ABSENT = 0;
export const STATUS_PROTO = 1;
export const STATUS_DECORATED = 2;
export const STATUS_PUBLISHED = 3;

/** cx and cz of a free record: outside every coordinate range, so a stale record never matches a lookup. */
export const NO_COLUMN = 0x7fffffff;

const FINAL_STRIDE = 4;
const PROTO_STRIDE = 2;

/** A claim found its record held (by another column or by the same one); free the holder first. */
export class SlotBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotBusy';
  }
}

/** Int offset of the record of (cx, cz): its torus slot times `RECORD_INTS`. */
export function recordBase(cx: number, cz: number): number {
  return ((cx & 63) + 64 * (cz & 63)) * RECORD_INTS;
}

/** Int offset of section `sy`'s final descriptor (blocks, light, fluid, meta) in the record at `base`. */
export function finalAt(base: number, sy: number): number {
  return base + REC_FINAL + FINAL_STRIDE * sy;
}

/** Int offset of section `sy`'s proto descriptor (blocks, fluid) in the record at `base`. */
export function protoAt(base: number, sy: number): number {
  return base + REC_PROTO + PROTO_STRIDE * sy;
}

export interface ColumnTable {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  /** Every record, `RECORD_INTS` per record; descriptors are plain ints published by `status` (Atomics). */
  readonly ints: Int32Array;
  /**
   * Takes the record of (cx, cz) (compare-exchange of `claimed` 0 → 1; `SlotBusy` if held) and writes cx, cz and
   * `epoch`; the rest of the record is reset to its initial values (status Absent, versions 0, descriptors −1,
   * meta 0, aux ids −1). Returns the record's base.
   */
  claim(cx: number, cz: number, epoch: number): number;
  /** The base of the record holding (cx, cz), or −1 when the record is free or holds another column. */
  find(cx: number, cz: number): number;
  /** Writes the initial values into every field but cx, cz, epoch and `claimed`; releases nothing. */
  clear(base: number): void;
  /** Stores cx and cz `NO_COLUMN`, then `claimed` 0. The caller has released every slot the record referenced. */
  unclaim(base: number): void;
  status(base: number): number;
  setStatus(base: number, status: number): void;
  epoch(base: number): number;
  blockVersion(base: number): number;
  lightVersion(base: number): number;
  /** `Atomics.add` of 1; returns the new version. */
  bumpBlockVersion(base: number): number;
  bumpLightVersion(base: number): number;
}

function clearRecord(ints: Int32Array, base: number): void {
  Atomics.store(ints, base + REC_STATUS, STATUS_ABSENT);
  Atomics.store(ints, base + REC_BLOCK_VERSION, 0);
  Atomics.store(ints, base + REC_LIGHT_VERSION, 0);
  ints[base + REC_PROTO_FLAGS] = 0;
  ints[base + REC_AUX_A] = -1;
  ints[base + REC_AUX_B] = -1;
  ints[base + REC_UNSETTLED] = 0;
  ints[base + REC_DIFF_FLAG] = 0;
  for (let sy = 0; sy < SECTIONS; sy++) {
    const f = finalAt(base, sy);
    ints[f] = -1;
    ints[f + 1] = -1;
    ints[f + 2] = -1;
    ints[f + 3] = 0;
    const p = protoAt(base, sy);
    ints[p] = -1;
    ints[p + 1] = -1;
  }
}

/** A new table, every record free. `shared` picks a `SharedArrayBuffer` (several threads) or an `ArrayBuffer`. */
export function createColumnTable(shared: boolean): ColumnTable {
  const buffer = shared ? new SharedArrayBuffer(COLUMN_TABLE_BYTES) : new ArrayBuffer(COLUMN_TABLE_BYTES);
  const ints = new Int32Array(buffer);
  for (let rec = 0; rec < RECORD_COUNT; rec++) {
    const base = rec * RECORD_INTS;
    ints[base + REC_CX] = NO_COLUMN;
    ints[base + REC_CZ] = NO_COLUMN;
    clearRecord(ints, base);
  }
  return attachColumnTable(buffer);
}

/** The table over an existing buffer (`createColumnTable(...).buffer`, possibly from another thread). */
export function attachColumnTable(buffer: SharedArrayBuffer | ArrayBuffer): ColumnTable {
  if (buffer.byteLength !== COLUMN_TABLE_BYTES) {
    throw new RangeError(`columnTable: buffer of ${buffer.byteLength} bytes, expected ${COLUMN_TABLE_BYTES}`);
  }
  const ints = new Int32Array(buffer);
  return {
    buffer,
    ints,
    claim(cx, cz, epoch) {
      const base = recordBase(cx, cz);
      if (Atomics.compareExchange(ints, base + REC_CLAIMED, 0, 1) !== 0) {
        throw new SlotBusy(`column (${cx}, ${cz}): record held by (${Atomics.load(ints, base + REC_CX)}, ${Atomics.load(ints, base + REC_CZ)})`);
      }
      clearRecord(ints, base);
      Atomics.store(ints, base + REC_CX, cx);
      Atomics.store(ints, base + REC_CZ, cz);
      Atomics.store(ints, base + REC_EPOCH, epoch);
      return base;
    },
    find(cx, cz) {
      const base = recordBase(cx, cz);
      if (Atomics.load(ints, base + REC_CLAIMED) !== 1) return -1;
      if (Atomics.load(ints, base + REC_CX) !== cx || Atomics.load(ints, base + REC_CZ) !== cz) return -1;
      return base;
    },
    clear: (base) => clearRecord(ints, base),
    unclaim(base) {
      Atomics.store(ints, base + REC_CX, NO_COLUMN);
      Atomics.store(ints, base + REC_CZ, NO_COLUMN);
      Atomics.store(ints, base + REC_CLAIMED, 0);
    },
    status: (base) => Atomics.load(ints, base + REC_STATUS),
    setStatus(base, status) {
      Atomics.store(ints, base + REC_STATUS, status);
    },
    epoch: (base) => Atomics.load(ints, base + REC_EPOCH),
    blockVersion: (base) => Atomics.load(ints, base + REC_BLOCK_VERSION),
    lightVersion: (base) => Atomics.load(ints, base + REC_LIGHT_VERSION),
    bumpBlockVersion: (base) => Atomics.add(ints, base + REC_BLOCK_VERSION, 1) + 1,
    bumpLightVersion: (base) => Atomics.add(ints, base + REC_LIGHT_VERSION, 1) + 1,
  };
}

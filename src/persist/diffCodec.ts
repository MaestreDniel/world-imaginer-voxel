/**
 * `ColumnDiffV1` (SP5b spec §2.2, D21; master §2.7): one column's DiffStore entries as bytes, little-endian.
 * Header `u8 v = 1`, `u32 genKeyLo`, `u32 genKeyHi`, `u8 sections`; per section by `sy`: `u8 sy, u8 fmt, u16 n`, then
 * fmt 0 (n < `DENSE_MIN`): n × `{u16 idx, u16 state, u8 fluid}` by idx, or fmt 1 (n ≥ `DENSE_MIN`): a 512 B mask (bit
 * `idx & 7` of byte `idx >> 3`), 4096 u16 states and 4096 u8 fluids, every voxel, the unmasked ones 0; trailer `u16
 * count` and count × `{u32 packedPos, u16 dueOffset}` by packedPos. A value is `state << 8 | fluid` (`diffStore.ts`).
 * The encoding is canonical: one column has exactly one byte string, whatever its input order (the flush writes the same
 * bytes straight from the DiffStore's maps, `encodeColumnSections`). The header's genKey is the world's when the column
 * was written and is informative (D8: entries apply under any generator). The trailer is written with count 0 until SP7;
 * any count decodes, and SP5b's callers drop the decoded ticks (D21).
 */
import type { Hash64 } from '../core/hash';
import type { ColumnDiff } from '../world/store/api';

/** A pending runtime fluid tick (SP7's): the voxel's packed position and its due offset. */
export interface FluidTick {
  readonly packedPos: number;
  readonly dueOffset: number;
}

export interface DecodedColumn {
  readonly diff: ColumnDiff;
  readonly genKey: Hash64;
  readonly ticks: readonly FluidTick[];
}

/** A malformed `ColumnDiffV1`; its message names the case. `decode` never returns a partial diff. */
export class DiffDecodeError extends Error {
  constructor(message: string) {
    super(`ColumnDiffV1: ${message}`);
    this.name = 'DiffDecodeError';
  }
}

/** A section with at least this many entries is dense (fmt 1): 512 + 8192 + 4096 = 12,800 B = 5 × 2560. */
export const DENSE_MIN = 2560;

const VERSION = 1;
const SECTIONS = 24;
const VOXELS = 4096;
const HEADER = 10;
const SECTION_HEADER = 4;
const ENTRY = 5;
const MASK = VOXELS / 8;
const DENSE = MASK + 2 * VOXELS + VOXELS;
const TRAILER = 2;
const TICK = 6;
/** The fluid byte's reserved bit (`world/blocks/fluid.ts`). */
const FLUID_RESERVED = 0x80;

const sectionSize = (n: number): number => SECTION_HEADER + (n < DENSE_MIN ? ENTRY * n : DENSE);

/** Entries per `sy`; throws on a `sy` outside 0 … 23. */
function countsBySy(d: ColumnDiff): Uint32Array {
  const counts = new Uint32Array(SECTIONS);
  for (let i = 0; i < d.sy.length; i++) {
    const sy = d.sy[i]!;
    if (sy >= SECTIONS) throw new RangeError(`ColumnDiffV1: sy ${sy} ≥ ${SECTIONS}`);
    counts[sy]!++;
  }
  return counts;
}

/** The byte length of `d` encoded with `tickCount` ticks: 10 + Σ (4 + (n < 2560 ? 5n : 12800)) + 2 + 6 × ticks. */
export function encodedSize(d: ColumnDiff, tickCount: number): number {
  let size = HEADER + TRAILER + TICK * tickCount;
  for (const n of countsBySy(d)) if (n > 0) size += sectionSize(n);
  return size;
}

/**
 * The entry order: by `sy`, then by `idx` (each key `sy · 4096 + idx` once). An input already in that order (the
 * DiffStore's `columnDiff`) is not sorted.
 */
function entryOrder(d: ColumnDiff): Uint32Array {
  const n = d.sy.length;
  const order = new Uint32Array(n);
  const keyed = new Float64Array(n);
  let canonical = true;
  for (let i = 0; i < n; i++) {
    const idx = d.idx[i]!;
    if (idx >= VOXELS) throw new RangeError(`ColumnDiffV1: idx ${idx} ≥ ${VOXELS}`);
    const key = d.sy[i]! * VOXELS + idx;
    if (i > 0 && key <= d.sy[i - 1]! * VOXELS + d.idx[i - 1]!) canonical = false;
    keyed[i] = key * n + i;
    order[i] = i;
  }
  if (canonical) return order;
  keyed.sort();
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const i = keyed[k]! % n;
    const key = (keyed[k]! - i) / n;
    if (key === prev) throw new RangeError(`ColumnDiffV1: duplicate entry at sy ${d.sy[i]} idx ${d.idx[i]}`);
    prev = key;
    order[k] = i;
  }
  return order;
}

/**
 * Encodes `d` (any order) with `genKey` and `ticks` (any order) into a fresh buffer of exactly `encodedSize` bytes,
 * never a view of a scratch buffer (IndexedDB and `postMessage` clone a view's whole `ArrayBuffer`). Throws on a
 * duplicate entry or tick and on a field outside its width.
 */
export function encodeColumnDiff(d: ColumnDiff, genKey: Hash64, ticks: readonly FluidTick[] = []): Uint8Array {
  const counts = countsBySy(d);
  const order = entryOrder(d);
  const sorted = [...ticks].sort((a, b) => a.packedPos - b.packedPos);
  for (let k = 0; k < sorted.length; k++) {
    const { packedPos, dueOffset } = sorted[k]!;
    if (!(Number.isInteger(packedPos) && packedPos >= 0 && packedPos <= 0xFFFFFFFF)) {
      throw new RangeError(`ColumnDiffV1: tick packedPos ${packedPos} is not a u32`);
    }
    if (!(Number.isInteger(dueOffset) && dueOffset >= 0 && dueOffset <= 0xFFFF)) {
      throw new RangeError(`ColumnDiffV1: tick dueOffset ${dueOffset} is not a u16`);
    }
    if (k > 0 && packedPos === sorted[k - 1]!.packedPos) throw new RangeError(`ColumnDiffV1: duplicate tick at ${packedPos}`);
  }
  if (sorted.length > 0xFFFF) throw new RangeError(`ColumnDiffV1: ${sorted.length} ticks`);

  const out = new Uint8Array(encodedSize(d, sorted.length));
  const view = new DataView(out.buffer);
  view.setUint8(0, VERSION);
  view.setUint32(1, genKey[0] >>> 0, true);
  view.setUint32(5, genKey[1] >>> 0, true);
  let sections = 0;
  for (const n of counts) if (n > 0) sections++;
  view.setUint8(9, sections);

  let at = HEADER;
  let k = 0;
  for (let sy = 0; sy < SECTIONS; sy++) {
    const n = counts[sy]!;
    if (n === 0) continue;
    view.setUint8(at, sy);
    view.setUint8(at + 1, n < DENSE_MIN ? 0 : 1);
    view.setUint16(at + 2, n, true);
    at += SECTION_HEADER;
    for (const end = k + n; k < end; k++) {
      const i = order[k]!;
      const idx = d.idx[i]!;
      const value = d.value[i]!;
      const state = value >>> 8;
      if (state > 0xFFFF) throw new RangeError(`ColumnDiffV1: state ${state} at sy ${sy} idx ${idx} is not a u16`);
      if (n < DENSE_MIN) {
        view.setUint16(at, idx, true);
        view.setUint16(at + 2, state, true);
        view.setUint8(at + 4, value & 0xFF);
        at += ENTRY;
      } else {
        out[at + (idx >> 3)]! |= 1 << (idx & 7);
        view.setUint16(at + MASK + 2 * idx, state, true);
        view.setUint8(at + MASK + 2 * VOXELS + idx, value & 0xFF);
      }
    }
    if (n >= DENSE_MIN) at += DENSE;
  }
  view.setUint16(at, sorted.length, true);
  at += TRAILER;
  for (const t of sorted) {
    view.setUint32(at, t.packedPos, true);
    view.setUint16(at + 4, t.dueOffset, true);
    at += TICK;
  }
  return out;
}

/** A column's entries as the DiffStore holds them (`DiffStore.columnSections`): sections by `sy`, entries by `idx`, unordered. */
export type ColumnSections = ReadonlyMap<number, ReadonlyMap<number, number>>;

/**
 * `encodeColumnSections`' scratch: one section's values by `idx`, and the mask of its `idx`s (bit `idx & 31` of word
 * `idx >> 5`), which the walk clears, so both are free again after every section.
 */
const gathered = new Uint32Array(VOXELS);
const gatheredMask = new Int32Array(VOXELS / 32);

/** `Map.forEach`'s callback (a module function: the walk allocates no closure); an `idx` outside 0 … 4095 sets nothing. */
function gather(value: number, idx: number): void {
  gathered[idx] = value;
  gatheredMask[idx >> 5]! |= 1 << (idx & 31);
}

/**
 * The flush's encoding (SP5b spec §3.2; the `persist.flush` row times it, §6.2): exactly the bytes of
 * `encodeColumnDiff(diffs.columnDiff(cx, cz), genKey)`, with no ticks, written straight from the DiffStore's maps
 * (`columnSections`) with no intermediate `ColumnDiff` and no sort: each section's entries are gathered by `idx` into
 * scratch and written in `idx` order by walking its mask. A fresh buffer of exactly `encodedSize` bytes. Throws on a
 * `sy` outside 0 … 23, an `idx` outside 0 … 4095 and a state wider than u16.
 */
export function encodeColumnSections(col: ColumnSections, genKey: Hash64): Uint8Array {
  const counts = new Uint32Array(SECTIONS);
  let size = HEADER + TRAILER;
  let sections = 0;
  for (const [sy, sec] of col) {
    if (!(Number.isInteger(sy) && sy >= 0 && sy < SECTIONS)) throw new RangeError(`ColumnDiffV1: sy ${sy} is outside 0 … ${SECTIONS - 1}`);
    if (sec.size === 0) continue;
    counts[sy] = sec.size;
    size += sectionSize(sec.size);
    sections++;
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint8(0, VERSION);
  view.setUint32(1, genKey[0] >>> 0, true);
  view.setUint32(5, genKey[1] >>> 0, true);
  view.setUint8(9, sections);

  let at = HEADER;
  for (let sy = 0; sy < SECTIONS; sy++) {
    const n = counts[sy]!;
    if (n === 0) continue;
    const dense = n >= DENSE_MIN;
    view.setUint8(at, sy);
    view.setUint8(at + 1, dense ? 1 : 0);
    view.setUint16(at + 2, n, true);
    at += SECTION_HEADER;
    col.get(sy)!.forEach(gather);
    let written = 0;
    let wide = -1;
    for (let w = 0; w < VOXELS / 32; w++) {
      let word = gatheredMask[w]!;
      if (word === 0) continue;
      gatheredMask[w] = 0;
      if (dense) {
        out[at + 4 * w] = word & 0xFF;
        out[at + 4 * w + 1] = (word >>> 8) & 0xFF;
        out[at + 4 * w + 2] = (word >>> 16) & 0xFF;
        out[at + 4 * w + 3] = word >>> 24;
      }
      do {
        const low = word & -word;
        const idx = (w << 5) | (31 - Math.clz32(low));
        word ^= low;
        const value = gathered[idx]!;
        const state = value >>> 8;
        if (state > 0xFFFF && wide < 0) wide = idx;
        if (dense) {
          view.setUint16(at + MASK + 2 * idx, state, true);
          view.setUint8(at + MASK + 2 * VOXELS + idx, value & 0xFF);
        } else {
          view.setUint16(at, idx, true);
          view.setUint16(at + 2, state, true);
          view.setUint8(at + 4, value & 0xFF);
          at += ENTRY;
        }
        written++;
      } while (word !== 0);
    }
    if (written !== n) throw new RangeError(`ColumnDiffV1: an idx outside 0 … ${VOXELS - 1} at sy ${sy}`);
    if (wide >= 0) throw new RangeError(`ColumnDiffV1: state ${gathered[wide]! >>> 8} at sy ${sy} idx ${wide} is not a u16`);
    if (dense) at += DENSE;
  }
  view.setUint16(at, 0, true);
  return out;
}

function popcount8(b: number): number {
  b -= (b >> 1) & 0x55;
  b = (b & 0x33) + ((b >> 2) & 0x33);
  return (b + (b >> 4)) & 0x0F;
}

/**
 * Decodes `b` (a view is read over its own bytes only); `stateCount` is the stored `stateTable`'s length. Throws a
 * `DiffDecodeError` naming the case on a bad `v` or `fmt`; more than 24 sections, a `sy` ≥ 24 or sections out of
 * order; a section with n = 0, a sparse one with n ≥ 2560, a dense one with n < 2560, whose mask's popcount is not n,
 * or with a non-zero state or fluid outside its mask; an `idx` ≥ 4096; unsorted or duplicate entries or ticks; a state
 * ≥ `stateCount`; a fluid byte with its reserved bit 7 set; a short or over-long buffer.
 */
export function decodeColumnDiff(b: Uint8Array, stateCount: number): DecodedColumn {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = b.byteLength;
  const need = (end: number): void => {
    if (end > len) throw new DiffDecodeError(`short buffer (${len} B, ${end} B needed)`);
  };

  // Pass 1: the structure (header, section headers, trailer, length) and the entry count.
  need(HEADER);
  const v = view.getUint8(0);
  if (v !== VERSION) throw new DiffDecodeError(`version ${v} ≠ ${VERSION}`);
  const genKey: Hash64 = [view.getUint32(1, true), view.getUint32(5, true)];
  const sections = view.getUint8(9);
  if (sections > SECTIONS) throw new DiffDecodeError(`more than ${SECTIONS} sections (${sections})`);
  let at = HEADER;
  let total = 0;
  let prevSy = -1;
  for (let s = 0; s < sections; s++) {
    need(at + SECTION_HEADER);
    const sy = view.getUint8(at);
    const fmt = view.getUint8(at + 1);
    const n = view.getUint16(at + 2, true);
    if (sy >= SECTIONS) throw new DiffDecodeError(`sy ${sy} ≥ ${SECTIONS}`);
    if (sy <= prevSy) throw new DiffDecodeError(`sections out of order (sy ${sy} after ${prevSy})`);
    if (fmt !== 0 && fmt !== 1) throw new DiffDecodeError(`fmt ${fmt} at sy ${sy}`);
    if (n === 0) throw new DiffDecodeError(`a section with n = 0 at sy ${sy}`);
    if (fmt === 0 && n >= DENSE_MIN) throw new DiffDecodeError(`a sparse section with n ${n} ≥ ${DENSE_MIN} at sy ${sy}`);
    if (fmt === 1 && n < DENSE_MIN) throw new DiffDecodeError(`a dense section with n ${n} < ${DENSE_MIN} at sy ${sy}`);
    prevSy = sy;
    at += sectionSize(n);
    need(at);
    total += n;
  }
  need(at + TRAILER);
  const count = view.getUint16(at, true);
  const ticksAt = at + TRAILER;
  need(ticksAt + TICK * count);
  if (ticksAt + TICK * count !== len) throw new DiffDecodeError(`over-long buffer (${len} B, ${ticksAt + TICK * count} B used)`);

  // Pass 2: the entries and ticks, each checked; nothing is returned unless every one passes.
  const sy = new Uint8Array(total);
  const idx = new Uint16Array(total);
  const value = new Uint32Array(total);
  const entry = (k: number, s: number, i: number, state: number, fluid: number): void => {
    if (state >= stateCount) throw new DiffDecodeError(`state ${state} ≥ ${stateCount} at sy ${s} idx ${i}`);
    if (fluid & FLUID_RESERVED) throw new DiffDecodeError(`fluid ${fluid} has bit 7 set at sy ${s} idx ${i}`);
    sy[k] = s;
    idx[k] = i;
    value[k] = (state << 8 | fluid) >>> 0;
  };
  at = HEADER;
  let k = 0;
  for (let s = 0; s < sections; s++) {
    const secSy = view.getUint8(at);
    const n = view.getUint16(at + 2, true);
    at += SECTION_HEADER;
    if (n < DENSE_MIN) {
      let prev = -1;
      for (let e = 0; e < n; e++, at += ENTRY) {
        const i = view.getUint16(at, true);
        if (i >= VOXELS) throw new DiffDecodeError(`idx ${i} ≥ ${VOXELS} at sy ${secSy}`);
        if (i <= prev) throw new DiffDecodeError(`entries out of order (idx ${i} after ${prev}) at sy ${secSy}`);
        prev = i;
        entry(k++, secSy, i, view.getUint16(at + 2, true), view.getUint8(at + 4));
      }
    } else {
      let pop = 0;
      for (let m = 0; m < MASK; m++) pop += popcount8(b[at + m]!);
      if (pop !== n) throw new DiffDecodeError(`mask popcount ${pop} ≠ n ${n} at sy ${secSy}`);
      for (let i = 0; i < VOXELS; i++) {
        const state = view.getUint16(at + MASK + 2 * i, true);
        const fluid = b[at + MASK + 2 * VOXELS + i]!;
        if (b[at + (i >> 3)]! & (1 << (i & 7))) entry(k++, secSy, i, state, fluid);
        else if (state !== 0 || fluid !== 0) throw new DiffDecodeError(`unmasked voxel ${i} not 0 at sy ${secSy}`);
      }
      at += DENSE;
    }
  }
  const ticks: FluidTick[] = [];
  at += TRAILER;
  for (let t = 0; t < count; t++, at += TICK) {
    const packedPos = view.getUint32(at, true);
    if (t > 0 && packedPos <= ticks[t - 1]!.packedPos) {
      throw new DiffDecodeError(`ticks out of order (packedPos ${packedPos} after ${ticks[t - 1]!.packedPos})`);
    }
    ticks.push({ packedPos, dueOffset: view.getUint16(at + 4, true) });
  }
  return { diff: { sy, idx, value }, genKey, ticks };
}

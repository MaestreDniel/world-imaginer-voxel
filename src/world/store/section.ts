/**
 * Section descriptors (SP3a spec §3.3, master §2.3). A descriptor entry is one int32 per channel:
 * - a slot id (≥ 0) for a dense channel: blocks in the block pool (u16 per voxel), light and fluid in the byte pool;
 * - `-1-value` for a uniform channel (no slot): `-1-stateId`, `-1-lightByte`, `-1-fluidByte`. −1 is therefore
 *   air, light 0 and "no fluid" (fluid byte 0), which is what an unwritten descriptor reads as.
 * Final descriptors are 4 ints (blocks, light, fluid, meta), proto descriptors 2 (blocks, fluid).
 *
 * Every dense entry holds one reference to its slot. Rewriting an entry releases what it held; sharing an entry
 * retains the slot; releasing an entry frees it once. The functions here act on one entry of an Int32Array (the
 * column table's records, or any other array of entries) and leave set-level bookkeeping to the store.
 *
 * Meta word: bits 0-12 nonAir (voxels whose state is not air, state 0), bit 13 hasOpaque, 14 hasCutout,
 * 15 hasTranslucent (any voxel whose PASS is that pass), bit 16 hasFluid (any fluid type ≠ 0), bits 17-31 the
 * connectivity bits (0 until SP4).
 */
import type { SlabPool } from './pool';

/** Voxels per 16³ section, and entries per channel array. */
export const SECTION_VOXELS = 4096;

export const FINAL_BLOCKS = 0;
export const FINAL_LIGHT = 1;
export const FINAL_FLUID = 2;
export const FINAL_META = 3;
export const FINAL_INTS = 4;
export const PROTO_BLOCKS = 0;
export const PROTO_FLUID = 1;
export const PROTO_INTS = 2;

export const META_NON_AIR = 0x1fff;
export const META_OPAQUE = 1 << 13;
export const META_CUTOUT = 1 << 14;
export const META_TRANSLUCENT = 1 << 15;
export const META_FLUID = 1 << 16;

/** Fluid type, bits 4-5 of the fluid byte (SP3a spec §2.1). */
const FLUID_TYPE_MASK = 0x30;

/** The entry of a uniform channel of value `v`. */
export function uniformCode(v: number): number {
  return -1 - v;
}

/** The value of a uniform entry (`code` < 0). */
export function uniformValue(code: number): number {
  return -1 - code;
}

/** True when the entry is a slot id. */
export function isDense(code: number): boolean {
  return code >= 0;
}

function checkChannel(pool: SlabPool, src: Uint16Array | Uint8Array): void {
  if (src.length !== SECTION_VOXELS) throw new RangeError(`section: ${src.length} entries, expected ${SECTION_VOXELS}`);
  if (pool.slotBytes !== src.BYTES_PER_ELEMENT * SECTION_VOXELS) {
    throw new RangeError(`section: a ${src.BYTES_PER_ELEMENT}-byte channel in a pool of ${pool.slotBytes}-byte slots`);
  }
}

/** Index of the first entry that differs from entry 0, or `SECTION_VOXELS` when the array is uniform. */
function firstDiff(src: Uint16Array | Uint8Array): number {
  const v = src[0]!;
  let i = 1;
  while (i < SECTION_VOXELS && src[i] === v) i++;
  return i;
}

/** Copies `src` into a new slot, or encodes it uniform; stores the entry at `ints[at]` and releases the old one. */
function storeChannel(pool: SlabPool, ints: Int32Array, at: number, src: Uint16Array | Uint8Array, view: Uint16Array | Uint8Array): void {
  checkChannel(pool, src);
  let code: number;
  if (firstDiff(src) === SECTION_VOXELS) {
    code = uniformCode(src[0]!);
  } else {
    code = pool.alloc();
    view.set(src, code * SECTION_VOXELS);
  }
  const old = ints[at]!;
  ints[at] = code;
  if (old >= 0) pool.free(old);
}

/** Stores a block channel (4096 u16 states, copied) at `ints[at]`, uniform or dense; `pool` is the block pool. */
export function storeWords(pool: SlabPool, ints: Int32Array, at: number, src: Uint16Array): void {
  storeChannel(pool, ints, at, src, pool.words);
}

/** Stores a light or fluid channel (4096 bytes, copied) at `ints[at]`, uniform or dense; `pool` is the byte pool. */
export function storeBytes(pool: SlabPool, ints: Int32Array, at: number, src: Uint8Array): void {
  storeChannel(pool, ints, at, src, pool.bytes);
}

/** Releases the entry at `ints[at]` (frees its slot once when dense) and resets it to −1. */
export function releaseEntry(pool: SlabPool, ints: Int32Array, at: number): void {
  const old = ints[at]!;
  ints[at] = -1;
  if (old >= 0) pool.free(old);
}

/** Makes `ints[to]` share `ints[from]`: a dense slot is retained (one more reference); the old `ints[to]` is released. */
export function shareEntry(pool: SlabPool, ints: Int32Array, from: number, to: number): void {
  const code = ints[from]!;
  if (code >= 0) pool.retain(code);
  const old = ints[to]!;
  ints[to] = code;
  if (old >= 0) pool.free(old);
}

/** Voxel `i`'s state in a block entry. */
export function wordAt(pool: SlabPool, code: number, i: number): number {
  return code < 0 ? -1 - code : pool.words[code * SECTION_VOXELS + i]!;
}

/** Voxel `i`'s byte in a light or fluid entry. */
export function byteAt(pool: SlabPool, code: number, i: number): number {
  return code < 0 ? -1 - code : pool.bytes[code * SECTION_VOXELS + i]!;
}

/** A block entry as a view over its slot (4096 states), or its uniform state. */
export function sectionWords(pool: SlabPool, code: number): Uint16Array | number {
  return code < 0 ? -1 - code : pool.u16(code);
}

/** A light or fluid entry as a view over its slot (4096 bytes), or its uniform byte. */
export function sectionBytes(pool: SlabPool, code: number): Uint8Array | number {
  return code < 0 ? -1 - code : pool.u8(code);
}

/** The pass bit of a `PASS` code: none 0 → 0, opaque 1, cutout 2, translucent 3 → bits 13, 14, 15. */
function passBit(code: number): number {
  return code === 0 ? 0 : 1 << (12 + code);
}

/**
 * The meta word of a section from its blocks and fluid (arrays or uniform values, as `sectionWords` and
 * `sectionBytes` return them). `pass` is the registry's per-state `PASS` table; air is state 0.
 */
export function computeMeta(blocks: Uint16Array | number, fluid: Uint8Array | number, pass: Uint8Array): number {
  let meta = 0;
  if (typeof blocks === 'number') {
    if (blocks !== 0) meta = SECTION_VOXELS | passBit(pass[blocks]!);
  } else {
    let nonAir = 0;
    let passes = 0;
    for (let i = 0; i < SECTION_VOXELS; i++) {
      const s = blocks[i]!;
      if (s !== 0) {
        nonAir++;
        passes |= passBit(pass[s]!);
      }
    }
    meta = nonAir | passes;
  }
  if (typeof fluid === 'number') {
    if ((fluid & FLUID_TYPE_MASK) !== 0) meta |= META_FLUID;
  } else {
    for (let i = 0; i < SECTION_VOXELS; i++) {
      if ((fluid[i]! & FLUID_TYPE_MASK) !== 0) {
        meta |= META_FLUID;
        break;
      }
    }
  }
  return meta;
}

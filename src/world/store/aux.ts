/**
 * Aux slots (SP3a spec §3.4, master §2.3): one byte-pool slot of exactly 4096 bytes per kind and column.
 * - Aux A: six Int16[256] heightmaps (`WORLD_SURFACE_WG` 0, `OCEAN_FLOOR_WG` 512, `WORLD_SURFACE` 1024,
 *   `MOTION_BLOCKING` 1536, `OCEAN_FLOOR` 2048, `LIGHT_BLOCKING` 2560), `surfaceBiome` Uint8[256] at 3072 and
 *   `tintTH` Uint8[768] at 3328. Int16 values are little-endian (native on every target).
 * - Aux B: `caveBiomeQ` Uint8[1536] at 0 and `surfaceBiomeQ` Uint8[16] at 1536; the rest of the slot is 0.
 * An aux slot is zero-filled when allocated, a recycled slot included, so a field no stage wrote reads 0.
 */
import type { AuxBView, AuxView } from './api';
import type { SlabPool } from './pool';

export const AUX_BYTES = 4096;

/** Byte offsets of the aux A fields in their slot. */
export const AUX_A_OFFSETS = {
  worldSurfaceWG: 0,
  oceanFloorWG: 512,
  worldSurface: 1024,
  motionBlocking: 1536,
  oceanFloor: 2048,
  lightBlocking: 2560,
  surfaceBiome: 3072,
  tintTH: 3328,
} as const;

/** Byte offsets of the aux B fields in their slot. */
export const AUX_B_OFFSETS = { caveBiomeQ: 0, surfaceBiomeQ: 1536 } as const;

/** A heightmap value when no voxel of the column qualifies: the bottom of the world. */
export const HEIGHT_NONE = -64;

const COLUMNS = 256;

function checkBytePool(pool: SlabPool): void {
  if (pool.slotBytes !== AUX_BYTES) throw new RangeError(`aux: a pool of ${pool.slotBytes}-byte slots, expected ${AUX_BYTES}`);
}

/** Allocates an aux slot in the byte pool and zero-fills all 4096 bytes. */
export function allocAux(pool: SlabPool): number {
  checkBytePool(pool);
  const slot = pool.alloc();
  pool.bytes.fill(0, slot * AUX_BYTES, (slot + 1) * AUX_BYTES);
  return slot;
}

/** Aux A views over `slot`. */
export function auxView(pool: SlabPool, slot: number): AuxView {
  checkBytePool(pool);
  const at = pool.u8(slot).byteOffset;
  const buf = pool.buffer;
  const o = AUX_A_OFFSETS;
  return {
    worldSurfaceWG: new Int16Array(buf, at + o.worldSurfaceWG, COLUMNS),
    oceanFloorWG: new Int16Array(buf, at + o.oceanFloorWG, COLUMNS),
    worldSurface: new Int16Array(buf, at + o.worldSurface, COLUMNS),
    motionBlocking: new Int16Array(buf, at + o.motionBlocking, COLUMNS),
    oceanFloor: new Int16Array(buf, at + o.oceanFloor, COLUMNS),
    lightBlocking: new Int16Array(buf, at + o.lightBlocking, COLUMNS),
    surfaceBiome: new Uint8Array(buf, at + o.surfaceBiome, COLUMNS),
    tintTH: new Uint8Array(buf, at + o.tintTH, 3 * COLUMNS),
  };
}

/** Aux B views over `slot`. */
export function auxBView(pool: SlabPool, slot: number): AuxBView {
  checkBytePool(pool);
  const at = pool.u8(slot).byteOffset;
  return {
    caveBiomeQ: new Uint8Array(pool.buffer, at + AUX_B_OFFSETS.caveBiomeQ, 1536),
    surfaceBiomeQ: new Uint8Array(pool.buffer, at + AUX_B_OFFSETS.surfaceBiomeQ, 16),
  };
}

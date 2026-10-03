/**
 * The store types `gen` may import (types only; SP3a spec §3.5). `store.ts` holds the implementation, which `gen`
 * never imports.
 */

/**
 * Aux A of a column (SP3a spec §3.4): named views over its 4096-byte slot. Per-position arrays are indexed by the
 * column index `lz·16 + lx`; heightmaps hold the absolute y of the highest qualifying voxel plus one (−64 when none).
 */
export interface AuxView {
  readonly worldSurfaceWG: Int16Array;
  readonly oceanFloorWG: Int16Array;
  readonly worldSurface: Int16Array;
  readonly motionBlocking: Int16Array;
  readonly oceanFloor: Int16Array;
  readonly lightBlocking: Int16Array;
  readonly surfaceBiome: Uint8Array;
  readonly tintTH: Uint8Array;
}

/** Aux B of a column (SP3a spec §3.4): the biome quarts. */
export interface AuxBView {
  readonly caveBiomeQ: Uint8Array;
  readonly surfaceBiomeQ: Uint8Array;
}

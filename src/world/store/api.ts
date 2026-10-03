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

/** A `commit` status: 1 Proto, 2 Decorated, 3 Published (SP3a spec §3.2). */
export type CommitStatus = 1 | 2 | 3;

/**
 * Writes one claimed column (SP3a spec §3.5); obtained from `store.claimColumn` and owned by one thread. Every
 * array argument is copied (callers reuse scratch buffers) and stored per channel: uniform when all 4096 values are
 * equal (no slot), dense otherwise; rewriting a section releases what it held. A writer whose column has been freed
 * throws on every call.
 */
export interface ColumnWriter {
  readonly cx: number;
  readonly cz: number;
  /** Section `sy` (0 … 23) of the proto set: 4096 block states and 4096 fluid bytes, voxel index `ly<<8|lz<<4|lx`. */
  setProto(sy: number, blocks: Uint16Array, fluid: Uint8Array): void;
  /** Section `sy` of the final set, and its meta word. */
  setFinal(sy: number, blocks: Uint16Array, light: Uint8Array, fluid: Uint8Array): void;
  /** The final blocks and fluid of `sy` become its proto entries (dense slots retained); light and meta as `setFinal`. */
  shareFinal(sy: number, light: Uint8Array): void;
  /** Aux A, allocated and zero-filled on the first call; later calls view the same slot. */
  aux(): AuxView;
  /** Aux B, likewise. */
  auxB(): AuxBView;
  /** `blockVersion` + 1, then `status` (stored last, so a reader never sees a partial column). */
  commit(status: CommitStatus): void;
}

/**
 * Reads one set (proto or final) of a committed column (SP3a spec §3.5). `y` is absolute (−64 … 319); `lx`, `lz`
 * are 0 … 15. A proto view has no light (reads 0). A view reads the record live: it is valid while its column stays
 * in the store.
 */
export interface ColumnView {
  readonly cx: number;
  readonly cz: number;
  block(lx: number, y: number, lz: number): number;
  fluid(lx: number, y: number, lz: number): number;
  light(lx: number, y: number, lz: number): number;
  /** A view over the section's slot (4096 states), or its uniform state. */
  sectionBlocks(sy: number): Uint16Array | number;
  /** A view over the section's fluid slot (4096 bytes), or its uniform fluid byte. */
  sectionFluid(sy: number): Uint8Array | number;
  /** The column's aux A, or null when it has none. */
  aux(): AuxView | null;
}

/** The 3 × 3 columns around (cx, cz) (SP3a spec §3.5); `dx`, `dz` ∈ {−1, 0, 1}. Consumed from SP4. */
export interface NeighborhoodReader {
  readonly cx: number;
  readonly cz: number;
  /** null for an absent column (not in the store, or not yet at the status the set needs). */
  proto(dx: number, dz: number): ColumnView | null;
  final(dx: number, dz: number): ColumnView | null;
  /**
   * A new Int32Array(18): the 3 × 3 in (dz, dx) order from (−1, −1), blockVersion then lightVersion per column,
   * −1 for an absent column (record free, held by another column, or claimed and not yet committed).
   */
  versions(): Int32Array;
}

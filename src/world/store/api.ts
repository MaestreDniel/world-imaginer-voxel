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
 * Writes one column (SP3a spec §3.5); obtained from `store.claimColumn`, or from `store.reopenColumn` for a
 * committed column (SP4a spec §2.5). Every array argument is copied (callers reuse scratch buffers) and stored per
 * channel: uniform when all 4096 values are equal (no slot), dense otherwise; rewriting a section releases what it
 * held. A writer whose column has been freed throws on every call.
 *
 * Thread contract (SP4a spec §2.4, §2.6): a writer is used by one thread, and a column has one writer at a time,
 * chosen by the coordinator's states (T claims, D reopens at Proto, L reopens at Decorated). A writer is not safe
 * against a concurrent `freeColumn` of its column (a double free): no column is freed during an SP4a session, and
 * SP4b's cancellation through the epoch cells lifts this.
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
  /**
   * The light channel of final section `sy` only (uniform or dense; the meta word does not depend on light). Throws
   * `light already written` when the entry already holds a slot: SP4a's light-once invariant, so a light slot is
   * never freed under a reader (SP4a spec §2.4, §2.5); SP4b's reclamation protocol replaces the refusal.
   */
  setLight(sy: number, light: Uint8Array): void;
  /**
   * Aux A: the record's slot when it has one (a reopened column), otherwise allocated and zero-filled on the first
   * call; later calls view the same slot.
   */
  aux(): AuxView;
  /** Aux B, likewise. */
  auxB(): AuxBView;
  /**
   * `blockVersion` + 1 when this writer wrote blocks or fluid since its previous commit (`setProto`, `setFinal`,
   * `shareFinal`), `lightVersion` + 1 when it wrote light (`setFinal`, `setLight`, or `shareFinal` with a non-zero
   * light byte; the D skeleton's all-zero light is no light change), then `status` (stored last, so a reader never
   * sees a partial column). A commit with no write bumps no version (SP4a spec §2.5).
   */
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
  /**
   * A view over the section's light slot (4096 bytes), or its uniform light byte (SP4a spec §4.3: `padded.ts` copies
   * through it). A proto view has no light and returns 0.
   */
  sectionLight(sy: number): Uint8Array | number;
  /** The column's aux A, or null when it has none. */
  aux(): AuxView | null;
  /** The column's aux B, or null when it has none (no stage of the column called the writer's `auxB()`). */
  auxB(): AuxBView | null;
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

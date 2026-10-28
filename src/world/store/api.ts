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

/** The six aux A heightmaps, by field name (`store.heightAt`, SP4b spec §2.4). */
export type HeightmapKind = 'worldSurfaceWG' | 'oceanFloorWG' | 'worldSurface' | 'motionBlocking' | 'oceanFloor' | 'lightBlocking';

/**
 * One column's edit entries (SP5a spec §2.4, D20; master §2.7): parallel arrays in canonical order (`sy` ascending, then
 * `idx` 0 … 4095), each `value` the voxel's absolute final value `state << 8 | fluid`. Built by the sim's DiffStore
 * (`columnDiff`), transferred to the main thread and handed to D's overlay (§2.5).
 */
export interface ColumnDiff {
  readonly sy: Uint8Array;
  readonly idx: Uint16Array;
  readonly value: Uint32Array;
}

/**
 * A `commit` status: 1 Proto, 2 Decorated, 3 Published (SP3a spec §3.2). A writer commits only a status above the one
 * it opened at (0 for a claim) and never below its own last commit (SP4b spec §2.4).
 */
export type CommitStatus = 1 | 2 | 3;

/**
 * Writes one column (SP3a spec §3.5); obtained from `store.claimColumn`, or from `store.reopenColumn` for a
 * committed column (SP4a spec §2.5). Every array argument is copied (callers reuse scratch buffers) and stored per
 * channel: uniform when all 4096 values are equal (no slot), dense otherwise; rewriting a section releases what it
 * held. A writer whose column has been freed, or whose record has been claimed again since (by any column), throws
 * `WriterStale` on every call (SP4b spec §2.2).
 *
 * Thread contract (SP4a spec §2.4, §2.6; SP4b spec §2.1, §2.10): a writer is used by one thread, and a column has one
 * writer at a time, chosen by the coordinator's states (T claims, D reopens at Proto, L reopens at Decorated); the
 * coordinator's reader pins forbid freeing a column while a job of it or its 3 × 3 runs, and queued jobs are dropped
 * with `cancelWorld` (SP4b).
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
   * `light already written` when the entry already holds a slot: the light-once invariant inside one job, so a light
   * slot is never freed under a reader (SP4a spec §2.4, §2.5). The refusal stays on this writer; SP5a's relight
   * replaces light through the edit writer's `replaceLight` (`EditWriter`), under the reclamation protocol (SP4b spec
   * §2.4).
   */
  setLight(sy: number, light: Uint8Array): void;
  /**
   * Releases the 24 final light entries to uniform 0 (SP4b spec §2.4): L's first step, so a retry after a partial
   * `setLight` run succeeds. Counts as a light write when an entry was not already uniform 0. The releases go through
   * deferred reclamation (SP4b spec §2.5).
   */
  resetLight(): void;
  /**
   * Aux A: the record's slot when it has one (a reopened column), otherwise allocated and zero-filled on the first
   * call; later calls view the same slot.
   */
  aux(): AuxView;
  /** Aux B, likewise. */
  auxB(): AuxBView;
  /**
   * The final blocks and fluid of section `sy` only (SP5a spec §2.2, §2.5): each channel copy-on-write (the entry
   * moves to a new slot or a uniform code, the old one released, so a slot shared with the proto stays the proto's),
   * and the meta word recomputed. Counts as a block write, never a light one (unlike `setFinal`). D's diff overlay.
   */
  replaceBlocks(sy: number, blocks: Uint16Array, fluid: Uint8Array): void;
  /** Sets the record's diff flag (`REC_DIFF_FLAG`, an `Atomics.store` of 1; SP5a spec §1.2, D23). */
  setDiffFlag(): void;
  /**
   * `blockVersion` + 1 when this writer wrote blocks or fluid since its previous commit (`setProto`, `setFinal`,
   * `shareFinal`, `replaceBlocks`), `lightVersion` + 1 when it wrote light (`setFinal`, `setLight`, or `shareFinal` with a non-zero
   * light byte; the D skeleton's all-zero light is no light change), then `status` (stored last, so a reader never
   * sees a partial column). A commit with no write bumps no version (SP4a spec §2.5). `status` is a status above the
   * one the writer opened at, never below its last commit (SP4b): anything else throws `RangeError` before any version
   * bump. Every commit of a writer from `claimColumn` sets the proto alive bit first (SP4b spec §2.4).
   */
  commit(status: CommitStatus): void;
}

/**
 * Edits a Published column (SP5a spec §2.2, D18); obtained from `store.reopenPublished`, used by the sim worker. Every
 * write is copy-on-write: no path writes a dense block, fluid or light slot in place, and the entry it replaces is
 * kept by the writer (its reference moves from the entry to the writer) until `publish` retires it or `rollback`
 * re-points the entry to it. The heightmaps in `aux()` are the caller's (`patchHeightmaps`), as is re-running them
 * after a `rollback`. The stale guard of `ColumnWriter` (`WriterStale`) runs on every call. A thread has one writer
 * per record claim (`reopenPublished` returns the same object until the record is freed or claimed again), so a
 * column reopened by several edits of a batch has one set of kept codes, and a `rollback` or `publish` per open, in
 * any order, undoes or publishes the batch once.
 */
export interface EditWriter {
  readonly cx: number;
  readonly cz: number;
  /** As `ColumnWriter.replaceBlocks`, keeping the replaced codes. */
  replaceBlocks(sy: number, blocks: Uint16Array, fluid: Uint8Array): void;
  /** The light channel of final section `sy`, copy-on-write over any entry (no light-once refusal), keeping the replaced code. */
  replaceLight(sy: number, light: Uint8Array): void;
  /** As `ColumnWriter.setDiffFlag`. */
  setDiffFlag(): void;
  /** The record's aux A slot (allocated, zero-filled, only when the record has none). */
  aux(): AuxView;
  /**
   * `blockVersion` + 1 when blocks or fluid were written and `lightVersion` + 1 when light was, since the last
   * `publish`; the status is never touched. Then retires the kept codes through the thread's deferred reclamation.
   */
  publish(): void;
  /**
   * Undoes every write since the last `publish` (a `StoreFull` mid-batch, SP5a spec §2.2): re-points each replaced
   * entry to its kept code (no `pool.alloc`), recomputes those sections' meta words, retires the new slots and clears
   * the pending version bumps. The diff flag and aux A stay as they are.
   */
  rollback(): void;
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

/**
 * The writer `terrainStage` takes (SP4b spec §2.4): the subset of `ColumnWriter` that `ProtoWriter` shares, so
 * `T(protoOnly)` runs T's own code.
 */
export type TerrainWriter = Pick<ColumnWriter, 'setProto' | 'aux' | 'auxB'>;

/**
 * Rewrites the freed proto set of a Decorated or Published column (SP4b spec §2.4, §3.7): `T(protoOnly)`'s writer,
 * from `store.reopenProto`. It writes only the proto descriptors and the alive bit, never the final set nor the
 * record's aux slots; it throws `WriterStale` once the record was freed or claimed again, as `ColumnWriter`.
 */
export interface ProtoWriter {
  readonly cx: number;
  readonly cz: number;
  /** Section `sy` (0 … 23) of the proto set, as `ColumnWriter.setProto`. */
  setProto(sy: number, blocks: Uint16Array, fluid: Uint8Array): void;
  /** Worker-local zeroed scratch (not the record's slot), discarded: T's aux A writes go nowhere. */
  aux(): AuxView;
  /** Aux B, likewise. */
  auxB(): AuxBView;
  /** Sets the proto alive bit; bumps no version and leaves the status (T is pure: the proto equals the freed one). */
  commitProto(): void;
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
  /** The 18 values of `versions()` into `out[0 … 17]` (`out.length` ≥ 18, else `RangeError`), allocation-free (SP4b spec §2.3). */
  versionsInto(out: Int32Array): void;
}

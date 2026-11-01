/**
 * The sim worker's edit pipeline (SP5a spec §2.1, §2.2, §2.6; D18-D20), pure over the attached store: `applyEdits`
 * runs one batch in sub-batches of `SUB_BATCH` edits (SP5c D21), each inside its own read section.
 * 1. **Validate all first** (§2.1): each voxel's column and its 3 × 3 Published (`'unloaded'`), its value still
 *    `expect` (`'changed'`; an earlier edit of the same voxel in the batch counts as written, found linear in the
 *    batch through a `Map` from the packed voxel position, SP5c D20), its column's proto retained (`'noProto'`). Any
 *    refusal refuses the batch with nothing written.
 * 2. **Per edit** (§2.2): the column's `EditWriter` (`reopenPublished`); the voxel's section copied into scratch and
 *    the voxel set (`revert`: the proto's value); `replaceBlocks` (copy-on-write, so the proto's shared slot stays the
 *    proto's); `setDiffFlag` (D23); `patchHeightmaps` from the old heights; `relight` over the 3 × 3 (D19) through a
 *    sparse section cache that reads the sections in place and copies a section's light on its first write; each
 *    changed light section written back with `replaceLight`; the DiffStore entry (a `revert`, or a `set` equal to the
 *    proto's value, removes it; D20).
 * 3. **Sub-batches** (SP5c spec §3.2, D21): step 2 runs `SUB_BATCH` (512) edits at a time; after each sub-batch
 *    `publish()` once per column it wrote, then, when edits remain, `exitRead` and `enterRead`, so the slots the
 *    sub-batch retired are reclaimed before the next (writers are reopened as needed). One result for the whole batch:
 *    one `dirty`, `relightMs` the relights' sum, `editMs` the whole call, `limboMax` the most entries in this thread's
 *    limbo at the end of any sub-batch (after its `publish`, before its `exitRead`; 0 for a refusal before any write),
 *    `subBatchMaxMs` the longest sub-batch. The drain needs read depth 0 (`reclaim.ts`: only the outermost `exitRead`
 *    drains), so `applyEdits` is never called inside a read section: the sim handler calls it at depth 0, and so does
 *    every test, metric and bench row that reads `limboMax` (called inside one, the batch is still applied whole and
 *    exact, but nothing is reclaimed until the caller's own `exitRead`).
 * A `StoreFull` in the first sub-batch refuses the batch (`'full'`): every writer the sub-batch opened rolls back (no
 * allocation), each edited block column's heightmaps are rescanned, and the DiffStore is restored from `prev`. The
 * content is back to what it was, but a MESH in flight may have read the replaced slots meanwhile (§2.1 lets it run
 * beside an edit, "dropped by its versions"): the `blockVersion` of each column whose block write began and the
 * `lightVersion` of each column whose light write began are bumped after the restore, and `dirty` keeps the columns
 * gathered so far, so such a MESH is dropped and the columns are remeshed. Any other throw after validation (a bug, a
 * relight overflow, a `WriterStale`), and any throw in a later sub-batch, runs the same recovery over its own
 * sub-batch and is then rethrown, so no sub-batch is left half-written with its kept codes unreleased (the earlier
 * sub-batches stay published).
 *
 * The dirty set (§2.6) is every column whose padded view holds a changed voxel: the edited column, its neighbours whose
 * one-voxel ring holds the edited voxel, and from the relight report each column with a changed section plus the
 * neighbours its border and corner bits face. The clock is injected (`now`): `sim/` reads no global clock.
 *
 * The entry changes (SP5b D20): `entryAdded` and `entryRemoved` name the edited columns whose `diffs.has` turned true
 * or false over the batch, so the main thread keeps its entry set without the whole set on every reply. The
 * DiffStore's own dirty-column set (SP5b §3.2) is marked by its `set` and `remove`, the restores included.
 */
import { colKey, colKeyCx, colKeyCz } from '../core/coords';
import { patchHeightmaps } from '../gen/pipeline/finalHeightmaps';
import {
  createRelightScratch, EDGE_E, EDGE_N, EDGE_NE, EDGE_NW, EDGE_S, EDGE_SE, EDGE_SW, EDGE_W, relight, type RelightAccess,
  type RelightScratch,
} from '../light/relight';
import type { ColumnDiff, ColumnView, EditWriter } from '../world/store/api';
import { StoreFull, type VoxelStore } from '../world/store/store';
import { NO_ENTRY, type DiffStore } from './diffStore';

/**
 * One voxel edit (§2.1): world block coordinates (y −64 … 319), `value` the voxel's new `state << 8 | fluid` (ignored
 * by `revert`, which writes the proto's value), `expect` the voxel's value the main thread saw when it decided.
 */
export interface Edit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly op: 'set' | 'revert';
  readonly value: number;
  readonly expect: number;
}

/**
 * The edits applied between two drains of the sim thread's limbo (SP5c spec §3.2, D21): 512 keeps a maximum paste's
 * limbo under 4,096 entries in the paste's y-ascending order (measured 2,198 solid, 2,536 lit; 1,024 left 4,205-4,441).
 */
export const SUB_BATCH = 512;

/** Why a batch was refused (§2.1): nothing of it was written. */
export type EditRefusal = 'unloaded' | 'changed' | 'noProto' | 'full';

/**
 * A batch's outcome (§2.1). `prev[k]` is edit k's DiffStore entry before it and `next[k]` the entry it left (`NO_ENTRY`
 * for none; a refused batch leaves both at the entries it found); `dirty` the colKeys to remesh (§2.6; empty on a
 * refusal before any write, the columns whose views held a rolled-back write on `'full'`), `entryAdded` and
 * `entryRemoved` the colKeys that gained their first entry or lost their last in the batch (both empty on a refusal;
 * SP5b D20). `limboMax` is the most entries in the calling thread's limbo at the end of any sub-batch, before its
 * `exitRead` (0 for a refusal before any write), and `subBatchMaxMs` the longest sub-batch on `now` (SP5c spec §3.2).
 * Every array is fresh (transferable).
 */
export interface EditResult {
  readonly prev: Uint32Array;
  readonly next: Uint32Array;
  readonly dirty: Float64Array;
  readonly entryAdded: Float64Array;
  readonly entryRemoved: Float64Array;
  readonly refused: EditRefusal | null;
  readonly relightMs: number;
  readonly editMs: number;
  readonly limboMax: number;
  readonly subBatchMaxMs: number;
}

/** The 3 × 3's sections: 9 columns (index dz·3 + dx) of 24 sections. */
const COLUMNS = 9;
const SECTIONS = 24;
const CACHED = COLUMNS * SECTIONS;
const VOXELS = 4096;
/** The relight's local grid (`relight.ts`): +1 per x, +48 per z, +48² per row. */
const W = 48;
const LAYER = W * W;
const ROW0 = 64;

/**
 * The relight's view of the 3 × 3 around one column (D19): each section's blocks, fluid and light read in place from
 * the store's slots (loaded on first use), and a section's light copied into a scratch buffer on its first write, so
 * the store is never written in place; `copied` lists the copied sections (column · 24 + sy) for the write-back.
 */
interface SectionCache extends RelightAccess {
  /** Points the cache at the 3 × 3 around (cx, cz) of `store`, forgetting every section read or copied before. */
  open(store: VoxelStore, cx: number, cz: number): void;
  /** The number of sections copied since `open`. */
  copiedCount(): number;
  /** The `n`-th copied section's index (column · 24 + sy). */
  copiedAt(n: number): number;
  /** The light copy of section index `k`. */
  copy(k: number): Uint8Array;
}

function createSectionCache(): SectionCache {
  let store: VoxelStore | null = null;
  let ccx = 0;
  let ccz = 0;
  const views: Array<ColumnView | null> = new Array<ColumnView | null>(COLUMNS).fill(null);
  const heights: Array<Int16Array | null> = new Array<Int16Array | null>(COLUMNS).fill(null);
  const loaded = new Uint8Array(CACHED);
  const blocks: Array<Uint16Array | null> = new Array<Uint16Array | null>(CACHED).fill(null);
  const fluids: Array<Uint8Array | null> = new Array<Uint8Array | null>(CACHED).fill(null);
  const lights: Array<Uint8Array | null> = new Array<Uint8Array | null>(CACHED).fill(null);
  /** A uniform channel's value (when its array is null). */
  const blockU = new Int32Array(CACHED);
  const fluidU = new Int32Array(CACHED);
  const lightU = new Int32Array(CACHED);
  const copied = new Uint8Array(CACHED);
  const copyBuf = new Uint8Array(CACHED * VOXELS);
  const copies = Array.from({ length: CACHED }, (_, k) => copyBuf.subarray(k * VOXELS, (k + 1) * VOXELS));
  const copiedList = new Int32Array(CACHED);
  let nCopied = 0;

  const view = (c: number): ColumnView => {
    const v = views[c] as ColumnView | null;
    if (v !== null) return v;
    const cx = ccx + (c % 3) - 1;
    const cz = ccz + ((c / 3) | 0) - 1;
    const f = store!.final(cx, cz);
    if (f === null) throw new Error(`edits: column (${cx}, ${cz}) of the 3 × 3 has no final set`);
    return (views[c] = f);
  };

  const load = (k: number): void => {
    const c = (k / SECTIONS) | 0;
    const sy = k - c * SECTIONS;
    const v = view(c);
    const b = v.sectionBlocks(sy);
    const f = v.sectionFluid(sy);
    const l = v.sectionLight(sy);
    if (typeof b === 'number') {
      blocks[k] = null;
      blockU[k] = b;
    } else blocks[k] = b;
    if (typeof f === 'number') {
      fluids[k] = null;
      fluidU[k] = f;
    } else fluids[k] = f;
    if (typeof l === 'number') {
      lights[k] = null;
      lightU[k] = l;
    } else lights[k] = l;
    loaded[k] = 1;
  };

  /** Section index of voxel `i`, and (through `vox`) its index in the section. */
  let vox = 0;
  const section = (i: number): number => {
    const row = (i / LAYER) | 0;
    const rem = i - row * LAYER;
    const z = (rem / W) | 0;
    const x = rem - z * W;
    vox = ((row & 15) << 8) | ((z & 15) << 4) | (x & 15);
    const k = ((z >> 4) * 3 + (x >> 4)) * SECTIONS + (row >> 4);
    if (loaded[k] === 0) load(k);
    return k;
  };

  return {
    open(s, cx, cz) {
      store = s;
      ccx = cx;
      ccz = cz;
      views.fill(null);
      heights.fill(null);
      loaded.fill(0);
      for (let n = 0; n < nCopied; n++) copied[copiedList[n]!] = 0;
      nCopied = 0;
    },
    block(i) {
      const k = section(i);
      const a = blocks[k] as Uint16Array | null;
      return a === null ? blockU[k]! : a[vox]!;
    },
    fluid(i) {
      const k = section(i);
      const a = fluids[k] as Uint8Array | null;
      return a === null ? fluidU[k]! : a[vox]!;
    },
    light(i) {
      const k = section(i);
      if (copied[k] !== 0) return copyBuf[k * VOXELS + vox]!;
      const a = lights[k] as Uint8Array | null;
      return a === null ? lightU[k]! : a[vox]!;
    },
    setLight(i, v) {
      const k = section(i);
      if (copied[k] === 0) {
        const a = lights[k] as Uint8Array | null;
        if (a === null) copies[k]!.fill(lightU[k]!);
        else copies[k]!.set(a);
        copied[k] = 1;
        copiedList[nCopied++] = k;
      }
      copyBuf[k * VOXELS + vox] = v;
    },
    lightBlocking(x, z) {
      const c = (z >> 4) * 3 + (x >> 4);
      let h = heights[c] as Int16Array | null;
      if (h === null) {
        const a = view(c).aux();
        if (a === null) throw new Error(`edits: column (${ccx + (c % 3) - 1}, ${ccz + ((c / 3) | 0) - 1}) has no aux A`);
        h = heights[c] = a.lightBlocking;
      }
      // The aux value is y + 1 (−64 … 320); the relight takes the row, 0 … 384 (ruling R8).
      return h[((z & 15) << 4) | (x & 15)]! + ROW0;
    },
    copiedCount: () => nCopied,
    copiedAt: (n) => copiedList[n]!,
    copy: (k) => copies[k]!,
  };
}

/** The sim's reusable state: the relight scratch, one section's blocks and fluid, and the 3 × 3 section cache. */
export interface EditScratch {
  readonly relight: RelightScratch;
  readonly blocks: Uint16Array;
  readonly fluid: Uint8Array;
  readonly cache: SectionCache;
}

/** The relight's rings (≈ 8 MB), the section scratch and the 3 × 3 cache with its light copies (≈ 0.9 MB). */
export function createEditScratch(): EditScratch {
  return { relight: createRelightScratch(), blocks: new Uint16Array(VOXELS), fluid: new Uint8Array(VOXELS), cache: createSectionCache() };
}

/** Column (cx, cz) of the edited column's 3 × 3 is Published, through the store's view-free read. */
const published = (store: VoxelStore, cx: number, cz: number): boolean => store.publishedAt(cx << 4, cz << 4);

function checkEdit(e: Edit): void {
  if (!Number.isInteger(e.x) || !Number.isInteger(e.y) || !Number.isInteger(e.z) || e.y < -64 || e.y > 319) {
    throw new RangeError(`edits: voxel (${e.x}, ${e.y}, ${e.z}) outside the world`);
  }
  if (e.op !== 'set' && e.op !== 'revert') throw new RangeError(`edits: op ${String(e.op)}`);
}

/** The proto's (generated) value of world voxel (x, y, z) of the column `p` views. */
const generatedAt = (p: ColumnView, x: number, y: number, z: number): number => (p.block(x & 15, y, z & 15) << 8) | p.fluid(x & 15, y, z & 15);

/** @internal Test-only counter (SP5c D20): the `Map`s `validate` built, one per batch of more than one edit. */
export const validateStats = { maps: 0 };

/**
 * The batch's refusal, or null (§2.1): every edit's 3 × 3 Published, its value `expect` (the value an earlier edit of
 * the same voxel in the batch leaves, else the store's), its column's proto retained. Linear in the batch (SP5c D20):
 * a batch of more than one edit keeps a `Map` from the voxel's packed position, `colKey · 98,304 + (y + 64) · 256 +
 * lz · 16 + lx` (below 2^53, as `colKey` < 2^32 and `(y + 64) · 256 + 255` ≤ 98,303), to the batch's value so far: a
 * `revert`'s generated value, else the edit's `value`. `prevValue[k]` receives the value edit k replaces (the batch's
 * value so far, else the store's), which a compensating pass writes back.
 */
function validate(store: VoxelStore, edits: readonly Edit[], prevValue: Uint32Array): EditRefusal | null {
  const inBatch = edits.length > 1 ? new Map<number, number>() : null;
  if (inBatch !== null) validateStats.maps++;
  for (let k = 0; k < edits.length; k++) {
    const e = edits[k]!;
    checkEdit(e);
    const cx = e.x >> 4;
    const cz = e.z >> 4;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!published(store, cx + dx, cz + dz)) return 'unloaded';
    const p = store.proto(cx, cz);
    const key = colKey(cx, cz) * 98_304 + (e.y + 64) * 256 + (e.z & 15) * 16 + (e.x & 15);
    const current = inBatch?.get(key) ?? ((store.blockAt(e.x, e.y, e.z) << 8) | store.fluidAt(e.x, e.y, e.z));
    if (current !== e.expect) return 'changed';
    if (p === null) return 'noProto';
    prevValue[k] = current;
    inBatch?.set(key, e.op === 'revert' ? generatedAt(p, e.x, e.y, e.z) : e.value);
  }
  return null;
}

/** Adds column (cx, cz) to `set` and the neighbours that `edges` (`EDGE_*` bits) face. */
function addWithEdges(set: Set<number>, cx: number, cz: number, edges: number): void {
  set.add(colKey(cx, cz));
  if ((edges & EDGE_W) !== 0) set.add(colKey(cx - 1, cz));
  if ((edges & EDGE_E) !== 0) set.add(colKey(cx + 1, cz));
  if ((edges & EDGE_N) !== 0) set.add(colKey(cx, cz - 1));
  if ((edges & EDGE_S) !== 0) set.add(colKey(cx, cz + 1));
  if ((edges & EDGE_NW) !== 0) set.add(colKey(cx - 1, cz - 1));
  if ((edges & EDGE_NE) !== 0) set.add(colKey(cx + 1, cz - 1));
  if ((edges & EDGE_SW) !== 0) set.add(colKey(cx - 1, cz + 1));
  if ((edges & EDGE_SE) !== 0) set.add(colKey(cx + 1, cz + 1));
}

/** The `EDGE_*` bits of block column (lx, lz): the borders and corners of its column it lies on. */
function edgesOf(lx: number, lz: number): number {
  let e = lx === 0 ? EDGE_W : lx === 15 ? EDGE_E : 0;
  if (lz === 0) e |= EDGE_N | (lx === 0 ? EDGE_NW : lx === 15 ? EDGE_NE : 0);
  else if (lz === 15) e |= EDGE_S | (lx === 0 ? EDGE_SW : lx === 15 ? EDGE_SE : 0);
  return e;
}

/**
 * Applies a batch of edits (§2.1, §2.2), validated whole first, then written in sub-batches of `SUB_BATCH` with a
 * drain between them (SP5c D21); see the module comment. Called outside any read section (the drain needs depth 0).
 * `now` is the clock behind `relightMs` (the relights' sum), `subBatchMaxMs` (the longest sub-batch) and `editMs`
 * (the whole call).
 */
export function applyEdits(store: VoxelStore, diffs: DiffStore, s: EditScratch, edits: readonly Edit[], now: () => number): EditResult {
  const t0 = now();
  const n = edits.length;
  const prev = new Uint32Array(n);
  const next = new Uint32Array(n);
  /** The voxel value each edit replaces, from validation (SP5c D20). */
  const prevValue = new Uint32Array(n);
  const dirty = new Set<number>();
  /** Each edited column's `diffs.has` before the batch (D20's entry changes), gathered once the batch is valid. */
  const had = new Map<number, boolean>();
  let refused: EditRefusal | null = null;
  let relightMs = 0;
  let limboMax = 0;
  let subBatchMaxMs = 0;
  /** Inside this call's read section (false only between a drain's `exitRead` and `enterRead`). */
  let reading = false;
  store.enterRead();
  reading = true;
  try {
    refused = validate(store, edits, prevValue);
    if (refused === null) {
      for (const e of edits) {
        const key = colKey(e.x >> 4, e.z >> 4);
        if (!had.has(key)) had.set(key, diffs.has(e.x >> 4, e.z >> 4));
      }
      /** The writers the current sub-batch reopened (each published once at its end). */
      const opened: EditWriter[] = [];
      const open = (cx: number, cz: number): EditWriter => {
        const w = store.reopenPublished(cx, cz);
        if (!opened.includes(w)) opened.push(w);
        return w;
      };
      /** The current sub-batch's writers whose block or light writes began: their versions are bumped on a rollback. */
      const wroteBlocks: EditWriter[] = [];
      const wroteLight: EditWriter[] = [];
      for (let s0 = 0; s0 < n; s0 += SUB_BATCH) {
        const end = Math.min(s0 + SUB_BATCH, n);
        const ts = now();
        opened.length = 0;
        wroteBlocks.length = 0;
        wroteLight.length = 0;
        /** The sub-batch's edits whose writes began (heightmaps to rescan on a rollback), and whose entry was recorded. */
        let written = s0;
        let recorded = s0;
        try {
          for (let k = s0; k < end; k++) {
            const e = edits[k]!;
            const cx = e.x >> 4;
            const cz = e.z >> 4;
            const lx = e.x & 15;
            const lz = e.z & 15;
            const sy = (e.y + 64) >> 4;
            const idx = (((e.y + 64) & 15) << 8) | (lz << 4) | lx;
            const w = open(cx, cz);
            const f = store.final(cx, cz)!;
            const p = store.proto(cx, cz)!;
            const generated = generatedAt(p, e.x, e.y, e.z);
            const value = e.op === 'revert' ? generated : e.value;
            const oldState = f.block(lx, e.y, lz);
            const oldFluid = f.fluid(lx, e.y, lz);
            // The section into scratch, the voxel set.
            const b = f.sectionBlocks(sy);
            const fl = f.sectionFluid(sy);
            if (typeof b === 'number') s.blocks.fill(b);
            else s.blocks.set(b);
            if (typeof fl === 'number') s.fluid.fill(fl);
            else s.fluid.set(fl);
            s.blocks[idx] = value >>> 8;
            s.fluid[idx] = value & 0xFF;
            // The old heights, before the write (raw aux values, y + 1).
            const aux = w.aux();
            const at = (lz << 4) | lx;
            const oldLb = aux.lightBlocking[at]!;
            const fromY = Math.min(319, Math.max(e.y, aux.worldSurface[at]! - 1, aux.oceanFloor[at]! - 1, aux.motionBlocking[at]! - 1, oldLb - 1));
            // The dirty set gains each write's columns before the write, so a rollback remeshes what a MESH may have read.
            // The edited column and the neighbours whose ring holds the voxel.
            addWithEdges(dirty, cx, cz, edgesOf(lx, lz));
            written = k + 1;
            if (!wroteBlocks.includes(w)) wroteBlocks.push(w);
            w.replaceBlocks(sy, s.blocks, s.fluid);
            w.setDiffFlag();
            patchHeightmaps(f.block, f.fluid, aux, lx, lz, fromY);

            // Relight the 3 × 3 (D19), then write back each section whose light changed.
            const r0 = now();
            const cache = s.cache;
            cache.open(store, cx, cz);
            const report = relight(cache, s.relight, ((e.y + ROW0) * W + 16 + lz) * W + 16 + lx, { state: oldState, fluid: oldFluid, lightBlocking: oldLb + ROW0 });
            // The relight's columns: each with a changed section, and the neighbours its border and corner bits face.
            for (let c = 0; c < COLUMNS; c++) {
              if (report.sections[c] !== 0 || report.edges[c] !== 0) addWithEdges(dirty, cx + (c % 3) - 1, cz + ((c / 3) | 0) - 1, report.edges[c]!);
            }
            for (let m = 0; m < cache.copiedCount(); m++) {
              const key = cache.copiedAt(m);
              const c = (key / SECTIONS) | 0;
              const ly = key - c * SECTIONS;
              if (((report.sections[c]! >>> ly) & 1) === 0) continue;
              const lw = open(cx + (c % 3) - 1, cz + ((c / 3) | 0) - 1);
              if (!wroteLight.includes(lw)) wroteLight.push(lw);
              lw.replaceLight(ly, cache.copy(key));
            }
            relightMs += now() - r0;

            // The DiffStore (D20): a revert, or a set equal to the generated value, removes the entry.
            prev[k] = diffs.get(cx, cz, sy, idx);
            if (e.op === 'revert' || value === generated) diffs.remove(cx, cz, sy, idx);
            else diffs.set(cx, cz, sy, idx, value);
            next[k] = diffs.get(cx, cz, sy, idx);
            recorded = k + 1;
          }
          for (const w of opened) w.publish();
        } catch (err) {
          // Any throw after validation runs the same recovery over its sub-batch (SIM-2); only a StoreFull in the first
          // sub-batch is a refusal, any other throw (and any in a later sub-batch, whose predecessors stay published) is
          // rethrown.
          for (const w of opened) w.rollback();
          // The heightmaps of each restored block column, rescanned whole.
          for (let k = s0; k < written; k++) {
            const e = edits[k]!;
            const w = store.reopenPublished(e.x >> 4, e.z >> 4);
            const f = store.final(e.x >> 4, e.z >> 4)!;
            patchHeightmaps(f.block, f.fluid, w.aux(), e.x & 15, e.z & 15, 319);
          }
          for (let k = recorded - 1; k >= s0; k--) {
            const e = edits[k]!;
            const cx = e.x >> 4;
            const cz = e.z >> 4;
            const sy = (e.y + 64) >> 4;
            const idx = (((e.y + 64) & 15) << 8) | ((e.z & 15) << 4) | (e.x & 15);
            if (prev[k] === NO_ENTRY) diffs.remove(cx, cz, sy, idx);
            else diffs.set(cx, cz, sy, idx, prev[k]!);
          }
          // After the restore, so a MESH that read the batch's slots holds the old versions and is dropped (§2.1).
          const table = store.table;
          for (const w of wroteBlocks) table.bumpBlockVersion(table.find(w.cx, w.cz));
          for (const w of wroteLight) table.bumpLightVersion(table.find(w.cx, w.cz));
          if (s0 > 0 || !(err instanceof StoreFull)) throw err;
          refused = 'full';
          break;
        }
        // The sub-batch's figures (SP5c spec §3.2): its retires still wait in this thread's limbo until the drain.
        limboMax = Math.max(limboMax, store.limboCount(store.thread));
        subBatchMaxMs = Math.max(subBatchMaxMs, now() - ts);
        // The drain between sub-batches; the last sub-batch's `exitRead` is the `finally`'s.
        if (end < n) {
          reading = false;
          store.exitRead();
          store.enterRead();
          reading = true;
        }
      }
    }
    if (refused !== null) {
      for (let k = 0; k < n; k++) {
        const e = edits[k]!;
        prev[k] = next[k] = diffs.get(e.x >> 4, e.z >> 4, (e.y + 64) >> 4, (((e.y + 64) & 15) << 8) | ((e.z & 15) << 4) | (e.x & 15));
      }
    }
  } finally {
    if (reading) store.exitRead();
  }
  // A refused batch left the DiffStore as it found it: no change to report.
  const added: number[] = [];
  const removed: number[] = [];
  if (refused === null) {
    for (const [key, before] of had) {
      const after = diffs.has(colKeyCx(key), colKeyCz(key));
      if (after && !before) added.push(key);
      else if (before && !after) removed.push(key);
    }
  }
  return {
    prev,
    next,
    dirty: Float64Array.from(dirty),
    entryAdded: Float64Array.from(added),
    entryRemoved: Float64Array.from(removed),
    refused,
    relightMs,
    editMs: now() - t0,
    limboMax,
    subBatchMaxMs,
  };
}

/** Column (cx, cz)'s entries for D's overlay (§2.5), in fresh arrays, or null when it holds none (ruling R9). */
export function readDiff(diffs: DiffStore, cx: number, cz: number): ColumnDiff | null {
  return diffs.columnDiff(cx, cz);
}

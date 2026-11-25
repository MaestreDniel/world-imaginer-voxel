/**
 * The region core (SP3a spec §6.1, §6.2), shared by the goldens, the slice job and the test harness (`src` never
 * imports `test/`): `fillColumnT` runs the T stage on one claimed column, `genRegionInProcess` fills a
 * region in process, and `regionHash` digests any generated window. Follows the core determinism rules
 * (in `DET_FILES`, arch-tested).
 * SP7a (spec §13.4, §15.3; ruling P36): `fillColumnD`, the D job's core, lives here beside `fillColumnT` (the workers
 * import both), so `genRegionDInProcess` decorates a window's interior in process as the workers do, and
 * `finalFluidHash` digests the settled fluid (`sp7a.region.D.water`).
 */
import { createFnv64, type Fnv64 as Fnv64T, type Hash64 } from '../core/hash';
import type { GenContext } from '../gen/context';
import { decorateStage } from '../gen/pipeline/decorateStage';
import { terrainStage } from '../gen/pipeline/terrainStage';
import type { ColumnDiff } from '../world/store/api';
import type { VoxelStore } from '../world/store/store';

const CREATE_FNV = createFnv64;
const DECORATE = decorateStage;
const TERRAIN = terrainStage;

const NEVER = (): boolean => false;
/** Dense block sections are hashed through a byte view of their slot when the platform is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** A region (or window) is 1 … 64 columns per side: a larger one would collide on the 64 × 64 torus. */
function checkRegion(what: string, w: number, h: number): void {
  for (const [name, v] of [['w', w], ['h', h]] as const) {
    if ((v | 0) !== v || v < 1 || v > 64) throw new RangeError(`${what}: ${name} = ${v} outside 1 … 64`);
  }
}

/**
 * Claims (cx, cz) with `epoch`, runs the T stage and commits it at status Proto; when `stop()` fires
 * (or the stage throws) it frees the column instead, which releases the sections already written and leaves the
 * record free. True when the column was committed. Throws `SlotBusy` when the record is held.
 */
export function fillColumnT(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean, epoch = 0): boolean {
  const w = store.claimColumn(cx, cz, epoch);
  let done: boolean;
  try {
    done = TERRAIN(ctx, cx, cz, w, stop);
  } catch (e) {
    store.freeColumn(cx, cz);
    throw e;
  }
  if (done) w.commit(1);
  else store.freeColumn(cx, cz);
  return done;
}

/** `fillColumnT` (never stopped, epoch 0) for every column of the w × h region at (cx0, cz0), cz outer, cx inner. */
export function genRegionInProcess(store: VoxelStore, ctx: GenContext, cx0: number, cz0: number, w: number, h: number): void {
  checkRegion('genRegionInProcess', w, h);
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) fillColumnT(store, ctx, cx, cz, NEVER);
  }
}

/**
 * The D job of (cx, cz) (SP4a spec §2.3): `reopenColumn(cx, cz, 1)`, the D skeleton over `store.neighborhood(cx, cz)`
 * (§3), then `commit(2)`. True when the column was committed at Decorated. A stop (false) or a throw leaves the
 * column at Proto with its versions unchanged: the skeleton writes nothing before its shares, and nothing is committed.
 * Throws when the column is not at Proto (`reopenColumn`) or a source column of its 3 × 3 is missing.
 * SP5a (spec §2.5, D21): `diff`, the column's edit entries from the sim, is overlaid by `decorateStage` (null: none).
 */
export function fillColumnD(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean, diff: ColumnDiff | null = null): boolean {
  const w = store.reopenColumn(cx, cz, 1);
  if (!DECORATE(ctx, store.neighborhood(cx, cz), w, stop, diff)) return false;
  w.commit(2);
  return true;
}

/**
 * `genRegionInProcess` over the w × h window at (cx0, cz0), then `fillColumnD` (never stopped, no diff) for every column
 * of its interior, the window without its outer ring ((w − 2) × (h − 2) at (cx0 + 1, cz0 + 1), cz outer, cx inner), each
 * from its own 3 × 3 at Proto (SP7a spec §13.4). Throws when the window has no interior (w or h below 3).
 */
export function genRegionDInProcess(store: VoxelStore, ctx: GenContext, cx0: number, cz0: number, w: number, h: number): void {
  checkRegion('genRegionDInProcess', w, h);
  if (w < 3 || h < 3) throw new RangeError(`genRegionDInProcess: a ${w} × ${h} window has no interior`);
  genRegionInProcess(store, ctx, cx0, cz0, w, h);
  for (let cz = cz0 + 1; cz < cz0 + h - 1; cz++) {
    for (let cx = cx0 + 1; cx < cx0 + w - 1; cx++) fillColumnD(store, ctx, cx, cz, NEVER);
  }
}

function hashWords(fnv: Fnv64T, a: Uint16Array): void {
  if (LITTLE_ENDIAN) {
    fnv.update(new Uint8Array(a.buffer, a.byteOffset, 2 * a.length));
    return;
  }
  for (let i = 0; i < a.length; i++) fnv.updateU16LE(a[i]!);
}

/**
 * FNV-1a 64 of the w × h window at (cx0, cz0) (SP3a spec §6.2): cz outer, cx inner; per column, for sy 0 … 23 the
 * 4096 proto block states (u16 little-endian, voxel-index order), the 4096 proto fluid bytes, then the 4096 proto cave
 * bytes (SP6a spec §3.3; uniform sections expanded, "no fluid" and "no cave" as 0; T-only regions have no final set,
 * so the proto's channel is the one hashed), then the column's 4096 aux A bytes and its 4096 aux B bytes (SP3b spec
 * §7; each zeros when the column has no such slot, so an absent slot hashes like a zero-filled one). Independent of
 * generation order, thread count, backend and slot layout. Throws when a column of the window is not at status ≥
 * Proto.
 */
export function regionHash(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): Hash64 {
  checkRegion('regionHash', w, h);
  const fnv = CREATE_FNV();
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = store.proto(cx, cz);
      if (v === null) throw new Error(`regionHash: column (${cx}, ${cz}) has no proto set in the store`);
      for (let sy = 0; sy < 24; sy++) {
        const b = v.sectionBlocks(sy);
        if (typeof b === 'number') fnv.updateRepeatU16LE(b, 4096);
        else hashWords(fnv, b);
        const f = v.sectionFluid(sy);
        if (typeof f === 'number') fnv.updateRepeatU8(f, 4096);
        else fnv.update(f);
        const c = v.sectionCave(sy);
        if (typeof c === 'number') fnv.updateRepeatU8(c, 4096);
        else fnv.update(c);
      }
      const a = v.aux();
      // The aux A fields tile the 4096-byte slot from worldSurfaceWG (offset 0) on; Int16 values are native LE.
      if (a === null) fnv.updateRepeatU8(0, 4096);
      else fnv.update(new Uint8Array(a.worldSurfaceWG.buffer, a.worldSurfaceWG.byteOffset, 4096));
      const b = v.auxB();
      // caveBiomeQ sits at offset 0 of the aux B slot, so a 4096-byte view from it is the whole slot.
      if (b === null) fnv.updateRepeatU8(0, 4096);
      else fnv.update(new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096));
    }
  }
  return fnv.digest();
}

/**
 * FNV-1a 64 of the final fluid of the w × h window at (cx0, cz0) (SP7a spec §13.4, §15.3): cz outer, cx inner; per
 * column its 24 sections' 4096 fluid bytes in section order, voxel-index order within each, uniform sections expanded
 * (as `regionHash` hashes the proto's), so it covers D's settle and nothing else. Throws when a column of the window has
 * no final set (status below Decorated).
 */
export function finalFluidHash(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): Hash64 {
  checkRegion('finalFluidHash', w, h);
  const fnv = CREATE_FNV();
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = store.final(cx, cz);
      if (v === null) throw new Error(`finalFluidHash: column (${cx}, ${cz}) has no final set in the store`);
      for (let sy = 0; sy < 24; sy++) {
        const f = v.sectionFluid(sy);
        if (typeof f === 'number') fnv.updateRepeatU8(f, 4096);
        else fnv.update(f);
      }
    }
  }
  return fnv.digest();
}

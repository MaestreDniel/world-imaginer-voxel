/**
 * The region core (SP3a spec §6.1, §6.2), shared by the goldens, the slice job and the test harness (`src` never
 * imports `test/`): `fillColumnT` runs the T stage on one claimed column, `genRegionInProcess` fills a
 * region in process, and `regionHash` digests any generated window. Follows the core determinism rules
 * (in `DET_FILES`, arch-tested).
 */
import { createFnv64, type Fnv64 as Fnv64T, type Hash64 } from '../core/hash';
import type { GenContext } from '../gen/context';
import { terrainStage } from '../gen/pipeline/terrainStage';
import type { VoxelStore } from '../world/store/store';

const CREATE_FNV = createFnv64;
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

function hashWords(fnv: Fnv64T, a: Uint16Array): void {
  if (LITTLE_ENDIAN) {
    fnv.update(new Uint8Array(a.buffer, a.byteOffset, 2 * a.length));
    return;
  }
  for (let i = 0; i < a.length; i++) fnv.updateU16LE(a[i]!);
}

/**
 * FNV-1a 64 of the w × h window at (cx0, cz0) (SP3a spec §6.2): cz outer, cx inner; per column, for sy 0 … 23 the
 * 4096 proto block states (u16 little-endian, voxel-index order) then the 4096 proto fluid bytes (uniform sections
 * expanded, "no fluid" as 0), then the column's 4096 aux A bytes and its 4096 aux B bytes (SP3b spec §7; each zeros
 * when the column has no such slot, so an absent slot hashes like a zero-filled one). Independent of
 * generation order, thread count, backend and slot layout. Throws when a column of the window is not at
 * status ≥ Proto.
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

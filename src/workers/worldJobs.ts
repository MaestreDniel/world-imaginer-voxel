/**
 * The world column jobs on the attached shared store (SP4a spec §2.3), run by the task handler. SP4a builds them in
 * turn: so far the D job's core, `fillColumnD`; T is `fillColumnT` (`metrics/region.ts`), and L, MESH_COLUMN and the
 * reply wrappers follow.
 */
import type { GenContext } from '../gen/context';
import { decorateStage } from '../gen/pipeline/decorateStage';
import type { VoxelStore } from '../world/store/store';

const DECORATE = decorateStage;

/**
 * The D job of (cx, cz) (SP4a spec §2.3): `reopenColumn(cx, cz, 1)`, the D skeleton over `store.neighborhood(cx, cz)`
 * (§3), then `commit(2)`. True when the column was committed at Decorated. A stop (false) or a throw leaves the
 * column at Proto with its versions unchanged: the skeleton writes nothing before its shares, and nothing is committed.
 * Throws when the column is not at Proto (`reopenColumn`) or a source column of its 3 × 3 is missing.
 */
export function fillColumnD(store: VoxelStore, ctx: GenContext, cx: number, cz: number, stop: () => boolean): boolean {
  const w = store.reopenColumn(cx, cz, 1);
  if (!DECORATE(ctx, store.neighborhood(cx, cz), w, stop)) return false;
  w.commit(2);
  return true;
}

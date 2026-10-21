/**
 * The world column jobs on the attached shared store (SP4a spec §2.3), run by the task handler. SP4a builds them in
 * turn: so far the D and L jobs' cores, `fillColumnD` and `fillColumnL`; T is `fillColumnT` (`metrics/region.ts`),
 * and MESH_COLUMN and the reply wrappers follow.
 */
import type { GenContext } from '../gen/context';
import { decorateStage } from '../gen/pipeline/decorateStage';
import { centreSection, lightRegion, type LightScratch } from '../light/initial';
import { SECTIONS } from '../world/store/columnTable';
import { copyLightRegion } from '../world/store/padded';
import type { VoxelStore } from '../world/store/store';

const DECORATE = decorateStage;
const COPY_LIGHT_REGION = copyLightRegion;
const LIGHT_REGION = lightRegion;
const CENTRE_SECTION = centreSection;
const SECTION_COUNT = SECTIONS;

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

/**
 * The L job of (cx, cz) (SP4a spec §2.3, §4.2): reads the 3 × 3 `versions()`, `reopenColumn(cx, cz, 2)`, copies the
 * light region (`copyLightRegion`), runs the light (`lightRegion`), writes the centre's 24 sections with `setLight`
 * (uniform sections store no slot) and `commit(3)`. Returns the versions read before the job (the coordinator's
 * intake compares their blockVersions), or null when `stop` fires; it polls after the copy and after the BFS, and a
 * stop writes nothing, so the column stays at Decorated with its versions. Throws when the column is not at
 * Decorated (`reopenColumn`) or a column of its 3 × 3 has no final set (`copyLightRegion`).
 */
export function fillColumnL(store: VoxelStore, cx: number, cz: number, s: LightScratch, stop: () => boolean): Int32Array | null {
  const nb = store.neighborhood(cx, cz);
  const versions = nb.versions();
  const w = store.reopenColumn(cx, cz, 2);
  COPY_LIGHT_REGION(nb, s.region);
  if (stop()) return null;
  LIGHT_REGION(s);
  if (stop()) return null;
  for (let sy = 0; sy < SECTION_COUNT; sy++) w.setLight(sy, CENTRE_SECTION(s, sy));
  w.commit(3);
  return versions;
}

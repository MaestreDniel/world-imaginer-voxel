/**
 * The caves metric's region worker (SP6b spec §13 L6, ruling P6), bundled by
 * `buildNodeTaskWorker(dir, {entry: 'test/harness/caveRegionWorker.ts'})` and driven by `measureCaveRegions`
 * (`caveSites.ts`) with 4 of them; `test/metrics/caves.metric.ts` pools what they return. Never part of
 * `src/workers/protocol.ts`.
 *
 * Message: `{type: 'region', handles, site, params, stride}`, one per region: the worker attaches the shared store that
 * `genRegion` filled from the region's cached dump (or generated and dumped), reads the region through `regionView`
 * with the debug readings (`pillar`, `terrainT`) on its own DensityContext of the region's seed and params, as
 * `genRegion`'s `debugTags` does, and answers `{type: 'measured', label, result}` with `measureCaveRegion`'s result,
 * the typed arrays' buffers transferred (`countsTransfer`). Anything that throws is answered `{type: 'error', message}`.
 *
 * `measureCaveRegion` is the metric's per-region pass, in one function so the worker and an in-process caller (the unit
 * test) run the same code: the grid, the pre-cave tops and the components once; C1-C6's counts (the default group
 * and `cave_heavy`'s regions), C7-C9's, C7's bottom counts (SP6b spec §12.3), B3's border counts (§12.2), the review
 * poses and SP6b's (`bottomCavern`; the default group's seed '42' default regions only), the biome region's poses and
 * T window (the biomes group's default-profile region, Task 27); then C7's construction counts, `regionCounts` against
 * `referenceCarve`, whose raw reference array never leaves the thread (ruling P6), except in the biomes group, whose
 * job registers no `carverReference`.
 */
import type { Params } from '../../src/core/params/schema';
import { createDensityContext } from '../../src/gen/density/context';
import { attachStore, type StoreHandles } from '../../src/world/store/store';
import {
  biomeTileMasks, CAP_AIR_Y, caveBiomeExamples, caveBorderCounts, caveBottomCounts, caveC7C9Counts, caveComponents, caveExamples, caveGridOf, caveRegionCounts, countsTransfer, flatWallDetail,
  landMask, localThickness, preCaveTops, ravinePathsOf, regionCounts, riverMaskOf, sp6bCaveExamples, wetMask,
  type BiomeExampleId, type CarverRegionCounts, type CaveBorderCounts, type CaveBottomCounts, type CaveC7C9Counts, type CavePose, type CaveRegionCounts, type ExampleId,
  type Sp6bExampleId,
} from './caveMetrics';
import type { Site } from './caveSites';
import { referenceCarve } from './refs';
import { regionView, type RegionView } from './regionView';
import { genContextWith } from './regionWorker';

/** One region's measurements (ruling P6): every field structured-cloneable. */
export interface CaveRegionResult {
  /**
   * C1-C6's counts: the default group's regions (default and large_biomes) and `cave_heavy`'s (its C1 and C2, SP6b spec
   * §12.3), else null.
   */
  readonly c16: CaveRegionCounts | null;
  readonly c79: CaveC7C9Counts;
  /**
   * C7's bottom counts (SP6b spec §12.3): the flat floors on the bedrock plane, all flat faces, the exposed bedrock and
   * the bedrock, and the accumulators of bottomFlatRatio, bottomFloorSpread and the records (Task 21).
   */
  readonly bottom: CaveBottomCounts;
  /**
   * B3's border counts (SP6b spec §12.2; Task 26): per biome pair and overall, the border faces per axis and plane
   * residue mod 4, the cave-air face pairs, the straight runs on every 4th layer, the planar patches and the skin by a
   * border.
   */
  readonly borders: CaveBorderCounts;
  /** The review poses: the seed '42' default regions only, else null. */
  readonly examples: Record<ExampleId, CavePose | null> | null;
  /** SP6b's review poses (`bottomCavern`; rulings P17, P59): the seed '42' default regions only, else null. */
  readonly sp6bExamples: Record<Sp6bExampleId, CavePose | null> | null;
  /** The biome region's review poses (`caveBiomeExamples`, Task 27): the biomes group's biome region only, else null. */
  readonly biomeExamples: Record<BiomeExampleId, CavePose | null> | null;
  /**
   * The biome region's stored-nibble mask per 8 × 8-chunk tile (`biomeTileMasks`; ruling P33's T check, re-checked by the
   * metric): the biome region only, else null.
   */
  readonly biomeTiles: number[] | null;
  /**
   * The ms of the shared grid and components, of C1-C6 (with the thickness), of C7-C9, of the bottom, of the border
   * counts, of the poses (every list, and the biome region's tile masks).
   */
  readonly ms: { shared: number; c16: number; c79: number; bottom: number; borders: number; examples: number };
  /**
   * C7's construction counts: `regionCounts(view, referenceCarve(…), capY)`, capY on floating_islands only; null in the
   * biomes group (its job registers no C7 call).
   */
  readonly carver: CarverRegionCounts | null;
}

export interface CaveRegionMsg {
  readonly type: 'region';
  readonly handles: StoreHandles;
  readonly site: Site;
  readonly params: Params;
  /** C7.switchWall's chunk stride. */
  readonly stride: number;
}

export type CaveRegionReply =
  | { type: 'measured'; label: string; result: CaveRegionResult }
  | { type: 'error'; message: string };

/** The parts of `measureCaveRegion` that read the grid (its own function, so the grid is released before the carver pass). */
function measureGrid(view: RegionView, site: Site, params: Params, stride: number): Omit<CaveRegionResult, 'carver'> {
  // The default group (the default and large_biomes profiles; C7-C9's "default" group), `cave_heavy`'s regions (C1, C2
  // and C9 recorded on it, SP6b spec §12.3) and the biome region (the biomes group's default-profile region, §12.2).
  const isDefault = site.group === 'default';
  const caveHeavy = site.profile === 'cave_heavy';
  const biomeRegion = site.group === 'biomes' && site.profile === 'default';
  const t0 = performance.now();
  const grid = caveGridOf(view);
  const tops = preCaveTops(grid);
  const c = caveComponents(grid, tops);
  const t1 = performance.now();
  const pillar = (x: number, y: number, z: number): boolean => view.pillar(x, y, z);
  const thick = isDefault || caveHeavy ? localThickness(c, grid.w, grid.d) : null;
  const c16 = isDefault || caveHeavy ? caveRegionCounts(grid, pillar, ravinePathsOf(grid, site.seed, params), 128, { tops, c, thick }) : null;
  const t2 = performance.now();
  const land = landMask(grid);
  const river = riverMaskOf(grid, site.seed, params);
  const eligible = land.map((v, p) => (v === 1 && river[p] === 0 ? 1 : 0));
  const seaFloor = site.profile === 'archipelago' ? wetMask(grid) : null;
  const c79 = caveC7C9Counts(grid, tops, c, {
    T: isDefault ? (x, y, z) => view.terrainT(x, y, z) : null, stride, eligible, seaFloor,
  });
  const t3 = performance.now();
  // C7.bottomPlane's flat faces are every position's (C7.flatWallShare's are the sea floor's on archipelago).
  const bottom = caveBottomCounts(grid, seaFloor === null ? c79.flat : flatWallDetail(grid), c);
  const t4 = performance.now();
  const borders = caveBorderCounts(grid);
  const t5 = performance.now();
  const poses = isDefault && site.seed === '42' && site.profile === 'default';
  const examples = poses ? caveExamples(grid, tops, c, thick, pillar) : null;
  const sp6bExamples = poses ? sp6bCaveExamples(grid, c) : null;
  const biomeExamples = biomeRegion ? caveBiomeExamples(grid, c) : null;
  const biomeTiles = biomeRegion ? biomeTileMasks(grid) : null;
  const t6 = performance.now();
  return {
    c16, c79, bottom, borders, examples, sp6bExamples, biomeExamples, biomeTiles,
    ms: {
      shared: Math.round(t1 - t0), c16: Math.round(t2 - t1), c79: Math.round(t3 - t2), bottom: Math.round(t4 - t3),
      borders: Math.round(t5 - t4), examples: Math.round(t6 - t5),
    },
  };
}

/**
 * One region's measurements (see the header) over `view`, which must carry the debug readings (`debugTags`, or a
 * DensityContext of the region's seed and params). `params` are the site's profile's, `stride` C7.switchWall's.
 */
export function measureCaveRegion(view: RegionView, site: Site, params: Params, stride: number): CaveRegionResult {
  const measured = measureGrid(view, site, params, stride);
  const carver = site.group === 'biomes'
    ? null
    : regionCounts(view, referenceCarve(view, site.seed, params), site.profile === 'floating_islands' ? CAP_AIR_Y : null);
  return { ...measured, carver };
}

interface Reply {
  msg: CaveRegionReply;
  transfer: Transferable[];
}

export function createTaskHandler(): { handle(raw: unknown): Reply } {
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown };
        if (m.type !== 'region') throw new Error(`cave region worker: unknown message '${String(m.type)}'`);
        const { handles, site, params, stride } = raw as CaveRegionMsg;
        const view = regionView(attachStore(handles), site.cx0, site.cz0, site.size, site.size, {
          debug: createDensityContext(genContextWith(site.seed, params)),
        });
        const result = measureCaveRegion(view, site, params, stride);
        return { msg: { type: 'measured', label: site.label, result }, transfer: countsTransfer(result) };
      } catch (e) {
        return { msg: { type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) }, transfer: [] };
      }
    },
  };
}

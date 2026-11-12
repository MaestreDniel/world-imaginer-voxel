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
 * only), C7-C9's, the review poses (seed '42' default only); then C7's construction counts, `regionCounts` against
 * `referenceCarve`, whose raw reference array never leaves the thread (ruling P6).
 */
import type { Params } from '../../src/core/params/schema';
import { createDensityContext } from '../../src/gen/density/context';
import { attachStore, type StoreHandles } from '../../src/world/store/store';
import {
  CAP_AIR_Y, caveC7C9Counts, caveComponents, caveExamples, caveGridOf, caveRegionCounts, countsTransfer, landMask, localThickness,
  preCaveTops, ravinePathsOf, regionCounts, riverMaskOf, wetMask,
  type CarverRegionCounts, type CaveC7C9Counts, type CavePose, type CaveRegionCounts, type ExampleId,
} from './caveMetrics';
import type { Site } from './caveSites';
import { referenceCarve } from './refs';
import { regionView, type RegionView } from './regionView';
import { genContextWith } from './regionWorker';

/** One region's measurements (ruling P6): every field structured-cloneable. */
export interface CaveRegionResult {
  /** C1-C6's counts: the default group's regions (default and large_biomes) only, else null. */
  readonly c16: CaveRegionCounts | null;
  readonly c79: CaveC7C9Counts;
  /** The review poses: the seed '42' default regions only, else null. */
  readonly examples: Record<ExampleId, CavePose | null> | null;
  /** The ms of the shared grid and components, of C1-C6 (with the thickness), of C7-C9, of the poses. */
  readonly ms: { shared: number; c16: number; c79: number; examples: number };
  /** C7's construction counts: `regionCounts(view, referenceCarve(…), capY)`, capY on floating_islands only. */
  readonly carver: CarverRegionCounts;
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
  // The group of C7-C9's "default and presets": 'default' for the default and large_biomes profiles.
  const isDefault = site.profile === 'default' || site.profile === 'large_biomes';
  const t0 = performance.now();
  const grid = caveGridOf(view);
  const tops = preCaveTops(grid);
  const c = caveComponents(grid, tops);
  const t1 = performance.now();
  const pillar = (x: number, y: number, z: number): boolean => view.pillar(x, y, z);
  const thick = isDefault ? localThickness(c, grid.w, grid.d) : null;
  const c16 = isDefault ? caveRegionCounts(grid, pillar, ravinePathsOf(grid, site.seed, params), 128, { tops, c, thick }) : null;
  const t2 = performance.now();
  const land = landMask(grid);
  const river = riverMaskOf(grid, site.seed, params);
  const eligible = land.map((v, p) => (v === 1 && river[p] === 0 ? 1 : 0));
  const c79 = caveC7C9Counts(grid, tops, c, {
    T: isDefault ? (x, y, z) => view.terrainT(x, y, z) : null, stride, eligible,
    seaFloor: site.profile === 'archipelago' ? wetMask(grid) : null,
  });
  const t3 = performance.now();
  const examples = site.seed === '42' && site.profile === 'default' ? caveExamples(grid, tops, c, thick, pillar) : null;
  const t4 = performance.now();
  return {
    c16, c79, examples,
    ms: { shared: Math.round(t1 - t0), c16: Math.round(t2 - t1), c79: Math.round(t3 - t2), examples: Math.round(t4 - t3) },
  };
}

/**
 * One region's measurements (see the header) over `view`, which must carry the debug readings (`debugTags`, or a
 * DensityContext of the region's seed and params). `params` are the site's profile's, `stride` C7.switchWall's.
 */
export function measureCaveRegion(view: RegionView, site: Site, params: Params, stride: number): CaveRegionResult {
  const measured = measureGrid(view, site, params, stride);
  const carver = regionCounts(view, referenceCarve(view, site.seed, params), site.profile === 'floating_islands' ? CAP_AIR_Y : null);
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

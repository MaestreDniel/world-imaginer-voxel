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
 * test) run the same code: first (SP7a spec §13.1-§13.2, D30) the global settle reference over the region's T
 * (`settleRegion`: `referenceSettle` per tile of at most 16 × 16 chunks, each over itself grown by one chunk, the settle's
 * radius, so its working set stays near 0.5 GB per worker on a 32 × 32-chunk region and the overlay equals the whole
 * region's), whose parts read the interior, 2 chunks in from the edge (`interiorOf`); then the grid, the pre-cave tops and
 * the components once; C1-C6's counts (the default group
 * and `cave_heavy`'s regions), C7-C9's, C7's bottom counts (SP6b spec §12.3), B3's border counts (§12.2, with the cave
 * air per biome), `B3.abyssRockStraight`'s counts (§12.2, Task 28: the default group's regions and the biome region), the review
 * poses and SP6b's (`bottomCavern`; the default group's seed '42' default regions only), the biome region's poses and
 * T window (the biomes group's default-profile region, Task 27); then C7's construction counts, `regionCounts` against
 * `referenceCarve`, whose raw reference array never leaves the thread (ruling P6), except in the biomes group, whose
 * job registers no `carverReference`; then the A parts' counts (`water.ts`' `waterRegionCounts`, with the margin
 * barriers' probes) and, on the seed '42' regions, SP7a's review poses (`waterExamplesOf`, each region's profile's). C7.waterWall reads
 * the settled bytes on the interior and the proto's rules reader for the spread sides (`caveC7C9Counts`' `water`).
 */
import type { Params } from '../../src/core/params/schema';
import { createDensityContext } from '../../src/gen/density/context';
import { attachStore, type StoreHandles } from '../../src/world/store/store';
import {
  abyssRockCounts, barrierProbe, biomeTileMasks, CAP_AIR_Y, caveBiomeExamples, caveBorderCounts, caveBottomCounts, caveC7C9Counts, caveComponents, caveExamples, caveGridOf, caveRegionCounts, countsTransfer, flatWallDetail,
  landMask, localThickness, preCaveTops, ravinePathsOf, regionCounts, riverMaskOf, sp6bCaveExamples, wetMask,
  type AbyssRockCounts, type BiomeExampleId, type C7C9Options, type CarverRegionCounts, type CaveBorderCounts, type CaveBottomCounts, type CaveC7C9Counts, type CavePose, type CaveRegionCounts, type ExampleId,
  type Sp6bExampleId,
} from './caveMetrics';
import type { Site } from './caveSites';
import { referenceCarve, referenceSettle, referenceSettleKey } from './refs';
import { regionView, type RegionView } from './regionView';
import { genContextWith } from './regionWorker';
import {
  loadWaterRegion, marginProbes, protoRuleReader, settledBytes, waterExamplesOf, waterRegionCounts, type WaterBox, type WaterExampleId, type WaterRegionCounts,
} from './water';

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
   * border, the cave air per biome (Task 28: `cave_heavy`'s shares).
   */
  readonly borders: CaveBorderCounts;
  /**
   * `B3.abyssRockStraight`'s counts (SP6b spec §12.2, Task 28; `abyssRockCounts`): the abyss rock's boundary edges on
   * walls, those in straight runs, the abyss walls; the default group's regions and the biome region only, else null.
   */
  readonly abyssRock: AbyssRockCounts | null;
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
   * counts, of the abyss rock's counts, of the poses (every list, and the biome region's tile masks); SP7a: of the settle
   * reference and of the A counts with SP7a's poses.
   */
  readonly ms: {
    shared: number; c16: number; c79: number; bottom: number; borders: number; abyssRock: number; examples: number; settle: number; water: number;
  };
  /**
   * C7's construction counts: `regionCounts(view, referenceCarve(…), capY, barrierProbe(…))` (SP7a: the aquifer's
   * barriers excluded), capY on floating_islands only; null in the
   * biomes group (its job registers no C7 call).
   */
  readonly carver: CarverRegionCounts | null;
  /** The A parts' counts on the interior (SP7a spec §13.1, `waterRegionCounts`); null for a region without an interior. */
  readonly water: WaterRegionCounts | null;
  /** SP7a's review poses (§13.9, `waterExamplesOf`, nearest its profile's spawn): the seed '42' regions only, else null. */
  readonly waterExamples: Record<WaterExampleId, CavePose | null> | null;
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

/** The chunks a region's interior lies in from each edge (SP7a spec §13.1: 2 chunks, beyond the settle's radius of 16). */
export const INTERIOR_CHUNKS = 2;
/** `settleRegion`'s tile, in chunks per axis. */
export const SETTLE_TILE_CHUNKS = 16;

/** The interior of the view's region (`INTERIOR_CHUNKS` in from each edge); null when the region is too small to hold one. */
export function interiorOf(view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h'>): WaterBox | null {
  if (view.w <= 2 * INTERIOR_CHUNKS || view.h <= 2 * INTERIOR_CHUNKS) return null;
  return {
    x0: 16 * (view.cx0 + INTERIOR_CHUNKS), z0: 16 * (view.cz0 + INTERIOR_CHUNKS),
    x1: 16 * (view.cx0 + view.w - INTERIOR_CHUNKS), z1: 16 * (view.cz0 + view.h - INTERIOR_CHUNKS),
  };
}

/**
 * The global settle reference over the view's region (SP7a spec §13.4, D30), keyed `referenceSettleKey(view, …)`:
 * `referenceSettle` over each tile of at most `tile` × `tile` chunks (from the region's corner) grown by one chunk on
 * every side inside the region, its entries on the tile kept. A voxel's settled byte reads the proto within the settle's
 * radius only (cap + search = 16 blocks, §4.1, the margin D's 3 × 3 holds and `DT1.settleReference` checks), so each
 * tile's entries equal the whole region's while each tile's reference needs about (tile + 2)² / (w·h) of the whole one's
 * memory (the unit test compares the two).
 */
export function settleRegion(view: RegionView, tile = SETTLE_TILE_CHUNKS): Map<number, number> {
  const out = new Map<number, number>();
  for (let tz = 0; tz < view.h; tz += tile) {
    for (let tx = 0; tx < view.w; tx += tile) {
      const ax0 = Math.max(0, tx - 1);
      const az0 = Math.max(0, tz - 1);
      const sub: RegionView = {
        ...view, cx0: view.cx0 + ax0, cz0: view.cz0 + az0, w: Math.min(view.w, tx + tile + 1) - ax0, h: Math.min(view.h, tz + tile + 1) - az0,
      };
      const W = 16 * sub.w;
      const D = 16 * sub.h;
      const box = {
        x0: 16 * (view.cx0 + tx), z0: 16 * (view.cz0 + tz),
        x1: 16 * (view.cx0 + Math.min(view.w, tx + tile)), z1: 16 * (view.cz0 + Math.min(view.h, tz + tile)),
      };
      for (const [k, v] of referenceSettle(sub, box)) {
        const x = 16 * sub.cx0 + (k % W);
        const z = 16 * sub.cz0 + (Math.floor(k / W) % D);
        out.set(referenceSettleKey(view, x, Math.floor(k / (W * D)) - 64, z), v);
      }
    }
  }
  return out;
}

/** The parts of `measureCaveRegion` that read the grid (its own function, so the grid is released before the carver pass). */
function measureGrid(
  view: RegionView, site: Site, params: Params, stride: number, water: C7C9Options['water'],
): Omit<CaveRegionResult, 'carver' | 'water' | 'waterExamples' | 'ms'> & { ms: Omit<CaveRegionResult['ms'], 'settle' | 'water'> } {
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
    T: isDefault ? (x, y, z) => view.terrainT(x, y, z) : null, stride, eligible, seaFloor, ...(water === undefined ? {} : { water }),
  });
  const t3 = performance.now();
  // C7.bottomPlane's flat faces are every position's (C7.flatWallShare's are the sea floor's on archipelago).
  const bottom = caveBottomCounts(grid, seaFloor === null ? c79.flat : flatWallDetail(grid), c);
  const t4 = performance.now();
  const borders = caveBorderCounts(grid);
  const t5 = performance.now();
  const abyssRock = isDefault || biomeRegion ? abyssRockCounts(grid) : null;
  const t6 = performance.now();
  const poses = isDefault && site.seed === '42' && site.profile === 'default';
  const examples = poses ? caveExamples(grid, tops, c, thick, pillar) : null;
  const sp6bExamples = poses ? sp6bCaveExamples(grid, c) : null;
  const biomeExamples = biomeRegion ? caveBiomeExamples(grid, c) : null;
  const biomeTiles = biomeRegion ? biomeTileMasks(grid) : null;
  const t7 = performance.now();
  return {
    c16, c79, bottom, borders, abyssRock, examples, sp6bExamples, biomeExamples, biomeTiles,
    ms: {
      shared: Math.round(t1 - t0), c16: Math.round(t2 - t1), c79: Math.round(t3 - t2), bottom: Math.round(t4 - t3),
      borders: Math.round(t5 - t4), abyssRock: Math.round(t6 - t5), examples: Math.round(t7 - t6),
    },
  };
}

/**
 * One region's measurements (see the header) over `view`, which must carry the debug readings (`debugTags`, or a
 * DensityContext of the region's seed and params). `params` are the site's profile's, `stride` C7.switchWall's.
 */
export function measureCaveRegion(view: RegionView, site: Site, params: Params, stride: number): CaveRegionResult {
  const t0 = performance.now();
  const interior = interiorOf(view);
  const settled = settleRegion(view);
  const bytes = settledBytes(view, settled);
  const t1 = performance.now();
  const water = interior === null
    ? undefined
    : { settled: (x: number, y: number, z: number) => bytes.fl[referenceSettleKey(view, x, y, z)]!, box: interior, rules: protoRuleReader(view) };
  const measured = measureGrid(view, site, params, stride, water);
  const carver = site.group === 'biomes'
    ? null
    : regionCounts(view, referenceCarve(view, site.seed, params), site.profile === 'floating_islands' ? CAP_AIR_Y : null, barrierProbe(site.seed, params));
  const t2 = performance.now();
  let counts: WaterRegionCounts | null = null;
  let waterExamples: CaveRegionResult['waterExamples'] = null;
  if (interior !== null) {
    // The A counts and the poses read one load of the region (its grid, the settled bytes above, A1's labelling).
    const region = loadWaterRegion(view, settled, interior, bytes);
    counts = waterRegionCounts(view, settled, interior, marginProbes(site.seed, params), region);
    if (site.seed === '42') waterExamples = waterExamplesOf(view, settled, interior, site.seed, params, region);
  }
  const t3 = performance.now();
  return {
    ...measured, carver, water: counts, waterExamples,
    ms: { ...measured.ms, settle: Math.round(t1 - t0), water: Math.round(t3 - t2) },
  };
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

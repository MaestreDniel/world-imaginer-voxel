import { expect } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { deriveTree, FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { PROFILE_IDS, resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { biomeFamily, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { islandMaskAt } from '../../src/gen/column/islands';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createDensityContext } from '../../src/gen/density/context';
import { biomeSharesInto, biomeSharesLength, summarizeBiomeShares } from '../../src/metrics/biomeShares';
import { waterRaster } from '../../src/metrics/columnStats';
import { samplePoints } from '../../src/metrics/noiseStats';
import { sp3eWindow } from '../../src/metrics/sp3eGoldens';
import { AIR, GRASS_BLOCK } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { dt2Column, newDt2Acc, type Dt2Extension, type Dt2Stratum } from '../harness/dt2';
import { topDownHeightmaps } from '../harness/heightmaps';
import { metricTest } from '../harness/metric';
import { analyseColumnsThreaded, s1Values, s2Values, s3Values } from '../harness/surfaceAnalysis';
import { newSurfaceAcc, type SurfaceAcc } from '../harness/surfaceScatter';
import {
  analyseColumn, forEachColumnThreaded, newScatterScratch, newScattered, presetRecord, solidity, t1Values, t2Values, t3Values,
  t5Values, transitions, type Scattered,
} from '../harness/terrainScatter';
import {
  binCounts, branchHoldsAtTop, columnStates, componentKm2, groundRun, islandCount, islandRuns, landComponents, nearestRank,
  positionColumn, SIZE_CLASSES, sizeClasses, solidRuns,
} from '../harness/zMetrics';

/**
 * The draft presets' metrics (SP3e spec §5), on every tier, over archipelago, amplified and floating_islands resolved
 * with `resolveProfile`, in `PROFILE_IDS` order. Its own streams, so no existing stream draws differently; nothing here
 * enters `terrain.metric.ts`' or `surface.metric.ts`' per-profile worst-of.
 * - `DT2.presets` (§5.2, gated, max 0): per preset, seed '42', `Xoshiro128(fnv1a32('DT2.presets.<preset>'))`, chunk
 *   columns uniform in ±1024 chunks (fast 8, quick 32, full 128 per preset): the first half drawn as DT2 draws its
 *   columns, the second half feature columns from the same stream, kept when `columnPoint` at the centre block
 *   (16cx + 8, 16cz + 8) has offset0 ≥ 180 (amplified), offset0 within 63 ± 4 (archipelago) or islandMask ≥ 0.5
 *   (floating_islands; its first feature column also offset0 < 63: an island over the sea), at most 4096 draws per
 *   search. Each column runs DT2's checks through `dt2Column` (16 voxels and their cell corners, the 8 skin voxels),
 *   amplified's feature columns with 2 extra voxels in y 296 … 319 (the moved slide and ceiling).
 *   `presetProbeBulk`, `presetCompiledReference`, `presetSurfaceProbeBulk`, `presetSurfaceReference`: DT2's four parts
 *   on these columns; `presetNonFinite`: checked voxels and cell corners whose compiled or reference density is not
 *   finite; `presetHeightmaps`: positions whose aux A `worldSurfaceWG` or `oceanFloorWG` differs from the top-down scan
 *   of the column's blocks and fluid (`test/harness/heightmaps.ts`); `presetNoFeatureColumn`: searches that ended
 *   without a column. Extras per preset: columns, feature draws, voxels per stratum, corner values and, on
 *   floating_islands, the island voxels checked (solid, in a run whose bottom voxel is ≥ ISLAND_RUN_MIN_BOTTOM).
 * - `B1.presets` (§5.4, gated): archipelago's B1, computed as the default B1 call (`biomes.metric.ts`: the
 *   `B1.<s>` point streams, seeds 1 … k, fast 40k × 2, quick 100k × 4, full 250k × 8) on the archipelago ctx;
 *   `presetInputsDiffer` counts the presets among amplified and floating_islands whose B1 inputs (climate, shape,
 *   rivers, lakes, biomes) are not canonically the defaults' (at 0 their B1 is the default's, gated by `B1`).
 * - Z1-Z3 (§5.3, D16): the master's diagnostics on the drafts, rows `activeFrom: 'SP12'` gated on the quick and full
 *   tiers from SP12, recorded on every tier now (an inactive part never fails). Seeds '42' (fast, quick) or '42', '1',
 *   '2', '3' (full); columns generated up to the T stage on 4 region workers (`forEachColumnThreaded`, worker dir
 *   `presetRegionWorker-<tier>`), drawn per seed (cx then cz) from one stream per row.
 *   - `Z1` (amplified, `Xoshiro128(fnv1a32('Z1'))`, 64 / 256 / 1024 columns per seed in ±1024 chunks): among land
 *     positions (WS = OF, top = WS − 1), `overhangs` the share with ≥ 2 solid→air transitions at y ≥ top − 30 (T2's
 *     definition), `p99Top` the nearest-rank p99 of the tops; extras p5/p50/p95/max top, `topsAbove300` (share of tops
 *     ≥ 300), `topHist.<b>` (tops in [b, b + 10), b = 250 … 310), `cappedTops` (positions, land or not, with a solid voxel
 *     at y ≥ 316).
 *   - `Z2` (archipelago): `waterRaster` n × n cells at step 64 centred on (0, 0) (n 256 / 512 / 1024 per seed):
 *     `oceanShare` the share of cells with offset0 < 63; `islandsPer100km2` the 4-connected land components (offset0 ≥ 63)
 *     of ≥ 1 km² (border ones by clipped area) per 100 km² of raster, pooled over the seeds; extras: the island count,
 *     the components per size class, the largest component's km², `islandsPer100km2Step32` (the same extent at step 32),
 *     and over archipelago columns drawn as Z1's from `fnv1a32('Z2.columns')`: `landTopP99`, `landTopMax` and
 *     `beachShare` (land tops whose aux A biome is of the coast family: beach, snowy_beach, stony_shore).
 *   - `Z3` (floating_islands, `Xoshiro128(fnv1a32('Z3'))`, 64 / 256 / 1024 chunk columns per seed in [−4096, 4096)²
 *     blocks, generated on floating_islands, on `DEFAULTS` and on the ungated tree at the same columns): an island run is a
 *     solid run whose bottom voxel is ≥ ISLAND_RUN_MIN_BOTTOM; `islandColumns` the share of positions holding one;
 *     `grassTops` among those, the share whose highest island run's top voxel is grass_block. Extras: `runsPerIsland`,
 *     `topsAbove250` / `topsBelow200` (of the highest island run's top), `islandColumnsLiteral` / `islandColumnsDefault`
 *     (any solid voxel at y 190-270, floating_islands / DEFAULTS), `branchFalsePositives` (positions whose sky-open run,
 *     the highest, has the branch predicate at its top — runTop ≥ 181 and top − bottom ≤ 100 — with a bottom < 181 or
 *     at islandMask 0) and its share, `shadowDiff` (island positions whose ground top state — the top voxel of the highest
 *     run with bottom < 181 — differs from DEFAULTS', D21's shadow) and its count, `gateLoss` (island-run voxels of the
 *     ungated tree — the m `rangeChoice` replaced by its `inside` — minus the gated tree's, over the ungated count),
 *     `islandComponents` / `largestFootprint` (4-connected components of the island positions over the floating_islands
 *     golden window of seed '42', `sp3eWindow`, and the largest one's share of its 128² positions).
 * - Full tier only: the record-only calls `T1.presets`, `T2.presets`, `T3.presets`, `T5.presets` (`fnv1a32('T1-T5.presets')`)
 *   and `S1.presets` … `S3.presets` (`fnv1a32('S1-S3.presets')`, worker dir `presetSurfaceWorker-full`), seed '42',
 *   4096 columns per preset in ±1024 chunks, through `terrainScatter.ts` / `surfaceAnalysis.ts` in `'record'` mode;
 *   keys `<part>.<preset>`, populations `<part>.population.<preset>` (`presetRecord`); no parts, nothing gated, no
 *   worst-of; T4 not run (§5.5).
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

type DraftPreset = Extract<ProfileId, 'archipelago' | 'amplified' | 'floating_islands'>;
const isDraft = (p: ProfileId): p is DraftPreset => p === 'archipelago' || p === 'amplified' || p === 'floating_islands';
/** The three drafts in PROFILE_IDS order (archipelago, amplified, floating_islands). */
const PRESETS: readonly DraftPreset[] = PROFILE_IDS.filter(isDraft);

const SEED = '42';
const ctxOf = (preset: ProfileId, seed: string): GenContext => createGenContext(seedFromInput(seed), resolveProfile(preset));

const DT2_PRESET_COLUMNS = pick(8, 32, 128);
/** The default's DT2_RANGE: chunk columns uniform in ±1024 chunks. */
const DT2_PRESET_RANGE = 1024;
const FEATURE_DRAWS = 4096;
const AMPLIFIED_EXTRA = { count: 2, yLo: 296, yHi: 319 } as const;
const STRATA: readonly Dt2Stratum[] = ['uniform', 'bulk', 'top', 'extra'];

/** Whether chunk column (cx, cz) is a feature column of `preset` (`first`: its first feature column). */
function isFeatureColumn(ctx: GenContext, preset: DraftPreset, cx: number, cz: number, first: boolean): boolean {
  const c = columnPoint(ctx, 16 * cx + 8, 16 * cz + 8);
  switch (preset) {
    case 'amplified': return c.offset0 >= 180;
    case 'archipelago': return Math.abs(c.offset0 - 63) <= 4;
    case 'floating_islands': return c.islandMask >= 0.5 && (!first || c.offset0 < 63);
  }
}

metricTest('DT2', [
  'presetProbeBulk', 'presetCompiledReference', 'presetSurfaceProbeBulk', 'presetSurfaceReference', 'presetNonFinite',
  'presetHeightmaps', 'presetNoFeatureColumn',
], () => {
  const t0 = performance.now();
  const acc = newDt2Acc();
  const problems = acc.problems;
  let nonFinite = 0;
  let heightmaps = 0;
  let noFeature = 0;
  const extras: Record<string, number> = {};
  for (const preset of PRESETS) {
    const ctx = ctxOf(preset, SEED);
    const r = new Xoshiro128(fnv1a32(`DT2.presets.${preset}`));
    acc.label = `preset ${preset}, seed '${SEED}'`;
    const strata = new Map<Dt2Stratum, number>(STRATA.map((s) => [s, 0]));
    let islandVoxels = 0;
    let corners = 0;
    let columns = 0;
    let featureDraws = 0;
    const ext = (extra?: Dt2Extension['extra']): Dt2Extension => ({
      extra,
      voxel: (v) => {
        strata.set(v.stratum, strata.get(v.stratum)! + 1);
        if (!Number.isFinite(v.value) || !Number.isFinite(v.reference)) {
          nonFinite++;
          problems.push(`${acc.label}: (${v.x}, ${v.y}, ${v.z}) non-finite density: compiled ${v.value}, reference ${v.reference}`);
        }
        if (v.block !== AIR && v.runBottom !== null && v.runBottom >= ISLAND_RUN_MIN_BOTTOM) islandVoxels++;
      },
      corner: (cv, rc) => {
        corners++;
        if (!Number.isFinite(cv) || !Number.isFinite(rc)) {
          nonFinite++;
          problems.push(`${acc.label}: non-finite corner value: compiled ${cv}, reference ${rc}`);
        }
      },
      column: (view: ColumnView) => {
        const aux = view.aux()!;
        for (let p = 0; p < 256; p++) {
          const [ws, of] = topDownHeightmaps(view, p & 15, p >> 4);
          if (aux.worldSurfaceWG[p] !== ws || aux.oceanFloorWG[p] !== of) {
            heightmaps++;
            problems.push(`${acc.label}, column (${view.cx}, ${view.cz}), p ${p}: heightmaps ${aux.worldSurfaceWG[p]}/${aux.oceanFloorWG[p]} ≠ top-down ${ws}/${of}`);
          }
        }
      },
    });
    const half = DT2_PRESET_COLUMNS >> 1;
    for (let n = 0; n < half; n++) {
      const cx = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
      const cz = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
      dt2Column(ctx, cx, cz, r, acc, ext());
      columns++;
    }
    for (let k = 0; k < DT2_PRESET_COLUMNS - half; k++) {
      let found: [number, number] | null = null;
      for (let d = 0; d < FEATURE_DRAWS && found === null; d++) {
        const cx = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
        const cz = -DT2_PRESET_RANGE + r.nextInt(2 * DT2_PRESET_RANGE);
        featureDraws++;
        if (isFeatureColumn(ctx, preset, cx, cz, k === 0)) found = [cx, cz];
      }
      if (found === null) {
        noFeature++;
        problems.push(`${acc.label}: feature column ${k}: none in ${FEATURE_DRAWS} draws`);
        continue;
      }
      dt2Column(ctx, found[0], found[1], r, acc, ext(preset === 'amplified' ? AMPLIFIED_EXTRA : undefined));
      columns++;
    }
    extras[`columns.${preset}`] = columns;
    extras[`featureDraws.${preset}`] = featureDraws;
    for (const s of STRATA) extras[`voxels.${s}.${preset}`] = strata.get(s)!;
    extras[`cornerValues.${preset}`] = corners;
    if (preset === 'floating_islands') extras[`islandVoxels.${preset}`] = islandVoxels;
  }
  expect.soft(problems.slice(0, 20), `DT2.presets mismatches (tier ${TIER}), first 20 of ${problems.length}`).toEqual([]);
  return {
    presetProbeBulk: acc.probeBulk, presetCompiledReference: acc.compiledReference, presetSurfaceProbeBulk: acc.surfaceProbeBulk,
    presetSurfaceReference: acc.surfaceReference, presetNonFinite: nonFinite, presetHeightmaps: heightmaps,
    presetNoFeatureColumn: noFeature,
    voxels: acc.voxels, maskedVoxels: acc.maskedVoxels, cornerValues: acc.corners, columns: acc.columns,
    surfaceVoxels: acc.surfaceVoxels, surfaceExtraVoxels: acc.surfaceExtraVoxels, surfaceExtraSkipped: acc.surfaceExtraSkipped,
    ...extras,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
}, 600_000, { outName: 'DT2.presets' });

/** The parameter groups B1 reads (climate, offset0, the river flag, the lake gates, the biome table). */
const B1_INPUTS = ['climate', 'shape', 'rivers', 'lakes', 'biomes'] as const;

metricTest('B1', [
  'oceanFamilyArchipelago', 'minShareArchipelago', 'minRareShareArchipelago', 'largestLandArchipelago', 'tiesArchipelago',
  'outsideArchipelago', 'presetInputsDiffer',
], () => {
  const t0 = performance.now();
  const seeds = pick(2, 4, 8);
  const n = pick(40000, 100000, 250000);
  const sum = new Float64Array(biomeSharesLength());
  for (let s = 1; s <= seeds; s++) biomeSharesInto(ctxOf('archipelago', String(s)), samplePoints(`B1.${s}`, n), 0, n, sum);
  const r = summarizeBiomeShares(sum);
  const differ: Record<string, number> = {};
  for (const preset of PRESETS) {
    if (preset === 'archipelago') continue;
    const params = resolveProfile(preset);
    differ[`inputsDiffer.${preset}`] = B1_INPUTS.some((g) => canonicalJSON(params[g]) !== canonicalJSON(DEFAULTS[g])) ? 1 : 0;
  }
  const shares: Record<string, number> = {};
  SURFACE_BIOMES.forEach((name, id) => { shares[`share.${name}`] = r.shares[id]!; });
  return {
    oceanFamilyArchipelago: r.oceanFamily, minShareArchipelago: r.minShare, minRareShareArchipelago: r.minRareShare,
    largestLandArchipelago: r.largestLand, tiesArchipelago: r.ties, outsideArchipelago: r.outside,
    presetInputsDiffer: Object.values(differ).reduce((a, b) => a + b, 0),
    points: r.total, ...differ, ...shares,
    seconds: Math.round(performance.now() - t0) / 1000,
  };
}, 600_000, { outName: 'B1.presets' });

/** Seeds of Z1-Z3 (SP3e spec §5.1): '42' on the fast and quick tiers, T1-T5's four on the full tier. */
const Z_SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const Z_COLUMNS = pick(64, 256, 1024);
const Z2_RASTER = pick(256, 512, 1024);
/** Z1's and Z2's column range: terrain.metric.ts' default ±1024 chunks. */
const Z_RANGE = 1024;
/** Z3's window [−4096, 4096)² blocks: chunks [−256, 256). */
const Z3_RANGE = 256;
const REGION_WORKER_DIR = `presetRegionWorker-${TIER}`;
const SURFACE_WORKER_DIR = `presetSurfaceWorker-${TIER}`;
const SEA = 63;
/** The islands surface branch's `stoneDepth{ceiling}` offset (SP3e spec §4.1; a tree literal of the preset rules). */
const BRANCH_CEILING_OFFSET = 100;

const timed = (t0: number): number => Math.round(performance.now() - t0) / 1000;

/** `count` chunk columns drawn from `r`, cx then cz, each uniform in [−range, range). */
function drawColumns(r: Xoshiro128, count: number, range: number): Array<[number, number]> {
  const cols: Array<[number, number]> = [];
  for (let n = 0; n < count; n++) cols.push([-range + r.nextInt(2 * range), -range + r.nextInt(2 * range)]);
  return cols;
}

metricTest('Z1', ['overhangs', 'p99Top'], async () => {
  const t0 = performance.now();
  const r = new Xoshiro128(fnv1a32('Z1'));
  const params = resolveProfile('amplified');
  const solid = new Uint8Array(98304);
  const tops: number[] = [];
  let over = 0;
  let capped = 0;
  let positions = 0;
  let columns = 0;
  for (const seed of Z_SEEDS) {
    await forEachColumnThreaded(REGION_WORKER_DIR, seed, params, drawColumns(r, Z_COLUMNS, Z_RANGE), (view) => {
      solidity(view, solid);
      const aux = view.aux()!;
      columns++;
      for (let p = 0; p < 256; p++) {
        positions++;
        for (let y = 316; y <= 319; y++) if (solid[((y + 64) << 8) | p] === 1) { capped++; break; }
        const ws = aux.worldSurfaceWG[p]!;
        if (ws !== aux.oceanFloorWG[p]!) continue;
        const top = ws - 1;
        tops.push(top);
        if (transitions(solid, p, top - 30, top) >= 2) over++;
      }
    });
  }
  const sorted = Float64Array.from(tops).sort();
  return {
    overhangs: over / sorted.length,
    p99Top: nearestRank(sorted, 0.99),
    p5Top: nearestRank(sorted, 0.05), p50Top: nearestRank(sorted, 0.5), p95Top: nearestRank(sorted, 0.95),
    maxTop: sorted.length === 0 ? NaN : sorted[sorted.length - 1]!,
    topsAbove300: sorted.filter((t) => t >= 300).length / sorted.length,
    ...binCounts(sorted, 250, 319, 10, 'topHist.'),
    cappedTops: capped,
    landPositions: sorted.length, overhangPositions: over, positions, columns,
    seconds: timed(t0),
  };
}, 600_000, { outName: 'Z1' });

metricTest('Z2', ['oceanShare', 'islandsPer100km2'], async () => {
  const t0 = performance.now();
  const n = Z2_RASTER;
  let cells = 0;
  let ocean = 0;
  let islands = 0;
  let islands32 = 0;
  let largest = 0;
  const classes = Object.fromEntries(SIZE_CLASSES.map((c) => [`sizeClass.${c}`, 0])) as Record<string, number>;
  for (const seed of Z_SEEDS) {
    const ctx = ctxOf('archipelago', seed);
    const land = (o: Float64Array): Uint8Array => Uint8Array.from(o, (v) => (v >= SEA ? 1 : 0));
    const ras = waterRaster(ctx, -32 * n, -32 * n, n, 64);
    const mask = land(ras.offset0);
    cells += n * n;
    for (const v of mask) if (v === 0) ocean++;
    const c = landComponents(mask, n, 4);
    islands += islandCount(c, 64);
    for (const [k, v] of Object.entries(sizeClasses(c, 64))) classes[`sizeClass.${k}`] = classes[`sizeClass.${k}`]! + v;
    for (let id = 1; id <= c.count; id++) largest = Math.max(largest, componentKm2(c, id, 64));
    const ras32 = waterRaster(ctx, -32 * n, -32 * n, 2 * n, 32);
    islands32 += islandCount(landComponents(land(ras32.offset0), 2 * n, 4), 32);
  }
  const r = new Xoshiro128(fnv1a32('Z2.columns'));
  const params = resolveProfile('archipelago');
  const tops: number[] = [];
  let beach = 0;
  for (const seed of Z_SEEDS) {
    await forEachColumnThreaded(REGION_WORKER_DIR, seed, params, drawColumns(r, Z_COLUMNS, Z_RANGE), (view) => {
      const aux = view.aux()!;
      for (let p = 0; p < 256; p++) {
        const ws = aux.worldSurfaceWG[p]!;
        if (ws !== aux.oceanFloorWG[p]!) continue;
        tops.push(ws - 1);
        if (biomeFamily(aux.surfaceBiome[p]!) === 'coast') beach++;
      }
    });
  }
  const sorted = Float64Array.from(tops).sort();
  const rasterKm2 = (Z_SEEDS.length * (64 * n) * (64 * n)) / 1e6;
  return {
    oceanShare: ocean / cells,
    islandsPer100km2: islands / (rasterKm2 / 100),
    islandCount: islands, ...classes, largestIslandKm2: largest,
    islandsPer100km2Step32: islands32 / (rasterKm2 / 100),
    landTopP99: nearestRank(sorted, 0.99), landTopMax: sorted.length === 0 ? NaN : sorted[sorted.length - 1]!,
    beachShare: beach / sorted.length, landTopPositions: sorted.length,
    cells, rasterKm2,
    seconds: timed(t0),
  };
}, 1_800_000, { outName: 'Z2' });

/** floating_islands with the m gate removed: the islands term's `rangeChoice` on islandMask replaced by its `inside`. */
function ungatedFloatingParams(): Params {
  const term = (FLOATING_DENSITY_TREE as { root: { b: { x: { x: { inside: Parameters<typeof deriveTree>[0] } } } } }).root.b.x.x;
  const defs = deriveTree(FLOATING_DENSITY_TREE, 'density.defs', 'density', [
    { path: 'root.b.x.x', was: { op: 'rangeChoice', x: { op: 'col', field: 'islandMask' }, lo: 0.25, hi: 2 }, by: term.inside },
  ]);
  const floating = resolveProfile('floating_islands');
  return { ...floating, density: { ...floating.density, defs } };
}

/** Z3's counts over one params' columns (positions, island positions and what they hold). */
interface Z3Counts {
  positions: number;
  island: number;
  grass: number;
  runs: number;
  above250: number;
  below200: number;
  literal: number;
  falsePositives: number;
  islandVoxels: number;
}

const newZ3Counts = (): Z3Counts => ({
  positions: 0, island: 0, grass: 0, runs: 0, above250: 0, below200: 0, literal: 0, falsePositives: 0, islandVoxels: 0,
});

/** The state of position p's ground top (the top voxel of its highest run with bottom < 181), −1 when it has none. */
const groundTopState = (states: Uint16Array, col: Uint8Array, p: number): number => {
  const g = groundRun(col, ISLAND_RUN_MIN_BOTTOM);
  return g === null ? -1 : states[((g.top + 64) << 8) | p]!;
};

metricTest('Z3', ['islandColumns', 'grassTops'], async () => {
  const t0 = performance.now();
  const r = new Xoshiro128(fnv1a32('Z3'));
  const floating = resolveProfile('floating_islands');
  const ungated = ungatedFloatingParams();
  const states = new Uint16Array(98304);
  const col = new Uint8Array(384);
  const fl = newZ3Counts();
  const def = newZ3Counts();
  let ungatedVoxels = 0;
  let shadow = 0;
  /** Counts the literal (any solid voxel at y 190-270) and the island runs of every position into `c`. */
  const scan = (c: Z3Counts, p: number): ReturnType<typeof islandRuns> => {
    positionColumn(states, p, col);
    c.positions++;
    for (let y = 190; y <= 270; y++) if (col[y + 64] !== 0) { c.literal++; break; }
    const runs = islandRuns(col, ISLAND_RUN_MIN_BOTTOM);
    for (const run of runs) c.islandVoxels += run.top - run.bottom + 1;
    return runs;
  };
  for (const seed of Z_SEEDS) {
    const cols = drawColumns(r, Z_COLUMNS, Z3_RANGE);
    const ctx = ctxOf('floating_islands', seed);
    const ground = new Map<string, Int32Array>();
    await forEachColumnThreaded(REGION_WORKER_DIR, seed, DEFAULTS, cols, (view, cx, cz) => {
      columnStates(view, states);
      const g = new Int32Array(256);
      for (let p = 0; p < 256; p++) {
        scan(def, p);
        g[p] = groundTopState(states, col, p);
      }
      ground.set(`${cx},${cz}`, g);
    });
    await forEachColumnThreaded(REGION_WORKER_DIR, seed, floating, cols, (view, cx, cz) => {
      columnStates(view, states);
      const g = ground.get(`${cx},${cz}`)!;
      for (let p = 0; p < 256; p++) {
        const runs = scan(fl, p);
        const all = solidRuns(col);
        const sky = all[all.length - 1];
        if (sky !== undefined && branchHoldsAtTop(sky, ISLAND_RUN_MIN_BOTTOM, BRANCH_CEILING_OFFSET)
          && (sky.bottom < ISLAND_RUN_MIN_BOTTOM || islandMaskAt(ctx, 16 * cx + (p & 15), 16 * cz + (p >> 4)) === 0)) fl.falsePositives++;
        if (runs.length === 0) continue;
        const top = runs[runs.length - 1]!.top;
        fl.island++;
        fl.runs += runs.length;
        if (states[((top + 64) << 8) | p] === GRASS_BLOCK) fl.grass++;
        if (top > 250) fl.above250++;
        if (top < 200) fl.below200++;
        if (groundTopState(states, col, p) !== g[p]) shadow++;
      }
    });
    await forEachColumnThreaded(REGION_WORKER_DIR, seed, ungated, cols, (view) => {
      columnStates(view, states);
      const u = newZ3Counts();
      for (let p = 0; p < 256; p++) scan(u, p);
      ungatedVoxels += u.islandVoxels;
    });
  }
  // The floating_islands golden window of seed '42' (§6), frozen by the goldens commit (the search is re-run by goldens.sp3e.test.ts).
  const w = sp3eWindow('floating_islands');
  const wcols: Array<[number, number]> = [];
  for (let dz = 0; dz < 8; dz++) for (let dx = 0; dx < 8; dx++) wcols.push([w.chunkX + dx, w.chunkZ + dz]);
  const foot = new Uint8Array(128 * 128);
  await forEachColumnThreaded(REGION_WORKER_DIR, '42', floating, wcols, (view, cx, cz) => {
    columnStates(view, states);
    for (let p = 0; p < 256; p++) {
      positionColumn(states, p, col);
      if (islandRuns(col, ISLAND_RUN_MIN_BOTTOM).length > 0) foot[(16 * (cz - w.chunkZ) + (p >> 4)) * 128 + 16 * (cx - w.chunkX) + (p & 15)] = 1;
    }
  });
  const comps = landComponents(foot, 128, 4);
  let largestFoot = 0;
  for (let id = 1; id <= comps.count; id++) largestFoot = Math.max(largestFoot, comps.size[id]!);
  const share = (a: number, b: number): number => (b === 0 ? NaN : a / b);
  return {
    islandColumns: fl.island / fl.positions,
    grassTops: share(fl.grass, fl.island),
    islandPositions: fl.island, positions: fl.positions,
    runsPerIsland: share(fl.runs, fl.island),
    topsAbove250: share(fl.above250, fl.island), topsBelow200: share(fl.below200, fl.island),
    islandColumnsLiteral: fl.literal / fl.positions, islandColumnsDefault: def.literal / def.positions,
    branchFalsePositives: fl.falsePositives, branchFalsePositivesShare: fl.falsePositives / fl.positions,
    shadowDiff: share(shadow, fl.island), shadowDiffPositions: shadow,
    gateLoss: ungatedVoxels === 0 ? 0 : (ungatedVoxels - fl.islandVoxels) / ungatedVoxels,
    islandVoxels: fl.islandVoxels, islandVoxelsUngated: ungatedVoxels, islandVoxelsDefault: def.islandVoxels,
    islandComponents: comps.count, largestFootprint: largestFoot / (128 * 128),
    windowA: w.a, windowB: w.b, windowIslandPositions: foot.reduce((a, v) => a + v, 0),
    seconds: timed(t0),
  };
}, 600_000, { outName: 'Z3' });

if (TIER === 'full') {
  /** Columns per preset of the full-tier records (SP3e spec §5.5), seed '42', ±1024 chunks. */
  const RECORD_COLUMNS = 4096;
  const RECORD_RANGE = 1024;

  let scatterMemo: Promise<Map<DraftPreset, Scattered>> | null = null;
  /** One pass of T1-T5's scatter over the three presets (`fnv1a32('T1-T5.presets')`, preset by preset), memoised. */
  const scattered = (): Promise<Map<DraftPreset, Scattered>> => {
    scatterMemo ??= (async () => {
      const r = new Xoshiro128(fnv1a32('T1-T5.presets'));
      const scratch = newScatterScratch();
      const out = new Map<DraftPreset, Scattered>();
      for (const preset of PRESETS) {
        const t0 = performance.now();
        const s = newScattered();
        const params = resolveProfile(preset);
        const dc = createDensityContext(createGenContext(seedFromInput(SEED), params));
        const est = (x: number, z: number): number => surfaceEst3(dc, x, z);
        await forEachColumnThreaded(REGION_WORKER_DIR, SEED, params, drawColumns(r, RECORD_COLUMNS, RECORD_RANGE),
          (view, cx, cz) => analyseColumn(s, view, cx, cz, est, scratch));
        s.seconds = timed(t0);
        out.set(preset, s);
      }
      return out;
    })();
    return scatterMemo;
  };
  const tRecord = async (body: typeof t1Values): Promise<Record<string, number>> => {
    const sc = await scattered();
    return Object.assign({}, ...PRESETS.map((p) => presetRecord(body(sc.get(p)!, 'record', p), p))) as Record<string, number>;
  };

  let surfaceMemo: Promise<Map<DraftPreset, SurfaceAcc>> | null = null;
  /** One pass of S1-S3's analysis over the three presets (`fnv1a32('S1-S3.presets')`, preset by preset), memoised. */
  const surfaced = (): Promise<Map<DraftPreset, SurfaceAcc>> => {
    surfaceMemo ??= (async () => {
      const r = new Xoshiro128(fnv1a32('S1-S3.presets'));
      const out = new Map<DraftPreset, SurfaceAcc>();
      for (const preset of PRESETS) {
        const t0 = performance.now();
        const a = newSurfaceAcc();
        await analyseColumnsThreaded(SURFACE_WORKER_DIR, SEED, resolveProfile(preset), drawColumns(r, RECORD_COLUMNS, RECORD_RANGE), a);
        a.seconds = timed(t0);
        out.set(preset, a);
      }
      return out;
    })();
    return surfaceMemo;
  };
  const sRecord = async (body: typeof s1Values): Promise<Record<string, number>> => {
    const sc = await surfaced();
    return Object.assign({}, ...PRESETS.map((p) => presetRecord(body(sc.get(p)!, 'record', p), p))) as Record<string, number>;
  };

  // Each call written literally: `findMetricCalls` scans the source for `metricTest('<id>', [<parts>]` and its outName.
  metricTest('T1', [], () => tRecord(t1Values), 1_800_000, { outName: 'T1.presets' });
  metricTest('T2', [], () => tRecord(t2Values), 1_800_000, { outName: 'T2.presets' });
  metricTest('T3', [], () => tRecord(t3Values), 1_800_000, { outName: 'T3.presets' });
  metricTest('T5', [], () => tRecord(t5Values), 1_800_000, { outName: 'T5.presets' });
  metricTest('S1', [], () => sRecord(s1Values), 1_800_000, { outName: 'S1.presets' });
  metricTest('S2', [], () => sRecord(s2Values), 1_800_000, { outName: 'S2.presets' });
  metricTest('S3', [], () => sRecord(s3Values), 1_800_000, { outName: 'S3.presets' });
}

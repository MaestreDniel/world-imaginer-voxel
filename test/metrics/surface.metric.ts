import { expect } from 'vitest';
import { ISLAND_RUN_MIN_BOTTOM } from '../../src/core/constants';
import { fnv1a32 } from '../../src/core/hash';
import type { JsonValue } from '../../src/core/params/json';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA, type Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { GRASS_BLOCK, REGISTRY } from '../../src/world/blocks/index';
import { CARVERS_OFF } from '../harness/carverParams';
import { metricTest } from '../harness/metric';
import { cavesMuted } from '../harness/sp5cTrees';
import { analyseColumnsThreaded, MIN_SURFACE_POPULATION, s1Values, s2Values, s3Values, surfaceCommonValues } from '../harness/surfaceAnalysis';
import { newSurfaceAcc, SURFACE_STATES, type SurfaceAcc } from '../harness/surfaceScatter';
import {
  forEachColumnThreaded, metricsProfiles, scatterColumns, type PopulationMode, type ScatterProfile,
} from '../harness/terrainScatter';
import { branchHoldsAtTop, columnStates, positionColumn, solidRuns } from '../harness/zMetrics';

/**
 * S1, S2, S3, the B4 voxel parts and the B2 river check on the surfaced voxels (SP3c spec §5.1, §5.2), with the
 * ungated diagnostics of §5.2.
 *
 * Sampling (§5.1): the scattered columns of T1-T5 (`terrain.metric.ts`): per profile (default, large_biomes) and tier
 * seed ('42'; full '42', '1', '2', '3'), `COLUMNS` columns drawn by one `Xoshiro128(fnv1a32('T1-T5'))` in the same
 * order (profile, then seed, then column) uniformly over ±1024 chunks (default) or ±4096 (large_biomes), generated with
 * `fillColumnT` AND analysed on 4 region workers (`test/harness/surfaceScatterWorker.ts`, the analysis in
 * `test/harness/surfaceScatter.ts`, driven by `analyseColumnsThreaded` of `test/harness/surfaceAnalysis.ts`, SP3e spec
 * §5.1); this thread only merges the workers' count records (`mergeSurfaceAcc`, an exact sum: every accumulator is
 * order-independent; `ymod16`'s position choice depends only on the seed and (cx, cz)). S1-S3's values per profile
 * are the part bodies of `surfaceAnalysis.ts` (`s1Values` …, `'enforce'` mode); B4 and B2 stay here.
 * Vitest isolates metric files, so this file draws and generates the columns again rather than sharing
 * terrain.metric.ts's pass (the same draws, `scatterColumns`).
 *
 * By profile (SP6b spec §13 L3; `METRICS_PROFILES`, read once: `default`, `large_biomes` or both comma-separated;
 * absent, both; an unknown name throws): CI runs each profile in a job of its own, `islandBranchOnGround` with the
 * default profile. Every profile's columns are drawn and only the run's kept (ruling P1), so each profile's columns
 * are the unsplit run's; every gated part is the worse profile or a sum with max 0, so the worst over the jobs is the
 * unsplit value.
 *
 * Readouts (§5.2): each column's ColumnSample is rebuilt in the worker (`buildColumnSample`, as the stage builds it)
 * and its voxels re-scanned with the stage's SurfaceContext settings (`scanColumn` over the stored solidity, the stored
 * water and aux A's `surfaceBiome`), so T, steep, T_eff, the cliff predicate (`steepHolds` ∧ `yAboveHolds{runTop}` at
 * the top), the biome, `lake` and the nearest quart corner are the rules' own; C, offset0 and offset are bilinear
 * `readField` readouts. A land top is the top of a position with no water above it (`WORLD_SURFACE_WG ==
 * OCEAN_FLOOR_WG`), y = `OCEAN_FLOOR_WG − 1`; a position is wet otherwise. A voxel is in the sky-open run when it lies
 * at or above the bottom of its position's first (topmost) run.
 *
 * Parts (worst of the two profiles; counts are summed; every per-profile value and population is recorded beside it
 * as `<part>.<profile>` and `<part>.n.<profile>`; a population below 1,000 fails "insufficient sample", §5.1):
 * - S1 `buried` grass_block, snow_block or red_sand voxels with a solid voxel directly above (y 319 has air above);
 *   `grassNoSky` grass_block voxels below the sky-open run; `ymod16` the χ² independence p-value of the land top's
 *   y mod 16 against its soil depth class over one position per column (§5.2, pooled per profile, the smaller p);
 * - S2 `deepslateBelow0` deepslate / (stone + deepslate) voxels at y < 0; `deepslateAbove8` the same at y > 8;
 *   `bedrockFloor` the share of positions with bedrock at y −64;
 * - S3 `snowAboveLine` the share of land tops with T_eff(y_top) < snowline that are not cliffs whose top is snow_block;
 *   `snowNoSky` snow_block voxels below the sky-open run;
 * - B4 (`B4.voxel.json`) `snowInDesert` desert land tops that are snow_block; `coastBandBeachVoxel` the share of
 *   coast-band land tops (C ∈ [−0.22, −0.04], offset0 ≥ 63) whose top is sand, red_sand, gravel or stone, or snow_block
 *   at a snowy_beach position; `landTopsBelowSea` the share of land-family positions (lowland, highland, coast; not at
 *   a corner with a finite lakeLevel, lakeMask > 0 or river-wet) whose floor is below 63 with water above;
 * - B2 (`B2.voxel.json`) `riverChannelWater` the share of positions whose nearest corner is river-wet and whose
 *   bilinear offset < 63 that have water above their top (with the same share over offset < 62 and < 61, and the dry
 *   positions' tops, as diagnostics).
 * Diagnostics (ungated): `landTopYmod16` (raw and against the neighbour-average expectation, with its χ²; SP3c :357,
 * re-measured with SP6a's caves and recorded, SP6a spec §10.4: it stays SP12's),
 * `dryPitsBelowSea`, `lakeRimIslets` (land tops with an ocean-family biome at a corner with 0 < lakeMask < 1, as a
 * share of all positions), `oceanBiomeLandTops` (every land top with an ocean-family biome, as a share of all positions:
 * mostly sea-class density islands, the rim islets are a small part of it), `shorelineFringe` (near-shore positions, Chebyshev distance ≤ 2 inside the column from a
 * position of the other wet/dry state, without the islets: the share with an ocean-family biome on a land top or a
 * land-family biome under water; `shorelineFringeSea` the same without lake, lakeMask and river-wet corners; the top
 * blocks of the islets and of both fringe kinds, to judge how they look), the
 * surfaceDepth histogram, `patchCoverage` per (biome, patch block), and per-block voxel and top shares.
 *
 * `islandBranchOnGround` (SP6a spec §10.4, D31, Point 2; recorded, no part, `.out/S.islandBranchOnGround.json`): the
 * share of floating_islands positions where the islands surface branch (`yAbove{181, runTop}` ∧
 * `stoneDepth{ceiling ≤ 100}`, SP3e spec §4.1) fires on a run whose bottom is below `ISLAND_RUN_MIN_BOTTOM` (181): some
 * solid run of the position with bottom < 181 has, at its top voxel, runTop ≥ 181 and top − bottom ≤ 100 (Z3's
 * `branchFalsePositives` predicate, `presets.metric.ts`, over every run rather than the sky-open one, since the branch
 * is not sky-gated). Measured on the same columns with caves (`after`) and before caves (`before`): the same
 * floating_islands tree with its carving family taps muted to 1e6 (`cavesMuted`: entrances, cheese, spaghetti 3D and
 * 2D, noodle) and the three carver chances 0 (`CARVERS_OFF`), whose solidity is SP5c's (`min(v, 1e6)` is v and
 * `detailG` changes no sign). Seeds as above; `ISLAND_BRANCH_COLUMNS` chunk columns per seed (fast 64, quick 256, full
 * 1024) drawn by `Xoshiro128(fnv1a32('islandBranchOnGround'))` in ±1024 chunks, generated up to T on 4 region workers.
 * Recorded beside it: the positions (`positions`), the summit positions (a run with bottom < 181 and top ≥ 181), the
 * firing positions and their share of the summits, the firing positions whose firing run tops with grass_block, and
 * the positions that fire only after caves (`added`) or only before (`removed`).
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

/** The run's profiles (`METRICS_PROFILES`; absent, both), in draw order. */
const PROFILES = metricsProfiles(process.env.METRICS_PROFILES);
type Profile = ScatterProfile;
const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const RANGE: Readonly<Record<Profile, number>> = { default: 1024, large_biomes: 4096 };
/** T1-T5's columns per (profile, seed) (§5.1). */
const COLUMNS: Readonly<Record<Profile, number>> = pick(
  { default: 4096, large_biomes: 16384 },
  { default: 8192, large_biomes: 32768 },
  { default: 4096, large_biomes: 16384 },
);
const SCATTER_WORKER_DIR = `surfaceScatterWorker-${TIER}`;

const STATES = SURFACE_STATES;
const NAMES: readonly string[] = Array.from({ length: STATES }, (_, s) => REGISTRY.stateKey(s));

/** Fails the running metric test (soft) when a population is below its minimum. */
function requireSample(what: string, n: number, min = MIN_SURFACE_POPULATION): void {
  expect.soft(n, `${what}: insufficient sample (${n} < ${min})`).toBeGreaterThanOrEqual(min);
}

type Acc = SurfaceAcc;

let scatteredMemo: Promise<Record<Profile, Acc>> | null = null;

/** The one pass over the scattered columns, memoised. */
function scattered(): Promise<Record<Profile, Acc>> {
  scatteredMemo ??= scatter();
  return scatteredMemo;
}

async function scatter(): Promise<Record<Profile, Acc>> {
  const columns = scatterColumns(PROFILES, SEEDS, COLUMNS, RANGE);
  const out = {} as Record<Profile, Acc>;
  for (const profile of PROFILES) {
    const t0 = performance.now();
    const a = newSurfaceAcc();
    const params = resolveProfile(profile);
    for (const [k, seed] of SEEDS.entries()) await analyseColumnsThreaded(SCATTER_WORKER_DIR, seed, params, columns[profile]![k]!, a);
    a.seconds = Math.round(performance.now() - t0) / 1000;
    out[profile] = a;
  }
  return out;
}

/** Writes `<key>.<profile>` for every profile and returns the worst (max or min) under `key`. */
function perProfile(rec: Record<string, number>, key: string, values: Record<Profile, number>, worst: 'max' | 'min' | 'sum'): void {
  for (const p of PROFILES) rec[`${key}.${p}`] = values[p];
  const v = PROFILES.map((p) => values[p]);
  rec[key] = worst === 'max' ? Math.max(...v) : worst === 'min' ? Math.min(...v) : v.reduce((s, x) => s + x, 0);
}

const byProfile = (f: (p: Profile) => number): Record<Profile, number> =>
  Object.fromEntries(PROFILES.map((p) => [p, f(p)])) as Record<Profile, number>;

const share = (n: number, d: number): number => (d === 0 ? NaN : n / d);

/** Records a population beside its part and requires the minimum. */
function population(rec: Record<string, number>, part: string, n: Record<Profile, number>): void {
  for (const p of PROFILES) {
    rec[`${part}.n.${p}`] = n[p];
    requireSample(`${part} (${p})`, n[p]);
  }
}

function common(rec: Record<string, number>, sc: Record<Profile, Acc>): void {
  for (const p of PROFILES) for (const [k, v] of Object.entries(surfaceCommonValues(sc[p]))) rec[`${k}.${p}`] = v;
}

type Body = (a: Acc, mode: PopulationMode, label: string) => Record<string, number>;
type Step = readonly [kind: 'part', key: string, worst: 'max' | 'min' | 'sum'] | readonly [kind: 'n', key: string];

/**
 * One S metric in today's .out layout from its per-profile bodies (`surfaceAnalysis.ts`, enforce mode, each profile's
 * population checked in turn): the `steps` in order (a part as `<part>.<profile>` and its worst-of `<part>`; a
 * population as `<part>.n.<profile>`), then every other key of the bodies as `<key>.<profile>` profile by profile,
 * then the common keys.
 */
async function sMetric(body: Body, steps: readonly Step[]): Promise<Record<string, number>> {
  const sc = await scattered();
  const v = Object.fromEntries(PROFILES.map((p) => [p, body(sc[p], 'enforce', p)])) as Record<Profile, Record<string, number>>;
  const rec: Record<string, number> = {};
  const placed = new Set(Object.keys(surfaceCommonValues(sc[PROFILES[0]!])));
  for (const s of steps) {
    if (s[0] === 'part') perProfile(rec, s[1], byProfile((p) => v[p][s[1]]!), s[2]);
    else for (const p of PROFILES) rec[`${s[1]}.n.${p}`] = v[p][`${s[1]}.n`]!;
    placed.add(s[0] === 'part' ? s[1] : `${s[1]}.n`);
  }
  for (const p of PROFILES) for (const [k, x] of Object.entries(v[p])) if (!placed.has(k)) rec[`${k}.${p}`] = x;
  common(rec, sc);
  return rec;
}

metricTest('S1', ['buried', 'grassNoSky', 'ymod16'], () => sMetric(s1Values, [
  ['part', 'buried', 'sum'], ['part', 'grassNoSky', 'sum'], ['n', 'buried'], ['n', 'grassNoSky'], ['part', 'ymod16', 'min'], ['n', 'ymod16'],
]));

metricTest('S2', ['deepslateBelow0', 'deepslateAbove8', 'bedrockFloor'], () => sMetric(s2Values, [
  ['part', 'deepslateBelow0', 'min'], ['part', 'deepslateAbove8', 'max'], ['part', 'bedrockFloor', 'min'], ['n', 'deepslateBelow0'], ['n', 'deepslateAbove8'],
]));

metricTest('S3', ['snowAboveLine', 'snowNoSky'], () => sMetric(s3Values, [
  ['part', 'snowAboveLine', 'min'], ['part', 'snowNoSky', 'sum'], ['n', 'snowAboveLine'], ['n', 'snowNoSky'],
]));

metricTest('B4', ['snowInDesert', 'coastBandBeachVoxel', 'landTopsBelowSea'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'snowInDesert', byProfile((p) => sc[p].desertSnow), 'sum');
  perProfile(rec, 'coastBandBeachVoxel', byProfile((p) => share(sc[p].coastOk, sc[p].coastTops)), 'min');
  perProfile(rec, 'landTopsBelowSea', byProfile((p) => share(sc[p].landBiomeWetBelow, sc[p].landBiome)), 'max');
  population(rec, 'snowInDesert', byProfile((p) => sc[p].desertTops));
  population(rec, 'coastBandBeachVoxel', byProfile((p) => sc[p].coastTops));
  population(rec, 'landTopsBelowSea', byProfile((p) => sc[p].landBiome));
  for (const p of PROFILES) {
    const a = sc[p];
    rec[`dryPitsBelowSea.${p}`] = share(a.landBiomeDryBelow, a.landBiome);
    rec[`landTopsBelowSeaCount.${p}`] = a.landBiomeWetBelow;
    rec[`lakeRimIslets.${p}`] = share(a.islets, a.positions);
    rec[`lakeRimIsletCount.${p}`] = a.islets;
    rec[`oceanBiomeLandTops.${p}`] = share(a.oceanOnLand, a.positions);
    rec[`oceanBiomeLandTopCount.${p}`] = a.oceanOnLand;
    rec[`shorelineFringe.${p}`] = share(a.fringeOceanOnLand + a.fringeLandUnderWater, a.fringe);
    rec[`shorelineFringe.n.${p}`] = a.fringe;
    rec[`shorelineFringe.oceanOnLand.${p}`] = share(a.fringeOceanOnLand, a.fringe);
    rec[`shorelineFringe.landUnderWater.${p}`] = share(a.fringeLandUnderWater, a.fringe);
    rec[`shorelineFringeSea.${p}`] = share(a.fringeSeaBad, a.fringeSea);
    rec[`shorelineFringeSea.n.${p}`] = a.fringeSea;
    rec[`coastBand.coastBiomeShare.${p}`] = share(a.coastBeachBiome, a.coastTops);
    for (let s = 1; s < STATES; s++) if (a.coastTopStates[s]! > 0) rec[`coastBand.top.${NAMES[s]}.${p}`] = share(a.coastTopStates[s]!, a.coastTops);
    rec[`desertTops.${p}`] = a.desertTops;
    for (let s = 1; s < STATES; s++) {
      if (a.isletTopStates[s]! > 0) rec[`lakeRimIslets.top.${NAMES[s]}.${p}`] = share(a.isletTopStates[s]!, a.islets);
      if (a.fringeOceanOnLandTop[s]! > 0) rec[`shorelineFringe.oceanOnLandTop.${NAMES[s]}.${p}`] = share(a.fringeOceanOnLandTop[s]!, a.fringeOceanOnLand);
      if (a.fringeLandUnderWaterTop[s]! > 0) rec[`shorelineFringe.landUnderWaterTop.${NAMES[s]}.${p}`] = share(a.fringeLandUnderWaterTop[s]!, a.fringeLandUnderWater);
    }
  }
  common(rec, sc);
  return rec;
}, 600_000, { outName: 'B4.voxel' });

metricTest('B2', ['riverChannelWater'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'riverChannelWater', byProfile((p) => share(sc[p].riverWet, sc[p].river)), 'min');
  population(rec, 'riverChannelWater', byProfile((p) => sc[p].river));
  for (const p of PROFILES) {
    const a = sc[p];
    const dry = a.river - a.riverWet;
    rec[`riverDry.${p}`] = dry;
    rec[`riverDry.topBelow63.${p}`] = a.riverDry[0]!;
    rec[`riverDry.top63to64.${p}`] = a.riverDry[1]!;
    rec[`riverDry.top65to67.${p}`] = a.riverDry[2]!;
    rec[`riverDry.top68up.${p}`] = a.riverDry[3]!;
    rec[`riverChannel.riverBiomeShare.${p}`] = share(a.riverRiverBiome, a.river);
    rec[`riverDry.riverBiome.${p}`] = a.riverDryRiverBiome;
    rec[`riverChannelWater.offsetBelow62.${p}`] = share(a.riverWet62, a.river62);
    rec[`riverChannelWater.offsetBelow62.n.${p}`] = a.river62;
    rec[`riverChannelWater.offsetBelow61.${p}`] = share(a.riverWet61, a.river61);
    rec[`riverChannelWater.offsetBelow61.n.${p}`] = a.river61;
  }
  common(rec, sc);
  return rec;
}, 600_000, { outName: 'B2.voxel' });

/** islandBranchOnGround's chunk columns per seed (header). */
const ISLAND_BRANCH_COLUMNS = pick(64, 256, 1024);
const ISLAND_BRANCH_RANGE = 1024;
const ISLAND_WORKER_DIR = `surfaceIslandWorker-${TIER}`;
/** The islands surface branch's `stoneDepth{ceiling}` offset (SP3e spec §4.1; a tree literal of the preset rules). */
const BRANCH_CEILING_OFFSET = 100;

/** floating_islands before caves: its carving family taps muted (`cavesMuted`) and the carvers off (`CARVERS_OFF`). */
function floatingBeforeCaves(): Params {
  const floating = resolveProfile('floating_islands');
  const r = applyPatch(SCHEMA, floating, { ...CARVERS_OFF, density: { defs: cavesMuted(floating.density.defs) as JsonValue } });
  if (!r.ok) throw new Error(`islandBranchOnGround: ${JSON.stringify(r.issues)}`);
  return r.value;
}

/** One world's counts over the columns; `fired` holds each column's 256 firing flags, keyed `<seed>:<cx>,<cz>`. */
interface BranchCounts { positions: number; summits: number; fires: number; grass: number; fired: Map<string, Uint8Array> }

async function branchCounts(params: Params): Promise<BranchCounts> {
  const r = new Xoshiro128(fnv1a32('islandBranchOnGround'));
  const c: BranchCounts = { positions: 0, summits: 0, fires: 0, grass: 0, fired: new Map() };
  const states = new Uint16Array(98304);
  const col = new Uint8Array(384);
  for (const seed of SEEDS) {
    const cols: Array<[number, number]> = [];
    for (let n = 0; n < ISLAND_BRANCH_COLUMNS; n++) {
      cols.push([-ISLAND_BRANCH_RANGE + r.nextInt(2 * ISLAND_BRANCH_RANGE), -ISLAND_BRANCH_RANGE + r.nextInt(2 * ISLAND_BRANCH_RANGE)]);
    }
    await forEachColumnThreaded(ISLAND_WORKER_DIR, seed, params, cols, (view, cx, cz) => {
      columnStates(view, states);
      const fired = new Uint8Array(256);
      for (let p = 0; p < 256; p++) {
        positionColumn(states, p, col);
        c.positions++;
        let summit = false;
        let fireTop = NaN;
        for (const run of solidRuns(col)) {
          if (run.bottom >= ISLAND_RUN_MIN_BOTTOM || run.top < ISLAND_RUN_MIN_BOTTOM) continue;
          summit = true;
          if (branchHoldsAtTop(run, ISLAND_RUN_MIN_BOTTOM, BRANCH_CEILING_OFFSET)) fireTop = run.top;
        }
        if (summit) c.summits++;
        if (Number.isNaN(fireTop)) continue;
        fired[p] = 1;
        c.fires++;
        if (states[((fireTop + 64) << 8) | p] === GRASS_BLOCK) c.grass++;
      }
      c.fired.set(`${seed}:${cx},${cz}`, fired);
    });
  }
  return c;
}

// islandBranchOnGround runs with the default profile (its own floating_islands columns, SP6b spec §13 L3).
if (PROFILES.includes('default')) {
  metricTest('S1', [], async () => {
    const t0 = performance.now();
    const after = await branchCounts(resolveProfile('floating_islands'));
    const before = await branchCounts(floatingBeforeCaves());
    let added = 0;
    let removed = 0;
    for (const [k, a] of after.fired) {
      const b = before.fired.get(k)!;
      for (let p = 0; p < 256; p++) {
        if (a[p] === 1 && b[p] === 0) added++;
        if (a[p] === 0 && b[p] === 1) removed++;
      }
    }
    const share = (n: number, d: number): number => (d === 0 ? NaN : n / d);
    const rec: Record<string, number> = {};
    for (const [name, c] of [['after', after], ['before', before]] as const) {
      rec[`islandBranchOnGround.${name}`] = share(c.fires, c.positions);
      rec[`firingPositions.${name}`] = c.fires;
      rec[`summitPositions.${name}`] = c.summits;
      rec[`firingShareOfSummits.${name}`] = share(c.fires, c.summits);
      rec[`firingGrassTops.${name}`] = c.grass;
    }
    rec.added = added;
    rec.removed = removed;
    rec.positions = after.positions;
    rec.columns = after.fired.size;
    rec.seconds = Math.round(performance.now() - t0) / 1000;
    return rec;
  }, 1_800_000, { outName: 'S.islandBranchOnGround' });
}

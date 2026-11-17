import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { columnSlice, readSlices, sliceOf, writeSlice } from '../harness/columnSlices';
import { metricTest, type MetricEnv } from '../harness/metric';
import { genRegion } from '../harness/region';
import {
  b3Values, mergeScattered, metricsProfiles, newGrid, newScattered, putColumn, scatterColumns, scatterColumnsThreaded, sumScattered,
  t1Values, t2Values, t3Values, t4Sites, t5Values, waterWalls, type B3Values, type Scattered, type ScatterProfile, type T4Site,
} from '../harness/terrainScatter';

/**
 * T1-T5 on voxels (SP3b spec §8.1, §8.2): the real T stage's land heights (T1), overhangs (T2), lowland border steps
 * (T3), ocean floors (T4) and the 3D surface estimate (T5).
 *
 * Sampling (§8.1), per profile (default, large_biomes) and tier seed ('42'; full '42', '1', '2', '3'):
 * - Scattered columns (T1, T2, T3, T5): `COLUMNS` per (profile, seed), drawn by one `Xoshiro128(fnv1a32('T1-T5'))`
 *   (`scatterColumns`) uniformly over ±1024 chunks (default) or ±4096 (large_biomes), i.e. ±16384 / ±65536 blocks,
 *   generated and analysed on 4 region workers (`regionWorker.ts`; SP6b spec §13 L5): each worker analyses its share
 *   in place and this thread sums the workers' accumulators (every one is order-independent; the T5 list is sorted),
 *   through `test/harness/terrainScatter.ts` (`scatterColumnsThreaded`, `analyseColumn` and the part bodies in
 *   `'enforce'` mode, SP3e spec §5.1). The four metrics read the same columns (one pass, memoised).
 * - T4 regions through the harness (`genRegion`, 4 threads, `cache: false`: each region is generated once per run):
 *   16 × 16 columns at sites whose 2D `offset` at the region's centre is < 40 (fast 4, quick 4, full 16 per
 *   (profile, seed); `Xoshiro128(fnv1a32('T4'))`, rejection-drawn over the same squares, `t4Sites`).
 * - By profile (SP6b spec §13 L2; `METRICS_PROFILES`, read once: `default`, `large_biomes` or both comma-separated;
 *   absent, both; an unknown name throws): CI runs each profile in a job of its own. Every profile's draws are made in
 *   the order above (T4's rejections included) and only the run's profiles kept (ruling P1), so each profile's columns
 *   and regions are the unsplit run's; every gated part is the worse profile or a sum with max 0, so the worst over
 *   the jobs is the unsplit value (`siteDraws` counts the run's profiles' draws).
 * - In column slices (SP6b spec §13 Stage 2 item 1, the user's ruling U15; `METRICS_SLICE`, read once,
 *   `test/harness/columnSlices.ts`): CI runs the large_biomes profile as two slice runs and one merge run. Slice k of n
 *   draws every column and T4 site as above, keeps draws k, k + n, … of each (profile, seed) column list and of each
 *   profile's T4 sites, scatters its columns and generates its regions as above, writes each seed's `Scattered` and each
 *   region's counts (`T4Region`) to its record, and gates nothing (every test below is skipped there). The merge run
 *   generates nothing: it reads the n records, sums each seed's parts (`sumScattered`: integer counts, the T5 list
 *   sorted) and folds the regions in site order, so every test below reads what the whole run reads (its `seconds`
 *   keys are the slices' summed times).
 *
 * Definitions (§8.2): solid = any block but air (stone; bedrock at y −64); a position is land when no water voxel lies
 * above its highest stone (`WORLD_SURFACE_WG === OCEAN_FLOOR_WG`), and its true top is `WORLD_SURFACE_WG − 1`; under
 * water the floor is `OCEAN_FLOOR_WG − 1`. A solid→air transition at y is solid(y) and not solid(y + 1) (y + 1 = 320 is air).
 * - T1 over all 256 positions of each column: `band` the largest share of land tops in [b, b + 10), `span` p95 − p5,
 *   `above120` / `above200` the shares of land tops > 120 / > 200 (master §6.4 "share y > 120").
 * - T2: `overhangs` the share of land positions with ≥ 2 transitions at y ≥ top − 30; `overhangsPeaks` the same over land
 *   positions whose aux A `surfaceBiome` is windswept_hills, snowy_slopes, stony_peaks, jagged_peaks or frozen_peaks.
 *   From SP6a (its spec §10.4) T2 reads the pre-cave solidity (solid or tagged, `preCaveSolidity`) from the pre-cave
 *   top over the true top, so cave transitions do not count.
 * - T3 over the land neighbour pairs (x and z) inside each scattered column (15 × 16 per axis; the biome is aux A's
 *   per-block `surfaceBiome`, so borders cross columns at every position): same biome → biome b's inside pairs; steep =
 *   |Δtop| ≥ 4; p_b = biome b's inside steep share over the same columns. `value` = Σ steep / Σ (p_a + p_b) / 2 over the
 *   pairs of two different biomes of the `lowland` family (the user's ruling: highland borders follow slopes by design).
 *   The same ratio for every other family, and over all same-family pairs (§8.2's wording), is an ungated diagnostic.
 *   `value` gates on the full tier only (its row's `tiers: ['full']`, the user's decision: a few dozen steep pairs make
 *   the fast and quick estimates noisy); fast and quick record it, and its 2,000-pair minimum holds on every tier.
 *   A pair whose biome has no inside pair is dropped and counted (`droppedPairs`).
 * - T4: `floorSd` the mean over regions of the sd of the floor under water; `exposedBedrock` floors at y −64 under
 *   water; `deepFloor` floors ≤ −50 under water.
 * - T5 at the 16 positions lx, lz ∈ {2, 6, 10, 14} of each column: land positions with exactly one transition at
 *   y ≥ −56; |surfaceEst3 − pre-cave top|, `median`, `p90`, `p99` (nearest rank). The pre-cave top (SP6a spec §10.4)
 *   is the top of the `precave` tap's run over the true top (`preCaveTop`): `surfaceEst3` estimates the pre-cave
 *   terrain by design, and the surface's cave holes are C9's (`holedSurface`, `thinRoof`); `raisedTop` counts the
 *   positions where it lies above the true top.
 *
 * Each part's value is the worse of the two profiles (seeds pooled within a profile); the per-profile values and the
 * populations are recorded beside it (`<part>.<profile>`). A part below its minimum population (§8.1: peak positions
 * from 20 columns, 1,000 T5 positions, 2,000 lowland border pairs) fails with "insufficient sample".
 * Diagnostics (ungated, in `.out`):
 * - populations and seconds;
 * - the water-wall share (§4) over the scattered columns (in-column neighbours) and the T4 regions: water voxels above
 *   a position's top with a horizontally adjacent position whose surface (WORLD_SURFACE_WG) is at or below that y, i.e.
 *   dry air beside the water at the same y (water and dry air under stone are not counted);
 * - floating rocks (T2.json): a land position has one when, at or above y −56, a solid run of height ≤ 6 rests on an
 *   air gap of ≥ 3 blocks (a per-column proxy: it also counts thin ledges and arch roofs). `floatingRockShare` is the
 *   share of land positions with one, `floatingRockVoxels` the voxels in such runs per land position.
 *
 * B3's cave-biome shares (SP6b spec §12.1, D26; recorded here, gated from the tuning task, Task 30) ride on the same scattered
 * columns, no new generation: cave air = tagged voxels (kind ≠ 0) that are air with no fluid, each counted under its
 * nibble (`analyseColumn`), per window of the profile's square (default: ±16,384 blocks in 4 × 4 windows of 8 × 8 km;
 * large_biomes: ±65,536 in 4 × 4 of 32 × 32 km, recorded only), per 0.1 band of §1.2's depth (Y0 from each column's
 * cave-biome pass in the region worker), per 16-block y band and per cave kind (`b3Values`). Per profile, every window's
 * cave air and four shares and the minima `lushMin`, `dripstoneMin`, `abyssMin` (the smallest window share) and
 * `windowAir` (the smallest window's cave air; a window under 50,000 is flagged `insufficient`) are written to
 * `.out/B3.windows.json`; the gated call `B3.shares` (Task 30) writes the default profile's four minima to
 * `.out/B3.shares.json`, registered only when the run scatters the default profile (the `terrain-large` job holds no
 * default window, and a missing value is an error). large_biomes' 32 × 32 km windows are
 * recorded only (`recordedOnly`; §12.1: its climate is zoomed × 4, so a window may lack a biome): only the default
 * profile's windows are B3's gated population. This file scatters only the default and large_biomes profiles, so
 * `cave_heavy`'s shares (§12.1's last recorded item) come from its two caves regions in the `caves-biomes` job
 * (`caves.metric.ts`, `.out/B3.caveHeavy.json`; Task 28).
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

/** The run's profiles (`METRICS_PROFILES`; absent, both), in draw order. */
const PROFILES = metricsProfiles(process.env.METRICS_PROFILES);
type Profile = ScatterProfile;
const SEEDS: readonly string[] = pick(['42'], ['42'], ['42', '1', '2', '3']);
const RANGE: Readonly<Record<Profile, number>> = { default: 1024, large_biomes: 4096 };
/**
 * Columns per (profile, seed), sized by T3's 2,000 lowland border pairs (§8.1's 512 / 2048 / 4096 give ≈ 0.64 such
 * pairs per default column and ≈ 0.17 per large_biomes one, whose biomes are 4 times larger): fast 4096 / 16384 measure
 * 2,613 / 2,843 pairs on seed '42'.
 */
const COLUMNS: Readonly<Record<Profile, number>> = pick(
  { default: 4096, large_biomes: 16384 },
  { default: 8192, large_biomes: 32768 },
  { default: 4096, large_biomes: 16384 },
);
const T4_REGIONS = pick(4, 4, 16);
const WORKER_DIR = `terrainRegionWorker-${TIER}`;
const SCATTER_WORKER_DIR = `terrainScatterWorker-${TIER}`;

/** The run's column slice (`METRICS_SLICE`; header): null, the whole run. */
const SLICE = columnSlice(process.env.METRICS_SLICE);
/** The whole run's tests (and the merge run's): skipped in a slice run, which gates and records nothing of its own. */
const wholeRunTest = SLICE?.kind === 'slice' ? test.skip : test;
const GATED: MetricEnv = { register: wholeRunTest };
/** The slice records' name, and the run's constants the merge run checks each record against. */
const SLICE_NAME = `terrain-${TIER}-${PROFILES.join('+')}`;
const SLICE_META = { tier: TIER, profiles: PROFILES, seeds: SEEDS, columns: COLUMNS, range: RANGE, t4Regions: T4_REGIONS };

/**
 * One T4 region's counts (header): its floor's sd under water, its wet, bedrock and deep floors, its lowest floor, its
 * water walls.
 */
interface T4Region { sd: number; wet: number; bedrock: number; deep: number; minFloor: number; walls: number; water: number }

/** A slice run's record (header): per profile, its `Scattered` per seed and its T4 regions by site index; timings. */
interface TerrainSlice {
  scattered: Record<Profile, Scattered[]>;
  t4: Record<Profile, Array<{ site: number; region: T4Region }>>;
  seconds: Record<Profile, number>;
  t4Seconds: number;
}

let slicesMemo: TerrainSlice[] | null = null;

/** The merge run's slice records, read once. */
function slices(): TerrainSlice[] {
  if (SLICE?.kind !== 'merge') throw new Error('terrain slices: not a merge run');
  slicesMemo ??= readSlices(SLICE_NAME, SLICE.n, SLICE_META) as TerrainSlice[];
  return slicesMemo;
}

/** Seconds summed over the slices, rounded as a run's own (a timing key). */
const slicesSeconds = (f: (s: TerrainSlice) => number): number => Math.round(slices().reduce((a, s) => a + f(s), 0) * 1000) / 1000;

let scatteredMemo: Promise<Record<Profile, Scattered>> | null = null;

/** The one pass over the scattered columns (T1, T2, T3, T5), memoised. */
function scattered(): Promise<Record<Profile, Scattered>> {
  scatteredMemo ??= scatter();
  return scatteredMemo;
}

async function scatter(): Promise<Record<Profile, Scattered>> {
  if (SLICE?.kind === 'merge') return mergedScatter();
  const columns = scatterColumns(PROFILES, SEEDS, COLUMNS, RANGE);
  const out = {} as Record<Profile, Scattered>;
  for (const profile of PROFILES) {
    const t0 = performance.now();
    const s = newScattered();
    const params = resolveProfile(profile);
    for (const [k, seed] of SEEDS.entries()) {
      mergeScattered(s, await scatterColumnsThreaded(SCATTER_WORKER_DIR, seed, params, columns[profile]![k]!));
    }
    s.seconds = Math.round(performance.now() - t0) / 1000;
    out[profile] = s;
  }
  return out;
}

/** The merge run's pass: per profile, each seed's slice parts summed (`sumScattered`), then the seeds in order. */
function mergedScatter(): Record<Profile, Scattered> {
  const out = {} as Record<Profile, Scattered>;
  for (const profile of PROFILES) {
    const s = newScattered();
    for (const [k, seed] of SEEDS.entries()) {
      const part = sumScattered(slices().map((r) => r.scattered[profile][k]!));
      if (part.columns !== COLUMNS[profile]) throw new Error(`terrain slices: ${profile}, seed ${seed}: ${part.columns} columns, not ${COLUMNS[profile]}`);
      mergeScattered(s, part);
    }
    s.seconds = slicesSeconds((r) => r.seconds[profile]);
    out[profile] = s;
  }
  return out;
}

/** Writes `<key>.<profile>` for every profile and returns the worst (max or min) under `key`. */
function perProfile(rec: Record<string, number>, key: string, values: Record<Profile, number>, worst: 'max' | 'min'): void {
  for (const p of PROFILES) rec[`${key}.${p}`] = values[p];
  const v = PROFILES.map((p) => values[p]);
  rec[key] = worst === 'max' ? Math.max(...v) : Math.min(...v);
}

const byProfile = (f: (p: Profile) => number): Record<Profile, number> =>
  Object.fromEntries(PROFILES.map((p) => [p, f(p)])) as Record<Profile, number>;

/** One part body per profile, in enforce mode (the minima fail softly with the profile in the message). */
async function partValues(body: typeof t1Values): Promise<Record<Profile, Record<string, number>>> {
  const sc = await scattered();
  return Object.fromEntries(PROFILES.map((p) => [p, body(sc[p], 'enforce', p)])) as Record<Profile, Record<string, number>>;
}

/** Writes each profile's non-part values as `<key>.<profile>`, profile by profile, in the body's key order. */
function extras(rec: Record<string, number>, per: Record<Profile, Record<string, number>>, parts: readonly string[]): void {
  for (const p of PROFILES) for (const [k, v] of Object.entries(per[p])) if (!parts.includes(k)) rec[`${k}.${p}`] = v;
}

metricTest('T1', ['band', 'span', 'above120', 'above200'], async () => {
  const per = await partValues(t1Values);
  const rec: Record<string, number> = {};
  perProfile(rec, 'band', byProfile((p) => per[p].band!), 'max');
  perProfile(rec, 'span', byProfile((p) => per[p].span!), 'min');
  perProfile(rec, 'above120', byProfile((p) => per[p].above120!), 'min');
  perProfile(rec, 'above200', byProfile((p) => per[p].above200!), 'min');
  extras(rec, per, ['band', 'span', 'above120', 'above200']);
  return rec;
}, 600_000, GATED);

metricTest('T2', ['overhangs', 'overhangsPeaks'], async () => {
  const per = await partValues(t2Values);
  const rec: Record<string, number> = {};
  perProfile(rec, 'overhangs', byProfile((p) => per[p].overhangs!), 'min');
  perProfile(rec, 'overhangsPeaks', byProfile((p) => per[p].overhangsPeaks!), 'min');
  extras(rec, per, ['overhangs', 'overhangsPeaks']);
  return rec;
}, 600_000, GATED);

metricTest('T3', ['value'], async () => {
  const per = await partValues(t3Values);
  const rec: Record<string, number> = {};
  extras(rec, per, ['value']);
  perProfile(rec, 'value', byProfile((p) => per[p].value!), 'max');
  return rec;
}, 600_000, GATED);

metricTest('T5', ['median', 'p90', 'p99'], async () => {
  const per = await partValues(t5Values);
  const rec: Record<string, number> = {};
  perProfile(rec, 'median', byProfile((p) => per[p].median!), 'max');
  perProfile(rec, 'p90', byProfile((p) => per[p].p90!), 'max');
  perProfile(rec, 'p99', byProfile((p) => per[p].p99!), 'max');
  extras(rec, per, ['median', 'p90', 'p99']);
  return rec;
}, 600_000, GATED);

const OUT_DIR = fileURLToPath(new URL('./.out/', import.meta.url));

/** Non-finite numbers (an empty window's NaN shares) as strings, as caves.metric.ts' records write them. */
const json = (v: unknown): string => `${JSON.stringify(v, (_, x: unknown) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x), 2)}\n`;

// B3's per-window record (header), every profile's.
wholeRunTest('B3: cave-biome shares per window (recorded)', async () => {
  const sc = await scattered();
  const profiles = Object.fromEntries(PROFILES.map((p) => [p, b3Values(sc[p], p)])) as Partial<Record<Profile, B3Values>>;
  mkdirSync(OUT_DIR, { recursive: true });
  const recordedOnly = PROFILES.filter((p) => p === 'large_biomes');
  writeFileSync(join(OUT_DIR, 'B3.windows.json'), json({
    id: 'B3.windows', tier: TIER, seeds: SEEDS, recordedOnly, caveHeavy: 'caves.metric.ts: .out/B3.caveHeavy.json', profiles,
  }));
  for (const p of PROFILES) {
    expect(profiles[p]!.windows, `B3 ${p}: 4 × 4 windows`).toHaveLength(16);
    expect(profiles[p]!.air, `B3 ${p}: cave air over the scattered columns`).toBeGreaterThan(0);
  }
}, 600_000);

// B3's gated parts (header; SP6b spec §12.1, master :1505): the default profile's smallest window share per biome
// (≥ 0.005 each) and its smallest window's cave air (≥ 50,000: an insufficient sample fails rather than passes).
if (PROFILES.includes('default')) {
  metricTest('B3', ['lushMin', 'dripstoneMin', 'abyssMin', 'windowAir'], async () => {
    const b = b3Values((await scattered()).default, 'default');
    return {
      lushMin: b.lushMin, dripstoneMin: b.dripstoneMin, abyssMin: b.abyssMin, windowAir: b.windowAir,
      insufficientWindows: b.insufficientWindows, air: b.air,
    };
  }, 600_000, { ...GATED, outName: 'B3.shares' });
}

/** Generates one T4 region (`genRegion`, 4 threads, no cache) and counts it (header). */
async function t4Region(params: Params, { seed, cx0, cz0 }: T4Site): Promise<T4Region> {
  const res = await genRegion({
    seed, params, cx0, cz0, w: 16, h: 16, upTo: 'T', order: 'spiral', threads: 4, cache: false, workerDir: WORKER_DIR,
  });
  const g = newGrid(256, 256);
  for (let cz = cz0; cz < cz0 + 16; cz++) {
    for (let cx = cx0; cx < cx0 + 16; cx++) putColumn(g, res.view.store.proto(cx, cz)!.aux()!, 16 * (cx - cx0), 16 * (cz - cz0));
  }
  const [walls, water] = waterWalls(g);
  let n0 = 0;
  let s1 = 0;
  let s2 = 0;
  let bedrock = 0;
  let deep = 0;
  let minFloor = Infinity;
  for (let k = 0; k < g.n * g.m; k++) {
    if (g.land[k] === 1) continue;
    const f = g.top[k]!;
    n0++;
    s1 += f;
    s2 += f * f;
    if (f === -64) bedrock++;
    if (f <= -50) deep++;
    if (f < minFloor) minFloor = f;
  }
  const sd = n0 < 2 ? 0 : Math.sqrt(Math.max(0, (s2 - (s1 * s1) / n0) / (n0 - 1)));
  return { sd, wet: n0, bedrock, deep, minFloor, walls, water };
}

/** Per profile, T4's regions in site order: generated here (the whole run) or the slices' records (the merge run). */
async function t4Regions(drawn: ReturnType<typeof t4Sites>): Promise<Record<Profile, T4Region[]>> {
  const out = {} as Record<Profile, T4Region[]>;
  for (const profile of PROFILES) {
    const sites = drawn[profile]!.sites;
    if (SLICE?.kind === 'merge') {
      const regions: Array<T4Region | undefined> = Array.from({ length: sites.length }, () => undefined);
      for (const r of slices()) {
        for (const { site, region } of r.t4[profile]) {
          if (regions[site] !== undefined) throw new Error(`terrain slices: ${profile}'s T4 site ${site} in two slices`);
          regions[site] = region;
        }
      }
      const missing = regions.findIndex((r) => r === undefined);
      if (missing >= 0) throw new Error(`terrain slices: no slice holds ${profile}'s T4 site ${missing}`);
      out[profile] = regions as T4Region[];
    } else {
      const params = resolveProfile(profile);
      out[profile] = [];
      for (const site of sites) out[profile].push(await t4Region(params, site));
    }
  }
  return out;
}

metricTest('T4', ['floorSd', 'exposedBedrock', 'deepFloor'], async () => {
  const t0 = performance.now();
  const drawn = t4Sites(PROFILES, SEEDS, T4_REGIONS, RANGE);
  const measured = await t4Regions(drawn);
  const rec: Record<string, number> = {};
  const sd = byProfile(() => 0);
  const bedrock = byProfile(() => 0);
  const deep = byProfile(() => 0);
  let walls = 0;
  let water = 0;
  let draws = 0;
  for (const profile of PROFILES) {
    let sdSum = 0;
    let regions = 0;
    let wet = 0;
    let minFloor = Infinity;
    draws += drawn[profile]!.draws;
    for (const r of measured[profile]) {
      walls += r.walls;
      water += r.water;
      bedrock[profile] += r.bedrock;
      deep[profile] += r.deep;
      if (r.minFloor < minFloor) minFloor = r.minFloor;
      wet += r.wet;
      regions++;
      sdSum += r.sd;
    }
    sd[profile] = sdSum / regions;
    rec[`wetPositions.${profile}`] = wet;
    rec[`minFloor.${profile}`] = minFloor;
    rec[`regions.${profile}`] = regions;
  }
  perProfile(rec, 'floorSd', sd, 'min');
  for (const p of PROFILES) { rec[`exposedBedrock.${p}`] = bedrock[p]; rec[`deepFloor.${p}`] = deep[p]; }
  rec.exposedBedrock = PROFILES.reduce((a, p) => a + bedrock[p], 0);
  rec.deepFloor = PROFILES.reduce((a, p) => a + deep[p], 0);
  rec.siteDraws = draws;
  rec.waterWallVoxels = walls;
  rec.waterVoxels = water;
  rec.waterWallShare = water === 0 ? 0 : walls / water;
  rec.seconds = SLICE?.kind === 'merge' ? slicesSeconds((r) => r.t4Seconds) : Math.round(performance.now() - t0) / 1000;
  return rec;
}, 600_000, GATED);

// A slice run (header): its share of T1-T5's and B3's columns and of T4's regions, recorded for the merge run.
if (SLICE?.kind === 'slice') {
  const slice = SLICE;
  test(`column slice ${slice.k}/${slice.n}: T1-T5's and B3's columns and T4's regions, draws ${slice.k}, ${slice.k} + ${slice.n}, …, recorded for the merge run`, async () => {
    const columns = scatterColumns(PROFILES, SEEDS, COLUMNS, RANGE);
    const drawn = t4Sites(PROFILES, SEEDS, T4_REGIONS, RANGE);
    const rec = { scattered: {}, t4: {}, seconds: {}, t4Seconds: 0 } as TerrainSlice;
    for (const profile of PROFILES) {
      const t0 = performance.now();
      const params = resolveProfile(profile);
      rec.scattered[profile] = [];
      for (const [k, seed] of SEEDS.entries()) {
        const cols = sliceOf(columns[profile]![k]!, slice);
        const part = await scatterColumnsThreaded(SCATTER_WORKER_DIR, seed, params, cols);
        expect(part.columns, `${profile}, seed ${seed}`).toBe(cols.length);
        rec.scattered[profile].push(part);
      }
      rec.seconds[profile] = Math.round(performance.now() - t0) / 1000;
    }
    const t1 = performance.now();
    for (const profile of PROFILES) {
      const params = resolveProfile(profile);
      const sites = drawn[profile]!.sites;
      rec.t4[profile] = [];
      for (const site of sliceOf(sites.map((_, i) => i), slice)) rec.t4[profile].push({ site, region: await t4Region(params, sites[site]!) });
    }
    rec.t4Seconds = Math.round(performance.now() - t1) / 1000;
    writeSlice(SLICE_NAME, slice, SLICE_META, rec);
  }, 600_000);
}

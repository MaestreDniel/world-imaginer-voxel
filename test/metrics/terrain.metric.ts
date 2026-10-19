import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { metricTest } from '../harness/metric';
import { genRegion } from '../harness/region';
import {
  analyseColumn, forEachColumnThreaded, newGrid, newScatterScratch, newScattered, putColumn, t1Values, t2Values, t3Values,
  t5Values, waterWalls, type Scattered,
} from '../harness/terrainScatter';

/**
 * T1-T5 on voxels (SP3b spec §8.1, §8.2): the real T stage's land heights (T1), overhangs (T2), lowland border steps
 * (T3), ocean floors (T4) and the 3D surface estimate (T5).
 *
 * Sampling (§8.1), per profile (default, large_biomes) and tier seed ('42'; full '42', '1', '2', '3'):
 * - Scattered columns (T1, T2, T3, T5): `COLUMNS` per (profile, seed), drawn by one `Xoshiro128(fnv1a32('T1-T5'))`
 *   uniformly over ±1024 chunks (default) or ±4096 (large_biomes), i.e. ±16384 / ±65536 blocks, generated on 4 region
 *   workers (`regionWorker.ts`) and read on this thread (every accumulator is order-independent), through
 *   `test/harness/terrainScatter.ts` (`forEachColumnThreaded`, `analyseColumn` and the part bodies in `'enforce'` mode,
 *   SP3e spec §5.1). The four metrics read the same columns (one pass, memoised).
 * - T4 regions through the harness (`genRegion`, 4 threads, `cache: false`: each region is generated once per run):
 *   16 × 16 columns at sites whose 2D `offset` at the region's centre is < 40 (fast 4, quick 4, full 16 per
 *   (profile, seed); `Xoshiro128(fnv1a32('T4'))`, rejection-drawn over the same squares).
 *
 * Definitions (§8.2): solid = any block but air (stone; bedrock at y −64); a position is land when no water voxel lies
 * above its highest stone (`WORLD_SURFACE_WG === OCEAN_FLOOR_WG`), and its true top is `WORLD_SURFACE_WG − 1`; under
 * water the floor is `OCEAN_FLOOR_WG − 1`. A solid→air transition at y is solid(y) and not solid(y + 1) (y + 1 = 320 is air).
 * - T1 over all 256 positions of each column: `band` the largest share of land tops in [b, b + 10), `span` p95 − p5,
 *   `above120` / `above200` the shares of land tops > 120 / > 200 (master §6.4 "share y > 120").
 * - T2: `overhangs` the share of land positions with ≥ 2 transitions at y ≥ top − 30; `overhangsPeaks` the same over land
 *   positions whose aux A `surfaceBiome` is windswept_hills, snowy_slopes, stony_peaks, jagged_peaks or frozen_peaks.
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
 *   y ≥ −56; |surfaceEst3 − true top|, `median`, `p90`, `p99` (nearest rank).
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
 */
type Tier = 'fast' | 'quick' | 'full';
const TIER = (process.env.METRICS_TIER ?? 'fast') as Tier;
const pick = <T>(fast: T, quick: T, full: T): T => (TIER === 'full' ? full : TIER === 'quick' ? quick : fast);

const PROFILES = ['default', 'large_biomes'] as const;
type Profile = (typeof PROFILES)[number];
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

let scatteredMemo: Promise<Record<Profile, Scattered>> | null = null;

/** The one pass over the scattered columns (T1, T2, T3, T5), memoised. */
function scattered(): Promise<Record<Profile, Scattered>> {
  scatteredMemo ??= scatter();
  return scatteredMemo;
}

async function scatter(): Promise<Record<Profile, Scattered>> {
  const r = new Xoshiro128(fnv1a32('T1-T5'));
  const scratch = newScatterScratch();
  const out = {} as Record<Profile, Scattered>;
  for (const profile of PROFILES) {
    const t0 = performance.now();
    const s = newScattered();
    const R = RANGE[profile];
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const dc = createDensityContext(createGenContext(seedFromInput(seed), params));
      const est = (x: number, z: number): number => surfaceEst3(dc, x, z);
      const cols: Array<[number, number]> = [];
      for (let n = 0; n < COLUMNS[profile]; n++) cols.push([-R + r.nextInt(2 * R), -R + r.nextInt(2 * R)]);
      await forEachColumnThreaded(SCATTER_WORKER_DIR, seed, params, cols, (view, cx, cz) => analyseColumn(s, view, cx, cz, est, scratch));
    }
    s.seconds = Math.round(performance.now() - t0) / 1000;
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
});

metricTest('T2', ['overhangs', 'overhangsPeaks'], async () => {
  const per = await partValues(t2Values);
  const rec: Record<string, number> = {};
  perProfile(rec, 'overhangs', byProfile((p) => per[p].overhangs!), 'min');
  perProfile(rec, 'overhangsPeaks', byProfile((p) => per[p].overhangsPeaks!), 'min');
  extras(rec, per, ['overhangs', 'overhangsPeaks']);
  return rec;
});

metricTest('T3', ['value'], async () => {
  const per = await partValues(t3Values);
  const rec: Record<string, number> = {};
  extras(rec, per, ['value']);
  perProfile(rec, 'value', byProfile((p) => per[p].value!), 'max');
  return rec;
});

metricTest('T5', ['median', 'p90', 'p99'], async () => {
  const per = await partValues(t5Values);
  const rec: Record<string, number> = {};
  perProfile(rec, 'median', byProfile((p) => per[p].median!), 'max');
  perProfile(rec, 'p90', byProfile((p) => per[p].p90!), 'max');
  perProfile(rec, 'p99', byProfile((p) => per[p].p99!), 'max');
  extras(rec, per, ['median', 'p90', 'p99']);
  return rec;
});

metricTest('T4', ['floorSd', 'exposedBedrock', 'deepFloor'], async () => {
  const t0 = performance.now();
  const r = new Xoshiro128(fnv1a32('T4'));
  const rec: Record<string, number> = {};
  const sd = byProfile(() => 0);
  const bedrock = byProfile(() => 0);
  const deep = byProfile(() => 0);
  let walls = 0;
  let water = 0;
  let draws = 0;
  for (const profile of PROFILES) {
    const params = resolveProfile(profile);
    const R = RANGE[profile];
    let sdSum = 0;
    let regions = 0;
    let wet = 0;
    let minFloor = Infinity;
    for (const seed of SEEDS) {
      const ctx = createGenContext(seedFromInput(seed), params);
      for (let n = 0; n < T4_REGIONS; n++) {
        let cx0: number;
        let cz0: number;
        do {
          cx0 = -R + r.nextInt(2 * R - 16);
          cz0 = -R + r.nextInt(2 * R - 16);
          draws++;
        } while (columnPoint(ctx, 16 * (cx0 + 8), 16 * (cz0 + 8)).offset >= 40);
        const res = await genRegion({
          seed, params, cx0, cz0, w: 16, h: 16, upTo: 'T', order: 'spiral', threads: 4, cache: false, workerDir: WORKER_DIR,
        });
        const g = newGrid(256, 256);
        for (let cz = cz0; cz < cz0 + 16; cz++) {
          for (let cx = cx0; cx < cx0 + 16; cx++) putColumn(g, res.view.store.proto(cx, cz)!.aux()!, 16 * (cx - cx0), 16 * (cz - cz0));
        }
        const [wl, wt] = waterWalls(g);
        walls += wl;
        water += wt;
        let n0 = 0;
        let s1 = 0;
        let s2 = 0;
        for (let k = 0; k < g.n * g.m; k++) {
          if (g.land[k] === 1) continue;
          const f = g.top[k]!;
          n0++;
          s1 += f;
          s2 += f * f;
          if (f === -64) bedrock[profile]++;
          if (f <= -50) deep[profile]++;
          if (f < minFloor) minFloor = f;
        }
        wet += n0;
        regions++;
        sdSum += n0 < 2 ? 0 : Math.sqrt(Math.max(0, (s2 - (s1 * s1) / n0) / (n0 - 1)));
      }
    }
    sd[profile] = sdSum / regions;
    rec[`wetPositions.${profile}`] = wet;
    rec[`minFloor.${profile}`] = minFloor;
    rec[`regions.${profile}`] = regions;
  }
  perProfile(rec, 'floorSd', sd, 'min');
  for (const p of PROFILES) { rec[`exposedBedrock.${p}`] = bedrock[p]; rec[`deepFloor.${p}`] = deep[p]; }
  rec.exposedBedrock = bedrock.default + bedrock.large_biomes;
  rec.deepFloor = deep.default + deep.large_biomes;
  rec.siteDraws = draws;
  rec.waterWallVoxels = walls;
  rec.waterVoxels = water;
  rec.waterWallShare = water === 0 ? 0 : walls / water;
  rec.seconds = Math.round(performance.now() - t0) / 1000;
  return rec;
});

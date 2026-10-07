import { Worker } from 'node:worker_threads';
import { expect } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { biomeFamily, biomeId, type BiomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import type { Params } from '../../src/core/params/schema';
import { AIR } from '../../src/world/blocks/index';
import type { AuxView, ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { metricTest } from '../harness/metric';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import { genRegion } from '../harness/region';
import type { RegionAttachMsg, RegionColumnMsg, RegionWorkerReply } from '../harness/regionWorker';

/**
 * T1-T5 on voxels (SP3b spec §8.1, §8.2): the real T stage's land heights (T1), overhangs (T2), lowland border steps
 * (T3), ocean floors (T4) and the 3D surface estimate (T5).
 *
 * Sampling (§8.1), per profile (default, large_biomes) and tier seed ('42'; full '42', '1', '2', '3'):
 * - Scattered columns (T1, T2, T3, T5): `COLUMNS` per (profile, seed), drawn by one `Xoshiro128(fnv1a32('T1-T5'))`
 *   uniformly over ±1024 chunks (default) or ±4096 (large_biomes), i.e. ±16384 / ±65536 blocks, generated on 4 region
 *   workers (`regionWorker.ts`, `forEachColumnThreaded` below) and read on this thread (every accumulator is order-independent). The four
 *   metrics read the same columns (one pass, memoised).
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

const MIN_PEAK_COLUMNS = 20;
const MIN_T5_POSITIONS = 1000;
const MIN_T3_PAIRS = 2000;

const PEAKS = new Set(['windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks'].map((n) => biomeId(n as Parameters<typeof biomeId>[0])));
const T5_LOCAL = [2, 6, 10, 14];
const T3_FAMILY: BiomeFamily = 'lowland';
const FLOAT_MAX_HEIGHT = 6;
const FLOAT_MIN_GAP = 3;

/** Fails the running metric test (soft) when a population is below its minimum. */
function requireSample(what: string, n: number, min: number): void {
  expect.soft(n, `${what}: insufficient sample (${n} < ${min})`).toBeGreaterThanOrEqual(min);
}

/** Column solidity, index ((y + 64) << 8) | (lz << 4) | lx, from the proto sections. */
function solidity(view: ColumnView, out: Uint8Array): Uint8Array {
  for (let sy = 0; sy < 24; sy++) {
    const b = view.sectionBlocks(sy);
    const base = sy << 12;
    if (typeof b === 'number') out.fill(b === AIR ? 0 : 1, base, base + 4096);
    else for (let i = 0; i < 4096; i++) out[base + i] = b[i] === AIR ? 0 : 1;
  }
  return out;
}

/** Solid→air transitions at y ∈ [y0, y1] (y0 ≥ −64) of position p. */
function transitions(solid: Uint8Array, p: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = Math.max(-64, y0); y <= y1; y++) {
    if (solid[((y + 64) << 8) | p] === 1 && (y === 319 || solid[((y + 65) << 8) | p] === 0)) n++;
  }
  return n;
}

/** Voxels of position p in solid runs of height ≤ 6 resting on an air gap of ≥ 3 blocks, at y ∈ [−56, top]. */
function floatingVoxels(solid: Uint8Array, p: number, top: number): number {
  let voxels = 0;
  let gap = 0;
  let run = 0;
  let runGap = 0;
  for (let y = -56; y <= top + 1; y++) {
    const s = y <= 319 && solid[((y + 64) << 8) | p] === 1;
    if (s) {
      if (run === 0) runGap = gap;
      run++;
      gap = 0;
    } else {
      if (run > 0 && run <= FLOAT_MAX_HEIGHT && runGap >= FLOAT_MIN_GAP) voxels += run;
      run = 0;
      gap++;
    }
  }
  return voxels;
}

const nearestRank = (sorted: ArrayLike<number>, q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

/** Per-position land flag, floor/top, surface and biome of a 16w × 16h block grid, row-major. */
interface Grid { n: number; m: number; top: Int16Array; ws: Int16Array; land: Uint8Array; biome: Uint8Array }

const newGrid = (n: number, m: number): Grid =>
  ({ n, m, top: new Int16Array(n * m), ws: new Int16Array(n * m), land: new Uint8Array(n * m), biome: new Uint8Array(n * m) });

/** Copies one column's aux A into the grid at block offset (ox, oz). */
function putColumn(g: Grid, a: AuxView, ox: number, oz: number): void {
  for (let p = 0; p < 256; p++) {
    const k = (oz + (p >> 4)) * g.n + ox + (p & 15);
    const ws = a.worldSurfaceWG[p]!;
    const of = a.oceanFloorWG[p]!;
    g.ws[k] = ws;
    g.top[k] = of - 1;
    g.land[k] = ws === of ? 1 : 0;
    g.biome[k] = a.surfaceBiome[p]!;
  }
}

/** Water-wall diagnostic over a grid: [wall voxels, water voxels above tops]. */
function waterWalls(g: Grid): [number, number] {
  let walls = 0;
  let water = 0;
  for (let j = 0; j < g.m; j++) {
    for (let i = 0; i < g.n; i++) {
      const k = j * g.n + i;
      const ws = g.ws[k]!;
      const top = g.top[k]!;
      if (ws - 1 <= top) continue;
      water += ws - 1 - top;
      let minWs = Infinity;
      if (i > 0) minWs = Math.min(minWs, g.ws[k - 1]!);
      if (i < g.n - 1) minWs = Math.min(minWs, g.ws[k + 1]!);
      if (j > 0) minWs = Math.min(minWs, g.ws[k - g.n]!);
      if (j < g.m - 1) minWs = Math.min(minWs, g.ws[k + g.n]!);
      walls += Math.max(0, ws - Math.max(minWs, top + 1));
    }
  }
  return [walls, water];
}

interface Scattered {
  hist: Float64Array; // land tops, index top + 64
  land: number;
  over: number;
  peakLand: number;
  peakOver: number;
  peakColumns: number;
  floatPositions: number;
  floatVoxels: number;
  peakFloatPositions: number;
  t5: number[];
  t5Land: number;
  t5Multi: number;
  /** T3: per biome, inside pairs and their steep count; per same-family biome pair `(min << 8) | max`, the same. */
  inside: Float64Array;
  insideSteep: Float64Array;
  borderPairs: Float64Array;
  borderSteep: Float64Array;
  landPairs: number;
  crossFamilyPairs: number;
  walls: number;
  water: number;
  columns: number;
  waterPositions: number;
  seconds: number;
}

let scatterScript: Promise<string> | null = null;
const askRegion = (w: Worker, msg: RegionAttachMsg | RegionColumnMsg): Promise<RegionWorkerReply> => ask<RegionWorkerReply>(w, msg);

/**
 * Generates scattered (possibly repeated) columns up to the T stage on 4 region workers (`regionWorker.ts`) and calls
 * `visit` on this thread with each column's proto view as soon as it is done, then frees it. Each worker writes into
 * its own small shared store and gets its next column only after `visit` has freed its previous one, so two columns
 * never meet on a store's 64 × 64 torus. `visit` sees the columns in completion order, not the list's: what it
 * accumulates must not depend on the order.
 */
async function forEachColumnThreaded(
  seed: string,
  params: Params,
  cols: ReadonlyArray<readonly [number, number]>,
  visit: (view: ColumnView, cx: number, cz: number) => void,
): Promise<void> {
  scatterScript ??= buildNodeTaskWorker(SCATTER_WORKER_DIR, { entry: 'test/harness/regionWorker.ts' });
  const script = await scatterScript;
  const stores = Array.from({ length: 4 }, () => createStore({ shared: true, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 }));
  const workers = stores.map(() => new Worker(script));
  try {
    const ready = await Promise.all(workers.map((w, t) => askRegion(w, { type: 'attach', handles: stores[t]!.handles(), seedText: seed, params })));
    for (const r of ready) if (r.type !== 'ready') throw new Error(`region worker: ${r.type === 'error' ? r.message : r.type}`);
    let next = 0;
    const drain = async (t: number): Promise<void> => {
      const store = stores[t]!;
      while (next < cols.length) {
        const [cx, cz] = cols[next++]!;
        const r = await askRegion(workers[t]!, { type: 'column', cx, cz });
        if (r.type !== 'done') throw new Error(`region worker ${t}, column (${cx}, ${cz}): ${r.type === 'error' ? r.message : r.type}`);
        const view = store.proto(cx, cz);
        if (view === null) throw new Error(`region worker ${t}: column (${cx}, ${cz}) has no proto set`);
        visit(view, cx, cz);
        store.freeColumn(cx, cz);
      }
    };
    await Promise.all(workers.map((_, t) => drain(t)));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

let scatteredMemo: Promise<Record<Profile, Scattered>> | null = null;

/** The one pass over the scattered columns (T1, T2, T3, T5), memoised. */
function scattered(): Promise<Record<Profile, Scattered>> {
  scatteredMemo ??= scatter();
  return scatteredMemo;
}

async function scatter(): Promise<Record<Profile, Scattered>> {
  const r = new Xoshiro128(fnv1a32('T1-T5'));
  const solid = new Uint8Array(98304);
  const g = newGrid(16, 16);
  const out = {} as Record<Profile, Scattered>;
  for (const profile of PROFILES) {
    const t0 = performance.now();
    const s: Scattered = {
      hist: new Float64Array(384), land: 0, over: 0, peakLand: 0, peakOver: 0, peakColumns: 0,
      floatPositions: 0, floatVoxels: 0, peakFloatPositions: 0, t5: [], t5Land: 0, t5Multi: 0,
      inside: new Float64Array(256), insideSteep: new Float64Array(256),
      borderPairs: new Float64Array(65536), borderSteep: new Float64Array(65536), landPairs: 0, crossFamilyPairs: 0,
      walls: 0, water: 0, columns: 0, waterPositions: 0, seconds: 0,
    };
    const R = RANGE[profile];
    const params = resolveProfile(profile);
    for (const seed of SEEDS) {
      const dc = createDensityContext(createGenContext(seedFromInput(seed), params));
      const cols: Array<[number, number]> = [];
      for (let n = 0; n < COLUMNS[profile]; n++) cols.push([-R + r.nextInt(2 * R), -R + r.nextInt(2 * R)]);
      await forEachColumnThreaded(seed, params, cols, (view, cx, cz) => {
        const aux = view.aux()!;
        solidity(view, solid);
        s.columns++;
        let peakHere = false;
        for (let p = 0; p < 256; p++) {
          const ws = aux.worldSurfaceWG[p]!;
          if (ws !== aux.oceanFloorWG[p]!) { s.waterPositions++; continue; }
          const top = ws - 1;
          s.land++;
          s.hist[top + 64]!++;
          const over = transitions(solid, p, top - 30, top) >= 2;
          if (over) s.over++;
          const fv = floatingVoxels(solid, p, top);
          if (fv > 0) { s.floatPositions++; s.floatVoxels += fv; }
          if (PEAKS.has(aux.surfaceBiome[p]!)) {
            s.peakLand++;
            peakHere = true;
            if (over) s.peakOver++;
            if (fv > 0) s.peakFloatPositions++;
          }
        }
        if (peakHere) s.peakColumns++;
        for (const lz of T5_LOCAL) {
          for (const lx of T5_LOCAL) {
            const p = (lz << 4) | lx;
            const ws = aux.worldSurfaceWG[p]!;
            if (ws !== aux.oceanFloorWG[p]!) continue;
            s.t5Land++;
            const top = ws - 1;
            if (transitions(solid, p, -56, top) !== 1) { s.t5Multi++; continue; }
            s.t5.push(Math.abs(surfaceEst3(dc, 16 * cx + lx, 16 * cz + lz) - top));
          }
        }
        putColumn(g, aux, 0, 0);
        const [wl, wt] = waterWalls(g);
        s.walls += wl;
        s.water += wt;
        const pair = (k: number, q: number): void => {
          if (g.land[k] !== 1 || g.land[q] !== 1) return;
          s.landPairs++;
          const steep = Math.abs(g.top[k]! - g.top[q]!) >= 4 ? 1 : 0;
          const a = g.biome[k]!;
          const b = g.biome[q]!;
          if (a === b) {
            s.inside[a]!++;
            s.insideSteep[a]! += steep;
          } else if (biomeFamily(a) === biomeFamily(b)) {
            const e = a < b ? (a << 8) | b : (b << 8) | a;
            s.borderPairs[e]!++;
            s.borderSteep[e]! += steep;
          } else s.crossFamilyPairs++;
        };
        for (let k = 0; k < 256; k++) {
          if ((k & 15) < 15) pair(k, k + 1);
          if (k < 240) pair(k, k + 16);
        }
      });
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

metricTest('T1', ['band', 'span', 'above120', 'above200'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  const band = byProfile((p) => {
    const h = sc[p].hist;
    let best = 0;
    for (let b = 0; b + 10 <= 384; b++) {
      let s = 0;
      for (let k = b; k < b + 10; k++) s += h[k]!;
      if (s > best) best = s;
    }
    return best / sc[p].land;
  });
  const quantile = (p: Profile, q: number): number => {
    const h = sc[p].hist;
    const target = Math.ceil(q * sc[p].land);
    let acc = 0;
    for (let k = 0; k < 384; k++) { acc += h[k]!; if (acc >= target) return k - 64; }
    return 319;
  };
  const above = (p: Profile, y: number): number => {
    let s = 0;
    for (let k = y + 1 + 64; k < 384; k++) s += sc[p].hist[k]!;
    return s / sc[p].land;
  };
  perProfile(rec, 'band', band, 'max');
  perProfile(rec, 'span', byProfile((p) => quantile(p, 0.95) - quantile(p, 0.05)), 'min');
  perProfile(rec, 'above120', byProfile((p) => above(p, 120)), 'min');
  perProfile(rec, 'above200', byProfile((p) => above(p, 200)), 'min');
  for (const p of PROFILES) {
    rec[`p5.${p}`] = quantile(p, 0.05);
    rec[`p50.${p}`] = quantile(p, 0.5);
    rec[`p95.${p}`] = quantile(p, 0.95);
    rec[`landPositions.${p}`] = sc[p].land;
    rec[`landShare.${p}`] = sc[p].land / (256 * sc[p].columns);
    rec[`columns.${p}`] = sc[p].columns;
    rec[`seconds.${p}`] = sc[p].seconds;
    rec[`waterWallVoxels.${p}`] = sc[p].walls;
    rec[`waterVoxels.${p}`] = sc[p].water;
    rec[`waterWallShare.${p}`] = sc[p].water === 0 ? 0 : sc[p].walls / sc[p].water;
  }
  return rec;
});

metricTest('T2', ['overhangs', 'overhangsPeaks'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  perProfile(rec, 'overhangs', byProfile((p) => sc[p].over / sc[p].land), 'min');
  perProfile(rec, 'overhangsPeaks', byProfile((p) => (sc[p].peakLand === 0 ? 0 : sc[p].peakOver / sc[p].peakLand)), 'min');
  for (const p of PROFILES) {
    rec[`peakPositions.${p}`] = sc[p].peakLand;
    rec[`peakColumns.${p}`] = sc[p].peakColumns;
    rec[`overhangPositions.${p}`] = sc[p].over;
    rec[`floatingRockShare.${p}`] = sc[p].floatPositions / sc[p].land;
    rec[`floatingRockVoxels.${p}`] = sc[p].floatVoxels / sc[p].land;
    rec[`floatingRockPeaksShare.${p}`] = sc[p].peakLand === 0 ? 0 : sc[p].peakFloatPositions / sc[p].peakLand;
    rec[`floatingRockPositions.${p}`] = sc[p].floatPositions;
    requireSample(`T2.overhangsPeaks (${p}) peak columns`, sc[p].peakColumns, MIN_PEAK_COLUMNS);
  }
  return rec;
});

metricTest('T3', ['value'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  const values = byProfile(() => 0);
  for (const profile of PROFILES) {
    const s = sc[profile];
    const fam = new Map<BiomeFamily, [number, number, number]>(); // pairs, steep, expected
    let dropped = 0;
    for (let e = 0; e < 65536; e++) {
      const n = s.borderPairs[e]!;
      if (n === 0) continue;
      const a = e >> 8;
      const b = e & 255;
      if (s.inside[a] === 0 || s.inside[b] === 0) { dropped += n; continue; }
      const d = (s.insideSteep[a]! / s.inside[a]! + s.insideSteep[b]! / s.inside[b]!) / 2;
      const f = fam.get(biomeFamily(a)) ?? [0, 0, 0];
      f[0] += n;
      f[1] += s.borderSteep[e]!;
      f[2] += n * d;
      fam.set(biomeFamily(a), f);
    }
    let all: [number, number, number] = [0, 0, 0];
    for (const [f, [n, st, d]] of fam) {
      rec[`familyPairs.${f}.${profile}`] = n;
      rec[`familyValue.${f}.${profile}`] = d === 0 ? Infinity : st / d;
      all = [all[0] + n, all[1] + st, all[2] + d];
    }
    const [n, st, d] = fam.get(T3_FAMILY) ?? [0, 0, 0];
    values[profile] = d === 0 ? Infinity : st / d;
    rec[`borderPairs.${profile}`] = n;
    rec[`borderSteepShare.${profile}`] = n === 0 ? 0 : st / n;
    rec[`expectedSteepShare.${profile}`] = n === 0 ? 0 : d / n;
    rec[`allFamiliesValue.${profile}`] = all[2] === 0 ? Infinity : all[1] / all[2];
    rec[`allFamiliesPairs.${profile}`] = all[0];
    rec[`droppedPairs.${profile}`] = dropped;
    rec[`landPairs.${profile}`] = s.landPairs;
    rec[`crossFamilyPairs.${profile}`] = s.crossFamilyPairs;
    rec[`columns.${profile}`] = s.columns;
    requireSample(`T3 (${profile}) lowland border pairs`, n, MIN_T3_PAIRS);
  }
  perProfile(rec, 'value', values, 'max');
  return rec;
});

metricTest('T5', ['median', 'p90', 'p99'], async () => {
  const sc = await scattered();
  const rec: Record<string, number> = {};
  const arrays = {} as Record<Profile, Float64Array>;
  for (const p of PROFILES) {
    arrays[p] = Float64Array.from(sc[p].t5).sort();
    requireSample(`T5 (${p}) single-surface positions`, arrays[p].length, MIN_T5_POSITIONS);
  }
  perProfile(rec, 'median', byProfile((p) => nearestRank(arrays[p], 0.5)), 'max');
  perProfile(rec, 'p90', byProfile((p) => nearestRank(arrays[p], 0.9)), 'max');
  perProfile(rec, 'p99', byProfile((p) => nearestRank(arrays[p], 0.99)), 'max');
  for (const p of PROFILES) {
    rec[`max.${p}`] = arrays[p][arrays[p].length - 1] ?? 0;
    rec[`mean.${p}`] = arrays[p].reduce((a, b) => a + b, 0) / Math.max(1, arrays[p].length);
    rec[`singleSurface.${p}`] = arrays[p].length;
    rec[`landPositions.${p}`] = sc[p].t5Land;
    rec[`multiSurface.${p}`] = sc[p].t5Multi;
  }
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

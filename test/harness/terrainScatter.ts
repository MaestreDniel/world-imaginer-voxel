import { Worker } from 'node:worker_threads';
import { expect } from 'vitest';
import { fnv1a32 } from '../../src/core/hash';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { biomeFamily, type BiomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import type { ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { ask, buildNodeTaskWorker } from './nodeWorker';
import type { RegionAttachMsg, RegionColumnMsg, RegionScatterMsg, RegionWorkerReply } from './regionWorker';
import { newScattered, type Scattered } from './terrainAnalysis';

export {
  analyseColumn, newGrid, newScatterScratch, newScattered, preCaveSolidity, preCaveTop, putColumn, solidity, transitions,
  waterWalls, type Grid, type ScatterColumn, type ScatterScratch, type Scattered,
} from './terrainAnalysis';

/**
 * T1-T5's threaded column scatter and per-column analysis (SP3e spec §5.1 "Extractions", D18), moved out of
 * `test/metrics/terrain.metric.ts` and parameterised: the worker dir, seed, params and columns are arguments, and
 * the part bodies take a population `mode`. terrain.metric.ts calls them in `'enforce'` mode with its own constants
 * (its outputs are unchanged, spec §5.7); the presets' full-tier records call them in `'record'` mode (§5.5).
 * The per-column analysis lives in `terrainAnalysis.ts` (re-exported here), which the region worker bundles for
 * `scatterColumnsThreaded` (SP6b spec §13 L5).
 * Definitions: terrain.metric.ts' header (SP3b spec §8.2).
 */

/**
 * `'enforce'`: a population below its minimum fails the running metric test softly with "insufficient sample" (SP3b
 * spec §8.1). `'record'`: no minimum is checked; each part's population is returned as `<part>.population`.
 */
export type PopulationMode = 'enforce' | 'record';

export const MIN_PEAK_COLUMNS = 20;
export const MIN_T5_POSITIONS = 1000;
export const MIN_T3_PAIRS = 2000;

const T3_FAMILY: BiomeFamily = 'lowland';

/** T1-T5's profiles in their draw order (terrain.metric.ts' header; surface.metric.ts draws the same columns). */
export const SCATTER_PROFILES = ['default', 'large_biomes'] as const;
export type ScatterProfile = (typeof SCATTER_PROFILES)[number];

/**
 * The profiles a terrain or surface metric run measures (SP6b spec §13 L2, L3; read once per file): `METRICS_PROFILES`'
 * comma-separated names, in draw order; absent, both. An unknown (or empty) name throws.
 */
export function metricsProfiles(raw: string | undefined): readonly ScatterProfile[] {
  if (raw === undefined) return SCATTER_PROFILES;
  const names = raw.split(',').map((n) => n.trim());
  for (const n of names) {
    if (!(SCATTER_PROFILES as readonly string[]).includes(n)) throw new Error(`METRICS_PROFILES '${raw}': unknown profile '${n}' (default, large_biomes)`);
  }
  return SCATTER_PROFILES.filter((p) => names.includes(p));
}

/**
 * T1-T5's scattered columns (terrain.metric.ts' header, SP3b spec §8.1; S1-S3's too): per profile and seed,
 * `columns[profile]` chunk columns drawn by one `Xoshiro128(fnv1a32('T1-T5'))`, profile by profile in
 * `SCATTER_PROFILES`' order, then seed, then column, uniformly over ±`range[profile]` chunks. Every profile's draws are
 * made and only `active`'s lists kept (ruling P1), so a run filtered by `METRICS_PROFILES` measures the unsplit run's
 * columns. Each kept profile's lists are indexed as `seeds`.
 */
export function scatterColumns(
  active: readonly ScatterProfile[],
  seeds: readonly string[],
  columns: Readonly<Record<ScatterProfile, number>>,
  range: Readonly<Record<ScatterProfile, number>>,
): Partial<Record<ScatterProfile, Array<Array<[number, number]>>>> {
  const r = new Xoshiro128(fnv1a32('T1-T5'));
  const out: Partial<Record<ScatterProfile, Array<Array<[number, number]>>>> = {};
  for (const profile of SCATTER_PROFILES) {
    const R = range[profile];
    const perSeed = seeds.map(() => {
      const cols: Array<[number, number]> = [];
      for (let n = 0; n < columns[profile]; n++) cols.push([-R + r.nextInt(2 * R), -R + r.nextInt(2 * R)]);
      return cols;
    });
    if (active.includes(profile)) out[profile] = perSeed;
  }
  return out;
}

/** A T4 region: its seed and its 16 × 16 chunks' origin. */
export interface T4Site { readonly seed: string; readonly cx0: number; readonly cz0: number }

/**
 * T4's regions (terrain.metric.ts' header): per profile and seed, `regions` 16 × 16-chunk origins drawn by one
 * `Xoshiro128(fnv1a32('T4'))`, profile by profile in `SCATTER_PROFILES`' order, then seed, each rejection-drawn over
 * ±`range[profile]` until the region centre's 2D `offset` (`columnPoint` on that profile's and seed's GenContext) is
 * < 40. Every profile's draws, its rejections included, are made and only `active`'s sites kept (ruling P1); `draws`
 * counts a kept profile's draws, rejections included.
 */
export function t4Sites(
  active: readonly ScatterProfile[],
  seeds: readonly string[],
  regions: number,
  range: Readonly<Record<ScatterProfile, number>>,
): Partial<Record<ScatterProfile, { sites: T4Site[]; draws: number }>> {
  const r = new Xoshiro128(fnv1a32('T4'));
  const out: Partial<Record<ScatterProfile, { sites: T4Site[]; draws: number }>> = {};
  for (const profile of SCATTER_PROFILES) {
    const params = resolveProfile(profile);
    const R = range[profile];
    const sites: T4Site[] = [];
    let draws = 0;
    for (const seed of seeds) {
      const ctx = createGenContext(seedFromInput(seed), params);
      for (let n = 0; n < regions; n++) {
        let cx0: number;
        let cz0: number;
        do {
          cx0 = -R + r.nextInt(2 * R - 16);
          cz0 = -R + r.nextInt(2 * R - 16);
          draws++;
        } while (columnPoint(ctx, 16 * (cx0 + 8), 16 * (cz0 + 8)).offset >= 40);
        sites.push({ seed, cx0, cz0 });
      }
    }
    if (active.includes(profile)) out[profile] = { sites, draws };
  }
  return out;
}

/** Fails the running metric test (soft) when a population is below its minimum. */
export function requireSample(what: string, n: number, min: number): void {
  expect.soft(n, `${what}: insufficient sample (${n} < ${min})`).toBeGreaterThanOrEqual(min);
}

/** Nearest-rank quantile of a sorted array; NaN for an empty one (a record-mode population of 0). */
const nearestRank = (sorted: ArrayLike<number>, q: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

const scatterScripts = new Map<string, Promise<string>>();
const askRegion = (w: Worker, msg: RegionAttachMsg | RegionColumnMsg | RegionScatterMsg): Promise<RegionWorkerReply> =>
  ask<RegionWorkerReply>(w, msg);

/** The region worker's script for `workerDir`, bundled once per dir (`forEachColumnThreaded`, `scatterColumnsThreaded`). */
function regionWorkerScript(workerDir: string): Promise<string> {
  let built = scatterScripts.get(workerDir);
  if (built === undefined) {
    built = buildNodeTaskWorker(workerDir, { entry: 'test/harness/regionWorker.ts' });
    scatterScripts.set(workerDir, built);
  }
  return built;
}

/**
 * Generates scattered (possibly repeated) columns up to the T stage on 4 region workers (`regionWorker.ts`, bundled
 * once per `workerDir` under test/.cache/: the dir must be unique per metric file and tier) and calls `visit` on this
 * thread with each column's proto view as soon as it is done, then frees it. Each worker writes into its own small
 * shared store and gets its next column only after `visit` has freed its previous one, so two columns never meet on a
 * store's 64 × 64 torus. `visit` sees the columns in completion order, not the list's: what it accumulates must not
 * depend on the order.
 */
export async function forEachColumnThreaded(
  workerDir: string,
  seed: string,
  params: Params,
  cols: ReadonlyArray<readonly [number, number]>,
  visit: (view: ColumnView, cx: number, cz: number) => void,
): Promise<void> {
  const script = await regionWorkerScript(workerDir);
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

/**
 * Adds every accumulator of `part` into `into` (numbers summed, Float64Arrays element by element, the T5 list
 * appended); the T5 list's order is the caller's to fix (`scatterColumnsThreaded` sorts it after its merges). Every
 * other accumulator is an integer count, so the merged record does not depend on the order of the parts. Throws when
 * `part` is not a record of `into`'s shape (a missing or extra field, another kind or array length), so a worker built
 * from another version of `terrainAnalysis.ts` cannot be merged silently.
 */
export function mergeScattered(into: Scattered, part: Scattered): void {
  const a = into as unknown as Record<string, number | Float64Array | number[]>;
  const b = part as unknown as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!(k in a)) throw new Error(`mergeScattered: unknown field '${k}'`);
  for (const k of Object.keys(a)) {
    const x = a[k]!;
    const y = b[k];
    if (typeof x === 'number') {
      if (typeof y !== 'number') throw new Error(`mergeScattered: field '${k}' is not a number`);
      a[k] = x + y;
    } else if (Array.isArray(x)) {
      if (!Array.isArray(y)) throw new Error(`mergeScattered: field '${k}' is not an array`);
      for (const v of y as number[]) x.push(v);
    } else {
      if (!(y instanceof Float64Array) || y.length !== x.length) throw new Error(`mergeScattered: field '${k}' is not a Float64Array(${x.length})`);
      for (let i = 0; i < x.length; i++) x[i]! += y[i]!;
    }
  }
}

/**
 * T1-T5's analysis of scattered (possibly repeated) columns on `opts.workers` region workers (default 4; SP6b spec
 * §13 L5, ruling P5): the columns are dealt out in turn (column i to worker i mod n), and each worker generates its
 * share up to the T stage, analyses each column in place (`analyseColumn` with `surfaceEst3` and `preCaveTop` on a
 * DensityContext of its own, built once) and frees it, then answers one `Scattered` for its share. This thread merges
 * the parts (`mergeScattered`) and sorts the T5 list, so the result equals the serial `analyseColumn` loop's for any
 * worker count (`seconds` aside: 0, the caller's to set). `workerDir` as `forEachColumnThreaded`'s.
 */
export async function scatterColumnsThreaded(
  workerDir: string,
  seed: string,
  params: Params,
  cols: ReadonlyArray<readonly [number, number]>,
  opts: { workers?: number } = {},
): Promise<Scattered> {
  const n = opts.workers ?? 4;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`scatterColumnsThreaded: workers ${n} (an integer ≥ 1)`);
  const script = await regionWorkerScript(workerDir);
  const stores = Array.from({ length: n }, () => createStore({ shared: true, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 }));
  const workers = stores.map(() => new Worker(script));
  try {
    const ready = await Promise.all(workers.map((w, t) => askRegion(w, { type: 'attach', handles: stores[t]!.handles(), seedText: seed, params })));
    for (const r of ready) if (r.type !== 'ready') throw new Error(`region worker: ${r.type === 'error' ? r.message : r.type}`);
    const parts = await Promise.all(workers.map(async (w, t) => {
      const r = await askRegion(w, { type: 'scatter', cols: cols.filter((_, i) => i % n === t) });
      if (r.type !== 'scattered') throw new Error(`region worker ${t}, scatter: ${r.type === 'error' ? r.message : r.type}`);
      return r.scattered;
    }));
    const s = newScattered();
    for (const part of parts) mergeScattered(s, part);
    s.t5.sort((x, y) => x - y);
    return s;
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

/** Adds `<part>.population` = n for each part (record mode only). */
function populations(rec: Record<string, number>, mode: PopulationMode, parts: readonly string[], n: number): void {
  if (mode === 'record') for (const part of parts) rec[`${part}.population`] = n;
}

/**
 * T1 of one population: the parts `band`, `span`, `above120`, `above200`, then the extras (p5/p50/p95, land
 * positions and share, columns, seconds, water walls). T1 has no minimum; its population is the land positions.
 * `label` names the population in enforce-mode messages (unused: T1 has none; kept for a uniform call).
 */
export function t1Values(s: Scattered, mode: PopulationMode, label: string): Record<string, number> {
  void label;
  const h = s.hist;
  let best = 0;
  for (let b = 0; b + 10 <= 384; b++) {
    let sum = 0;
    for (let k = b; k < b + 10; k++) sum += h[k]!;
    if (sum > best) best = sum;
  }
  const quantile = (q: number): number => {
    const target = Math.ceil(q * s.land);
    let acc = 0;
    for (let k = 0; k < 384; k++) { acc += h[k]!; if (acc >= target) return k - 64; }
    return 319;
  };
  const above = (y: number): number => {
    let sum = 0;
    for (let k = y + 1 + 64; k < 384; k++) sum += h[k]!;
    return sum / s.land;
  };
  const rec: Record<string, number> = {
    band: best / s.land,
    span: quantile(0.95) - quantile(0.05),
    above120: above(120),
    above200: above(200),
    p5: quantile(0.05),
    p50: quantile(0.5),
    p95: quantile(0.95),
    landPositions: s.land,
    landShare: s.land / (256 * s.columns),
    columns: s.columns,
    seconds: s.seconds,
    waterWallVoxels: s.walls,
    waterVoxels: s.water,
    waterWallShare: s.water === 0 ? 0 : s.walls / s.water,
  };
  populations(rec, mode, ['band', 'span', 'above120', 'above200'], s.land);
  return rec;
}

/**
 * T2 of one population: `overhangs` (population: land positions) and `overhangsPeaks` (population: peak columns,
 * minimum 20 in enforce mode), then the floating-rock extras.
 */
export function t2Values(s: Scattered, mode: PopulationMode, label: string): Record<string, number> {
  const rec: Record<string, number> = {
    overhangs: s.over / s.land,
    overhangsPeaks: s.peakLand === 0 ? 0 : s.peakOver / s.peakLand,
    peakPositions: s.peakLand,
    peakColumns: s.peakColumns,
    overhangPositions: s.over,
    floatingRockShare: s.floatPositions / s.land,
    floatingRockVoxels: s.floatVoxels / s.land,
    floatingRockPeaksShare: s.peakLand === 0 ? 0 : s.peakFloatPositions / s.peakLand,
    floatingRockPositions: s.floatPositions,
  };
  if (mode === 'enforce') requireSample(`T2.overhangsPeaks (${label}) peak columns`, s.peakColumns, MIN_PEAK_COLUMNS);
  populations(rec, mode, ['overhangs'], s.land);
  populations(rec, mode, ['overhangsPeaks'], s.peakColumns);
  return rec;
}

/**
 * T3 of one population: `value` over the lowland border pairs (population: those pairs, minimum 2,000 in enforce
 * mode), then per family `familyPairs.<f>` / `familyValue.<f>` and the pair diagnostics.
 */
export function t3Values(s: Scattered, mode: PopulationMode, label: string): Record<string, number> {
  const rec: Record<string, number> = {};
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
    rec[`familyPairs.${f}`] = n;
    rec[`familyValue.${f}`] = d === 0 ? Infinity : st / d;
    all = [all[0] + n, all[1] + st, all[2] + d];
  }
  const [n, st, d] = fam.get(T3_FAMILY) ?? [0, 0, 0];
  rec.borderPairs = n;
  rec.borderSteepShare = n === 0 ? 0 : st / n;
  rec.expectedSteepShare = n === 0 ? 0 : d / n;
  rec.allFamiliesValue = all[2] === 0 ? Infinity : all[1] / all[2];
  rec.allFamiliesPairs = all[0];
  rec.droppedPairs = dropped;
  rec.landPairs = s.landPairs;
  rec.crossFamilyPairs = s.crossFamilyPairs;
  rec.columns = s.columns;
  if (mode === 'enforce') requireSample(`T3 (${label}) lowland border pairs`, n, MIN_T3_PAIRS);
  rec.value = d === 0 ? Infinity : st / d;
  populations(rec, mode, ['value'], n);
  return rec;
}

/**
 * T5 of one population: nearest-rank `median`, `p90`, `p99` of |surfaceEst3 − pre-cave top| (SP6a spec §10.4; the
 * population: the single-surface positions, minimum 1,000 in enforce mode; NaN when empty), then the extras
 * (`raisedTop`: the positions whose pre-cave top lies above the true top).
 */
export function t5Values(s: Scattered, mode: PopulationMode, label: string): Record<string, number> {
  const sorted = Float64Array.from(s.t5).sort();
  if (mode === 'enforce') requireSample(`T5 (${label}) single-surface positions`, sorted.length, MIN_T5_POSITIONS);
  const rec: Record<string, number> = {
    median: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p99: nearestRank(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
    singleSurface: sorted.length,
    landPositions: s.t5Land,
    multiSurface: s.t5Multi,
    raisedTop: s.t5Raised,
  };
  populations(rec, mode, ['median', 'p90', 'p99'], sorted.length);
  return rec;
}

/** The draft presets whose full-tier records `presetRecord` keys (SP3e spec §5.5). */
const RECORD_PRESETS: ReadonlySet<string> = new Set(['archipelago', 'amplified', 'floating_islands']);

/**
 * One preset's record-mode values keyed for the presets' full-tier records (SP3e spec §5.5): every key `<k>` becomes
 * `<k>.<preset>`, so a part's value `<part>` becomes `<part>.<preset>` and its population `<part>.population` becomes
 * `<part>.population.<preset>` (extras likewise); values, NaN included, are kept as they are. Used by the T and S
 * records of `presets.metric.ts`, which merge the three presets' records into one `.out` record (nothing enters a
 * per-profile worst-of). RangeError for a profile that is not a draft preset.
 */
export function presetRecord(values: Readonly<Record<string, number>>, preset: string): Record<string, number> {
  if (!RECORD_PRESETS.has(preset)) throw new RangeError(`presetRecord: ${preset} is not a draft preset`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) out[`${k}.${preset}`] = v;
  return out;
}

import { Worker } from 'node:worker_threads';
import { expect } from 'vitest';
import type { Params } from '../../src/core/params/schema';
import { biomeFamily, biomeId, type BiomeFamily } from '../../src/gen/biomes/registry';
import { AIR } from '../../src/world/blocks/index';
import type { AuxView, ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { ask, buildNodeTaskWorker } from './nodeWorker';
import type { RegionAttachMsg, RegionColumnMsg, RegionWorkerReply } from './regionWorker';

/**
 * T1-T5's threaded column scatter and per-column analysis (SP3e spec §5.1 "Extractions", D18), moved out of
 * `test/metrics/terrain.metric.ts` and parameterised: the worker dir, seed, params and columns are arguments, and
 * the part bodies take a population `mode`. terrain.metric.ts calls them in `'enforce'` mode with its own constants
 * (its outputs are unchanged, spec §5.7); the presets' full-tier records call them in `'record'` mode (§5.5).
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

const PEAKS = new Set(['windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks'].map((n) => biomeId(n as Parameters<typeof biomeId>[0])));
const T5_LOCAL = [2, 6, 10, 14];
const T3_FAMILY: BiomeFamily = 'lowland';
const FLOAT_MAX_HEIGHT = 6;
const FLOAT_MIN_GAP = 3;

/** Fails the running metric test (soft) when a population is below its minimum. */
export function requireSample(what: string, n: number, min: number): void {
  expect.soft(n, `${what}: insufficient sample (${n} < ${min})`).toBeGreaterThanOrEqual(min);
}

/** What the per-column analysis reads of a column: its blocks and aux A (a `ColumnView` is one). */
export interface ScatterColumn {
  sectionBlocks(sy: number): Uint16Array | number;
  aux(): Pick<AuxView, 'worldSurfaceWG' | 'oceanFloorWG' | 'surfaceBiome'> | null;
}

/** Column solidity, index ((y + 64) << 8) | (lz << 4) | lx, from the proto sections. */
function solidity(view: ScatterColumn, out: Uint8Array): Uint8Array {
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

/** Nearest-rank quantile of a sorted array; NaN for an empty one (a record-mode population of 0). */
const nearestRank = (sorted: ArrayLike<number>, q: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

/** Per-position land flag, floor/top, surface and biome of a 16w × 16h block grid, row-major. */
export interface Grid { n: number; m: number; top: Int16Array; ws: Int16Array; land: Uint8Array; biome: Uint8Array }

export const newGrid = (n: number, m: number): Grid =>
  ({ n, m, top: new Int16Array(n * m), ws: new Int16Array(n * m), land: new Uint8Array(n * m), biome: new Uint8Array(n * m) });

/** Copies one column's aux A into the grid at block offset (ox, oz). */
export function putColumn(g: Grid, a: Pick<AuxView, 'worldSurfaceWG' | 'oceanFloorWG' | 'surfaceBiome'>, ox: number, oz: number): void {
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
export function waterWalls(g: Grid): [number, number] {
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

/** The accumulators of one population of scattered columns (order-independent sums). */
export interface Scattered {
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
  /** Wall time of the population, set by the caller (a timing key: never compared). */
  seconds: number;
}

export const newScattered = (): Scattered => ({
  hist: new Float64Array(384), land: 0, over: 0, peakLand: 0, peakOver: 0, peakColumns: 0,
  floatPositions: 0, floatVoxels: 0, peakFloatPositions: 0, t5: [], t5Land: 0, t5Multi: 0,
  inside: new Float64Array(256), insideSteep: new Float64Array(256),
  borderPairs: new Float64Array(65536), borderSteep: new Float64Array(65536), landPairs: 0, crossFamilyPairs: 0,
  walls: 0, water: 0, columns: 0, waterPositions: 0, seconds: 0,
});

/** Reusable buffers of `analyseColumn` (one per caller thread). */
export interface ScatterScratch { solid: Uint8Array; g: Grid }

export const newScatterScratch = (): ScatterScratch => ({ solid: new Uint8Array(98304), g: newGrid(16, 16) });

/**
 * Adds one generated column (chunk column cx, cz) to `s`: T1's land tops, T2's overhangs and floating rocks, T5's
 * |surfaceEst − true top| at its 16 positions (`surfaceEst(x, z)` is `surfaceEst3` on the population's density
 * context), T3's in-column neighbour pairs and the water-wall diagnostic.
 */
export function analyseColumn(
  s: Scattered,
  view: ScatterColumn,
  cx: number,
  cz: number,
  surfaceEst: (x: number, z: number) => number,
  scratch: ScatterScratch,
): void {
  const { solid, g } = scratch;
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
      s.t5.push(Math.abs(surfaceEst(16 * cx + lx, 16 * cz + lz) - top));
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
}

const scatterScripts = new Map<string, Promise<string>>();
const askRegion = (w: Worker, msg: RegionAttachMsg | RegionColumnMsg): Promise<RegionWorkerReply> => ask<RegionWorkerReply>(w, msg);

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
  let built = scatterScripts.get(workerDir);
  if (built === undefined) {
    built = buildNodeTaskWorker(workerDir, { entry: 'test/harness/regionWorker.ts' });
    scatterScripts.set(workerDir, built);
  }
  const script = await built;
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
 * T5 of one population: nearest-rank `median`, `p90`, `p99` of |surfaceEst3 − true top| (population: the
 * single-surface positions, minimum 1,000 in enforce mode; NaN when empty), then the extras.
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
  };
  populations(rec, mode, ['median', 'p90', 'p99'], sorted.length);
  return rec;
}

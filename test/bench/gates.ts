/** SP1 bench gates (SP1 spec §7.5). Outside THRESHOLDS in SP1; changing them requires a spec amendment. */
export const P1_MAX_REGRESSION = 1.3;
export const KILL_RATIO_MAX = 1.6;
/** P1 column-stage budget (master §3.0): buildColumnSample p50 / p95 in ms on the reference machine (SP2a; p95 gated through p99). */
export const COLUMN_P50_MAX_MS = 0.7;
export const COLUMN_P95_MAX_MS = 1.2;
/** SP3b exit (master §10, SP3b spec §10): the real T stage's `terrain.real` p50 in ms per column, its ColumnSample included. */
export const TERRAIN_P50_MAX_MS = 4;

/**
 * Every gated bench row, in measurement order: `noise.bench.ts` measures exactly these, and `test/baselines.json`
 * records every one (a unit test), so a row added without `npm run bench:record` cannot stay ungated.
 * SP3a §7 appends `store.alloc` and `terrain.provisional`; SP3b §10 appends `density.corner` and replaces
 * `terrain.provisional` by `terrain.real`.
 */
export const BENCH_ROWS = [
  'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
  'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
  'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
  'store.alloc', 'density.corner', 'terrain.real',
] as const;

export interface BenchKernel {
  readonly nsPerEval: number;
  /** nsPerEval ÷ the calibration kernel's nsPerEval, measured in the same run. */
  readonly ratio: number;
}

export interface Baselines {
  readonly machine: string;
  readonly node: string;
  readonly date: string;
  readonly kernels: Readonly<Record<string, BenchKernel>>;
  readonly killRatio: number;
}

export function gateFailures(baseline: Baselines | null, kernels: Readonly<Record<string, BenchKernel>>, killRatio: number): string[] {
  const out: string[] = [];
  if (killRatio > KILL_RATIO_MAX) out.push(`kill criterion: lattice3/perm512 = ${killRatio.toFixed(3)} > ${KILL_RATIO_MAX}`);
  if (baseline !== null) {
    for (const [name, k] of Object.entries(kernels)) {
      const b = baseline.kernels[name];
      if (b === undefined) continue;
      if (k.ratio > b.ratio * P1_MAX_REGRESSION) out.push(`${name}: ratio ${k.ratio.toFixed(3)} > ${P1_MAX_REGRESSION} × baseline ${b.ratio.toFixed(3)}`);
    }
  }
  return out;
}

/** The absolute latencies the bench gates, in ms per call (`columnP95` is the measured p99, an upper bound of p95). */
export interface AbsoluteLatencies {
  readonly columnP50: number;
  readonly columnP95: number;
  readonly terrainP50: number;
}

/**
 * The absolute gates (P1 column budget, SP2a; the real T budget, SP3b): checked by `npm run bench` and before
 * `npm run bench:record` writes, so a record refuses to write when one fails.
 */
export function absoluteGateFailures(l: AbsoluteLatencies): string[] {
  const out: string[] = [];
  if (l.columnP50 > COLUMN_P50_MAX_MS) out.push(`P1 column p50 ${l.columnP50.toFixed(3)} ms > ${COLUMN_P50_MAX_MS} ms`);
  if (l.columnP95 > COLUMN_P95_MAX_MS) out.push(`P1 column p95 ${l.columnP95.toFixed(3)} ms > ${COLUMN_P95_MAX_MS} ms`);
  if (l.terrainP50 > TERRAIN_P50_MAX_MS) out.push(`terrain.real p50 ${l.terrainP50.toFixed(3)} ms > ${TERRAIN_P50_MAX_MS} ms`);
  return out;
}

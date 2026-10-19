/** SP1 bench gates (SP1 spec §7.5). Outside THRESHOLDS in SP1; changing them requires a spec amendment. */
export const P1_MAX_REGRESSION = 1.3;
export const KILL_RATIO_MAX = 1.6;
/** P1 column-stage budget (master §3.0): buildColumnSample p50 / p95 in ms on the reference machine (SP2a; p95 gated through p99). */
export const COLUMN_P50_MAX_MS = 0.7;
export const COLUMN_P95_MAX_MS = 1.2;
/**
 * SP3b exit (master §10, SP3b spec §10): the real T stage's `terrain.real` p50 in ms per column, its ColumnSample included;
 * SP3e §7 gates `terrain.islands` (floating_islands cluster columns) at the same bound.
 */
export const TERRAIN_P50_MAX_MS = 4;
/**
 * SP3d (its spec §9, master §7): the vertical 128² density slice on one thread (`slice.vertical128`), one slice part at
 * PART_BUDGET of the heaviest noise tree (`slice.partWorst`, which pins the work unit of spec §5.2) and one slider commit
 * of a session whose two trees are at the 128 KiB cap (`session.commitMaxTree`), p50 in ms.
 */
export const SLICE_V128_P50_MAX_MS = 300;
export const SLICE_PART_P50_MAX_MS = 250;
export const SESSION_COMMIT_P50_MAX_MS = 4;

/**
 * `terrain.islands`' run (SP3e §7): 256 timed iterations after exactly one warm-up call, each call on the next of its
 * ISLANDS_COLUMNS precomputed cluster columns, so no column is generated twice. tinybench warms up until both
 * `warmupIterations` and `warmupTime` (250 ms when unset) are reached, so `warmupTime: 0` is what keeps the warm-up
 * to one call: unset, a 3.5 ms column gave about 70 more, and a column under about 1 ms would run past the 512.
 */
export const ISLANDS_RUN = Object.freeze({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
export const ISLANDS_COLUMNS = 512;

/**
 * Every gated bench row, in measurement order: `noise.bench.ts` measures exactly these, and `test/baselines.json`
 * records every one (a unit test), so a row added without `npm run bench:record` cannot stay ungated.
 * SP3a §7 appends `store.alloc` and `terrain.provisional`; SP3b §10 appends `density.corner` and replaces
 * `terrain.provisional` by `terrain.real`; SP3c §7 appends `surface.column` (the surface pass alone); SP3d §9 appends
 * the slice rows `slice.vertical128`, `slice.horizontal128`, `slice.partWorst` and the session row `session.commitMaxTree`;
 * SP3e §7 appends `terrain.islands` (fillColumnT on floating_islands at cluster columns).
 */
export const BENCH_ROWS = [
  'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
  'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
  'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
  'store.alloc', 'density.corner', 'terrain.real', 'surface.column',
  'slice.vertical128', 'slice.horizontal128', 'slice.partWorst', 'session.commitMaxTree', 'terrain.islands',
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

/**
 * The ratio gates (each row within `P1_MAX_REGRESSION` × its baseline ratio; rows without a baseline are skipped) and
 * the kill criterion. `exempt` (SP3c §7, `BENCH_EXEMPT`) names rows whose ratio gate is skipped: each such row with a
 * baseline is printed through `log` as `<row>: exempt, ratio r vs baseline b` instead. The kill criterion is never
 * exempt (nor are the absolute gates, which `absoluteGateFailures` checks).
 */
export function gateFailures(
  baseline: Baselines | null, kernels: Readonly<Record<string, BenchKernel>>, killRatio: number, exempt: readonly string[],
  log: (line: string) => void = (line) => { console.log(line); },
): string[] {
  const out: string[] = [];
  if (killRatio > KILL_RATIO_MAX) out.push(`kill criterion: lattice3/perm512 = ${killRatio.toFixed(3)} > ${KILL_RATIO_MAX}`);
  if (baseline !== null) {
    for (const [name, k] of Object.entries(kernels)) {
      const b = baseline.kernels[name];
      if (b === undefined) continue;
      if (exempt.includes(name)) {
        log(`${name}: exempt, ratio ${k.ratio.toFixed(3)} vs baseline ${b.ratio.toFixed(3)}`);
        continue;
      }
      if (k.ratio > b.ratio * P1_MAX_REGRESSION) out.push(`${name}: ratio ${k.ratio.toFixed(3)} > ${P1_MAX_REGRESSION} × baseline ${b.ratio.toFixed(3)}`);
    }
  }
  return out;
}

/**
 * `BENCH_EXEMPT` (SP3c §7): a comma-separated list of `BENCH_ROWS` names (blanks around a name ignored, repeats kept
 * once); unset or empty → []. An unknown name or an empty entry throws, so a typo fails the run instead of gating
 * the row. `npm run bench:record` never reads it.
 */
export function parseBenchExempt(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const rows: readonly string[] = BENCH_ROWS;
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim();
    if (name === '') throw new Error(`BENCH_EXEMPT: empty entry in '${value}'`);
    if (!rows.includes(name)) throw new Error(`BENCH_EXEMPT: unknown bench row '${name}' (one of ${BENCH_ROWS.join(', ')})`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The absolute latencies the bench gates, in ms per call (`columnP95` is the measured p99, an upper bound of p95). */
export interface AbsoluteLatencies {
  readonly columnP50: number;
  readonly columnP95: number;
  readonly terrainP50: number;
  /** SP3d §9: `slice.vertical128`, `slice.partWorst` and `session.commitMaxTree` p50. */
  readonly sliceV128P50: number;
  readonly slicePartP50: number;
  readonly sessionCommitP50: number;
  /** SP3e §7: `terrain.islands` p50 (floating_islands cluster columns), gated at TERRAIN_P50_MAX_MS. */
  readonly islandsP50: number;
}

/**
 * The absolute gates (P1 column budget, SP2a; the real T budget, SP3b; the slice and session commit budgets, SP3d): checked by `npm run bench` and before
 * `npm run bench:record` writes, so a record refuses to write when one fails.
 */
export function absoluteGateFailures(l: AbsoluteLatencies): string[] {
  const out: string[] = [];
  if (l.columnP50 > COLUMN_P50_MAX_MS) out.push(`P1 column p50 ${l.columnP50.toFixed(3)} ms > ${COLUMN_P50_MAX_MS} ms`);
  if (l.columnP95 > COLUMN_P95_MAX_MS) out.push(`P1 column p95 ${l.columnP95.toFixed(3)} ms > ${COLUMN_P95_MAX_MS} ms`);
  if (l.terrainP50 > TERRAIN_P50_MAX_MS) out.push(`terrain.real p50 ${l.terrainP50.toFixed(3)} ms > ${TERRAIN_P50_MAX_MS} ms`);
  if (l.sliceV128P50 > SLICE_V128_P50_MAX_MS) out.push(`slice.vertical128 p50 ${l.sliceV128P50.toFixed(3)} ms > ${SLICE_V128_P50_MAX_MS} ms`);
  if (l.slicePartP50 > SLICE_PART_P50_MAX_MS) out.push(`slice.partWorst p50 ${l.slicePartP50.toFixed(3)} ms > ${SLICE_PART_P50_MAX_MS} ms`);
  if (l.islandsP50 > TERRAIN_P50_MAX_MS) out.push(`terrain.islands p50 ${l.islandsP50.toFixed(3)} ms > ${TERRAIN_P50_MAX_MS} ms`);
  if (l.sessionCommitP50 > SESSION_COMMIT_P50_MAX_MS) out.push(`session.commitMaxTree p50 ${l.sessionCommitP50.toFixed(3)} ms > ${SESSION_COMMIT_P50_MAX_MS} ms`);
  return out;
}

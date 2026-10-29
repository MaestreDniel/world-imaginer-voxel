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
 * SP4a §9.3 (master §7's L and Mesh rows): one column's light job (`light.column`: the region copy, the BFS and the
 * 24 output sections) and one non-trivial section's padded copy and mesh (`mesh.section`), p50 and p99 in ms (p99 as
 * the upper bound of p95, the `column.sample` precedent).
 */
export const LIGHT_P50_MAX_MS = 4;
export const LIGHT_P99_MAX_MS = 8;
export const MESH_P50_MAX_MS = 1.0;
export const MESH_P99_MAX_MS = 2.5;
/**
 * SP5a §6.2: one edit's relight (`relight.edit`: the sim's `relightMs` of a one-edit `applyEdits`), p95 in ms, gated
 * through p99 (the upper bound of p95, the `column.sample` precedent), so stricter than the spec's p95.
 */
export const RELIGHT_P95_MAX_MS = 3;

/**
 * `terrain.islands`' run (SP3e §7): 256 timed iterations after exactly one warm-up call, each call on the next of its
 * ISLANDS_COLUMNS precomputed cluster columns, so no column is generated twice. tinybench warms up until both
 * `warmupIterations` and `warmupTime` (250 ms when unset) are reached, so `warmupTime: 0` is what keeps the warm-up
 * to one call: unset, a 3.5 ms column gave about 70 more, and a column under about 1 ms would run past the 512.
 */
export const ISLANDS_RUN = Object.freeze({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
export const ISLANDS_COLUMNS = 512;

/**
 * The SP4a rows' runs (§9.3), on `ISLANDS_RUN`'s pattern: exactly one warm-up call, then one timed call per lit column
 * (`light.column`, 256) or per non-trivial section (`mesh.section`, 1024). Each row walks its items cyclically, so the
 * probe and the warm-up take the first two and the last two timed calls take them again: every item is timed once.
 */
export const LIGHT_RUN = Object.freeze({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
export const MESH_RUN = Object.freeze({ iterations: 1024, time: 0, warmupIterations: 1, warmupTime: 0 });
/**
 * `relight.edit`'s run (SP5a §6.2), on the same pattern: one probe, one warm-up, 256 timed calls, each the next edit of
 * its 6-edit cycle, so the 258 calls are 43 whole turns and the region ends as it began.
 */
export const RELIGHT_RUN = Object.freeze({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });

/**
 * Every gated bench row, in measurement order: `noise.bench.ts` measures exactly these, and `test/baselines.json`
 * records every one (a unit test), so a row added without `npm run bench:record` cannot stay ungated.
 * SP3a §7 appends `store.alloc` and `terrain.provisional`; SP3b §10 appends `density.corner` and replaces
 * `terrain.provisional` by `terrain.real`; SP3c §7 appends `surface.column` (the surface pass alone); SP3d §9 appends
 * the slice rows `slice.vertical128`, `slice.horizontal128`, `slice.partWorst` and the session row `session.commitMaxTree`;
 * SP3e §7 appends `terrain.islands` (fillColumnT on floating_islands at cluster columns); SP4a §9.3 appends
 * `light.column` (one column's light job) and `mesh.section` (one non-trivial section's padded copy and mesh); SP5a §6.2
 * appends `relight.edit` (one edit's relight).
 */
export const BENCH_ROWS = [
  'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
  'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
  'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
  'store.alloc', 'density.corner', 'terrain.real', 'surface.column',
  'slice.vertical128', 'slice.horizontal128', 'slice.partWorst', 'session.commitMaxTree', 'terrain.islands',
  'light.column', 'mesh.section', 'relight.edit',
] as const;

export interface BenchKernel {
  readonly nsPerEval: number;
  /**
   * nsPerEval ÷ the mean of the calibration kernel's nsPerEval measured immediately before and immediately after this
   * row, in the same run (SP5a Task 43b: `CALIBRATION_BESIDE_RUN`, `measureBracketed`), so both share one clock state;
   * `calibration.fmix32` is its own divisor (ratio 1).
   */
  readonly ratio: number;
}

/**
 * SP5a Task 43b: the calibration run beside each row, tinybench options for the `calibration.fmix32` kernel measured
 * immediately before and immediately after every other row (20 ms of warm-up, then at least 100 ms timed). On the
 * i7-12700H the busy P-core leaves its turbo window (4.7 GHz) after about 30-40 s of the run and drops to 3.0-3.9 GHz
 * (Task 40c); one calibration taken first, at turbo, divided the late rows measured throttled. In Task 43b's probe
 * (2026-10-29, the task report) windows of 25 to 400 ms read the same p50 (0.635-0.638 ns at turbo, 12 runs each between
 * bursts of other work), so 100 ms is stable with margin.
 */
export const CALIBRATION_BESIDE_RUN = Object.freeze({ time: 100, warmupTime: 20 });

/**
 * SP5a Task 43b (review I2): the calibrations before and after a row agree when the larger is within 5 % of the smaller
 * (`calibrationSpread`). A row that straddles the turbo drop (or a transient) sees them differ, by 15-50 % between 4.7 GHz
 * and 3.0-3.9 GHz, and runs again, up to `ROW_ATTEMPTS_MAX` runs in all (`measureBracketed`).
 */
export const CALIBRATION_SPREAD_MAX = 0.05;
export const ROW_ATTEMPTS_MAX = 3;

/** How far apart two calibrations are: the larger ÷ the smaller, minus 1 (0 when equal). */
export function calibrationSpread(before: number, after: number): number {
  return Math.max(before, after) / Math.min(before, after) - 1;
}

/** One bracketed row: the row's run kept, the calibrations before and after it, its divisor and how often it ran. */
export interface BracketedRun<R> {
  readonly result: R;
  readonly before: number;
  readonly after: number;
  /** The row's divisor (`benchKernels`' `beside`): the mean of `before` and `after`. */
  readonly divisor: number;
  /** How many times the row ran (1 when its first calibrations agreed). */
  readonly runs: number;
}

/**
 * SP5a Task 43b (review I2): a row between a calibration immediately before it and one immediately after it, so its
 * divisor (their mean) shares the row's clock even when the CPU leaves its turbo window during the row. When the two
 * differ by more than `CALIBRATION_SPREAD_MAX` the clock moved under the row: `rerun` resets the row's state and the
 * row runs again between two fresh calibrations, up to `ROW_ATTEMPTS_MAX` runs; the first run whose calibrations agree
 * is kept, else the run with the smallest spread.
 */
export async function measureBracketed<R>(
  calibrate: () => Promise<number>, row: () => Promise<R>, rerun: () => void = () => {},
): Promise<BracketedRun<R>> {
  let kept: BracketedRun<R> | null = null;
  for (let runs = 1; runs <= ROW_ATTEMPTS_MAX; runs++) {
    if (runs > 1) rerun();
    const before = await calibrate();
    const result = await row();
    const after = await calibrate();
    const spread = calibrationSpread(before, after);
    if (kept === null || spread < calibrationSpread(kept.before, kept.after)) kept = { result, before, after, divisor: (before + after) / 2, runs };
    if (spread <= CALIBRATION_SPREAD_MAX) return kept;
  }
  return { ...kept!, runs: ROW_ATTEMPTS_MAX };
}

/** A row's ratio: its ns per evaluation ÷ its divisor, the calibration measured beside it (SP5a Task 43b), to 3 decimals. */
export function ratioOf(rowNs: number, calibNs: number): number {
  return Math.round((rowNs / calibNs) * 1000) / 1000;
}

/**
 * The run's kernels from each row's p50 ns per evaluation (`ns`) and its divisor (`beside`: `measureBracketed`'s mean of
 * the calibrations immediately before and after the row, `calibration.fmix32` beside itself): nsPerEval to 3 decimals
 * and `ratioOf` the two. A row with no calibration beside it throws.
 */
export function benchKernels(ns: Readonly<Record<string, number>>, beside: Readonly<Record<string, number>>): Record<string, BenchKernel> {
  const out: Record<string, BenchKernel> = {};
  for (const [name, v] of Object.entries(ns)) {
    const calib = beside[name];
    if (calib === undefined) throw new Error(`benchKernels: no calibration beside row '${name}'`);
    out[name] = { nsPerEval: Math.round(v * 1000) / 1000, ratio: ratioOf(v, calib) };
  }
  return out;
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
  /** SP4a §9.3: `light.column` and `mesh.section` p50 and p99 (p99 bounds p95 from above). */
  readonly lightP50: number;
  readonly lightP99: number;
  readonly meshP50: number;
  readonly meshP99: number;
  /** SP5a §6.2: `relight.edit` p99 (the upper bound of p95), gated at RELIGHT_P95_MAX_MS. */
  readonly relightP95: number;
}

/**
 * The absolute gates (P1 column budget, SP2a; the real T budget, SP3b; the slice and session commit budgets, SP3d; the
 * light and mesh budgets, SP4a; the relight budget, SP5a): checked by `npm run bench` and before
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
  if (l.lightP50 > LIGHT_P50_MAX_MS) out.push(`light.column p50 ${l.lightP50.toFixed(3)} ms > ${LIGHT_P50_MAX_MS} ms`);
  if (l.lightP99 > LIGHT_P99_MAX_MS) out.push(`light.column p99 ${l.lightP99.toFixed(3)} ms > ${LIGHT_P99_MAX_MS} ms`);
  if (l.meshP50 > MESH_P50_MAX_MS) out.push(`mesh.section p50 ${l.meshP50.toFixed(3)} ms > ${MESH_P50_MAX_MS} ms`);
  if (l.meshP99 > MESH_P99_MAX_MS) out.push(`mesh.section p99 ${l.meshP99.toFixed(3)} ms > ${MESH_P99_MAX_MS} ms`);
  if (l.relightP95 > RELIGHT_P95_MAX_MS) out.push(`relight.edit p99 ${l.relightP95.toFixed(3)} ms > ${RELIGHT_P95_MAX_MS} ms`);
  return out;
}

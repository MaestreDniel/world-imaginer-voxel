import { readFileSync } from 'node:fs';
import { Bench } from 'tinybench';
import { expect, test } from 'vitest';
import {
  absoluteGateFailures, BENCH_ROWS, benchKernels, CALIBRATION_BESIDE_RUN, CALIBRATION_SPREAD_MAX, calibrationSpread, COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, ISLANDS_COLUMNS, ISLANDS_RUN, KILL_RATIO_MAX,
  LIGHT_P50_MAX_MS, LIGHT_P99_MAX_MS, LIGHT_RUN, MESH_P50_MAX_MS, MESH_P99_MAX_MS, MESH_RUN, measureBracketed, P1_MAX_REGRESSION, parseBenchExempt,
  PERSIST_FLUSH_P99_MAX_MS, PERSIST_RUN, ratioOf, RELIGHT_P95_MAX_MS, RELIGHT_RUN, ROW_ATTEMPTS_MAX, SESSION_COMMIT_P50_MAX_MS, SLICE_PART_P50_MAX_MS, SLICE_V128_P50_MAX_MS, TERRAIN_P50_MAX_MS, type Baselines,
} from '../bench/gates';

const base: Baselines = { machine: 'm', node: 'v24', date: '2026-09-27', killRatio: 1.2, kernels: { a: { nsPerEval: 10, ratio: 2 }, b: { nsPerEval: 5, ratio: 1 } } };

test('constants', () => {
  expect([P1_MAX_REGRESSION, KILL_RATIO_MAX]).toEqual([1.3, 1.6]);
  expect([COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, TERRAIN_P50_MAX_MS]).toEqual([0.7, 1.2, 4]);
  // SP3d §9 (master §7): the vertical 128² slice, a slice part at PART_BUDGET, a slider commit with two capped trees.
  expect([SLICE_V128_P50_MAX_MS, SLICE_PART_P50_MAX_MS, SESSION_COMMIT_P50_MAX_MS]).toEqual([300, 250, 4]);
  // SP4a §9.3 (master §7's L and Mesh rows): one light job per column, one non-trivial section's copy and mesh.
  expect([LIGHT_P50_MAX_MS, LIGHT_P99_MAX_MS, MESH_P50_MAX_MS, MESH_P99_MAX_MS]).toEqual([4, 8, 1.0, 2.5]);
  // SP5a §6.2: one edit's relight, p95 ≤ 3 ms (gated through p99).
  expect(RELIGHT_P95_MAX_MS).toBe(3);
  // SP5b §6.2: one flush's synchronous part, p99 ≤ 2 ms.
  expect(PERSIST_FLUSH_P99_MAX_MS).toBe(2);
});

/** Latencies within every absolute gate, at their bounds. */
const AT_GATES = {
  columnP50: 0.7, columnP95: 1.2, terrainP50: 4, sliceV128P50: 300, slicePartP50: 250, sessionCommitP50: 4, islandsP50: 4,
  lightP50: 4, lightP99: 8, meshP50: 1.0, meshP99: 2.5, relightP95: 3, persistFlushP99: 2,
};

test('absolute gates: column p50 / p95 (P1, SP2a) and the real T column p50 (SP3b §10), inclusive', () => {
  expect(absoluteGateFailures(AT_GATES)).toEqual([]);
  expect(absoluteGateFailures({ ...AT_GATES, columnP50: 0.71, columnP95: 1.21, terrainP50: 4.01 })).toEqual([
    'P1 column p50 0.710 ms > 0.7 ms',
    'P1 column p95 1.210 ms > 1.2 ms',
    'terrain.real p50 4.010 ms > 4 ms',
  ]);
  expect(absoluteGateFailures({ ...AT_GATES, columnP50: 0.3, columnP95: 0.5, terrainP50: 4.5 })).toEqual(['terrain.real p50 4.500 ms > 4 ms']);
});

test('absolute gates (SP3d §9): slice.vertical128 ≤ 300 ms, slice.partWorst ≤ 250 ms, session.commitMaxTree ≤ 4 ms p50, inclusive', () => {
  expect(absoluteGateFailures({ ...AT_GATES, sliceV128P50: 300.01, slicePartP50: 250.01, sessionCommitP50: 4.01 })).toEqual([
    'slice.vertical128 p50 300.010 ms > 300 ms',
    'slice.partWorst p50 250.010 ms > 250 ms',
    'session.commitMaxTree p50 4.010 ms > 4 ms',
  ]);
  expect(absoluteGateFailures({ ...AT_GATES, slicePartP50: 251 })).toEqual(['slice.partWorst p50 251.000 ms > 250 ms']);
  expect(absoluteGateFailures({ ...AT_GATES, sliceV128P50: 187, slicePartP50: 65, sessionCommitP50: 0.2 })).toEqual([]);
});

test('absolute gate (SP3e §7): terrain.islands p50 ≤ TERRAIN_P50_MAX_MS (4 ms) on cluster columns, inclusive, after the slice rows', () => {
  expect(absoluteGateFailures({ ...AT_GATES, islandsP50: 3.5 })).toEqual([]);
  expect(absoluteGateFailures({ ...AT_GATES, islandsP50: 4.01 })).toEqual(['terrain.islands p50 4.010 ms > 4 ms']);
  // terrain.real's gate does not cover it: each row has its own line, in the order the gates are listed.
  expect(absoluteGateFailures({ ...AT_GATES, terrainP50: 2.4, islandsP50: 4.5 })).toEqual(['terrain.islands p50 4.500 ms > 4 ms']);
  expect(absoluteGateFailures({ ...AT_GATES, terrainP50: 4.01, slicePartP50: 251, islandsP50: 4.2, sessionCommitP50: 4.01 })).toEqual([
    'terrain.real p50 4.010 ms > 4 ms',
    'slice.partWorst p50 251.000 ms > 250 ms',
    'terrain.islands p50 4.200 ms > 4 ms',
    'session.commitMaxTree p50 4.010 ms > 4 ms',
  ]);
});

test('absolute gates (SP4a §9.3): light.column p50 ≤ 4 ms, p99 ≤ 8 ms; mesh.section p50 ≤ 1.0 ms, p99 ≤ 2.5 ms, inclusive, after the earlier rows', () => {
  expect(absoluteGateFailures({ ...AT_GATES, lightP50: 1.6, lightP99: 3.1, meshP50: 0.2, meshP99: 0.9 })).toEqual([]);
  expect(absoluteGateFailures({ ...AT_GATES, lightP50: 4.01, lightP99: 8.01, meshP50: 1.01, meshP99: 2.51 })).toEqual([
    'light.column p50 4.010 ms > 4 ms',
    'light.column p99 8.010 ms > 8 ms',
    'mesh.section p50 1.010 ms > 1 ms',
    'mesh.section p99 2.510 ms > 2.5 ms',
  ]);
  // Each bound has its own line: a p99 over its gate fails with the p50 under its own.
  expect(absoluteGateFailures({ ...AT_GATES, lightP50: 2, lightP99: 9 })).toEqual(['light.column p99 9.000 ms > 8 ms']);
  expect(absoluteGateFailures({ ...AT_GATES, meshP50: 1.2, meshP99: 2 })).toEqual(['mesh.section p50 1.200 ms > 1 ms']);
  // They follow the earlier rows' lines.
  expect(absoluteGateFailures({ ...AT_GATES, terrainP50: 4.01, sessionCommitP50: 4.01, meshP99: 3 })).toEqual([
    'terrain.real p50 4.010 ms > 4 ms',
    'session.commitMaxTree p50 4.010 ms > 4 ms',
    'mesh.section p99 3.000 ms > 2.5 ms',
  ]);
});

test('absolute gate (SP5a §6.2): relight.edit p99 (relightP95, the upper bound of p95) ≤ 3 ms, inclusive, after the earlier rows', () => {
  expect(absoluteGateFailures({ ...AT_GATES, relightP95: 3.1 })).toEqual(['relight.edit p99 3.100 ms > 3 ms']);
  expect(absoluteGateFailures({ ...AT_GATES, relightP95: 2.9 })).toEqual([]);
  expect(absoluteGateFailures({ ...AT_GATES, meshP99: 3, relightP95: 3.1 })).toEqual(['mesh.section p99 3.000 ms > 2.5 ms', 'relight.edit p99 3.100 ms > 3 ms']);
});

test('absolute gate (SP5b §6.2): a `persist.flush` p99 of 2.1 ms fails `absoluteGateFailures`, 1.9 passes; inclusive, after the earlier rows', () => {
  expect(absoluteGateFailures({ ...AT_GATES, persistFlushP99: 2.1 })).toEqual(['persist.flush p99 2.100 ms > 2 ms']);
  expect(absoluteGateFailures({ ...AT_GATES, persistFlushP99: 1.9 })).toEqual([]);
  expect(absoluteGateFailures({ ...AT_GATES, relightP95: 3.1, persistFlushP99: 2.1 })).toEqual(['relight.edit p99 3.100 ms > 3 ms', 'persist.flush p99 2.100 ms > 2 ms']);
});

test('ratioOf (SP5a Task 43b): a row\'s ns per evaluation ÷ the calibration measured beside it, to 3 decimals', () => {
  expect(ratioOf(22.314, 0.636)).toBe(35.085);
  expect(ratioOf(0.636, 0.636)).toBe(1);
  // The same row read throttled beside a throttled calibration keeps its ratio.
  expect(ratioOf(22.314 * 1.25, 0.636 * 1.25)).toBe(35.085);
});

test('benchKernels (SP5a Task 43b): each row\'s ratio uses the calibration taken beside it, not the first row\'s', () => {
  // The first row is the calibration itself (its own divisor, ratio 1); row a was measured at turbo, row b after the
  // clock dropped by 1.25 ×, each beside its own calibration.
  const ns = { 'calibration.fmix32': 0.64, a: 64, b: 100 };
  const beside = { 'calibration.fmix32': 0.64, a: 0.64, b: 0.8 };
  expect(benchKernels(ns, beside)).toEqual({
    'calibration.fmix32': { nsPerEval: 0.64, ratio: 1 },
    a: { nsPerEval: 64, ratio: 100 },
    b: { nsPerEval: 100, ratio: 125 },
  });
  // Divided by the first row's calibration instead, b would read 156.25 and fail a 1.3 × gate on a baseline of 100.
  expect(gateFailures({ ...base, kernels: { b: { nsPerEval: 64, ratio: 100 } } }, benchKernels(ns, beside), 1.2, [])).toEqual([]);
  expect(gateFailures({ ...base, kernels: { b: { nsPerEval: 64, ratio: 100 } } }, benchKernels(ns, { ...beside, b: 0.64 }), 1.2, [])).toEqual([
    'b: ratio 156.250 > 1.3 × baseline 100.000',
  ]);
  // nsPerEval is rounded to 3 decimals, as before; a row without a calibration beside it throws.
  expect(benchKernels({ a: 1.23456 }, { a: 0.5 })).toEqual({ a: { nsPerEval: 1.235, ratio: 2.469 } });
  expect(() => benchKernels({ a: 1, c: 2 }, { a: 1 })).toThrow(/no calibration beside row 'c'/);
});

test('CALIBRATION_BESIDE_RUN (SP5a Task 43b): about 120 ms of fmix32 before each row (20 ms warm-up, 100 ms timed)', () => {
  expect(CALIBRATION_BESIDE_RUN).toEqual({ time: 100, warmupTime: 20 });
});

test('calibrationSpread and the bracket constants (SP5a Task 43b review I2): the larger calibration over the smaller, minus 1', () => {
  expect([CALIBRATION_SPREAD_MAX, ROW_ATTEMPTS_MAX]).toEqual([0.05, 3]);
  expect(calibrationSpread(0.8, 0.8)).toBe(0);
  expect(calibrationSpread(0.8, 0.84)).toBeCloseTo(0.05, 12);
  expect(calibrationSpread(0.84, 0.8)).toBeCloseTo(0.05, 12);
  // Task 43b's v1 slice.horizontal128: turbo before the row, throttled after it.
  expect(calibrationSpread(0.637, 0.796)).toBeGreaterThan(CALIBRATION_SPREAD_MAX);
});

/** A fake bracket: each calibrate() returns the next calibration; each row() logs its run and returns the next result. */
function fakeBracket(calibs: readonly number[], results: readonly number[]) {
  const log: string[] = [];
  let c = 0;
  let r = 0;
  return {
    log,
    calibrate: async (): Promise<number> => { log.push('calibrate'); return calibs[c++]!; },
    row: async (): Promise<number> => { log.push('row'); return results[r++]!; },
    rerun: (): void => { log.push('rerun'); },
  };
}

test('measureBracketed (SP5a Task 43b review I2): a calibration before and after the row; agreeing within 5 %, the row runs once and divides by their mean', async () => {
  const f = fakeBracket([0.636, 0.64], [100]);
  expect(await measureBracketed(f.calibrate, f.row, f.rerun)).toEqual({ result: 100, before: 0.636, after: 0.64, divisor: expect.closeTo(0.638, 12), runs: 1 });
  expect(f.log).toEqual(['calibrate', 'row', 'calibrate']);
  // Without a rerun hook it runs the same way.
  const g = fakeBracket([0.636, 0.64], [100]);
  expect((await measureBracketed(g.calibrate, g.row)).runs).toBe(1);
});

test('measureBracketed (SP5a Task 43b review I2): a row that straddles the turbo drop runs again, after its rerun hook, and keeps the agreeing run', async () => {
  // Task 43b's v1 slice.horizontal128: p50 631 ms, throttled, between a turbo 0.637 and a throttled 0.796. Read again at
  // the steady throttled clock (624 ms between 0.786 and 0.79), its ratio is the record's (624 ms beside 0.786).
  const f = fakeBracket([0.637, 0.796, 0.786, 0.79], [631, 624]);
  const m = await measureBracketed(f.calibrate, f.row, f.rerun);
  expect(m).toEqual({ result: 624, before: 0.786, after: 0.79, divisor: expect.closeTo(0.788, 12), runs: 2 });
  expect(f.log).toEqual(['calibrate', 'row', 'calibrate', 'rerun', 'calibrate', 'row', 'calibrate']);
  const baselineRatio = ratioOf(624, 0.786);
  const kernels = benchKernels({ h: m.result }, { h: m.divisor });
  expect(kernels['h']!.ratio / baselineRatio).toBeCloseTo(0.997, 3);
  expect(gateFailures({ ...base, kernels: { h: { nsPerEval: 624, ratio: baselineRatio } } }, kernels, 1.2, [])).toEqual([]);
  // Divided by the calibration before it alone, the straddling run read 1.248 × that baseline.
  expect(ratioOf(631, 0.637) / baselineRatio).toBeCloseTo(1.248, 3);
  // A transient slow calibration (Task 43b's v1 session.commitMaxTree: 0.959 before a throttled row, which read 0.810 ×)
  // runs the row again too, rather than hiding a regression behind a large divisor.
  const t = fakeBracket([0.959, 0.78, 0.782, 0.78], [3.4, 3.42]);
  expect(await measureBracketed(t.calibrate, t.row, t.rerun)).toEqual({ result: 3.42, before: 0.782, after: 0.78, divisor: expect.closeTo(0.781, 12), runs: 2 });
});

test('measureBracketed (SP5a Task 43b review I2): after ROW_ATTEMPTS_MAX runs that never agree, the run with the smallest spread', async () => {
  const f = fakeBracket([0.6, 0.8, 0.7, 0.77, 0.65, 0.8], [1, 2, 3]);
  expect(await measureBracketed(f.calibrate, f.row, f.rerun)).toEqual({ result: 2, before: 0.7, after: 0.77, divisor: expect.closeTo(0.735, 12), runs: 3 });
  expect(f.log.filter((s) => s === 'row')).toHaveLength(ROW_ATTEMPTS_MAX);
  expect(f.log.filter((s) => s === 'rerun')).toHaveLength(ROW_ATTEMPTS_MAX - 1);
});

test('no baseline: only the kill criterion gates', () => {
  expect(gateFailures(null, { a: { nsPerEval: 99, ratio: 9 } }, 1.5, [])).toEqual([]);
  expect(gateFailures(null, {}, 1.61, [])).toEqual(['kill criterion: lattice3/perm512 = 1.610 > 1.6']);
});

test('P1: a kernel ratio above 1.3 × its baseline fails; new kernels are ignored', () => {
  expect(gateFailures(base, { a: { nsPerEval: 12, ratio: 2.6 }, b: { nsPerEval: 6, ratio: 1.31 }, c: { nsPerEval: 1, ratio: 9 } }, 1.2, [])).toEqual([
    'b: ratio 1.310 > 1.3 × baseline 1.000',
  ]);
});

test('BENCH_EXEMPT (SP3c §7): an exempt row skips its ratio gate and is printed; the kill criterion never is', () => {
  const kernels = { a: { nsPerEval: 12, ratio: 2.7 }, b: { nsPerEval: 6, ratio: 1.31 }, c: { nsPerEval: 1, ratio: 9 } };
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); };
  expect(gateFailures(base, kernels, 1.2, ['a'], log)).toEqual(['b: ratio 1.310 > 1.3 × baseline 1.000']);
  expect(lines).toEqual(['a: exempt, ratio 2.700 vs baseline 2.000']);
  lines.length = 0;
  expect(gateFailures(base, kernels, 1.2, ['a', 'b'], log)).toEqual([]);
  expect(lines).toEqual(['a: exempt, ratio 2.700 vs baseline 2.000', 'b: exempt, ratio 1.310 vs baseline 1.000']);
  // A row within its gate is printed too when exempt; an exempt row with no baseline is skipped as any new row.
  lines.length = 0;
  expect(gateFailures(base, { a: { nsPerEval: 10, ratio: 2 }, c: { nsPerEval: 1, ratio: 9 } }, 1.2, ['a', 'c'], log)).toEqual([]);
  expect(lines).toEqual(['a: exempt, ratio 2.000 vs baseline 2.000']);
  // The kill criterion is never exempt (exempting its rows changes nothing), with or without a baseline.
  lines.length = 0;
  expect(gateFailures(base, kernels, 1.61, ['a', 'b', 'lattice3.slice', 'perm512.slice'], log)).toEqual(['kill criterion: lattice3/perm512 = 1.610 > 1.6']);
  expect(gateFailures(null, kernels, 1.61, ['a', 'b'], log)).toEqual(['kill criterion: lattice3/perm512 = 1.610 > 1.6']);
  // An empty list keeps the plain gate; nothing is printed.
  lines.length = 0;
  expect(gateFailures(base, kernels, 1.2, [], log)).toEqual(['a: ratio 2.700 > 1.3 × baseline 2.000', 'b: ratio 1.310 > 1.3 × baseline 1.000']);
  expect(lines).toEqual([]);
});

test('parseBenchExempt: a comma-separated list of BENCH_ROWS names, empty when unset; an unknown name throws', () => {
  expect(parseBenchExempt(undefined)).toEqual([]);
  expect(parseBenchExempt('')).toEqual([]);
  expect(parseBenchExempt('terrain.real')).toEqual(['terrain.real']);
  expect(parseBenchExempt(' terrain.real , surface.column ')).toEqual(['terrain.real', 'surface.column']);
  expect(parseBenchExempt('terrain.real,terrain.real')).toEqual(['terrain.real']);
  expect(() => parseBenchExempt('terrain.rel')).toThrow(/BENCH_EXEMPT: unknown bench row 'terrain\.rel'/);
  expect(() => parseBenchExempt('terrain.real,')).toThrow(/BENCH_EXEMPT: empty entry/);
  expect(() => parseBenchExempt('kill')).toThrow(/unknown bench row/);
  // The rows themselves, in BENCH_ROWS order or not, are all accepted.
  expect(parseBenchExempt([...BENCH_ROWS].reverse().join(','))).toEqual([...BENCH_ROWS].reverse());
});

test('the bench rows: SP1 to SP2b, the SP3a store row, the SP3b density corner and real T rows, SP3c surface.column, SP3d\'s slice and session rows, SP3e\'s terrain.islands, SP4a\'s light.column and mesh.section, SP5a\'s relight.edit, then SP5b\'s persist.flush', () => {
  expect(BENCH_ROWS).toEqual([
    'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
    'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
    'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
    'store.alloc', 'density.corner', 'terrain.real', 'surface.column',
    'slice.vertical128', 'slice.horizontal128', 'slice.partWorst', 'session.commitMaxTree', 'terrain.islands',
    'light.column', 'mesh.section', 'relight.edit', 'persist.flush',
  ]);
  expect(BENCH_ROWS.slice(-4)).toEqual(['light.column', 'mesh.section', 'relight.edit', 'persist.flush']);
  expect(BENCH_ROWS).not.toContain('terrain.provisional');
  expect(new Set(BENCH_ROWS).size).toBe(BENCH_ROWS.length);
});

test('`BENCH_ROWS` ends `\'relight.edit\', \'persist.flush\'` (SP5b §6.2 appends one flush\'s synchronous part)', () => {
  expect(BENCH_ROWS.slice(-2)).toEqual(['relight.edit', 'persist.flush']);
});

test('test/baselines.json records every bench row, so none is silently ungated', () => {
  const baseline = JSON.parse(readFileSync(new URL('../baselines.json', import.meta.url), 'utf8')) as Baselines;
  expect(Object.keys(baseline.kernels)).toEqual([...BENCH_ROWS]);
  for (const [name, k] of Object.entries(baseline.kernels)) {
    expect(k.nsPerEval, name).toBeGreaterThan(0);
    expect(k.ratio, name).toBeGreaterThan(0);
  }
  expect(baseline.kernels['calibration.fmix32']!.ratio).toBe(1);
});

/** Calls of a ≈ 0.8 ms busy function under tinybench's Bench built as vitest's bench provider builds it (options spread). */
async function benchCalls(options: Record<string, number>): Promise<number> {
  let calls = 0;
  const b = new Bench({ ...options });
  b.add('busy', () => {
    calls++;
    const t = performance.now();
    while (performance.now() - t < 0.8) { /* busy */ }
  });
  await b.run();
  return calls;
}

test('terrain.islands run options (SP3e §7): exactly one warm-up call, so its 258 calls never pass the 512 precomputed columns', async () => {
  expect(ISLANDS_RUN).toEqual({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
  expect(ISLANDS_COLUMNS).toBe(512);
  // A column about 4 × faster than this machine's 3.5 ms: tinybench's probe call when the function is added (does it
  // return a promise?), one warm-up call and the 256 timed ones.
  const calls = await benchCalls(ISLANDS_RUN);
  expect(calls).toBe(258);
  expect(calls).toBeLessThanOrEqual(ISLANDS_COLUMNS);
  // Without warmupTime, tinybench warms up for 250 ms: far more than one call (about 310 at 0.8 ms on a quiet machine,
  // which took the row's index past its 512 columns).
  expect(await benchCalls({ iterations: 256, time: 0, warmupIterations: 1 })).toBeGreaterThan(258 + 50);
}, 30_000);

test('light.column and mesh.section run options (SP4a §9.3): one probe, one warm-up and 256 or 1024 timed calls', async () => {
  expect(LIGHT_RUN).toEqual({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
  expect(MESH_RUN).toEqual({ iterations: 1024, time: 0, warmupIterations: 1, warmupTime: 0 });
  // The row walks its 256 columns (1024 sections) cyclically: the probe and the warm-up take the first two, which the
  // last two timed calls then take again, so each is timed exactly once.
  expect(await benchCalls(LIGHT_RUN)).toBe(1 + 1 + 256);
  expect(await benchCalls(MESH_RUN)).toBe(1 + 1 + 1024);
}, 30_000);

test('persist.flush run options (SP5b §6.2): one probe, one warm-up and 256 timed calls', async () => {
  expect(PERSIST_RUN).toEqual({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
  expect(await benchCalls(PERSIST_RUN)).toBe(1 + 1 + 256);
}, 30_000);

test('relight.edit run options (SP5a §6.2): one probe, one warm-up and 256 timed calls, 43 turns of its 6-edit cycle', async () => {
  expect(RELIGHT_RUN).toEqual({ iterations: 256, time: 0, warmupIterations: 1, warmupTime: 0 });
  const calls = await benchCalls(RELIGHT_RUN);
  expect(calls).toBe(1 + 1 + 256);
  // The cycle (torch place, torch break, stone place, stone break, shaft open, shaft close) ends where it began.
  expect(calls % 6).toBe(0);
}, 30_000);

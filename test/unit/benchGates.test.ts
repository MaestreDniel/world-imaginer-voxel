import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  absoluteGateFailures, BENCH_ROWS, COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, gateFailures, KILL_RATIO_MAX, P1_MAX_REGRESSION, TERRAIN_P50_MAX_MS,
  type Baselines,
} from '../bench/gates';

const base: Baselines = { machine: 'm', node: 'v24', date: '2026-09-27', killRatio: 1.2, kernels: { a: { nsPerEval: 10, ratio: 2 }, b: { nsPerEval: 5, ratio: 1 } } };

test('constants', () => {
  expect([P1_MAX_REGRESSION, KILL_RATIO_MAX]).toEqual([1.3, 1.6]);
  expect([COLUMN_P50_MAX_MS, COLUMN_P95_MAX_MS, TERRAIN_P50_MAX_MS]).toEqual([0.7, 1.2, 4]);
});

test('absolute gates: column p50 / p95 (P1, SP2a) and the real T column p50 (SP3b §10), inclusive', () => {
  expect(absoluteGateFailures({ columnP50: 0.7, columnP95: 1.2, terrainP50: 4 })).toEqual([]);
  expect(absoluteGateFailures({ columnP50: 0.71, columnP95: 1.21, terrainP50: 4.01 })).toEqual([
    'P1 column p50 0.710 ms > 0.7 ms',
    'P1 column p95 1.210 ms > 1.2 ms',
    'terrain.real p50 4.010 ms > 4 ms',
  ]);
  expect(absoluteGateFailures({ columnP50: 0.3, columnP95: 0.5, terrainP50: 4.5 })).toEqual(['terrain.real p50 4.500 ms > 4 ms']);
});

test('no baseline: only the kill criterion gates', () => {
  expect(gateFailures(null, { a: { nsPerEval: 99, ratio: 9 } }, 1.5)).toEqual([]);
  expect(gateFailures(null, {}, 1.61)).toEqual(['kill criterion: lattice3/perm512 = 1.610 > 1.6']);
});

test('P1: a kernel ratio above 1.3 × its baseline fails; new kernels are ignored', () => {
  expect(gateFailures(base, { a: { nsPerEval: 12, ratio: 2.6 }, b: { nsPerEval: 6, ratio: 1.31 }, c: { nsPerEval: 1, ratio: 9 } }, 1.2)).toEqual([
    'b: ratio 1.310 > 1.3 × baseline 1.000',
  ]);
});

test('the bench rows: SP1 to SP2b, the SP3a store row, then the SP3b density corner and real T rows (SP3b §10)', () => {
  expect(BENCH_ROWS).toEqual([
    'calibration.fmix32', 'lattice3.slice', 'perm512.slice', 'lattice3.random', 'perm512.random', 'normal.z2.climateC',
    'normal.z3.density3d', 'spline.offset', 'spline.mix3', 'detErf', 'stageHashes.genKey', 'column.point', 'column.sample',
    'map.tile.b64.biome', 'map.tile.b16.relief', 'worker.configure', 'map.tile.b256.biome', 'map.tile.b256.relief',
    'store.alloc', 'density.corner', 'terrain.real',
  ]);
  expect(BENCH_ROWS).not.toContain('terrain.provisional');
  expect(new Set(BENCH_ROWS).size).toBe(BENCH_ROWS.length);
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

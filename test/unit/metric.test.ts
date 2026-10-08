import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { coverageErrors, evaluateMetric, metricTest, type MetricEnv } from '../harness/metric';
import type { ThresholdTable } from '../thresholds';

const table: ThresholdTable = {
  C1: { default: { min: 0.05, max: 0.15, activeFrom: 'SP6' }, cave_heavy: { min: 0.1, max: 0.22, activeFrom: 'SP12' } },
};

describe('evaluateMetric', () => {
  test('active parts are asserted, inactive parts only recorded', () => {
    const r = evaluateMetric('C1', ['default', 'cave_heavy'], { default: 0.09, cave_heavy: 0.5 }, table, ['SP6']);
    expect(r).toEqual({ asserted: ['default'], inactive: ['cave_heavy'], otherTier: [], errors: [] });
  });

  test('an active part outside its range fails', () => {
    const r = evaluateMetric('C1', ['default'], { default: 0.2 }, table, ['SP6']);
    expect(r.errors).toEqual(['C1.default = 0.2 > max 0.15']);
  });

  test('a part with tiers is gated only on its listed tiers and recorded elsewhere (SP3b: T3 on full only)', () => {
    const tiered: ThresholdTable = { T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: ['full'] } } };
    for (const tier of ['fast', 'quick'] as const) {
      expect(evaluateMetric('T3', ['value'], { value: 9 }, tiered, ['SP3b'], tier)).toEqual(
        { asserted: [], inactive: [], otherTier: ['value'], errors: [] },
      );
    }
    expect(evaluateMetric('T3', ['value'], { value: 9 }, tiered, ['SP3b'], 'full')).toEqual(
      { asserted: ['value'], inactive: [], otherTier: [], errors: ['T3.value = 9 > max 1.5'] },
    );
    expect(evaluateMetric('T3', ['value'], { value: 1.2 }, tiered, ['SP3b'], 'full').errors).toEqual([]);
    // Off-tier parts still need their value, and an inactive part stays inactive whatever its tiers.
    expect(evaluateMetric('T3', ['value'], {}, tiered, ['SP3b'], 'fast').errors).toEqual(['T3.value: no value returned']);
    expect(evaluateMetric('T3', ['value'], { value: 9 }, tiered, ['SP3a'], 'full')).toEqual(
      { asserted: [], inactive: ['value'], otherTier: [], errors: [] },
    );
  });

  test('a part without tiers is gated on every tier', () => {
    for (const tier of ['fast', 'quick', 'full'] as const) {
      expect(evaluateMetric('C1', ['default'], { default: 0.2 }, table, ['SP6'], tier).errors).toEqual(['C1.default = 0.2 > max 0.15']);
    }
  });

  test('a NaN value fails a gated part (it would pass both min and max), and is only recorded on an ungated one', () => {
    expect(evaluateMetric('C1', ['default'], { default: NaN }, table, ['SP6']).errors).toEqual(['C1.default = NaN (not a number)']);
    const tiered: ThresholdTable = { T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: ['full'] } } };
    expect(evaluateMetric('T3', ['value'], { value: NaN }, tiered, ['SP3b'], 'full').errors).toEqual(['T3.value = NaN (not a number)']);
    expect(evaluateMetric('T3', ['value'], { value: NaN }, tiered, ['SP3b'], 'fast').errors).toEqual([]);
    expect(evaluateMetric('C1', ['cave_heavy'], { cave_heavy: NaN }, table, ['SP6']).errors).toEqual([]);
    // ±Infinity still fails on its bound only (T3 writes Infinity for "no expected steep pairs").
    expect(evaluateMetric('T3', ['value'], { value: Infinity }, tiered, ['SP3b'], 'full').errors).toEqual(['T3.value = Infinity > max 1.5']);
  });

  test('missing values and unknown parts are errors', () => {
    expect(evaluateMetric('C1', ['default'], {}, table, ['SP6']).errors).toEqual(['C1.default: no value returned']);
    expect(evaluateMetric('C1', ['nope'], { nope: 1 }, table, ['SP6']).errors).toEqual(['C1.nope: not in THRESHOLDS']);
  });
});

describe('metricTest: a soft failure is never skipped away (SP3b spec §8.1: "never passes silently")', () => {
  // T3 gates on full only, so on fast its only part is off-tier and metricTest skips the test. In vitest 5 a skip
  // replaces the result and drops the errors expect.soft recorded (requireSample's "insufficient sample").
  const tiered: ThresholdTable = { T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: ['full'] } } };
  const outDir = mkdtempSync(join(tmpdir(), 'wi10-metric-'));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));
  const env = (register: MetricEnv['register']): MetricEnv => ({ register, table: tiered, started: ['SP3b'], tier: 'fast', outDir });

  // An expected failure: vitest reports it passed only when the metric test itself failed.
  metricTest('T3', ['value'], () => {
    expect.soft(1, 'T3 lowland border pairs: insufficient sample (1 < 2000)').toBeGreaterThanOrEqual(2000);
    return { value: 9 };
  }, 10_000, env(test.fails));
  // The same off-tier metric without a soft failure is still skipped (value recorded).
  metricTest('T3', ['value'], () => ({ value: 9 }), 10_000, env(test));

  test('the off-tier metric with a soft failure failed; the clean one was skipped', (ctx) => {
    const [failing, clean] = ctx.task.suite!.tasks.filter((t) => t.name === 'T3');
    expect(failing?.result?.state, 'the soft failure was reported (test.fails inverts it to pass)').toBe('pass');
    expect(clean?.result?.state).toBe('skip');
  });
});

describe('MetricEnv.outName (SP3c spec §5.2): two calls for one id write their own .out files', () => {
  // SP3c registers B4's and B2's voxel parts with a second metricTest call each; `outName` keeps the 2D record.
  const rows: ThresholdTable = {
    B4: { coastBandBeach: { min: 0.7, activeFrom: 'SP2a' }, coastBandBeachVoxel: { min: 0.7, activeFrom: 'SP3c' } },
  };
  const outDir = mkdtempSync(join(tmpdir(), 'wi10-metric-out-'));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));
  const env = (outName?: string): MetricEnv => ({ table: rows, started: ['SP2a', 'SP3c'], tier: 'fast', outDir, ...(outName === undefined ? {} : { outName }) });

  metricTest('B4', ['coastBandBeach'], () => ({ coastBandBeach: 0.8 }), 10_000, env());
  metricTest('B4', ['coastBandBeachVoxel'], () => ({ coastBandBeachVoxel: 0.9 }), 10_000, env('B4.voxel'));

  test('the default name is the id; outName names the second record, which keeps the id inside', () => {
    const read = (name: string): { id: string; values: Record<string, number> } => JSON.parse(readFileSync(join(outDir, `${name}.json`), 'utf8'));
    expect(read('B4')).toMatchObject({ id: 'B4', values: { coastBandBeach: 0.8 } });
    expect(read('B4.voxel')).toMatchObject({ id: 'B4', values: { coastBandBeachVoxel: 0.9 } });
    expect(read('B4').values).not.toHaveProperty('coastBandBeachVoxel');
    expect(existsSync(join(outDir, 'B4.voxel.json'))).toBe(true);
  });
});

describe('coverageErrors', () => {
  test('every active part needs exactly one registering call', () => {
    expect(coverageErrors([], table, ['SP6'])).toEqual(['C1.default is active but no metricTest covers it']);
    const call = { file: 'a.metric.ts', id: 'C1', parts: ['default'] };
    expect(coverageErrors([call], table, ['SP6'])).toEqual([]);
    expect(coverageErrors([call, call], table, ['SP6'])).toEqual(['C1: 2 metricTest calls write .out/C1.json', 'C1.default is covered by 2 metricTest calls']);
  });

  test('two calls writing one .out file (same outName, the id by default) are an error, even over disjoint parts', () => {
    const rows: ThresholdTable = { B4: { a: { min: 0, activeFrom: 'SP2a' }, b: { min: 0, activeFrom: 'SP3c' } } };
    const a = { file: 'biomes.metric.ts', id: 'B4', parts: ['a'] };
    const b = { file: 'surface.metric.ts', id: 'B4', parts: ['b'] };
    expect(coverageErrors([a, b], rows, ['SP2a', 'SP3c'])).toEqual(['B4: 2 metricTest calls write .out/B4.json']);
    expect(coverageErrors([a, { ...b, outName: 'B4' }], rows, ['SP2a', 'SP3c'])).toEqual(['B4: 2 metricTest calls write .out/B4.json']);
    expect(coverageErrors([a, { ...b, outName: 'B4.voxel' }], rows, ['SP2a', 'SP3c'])).toEqual([]);
  });

  test('a tier-restricted part still needs exactly one call; its tiers must be a non-empty subset of the tiers', () => {
    const call = { file: 'a.metric.ts', id: 'T3', parts: ['value'] };
    const row = (tiers: readonly string[]): ThresholdTable => ({ T3: { value: { max: 1.5, activeFrom: 'SP3b', tiers: tiers as never } } });
    expect(coverageErrors([], row(['full']), ['SP3b'])).toEqual(['T3.value is active but no metricTest covers it']);
    expect(coverageErrors([call], row(['full']), ['SP3b'])).toEqual([]);
    expect(coverageErrors([call], row([]), ['SP3b'])).toEqual(['T3.value: tiers [] (a non-empty subset of fast, quick, full)']);
    expect(coverageErrors([call], row(['full', 'nightly']), ['SP3b'])).toEqual(['T3.value: tiers [full, nightly] (a non-empty subset of fast, quick, full)']);
    expect(coverageErrors([call], row(['full', 'full']), ['SP3b'])).toEqual(['T3.value: tiers [full, full] (a non-empty subset of fast, quick, full)']);
  });

  test('calls naming unknown ids or parts are errors', () => {
    expect(coverageErrors([{ file: 'a.metric.ts', id: 'C9', parts: ['x'] }], table, [])).toEqual([
      'a.metric.ts: C9 is not in THRESHOLDS',
    ]);
  });
});

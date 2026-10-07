import { describe, expect, test } from 'vitest';
import { coverageErrors, evaluateMetric } from '../harness/metric';
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

  test('missing values and unknown parts are errors', () => {
    expect(evaluateMetric('C1', ['default'], {}, table, ['SP6']).errors).toEqual(['C1.default: no value returned']);
    expect(evaluateMetric('C1', ['nope'], { nope: 1 }, table, ['SP6']).errors).toEqual(['C1.nope: not in THRESHOLDS']);
  });
});

describe('coverageErrors', () => {
  test('every active part needs exactly one registering call', () => {
    expect(coverageErrors([], table, ['SP6'])).toEqual(['C1.default is active but no metricTest covers it']);
    const call = { file: 'a.metric.ts', id: 'C1', parts: ['default'] };
    expect(coverageErrors([call], table, ['SP6'])).toEqual([]);
    expect(coverageErrors([call, call], table, ['SP6'])).toEqual(['C1.default is covered by 2 metricTest calls']);
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

import { describe, expect, test } from 'vitest';
import { coverageErrors, evaluateMetric } from '../harness/metric';
import type { ThresholdTable } from '../thresholds';

const table: ThresholdTable = {
  C1: { default: { min: 0.05, max: 0.15, activeFrom: 'SP6' }, cave_heavy: { min: 0.1, max: 0.22, activeFrom: 'SP12' } },
};

describe('evaluateMetric', () => {
  test('active parts are asserted, inactive parts only recorded', () => {
    const r = evaluateMetric('C1', ['default', 'cave_heavy'], { default: 0.09, cave_heavy: 0.5 }, table, ['SP6']);
    expect(r).toEqual({ asserted: ['default'], inactive: ['cave_heavy'], errors: [] });
  });

  test('an active part outside its range fails', () => {
    const r = evaluateMetric('C1', ['default'], { default: 0.2 }, table, ['SP6']);
    expect(r.errors).toEqual(['C1.default = 0.2 > max 0.15']);
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

  test('calls naming unknown ids or parts are errors', () => {
    expect(coverageErrors([{ file: 'a.metric.ts', id: 'C9', parts: ['x'] }], table, [])).toEqual([
      'a.metric.ts: C9 is not in THRESHOLDS',
    ]);
  });
});

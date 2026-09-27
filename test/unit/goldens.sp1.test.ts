import { describe, expect, test } from 'vitest';
import { compareGoldens, computeGolden, goldenKeys } from '../../src/metrics/sp1Goldens';
import { expectGolden } from '../harness/goldens';

test('27 unique keys: 6 detMath, 16 noise fixtures, 4 splines, 1 params', () => {
  const keys = goldenKeys();
  expect(keys.length).toBe(27);
  expect(new Set(keys).size).toBe(27);
  expect(keys.filter((k) => k.startsWith('sp1.detMath.')).length).toBe(6);
  expect(keys.filter((k) => k.startsWith('sp1.noise.')).length).toBe(16);
  expect(keys.filter((k) => k.startsWith('sp1.spline.')).length).toBe(4);
  expect(keys).toContain('sp1.params');
  expect(computeGolden('sp1.params')).toMatch(/^[0-9a-f]{16}$/);
  expect(() => computeGolden('sp1.nope')).toThrow(/unknown golden/);
});

describe('SP1 goldens', () => {
  test.each(goldenKeys())('%s', (key) => {
    expectGolden(key, computeGolden(key));
  });
});

test('compareGoldens reports matches, mismatches and missing keys', () => {
  expect(compareGoldens({ a: '1', b: '2' }, ['a', 'b', 'c'], (k) => (k === 'b' ? '3' : '1'))).toEqual([
    { key: 'a', expected: '1', actual: '1', ok: true },
    { key: 'b', expected: '2', actual: '3', ok: false },
    { key: 'c', expected: null, actual: '1', ok: false },
  ]);
});

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DETMATH_FNS, detMathDigest, detMathInputs } from '../../src/metrics/sp1Goldens';

test('input streams: 2^20 draws plus the specials, sin/cos alternate their two ranges', () => {
  const sin = detMathInputs('detSin');
  expect(sin.length).toBe((1 << 20) + 13 + 5);
  expect(Math.abs(sin[0]!)).toBeLessThan(64);
  expect(Object.is(sin[(1 << 20) + 1], -0)).toBe(true);
  expect(detMathInputs('detSmoothstep').length).toBe((1 << 20) + 13);
});

test('T-DM6 detMath digests equal the CPython oracle', () => {
  const oracle = JSON.parse(readFileSync(new URL('../fixtures/detmath-oracle.json', import.meta.url), 'utf8')) as Record<string, string>;
  expect(Object.keys(oracle)).toEqual([...DETMATH_FNS]);
  for (const fn of DETMATH_FNS) expect(detMathDigest(fn), fn).toBe(oracle[fn]);
});

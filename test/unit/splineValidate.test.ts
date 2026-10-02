import { describe, expect, test } from 'vitest';
import { q15 } from '../../src/core/params/canonical';
import { compileSpline, evalSpline, evalSplineRef } from '../../src/core/spline/hermite';
import { SPLINE_COORDS, SPLINE_MAX_ABS_D, SPLINE_MAX_ABS_X, type NestedSpline, type SplineCoord, type SplineOpts } from '../../src/core/spline/types';
import { normalizeSpline, SplineValidationError, validateSpline } from '../../src/core/spline/validate';
import { testFloat, testRng } from '../harness/stats';

const P = (x: number, y: number | NestedSpline, d = 0) => ({ x, y, d });
const ok: NestedSpline = { coord: 'C', points: [P(-1, 16), P(0, { coord: 'E', points: [P(-1, 70), P(1, 63)] }), P(1, 20)] };
const brief = (v: unknown, opts: SplineOpts = {}) => validateSpline(v, 'shape.offset', opts).map((i) => `${i.code} @ ${i.path}`);

describe('validateSpline', () => {
  test('a valid nested spline has no issues', () => {
    expect(validateSpline(ok)).toEqual([]);
    expect(validateSpline({ coord: 'H', points: [P(0.3, 1)] })).toEqual([]);
  });
  const cases: Array<{ name: string; value: unknown; expected: string[]; opts?: SplineOpts }> = [
    { name: 'not an object', value: 5, expected: ['NOT_OBJECT @ shape.offset'] },
    { name: 'unknown spline key', value: { coord: 'C', points: [P(0, 1)], pts: [] }, expected: ['UNKNOWN_KEY @ shape.offset.pts'] },
    { name: 'bad coord', value: { coord: 'Q', points: [P(0, 1)] }, expected: ['BAD_COORD @ shape.offset.coord'] },
    { name: 'coord not allowed by the leaf', value: { coord: 'T', points: [P(0, 1)] }, expected: ['BAD_COORD @ shape.offset.coord'], opts: { coords: ['C', 'E'] } },
    { name: 'coord reused', value: { coord: 'C', points: [P(0, { coord: 'C', points: [P(0, 1)] })] }, expected: ['COORD_REUSED @ shape.offset.points[0].y.coord'] },
    { name: 'points not an array', value: { coord: 'C', points: 3 }, expected: ['POINTS_NOT_ARRAY @ shape.offset.points'] },
    { name: 'empty', value: { coord: 'C', points: [] }, expected: ['EMPTY @ shape.offset.points'] },
    { name: 'too many points', value: { coord: 'C', points: Array.from({ length: 33 }, (_, i) => P(i / 16 - 1, 0)) }, expected: ['TOO_MANY_POINTS @ shape.offset.points'] },
    { name: 'point not an object', value: { coord: 'C', points: [7] }, expected: ['POINT_NOT_OBJECT @ shape.offset.points[0]'] },
    { name: 'unknown point key', value: { coord: 'C', points: [{ x: 0, y: 1, d: 0, tangent: 1 }] }, expected: ['UNKNOWN_KEY @ shape.offset.points[0].tangent'] },
    { name: 'x not finite', value: { coord: 'C', points: [{ x: 'a', y: 1, d: 0 }] }, expected: ['X_NOT_FINITE @ shape.offset.points[0].x'] },
    { name: 'd missing', value: { coord: 'C', points: [{ x: 0, y: 1 }] }, expected: ['D_NOT_FINITE @ shape.offset.points[0].d'] },
    { name: 'y not finite', value: { coord: 'C', points: [P(0, Infinity)] }, expected: ['Y_NOT_FINITE @ shape.offset.points[0].y'] },
    { name: 'y out of range', value: { coord: 'C', points: [P(0, 999)] }, expected: ['Y_OUT_OF_RANGE @ shape.offset.points[0].y'], opts: { yMin: -64, yMax: 320 } },
    { name: 'y bad type', value: { coord: 'C', points: [{ x: 0, y: 'z', d: 0 }] }, expected: ['Y_BAD_TYPE @ shape.offset.points[0].y'] },
    { name: 'x duplicate after q15', value: { coord: 'C', points: [P(0.1 + 0.2, 1), P(0.3, 2)] }, expected: ['X_DUPLICATE @ shape.offset.points[1].x'] },
    { name: 'x unsorted', value: { coord: 'C', points: [P(0.5, 1), P(0.2, 2)] }, expected: ['X_UNSORTED @ shape.offset.points[1].x'] },
    { name: 'x beyond 2', value: { coord: 'C', points: [P(-2.5, 1), P(2, 2)] }, expected: ['X_OUT_OF_RANGE @ shape.offset.points[0].x'] },
    { name: 'x beyond 2 after q15', value: { coord: 'C', points: [P(0, 1), P(2.00000000000001, 2)] }, expected: ['X_OUT_OF_RANGE @ shape.offset.points[1].x'] },
    { name: 'x beyond 2 in a nested spline', value: { coord: 'C', points: [P(0, { coord: 'E', points: [P(-1, 1), P(3, 2)] })] }, expected: ['X_OUT_OF_RANGE @ shape.offset.points[0].y.points[1].x'] },
    { name: 'x out of range and unsorted', value: { coord: 'C', points: [P(1, 1), P(-7, 2)] }, expected: ['X_OUT_OF_RANGE @ shape.offset.points[1].x', 'X_UNSORTED @ shape.offset.points[1].x'] },
    { name: 'd beyond 1e5', value: { coord: 'C', points: [P(0, 1, 100000.5)] }, expected: ['D_OUT_OF_RANGE @ shape.offset.points[0].d'] },
    { name: 'd beyond −1e5 in a nested spline', value: { coord: 'C', points: [P(0, { coord: 'E', points: [P(0, 1, -1e6)] })] }, expected: ['D_OUT_OF_RANGE @ shape.offset.points[0].y.points[0].d'] },
  ];
  test.each(cases)('$name', ({ value, expected, opts }) => {
    expect(brief(value, opts)).toEqual(expected);
  });
  test('program too large (more than 4096 spline objects)', () => {
    const pv = { coord: 'PV' as const, points: [P(0, 1)] };
    const w = { coord: 'W' as const, points: Array.from({ length: 4 }, (_, k) => P(k / 4, pv)) };
    const e = { coord: 'E' as const, points: Array.from({ length: 32 }, (_, j) => P(j / 16 - 1, w)) };
    const c: NestedSpline = { coord: 'C', points: Array.from({ length: 32 }, (_, i) => P(i / 16 - 1, e)) };
    expect(brief(c)).toEqual(['PROGRAM_TOO_LARGE @ shape.offset']);
  });
  test('every issue is collected, in DFS pre-order', () => {
    const bad = { coord: 'C', points: [{ x: 0, y: { coord: 'Q', points: [{ x: NaN, y: 1, d: 0 }] }, d: 'x' }, P(-1, 2)] };
    expect(brief(bad)).toEqual([
      'D_NOT_FINITE @ shape.offset.points[0].d',
      'BAD_COORD @ shape.offset.points[0].y.coord',
      'X_NOT_FINITE @ shape.offset.points[0].y.points[0].x',
      'X_UNSORTED @ shape.offset.points[1].x',
    ]);
  });
  test('the error class carries the issues', () => {
    const e = new SplineValidationError(validateSpline({ coord: 'C', points: [] }));
    expect(e.issues.map((i) => i.code)).toEqual(['EMPTY']);
    expect(e.message).toMatch(/EMPTY/);
  });
});

describe('knot and tangent bounds (SP2b §6.1)', () => {
  test('|x| ≤ 2 and |d| ≤ 1e5 are legal, inclusive', () => {
    expect([SPLINE_MAX_ABS_X, SPLINE_MAX_ABS_D]).toEqual([2, 1e5]);
    expect(validateSpline({ coord: 'C', points: [P(-2, 1, -1e5), P(2, 2, 1e5)] })).toEqual([]);
    expect(validateSpline({ coord: 'C', points: [P(-2.0000000000000004, 1, 100000.00000000001), P(2, 2)] })).toEqual([]);
  });
  test('SP1 minor 2: the huge knots that evaluated to NaN are refused', () => {
    const huge: NestedSpline = { coord: 'C', points: [P(-1e308, 1), P(1e308, 2, 1e308)] };
    expect(Number.isNaN(evalSplineRef(huge, new Float64Array(6)))).toBe(true);
    expect(brief(huge)).toEqual([
      'X_OUT_OF_RANGE @ shape.offset.points[0].x',
      'X_OUT_OF_RANGE @ shape.offset.points[1].x',
      'D_OUT_OF_RANGE @ shape.offset.points[1].d',
    ]);
    expect(() => compileSpline(huge)).toThrow(SplineValidationError);
  });
});

/** An end of [lo, hi] (half the time) or a value inside it. */
const endOrInside = (next: () => number, lo: number, hi: number) => {
  const k = next() % 4;
  return k === 0 ? lo : k === 1 ? hi : q15(lo + (hi - lo) * testFloat(next));
};

/**
 * A random valid spline at the §6.1 bounds: 1-8 knots per node with x in [−2, 2] (half the nodes put their end
 * knots exactly at ±2), d and y each at an end of their range half the time, distinct coords, `levels` ≤ 3.
 */
function boundedSpline(next: () => number, levels: number, used: readonly SplineCoord[], yMin: number, yMax: number): NestedSpline {
  const free = SPLINE_COORDS.filter((c) => !used.includes(c));
  const coord = free[next() % free.length]!;
  const n = 1 + (next() % 8);
  const X = SPLINE_MAX_ABS_X;
  const xs = Array.from({ length: n }, (_, k) => q15(-X + (2 * X * (k + 0.05 + 0.9 * testFloat(next))) / n));
  if (n > 1 && (next() & 1) === 1) { xs[0] = -X; xs[n - 1] = X; }
  const points = xs.map((x) => ({
    x,
    y: levels > 1 && next() % 3 === 0 ? boundedSpline(next, levels - 1, [...used, coord], yMin, yMax) : endOrInside(next, yMin, yMax),
    d: endOrInside(next, -SPLINE_MAX_ABS_D, SPLINE_MAX_ABS_D),
  }));
  return { coord, points };
}

describe('no issues ⇒ finite outputs everywhere (SP2b §6.1)', () => {
  const RANGES: ReadonlyArray<readonly [number, number]> = [[-64, 320], [-16, 64], [-16, 128]];
  test('20 random valid splines at the bounds × 10 000 coords in [−3, 3]⁶, reference and compiled', () => {
    const next = testRng(601);
    const c = new Float64Array(6);
    let bad = 0;
    let nested = 0;
    for (let k = 0; k < 20; k++) {
      const [yMin, yMax] = RANGES[k % RANGES.length]!;
      const opts: SplineOpts = { yMin, yMax };
      const s = boundedSpline(next, 3, [], yMin, yMax);
      expect(validateSpline(s, '', opts)).toEqual([]);
      const p = compileSpline(s, opts);
      if (p.depth > 1) nested++;
      for (let i = 0; i < 10000; i++) {
        for (let j = 0; j < 6; j++) c[j] = -3 + 6 * testFloat(next);
        if (!Number.isFinite(evalSplineRef(s, c)) || !Number.isFinite(evalSpline(p, c))) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(nested).toBeGreaterThanOrEqual(10);
  });
  test('the extreme corner: six levels, |x| = 2, |d| = 1e5, y at the range ends stays within 1.5·B + 1e5 per level', () => {
    // |v| ≤ |y0 + t·dy| + t(1 − t)·|…| ≤ B + (4e5 + 2B)/4 for children bounded by B, since h ≤ 4 and |d·h| ≤ 4e5.
    let bound = 320;
    let lo: NestedSpline | number = -64;
    let hi: NestedSpline | number = 320;
    for (const [level, coord] of SPLINE_COORDS.entries()) {
      const d = level % 2 === 0 ? 1e5 : -1e5;
      const up: NestedSpline = { coord, points: [P(-2, lo, d), P(2, hi, -d)] };
      const down: NestedSpline = { coord, points: [P(-2, hi, -d), P(2, lo, d)] };
      lo = down;
      hi = up;
      bound = 1.5 * bound + 1e5;
    }
    const top = hi as NestedSpline;
    expect(validateSpline(top, '', { yMin: -64, yMax: 320 })).toEqual([]);
    const p = compileSpline(top);
    expect(p.depth).toBe(6);
    const next = testRng(602);
    const c = new Float64Array(6);
    let worst = 0;
    for (let i = 0; i < 10000; i++) {
      for (let j = 0; j < 6; j++) c[j] = -2 + 4 * testFloat(next);
      worst = Math.max(worst, Math.abs(evalSpline(p, c)));
    }
    expect(worst).toBeGreaterThan(1e5);
    expect(worst).toBeLessThanOrEqual(bound);
  });
});

test('normalizeSpline applies q15 and maps -0 to +0 everywhere', () => {
  const s: NestedSpline = { coord: 'C', points: [P(-0, 0.1 + 0.2, -0), P(0.5, { coord: 'E', points: [P(1 / 3, -0)] })] };
  const n = normalizeSpline(s);
  expect(Object.is(n.points[0]!.x, 0)).toBe(true);
  expect(n.points[0]!.y).toBe(0.3);
  expect(Object.is(n.points[0]!.d, 0)).toBe(true);
  const inner = n.points[1]!.y as NestedSpline;
  expect(inner.points[0]!.x).toBe(0.333333333333333);
  expect(Object.is(inner.points[0]!.y, 0)).toBe(true);
});

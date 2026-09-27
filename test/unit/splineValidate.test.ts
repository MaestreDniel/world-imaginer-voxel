import { describe, expect, test } from 'vitest';
import type { NestedSpline, SplineOpts } from '../../src/core/spline/types';
import { normalizeSpline, SplineValidationError, validateSpline } from '../../src/core/spline/validate';

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
    { name: 'too many points', value: { coord: 'C', points: Array.from({ length: 33 }, (_, i) => P(i, 0)) }, expected: ['TOO_MANY_POINTS @ shape.offset.points'] },
    { name: 'point not an object', value: { coord: 'C', points: [7] }, expected: ['POINT_NOT_OBJECT @ shape.offset.points[0]'] },
    { name: 'unknown point key', value: { coord: 'C', points: [{ x: 0, y: 1, d: 0, tangent: 1 }] }, expected: ['UNKNOWN_KEY @ shape.offset.points[0].tangent'] },
    { name: 'x not finite', value: { coord: 'C', points: [{ x: 'a', y: 1, d: 0 }] }, expected: ['X_NOT_FINITE @ shape.offset.points[0].x'] },
    { name: 'd missing', value: { coord: 'C', points: [{ x: 0, y: 1 }] }, expected: ['D_NOT_FINITE @ shape.offset.points[0].d'] },
    { name: 'y not finite', value: { coord: 'C', points: [P(0, Infinity)] }, expected: ['Y_NOT_FINITE @ shape.offset.points[0].y'] },
    { name: 'y out of range', value: { coord: 'C', points: [P(0, 999)] }, expected: ['Y_OUT_OF_RANGE @ shape.offset.points[0].y'], opts: { yMin: -64, yMax: 320 } },
    { name: 'y bad type', value: { coord: 'C', points: [{ x: 0, y: 'z', d: 0 }] }, expected: ['Y_BAD_TYPE @ shape.offset.points[0].y'] },
    { name: 'x duplicate after q15', value: { coord: 'C', points: [P(0.1 + 0.2, 1), P(0.3, 2)] }, expected: ['X_DUPLICATE @ shape.offset.points[1].x'] },
    { name: 'x unsorted', value: { coord: 'C', points: [P(0.5, 1), P(0.2, 2)] }, expected: ['X_UNSORTED @ shape.offset.points[1].x'] },
  ];
  test.each(cases)('$name', ({ value, expected, opts }) => {
    expect(brief(value, opts)).toEqual(expected);
  });
  test('program too large (more than 4096 spline objects)', () => {
    const pv = { coord: 'PV' as const, points: [P(0, 1)] };
    const w = { coord: 'W' as const, points: Array.from({ length: 4 }, (_, k) => P(k, pv)) };
    const e = { coord: 'E' as const, points: Array.from({ length: 32 }, (_, j) => P(j, w)) };
    const c: NestedSpline = { coord: 'C', points: Array.from({ length: 32 }, (_, i) => P(i, e)) };
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

import { describe, expect, test } from 'vitest';
import { canonicalJSON, q15 } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { PARAM_META } from '../../src/core/params/meta';
import {
  autoTangentsAt, deleteKnot, flattenKnot, insertKnot, knotAt, nestKnot, nodeAt, setKnot, type SplineEdit,
} from '../../src/core/spline/edit';
import { compileSpline, evalSpline, evalSplineRef } from '../../src/core/spline/hermite';
import { autoTangents } from '../../src/core/spline/tangents';
import { SPLINE_MAX_ABS_D, type NestedSpline, type SplineOpts } from '../../src/core/spline/types';
import { validateSpline } from '../../src/core/spline/validate';
import { testFloat, testRng } from '../harness/stats';

/** The default offset spline (deep-frozen, so any mutation of the input throws). */
const S = DEFAULTS.shape.offset;
/** The shape.offset leaf's options. */
const OPTS: SplineOpts = { coords: ['C', 'E', 'PV'], yMin: -64, yMax: 320 };
/** A probe: C 0, E 0.3, W 0, PV −0.2, T 0, H 0. */
const PROBE = Float64Array.of(0, 0.3, 0, -0.2, 0, 0);

const issues = (r: SplineEdit) => (r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.code}`));
function ok(r: SplineEdit, opts: SplineOpts = OPTS): NestedSpline {
  if (!r.ok) throw new Error(issues(r).join('; '));
  expect(validateSpline(r.value, '', opts)).toEqual([]);
  return r.value;
}
const randomCoords = (next: () => number) => Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));

describe('spline edit operations (SP2b §4.1)', () => {
  test('the fixture: the offset leaf, frozen, with auto tangents everywhere', () => {
    expect(PARAM_META.find((m) => m.path === 'shape.offset')).toMatchObject({ coords: OPTS.coords, min: OPTS.yMin, max: OPTS.yMax });
    expect(Object.isFrozen(S.points[7])).toBe(true);
    expect(canonicalJSON(autoTangents(S))).toBe(canonicalJSON(S));
  });

  describe('nodeAt and knotAt', () => {
    test('address nodes and knots by KnotPath', () => {
      expect(nodeAt(S, [])).toBe(S);
      expect(nodeAt(S, [7]).coord).toBe('E');
      expect(nodeAt(S, [7, 1]).coord).toBe('PV');
      expect(knotAt(S, [2])).toEqual({ x: -0.4, y: 40, d: 72.5063938618926 });
      expect(knotAt(S, [7, 1, 1])).toEqual({ x: 0, y: 92, d: 23.3333333333333 });
      expect(knotAt(S, [7])).toBe(S.points[7]);
    });
    test('a bad path throws', () => {
      expect(() => nodeAt(S, [9])).toThrow(/no knot at points\[9\]/);
      expect(() => nodeAt(S, [2])).toThrow(/points\[2\] holds a number/);
      expect(() => nodeAt(S, [7, 1, 1])).toThrow(/holds a number/);
      expect(() => nodeAt(S, [1.5])).toThrow(/no knot/);
      expect(() => nodeAt(S, [-1])).toThrow(/no knot/);
      expect(() => knotAt(S, [])).toThrow(/empty knot path/);
      expect(() => knotAt(S, [7, 1, 3])).toThrow(/no knot at points\[7\]\.y\.points\[1\]\.y\.points\[3\]/);
      expect(() => knotAt(S, [2, 0])).toThrow(/holds a number/);
    });
  });

  describe('setKnot', () => {
    test('sets x, y or d of one knot; neighbours and tangents are untouched', () => {
      const a = ok(setKnot(S, [2], { y: 45 }, OPTS));
      expect(a.points[2]).toEqual({ x: -0.4, y: 45, d: 72.5063938618926 });
      expect(canonicalJSON({ ...a, points: a.points.filter((_, k) => k !== 2) })).toBe(canonicalJSON({ ...S, points: S.points.filter((_, k) => k !== 2) }));
      const b = ok(setKnot(S, [7, 1, 1], { x: 0.1, d: 5 }, OPTS));
      expect(knotAt(b, [7, 1, 1])).toEqual({ x: 0.1, y: 92, d: 5 });
      expect(knotAt(b, [7, 1, 0])).toEqual(knotAt(S, [7, 1, 0]));
      const c = ok(setKnot(S, [7, 1], { x: -0.3 }, OPTS));
      expect(knotAt(c, [7, 1]).x).toBe(-0.3);
      expect(canonicalJSON(nodeAt(c, [7, 1]))).toBe(canonicalJSON(nodeAt(S, [7, 1])));
    });
    test('results are q15-normalised', () => {
      const a = ok(setKnot(S, [2], { y: 0.1 + 0.2, d: -0 }, OPTS));
      expect(a.points[2]!.y).toBe(0.3);
      expect(Object.is(a.points[2]!.d, 0)).toBe(true);
    });
    test('issue paths', () => {
      expect(issues(setKnot(S, [2], { x: -0.6 }, OPTS))).toEqual(['points[2].x: X_DUPLICATE']);
      expect(issues(setKnot(S, [2], { x: -0.7 }, OPTS))).toEqual(['points[2].x: X_UNSORTED']);
      expect(issues(setKnot(S, [2], { x: -0.2 }, OPTS))).toEqual(['points[3].x: X_UNSORTED']);
      expect(issues(setKnot(S, [2], { x: Infinity }, OPTS))).toEqual(['points[2].x: X_NOT_FINITE']);
      expect(issues(setKnot(S, [2], { y: 400 }, OPTS))).toEqual(['points[2].y: Y_OUT_OF_RANGE']);
      expect(issues(setKnot(S, [2], { y: Number.NaN }, OPTS))).toEqual(['points[2].y: Y_NOT_FINITE']);
      expect(issues(setKnot(S, [2], { d: Number.NaN }, OPTS))).toEqual(['points[2].d: D_NOT_FINITE']);
      expect(issues(setKnot(S, [7, 1], { y: 5 }, OPTS))).toEqual(['points[7].y.points[1].y: Y_BAD_TYPE']);
      expect(issues(setKnot(S, [7, 1, 1], { y: -100 }, OPTS))).toEqual(['points[7].y.points[1].y.points[1].y: Y_OUT_OF_RANGE']);
      expect(issues(setKnot(S, [8], { x: 2.5 }, OPTS))).toEqual(['points[8].x: X_OUT_OF_RANGE']);
      expect(issues(setKnot(S, [2], { d: 2e5 }, OPTS))).toEqual(['points[2].d: D_OUT_OF_RANGE']);
    });
  });

  describe('insertKnot', () => {
    test('inserts in x order with the auto tangent of the new knot only', () => {
      const a = ok(insertKnot(S, [], -0.5, 33, OPTS));
      expect(a.points.map((p) => p.x)).toEqual([-1, -0.6, -0.5, -0.4, -0.24, -0.16, -0.1, 0.05, 0.3, 0.6]);
      const manual: NestedSpline = { coord: 'C', points: [...S.points.slice(0, 2), { x: -0.5, y: 33, d: 0 }, ...S.points.slice(2)] };
      expect(a.points[2]).toEqual({ x: -0.5, y: 33, d: autoTangents(manual).points[2]!.d });
      expect(a.points[2]!.d).toBe(70);
      expect(a.points.filter((_, k) => k !== 2).map((p) => p.d)).toEqual(S.points.map((p) => p.d));
      const b = ok(insertKnot(S, [7, 1], 0.5, 100, OPTS));
      expect(nodeAt(b, [7, 1]).points).toEqual([
        { x: -1, y: 72, d: 16 }, { x: 0, y: 92, d: 23.3333333333333 }, { x: 0.5, y: 100, d: 22.8571428571429 }, { x: 1, y: 120, d: 32 },
      ]);
    });
    test('a knot next to a nested knot gets d = 0 (the hybrid rule)', () => {
      const a = ok(insertKnot(S, [], 1, 70, OPTS));
      expect(a.points[9]).toEqual({ x: 1, y: 70, d: 0 });
    });
    test('x is q15-normalised before it is placed', () => {
      const a = ok(insertKnot(S, [5], 0.1 + 0.2, 66, OPTS));
      expect(nodeAt(a, [5]).points.map((p) => p.x)).toEqual([-1, 0, 0.3, 1]);
    });
    test('issue paths', () => {
      expect(issues(insertKnot(S, [], -0.4000000000000001, 50, OPTS))).toEqual(['points[3].x: X_DUPLICATE']);
      expect(issues(insertKnot(S, [7, 1], 0, 100, OPTS))).toEqual(['points[7].y.points[1].y.points[2].x: X_DUPLICATE']);
      expect(issues(insertKnot(S, [], 0.9, 500, OPTS))).toEqual(['points[9].y: Y_OUT_OF_RANGE']);
      expect(issues(insertKnot(S, [], 0.9, Number.NaN, OPTS))).toEqual(['points[9].y: Y_NOT_FINITE']);
      expect(issues(insertKnot(S, [], Number.NaN, 50, OPTS))).toEqual(['points[0].x: X_NOT_FINITE']);
      const full: NestedSpline = { coord: 'C', points: Array.from({ length: 32 }, (_, i) => ({ x: i / 16 - 1, y: 0, d: 0 })) };
      expect(issues(insertKnot(full, [], 1.5, 0, {}))).toEqual(['points: TOO_MANY_POINTS']);
    });
    test('the automatic tangent is clamped to ±SPLINE_MAX_ABS_D (lead ruling), so a steep insert is not refused', () => {
      // A 384-block step over 2⁻⁹; the new knot sits 2⁻¹⁰ from each neighbour, where PCHIP gives 196 608.
      const step: NestedSpline = { coord: 'C', points: [
        { x: -1, y: -64, d: 0 }, { x: 0, y: -64, d: 0 }, { x: 2 ** -9, y: 320, d: 0 }, { x: 1, y: 320, d: 0 },
      ] };
      const up = ok(insertKnot(step, [], 2 ** -10, 128, OPTS));
      expect(up.points[2]).toEqual({ x: 2 ** -10, y: 128, d: SPLINE_MAX_ABS_D });
      expect(SPLINE_MAX_ABS_D).toBe(1e5);
      expect(up.points.filter((_, k) => k !== 2).map((p) => p.d)).toEqual([0, 0, 0, 0]);
      const fall: NestedSpline = { coord: 'C', points: step.points.map((p) => ({ x: p.x, y: 256 - (p.y as number), d: 0 })) };
      expect(ok(insertKnot(fall, [], 2 ** -10, 128, OPTS)).points[2]).toEqual({ x: 2 ** -10, y: 128, d: -SPLINE_MAX_ABS_D });
    });
  });

  describe('deleteKnot', () => {
    test('removes a numeric or a nested knot; the other tangents are untouched', () => {
      const a = ok(deleteKnot(S, [2], OPTS));
      expect(a.points.map((p) => [p.x, p.d])).toEqual(S.points.filter((_, k) => k !== 2).map((p) => [p.x, p.d]));
      const b = ok(deleteKnot(S, [7], OPTS));
      expect(b.points.map((p) => p.x)).toEqual([-1, -0.6, -0.4, -0.24, -0.16, -0.1, 0.05, 0.6]);
      const c = ok(deleteKnot(S, [7, 1, 1], OPTS));
      expect(nodeAt(c, [7, 1]).points).toEqual([{ x: -1, y: 72, d: 16 }, { x: 1, y: 120, d: 32 }]);
    });
    test('a node cannot lose its last knot', () => {
      const one: NestedSpline = { coord: 'C', points: [{ x: 0, y: 1, d: 0 }] };
      expect(issues(deleteKnot(one, [0], {}))).toEqual(['points: EMPTY']);
      const inner: NestedSpline = { coord: 'C', points: [{ x: -1, y: 0, d: 0 }, { x: 1, y: { coord: 'E', points: [{ x: 0, y: 5, d: 0 }] }, d: 0 }] };
      expect(issues(deleteKnot(inner, [1, 0], {}))).toEqual(['points[1].y.points: EMPTY']);
    });
  });

  describe('nestKnot', () => {
    test('turns a numeric knot into two flat knots over the coord; the value is unchanged everywhere', () => {
      const a = ok(nestKnot(S, [2], 'E', OPTS));
      expect(knotAt(a, [2])).toEqual({ x: -0.4, y: { coord: 'E', points: [{ x: -1, y: 40, d: 0 }, { x: 1, y: 40, d: 0 }] }, d: 72.5063938618926 });
      const b = ok(nestKnot(S, [5, 1], 'PV', OPTS));
      const c = ok(nestKnot(S, [8, 3], 'PV', OPTS));
      const base = compileSpline(S, OPTS);
      const progs = [a, b, c].map((s) => compileSpline(s, OPTS));
      const next = testRng(311);
      let bad = 0;
      for (let i = 0; i < 20000; i++) {
        const q = randomCoords(next);
        const v = evalSpline(base, q);
        for (const p of progs) if (!Object.is(evalSpline(p, q), v)) bad++;
      }
      expect(bad).toBe(0);
    });
    test('issue paths: a coord outside the leaf, a coord used on the path, a knot that is already nested', () => {
      expect(issues(nestKnot(S, [2], 'W', OPTS))).toEqual(['points[2].y.coord: BAD_COORD']);
      expect(issues(nestKnot(S, [2], 'C', OPTS))).toEqual(['points[2].y.coord: COORD_REUSED']);
      expect(issues(nestKnot(S, [7, 3], 'E', OPTS))).toEqual(['points[7].y.points[3].y.coord: COORD_REUSED']);
      expect(issues(nestKnot(S, [7, 1, 1], 'C', OPTS))).toEqual(['points[7].y.points[1].y.points[1].y.coord: COORD_REUSED']);
      expect(issues(nestKnot(S, [7], 'E', OPTS))).toEqual(['points[7].y: Y_BAD_TYPE']);
    });
  });

  describe('flattenKnot', () => {
    test('replaces a child spline with its value at the probe', () => {
      const a = ok(flattenKnot(S, [7], PROBE, OPTS));
      expect(knotAt(a, [7])).toEqual({ x: 0.3, y: q15(evalSplineRef(nodeAt(S, [7]), PROBE)) + 0, d: 0 });
      expect(canonicalJSON(nodeAt(a, [8]))).toBe(canonicalJSON(nodeAt(S, [8])));
      const b = ok(flattenKnot(S, [7, 1], PROBE, OPTS));
      expect(knotAt(b, [7, 1])).toEqual({ x: -0.4, y: q15(evalSplineRef(nodeAt(S, [7, 1]), PROBE)) + 0, d: 0 });
      expect(canonicalJSON(nodeAt(b, [7, 0]))).toBe(canonicalJSON(nodeAt(S, [7, 0])));
    });
    test('flatten undoes nest', () => {
      const nested = ok(nestKnot(S, [2], 'E', OPTS));
      expect(canonicalJSON(ok(flattenKnot(nested, [2], PROBE, OPTS)))).toBe(canonicalJSON(S));
    });
    test('issue paths: a numeric knot, a non-finite probe, a value outside the leaf range', () => {
      expect(issues(flattenKnot(S, [2], PROBE, OPTS))).toEqual(['points[2].y: Y_BAD_TYPE']);
      expect(issues(flattenKnot(S, [7], new Float64Array(6).fill(Number.NaN), OPTS))).toEqual(['points[7].y: Y_NOT_FINITE']);
      const over: NestedSpline = { coord: 'C', points: [{ x: 0, y: { coord: 'E', points: [{ x: -1, y: 100, d: 200 }, { x: 1, y: 100, d: -200 }] }, d: 0 }] };
      const range: SplineOpts = { yMin: 0, yMax: 150 };
      expect(issues(flattenKnot(over, [0], new Float64Array(6), range))).toEqual(['points[0].y: Y_OUT_OF_RANGE']);
      expect(ok(flattenKnot(over, [0], Float64Array.of(0, 1, 0, 0, 0, 0), range), range).points).toEqual([{ x: 0, y: 100, d: 0 }]);
    });
  });

  describe('autoTangentsAt', () => {
    test('recomputes the tangents of one node, not its children', () => {
      const edited = ok(setKnot(ok(setKnot(S, [2], { d: 0 }, OPTS)), [7, 1, 1], { d: 5 }, OPTS));
      const root = ok(autoTangentsAt(edited, [], OPTS));
      expect(root.points[2]!.d).toBe(72.5063938618926);
      expect(knotAt(root, [7, 1, 1]).d).toBe(5);
      const inner = ok(autoTangentsAt(edited, [7, 1], OPTS));
      expect(knotAt(inner, [7, 1, 1]).d).toBe(23.3333333333333);
      expect(inner.points[2]!.d).toBe(0);
      expect(canonicalJSON(ok(autoTangentsAt(root, [7, 1], OPTS)))).toBe(canonicalJSON(S));
    });
    test('automatic tangents are clamped to ±SPLINE_MAX_ABS_D (lead ruling)', () => {
      const steep: NestedSpline = { coord: 'C', points: [
        { x: -1, y: 320, d: 0 }, { x: 0, y: 320, d: 0 }, { x: 2 ** -10, y: 128, d: 0 }, { x: 2 ** -9, y: -64, d: 0 }, { x: 1, y: -64, d: 0 },
      ] };
      expect(autoTangents(steep).points[2]!.d).toBe(-196608);
      expect(ok(autoTangentsAt(steep, [], OPTS)).points.map((p) => p.d)).toEqual([0, 0, -SPLINE_MAX_ABS_D, 0, 0]);
      const inner: NestedSpline = { coord: 'E', points: [{ x: -1, y: 0, d: 0 }, { x: 1, y: { ...steep, coord: 'C' }, d: 0 }] };
      expect(knotAt(ok(autoTangentsAt(inner, [1], OPTS)), [1, 2]).d).toBe(-SPLINE_MAX_ABS_D);
    });
  });

  test('every operation leaves its input unchanged and returns a new spline', () => {
    const before = canonicalJSON(S);
    const results = [
      setKnot(S, [2], {}, OPTS), insertKnot(S, [], 0.9, 70, OPTS), deleteKnot(S, [2], OPTS), nestKnot(S, [2], 'E', OPTS),
      flattenKnot(S, [7], PROBE, OPTS), autoTangentsAt(S, [7, 1], OPTS),
    ];
    for (const r of results) expect(ok(r)).not.toBe(S);
    expect(canonicalJSON(ok(results[0]!))).toBe(before);
    expect(canonicalJSON(S)).toBe(before);
  });

  test('a bad path throws in every operation', () => {
    expect(() => setKnot(S, [9], { y: 1 }, OPTS)).toThrow(/no knot/);
    expect(() => setKnot(S, [2, 0], { y: 1 }, OPTS)).toThrow(/holds a number/);
    expect(() => insertKnot(S, [2], 0, 1, OPTS)).toThrow(/holds a number/);
    expect(() => insertKnot(S, [7, 9], 0, 1, OPTS)).toThrow(/no knot/);
    expect(() => deleteKnot(S, [], OPTS)).toThrow(/empty knot path/);
    expect(() => nestKnot(S, [1.5], 'E', OPTS)).toThrow(/no knot/);
    expect(() => flattenKnot(S, [-1], PROBE, OPTS)).toThrow(/no knot/);
    expect(() => autoTangentsAt(S, [0], OPTS)).toThrow(/holds a number/);
  });
});

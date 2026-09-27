import v8 from 'node:v8';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { compileSpline, evalSpline, evalSplineBatch, evalSplineRef, knotPathToString, withKnotY } from '../../src/core/spline/hermite';
import { SPLINE_COORDS, type NestedSpline, type SplineCoord } from '../../src/core/spline/types';
import { SplineValidationError, validateSpline } from '../../src/core/spline/validate';
import { testFloat, testRng } from '../harness/stats';

const P = (x: number, y: number | NestedSpline, d = 0) => ({ x, y, d });

/** Random valid nested spline: distinct coords along every path, 1-6 points, depth ≤ 3. */
function randomSpline(next: () => number, depth: number, used: readonly SplineCoord[]): NestedSpline {
  const free = SPLINE_COORDS.filter((c) => !used.includes(c));
  const coord = free[next() % free.length]!;
  const n = 1 + (next() % 6);
  const xs = Array.from({ length: n }, () => -1.2 + 2.4 * testFloat(next)).sort((a, b) => a - b);
  const points = xs.filter((x, i) => i === 0 || x !== xs[i - 1]).map((x) => ({
    x,
    y: depth > 0 && next() % 3 === 0 ? randomSpline(next, depth - 1, [...used, coord]) : -100 + 200 * testFloat(next),
    d: -50 + 100 * testFloat(next),
  }));
  return { coord, points };
}

const coordsOf = (next: () => number) => Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));

describe('spline tests 1-3', () => {
  test('1: the segment formula equals the textbook Hermite basis', () => {
    const next = testRng(111);
    for (let i = 0; i < 20000; i++) {
      const x0 = -1 + testFloat(next), x1 = x0 + 0.01 + testFloat(next);
      const y0 = -4096 + 8192 * testFloat(next), y1 = -4096 + 8192 * testFloat(next);
      const d0 = -5000 + 10000 * testFloat(next), d1 = -5000 + 10000 * testFloat(next);
      const s: NestedSpline = { coord: 'C', points: [P(x0, y0, d0), P(x1, y1, d1)] };
      const q = x0 + (x1 - x0) * testFloat(next);
      const c = new Float64Array(6);
      c[0] = q;
      const h = x1 - x0, t = (q - x0) / h;
      const basis = (2 * t ** 3 - 3 * t ** 2 + 1) * y0 + (t ** 3 - 2 * t ** 2 + t) * h * d0 + (-2 * t ** 3 + 3 * t ** 2) * y1 + (t ** 3 - t ** 2) * h * d1;
      const tol = 1e-13 * Math.max(1, Math.abs(y0), Math.abs(y1), Math.abs(d0 * h), Math.abs(d1 * h));
      expect(Math.abs(evalSplineRef(s, c) - basis)).toBeLessThanOrEqual(tol);
    }
  });
  test('2: numeric knots interpolate exactly; a nested knot equals its child', () => {
    const child: NestedSpline = { coord: 'E', points: [P(-1, 70, 3), P(0.25, 64, -2), P(1, 63)] };
    const s: NestedSpline = { coord: 'C', points: [P(-1, 16, 5), P(-0.3, 40, 2), P(0.2, child), P(0.9, 30, -1)] };
    const p = compileSpline(s);
    const c = new Float64Array(6);
    for (const k of s.points) {
      c[0] = k.x;
      c[1] = 0.37;
      const expected = typeof k.y === 'number' ? k.y : evalSpline(compileSpline(k.y), c);
      expect(evalSpline(p, c)).toBe(expected);
    }
  });
  test('3: hold outside the end knots; 1-point constant; NaN in → NaN out', () => {
    const s: NestedSpline = { coord: 'C', points: [P(-0.5, 10, 7), P(0.5, 20, -3)] };
    const p = compileSpline(s);
    const c = new Float64Array(6);
    for (const [q, v] of [[-5, 10], [-0.5, 10], [0.5, 20], [5, 20]] as const) {
      c[0] = q;
      expect(evalSpline(p, c)).toBe(v);
    }
    c[0] = NaN;
    expect(evalSpline(p, c)).toBeNaN();
    expect(evalSplineRef(s, c)).toBeNaN();
    const one = compileSpline({ coord: 'H', points: [P(0.3, 42, 9)] });
    for (const q of [-9, 0.3, 9]) { c[5] = q; expect(evalSpline(one, c)).toBe(42); }
  });
});

describe('compiled program', () => {
  test('6: compiled equals the reference bit for bit on 1M random points', () => {
    const next = testRng(112);
    let bad = 0;
    for (let k = 0; k < 50; k++) {
      const s = randomSpline(next, 3, []);
      const p = compileSpline(s);
      for (let i = 0; i < 20000; i++) {
        const c = coordsOf(next);
        if (!Object.is(evalSpline(p, c), evalSplineRef(s, c))) bad++;
      }
    }
    expect(bad).toBe(0);
  });
  test('6b: a −0 knot compiles and references to +0', () => {
    const s: NestedSpline = { coord: 'C', points: [P(-0.5, -0, -0), P(0.5, { coord: 'E', points: [P(0, -0)] })] };
    const p = compileSpline(s);
    const c = new Float64Array(6);
    c[0] = -3;
    expect(Object.is(evalSpline(p, c), 0)).toBe(true);
    expect(Object.is(evalSplineRef(s, c), 0)).toBe(true);
    c[0] = 3;
    expect(Object.is(evalSpline(p, c), 0)).toBe(true);
  });
  test('7: batch equals point evaluation', () => {
    const next = testRng(113);
    const s = randomSpline(next, 3, []);
    const p = compileSpline(s);
    const n = 4096;
    const soa = new Float64Array(6 * n);
    for (let i = 0; i < soa.length; i++) soa[i] = -1.25 + 2.5 * testFloat(next);
    const out = new Float64Array(n);
    evalSplineBatch(p, soa, n, n, out, new Float64Array(6));
    const c = new Float64Array(6);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < 6; k++) c[k] = soa[k * n + j]!;
      expect(Object.is(out[j], evalSpline(p, c))).toBe(true);
    }
  });
  test('9: compileSpline throws with exactly the validator issues', () => {
    const bad = { coord: 'C', points: [P(0.5, 1), P(0.2, 2)] } as unknown as NestedSpline;
    try {
      compileSpline(bad);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SplineValidationError);
      expect((e as SplineValidationError).issues).toEqual(validateSpline(bad));
    }
    expect(() => compileSpline({ coord: 'T', points: [P(0, 1)] }, { coords: ['C'] })).toThrow(SplineValidationError);
  });
  test('10: equal canonical JSON after q15 gives identical code and nums', () => {
    const a = compileSpline({ coord: 'C', points: [P(0.1 + 0.2, 1 / 3), P(0.7, 2)] });
    const b = compileSpline({ coord: 'C', points: [P(0.3, 0.333333333333333), P(0.7, 2)] });
    expect(Array.from(a.code)).toEqual(Array.from(b.code));
    expect(canonicalJSON(Array.from(a.nums))).toBe(canonicalJSON(Array.from(b.nums)));
    expect(a.depth).toBe(1);
    expect(a.splines).toBe(1);
    expect(a.knots).toBe(2);
  });
  test('11: evaluation does not allocate (≤ 1 scavenge over 4M calls)', () => {
    const next = testRng(114);
    const p = compileSpline(randomSpline(next, 3, []));
    const c = coordsOf(next);
    let sink = 0;
    for (let i = 0; i < 200000; i++) { c[0] = (i % 997) / 400 - 1.25; sink += evalSpline(p, c); }
    const prof = new v8.GCProfiler();
    prof.start();
    for (let i = 0; i < 4000000; i++) { c[0] = (i % 997) / 400 - 1.25; sink += evalSpline(p, c); }
    const stats = prof.stop();
    const scavenges = stats.statistics.filter((s) => s.gcType === 'Scavenge').length;
    expect(Number.isFinite(sink)).toBe(true);
    expect(scavenges).toBeLessThanOrEqual(1);
  });
});

describe('knot paths', () => {
  const s: NestedSpline = { coord: 'C', points: [P(-1, 1), P(0, { coord: 'E', points: [P(-1, 2), P(1, 3)] })] };
  test('withKnotY replaces one knot with structural sharing', () => {
    const t = withKnotY(s, [1, 0], 9);
    expect(((t.points[1]!.y as NestedSpline).points[0]!.y)).toBe(9);
    expect(t.points[0]).toBe(s.points[0]);
    expect(s.points[1]!.y).not.toBe(t.points[1]!.y);
    expect(() => withKnotY(s, [1], 5)).toThrow(/nested/);
    expect(() => withKnotY(s, [0, 0], 5)).toThrow(/numeric/);
    expect(() => withKnotY(s, [], 5)).toThrow(/empty/);
  });
  test('knotPathToString', () => {
    expect(knotPathToString([7, 1, 1])).toBe('points[7].y.points[1].y.points[1]');
  });
});

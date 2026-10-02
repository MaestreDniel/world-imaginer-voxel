import { describe, expect, test } from 'vitest';
import { SPLINE_SLOT, type NestedSpline } from '../../src/core/spline/types';
import { nodeWeight, pathWeight } from '../../src/core/spline/weights';
import { JAG, OFFSET, SIGMA } from '../../src/metrics/sp1Fixtures';
import { pathWeight as harnessPathWeight } from '../harness/spline';
import { testFloat, testRng } from '../harness/stats';

const FIXTURES: Array<[string, NestedSpline]> = [['OFFSET', OFFSET], ['SIGMA', SIGMA], ['JAG', JAG]];

/** The SP2a harness version (test/harness/spline.ts before SP2b), verbatim: the reference the move is checked against. */
function sp2aPathWeight(s: NestedSpline, path: readonly number[], c: Float64Array): number {
  const [k, ...rest] = path;
  const xs = s.points.map((p) => p.x);
  const n = xs.length;
  const q = c[SPLINE_SLOT[s.coord]]!;
  let w: number;
  if (q <= xs[0]!) w = k === 0 ? 1 : 0;
  else if (q >= xs[n - 1]!) w = k === n - 1 ? 1 : 0;
  else {
    let i = 0;
    while (q >= xs[i + 1]!) i++;
    const t = (q - xs[i]!) / (xs[i + 1]! - xs[i]!);
    w = k === i ? 2 * t ** 3 - 3 * t ** 2 + 1 : k === i + 1 ? -2 * t ** 3 + 3 * t ** 2 : 0;
  }
  if (rest.length === 0 || w === 0) return w;
  return w * sp2aPathWeight(s.points[k!]!.y as NestedSpline, rest, c);
}

/** Every knot path of the spline in DFS pre-order (nested knots and numeric knots). */
function knotPaths(s: NestedSpline, prefix: readonly number[] = []): number[][] {
  return s.points.flatMap((p, k) => [[...prefix, k], ...(typeof p.y === 'number' ? [] : knotPaths(p.y, [...prefix, k]))]);
}

function numericKnotPaths(s: NestedSpline, prefix: readonly number[] = []): number[][] {
  return s.points.flatMap((p, k) => (typeof p.y === 'number' ? [[...prefix, k]] : numericKnotPaths(p.y, [...prefix, k])));
}

const randomCoords = (next: () => number) => Float64Array.from({ length: 6 }, () => -1.25 + 2.5 * testFloat(next));

describe('pathWeight (moved to core/spline/weights.ts, SP2b §4.1)', () => {
  test('the test harness re-exports the src function', () => {
    expect(harnessPathWeight).toBe(pathWeight);
  });

  test.each(FIXTURES)('%s: equals the SP2a `**` formula within 1e-15 at every knot path', (_, s) => {
    const paths = knotPaths(s);
    const next = testRng(301);
    let maxDiff = 0;
    for (let i = 0; i < 20000; i++) {
      const c = randomCoords(next);
      for (const p of paths) maxDiff = Math.max(maxDiff, Math.abs(pathWeight(s, p, c) - sp2aPathWeight(s, p, c)));
    }
    expect(maxDiff).toBeLessThanOrEqual(1e-15);
  });

  test.each(FIXTURES)('%s: the weights of the numeric knots sum to 1', (_, s) => {
    const paths = numericKnotPaths(s);
    const next = testRng(302);
    for (let i = 0; i < 5000; i++) {
      const c = randomCoords(next);
      let sum = 0;
      for (const p of paths) sum += pathWeight(s, p, c);
      expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-14);
    }
  });

  test('value basis: 1 at its own knot, 0 at the others, 1 on the hold side of an end knot', () => {
    const c = new Float64Array(6);
    OFFSET.points.forEach((p, k) => {
      c[SPLINE_SLOT.C] = p.x;
      expect(OFFSET.points.map((_, j) => pathWeight(OFFSET, [j], c))).toEqual(OFFSET.points.map((_, j) => (j === k ? 1 : 0)));
    });
    c[SPLINE_SLOT.C] = -1.5;
    expect(pathWeight(OFFSET, [0], c)).toBe(1);
    c[SPLINE_SLOT.C] = 1.5;
    expect(pathWeight(OFFSET, [8], c)).toBe(1);
    expect(pathWeight(OFFSET, [7], c)).toBe(0);
  });

  test('a nested path multiplies the weights of every level', () => {
    const c = Float64Array.of(0.4, -0.2, 0, 0.5, 0, 0);
    const e = OFFSET.points[7]!.y as NestedSpline;
    const pv = e.points[1]!.y as NestedSpline;
    const expected = pathWeight(OFFSET, [7], c) * (pathWeight(e, [1], c) * pathWeight(pv, [1], c));
    expect(expected).toBeGreaterThan(0);
    expect(pathWeight(OFFSET, [7, 1, 1], c)).toBe(expected);
  });

  test('an empty path, or a path through a numeric knot with non-zero weight, throws', () => {
    const c = new Float64Array(6);
    expect(() => pathWeight(OFFSET, [], c)).toThrow(/empty knot path/);
    expect(() => pathWeight(OFFSET, [5, 1, 0], c)).toThrow(/numeric/);
  });
});

describe('nodeWeight', () => {
  test('1 at the root, else the weight of the knot that holds the node', () => {
    const next = testRng(303);
    for (let i = 0; i < 1000; i++) {
      const c = randomCoords(next);
      expect(nodeWeight(OFFSET, [], c)).toBe(1);
      expect(nodeWeight(OFFSET, [7], c)).toBe(pathWeight(OFFSET, [7], c));
      expect(nodeWeight(OFFSET, [7, 1], c)).toBe(pathWeight(OFFSET, [7, 1], c));
    }
  });
});

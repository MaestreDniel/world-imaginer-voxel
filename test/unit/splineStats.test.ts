import { describe, expect, test } from 'vitest';
import { SEA_LEVEL } from '../../src/core/constants';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import { nodeAt } from '../../src/core/spline/edit';
import { SPLINE_SLOT, type KnotPath } from '../../src/core/spline/types';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { samplePoints } from '../../src/metrics/noiseStats';
import {
  SPLINE_LEAVES, splineOfLeaf, splineStatPoints, splineStatsInto, splineStatsLength, splineStatsNode, summarizeSplineStats, type SplineLeaf,
} from '../../src/metrics/splineStats';
import { ctxFor, paramsWith } from '../harness/gen';
import { pathWeight } from '../harness/spline';

const BINS = 64;

/** Spec §4.3 computed directly: columnPoint per point, the harness pathWeight, bins and regions by definition. */
function direct(seed: string, patch: ParamsPatch, leaf: SplineLeaf, nodePath: KnotPath, id: string, n: number): number[] {
  const ctx = ctxFor(seed, patch);
  const s = splineOfLeaf(ctx.params, leaf);
  const node = nodeAt(s, nodePath);
  const xs = node.points.map((p) => p.x);
  const nk = xs.length;
  const len = splineStatsLength(nk);
  const out = new Array<number>(len).fill(0);
  const pts = samplePoints(id, n);
  for (let i = 0; i < n; i++) {
    const c = columnPoint(ctx, pts.x[i]!, pts.z[i]!);
    const coords = Float64Array.of(c.C, c.E, c.W, c.PV, c.T, c.H);
    const w = nodePath.length === 0 ? 1 : pathWeight(s, nodePath, coords);
    const q = coords[SPLINE_SLOT[node.coord]]!;
    out[Math.min(BINS - 1, Math.max(0, Math.floor((q + 1) * 32)))]! += w;
    let r = 0;
    while (r < nk && q >= xs[r]!) r++;
    const land = c.offset0 >= SEA_LEVEL;
    if (land) out[BINS + 2 * r]! += w;
    out[BINS + 2 * r + 1]! += w;
    out[len - 3]! += w;
    out[len - 2]!++;
    if (land) out[len - 1]!++;
  }
  return out;
}

const run = (seed: string, patch: ParamsPatch, leaf: SplineLeaf, nodePath: KnotPath, id: string, n: number, from = 0, to = n, stop?: () => boolean) => {
  const ctx = ctxFor(seed, patch);
  const node = splineStatsNode(ctx.params, leaf, nodePath)!;
  const out = new Float64Array(splineStatsLength(node.points.length));
  const done = splineStatsInto(ctx, leaf, nodePath, samplePoints(id, n), from, to, out, stop);
  return { out, done };
};

describe('layout and nodes', () => {
  test('64 bins, (land, all) for the left hold, each segment and the right hold, then total weight, points and land points', () => {
    expect(splineStatsLength(1)).toBe(64 + 2 * 2 + 3);
    expect(splineStatsLength(9)).toBe(64 + 2 * 10 + 3);
    expect(splineStatsLength(32)).toBe(64 + 2 * 33 + 3);
    for (const bad of [0, 33, 1.5, -1, Number.NaN]) expect(() => splineStatsLength(bad)).toThrow(RangeError);
  });

  test('SPLINE_LEAVES are the schema\'s spline leaves in schema order; splineOfLeaf reads them', () => {
    expect(SPLINE_LEAVES).toEqual(SCHEMA.leaves.filter((l) => l.meta.kind === 'spline').map((l) => l.path));
    const p = paramsWith();
    expect(splineOfLeaf(p, 'shape.offset')).toBe(p.shape.offset);
    expect(splineOfLeaf(p, 'shape.sigma')).toBe(p.shape.sigma);
    expect(splineOfLeaf(p, 'shape.jag')).toBe(p.shape.jag);
  });

  test('splineStatsNode resolves a node path or returns null for a bad leaf or path', () => {
    const p = paramsWith();
    expect(splineStatsNode(p, 'shape.offset', [])).toBe(p.shape.offset);
    expect(splineStatsNode(p, 'shape.offset', [6])?.coord).toBe('E');
    expect(splineStatsNode(p, 'shape.offset', [6, 0])?.coord).toBe('PV');
    expect(splineStatsNode(p, 'shape.jag', [1, 0])?.points.length).toBe(3);
    for (const bad of [[0], [9], [6, 3], [6, 0, 0], [1.5], [-1], ['6'], 6, null, undefined]) {
      expect(splineStatsNode(p, 'shape.offset', bad)).toBeNull();
    }
    for (const leaf of ['shape.nope', 'climate.C', 7, null]) expect(splineStatsNode(p, leaf, [])).toBeNull();
  });
});

describe('splineStatsInto', () => {
  test.each<[SplineLeaf, KnotPath]>([
    ['shape.offset', []],
    ['shape.offset', [7]],
    ['shape.offset', [7, 0]],
    ['shape.sigma', [3, 0]],
    ['shape.jag', [1]],
  ])('%s node %j equals the direct computation', (leaf, nodePath) => {
    const want = direct('7', {}, leaf, nodePath, 'test.splineStats', 1500);
    const got = run('7', {}, leaf, nodePath, 'test.splineStats', 1500);
    expect(got.done).toBe(true);
    expect(Array.from(got.out)).toEqual(want);
    const len = want.length;
    expect(want[len - 2]).toBe(1500);
    expect(want[len - 1]).toBeGreaterThan(0);
    expect(want[len - 1]).toBeLessThan(1500);
  });

  test('the root of a patched spline (a moved knot) equals the direct computation', () => {
    const patch: ParamsPatch = { shape: { jag: { coord: 'C', points: [{ x: -0.5, y: 0, d: 0 }, { x: 0.25, y: 20, d: 10 }, { x: 0.9, y: 40, d: 0 }] } } };
    expect(Array.from(run('3', patch, 'shape.jag', [], 'test.splineStats', 1500).out)).toEqual(direct('3', patch, 'shape.jag', [], 'test.splineStats', 1500));
  });

  test('accumulates: slices summed equal one run (exactly at the root, within 1e-10 relative in a nested node)', () => {
    const ctx = ctxFor('3');
    const pts = samplePoints('test.splineStats', 3000);
    for (const nodePath of [[], [7, 0]] as KnotPath[]) {
      const len = splineStatsLength(splineStatsNode(ctx.params, 'shape.offset', nodePath)!.points.length);
      const whole = new Float64Array(len);
      splineStatsInto(ctx, 'shape.offset', nodePath, pts, 0, 3000, whole);
      const parts = new Float64Array(len);
      for (const [a, b] of [[0, 1000], [1000, 1001], [1001, 1001], [1001, 3000]] as const) {
        expect(splineStatsInto(ctx, 'shape.offset', nodePath, pts, a, b, parts)).toBe(true);
      }
      if (nodePath.length === 0) {
        expect(Array.from(parts)).toEqual(Array.from(whole));
      } else {
        for (let i = 0; i < len; i++) expect(Math.abs(parts[i]! - whole[i]!)).toBeLessThanOrEqual(1e-10 * Math.abs(whole[i]!));
        expect(whole[len - 3]).toBeGreaterThan(0);
      }
    }
  });

  test('stop is checked before every 256 points; a stopped run returns false with a partial sum', () => {
    let calls = 0;
    const never = run('3', {}, 'shape.offset', [], 'test.splineStats', 1000, 0, 1000, () => { calls++; return false; });
    expect(never.done).toBe(true);
    expect(calls).toBe(4);
    expect(Array.from(never.out)).toEqual(Array.from(run('3', {}, 'shape.offset', [], 'test.splineStats', 1000).out));
    const points = never.out.length - 2;

    calls = 0;
    const third = run('3', {}, 'shape.offset', [], 'test.splineStats', 1000, 0, 1000, () => ++calls === 3);
    expect(third.done).toBe(false);
    expect(third.out[points]).toBe(512);

    calls = 0;
    const offset = run('3', {}, 'shape.offset', [], 'test.splineStats', 1000, 100, 1000, () => ++calls === 2);
    expect(offset.done).toBe(false);
    expect(offset.out[points]).toBe(256);

    const at = run('3', {}, 'shape.offset', [], 'test.splineStats', 1000, 0, 1000, () => true);
    expect(at.done).toBe(false);
    expect(Array.from(at.out).every((v) => v === 0)).toBe(true);
  });

  test('a bad range, output length, leaf or node throws RangeError', () => {
    const ctx = ctxFor('3');
    const pts = samplePoints('test.splineStats', 10);
    const out = new Float64Array(splineStatsLength(9));
    expect(() => splineStatsInto(ctx, 'shape.offset', [], pts, 5, 4, out)).toThrow(RangeError);
    expect(() => splineStatsInto(ctx, 'shape.offset', [], pts, -1, 4, out)).toThrow(RangeError);
    expect(() => splineStatsInto(ctx, 'shape.offset', [], pts, 0, 11, out)).toThrow(RangeError);
    expect(() => splineStatsInto(ctx, 'shape.offset', [], pts, 0.5, 4, out)).toThrow(RangeError);
    expect(() => splineStatsInto(ctx, 'shape.offset', [], pts, 0, 4, new Float64Array(splineStatsLength(8)))).toThrow(RangeError);
    expect(() => splineStatsInto(ctx, 'shape.offset', [0], pts, 0, 4, out)).toThrow(RangeError);
    expect(() => splineStatsInto(ctx, 'shape.nope' as SplineLeaf, [], pts, 0, 4, out)).toThrow(RangeError);
  });
});

describe('summarizeSplineStats', () => {
  test('histogram as shares of the total weight; land and world shares per region with their x bounds', () => {
    const xs = [-0.5, 0.25];
    const len = splineStatsLength(2);
    const sum = new Float64Array(len);
    sum[0] = 1; sum[31] = 2.5; sum[63] = 0.5;
    // regions: left hold, [−0.5, 0.25), right hold: (land, all)
    sum.set([0.5, 1, 1, 2.5, 0.25, 0.5], BINS);
    sum.set([4, 10, 5], len - 3);
    const r = summarizeSplineStats(sum, xs);
    expect(r.histogram.length).toBe(BINS);
    expect([r.histogram[0], r.histogram[31], r.histogram[63], r.histogram[1]]).toEqual([0.25, 0.625, 0.125, 0]);
    expect(r.regions).toEqual([
      { lo: -Infinity, hi: -0.5, land: 0.1, world: 0.1 },
      { lo: -0.5, hi: 0.25, land: 0.2, world: 0.25 },
      { lo: 0.25, hi: Infinity, land: 0.05, world: 0.05 },
    ]);
    expect([r.points, r.landPoints, r.meanWeight, r.meanLandWeight]).toEqual([10, 5, 0.4, 0.35]);
  });

  test('real sums: shares add up to the mean weights (1 at the root)', () => {
    const ctx = ctxFor('11');
    const pts = samplePoints('test.splineStats', 3000);
    for (const nodePath of [[], [7], [7, 0]] as KnotPath[]) {
      const node = splineStatsNode(ctx.params, 'shape.offset', nodePath)!;
      const out = new Float64Array(splineStatsLength(node.points.length));
      splineStatsInto(ctx, 'shape.offset', nodePath, pts, 0, 3000, out);
      const r = summarizeSplineStats(out, node.points.map((p) => p.x));
      expect(r.regions.length).toBe(node.points.length + 1);
      const land = r.regions.reduce((a, g) => a + g.land, 0);
      const world = r.regions.reduce((a, g) => a + g.world, 0);
      expect(land).toBeCloseTo(r.meanLandWeight, 12);
      expect(world).toBeCloseTo(r.meanWeight, 12);
      expect(r.histogram.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
      if (nodePath.length === 0) {
        expect([r.meanWeight, r.meanLandWeight, r.points]).toEqual([1, 1, 3000]);
      } else {
        expect(r.meanWeight).toBeGreaterThan(0);
        expect(r.meanWeight).toBeLessThan(1);
      }
    }
  });

  test('an empty sum gives zeros, not NaN; a length that does not match the knots throws', () => {
    const r = summarizeSplineStats(new Float64Array(splineStatsLength(3)), [-1, 0, 1]);
    expect(Array.from(r.histogram).every((v) => v === 0)).toBe(true);
    expect(r.regions.map((g) => [g.land, g.world])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]]);
    expect([r.points, r.landPoints, r.meanWeight, r.meanLandWeight]).toEqual([0, 0, 0, 0]);
    expect(() => summarizeSplineStats(new Float64Array(splineStatsLength(3)), [-1, 1])).toThrow(RangeError);
    expect(() => summarizeSplineStats(new Float64Array(splineStatsLength(1)), [])).toThrow(RangeError);
  });
});

describe('histogram shape (spec §4.3)', () => {
  const stats = (nodePath: KnotPath) => {
    const ctx = ctxFor('42');
    const node = splineStatsNode(ctx.params, 'shape.offset', nodePath)!;
    const out = new Float64Array(splineStatsLength(node.points.length));
    splineStatsInto(ctx, 'shape.offset', nodePath, samplePoints('test.splineStats', 20000), 0, 20000, out);
    return summarizeSplineStats(out, node.points.map((p) => p.x));
  };

  test('C at the root is flat under CDF-uniform climate (every bin within 25 % of 1/64)', () => {
    for (const v of stats([]).histogram) {
      expect(v).toBeGreaterThan(0.75 / BINS);
      expect(v).toBeLessThan(1.25 / BINS);
    }
  });

  test('PV is not flat: folded from W, its density is about 2:1 across PV = 0 (weighted, node [6, 0])', () => {
    const h = stats([6, 0]).histogram;
    let neg = 0;
    let pos = 0;
    for (let b = 0; b < BINS; b++) (b < BINS / 2 ? (neg += h[b]!) : (pos += h[b]!));
    expect(pos / neg).toBeGreaterThan(1.6);
    expect(pos / neg).toBeLessThan(2.4);
  });
});

test('the editor\'s stream is samplePoints(\'sp2b.splineStats\', 60000)', () => {
  const p = splineStatPoints();
  const q = samplePoints('sp2b.splineStats', 60000);
  expect(p.n).toBe(60000);
  expect(Array.from(p.x.subarray(0, 8))).toEqual(Array.from(q.x.subarray(0, 8)));
  expect(Array.from(p.z.subarray(59992))).toEqual(Array.from(q.z.subarray(59992)));
});

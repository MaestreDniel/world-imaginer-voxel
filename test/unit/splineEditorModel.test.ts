import { describe, expect, test } from 'vitest';
import { uMax } from '../../src/core/noise/cdf';
import { q15 } from '../../src/core/params/canonical';
import { SCHEMA } from '../../src/core/params/schema';
import { deleteKnot, nestKnot, nodeAt } from '../../src/core/spline/edit';
import { evalSplineRef } from '../../src/core/spline/hermite';
import { autoTangents } from '../../src/core/spline/tangents';
import { SPLINE_COORDS, type KnotPath, type NestedSpline, type SplineCoord } from '../../src/core/spline/types';
import { validateSpline } from '../../src/core/spline/validate';
import {
  SPLINE_LEAVES, SPLINE_STATS_POINTS, splineOfLeaf, splineStatsLength, splineStatsNode, summarizeSplineStats, type SplineRegionShare,
} from '../../src/metrics/splineStats';
import {
  autoTangentsAll, breadcrumbs, clampKnotDrag, CRUMB_SEPARATOR, curveOvershoot, curvePath, followNode, formatCoordValue, formatShare, fromPx,
  hitHandle, hitKnot, histogramBars, isSplineLeaf, KNOT_GAP, knotViews, leafOpts, leafView, lintText, nestCoords, niceTicks, nodeStatsRequest,
  overlayState, OVERSHOOT_SAMPLES, plotFor, pointOnCurve, probeCoords, probeVector, reachLimit, reachMarks, regionBands, regionLabel, regionText,
  sameStatsTarget, sampleCurve, splineLints, splineTree, statsText, tangentFromPointer, tangentHandles, toPx, unreachableKnots, withCoord,
  type Plot, type StatsTarget,
} from '../../src/ui/splineEditor/model';
import { paramsWith } from '../harness/gen';

const DEF = paramsWith();
const OFFSET = DEF.shape.offset;
const node = (coord: SplineCoord, knots: ReadonlyArray<readonly [number, number, number?]>): NestedSpline =>
  ({ coord, points: knots.map(([x, y, d]) => ({ x, y, d: d ?? 0 })) });
const ZERO = new Float64Array(6);
const BOX = { left: 10, top: 5, width: 400, height: 200 };

/** Every node path of a spline, pre-order. */
function nodePaths(s: NestedSpline, at: KnotPath = []): KnotPath[] {
  const out: KnotPath[] = [at];
  s.points.forEach((p, k) => { if (typeof p.y !== 'number') out.push(...nodePaths(p.y, [...at, k])); });
  return out;
}

describe('leaves', () => {
  test('leafView reads the schema: key, label, unit, coords, range; sea level only for offset', () => {
    expect(leafView('shape.offset')).toEqual({ path: 'shape.offset', key: 'offset', label: 'Offset', unit: 'blocks', coords: ['C', 'E', 'PV'], yMin: -64, yMax: 320, seaLevel: 63 });
    expect(leafView('shape.sigma')).toMatchObject({ key: 'sigma', label: 'Sigma', yMin: -16, yMax: 64, seaLevel: null });
    expect(leafView('shape.jag')).toMatchObject({ key: 'jag', label: 'Jaggedness', yMin: -16, yMax: 128, seaLevel: null });
  });

  test('leafOpts are the validator options of the leaf: the defaults pass, a y beyond the range does not', () => {
    for (const leaf of SPLINE_LEAVES) {
      const meta = SCHEMA.leaves.find((l) => l.path === leaf)!.meta;
      expect(leafOpts(leaf)).toEqual({ coords: meta.coords, yMin: meta.min, yMax: meta.max });
    }
    expect(validateSpline(OFFSET, '', leafOpts('shape.offset'))).toEqual([]);
    expect(validateSpline(OFFSET, '', leafOpts('shape.jag')).map((i) => i.code)).toContain('Y_OUT_OF_RANGE');
  });
});

describe('reach limit and the unreachable-knot lint', () => {
  test('L = uMax(clampSigma) of the coord\'s climate noise; PV spans [−1, 1] (no marks)', () => {
    expect(reachLimit('C', DEF)).toBe(uMax(3));
    expect(reachLimit('C', DEF)).toBe(0.9973002846585164);
    const p = paramsWith({ climate: { E: { clampSigma: 2 }, W: { clampSigma: 1 }, T: { clampSigma: 8 }, H: { clampSigma: 1.5 } } });
    expect(reachLimit('E', p)).toBe(uMax(2));
    expect(reachLimit('W', p)).toBe(uMax(1));
    expect(reachLimit('T', p)).toBe(uMax(8));
    expect(reachLimit('H', p)).toBe(uMax(1.5));
    expect(reachLimit('C', p)).toBe(uMax(3));
    expect(reachLimit('PV', p)).toBe(1);
    expect(reachLimit('PV', paramsWith({ climate: { W: { clampSigma: 1 } } }))).toBe(1);
    expect(reachMarks('PV', DEF)).toEqual([]);
    expect(reachMarks('E', p)).toEqual([-uMax(2), uMax(2)]);
  });

  test('no lint on any node of the default splines, at the default clamp or the smallest (1)', () => {
    const tight = paramsWith({ climate: { C: { clampSigma: 1 }, E: { clampSigma: 1 }, W: { clampSigma: 1 } } });
    for (const params of [DEF, tight]) {
      for (const leaf of SPLINE_LEAVES) {
        const s = leaf === 'shape.offset' ? params.shape.offset : leaf === 'shape.sigma' ? params.shape.sigma : params.shape.jag;
        for (const p of nodePaths(s)) {
          const n = nodeAt(s, p);
          expect(unreachableKnots(n, reachLimit(n.coord, params))).toEqual([]);
        }
      }
    }
  });

  test('no lint on nestKnot\'s ±1 knots, for any L', () => {
    const r = nestKnot(OFFSET, [2], 'E', leafOpts('shape.offset'));
    if (!r.ok) throw new Error('nest failed');
    const child = nodeAt(r.value, [2]);
    expect(child.points.map((p) => p.x)).toEqual([-1, 1]);
    for (const L of [0.01, 0.5, uMax(1), uMax(3), 1]) expect(unreachableKnots(child, L)).toEqual([]);
    expect(unreachableKnots(r.value, reachLimit('C', DEF))).toEqual([]);
  });

  test('interior knots whose (x_{k−1}, x_{k+1}) misses [−L, L]; end knots only when the inner neighbour is at or beyond L', () => {
    const L = reachLimit('C', DEF);
    expect(unreachableKnots(node('C', [[-1.5, 0], [-1.2, 0], [-1.1, 0], [0, 0], [1, 0]]), L)).toEqual([0, 1]);
    expect(unreachableKnots(node('C', [[-1, 0], [0, 0], [1.05, 0], [1.1, 0], [2, 0]]), 1)).toEqual([3, 4]);
    expect(unreachableKnots(node('C', [[-1, 0], [-0.5, 0], [0.2, 0]]), 0.5)).toEqual([0]);
    expect(unreachableKnots(node('C', [[-1, 0], [-0.4999, 0], [0.2, 0]]), 0.5)).toEqual([]);
    expect(unreachableKnots(node('C', [[1.5, 0], [1.9, 0]]), 1)).toEqual([1]);
    expect(unreachableKnots(node('C', [[1.9, 0]]), 0.5)).toEqual([]);
    expect(unreachableKnots(node('C', [[-2, 0], [2, 0]]), 0.1)).toEqual([]);
  });

  test('the lint recomputes with a clampSigma: C = 0.8 after a knot at 0.7 is reached at clamp 3, not at clamp 1', () => {
    const n = node('C', [[-1, 0], [0, 10], [0.7, 20], [0.8, 30]]);
    expect(unreachableKnots(n, reachLimit('C', DEF))).toEqual([]);
    expect(unreachableKnots(n, reachLimit('C', paramsWith({ climate: { C: { clampSigma: 1 } } })))).toEqual([3]);
  });
});

describe('curve sampling and overshoot', () => {
  test('sampleCurve evaluates the node with the other coords at the probe, ends exact', () => {
    const probe = probeVector({ E: -0.5, PV: 0.3 });
    const { xs, ys } = sampleCurve(OFFSET, probe, -0.1, 0.05, 7);
    expect(xs.length).toBe(7);
    expect([xs[0], xs[6]]).toEqual([-0.1, 0.05]);
    for (let j = 0; j < 7; j++) expect(ys[j]).toBe(evalSplineRef(OFFSET, withCoord(probe, 'C', xs[j]!)));
    expect(Array.from(probe)).toEqual([0, -0.5, 0, 0.3, 0, 0]);
  });

  test('the default splines stay in range between knots at several probes', () => {
    for (const [leaf, s] of [['shape.offset', DEF.shape.offset], ['shape.sigma', DEF.shape.sigma], ['shape.jag', DEF.shape.jag]] as const) {
      const v = leafView(leaf);
      for (const pr of [ZERO, probeVector({ E: -1, PV: 1 }), probeVector({ E: 0.37, PV: -0.62 })]) {
        for (const p of nodePaths(s)) expect(curveOvershoot(nodeAt(s, p), pr, v.yMin, v.yMax)).toBeNull();
      }
    }
  });

  test('a steep tangent overshoots: the largest excess over the 512 samples of [x_first, x_last]', () => {
    const up = node('C', [[-1, 300, 200], [1, 310, 0]]);
    const o = curveOvershoot(up, ZERO, -64, 320)!;
    const { xs, ys } = sampleCurve(up, ZERO, -1, 1, OVERSHOOT_SAMPLES);
    let best = 0;
    let at = -1;
    for (let j = 0; j < OVERSHOOT_SAMPLES; j++) if (ys[j]! - 320 > best) { best = ys[j]! - 320; at = j; }
    expect(OVERSHOOT_SAMPLES).toBe(512);
    expect(o).toEqual({ x: xs[at], y: ys[at], by: best });
    expect(o.by).toBeGreaterThan(30);
    const down = node('C', [[-1, -50, -200], [1, -60, 0]]);
    expect(curveOvershoot(down, ZERO, -64, 320)!.by).toBeGreaterThan(30);
    expect(curveOvershoot(node('C', [[0.5, 100]]), ZERO, -64, 320)).toBeNull();
  });

  test('splineLints walks every node: unreachable knots and overshoots with their node and knot', () => {
    const inner = node('PV', [[-1, 100], [1, 110, 0]]);
    const steep = node('PV', [[-1, 300, 200], [0, 310], [1, 300]]);
    const s: NestedSpline = {
      coord: 'C',
      points: [{ x: -1, y: 20, d: 0 }, { x: 0.2, y: { coord: 'E', points: [{ x: -1.5, y: inner, d: 0 }, { x: -1.2, y: 90, d: 0 }, { x: 0, y: steep, d: 0 }] }, d: 0 }],
    };
    const lints = splineLints(s, 'shape.offset', DEF, ZERO);
    expect(lints.map((l) => [l.kind, l.nodePath, l.knot])).toEqual([
      ['unreachable', [1], 0],
      ['overshoot', [1, 2], 0],
    ]);
    expect(lints[0]!.message).toBe('knot 0 (E=−1.50) is unreachable: E stays within ±0.9973');
    expect(lints[1]!.message).toMatch(/^the curve leaves −64…320 by \d+\.\d blocks at PV=−0\.\d+$/);
    for (const leaf of SPLINE_LEAVES) {
      const d = leaf === 'shape.offset' ? DEF.shape.offset : leaf === 'shape.sigma' ? DEF.shape.sigma : DEF.shape.jag;
      expect(splineLints(d, leaf, DEF, ZERO)).toEqual([]);
    }
  });
});

describe('probes', () => {
  test('probeCoords: the coords read below a node, not its own, in slot order', () => {
    expect(probeCoords(OFFSET)).toEqual(['E', 'PV']);
    expect(probeCoords(nodeAt(OFFSET, [5]))).toEqual([]);
    expect(probeCoords(nodeAt(OFFSET, [7]))).toEqual(['PV']);
    expect(probeCoords(nodeAt(OFFSET, [7, 0]))).toEqual([]);
    expect(probeCoords(DEF.shape.sigma)).toEqual(['E', 'PV']);
    expect(probeCoords(node('H', [[0, 1]]))).toEqual([]);
  });

  test('probeVector defaults to 0; withCoord copies with one slot set', () => {
    const p = probeVector({ E: 0.5, T: -0.25 });
    expect(Array.from(p)).toEqual([0, 0.5, 0, 0, -0.25, 0]);
    expect(SPLINE_COORDS.length).toBe(6);
    const q = withCoord(p, 'C', 0.3);
    expect(Array.from(q)).toEqual([0.3, 0.5, 0, 0, -0.25, 0]);
    expect(q).not.toBe(p);
    expect(p[0]).toBe(0);
  });
});

describe('plot transforms', () => {
  test('x spans [min(−1, x_first), max(1, x_last)]; y spans the leaf range', () => {
    const p = plotFor(OFFSET, -64, 320, BOX);
    expect([p.xMin, p.xMax, p.yMin, p.yMax]).toEqual([-1, 1, -64, 320]);
    const wide = plotFor(node('C', [[-1.5, 0], [0, 0], [1.2, 0]]), -16, 128, BOX);
    expect([wide.xMin, wide.xMax]).toEqual([-1.5, 1.2]);
    const pvj = plotFor(nodeAt(DEF.shape.jag, [1, 0]), -16, 128, BOX);
    expect([pvj.xMin, pvj.xMax]).toEqual([-1, 1]);
    expect([p.left, p.top, p.width, p.height]).toEqual([10, 5, 400, 200]);
  });

  test('toPx maps corners (y down) and fromPx inverts it', () => {
    const p = plotFor(OFFSET, -64, 320, BOX);
    expect(toPx(p, -1, 320)).toEqual({ px: 10, py: 5 });
    expect(toPx(p, 1, -64)).toEqual({ px: 410, py: 205 });
    expect(toPx(p, 0, 128)).toEqual({ px: 210, py: 105 });
    for (const [x, y] of [[-0.37, 12.5], [0.91, 300], [0, -64]] as const) {
      const { px, py } = toPx(p, x, y);
      const back = fromPx(p, px, py);
      expect(back.x).toBeCloseTo(x, 12);
      expect(back.y).toBeCloseTo(y, 10);
    }
  });

  test('knotViews: numeric knots as stored; nested knots at their child\'s value at the probe', () => {
    const probe = probeVector({ E: -1, PV: 1 });
    const views = knotViews(OFFSET, probe);
    expect(views.length).toBe(9);
    expect(views[0]).toEqual({ x: -1, y: 16, d: OFFSET.points[0]!.d, nested: false });
    const child = OFFSET.points[7]!.y as NestedSpline;
    expect(views[7]).toEqual({ x: 0.3, y: evalSplineRef(child, probe), d: OFFSET.points[7]!.d, nested: true });
    expect(views[7]!.y).toBe(175);
  });
});

describe('hit testing and handles', () => {
  const p: Plot = plotFor(node('C', [[-1, 0], [1, 0]]), -64, 320, BOX);
  const knots = [{ x: 0, y: 128, d: 0, nested: false }, { x: 0.05, y: 128, d: 0, nested: false }, { x: 0.5, y: 0, d: 0, nested: false }];

  test('hitKnot: the nearest knot within the radius; ties go to the later (drawn on top); none outside', () => {
    expect(hitKnot(p, knots, 210, 111, 8)).toBe(0);
    expect(hitKnot(p, knots, 220, 105, 8)).toBe(1);
    expect(hitKnot(p, knots, 215, 105, 8)).toBe(1);
    expect(hitKnot(p, knots, 212, 105, 8)).toBe(0);
    const k2 = toPx(p, 0.5, 0);
    expect(hitKnot(p, knots, k2.px + 8, k2.py, 8)).toBe(2);
    expect(hitKnot(p, knots, k2.px + 8.01, k2.py, 8)).toBeNull();
    expect(hitKnot(p, [], 0, 0, 8)).toBeNull();
  });

  test('tangentHandles: lengthPx either side along the tangent in pixel space', () => {
    const [l, r] = tangentHandles(p, knots[0]!, 30);
    expect(l).toEqual({ px: 180, py: 105 });
    expect(r).toEqual({ px: 240, py: 105 });
    const k = { x: 0, y: 128, d: 384, nested: false };
    const [l2, r2] = tangentHandles(p, k, 30);
    const s = 30 / Math.SQRT2;
    expect(r2.px).toBeCloseTo(210 + s, 10);
    expect(r2.py).toBeCloseTo(105 - s, 10);
    expect(l2.px).toBeCloseTo(210 - s, 10);
    expect(l2.py).toBeCloseTo(105 + s, 10);
    expect(hitHandle(p, k, r2.px + 3, r2.py, 30, 6)).toBe(true);
    expect(hitHandle(p, k, l2.px, l2.py - 5, 30, 6)).toBe(true);
    expect(hitHandle(p, k, 210, 105, 30, 6)).toBe(false);
  });

  test('tangentFromPointer: the slope from the knot to the pointer, either side; clamped to ±1e5; the knot itself keeps d', () => {
    const k = { x: 0, y: 128, d: 384, nested: false };
    const [l, r] = tangentHandles(p, k, 30);
    expect(tangentFromPointer(p, k, r.px, r.py)).toBeCloseTo(384, 9);
    expect(tangentFromPointer(p, k, l.px, l.py)).toBeCloseTo(384, 9);
    expect(tangentFromPointer(p, k, 240, 105)).toBe(0);
    expect(tangentFromPointer(p, k, 160, 5)).toBe(-768);
    expect(tangentFromPointer(p, k, 210, 104)).toBe(1e5);
    expect(tangentFromPointer(p, k, 210, 106)).toBe(-1e5);
    expect(tangentFromPointer(p, k, 210.001, 5)).toBe(1e5);
    expect(tangentFromPointer(p, k, 210, 105)).toBe(384);
  });
});

describe('drag clamping and insertion', () => {
  const n = node('C', [[-1, 10], [-0.5, 20], [0.3, 30], [0.3 + 0.25 * KNOT_GAP, 35], [0.3 + 1.5 * KNOT_GAP, 40], [1, 50]]);

  test('x stays between the neighbours at least 2^-10 apart; end knots within [−2, 2]; y within the range', () => {
    expect(KNOT_GAP).toBe(1 / 1024);
    expect(clampKnotDrag(n, 1, -2, 500, -64, 320)).toEqual({ x: q15(-1 + KNOT_GAP), y: 320 });
    expect(clampKnotDrag(n, 1, 0.9, -100, -64, 320)).toEqual({ x: q15(0.3 - KNOT_GAP), y: -64 });
    expect(clampKnotDrag(n, 1, -0.2, 25, -64, 320)).toEqual({ x: -0.2, y: 25 });
    expect(clampKnotDrag(n, 0, -3, 0, -64, 320)).toEqual({ x: -2, y: 0 });
    expect(clampKnotDrag(n, 5, 2.5, 0, -64, 320)).toEqual({ x: 2, y: 0 });
    expect(clampKnotDrag(n, 5, 0, 0, -64, 320).x).toBe(q15(0.3 + 1.5 * KNOT_GAP + KNOT_GAP));
  });

  test('neighbours closer than 2 × 2^-10 keep x; NaN keeps the knot\'s value; results are q15', () => {
    expect(clampKnotDrag(n, 3, 0.5, 36, -64, 320)).toEqual({ x: q15(0.3 + 0.25 * KNOT_GAP), y: 36 });
    expect(clampKnotDrag(n, 3, 0, 36, -64, 320).x).toBe(q15(0.3 + 0.25 * KNOT_GAP));
    expect(clampKnotDrag(n, 2, Number.NaN, Number.NaN, -64, 320)).toEqual({ x: 0.3, y: 30 });
    expect(clampKnotDrag(n, 1, 0.1 + 0.2 - 0.5, 1 / 3, -64, 320)).toEqual({ x: -0.2, y: 0.333333333333333 });
    const nested: NestedSpline = { coord: 'C', points: [{ x: -1, y: 0, d: 0 }, { x: 0, y: node('E', [[0, 5]]), d: 0 }, { x: 1, y: 0, d: 0 }] };
    expect(clampKnotDrag(nested, 1, Number.NaN, Number.NaN, -64, 320)).toEqual({ x: 0, y: -64 });
  });

  test('pointOnCurve: x within [−2, 2], y the curve value at the probe clamped to the range', () => {
    const probe = probeVector({ E: -1, PV: 1 });
    const on = pointOnCurve(OFFSET, probe, 0.4, -64, 320);
    expect(on).toEqual({ x: 0.4, y: Number(evalSplineRef(OFFSET, withCoord(probe, 'C', 0.4)).toPrecision(15)) });
    expect(pointOnCurve(OFFSET, probe, 3, -64, 320).x).toBe(2);
    expect(pointOnCurve(OFFSET, probe, 0.4, -64, 150).y).toBe(150);
  });
});

describe('breadcrumbs and tree', () => {
  test('formatCoordValue: at most 3 decimals, at least 2, with a real minus sign', () => {
    expect([0.3, -0.4, 0.05, 0.125, 1 / 1024, -0, 1 / 3, -1, 2].map(formatCoordValue)).toEqual(
      ['0.30', '−0.40', '0.05', '0.125', '0.001', '0.00', '0.333', '−1.00', '2.00'],
    );
  });

  test('crumbs from the typed coords, each with the node path it opens', () => {
    const c = breadcrumbs('shape.offset', OFFSET, [7, 1]);
    expect(c).toEqual([
      { label: 'offset', nodePath: [] },
      { label: 'C=0.30', nodePath: [7] },
      { label: 'E=−0.40', nodePath: [7, 1] },
    ]);
    expect(c.map((x) => x.label).join(CRUMB_SEPARATOR)).toBe('offset › C=0.30 › E=−0.40');
    expect(breadcrumbs('shape.jag', DEF.shape.jag, [])).toEqual([{ label: 'jag', nodePath: [] }]);
    expect(() => breadcrumbs('shape.offset', OFFSET, [0])).toThrow();
  });

  test('splineTree: every node pre-order with its coord and knot count', () => {
    const rows = splineTree('shape.offset', OFFSET);
    expect(rows.length).toBe(nodePaths(OFFSET).length);
    expect(rows.map((r) => r.nodePath)).toEqual(nodePaths(OFFSET));
    expect(rows.slice(0, 3)).toEqual([
      { nodePath: [], depth: 0, label: 'offset → C (9 knots)' },
      { nodePath: [5], depth: 1, label: 'C=−0.10 → E (3 knots)' },
      { nodePath: [6], depth: 1, label: 'C=0.05 → E (4 knots)' },
    ]);
    expect(rows[3]).toEqual({ nodePath: [6, 0], depth: 2, label: 'E=−1.00 → PV (3 knots)' });
    expect(splineTree('shape.sigma', DEF.shape.sigma).map((r) => r.label)).toEqual([
      'sigma → C (4 knots)', 'C=0.05 → E (3 knots)', 'E=−1.00 → PV (2 knots)',
    ]);
    expect(splineTree('shape.jag', node('C', [[0, 1]]))).toEqual([{ nodePath: [], depth: 0, label: 'jag → C (1 knot)' }]);
  });

  test('a nested knot appears in the tree right after its parent node', () => {
    const r = nestKnot(OFFSET, [0], 'E', leafOpts('shape.offset'));
    if (!r.ok) throw new Error('nest failed');
    expect(splineTree('shape.offset', r.value)[1]).toEqual({ nodePath: [0], depth: 1, label: 'C=\u22121.00 \u2192 E (2 knots)' });
  });
});

describe('drawer helpers', () => {
  const OPTS = leafOpts('shape.offset');

  test('isSplineLeaf: the three spline leaves and nothing else', () => {
    for (const leaf of SPLINE_LEAVES) expect(isSplineLeaf(leaf)).toBe(true);
    for (const p of ['shape', 'shape.offset.x', 'climate.C', 'biomes.table', '', 'toString', 'Shape.offset']) expect(isSplineLeaf(p)).toBe(false);
  });

  test('followNode: the longest prefix of a node path that still addresses a nested node', () => {
    expect(followNode(OFFSET, [])).toEqual([]);
    expect(followNode(OFFSET, [7, 1])).toEqual([7, 1]);
    expect(followNode(OFFSET, [7, 1, 0])).toEqual([7, 1]);
    expect(followNode(OFFSET, [7, 3])).toEqual([7]);
    expect(followNode(OFFSET, [7, 3, 1])).toEqual([7]);
    expect(followNode(OFFSET, [9, 0])).toEqual([]);
    expect(followNode(OFFSET, [0])).toEqual([]);
    const del = deleteKnot(OFFSET, [7], OPTS);
    if (!del.ok) throw new Error('delete failed');
    expect(followNode(del.value, [7, 1])).toEqual([7, 1]);
    expect(nodeAt(del.value, [7, 1])).toBe(nodeAt(del.value, followNode(del.value, [7, 1])));
    expect(followNode(del.value, [8, 1])).toEqual([]);
  });

  test('nestCoords: the leaf coords no node from the root down to the knot uses, matching nestKnot', () => {
    expect(nestCoords('shape.offset', OFFSET, [0])).toEqual(['E', 'PV']);
    expect(nestCoords('shape.offset', OFFSET, [7, 3])).toEqual(['PV']);
    expect(nestCoords('shape.offset', OFFSET, [7, 1, 0])).toEqual([]);
    expect(nestCoords('shape.sigma', DEF.shape.sigma, [3, 1])).toEqual(['PV']);
    for (const path of [[0], [7, 3], [7, 1, 0], [5, 2]]) {
      const offered = nestCoords('shape.offset', OFFSET, path);
      for (const c of SPLINE_COORDS) expect([c, nestKnot(OFFSET, path, c, OPTS).ok]).toEqual([c, offered.includes(c)]);
    }
    expect(() => nestCoords('shape.offset', OFFSET, [12])).toThrow();
  });

  test('autoTangentsAll: autoTangentsAt on every node, so SP1 autoTangents with each tangent clamped to ±1e5', () => {
    for (const leaf of SPLINE_LEAVES) {
      const s = splineOfLeaf(DEF, leaf);
      expect(autoTangentsAll(s, leafOpts(leaf))).toEqual({ ok: true, value: autoTangents(s) });
    }
    const steep: NestedSpline = { coord: 'E', points: [{ x: -1, y: 0, d: 0 }, { x: -1 + 1 / 1024, y: 300, d: 0 }, { x: 1, y: 300, d: 0 }] };
    const s: NestedSpline = { coord: 'C', points: [{ x: -1, y: steep, d: 5 }, { x: 1, y: 100, d: 7 }] };
    expect((autoTangents(s).points[0]!.y as NestedSpline).points[0]!.d).toBe(307350);
    const r = autoTangentsAll(s, OPTS);
    if (!r.ok) throw new Error('auto tangents refused');
    expect(r.value.points.map((p) => p.d)).toEqual([0, 0]);
    expect((r.value.points[0]!.y as NestedSpline).points.map((p) => p.d)).toEqual([1e5, 0, 0]);
    expect(validateSpline(r.value, '', OPTS)).toEqual([]);
  });

  test('nodeStatsRequest: the pool request for the open node and the knot xs its sum is summarised with', () => {
    const r = nodeStatsRequest(DEF, 'shape.offset', [7, 1]);
    expect(r).toEqual({ n: SPLINE_STATS_POINTS, args: { len: splineStatsLength(3), leaf: 'shape.offset', node: [7, 1] }, knotXs: [-1, 0, 1] });
    expect(SPLINE_STATS_POINTS).toBe(60000);
    expect(splineStatsNode(DEF, r.args.leaf, r.args.node)).toBe(nodeAt(OFFSET, [7, 1]));
    expect(nodeStatsRequest(DEF, 'shape.jag', [])).toEqual({ n: 60000, args: { len: splineStatsLength(2), leaf: 'shape.jag', node: [] }, knotXs: [-0.1, 0.05] });
    const path = [7];
    expect(nodeStatsRequest(DEF, 'shape.offset', path).args.node).not.toBe(path);
    expect(() => nodeStatsRequest(DEF, 'shape.offset', [0])).toThrow();
  });

  test('overlayState: fresh for the same epoch and node outside a gesture; stale after a change or during a gesture; none for another node', () => {
    const at = (epoch: number, nodePath: KnotPath = [7, 1], coord: SplineCoord = 'E', leaf: StatsTarget['leaf'] = 'shape.offset'): StatsTarget =>
      ({ epoch, leaf, nodePath: [...nodePath], coord });
    expect(overlayState(null, at(3), false)).toBe('none');
    expect(overlayState(at(3), at(3), false)).toBe('fresh');
    expect(overlayState(at(3), at(3), true)).toBe('stale');
    expect(overlayState(at(3), at(4), false)).toBe('stale');
    expect(overlayState(at(3, [7]), at(3), false)).toBe('none');
    expect(overlayState(at(3, [7, 1], 'PV'), at(3), false)).toBe('none');
    expect(overlayState(at(3, [7, 1], 'E', 'shape.sigma'), at(3), false)).toBe('none');
    expect(sameStatsTarget(at(3), at(3))).toBe(true);
    expect(sameStatsTarget(at(3), at(4))).toBe(false);
    expect(sameStatsTarget(at(3, [7]), at(3))).toBe(false);
    expect(sameStatsTarget(null, at(3))).toBe(false);
  });

  test('niceTicks: 1-2-5 steps inside the range, at most maxCount values, no −0', () => {
    expect(niceTicks(-1, 1, 5)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(niceTicks(-2, 1, 7)).toEqual([-2, -1.5, -1, -0.5, 0, 0.5, 1]);
    expect(niceTicks(-64, 320, 8)).toEqual([-50, 0, 50, 100, 150, 200, 250, 300]);
    expect(niceTicks(-16, 64, 6)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(-16, 128, 6)).toEqual([0, 50, 100]);
    expect(niceTicks(0.1, 0.7, 4)).toEqual([0.2, 0.4, 0.6]);
    expect(niceTicks(-1.4, -1, 5)).toEqual([-1.4, -1.3, -1.2, -1.1, -1]);
    expect(niceTicks(0.1, 0.7, 7)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    for (const [lo, hi, n] of [[-1, 1, 5], [-0.9, 0.9, 3], [-16, 64, 6], [-2, 2, 9]] as const) {
      const t = niceTicks(lo, hi, n);
      expect(t.length).toBeLessThanOrEqual(n);
      expect(t.length).toBeGreaterThanOrEqual(2);
      expect(t.every((v) => v >= lo && v <= hi && !Object.is(v, -0))).toBe(true);
    }
  });

  test('histogramBars: 64 bars over [−1, 1] whatever the plot range, heights relative to the largest bin', () => {
    const p = plotFor(node('C', [[-2, 0], [1, 0]]), -64, 320, BOX);
    const h = new Float64Array(64);
    h[0] = 0.5;
    h[10] = 0.25;
    h[63] = 0.25;
    const bars = histogramBars(p, h, 40);
    expect(bars.length).toBe(64);
    expect(bars[0]).toEqual({ x0: toPx(p, -1, 0).px, x1: toPx(p, -1 + 1 / 32, 0).px, height: 40 });
    expect(bars[63]!.x1).toBeCloseTo(toPx(p, 1, 0).px, 9);
    expect([bars[10]!.height, bars[63]!.height, bars[1]!.height]).toEqual([20, 20, 0]);
    expect(histogramBars(p, new Float64Array(64), 40).every((b) => b.height === 0)).toBe(true);
  });

  test('regionBands: each region clipped to the plot\'s x range, regions outside it dropped', () => {
    const p = plotFor(node('C', [[-0.5, 0], [0.2, 0], [0.6, 0]]), -64, 320, BOX);
    const r = (lo: number, hi: number, land: number, world: number): SplineRegionShare => ({ lo, hi, land, world });
    const regions = [r(-Infinity, -0.5, 0.1, 0.2), r(-0.5, 0.2, 0.3, 0.4), r(0.2, 0.6, 0.25, 0.15), r(0.6, Infinity, 0.35, 0.25)];
    expect(regionBands(p, regions)).toEqual([
      { index: 0, x0: toPx(p, -1, 0).px, x1: toPx(p, -0.5, 0).px, land: 0.1, world: 0.2 },
      { index: 1, x0: toPx(p, -0.5, 0).px, x1: toPx(p, 0.2, 0).px, land: 0.3, world: 0.4 },
      { index: 2, x0: toPx(p, 0.2, 0).px, x1: toPx(p, 0.6, 0).px, land: 0.25, world: 0.15 },
      { index: 3, x0: toPx(p, 0.6, 0).px, x1: toPx(p, 1, 0).px, land: 0.35, world: 0.25 },
    ]);
    expect(regionBands(p, [r(-Infinity, -1.5, 0, 0), r(-1.5, 1.5, 1, 1), r(1.5, Infinity, 0, 0)])).toEqual([
      { index: 1, x0: BOX.left, x1: BOX.left + BOX.width, land: 1, world: 1 },
    ]);
  });

  test('share and region texts', () => {
    expect([0.073, 0.041, 0, 1, 0.12345].map(formatShare)).toEqual(['7.3 %', '4.1 %', '0.0 %', '100.0 %', '12.3 %']);
    const r = (lo: number, hi: number): SplineRegionShare => ({ lo, hi, land: 0.073, world: 0.041 });
    expect(regionLabel('C', r(-Infinity, 0.3))).toBe('C < 0.30');
    expect(regionLabel('E', r(-0.4, 0.2))).toBe('−0.40 ≤ E < 0.20');
    expect(regionLabel('PV', r(1, Infinity))).toBe('PV ≥ 1.00');
    expect(regionText('C', r(0.3, 0.55))).toBe('0.30 ≤ C < 0.55: 7.3 % of land, 4.1 % of the world');
  });

  test('statsText: the point count and land share, and for a nested node its mean weights', () => {
    const sum = new Float64Array(splineStatsLength(2));
    sum[0] = 25;
    sum[64 + 2] = 10;
    sum[64 + 3] = 25;
    sum[sum.length - 3] = 25;
    sum[sum.length - 2] = 100;
    sum[sum.length - 1] = 40;
    const sm = summarizeSplineStats(sum, [-0.5, 0.5]);
    expect(statsText(sm, false)).toBe('100 points, 40.0 % land');
    expect(statsText(sm, true)).toBe('100 points, 40.0 % land; this node weighs 25.0 % of the world and 25.0 % of land');
    expect(statsText(summarizeSplineStats(new Float64Array(splineStatsLength(1)), [0]), false)).toBe('0 points, 0.0 % land');
  });

  test('curvePath: an SVG path through the samples in plot pixels (2 decimals)', () => {
    const p = plotFor(node('C', [[-1, 0], [1, 0]]), 0, 100, { left: 0, top: 0, width: 200, height: 100 });
    expect(curvePath(p, Float64Array.of(-1, 0, 1), Float64Array.of(0, 50, 100))).toBe('M0,100L100,50L200,0');
    expect(curvePath(p, Float64Array.of(-1 / 3), Float64Array.of(1 / 3))).toBe('M66.67,99.67');
    expect(curvePath(p, new Float64Array(0), new Float64Array(0))).toBe('');
  });

  test('lintText: the crumbs of the lint\'s node, then its message', () => {
    const s: NestedSpline = {
      coord: 'C',
      points: [{ x: -1, y: 20, d: 0 }, { x: 0.2, y: node('E', [[-1.5, 90], [-1.2, 90], [0, 100]]), d: 0 }],
    };
    const lints = splineLints(s, 'shape.offset', DEF, ZERO);
    expect(lints.length).toBe(1);
    expect(lintText('shape.offset', s, lints[0]!)).toBe('offset › C=0.20: knot 0 (E=−1.50) is unreachable: E stays within ±0.9973');
  });
});

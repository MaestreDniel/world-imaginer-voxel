/**
 * Spline editor model (SP2b spec §4.2, §4.3): leaf views, the reach limit and the lints, probes, plot
 * transforms, hit testing, drag clamping, breadcrumbs and the node tree, and the drawer's helpers (the node
 * it follows, the coords nest offers, auto tangents for the whole spline, the statistics request and its
 * stale state, axis ticks, histogram bars, region bands and texts). Pure; the SVG lives in plot.ts, the tree
 * in tree.ts and the drawer in drawer.ts. Edits themselves go through core/spline/edit.ts.
 */
import { SEA_LEVEL } from '../../core/constants';
import { uMax } from '../../core/noise/cdf';
import { q15 } from '../../core/params/canonical';
import { metaOf } from '../../core/params/meta';
import type { Params } from '../../core/params/schema';
import { autoTangentsAt, knotAt, nodeAt, type SplineEdit } from '../../core/spline/edit';
import { evalSplineRef } from '../../core/spline/hermite';
import {
  SPLINE_COORDS, SPLINE_MAX_ABS_D, SPLINE_MAX_ABS_X, SPLINE_SLOT, type KnotPath, type NestedSpline, type SplineCoord, type SplineOpts,
} from '../../core/spline/types';
import {
  SPLINE_LEAVES, SPLINE_STATS_POINTS, splineOfLeaf, splineStatsLength, type SplineLeaf, type SplineRegionShare, type SplineStatsSummary,
} from '../../metrics/splineStats';

// ---------------------------------------------------------------- leaves
export interface LeafView {
  readonly path: SplineLeaf;
  /** The last path segment ('offset'): the root breadcrumb. */
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly coords: readonly SplineCoord[];
  /** The y axis: the leaf's range. */
  readonly yMin: number;
  readonly yMax: number;
  /** A horizontal line on the plot (sea level for offset), or null. */
  readonly seaLevel: number | null;
}

export function leafView(leaf: SplineLeaf): LeafView {
  const m = metaOf(leaf);
  if (m === undefined || m.kind !== 'spline' || m.coords === undefined || m.min === undefined || m.max === undefined) {
    throw new Error(`${leaf} is not a spline leaf`);
  }
  return {
    path: leaf, key: leaf.slice(leaf.lastIndexOf('.') + 1), label: m.label, unit: m.unit ?? '', coords: m.coords,
    yMin: m.min, yMax: m.max, seaLevel: leaf === 'shape.offset' ? SEA_LEVEL : null,
  };
}

/** The validator options of the leaf (checkSpline's): its coords and y range. */
export function leafOpts(leaf: SplineLeaf): SplineOpts {
  const v = leafView(leaf);
  return { coords: v.coords, yMin: v.yMin, yMax: v.yMax };
}

// ---------------------------------------------------------------- reach and lints
/**
 * L, the largest |value| the climate gives the coord (spec §4.2): uMax(clampSigma) of the coord's climate
 * noise for C, E, W, T and H; 1 for PV, which the fold spans fully for every legal clamp.
 */
export function reachLimit(coord: SplineCoord, params: Params): number {
  return coord === 'PV' ? 1 : uMax(params.climate[coord].clampSigma);
}

/** The x positions of the ±L marks on the plot: none for PV. */
export function reachMarks(coord: SplineCoord, params: Params): readonly number[] {
  if (coord === 'PV') return [];
  const L = reachLimit(coord, params);
  return [-L, L];
}

/**
 * Knots whose influence interval (x_{k−1}, x_{k+1}) misses [−L, L] (spec §4.3). An end knot's interval
 * is unbounded on its outer side, so it is flagged only when its inner neighbour is at or beyond L on the
 * same side; a node's only knot is never flagged.
 */
export function unreachableKnots(node: NestedSpline, L: number): number[] {
  const pts = node.points;
  const n = pts.length;
  const out: number[] = [];
  if (n < 2) return out;
  for (let k = 0; k < n; k++) {
    const left = k > 0 ? pts[k - 1]!.x : -Infinity;
    const right = k < n - 1 ? pts[k + 1]!.x : Infinity;
    if (right <= -L || left >= L) out.push(k);
  }
  return out;
}

/** Points the overshoot lint checks per node (spec §4.3). */
export const OVERSHOOT_SAMPLES = 512;

/** n evaluations of the node from x0 to x1 (both ends exact), the other coords at the probe. */
export function sampleCurve(node: NestedSpline, probe: Float64Array, x0: number, x1: number, n: number): { readonly xs: Float64Array; readonly ys: Float64Array } {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const c = Float64Array.from(probe);
  const slot = SPLINE_SLOT[node.coord];
  for (let j = 0; j < n; j++) {
    const x = j === n - 1 ? x1 : n === 1 ? x0 : x0 + ((x1 - x0) * j) / (n - 1);
    c[slot] = x;
    xs[j] = x;
    ys[j] = evalSplineRef(node, c);
  }
  return { xs, ys };
}

export interface Overshoot {
  readonly x: number;
  readonly y: number;
  /** How far y lies beyond the range (> 0). */
  readonly by: number;
}

/**
 * The largest excursion of the node's curve beyond [yMin, yMax] over OVERSHOOT_SAMPLES points from the
 * first to the last knot (the validator checks y only at knots), or null. A single knot has no curve.
 */
export function curveOvershoot(node: NestedSpline, probe: Float64Array, yMin: number, yMax: number): Overshoot | null {
  const pts = node.points;
  if (pts.length < 2) return null;
  const { xs, ys } = sampleCurve(node, probe, pts[0]!.x, pts[pts.length - 1]!.x, OVERSHOOT_SAMPLES);
  let best: Overshoot | null = null;
  for (let j = 0; j < OVERSHOOT_SAMPLES; j++) {
    const y = ys[j]!;
    const by = y > yMax ? y - yMax : y < yMin ? yMin - y : 0;
    if (by > (best?.by ?? 0)) best = { x: xs[j]!, y, by };
  }
  return best;
}

export interface SplineLint {
  /** The node to open and the knot to select (for an overshoot, the left knot of its segment). */
  readonly nodePath: KnotPath;
  readonly knot: number;
  readonly kind: 'unreachable' | 'overshoot';
  readonly message: string;
}

const minus = (t: string): string => t.replace('-', '−');

/** Every lint of the spline, node by node in pre-order: unreachable knots, then the node's overshoot. */
export function splineLints(s: NestedSpline, leaf: SplineLeaf, params: Params, probe: Float64Array): SplineLint[] {
  const v = leafView(leaf);
  const out: SplineLint[] = [];
  const walk = (node: NestedSpline, nodePath: KnotPath): void => {
    const L = reachLimit(node.coord, params);
    for (const k of unreachableKnots(node, L)) {
      out.push({
        nodePath, knot: k, kind: 'unreachable',
        message: `knot ${k} (${node.coord}=${formatCoordValue(node.points[k]!.x)}) is unreachable: ${node.coord} stays within ±${L.toFixed(4)}`,
      });
    }
    const o = curveOvershoot(node, probe, v.yMin, v.yMax);
    if (o !== null) {
      let k = 0;
      while (k < node.points.length - 2 && o.x >= node.points[k + 1]!.x) k++;
      out.push({
        nodePath, knot: k, kind: 'overshoot',
        message: `the curve leaves ${minus(String(v.yMin))}…${minus(String(v.yMax))} by ${o.by.toFixed(1)} ${v.unit} at ${node.coord}=${formatCoordValue(o.x)}`,
      });
    }
    node.points.forEach((p, k) => { if (typeof p.y !== 'number') walk(p.y, [...nodePath, k]); });
  };
  walk(s, []);
  return out;
}

// ---------------------------------------------------------------- probes
/** The coords the plot does not show but the curve reads: those of the node's descendants, in slot order. */
export function probeCoords(node: NestedSpline): SplineCoord[] {
  let mask = 0;
  const walk = (n: NestedSpline): void => {
    for (const p of n.points) {
      if (typeof p.y !== 'number') {
        mask |= 1 << SPLINE_SLOT[p.y.coord];
        walk(p.y);
      }
    }
  };
  walk(node);
  return SPLINE_COORDS.filter((c) => c !== node.coord && ((mask >> SPLINE_SLOT[c]) & 1) === 1);
}

/** A coords vector (Float64Array(6) in SPLINE_COORDS order) from the probe sliders; missing coords are 0. */
export function probeVector(values: Readonly<Partial<Record<SplineCoord, number>>>): Float64Array {
  return Float64Array.from(SPLINE_COORDS, (c) => values[c] ?? 0);
}

/** A copy of `probe` with `coord` set to x. */
export function withCoord(probe: Float64Array, coord: SplineCoord, x: number): Float64Array {
  const c = Float64Array.from(probe);
  c[SPLINE_SLOT[coord]] = x;
  return c;
}

// ---------------------------------------------------------------- plot
export interface PlotBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A plot area in SVG pixels (y down) and its data ranges. */
export interface Plot extends PlotBox {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

/** x over [min(−1, x_first), max(1, x_last)] so every knot shows; y over the leaf range. */
export function plotFor(node: NestedSpline, yMin: number, yMax: number, box: PlotBox): Plot {
  const pts = node.points;
  return {
    left: box.left, top: box.top, width: box.width, height: box.height,
    xMin: Math.min(-1, pts[0]!.x), xMax: Math.max(1, pts[pts.length - 1]!.x), yMin, yMax,
  };
}

export function toPx(p: Plot, x: number, y: number): { readonly px: number; readonly py: number } {
  return { px: p.left + ((x - p.xMin) * p.width) / (p.xMax - p.xMin), py: p.top + ((p.yMax - y) * p.height) / (p.yMax - p.yMin) };
}

export function fromPx(p: Plot, px: number, py: number): { readonly x: number; readonly y: number } {
  return { x: p.xMin + ((px - p.left) * (p.xMax - p.xMin)) / p.width, y: p.yMax - ((py - p.top) * (p.yMax - p.yMin)) / p.height };
}

/** A knot as drawn: a nested knot (hollow) sits at its child's value at the probe. */
export interface KnotView {
  readonly x: number;
  readonly y: number;
  readonly d: number;
  readonly nested: boolean;
}

export function knotViews(node: NestedSpline, probe: Float64Array): KnotView[] {
  return node.points.map((p) => (typeof p.y === 'number'
    ? { x: p.x, y: p.y, d: p.d, nested: false }
    : { x: p.x, y: evalSplineRef(p.y, probe), d: p.d, nested: true }));
}

/** The knot nearest to (px, py) within radiusPx, or null; on a tie the later knot (drawn on top). */
export function hitKnot(p: Plot, knots: readonly KnotView[], px: number, py: number, radiusPx: number): number | null {
  let best: number | null = null;
  let bestD2 = radiusPx * radiusPx;
  for (let k = 0; k < knots.length; k++) {
    const q = toPx(p, knots[k]!.x, knots[k]!.y);
    const d2 = (q.px - px) * (q.px - px) + (q.py - py) * (q.py - py);
    if (d2 <= bestD2) { best = k; bestD2 = d2; }
  }
  return best;
}

/** The two tangent handles of a knot, lengthPx either side along its tangent in pixel space (left first). */
export function tangentHandles(p: Plot, knot: KnotView, lengthPx: number): readonly [{ readonly px: number; readonly py: number }, { readonly px: number; readonly py: number }] {
  const c = toPx(p, knot.x, knot.y);
  const dx = p.width / (p.xMax - p.xMin);
  const dy = (-knot.d * p.height) / (p.yMax - p.yMin);
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = (lengthPx * dx) / len;
  const uy = (lengthPx * dy) / len;
  return [{ px: c.px - ux, py: c.py - uy }, { px: c.px + ux, py: c.py + uy }];
}

/** Whether (px, py) is within radiusPx of one of the knot's tangent handles. */
export function hitHandle(p: Plot, knot: KnotView, px: number, py: number, lengthPx: number, radiusPx: number): boolean {
  return tangentHandles(p, knot, lengthPx).some((h) => (h.px - px) * (h.px - px) + (h.py - py) * (h.py - py) <= radiusPx * radiusPx);
}

/**
 * The tangent a handle drag sets: the slope from the knot to the pointer in data units, on either side,
 * clamped to ±1e5 (§6.1) and q15. Straight above or below the knot gives ±1e5; the knot itself keeps d.
 */
export function tangentFromPointer(p: Plot, knot: KnotView, px: number, py: number): number {
  const { x, y } = fromPx(p, px, py);
  const dx = x - knot.x;
  const dy = y - knot.y;
  if (dx === 0) return dy === 0 ? knot.d : dy > 0 ? SPLINE_MAX_ABS_D : -SPLINE_MAX_ABS_D;
  const d = dy / dx;
  return q15(d > SPLINE_MAX_ABS_D ? SPLINE_MAX_ABS_D : d < -SPLINE_MAX_ABS_D ? -SPLINE_MAX_ABS_D : d) + 0;
}

// ---------------------------------------------------------------- dragging and inserting
/** The smallest distance a drag leaves between neighbouring knots (spec §4.2). */
export const KNOT_GAP = 1 / 1024;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Where a knot drag lands (q15): x between its neighbours at least KNOT_GAP apart (end knots within
 * [−2, 2]), y within [yMin, yMax]. Neighbours closer than 2 × KNOT_GAP keep x; NaN keeps the knot's value
 * (yMin for a nested knot, whose y the caller does not send).
 */
export function clampKnotDrag(node: NestedSpline, k: number, x: number, y: number, yMin: number, yMax: number): { readonly x: number; readonly y: number } {
  const pts = node.points;
  const knot = pts[k];
  if (knot === undefined) throw new Error(`no knot ${k}`);
  const lo = k > 0 ? pts[k - 1]!.x + KNOT_GAP : -SPLINE_MAX_ABS_X;
  const hi = k < pts.length - 1 ? pts[k + 1]!.x - KNOT_GAP : SPLINE_MAX_ABS_X;
  const nx = Number.isNaN(x) || lo > hi ? knot.x : clamp(x, lo, hi);
  const ny = Number.isNaN(y) ? (typeof knot.y === 'number' ? knot.y : yMin) : clamp(y, yMin, yMax);
  return { x: q15(nx) + 0, y: q15(ny) + 0 };
}

/** The knot a double-click inserts (q15): x within [−2, 2], y the curve at x (probe) within the range. */
export function pointOnCurve(node: NestedSpline, probe: Float64Array, x: number, yMin: number, yMax: number): { readonly x: number; readonly y: number } {
  const cx = clamp(x, -SPLINE_MAX_ABS_X, SPLINE_MAX_ABS_X);
  const y = evalSplineRef(node, withCoord(probe, node.coord, cx));
  return { x: q15(cx) + 0, y: q15(clamp(y, yMin, yMax)) + 0 };
}

// ---------------------------------------------------------------- breadcrumbs and tree
/** A coordinate value for labels: at most 3 decimals, at least 2, with a real minus sign (0.30, −0.40, 0.125). */
export function formatCoordValue(x: number): string {
  const t = (Math.round(x * 1000) / 1000).toFixed(3);
  return minus(t.endsWith('0') ? t.slice(0, -1) : t);
}

export interface Crumb {
  readonly label: string;
  /** The node the crumb opens. */
  readonly nodePath: KnotPath;
}

/** Joins crumb labels: `offset › C=0.30 › E=−0.40`. */
export const CRUMB_SEPARATOR = ' › ';

/** The leaf key, then `coord=x` of each knot on the path down to the node. Throws on a bad node path. */
export function breadcrumbs(leaf: SplineLeaf, s: NestedSpline, nodePath: KnotPath): Crumb[] {
  nodeAt(s, nodePath);
  const out: Crumb[] = [{ label: leafView(leaf).key, nodePath: [] }];
  let node = s;
  for (let i = 0; i < nodePath.length; i++) {
    const knot = node.points[nodePath[i]!]!;
    out.push({ label: `${node.coord}=${formatCoordValue(knot.x)}`, nodePath: nodePath.slice(0, i + 1) });
    node = knot.y as NestedSpline;
  }
  return out;
}

export interface TreeRow {
  readonly nodePath: KnotPath;
  readonly depth: number;
  /** `C=0.30 → E (5 knots)`; the root row starts with the leaf key. */
  readonly label: string;
}

/** Every node of the spline in pre-order with its coord and knot count. */
export function splineTree(leaf: SplineLeaf, s: NestedSpline): TreeRow[] {
  const out: TreeRow[] = [];
  const knots = (n: NestedSpline) => `${n.coord} (${n.points.length} ${n.points.length === 1 ? 'knot' : 'knots'})`;
  const walk = (node: NestedSpline, nodePath: KnotPath, head: string): void => {
    out.push({ nodePath, depth: nodePath.length, label: `${head} → ${knots(node)}` });
    node.points.forEach((p, k) => {
      if (typeof p.y !== 'number') walk(p.y, [...nodePath, k], `${node.coord}=${formatCoordValue(p.x)}`);
    });
  };
  walk(s, [], leafView(leaf).key);
  return out;
}

// ---------------------------------------------------------------- the drawer
/** Whether a parameter path is one of the spline leaves the drawer opens. */
export function isSplineLeaf(path: string): path is SplineLeaf {
  return (SPLINE_LEAVES as readonly string[]).includes(path);
}

/**
 * The longest prefix of `nodePath` that still addresses a nested node of `s`: the node the drawer shows after
 * an undo, a reset or an import removed or replaced the one it had open.
 */
export function followNode(s: NestedSpline, nodePath: KnotPath): KnotPath {
  const out: number[] = [];
  let node = s;
  for (const k of nodePath) {
    const p = node.points[k];
    if (p === undefined || typeof p.y === 'number') break;
    out.push(k);
    node = p.y;
  }
  return out;
}

/** The coords "nest" offers for the knot at `path`: the leaf's coords that no node from the root down to the knot's node uses. Throws on a bad path. */
export function nestCoords(leaf: SplineLeaf, s: NestedSpline, path: KnotPath): SplineCoord[] {
  knotAt(s, path);
  const used = new Set<SplineCoord>([s.coord]);
  let node = s;
  for (const k of path.slice(0, -1)) {
    node = node.points[k]!.y as NestedSpline;
    used.add(node.coord);
  }
  return leafView(leaf).coords.filter((c) => !used.has(c));
}

function nodePathsOf(s: NestedSpline, at: KnotPath): KnotPath[] {
  const out: KnotPath[] = [at];
  s.points.forEach((p, k) => { if (typeof p.y !== 'number') out.push(...nodePathsOf(p.y, [...at, k])); });
  return out;
}

/**
 * "Auto tangents (spline)": autoTangentsAt on every node in pre-order, so SP1's autoTangents(s) with every
 * automatic tangent clamped to ±1e5 like the node action (§6.1).
 */
export function autoTangentsAll(s: NestedSpline, opts: SplineOpts): SplineEdit {
  let cur = s;
  for (const nodePath of nodePathsOf(s, [])) {
    const r = autoTangentsAt(cur, nodePath, opts);
    if (!r.ok) return r;
    cur = r.value;
  }
  return { ok: true, value: cur };
}

/** A `splineStats` request for the open node (spec §4.3): the pool's n and args, and the knot xs that summarise its sum. */
export interface NodeStatsRequest {
  readonly n: number;
  readonly args: { readonly len: number; readonly leaf: SplineLeaf; readonly node: KnotPath };
  readonly knotXs: readonly number[];
}

/** Throws on a bad node path. */
export function nodeStatsRequest(params: Params, leaf: SplineLeaf, nodePath: KnotPath): NodeStatsRequest {
  const node = nodeAt(splineOfLeaf(params, leaf), nodePath);
  return { n: SPLINE_STATS_POINTS, args: { len: splineStatsLength(node.points.length), leaf, node: [...nodePath] }, knotXs: node.points.map((p) => p.x) };
}

/** What a statistics result describes: the session epoch of the draft it ran on and the node. */
export interface StatsTarget {
  readonly epoch: number;
  readonly leaf: SplineLeaf;
  readonly nodePath: KnotPath;
  readonly coord: SplineCoord;
}

const sameNode = (a: StatsTarget, b: StatsTarget): boolean =>
  a.leaf === b.leaf && a.coord === b.coord && a.nodePath.length === b.nodePath.length && a.nodePath.every((k, i) => k === b.nodePath[i]);

/** Whether `a` is exactly `b` (same epoch and node): a result or a request that needs no new request. */
export function sameStatsTarget(a: StatsTarget | null, b: StatsTarget): boolean {
  return a !== null && a.epoch === b.epoch && sameNode(a, b);
}

export type OverlayState = 'fresh' | 'stale' | 'none';

/**
 * How the overlays show the last result for the open node: fresh when it ran on the current draft and no
 * gesture is active; stale from the next session change (or during a gesture) until a new result arrives;
 * none when it belongs to another node.
 */
export function overlayState(shown: StatsTarget | null, now: StatsTarget, inGesture: boolean): OverlayState {
  if (shown === null || !sameNode(shown, now)) return 'none';
  return !inGesture && shown.epoch === now.epoch ? 'fresh' : 'stale';
}

/** Axis ticks: the multiples of a 1, 2 or 5 × 10^k step inside [lo, hi], the finest step giving at most maxCount. */
export function niceTicks(lo: number, hi: number, maxCount: number): number[] {
  if (!(hi > lo) || !(maxCount >= 2)) return [];
  let mag = Math.pow(10, Math.floor(Math.log10((hi - lo) / (maxCount - 1))));
  for (;;) {
    for (const m of [1, 2, 5]) {
      const step = m * mag;
      const i0 = Math.ceil(lo / step - 1e-9);
      const i1 = Math.floor(hi / step + 1e-9);
      if (i1 - i0 + 1 <= maxCount) {
        const out: number[] = [];
        for (let i = i0; i <= i1; i++) out.push(Number((i * step).toFixed(10)));
        return out;
      }
    }
    mag *= 10;
  }
}

/** A histogram bar in plot pixels: [x0, x1] and its height, drawn up from the plot's bottom. */
export interface Bar {
  readonly x0: number;
  readonly x1: number;
  readonly height: number;
}

/** The histogram's equal bins over [−1, 1] (whatever the plot's x range), the largest bin maxHeightPx high. */
export function histogramBars(p: Plot, histogram: ArrayLike<number>, maxHeightPx: number): Bar[] {
  const n = histogram.length;
  let max = 0;
  for (let b = 0; b < n; b++) if (histogram[b]! > max) max = histogram[b]!;
  const out: Bar[] = [];
  for (let b = 0; b < n; b++) {
    out.push({ x0: toPx(p, -1 + (2 * b) / n, 0).px, x1: toPx(p, -1 + (2 * (b + 1)) / n, 0).px, height: max > 0 ? (histogram[b]! / max) * maxHeightPx : 0 });
  }
  return out;
}

/** A region of the node (summarizeSplineStats order) as drawn: its x interval clipped to the plot, in pixels, with its shares. */
export interface Band {
  readonly index: number;
  readonly x0: number;
  readonly x1: number;
  readonly land: number;
  readonly world: number;
}

export function regionBands(p: Plot, regions: readonly SplineRegionShare[]): Band[] {
  const out: Band[] = [];
  regions.forEach((r, index) => {
    const lo = r.lo > p.xMin ? r.lo : p.xMin;
    const hi = r.hi < p.xMax ? r.hi : p.xMax;
    if (hi > lo) out.push({ index, x0: toPx(p, lo, 0).px, x1: toPx(p, hi, 0).px, land: r.land, world: r.world });
  });
  return out;
}

/** A share as a percentage with one decimal: `7.3 %`. */
export function formatShare(f: number): string {
  return `${(f * 100).toFixed(1)} %`;
}

/** `C < 0.30` (left hold), `0.30 ≤ C < 0.55` (segment), `C ≥ 0.80` (right hold). */
export function regionLabel(coord: SplineCoord, r: SplineRegionShare): string {
  if (r.lo === -Infinity) return `${coord} < ${formatCoordValue(r.hi)}`;
  if (r.hi === Infinity) return `${coord} ≥ ${formatCoordValue(r.lo)}`;
  return `${formatCoordValue(r.lo)} ≤ ${coord} < ${formatCoordValue(r.hi)}`;
}

/** `0.30 ≤ C < 0.55: 7.3 % of land, 4.1 % of the world` (spec §4.3). */
export function regionText(coord: SplineCoord, r: SplineRegionShare): string {
  return `${regionLabel(coord, r)}: ${formatShare(r.land)} of land, ${formatShare(r.world)} of the world`;
}

/** The statistics line: the stream's point and land counts, and for a nested node its mean weights (the sums of its shares). */
export function statsText(sm: SplineStatsSummary, nested: boolean): string {
  const base = `${sm.points} points, ${formatShare(sm.points > 0 ? sm.landPoints / sm.points : 0)} land`;
  return nested ? `${base}; this node weighs ${formatShare(sm.meanWeight)} of the world and ${formatShare(sm.meanLandWeight)} of land` : base;
}

const px2 = (v: number): number => Math.round(v * 100) / 100;

/** An SVG path `M…L…` through the samples, in plot pixels rounded to 2 decimals. */
export function curvePath(p: Plot, xs: ArrayLike<number>, ys: ArrayLike<number>): string {
  let d = '';
  for (let j = 0; j < xs.length; j++) {
    const q = toPx(p, xs[j]!, ys[j]!);
    d += `${j === 0 ? 'M' : 'L'}${px2(q.px)},${px2(q.py)}`;
  }
  return d;
}

/** A lint entry: the crumbs of its node, then its message (`offset › C=0.20: knot 0 (E=−1.50) is unreachable: …`). */
export function lintText(leaf: SplineLeaf, s: NestedSpline, lint: SplineLint): string {
  return `${breadcrumbs(leaf, s, lint.nodePath).map((c) => c.label).join(CRUMB_SEPARATOR)}: ${lint.message}`;
}

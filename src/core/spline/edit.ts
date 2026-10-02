/**
 * Pure spline edit operations (SP2b spec §4.1). Every operation addresses knots with a KnotPath (SP1
 * addressing: [7, 1, 1] = points[7].y.points[1].y.points[1]) and nodes with a node path ([] = the root,
 * [7, 1] = the child spline in points[7].y.points[1].y), never mutates its input, and returns the edited
 * spline validated with validateSpline(result, '', opts) and q15-normalised as checkSpline does, or every
 * issue with its path from the spline root. A path that addresses no node or knot is a programming error
 * and throws. Tangents are data: no operation changes a tangent it was not asked to change.
 */
import { q15 } from '../params/canonical';
import { evalSplineRef, knotPathToString } from './hermite';
import { autoTangents } from './tangents';
import { SPLINE_MAX_ABS_D, type KnotPath, type NestedSpline, type SplineCoord, type SplineOpts, type SplinePoint } from './types';
import { normalizeSpline, validateSpline, type SplineErrorCode, type SplineIssue } from './validate';

const Q15 = q15;
const EVAL = evalSplineRef;
const PATH_TEXT = knotPathToString;
const AUTO = autoTangents;
const NORMALIZE = normalizeSpline;
const VALIDATE = validateSpline;
const MAX_ABS_D = SPLINE_MAX_ABS_D;

export type SplineEdit = { readonly ok: true; readonly value: NestedSpline } | { readonly ok: false; readonly issues: readonly SplineIssue[] };

function knotIndex(node: NestedSpline, path: KnotPath, depth: number): number {
  const k = path[depth];
  if (k === undefined || !Number.isInteger(k) || k < 0 || k >= node.points.length) {
    throw new Error(`no knot at ${PATH_TEXT(path.slice(0, depth + 1))}`);
  }
  return k;
}

function child(node: NestedSpline, path: KnotPath, depth: number): NestedSpline {
  const y = node.points[knotIndex(node, path, depth)]!.y;
  if (typeof y === 'number') throw new Error(`the knot at ${PATH_TEXT(path.slice(0, depth + 1))} holds a number, not a nested spline`);
  return y;
}

/** The node at `nodePath`: [] is the root; [k, …] is the child spline in knot k's y. Throws on a bad path. */
export function nodeAt(s: NestedSpline, nodePath: KnotPath): NestedSpline {
  let node = s;
  for (let i = 0; i < nodePath.length; i++) node = child(node, nodePath, i);
  return node;
}

/** The knot at `path` (non-empty). Throws on a bad path. */
export function knotAt(s: NestedSpline, path: KnotPath): SplinePoint {
  if (path.length === 0) throw new Error('empty knot path');
  const node = nodeAt(s, path.slice(0, -1));
  return node.points[knotIndex(node, path, path.length - 1)]!;
}

/** Copies the nodes from the root down to the node at `nodePath` and lets `edit` change that node's points copy. */
function withNode(s: NestedSpline, nodePath: KnotPath, depth: number, edit: (points: SplinePoint[]) => void): NestedSpline {
  const points = s.points.slice();
  if (depth === nodePath.length) {
    edit(points);
  } else {
    const k = knotIndex(s, nodePath, depth);
    const p = points[k]!;
    points[k] = { x: p.x, y: withNode(child(s, nodePath, depth), nodePath, depth + 1, edit), d: p.d };
  }
  return { coord: s.coord, points };
}

/** Replaces the knot at `path` (already checked by knotAt). */
function withKnot(s: NestedSpline, path: KnotPath, knot: SplinePoint): NestedSpline {
  const k = path[path.length - 1]!;
  return withNode(s, path.slice(0, -1), 0, (points) => { points[k] = knot; });
}

function finish(s: NestedSpline, opts: SplineOpts): SplineEdit {
  const issues = VALIDATE(s, '', opts);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: NORMALIZE(s) };
}

function refuse(path: string, code: SplineErrorCode, message: string): SplineEdit {
  return { ok: false, issues: [{ path, code, message }] };
}

/** An automatic tangent clamped to ±SPLINE_MAX_ABS_D, so a steep PCHIP slope never refuses an insert or an auto action. */
function clampAuto(d: number): number {
  return d > MAX_ABS_D ? MAX_ABS_D : d < -MAX_ABS_D ? -MAX_ABS_D : d;
}

/** Sets a knot's x, numeric y or tangent d; the other knots are untouched. Setting y on a nested knot gives Y_BAD_TYPE. */
export function setKnot(s: NestedSpline, path: KnotPath, f: { readonly x?: number; readonly y?: number; readonly d?: number }, opts: SplineOpts): SplineEdit {
  const knot = knotAt(s, path);
  if (f.y !== undefined && typeof knot.y !== 'number') {
    return refuse(`${PATH_TEXT(path)}.y`, 'Y_BAD_TYPE', 'the knot holds a nested spline; flatten it before setting a number');
  }
  return finish(withKnot(s, path, { x: f.x ?? knot.x, y: f.y ?? knot.y, d: f.d ?? knot.d }), opts);
}

/**
 * Inserts a numeric knot into the node at `nodePath`, after every knot whose q15(x) ≤ q15(x) (so a
 * duplicate x reports X_DUPLICATE on the new knot). Its tangent is SP1's autoTangents rule at that knot,
 * clamped to ±SPLINE_MAX_ABS_D; the other tangents are untouched.
 */
export function insertKnot(s: NestedSpline, nodePath: KnotPath, x: number, y: number, opts: SplineOpts): SplineEdit {
  const pts = nodeAt(s, nodePath).points;
  const qx = Q15(x);
  let j = 0;
  while (j < pts.length && Q15(pts[j]!.x) <= qx) j++;
  const draft = withNode(s, nodePath, 0, (points) => { points.splice(j, 0, { x, y, d: 0 }); });
  const issues = VALIDATE(draft, '', opts);
  if (issues.length > 0) return { ok: false, issues };
  const norm = NORMALIZE(draft);
  const d = clampAuto(AUTO(nodeAt(norm, nodePath)).points[j]!.d);
  return finish(withNode(norm, nodePath, 0, (points) => { points[j] = { x: points[j]!.x, y: points[j]!.y, d }; }), opts);
}

/** Removes a knot (a nested knot with its whole child spline); a node cannot lose its last knot (EMPTY). */
export function deleteKnot(s: NestedSpline, path: KnotPath, opts: SplineOpts): SplineEdit {
  knotAt(s, path);
  const k = path[path.length - 1]!;
  return finish(withNode(s, path.slice(0, -1), 0, (points) => { points.splice(k, 1); }), opts);
}

/**
 * Turns a numeric knot into a child spline over `coord` with two flat knots {x: −1, y, d: 0} and
 * {x: 1, y, d: 0}; the knot keeps its x and d, so the value is unchanged everywhere. `coord` must be one
 * of the leaf's coords (BAD_COORD) and unused on the path (COORD_REUSED); a nested knot gives Y_BAD_TYPE.
 */
export function nestKnot(s: NestedSpline, path: KnotPath, coord: SplineCoord, opts: SplineOpts): SplineEdit {
  const knot = knotAt(s, path);
  const y = knot.y;
  if (typeof y !== 'number') return refuse(`${PATH_TEXT(path)}.y`, 'Y_BAD_TYPE', 'the knot already holds a nested spline');
  const nested: NestedSpline = { coord, points: [{ x: -1, y, d: 0 }, { x: 1, y, d: 0 }] };
  return finish(withKnot(s, path, { x: knot.x, y: nested, d: knot.d }), opts);
}

/**
 * Replaces a knot's child spline with its value at `probe` (Float64Array(6) in SPLINE_COORDS order); the
 * knot keeps its x and d. A numeric knot gives Y_BAD_TYPE; a value outside the leaf range, Y_OUT_OF_RANGE.
 */
export function flattenKnot(s: NestedSpline, path: KnotPath, probe: Float64Array, opts: SplineOpts): SplineEdit {
  const knot = knotAt(s, path);
  if (typeof knot.y === 'number') return refuse(`${PATH_TEXT(path)}.y`, 'Y_BAD_TYPE', 'the knot holds a number, not a nested spline');
  return finish(withKnot(s, path, { x: knot.x, y: EVAL(knot.y, probe), d: knot.d }), opts);
}

/**
 * Recomputes the tangents of the node's own knots with SP1's autoTangents rule (not its children's), each
 * clamped to ±SPLINE_MAX_ABS_D.
 */
export function autoTangentsAt(s: NestedSpline, nodePath: KnotPath, opts: SplineOpts): SplineEdit {
  const auto = AUTO(nodeAt(s, nodePath)).points;
  return finish(withNode(s, nodePath, 0, (points) => {
    for (let k = 0; k < points.length; k++) points[k] = { x: points[k]!.x, y: points[k]!.y, d: clampAuto(auto[k]!.d) };
  }), opts);
}

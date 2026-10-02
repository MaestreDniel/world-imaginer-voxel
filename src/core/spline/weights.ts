import { SPLINE_SLOT } from './types';
import type { KnotPath, NestedSpline } from './types';

const SLOT = SPLINE_SLOT;

/**
 * Hermite value-basis weight of knot k of one node at coords (tangents fixed): 1 on the hold side of an
 * end knot, h00(t) = 2t³ − 3t² + 1 for the left knot of the segment holding the coord, h01(t) = 3t² − 2t³
 * for the right knot, else 0. Reads x as stored, like the SP2a harness version.
 */
function knotWeight(s: NestedSpline, k: number, c: Float64Array): number {
  const pts = s.points;
  const n = pts.length;
  const q = c[SLOT[s.coord]]!;
  if (q <= pts[0]!.x) return k === 0 ? 1 : 0;
  if (q >= pts[n - 1]!.x) return k === n - 1 ? 1 : 0;
  let i = 0;
  while (q >= pts[i + 1]!.x) i++;
  const t = (q - pts[i]!.x) / (pts[i + 1]!.x - pts[i]!.x);
  const t2 = t * t;
  const t3 = t2 * t;
  return k === i ? 2 * t3 - 3 * t2 + 1 : k === i + 1 ? -2 * t3 + 3 * t2 : 0;
}

/** Right-nested product w0 · (w1 · (w2 · …)), stopping at the first zero, as the SP2a harness version. */
function weightFrom(s: NestedSpline, path: KnotPath, depth: number, c: Float64Array): number {
  const k = path[depth]!;
  const w = knotWeight(s, k, c);
  if (depth === path.length - 1 || w === 0) return w;
  const y = s.points[k]!.y;
  if (typeof y === 'number') throw new Error(`knot path [${path.join(', ')}] descends into a numeric knot`);
  return w * weightFrom(y, path, depth + 1, c);
}

/**
 * Product of the Hermite value-basis weights of the knot along `path` at `coords` (Float64Array(6) in
 * SPLINE_COORDS order): how much a change of that knot's y moves the spline there (T6, the editor's
 * statistics; SP2b spec §4.1). Moved from test/harness/spline.ts and written without `**`; it agrees with
 * the SP2a version within 1e-15. Zero allocation.
 */
export function pathWeight(s: NestedSpline, path: KnotPath, coords: Float64Array): number {
  if (path.length === 0) throw new Error('empty knot path');
  return weightFrom(s, path, 0, coords);
}

/** Weight of the node at `nodePath` ([] = the root, weight 1): the weight of the knot that holds it. */
export function nodeWeight(s: NestedSpline, nodePath: KnotPath, coords: Float64Array): number {
  return nodePath.length === 0 ? 1 : pathWeight(s, nodePath, coords);
}

import type { NestedSpline } from '../../src/core/spline/types';
import { SPLINE_SLOT } from '../../src/core/spline/types';

/** Product of Hermite value-basis weights of the knot along `path` (tangents fixed). */
export function pathWeight(s: NestedSpline, path: readonly number[], c: Float64Array): number {
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
  return w * pathWeight(s.points[k!]!.y as NestedSpline, rest, c);
}

/** The numeric y of the knot at `path`. */
export function knotY(s: NestedSpline, path: readonly number[]): number {
  let node = s;
  for (let i = 0; i < path.length - 1; i++) node = node.points[path[i]!]!.y as NestedSpline;
  return node.points[path[path.length - 1]!]!.y as number;
}

import type { NestedSpline } from '../../src/core/spline/types';

/** Moved to src/core/spline/weights.ts (SP2b spec §4.1); re-exported for T6 and the fixture tests. */
export { pathWeight } from '../../src/core/spline/weights';

/** The numeric y of the knot at `path`. */
export function knotY(s: NestedSpline, path: readonly number[]): number {
  let node = s;
  for (let i = 0; i < path.length - 1; i++) node = node.points[path[i]!]!.y as NestedSpline;
  return node.points[path[path.length - 1]!]!.y as number;
}

export type SplineCoord = 'C' | 'E' | 'W' | 'PV' | 'T' | 'H';

/** Slot order of the coordinates vector (Float64Array(6)). */
export const SPLINE_COORDS: readonly SplineCoord[] = ['C', 'E', 'W', 'PV', 'T', 'H'];
export const SPLINE_SLOT: Readonly<Record<SplineCoord, number>> = { C: 0, E: 1, W: 2, PV: 3, T: 4, H: 5 };
export const SPLINE_MAX_POINTS = 32;
export const SPLINE_MAX_OBJECTS = 4096;
/** Knots are legal up to |x| ≤ 2 (SP2b §6.1); the climate never reaches beyond ±1. */
export const SPLINE_MAX_ABS_X = 2;
/** Tangents are legal up to |d| ≤ 1e5 output units per unit of the node's coordinate (SP2b §6.1). */
export const SPLINE_MAX_ABS_D = 1e5;

/** d = dy/dx in output units per unit of the node's own coordinate (explicit data; never re-derived). */
export interface SplinePoint {
  readonly x: number;
  readonly y: number | NestedSpline;
  readonly d: number;
}

export interface NestedSpline {
  readonly coord: SplineCoord;
  readonly points: readonly SplinePoint[];
}

/** [7, 1, 1] = points[7].y.points[1].y.points[1]. */
export type KnotPath = readonly number[];

/** Leaf constraints; defaults: every coordinate allowed, y unbounded. */
export interface SplineOpts {
  readonly coords?: readonly SplineCoord[];
  readonly yMin?: number;
  readonly yMax?: number;
}

/**
 * Defaults of the shape splines (master §3.3, SP2a spec §2.2), authored with autoTangents. They start
 * equal to SP1's frozen OFFSET / SIGMA / JAG fixtures; a unit test pins that until the first retune.
 */
import { autoTangents } from '../spline/tangents';
import type { NestedSpline, SplineCoord } from '../spline/types';

type Knot = readonly [number, number | NestedSpline];
const S = (coord: SplineCoord, knots: readonly Knot[]): NestedSpline => ({ coord, points: knots.map(([x, y]) => ({ x, y, d: 0 })) });
const PV3 = (a: number, b: number, c: number): NestedSpline => S('PV', [[-1, a], [0, b], [1, c]]);
const PVJ = (): NestedSpline => S('PV', [[0.3, 0], [0.7, 30], [1.0, 55]]);

export const OFFSET_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-1, 16], [-0.6, 26], [-0.4, 40], [-0.24, 52], [-0.16, 60],
  [-0.1, S('E', [[-1, 70], [0, 64], [1, 63]])],
  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(65, 72, 80)], [1, 66]])],
  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(66, 76, 88)], [0.6, 70], [1, 66]])],
  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(68, 82, 96)], [1, 70]])],
]));

export const SIGMA_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-1, 3], [-0.16, 3], [-0.1, 1.5],
  [0.05, S('E', [[-1, S('PV', [[-1, 4], [1, 16]])], [0, 3], [1, 1.2]])],
]));

export const JAG_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-0.1, 0],
  [0.05, S('E', [[-1, PVJ()], [-0.5, PVJ()], [-0.4, 0]])],
]));

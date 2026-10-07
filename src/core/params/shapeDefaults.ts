/**
 * Defaults of the shape splines (master §3.3, SP2a spec §2.2), authored with autoTangents. They started
 * equal to SP1's frozen OFFSET / SIGMA / JAG fixtures. SP3b's retune (SP3b spec §8.4) raised the lowland
 * offset knots (C ≥ 0.05, E ≥ 0.2) and the C 0.05 sigma node; jag is unchanged. A unit test
 * (terrainRetune.test.ts) pins exactly which knots differ from the fixtures.
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
  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(72, 84, 98)], [1, 76]])],
  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(78, 92, 108)], [0.6, 90], [1, 86]])],
  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(86, 104, 124)], [1, 102]])],
]));

export const SIGMA_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-1, 3], [-0.16, 3], [-0.1, 1.5],
  [0.05, S('E', [[-1, S('PV', [[-1, 12], [1, 26]])], [0, 6], [1, 3]])],
]));

export const JAG_DEFAULT: NestedSpline = autoTangents(S('C', [
  [-0.1, 0],
  [0.05, S('E', [[-1, PVJ()], [-0.5, PVJ()], [-0.4, 0]])],
]));

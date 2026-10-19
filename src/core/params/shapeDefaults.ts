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

/*
 * The archipelago preset's splines (SP3e spec §1.3, D8): the defaults' knots and values carried through the C map
 * φ (shift 0.42: C + 0.42 for C ≥ −0.24; below, piecewise linear through (−1, −1), (−0.6, −0.39), (−0.4, −0.05),
 * (−0.24, 0.18)), so the shore (offset0 = 63) lies at C 0.26-0.32 and every C < 0.2 is ocean. Offset drops the
 * default's C 0.3 and 0.6 knots (the big-mountain E splines): beyond its last knot a spline holds its last value,
 * so every C ≥ 0.47 is near-inland (offset0 ≤ 130). Every value is written as its literal (in doubles
 * −0.22 + 0.42 is not 0.2). A unit test (archipelago.test.ts) pins the knots against φ of the defaults.
 */
export const ARCHIPELAGO_OFFSET: NestedSpline = autoTangents(S('C', [
  [-1, 16], [-0.39, 26], [-0.05, 40], [0.18, 52], [0.26, 60],
  [0.32, S('E', [[-1, 70], [0, 64], [1, 63]])],
  [0.47, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(72, 84, 98)], [1, 76]])],
]));

export const ARCHIPELAGO_SIGMA: NestedSpline = autoTangents(S('C', [
  [-1, 3], [0.26, 3], [0.32, 1.5],
  [0.47, S('E', [[-1, S('PV', [[-1, 12], [1, 26]])], [0, 6], [1, 3]])],
]));

export const ARCHIPELAGO_JAG: NestedSpline = autoTangents(S('C', [
  [0.32, 0],
  [0.47, S('E', [[-1, PVJ()], [-0.5, PVJ()], [-0.4, 0]])],
]));

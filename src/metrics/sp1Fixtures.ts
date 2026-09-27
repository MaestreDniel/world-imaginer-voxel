/**
 * Frozen SP1 fixtures (SP1 spec Appendix B). Used by tests, benches, goldens and the lab. Changing any
 * of this changes goldens (a GENERATOR_VERSION bump once they are recorded). Follows the core rules.
 */
import { completeNoiseDef } from '../core/noise/types';
import type { NoiseDef } from '../core/noise/types';
import { autoTangents } from '../core/spline/tangents';
import type { NestedSpline, SplineCoord } from '../core/spline/types';

const COMPLETE = completeNoiseDef;
const AUTO = autoTangents;

type Knot = readonly [number, number | NestedSpline];
const S = (coord: SplineCoord, knots: readonly Knot[]): NestedSpline => ({ coord, points: knots.map(([x, y]) => ({ x, y, d: 0 })) });
const PV3 = (a: number, b: number, c: number): NestedSpline => S('PV', [[-1, a], [0, b], [1, c]]);
const PVJ = (): NestedSpline => S('PV', [[0.3, 0], [0.7, 30], [1.0, 55]]);

export const OFFSET: NestedSpline = AUTO(S('C', [
  [-1, 16], [-0.6, 26], [-0.4, 40], [-0.24, 52], [-0.16, 60],
  [-0.1, S('E', [[-1, 70], [0, 64], [1, 63]])],
  [0.05, S('E', [[-1, PV3(72, 96, 130)], [-0.4, PV3(68, 82, 100)], [0.2, PV3(65, 72, 80)], [1, 66]])],
  [0.3, S('E', [[-1, PV3(80, 125, 175)], [-0.4, PV3(72, 92, 120)], [0.2, PV3(66, 76, 88)], [0.6, 70], [1, 66]])],
  [0.6, S('E', [[-1, PV3(90, 150, 210)], [-0.4, PV3(76, 104, 140)], [0.2, PV3(68, 82, 96)], [1, 70]])],
]));

export const SIGMA: NestedSpline = AUTO(S('C', [
  [-1, 3], [-0.16, 3], [-0.1, 1.5],
  [0.05, S('E', [[-1, S('PV', [[-1, 4], [1, 16]])], [0, 3], [1, 1.2]])],
]));

export const JAG: NestedSpline = AUTO(S('C', [
  [-0.1, 0],
  [0.05, S('E', [[-1, PVJ()], [-0.5, PVJ()], [-0.4, 0]])],
]));

/** Explicit non-zero tangents and uneven spacing (catches the "tangent not multiplied by h" mutant). */
export const TANGENT_FIXTURE: NestedSpline = {
  coord: 'C',
  points: [
    { x: -0.9, y: 10, d: 12 },
    { x: -0.2, y: { coord: 'E', points: [{ x: -0.7, y: 5, d: -3 }, { x: 0.4, y: 20, d: 8 }, { x: 0.8, y: 14, d: -6 }] }, d: 4 },
    { x: 0.5, y: 30, d: -9 },
  ],
};

export interface FixtureNoise {
  readonly seedName: string;
  readonly def: NoiseDef;
  readonly dims: 2 | 3;
  /** Sample only at 4×8×4 cell corners (the λ 32 adversarial def). */
  readonly corners: boolean;
}

const warp = (name: string, wavelength: number, octaves: number): FixtureNoise[] => {
  const def = COMPLETE({ wavelength, octaves });
  return [
    { seedName: `${name}.x`, def, dims: 2, corners: false },
    { seedName: `${name}.z`, def, dims: 2, corners: false },
  ];
};
const climate = (name: string, wavelength: number, octaves: number): FixtureNoise => ({
  seedName: name, def: COMPLETE({ wavelength, octaves, remap: 'uniform' }), dims: 2, corners: false,
});

/** Frozen copies of the 12 SP1 schema instances, in schema pre-order. */
export const CLIMATE_FIXTURE_DEFS: readonly FixtureNoise[] = [
  ...warp('climate.warp.shift.noise', 256, 3),
  ...warp('climate.warp.C.noise', 1024, 2),
  ...warp('climate.warp.R.noise', 512, 2),
  climate('climate.C', 2400, 6),
  climate('climate.E', 1600, 5),
  climate('climate.W', 900, 5),
  climate('climate.T', 5000, 4),
  climate('climate.H', 2400, 4),
  climate('climate.R', 1400, 4),
];

export const DENSITY3D_DEF: FixtureNoise = { seedName: 'test.density3d', def: COMPLETE({ wavelength: 64, octaves: 4 }), dims: 3, corners: false };

export const ADVERSARIAL_DEFS: readonly FixtureNoise[] = [
  { seedName: 'test.adv2d16', def: COMPLETE({ wavelength: 16, octaves: 1, double: false }), dims: 2, corners: false },
  { seedName: 'test.adv3d8', def: COMPLETE({ wavelength: 8, octaves: 1, double: false }), dims: 3, corners: false },
  { seedName: 'test.adv3d32', def: COMPLETE({ wavelength: 32, octaves: 1, double: false }), dims: 3, corners: true },
];

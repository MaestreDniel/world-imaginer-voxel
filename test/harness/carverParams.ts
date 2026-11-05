/**
 * The carver parameters as `CarverParams` literals (SP6a spec §2.2, §4), for the carver tests until the carver leaves
 * land in the schema (Task 27, which pins `CARVER_DEFAULTS` equal to `carverParamsOf(DEFAULTS)`):
 * - `CARVER_DEFAULTS`: spec §4's defaults, with `caves.worms.shape` at §2.2's drift constants;
 * - `CARVER_MAXIMA`: every carver leaf at its static maximum, the end of its range (spec §4; where §4 gives none, the
 *   plan's ranges: `branchChance`, `roomChance` 0 … 1, `roomYScaleMin`/`Max` 0.1 … 0.9, `startYMin`/`Max` −64 … 320,
 *   `ravines.plateau` 0 … 8, `ravines.vRotation` 0 … 0.5, `worms.shape.pitchKeep`, `.yawDriftKeep` and
 *   `.pitchDriftKeep` 0 … 1 and the other four shape leaves 0 … 8 (ruling P17)); `reachOverflow`'s static-maxima case
 *   (Task 25 in `carverPaths.test.ts`, Task 30's C7) runs every path at these;
 * - `carverReachOf` and `carverWindowROf`: spec §2.1's L_max, r_max and window R for given leaves, which
 *   `test/unit/constants.test.ts` applies to `CARVER_MAXIMA` to recompute `CARVER_WINDOW_R`.
 */
import type { CarverParams, WormShape } from '../../src/gen/caves/carvers';

/** Minecraft's drift (spec §2.2): pitch ·= 0.7; yaw += 0.1·yd; pitch += 0.1·pd; yd = 0.75·yd + …·4; pd = 0.9·pd + …·2. */
const SHAPE_DEFAULTS: WormShape = {
  pitchKeep: 0.7, yawStep: 0.1, pitchStep: 0.1, yawDriftKeep: 0.75, yawDriftMul: 4, pitchDriftKeep: 0.9, pitchDriftMul: 2,
};

export const CARVER_DEFAULTS: CarverParams = {
  worms: {
    chance: 0.15, length: 112, lengthVar: 28, radiusMin: 0.7, radiusMax: 1.4, vRatioMin: 0.8, vRatioMax: 1.3,
    floorMin: -1, floorMax: -0.4, branchChance: 0.25, roomChance: 0.25, roomYScaleMin: 0.1, roomYScaleMax: 0.9,
    startYMin: -56, startYMax: 180, shape: SHAPE_DEFAULTS,
  },
  undergroundWorms: { chance: 0.07, startYMin: -56, startYMax: 24, maxY: 40 },
  ravines: {
    chance: 0.015, lengthMin: 84, lengthMax: 112, thicknessMax: 6, plateau: 2, yScale: 3, widthSmoothness: 3,
    vRotation: 0.125, startYMin: 10, startYMax: 72,
  },
  limits: { waterDepth: 16, bandSpan: 16, capTop: 344 },
};

export const CARVER_MAXIMA: CarverParams = {
  worms: {
    chance: 1, length: 160, lengthVar: 64, radiusMin: 2, radiusMax: 2, vRatioMin: 3, vRatioMax: 3,
    floorMin: 1, floorMax: 1, branchChance: 1, roomChance: 1, roomYScaleMin: 0.9, roomYScaleMax: 0.9,
    startYMin: 320, startYMax: 320,
    shape: { pitchKeep: 1, yawStep: 8, pitchStep: 8, yawDriftKeep: 1, yawDriftMul: 8, pitchDriftKeep: 1, pitchDriftMul: 8 },
  },
  undergroundWorms: { chance: 1, startYMin: 320, startYMax: 320, maxY: 120 },
  ravines: {
    chance: 0.2, lengthMin: 160, lengthMax: 160, thicknessMax: 8, plateau: 8, yScale: 6, widthSmoothness: 16,
    vRotation: 0.5, startYMin: 320, startYMax: 320,
  },
  limits: { waterDepth: 48, bandSpan: 32, capTop: 344 },
};

/** The worms' thickness t = 2·u + u (spec §2.2) stays below 3 whatever the leaves: it is not a leaf. */
const WORM_THICKNESS_SUP = 3;
/** Minecraft's cap: every step's radius is (1.5 + detSin(π·i/n)·t)·mul (spec §2.2-§2.3). */
const CAP = 1.5;

/**
 * Spec §2.1's L_max (the longest path in steps: `worms.length` and the ravines' `max(lengthMin, lengthMax)`; each step
 * moves 1 block) and r_max (the largest horizontal radius along a path: (1.5 + 3)·max(radiusMin, radiusMax) for worms
 * and underground worms, 1.5 + thicknessMax for ravines, whose width factor only narrows them; a start room sits at the
 * start and is not counted) for the leaves `p`.
 */
export function carverReachOf(p: CarverParams): { readonly lMax: number; readonly rMax: number } {
  const lMax = Math.max(p.worms.length, p.ravines.lengthMin, p.ravines.lengthMax);
  const worm = (CAP + WORM_THICKNESS_SUP) * Math.max(p.worms.radiusMin, p.worms.radiusMax);
  const ravine = CAP + p.ravines.thicknessMax;
  return { lMax, rMax: Math.max(worm, ravine) };
}

/** Spec §2.1's window: the largest integer R with 16·R < 16 + L_max + r_max for the leaves `p`. */
export function carverWindowROf(p: CarverParams): number {
  const { lMax, rMax } = carverReachOf(p);
  const reach = 16 + lMax + rMax;
  let r = 0;
  while (16 * (r + 1) < reach) r++;
  return r;
}

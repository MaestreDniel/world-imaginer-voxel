/**
 * The underwater and lava fog's numbers (SP7a spec §8, D11), the single source of the fluid fog: `FLUID_FOG_GLSL`
 * (`materials/glsl/common.glsl.ts`) interpolates them into its formula as GLSL literals, and `fluidFogFactor` is the
 * same formula in TS, which the tests pin.
 */

/** Water's fog distance L in blocks: less than 1/256 of the colour is left at 56 blocks. */
export const FLUID_FOG_L_WATER = 56;
/** Lava's fog distance L in blocks. */
export const FLUID_FOG_L_LAVA = 3;
/** The exponent's scale: f = 1 − 2^(−8·(d/L)²), so 2⁻⁸ of the colour is left at d = L. */
export const FLUID_FOG_SHARPNESS = 8;
/** The tint: while the eye is in a fluid every fragment mixes this much toward the fog colour. */
export const FLUID_FOG_TINT = 0.25;

/** The fluid fog's factor at `d` blocks from the eye for the distance `l`: 1 − 2^(−8·(d/l)²), 0 at the eye. */
export function fluidFogFactor(d: number, l: number): number {
  const x = d / l;
  return 1 - Math.pow(2, -FLUID_FOG_SHARPNESS * x * x);
}

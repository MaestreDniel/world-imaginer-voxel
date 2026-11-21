import { describe, expect, test } from 'vitest';
import {
  FLUID_FOG_L_LAVA, FLUID_FOG_L_WATER, FLUID_FOG_SHARPNESS, FLUID_FOG_TINT, fluidFogFactor,
} from '../../src/render/fogMath';

describe('the underwater and lava fog factor (SP7a spec §8, D11)', () => {
  test('the constants: water fully fogged at 56 blocks, lava at 3, sharpness 8, tint 0.25', () => {
    expect([FLUID_FOG_L_WATER, FLUID_FOG_L_LAVA, FLUID_FOG_SHARPNESS, FLUID_FOG_TINT]).toEqual([56, 3, 8, 0.25]);
  });

  test('f = 1 − 2^(−8·(d/L)²): (56, 56) = 1 − 2⁻⁸, (28, 56) = 0.75, (0, L) = 0, (3, 3) = 1 − 2⁻⁸', () => {
    expect(fluidFogFactor(56, 56)).toBe(1 - 2 ** -8);
    // Less than 1/256 of the colour left at L.
    expect(fluidFogFactor(56, 56)).toBeGreaterThanOrEqual(1 - 1 / 256);
    expect(fluidFogFactor(28, 56)).toBe(0.75);
    expect(fluidFogFactor(0, 56)).toBe(0);
    expect(fluidFogFactor(0, 3)).toBe(0);
    expect(fluidFogFactor(3, 3)).toBe(1 - 2 ** -8);
  });
});

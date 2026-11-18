/**
 * The aquifer's defaults for the tests that build `aquiferInputs` by hand (SP7a spec §1.9; rulings P5): until Task 13
 * they were literals here (gen exports no numeric data); since Task 13 wrote them into the schema they are
 * `DEFAULTS.aquifer`, so the tests read the schema's values.
 * - `AQUIFER_SETTINGS`: §1.9's leaves but the noises (`abyssMargin` 0.06, m as the plan's Task 6 measured it, the SP7a
 *   spec's Exit evidence "The abyss margin (Task 6)").
 * - `AQUIFER_NOISES`: the four noise definitions, Minecraft's wavelengths and octaves (**MC (memory)**): floodedness
 *   λ 128, spread λ 32, lava λ 2, barrier λ 8, one octave each, double, clampSigma 3, remap 'none' (the vertical scales
 *   0.67, 0.714 and 0.5 are applied by the readers, so yScale stays 1).
 */
import type { NoiseDef } from '../../src/core/noise/types';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { AquiferSettings } from '../../src/gen/fluids/aquifer';

export const AQUIFER_SETTINGS: AquiferSettings = DEFAULTS.aquifer;

export const AQUIFER_NOISES: { readonly floodedness: NoiseDef; readonly spread: NoiseDef; readonly lava: NoiseDef; readonly barrier: NoiseDef } = DEFAULTS.aquifer.noises;

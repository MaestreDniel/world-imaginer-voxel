/**
 * The aquifer's pre-schema defaults (SP7a spec §1.9; rulings P5): the settings and the four noise definitions as
 * literals, here once and never in `gen/` (gen exports no numeric data), until Task 13 writes them into the schema
 * (`DEFAULTS.aquifer`), when this file returns them or is pinned equal to them.
 * - `AQUIFER_SETTINGS`: §1.9's leaves but the noises; `abyssMargin` is m as Task 6 measured it (0.06, the SP7a spec's
 *   Exit evidence "The abyss margin (Task 6)"; §1.6's estimate was 0.03).
 * - `AQUIFER_NOISES`: Minecraft's wavelengths and octaves (**MC (memory)**, the plan's Task 5): floodedness λ 128,
 *   spread λ 32, lava λ 2, barrier λ 8, one octave each; each a double NormalNoise with clampSigma 3 and remap 'none',
 *   as SP6a's cave noises (the vertical scales 0.67, 0.714 and 0.5 are applied by the readers, so yScale stays 1).
 */
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import type { AquiferSettings } from '../../src/gen/fluids/aquifer';

export const AQUIFER_SETTINGS: AquiferSettings = {
  enabled: true,
  surfaceBand: 12,
  thresholds: { fullInland: 0.8, fullOcean: -0.3, partialInland: 0.4, partialOcean: -0.8 },
  lavaMaxLevel: -10,
  lavaThreshold: 0.3,
  lavaLevel: -54,
  barrierBand: 25,
  abyssMargin: 0.06,
};

export const AQUIFER_NOISES: { readonly floodedness: NoiseDef; readonly spread: NoiseDef; readonly lava: NoiseDef; readonly barrier: NoiseDef } = {
  floodedness: completeNoiseDef({ wavelength: 128, octaves: 1, double: true, clampSigma: 3 }),
  spread: completeNoiseDef({ wavelength: 32, octaves: 1, double: true, clampSigma: 3 }),
  lava: completeNoiseDef({ wavelength: 2, octaves: 1, double: true, clampSigma: 3 }),
  barrier: completeNoiseDef({ wavelength: 8, octaves: 1, double: true, clampSigma: 3 }),
};

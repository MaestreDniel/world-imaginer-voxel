/** A complete noise definition (validated params always hold every field; spec §4.2). */
export interface NoiseDef {
  readonly wavelength: number;
  readonly octaves: number;
  readonly persistence: number;
  readonly lacunarity: number;
  readonly amplitudes: readonly number[] | null;
  readonly yScale: number;
  readonly double: boolean;
  readonly remap: 'none' | 'uniform';
  readonly clampSigma: number;
}

export type NoiseDefPatch = { readonly [K in keyof NoiseDef]?: NoiseDef[K] };

export const NOISE_DEF_DEFAULTS = {
  persistence: 0.5,
  lacunarity: 2,
  amplitudes: null,
  yScale: 1,
  double: true,
  remap: 'none',
  clampSigma: 3,
} as const satisfies Omit<NoiseDef, 'wavelength' | 'octaves'>;

export function completeNoiseDef(init: Pick<NoiseDef, 'wavelength' | 'octaves'> & NoiseDefPatch): NoiseDef {
  return { ...NOISE_DEF_DEFAULTS, ...init };
}

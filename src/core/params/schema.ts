import { buildSchema, group, noise, num, type Patch, type Value } from './kit';

export { NOISE_FIELD_RANGES } from './kit';

const CLIMATE = { scope: 'climate', stage: 'climate' } as const;

const warp = (label: string, doc: string, amplitude: number, wavelength: number, octaves: number) =>
  group(label, doc, {
    amplitude: num(amplitude, { ...CLIMATE, label: 'Amplitude', doc: 'Maximum displacement of the warp.', unit: 'blocks', min: 0, max: 1000, step: 1 }),
    noise: noise({ wavelength, octaves }, {
      ...CLIMATE, label: 'Warp noise', doc: 'Unit-sd noise sampled twice (.x and .z) to displace the coordinates.',
      wavelength: { min: 16, max: 8192 }, dims: 2, components: ['x', 'z'],
    }),
  });

const field = (label: string, doc: string, wavelength: number, octaves: number) =>
  noise({ wavelength, octaves, remap: 'uniform' }, { ...CLIMATE, label, doc, wavelength: { min: 64, max: 20000 }, dims: 2 });

/** The SP1 ParamSchema: the climate section (SP1 spec §4.3). Later sub-projects add sections. */
export const ROOT = group('Parameters', 'World generation parameters.', {
  climate: group('Climate', 'The six climate fields and their warps.', {
    scaleMul: num(1, { ...CLIMATE, label: 'Climate scale', doc: 'Zooms every climate wavelength, warp wavelength and warp amplitude (large_biomes = 4).', min: 0.25, max: 16, step: 0.05, effectMetric: 'Z4' }),
    warp: group('Warps', 'Domain warps applied before sampling the climate fields.', {
      shift: warp('Shift warp', 'Shared warp of every climate field.', 48, 256, 3),
      C: warp('Continentalness warp', 'Extra warp of C: bays and peninsulas.', 180, 1024, 2),
      R: warp('River warp', 'Extra warp of R: meanders.', 120, 512, 2),
    }),
    C: field('Continentalness', 'Ocean ↔ inland.', 2400, 6),
    E: field('Erosion', 'Flat ↔ mountainous.', 1600, 5),
    W: field('Weirdness', 'Ridges at |W| = 2/3 via PV; sign selects variants.', 900, 5),
    T: field('Temperature', 'Cold ↔ hot; zones about twice the size of humidity zones.', 5000, 4),
    H: field('Humidity', 'Dry ↔ wet.', 2400, 4),
    R: field('Rivers', 'Its zero set gives the river lines.', 1400, 4),
  }),
});

export const SCHEMA = buildSchema(ROOT);
export type Params = Value<typeof ROOT>;
export type ParamsPatch = Patch<typeof ROOT>;
export interface ClimateParams extends Value<typeof ROOT.children.climate> {}

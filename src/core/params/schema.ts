import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from './biomeDefaults';
import { boxTable, buildSchema, group, noise, num, spline, type Patch, type Value } from './kit';
import { JAG_DEFAULT, OFFSET_DEFAULT, SIGMA_DEFAULT } from './shapeDefaults';

export { NOISE_FIELD_RANGES } from './kit';

const CLIMATE = { scope: 'climate', stage: 'climate' } as const;
const SHAPE = { scope: 'terrain', stage: 'shape' } as const;
const BIOME = { scope: 'terrain', stage: 'biome2d' } as const;
const TERRAIN = { scope: 'terrain', stage: 'terrain' } as const;
const SHAPE_COORDS = ['C', 'E', 'PV'] as const;

const blocks = (def: number, label: string, doc: string, min: number, max: number, step = 1) =>
  num(def, { ...SHAPE, label, doc, unit: 'blocks', min, max, step });
const frac = (def: number, label: string, doc: string, min: number, max: number) =>
  num(def, { ...SHAPE, label, doc, min, max, step: 0.01 });
const shapeNoise = (label: string, doc: string, wavelength: number, octaves: number, extra: { remap?: 'uniform'; components?: readonly ['x', 'z'] } = {}) =>
  noise({ wavelength, octaves, ...(extra.remap !== undefined ? { remap: extra.remap } : {}) }, {
    ...SHAPE, label, doc, wavelength: { min: 16, max: 8192 }, dims: 2,
    ...(extra.components !== undefined ? { components: extra.components } : {}),
  });

const warp = (label: string, doc: string, amplitude: number, wavelength: number, octaves: number) =>
  group(label, doc, {
    amplitude: num(amplitude, { ...CLIMATE, label: 'Amplitude', doc: 'Maximum displacement of the warp.', unit: 'blocks', min: 0, max: 1000, step: 1 }),
    noise: noise({ wavelength, octaves }, {
      ...CLIMATE, label: 'Warp noise', doc: 'Unit-sd noise sampled twice (.x and .z) to displace the coordinates.',
      wavelength: { min: 16, max: 8192 }, dims: 2, components: ['x', 'z'],
    }),
  });

/** A density noise (SP3b spec §3.3): sampled at unscaled world block coordinates; remap 'none' (validateExpr; the schema refuses another). */
const densityNoise = (label: string, doc: string, def: { readonly wavelength: number; readonly octaves: number; readonly yScale?: number; readonly persistence?: number }, dims: 2 | 3, wavelength: { readonly min: number; readonly max: number }) =>
  noise(def, { ...TERRAIN, label, doc, wavelength, dims, remapNone: true });
const amp = (def: number, label: string, doc: string) =>
  num(def, { ...TERRAIN, label, doc, unit: 'blocks', min: 0, max: 8, step: 0.05 });

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
    R: field('Rivers', 'Its zero set gives the river lines.', 1000, 4),
  }),
  shape: group('Shape', 'Target height, overhang and jaggedness in blocks (master §3.3).', {
    offset: spline(OFFSET_DEFAULT, { ...SHAPE, label: 'Offset', doc: 'Target surface y in blocks from C → E → PV.', unit: 'blocks', coords: SHAPE_COORDS, min: -64, max: 320 }),
    sigma: spline(SIGMA_DEFAULT, { ...SHAPE, label: 'Sigma', doc: 'Sd of the 3D surface displacement in blocks (clamped at 0).', unit: 'blocks', coords: SHAPE_COORDS, min: -16, max: 64 }),
    jag: spline(JAG_DEFAULT, { ...SHAPE, label: 'Jaggedness', doc: 'Amplitude of ridged peaks in blocks (clamped at 0).', unit: 'blocks', coords: SHAPE_COORDS, min: -16, max: 128 }),
  }),
  rivers: group('Rivers', 'Channels, valleys and gorges along the zero set of R (master §3.4).', {
    widthMin: blocks(8, 'Minimum width', 'Channel width where the width noise is lowest.', 1, 64),
    widthVar: blocks(12, 'Width variation', 'Extra channel width where the width noise is highest.', 0, 64),
    widthNoise: shapeNoise('Width noise', 'Uniform noise u2 that varies the width and depth along the river.', 600, 2, { remap: 'uniform' }),
    valleyBase: blocks(30, 'Valley width', 'Valley half-width on flat ground (E = −1).', 0, 400),
    valleyPerE: blocks(45, 'Valley width per E', 'Extra valley half-width per unit of (1 + E).', 0, 400),
    valleyFloor: blocks(64, 'Valley floor', 'Height the valley floor starts from next to the channel.', 63, 128),
    valleyRise: blocks(2, 'Valley rise', 'Rise of the valley floor across the valley.', 0, 64),
    coastFadeLo: frac(-0.12, 'Coast fade start', 'C where valleys begin to fade in from the coast.', -1, 1),
    coastFadeHi: frac(-0.02, 'Coast fade end', 'C where valleys reach full strength.', -1, 1),
    altFadeLo: blocks(120, 'Gorge start', 'offset0 where channels begin to fade into dry gorges.', 64, 320),
    altFadeHi: blocks(170, 'Gorge end', 'offset0 above which the channel is fully faded.', 64, 320),
    depthMin: blocks(3, 'Channel depth', 'Channel depth below sea level at the centre where u2 is lowest.', 0, 32),
    depthVar: blocks(3, 'Channel depth variation', 'Extra channel depth where u2 is highest.', 0, 32),
    wetMargin: blocks(2, 'Wet margin', 'Blocks beyond the channel edge still counted as river water.', 0, 16),
    gorgeDepth: blocks(12, 'Gorge depth', 'Depth of the dry gorge cut below offset0 on high ground (SP2a amendment).', 0, 64),
  }),
  lakes: group('Lakes', 'Lakes at elevation in warped Voronoi cells (master §3.5).', {
    cell: blocks(320, 'Cell size', 'Voronoi cell size.', 64, 4096),
    jitter: frac(0.8, 'Cell jitter', 'Fraction of the cell a centre may move from the cell middle.', 0, 1),
    warpAmp: blocks(80, 'Warp amplitude', 'Displacement of the Voronoi domain.', 0, 1000),
    warpNoise: shapeNoise('Warp noise', 'Noise sampled twice (.x and .z) to warp the cells.', 360, 2, { components: ['x', 'z'] }),
    p: frac(0.12, 'Probability', 'Chance that an eligible cell holds a lake.', 0, 1),
    minC: frac(-0.1, 'Minimum C', 'Continentalness a lake centre needs.', -1, 1),
    offsetMin: blocks(66, 'Lowest centre', 'Lowest offset0 at a lake centre.', -64, 320),
    offsetMax: blocks(200, 'Highest centre', 'Highest offset0 at a lake centre.', -64, 320),
    radius: blocks(90, 'Radius', 'Basin radius around the cell centre.', 8, 1024),
    rimWidth: frac(0.35, 'Rim width', 'Rim band width as a fraction of the radius.', 0.05, 2),
    roughness: frac(0.15, 'Shore roughness', 'Scale of the rim noise on the basin edge, in radii.', 0, 1),
    rimNoise: shapeNoise('Rim noise', 'Noise that roughens the shoreline.', 48, 2),
    ringFrac: frac(0.55, 'Level ring', 'Radius fraction of the 8 samples that fix the water level.', 0.1, 1.5),
    depthMin: blocks(4, 'Depth', 'Lake depth where the depth hash is lowest.', 1, 64),
    depthVar: blocks(10, 'Depth variation', 'Extra depth where the depth hash is highest.', 0, 64),
    rimRise: blocks(2, 'Rim rise', 'Rim height above the water level before the σ margin.', 0, 32),
    rimSigma: num(0.5, { ...SHAPE, label: 'Rim sigma', doc: 'Largest σ on the rim; the rim adds 3 of these above the water.', unit: 'blocks', min: 0, max: 8, step: 0.1 }),
    sigmaMul: frac(0.3, 'Basin sigma', 'Multiplier of σ inside the basin.', 0, 1),
  }),
  biomes: group('Biomes', 'Surface biome boxes and the per-block zoom (master §3.10).', {
    table: boxTable(BIOME_TABLE_DEFAULT, { ...BIOME, label: 'Biome boxes', doc: 'Climate box, sign(W) filter and tie-break priority of every box-picked surface biome.', rows: BOX_BIOMES }),
    zoomJitter: num(1.5, { ...BIOME, label: 'Zoom jitter', doc: 'Jitter of the quart centres in the jittered-Voronoi zoom.', unit: 'blocks', min: 0, max: 2, step: 0.05 }),
  }),
  density: group('Density', 'Tunables of the default 3D density expression (SP3b spec §3); its structure is code until SP3d.', {
    noises: group('Density noises', 'Noises read by the density expression (noise2 / noise ops), at unscaled world block coordinates.', {
      jag: densityNoise('Jag noise', 'Ridges of jagged peaks: J = (1 − |z / clampSigma|)², times the jag spline.', { wavelength: 28, octaves: 2 }, 2, { min: 16, max: 8192 }),
      overhang: densityNoise('Overhang noise', '3D surface displacement, times σ and the vertical slide (yScale 1: octaves at λy 32 and 16).', { wavelength: 32, octaves: 2, yScale: 1, persistence: 0.65 }, 3, { min: 16, max: 8192 }),
      detail: densityNoise('Detail noise', 'Small 3D surface detail outside the interpolation, times the detail amplitude.', { wavelength: 10, octaves: 1 }, 3, { min: 4, max: 256 }),
    }),
    detailAmpLo: amp(0.6, 'Detail amplitude at E −1', 'Detail amplitude in blocks where E ≤ −1.'),
    detailAmpHi: amp(1.5, 'Detail amplitude at E +1', 'Detail amplitude in blocks where E ≥ 1; linear in (E + 1) / 2 between the two.'),
  }),
});

export const SCHEMA = buildSchema(ROOT);
export type Params = Value<typeof ROOT>;
export type ParamsPatch = Patch<typeof ROOT>;
export interface ClimateParams extends Value<typeof ROOT.children.climate> {}
export interface ShapeParams extends Value<typeof ROOT.children.shape> {}
export interface RiverParams extends Value<typeof ROOT.children.rivers> {}
export interface LakeParams extends Value<typeof ROOT.children.lakes> {}
export interface BiomeParams extends Value<typeof ROOT.children.biomes> {}
export interface DensityParams extends Value<typeof ROOT.children.density> {}

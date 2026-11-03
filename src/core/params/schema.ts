import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from './biomeDefaults';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from './defaultTrees';
import { bool, boxTable, buildSchema, group, int, jsonLeaf, noise, num, spline, type Patch, type Value } from './kit';
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
/**
 * A cave noise (SP6a spec §1.2, §4): a density noise under `caves.noises.*`, read by the cave terms of the density
 * expression through its id (the noise lookup tries `density.noises.<id>` first, then `caves.noises.<id>`); a single
 * stack unless `def.double` (D24), remap 'none', and `clampSigma` given here (3 for every SP6a noise, so the closure
 * bounds of the caps hold). `def.dims` is the noise's dims; a 3D noise's vertical wavelength is λ / yScale (≥ 16 at the
 * defaults, SP3b's rule: 2 × the 8-block corner step).
 */
const caveNoise = (label: string, doc: string, def: { readonly dims: 2 | 3; readonly wavelength: number; readonly octaves: number; readonly yScale?: number; readonly double?: boolean; readonly amplitudes?: readonly number[] }, clampSigma: number, range: { readonly min: number; readonly max: number }) => {
  const { dims, ...noiseDef } = def;
  return noise({ double: false, ...noiseDef, clampSigma }, { ...TERRAIN, label, doc, wavelength: range, dims, remapNone: true });
};
const CAVE_WAVELENGTH = { min: 16, max: 8192 } as const;
/** A spaghetti band's tunnel scale rm (SP6a spec §1.3, §4): the `noiseScaled` s of its band, 1/16 … 16 (the op's range). */
const scale = (def: number, label: string, doc: string) =>
  num(def, { ...TERRAIN, label, doc, min: 0.0625, max: 16, step: 0.0625 });
const amp = (def: number, label: string, doc: string) =>
  num(def, { ...TERRAIN, label, doc, unit: 'blocks', min: 0, max: 8, step: 0.05 });
/**
 * A cave family's depth band end (SP6a spec §1.4, §4): an int y in −64 … 320. Outside [minY, maxY] the family narrows
 * over `caves.limits.bandSpan` blocks (the gentle part of its cap), then closes over the next 8 (the steep part).
 */
const bandY = (def: number, end: 'minY' | 'maxY', family: string) => int(def, {
  ...TERRAIN, unit: 'y', min: -64, max: 320,
  label: end === 'minY' ? 'Lowest y' : 'Highest y',
  doc: end === 'minY'
    ? `${family} narrow below this y over the band span, then close over the next 8 blocks.`
    : `${family} narrow above this y over the band span, then close over the next 8 blocks.`,
});

/** A surface noise (SP3c spec §3.5): 2D, sampled at unscaled world block coordinates; remap 'none' (validateRules refuses another). */
const surfaceNoise = (label: string, doc: string, def: { readonly wavelength: number; readonly octaves: number }, wavelength: { readonly min: number; readonly max: number }) =>
  noise(def, { ...TERRAIN, label, doc, wavelength, dims: 2, remapNone: true });
/** A world height (SP3c spec §3.5): an int in y −64 … 319. */
const worldY = (def: number, label: string, doc: string) => int(def, { ...TERRAIN, label, doc, unit: 'y', min: -64, max: 319 });

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
  density: group('Density', 'Tunables of the default 3D density expression (SP3b spec §3); its structure is the `defs` tree.', {
    noises: group('Density noises', 'Noises read by the density expression (noise2 / noise ops), at unscaled world block coordinates.', {
      jag: densityNoise('Jag noise', 'Ridges of jagged peaks: J = (1 − |z / clampSigma|)², times the jag spline.', { wavelength: 28, octaves: 2 }, 2, { min: 16, max: 8192 }),
      overhang: densityNoise('Overhang noise', '3D surface displacement, times σ and the vertical slide. Its vertical wavelength is λ / yScale; keep its last octave at 16 blocks or more (2 × the 8-block vertical corner step).', { wavelength: 32, octaves: 2, yScale: 1, persistence: 0.65 }, 3, { min: 16, max: 8192 }),
      detail: densityNoise('Detail noise', 'Small 3D surface detail outside the interpolation, times the detail amplitude.', { wavelength: 10, octaves: 1 }, 3, { min: 4, max: 256 }),
      // SP3e spec §2.1, §3.1: NI of FLOATING_DENSITY_TREE (λxz 72, λy 36); after `detail`, so no earlier draw moves.
      islands: densityNoise('Island noise', 'NI of the floating_islands islands term, sampled at the 4 × 8 × 4 corners; vertical wavelength λ / yScale. The preset\'s band window and cluster gate are exact for clampSigma ≤ 3; above, they cut where NI > 3.', { wavelength: 72, octaves: 2, yScale: 2 }, 3, { min: 16, max: 8192 }),
    }),
    detailAmpLo: amp(0.6, 'Detail amplitude at E −1', 'Detail amplitude in blocks where E ≤ −1.'),
    detailAmpHi: amp(1.5, 'Detail amplitude at E +1', 'Detail amplitude in blocks where E ≥ 1; linear in (E + 1) / 2 between the two.'),
    defs: jsonLeaf(DEFAULT_DENSITY_TREE, 'density', { ...TERRAIN, label: 'Density expression', doc: 'The density expression {root, defs} as data (SP3d spec §1-§2): its numbers may read the density and surface tunables through parameter refs, and its taps may be muted. Edit it in the Density tab.' }),
  }),
  surface: group('Surface', 'Tunables of the default surface-rule tree (SP3c spec §3.5, §4); its structure is the `rules` tree.', {
    noises: group('Surface noises', 'Noises read by the surface scan and rules, at unscaled world block coordinates (z2, unit sd).', {
      depth: surfaceNoise('Depth noise', 'Ns of the surface depth: max(0, ⌊3 + 2.75 · depthMul · Ns + 0.25 · hash⌋) blocks of under blocks below each top.', { wavelength: 64, octaves: 2 }, { min: 8, max: 1024 }),
      patch: surfaceNoise('Patch noise', 'Every surface patch (clay, podzol, coarse dirt, mud, gravel, calcite, packed ice): a patch block where it is ≥ the patch threshold, a second one where it is ≤ −threshold.', { wavelength: 24, octaves: 2 }, { min: 4, max: 512 }),
      bandOffset: surfaceNoise('Band offset noise', 'Shifts the badlands terracotta bands up or down by round(4 · z / clampSigma) blocks (−4 … 4), so the bands waver across the badlands.', { wavelength: 128, octaves: 1 }, { min: 16, max: 2048 }),
    }),
    depthMul: num(1, { ...TERRAIN, label: 'Surface depth multiplier', doc: 'Multiplies the depth noise in the surface depth (0: three under blocks everywhere).', min: 0, max: 2, step: 0.05 }),
    snowline: num(-0.6, { ...TERRAIN, label: 'Snowline', doc: 'Tops whose T_eff (T lowered by the lapse rate with height) is below this are snow.', min: -1, max: 1, step: 0.01 }),
    lapse: num(0.006, { ...TERRAIN, label: 'Lapse rate', doc: 'T_eff = T − lapse · max(0, y − lapse base): temperature drop per block of height.', min: 0, max: 0.05, step: 0.0005 }),
    lapseBase: worldY(80, 'Lapse base', 'Height from which T_eff falls with the lapse rate.'),
    cliffSteep: num(1.2, { ...TERRAIN, label: 'Cliff steepness', doc: 'A sky-open run whose position is at least this steep and whose top is at or above the cliff height shows stone (packed ice on frozen peaks).', min: 0, max: 8, step: 0.05 }),
    cliffMinY: worldY(80, 'Cliff height', 'Lowest run top that can be a cliff.'),
    patchThreshold: num(0.55, { ...TERRAIN, label: 'Patch threshold', doc: 'A patch block where the patch noise is ≥ this; the second block of a two-block patch where it is ≤ −this (≈ 29 % of the tops each at 0.55).', min: 0, max: 3, step: 0.01 }),
    rules: jsonLeaf(DEFAULT_SURFACE_RULES, 'surfaceRules', { ...TERRAIN, label: 'Surface rules', doc: 'The surface-rule tree as data (SP3d spec §1-§2): its numeric fields may read the density and surface tunables through parameter refs, and its block states must be solid. Edit it in the Density tab.' }),
  }),
  // Last in the schema (SP3e spec §2.1, D9), so randomParams and randomPatch draw every earlier group as before.
  islands: group('Islands', 'The island cluster mask of the floating_islands preset (SP3e spec §2): islandMask = smoothstep(lo, hi, u) of a 2D noise.', {
    enabled: bool(false, { ...SHAPE, label: 'Enabled', doc: 'Computes the island cluster mask `islandMask` (off: 0), makes water v0 fill the sea under runs lying above y 180 and makes the surface rules\' sky-open run the highest run reaching below y 181 (on in floating_islands). It switches no tree: off in floating_islands, its rules still give peaks topped above y 180 the islands palette; on elsewhere, a run lying above y 180 (a detached peak) loses the sky-open palette (snow becomes stone).' }),
    noise: shapeNoise('Cluster noise', 'u = U(z2) of this noise sets the mask.', 700, 2, { remap: 'uniform' }),
    lo: frac(0.55, 'Mask start', 'u where `islandMask` starts to rise from 0.', -1, 1),
    hi: frac(0.8, 'Mask full', 'u from which `islandMask` is 1 (lo ≥ hi: a step at lo).', -1, 1),
  }),
  // SP6a spec §4 (D9): appended after `islands`, so randomParams and randomPatch draw every earlier group as before. The
  // sub-groups in this order (Cheese, Spaghetti 3D, Spaghetti 2D, Noodles, Pillars, Entrances, Worms, Underground worms,
  // Ravines, Limits, then the noises); each leaf lands with the term that reads it, sizes first.
  caves: group('Caves', 'The cave terms of the default density expression (SP6a spec §1, §4): the noise families, their floors and limits.', {
    cheese: group('Cheese', 'Large caverns: 16·(layerAmp·L² + clamp(Nch + offset − regional·Nra, −1, 1) + roof), carved where it is below 0.', {
      offset: num(0.27, { ...TERRAIN, label: 'Offset', doc: 'Added to the cheese noise: lower → larger caverns (0.27: caverns are rare pockets).', min: -0.5, max: 1, step: 0.01 }),
      regional: num(0.1, { ...TERRAIN, label: 'Regional swing', doc: 'Lowers the offset by this × the regional noise Nra (λ 1536), so some regions hold larger caverns.', min: 0, max: 0.4, step: 0.01 }),
      layerAmp: num(4, { ...TERRAIN, label: 'Layer amplitude', doc: 'Weight of the squared layer noise L², which closes caverns between flat layers.', min: 0, max: 8, step: 0.05 }),
      roofDepth: num(12, { ...TERRAIN, label: 'Roof depth', doc: 'Caverns close within about this depth below the terrain surface: + clamp((roofDepth − T) / 24, 0, 0.5).', unit: 'blocks', min: 0, max: 48, step: 1 }),
      minY: bandY(-56, 'minY', 'Caverns'),
      maxY: bandY(320, 'maxY', 'Caverns'),
    }),
    spaghetti3d: group('Spaghetti 3D', 'Winding tunnels: 16·(rough + clamp(max(rm·|S1(p/rm)|, rm·|S2(p/rm)|) − thickness − thicknessVar·thk − regional·Nrb, −1, 1)), carved where it is below 0; rm is the scale of the rarity band (SP6a spec §1.2-§1.3).', {
      thickness: num(0.0765, { ...TERRAIN, label: 'Thickness', doc: 'Subtracted from the tunnel noise: higher → wider tunnels.', min: 0, max: 0.3, step: 0.0005 }),
      thicknessVar: num(0.0115, { ...TERRAIN, label: 'Thickness variation', doc: 'Times the thickness noise thk: how much the tunnel width varies along a tunnel.', min: 0, max: 0.1, step: 0.0005 }),
      regional: num(0.05, { ...TERRAIN, label: 'Regional swing', doc: 'Times the regional noise Nrb (λ 1024): tunnels are wider where Nrb is high, narrower where it is low.', min: 0, max: 0.2, step: 0.005 }),
      scales: group('Scales', 'The tunnel scale rm of each band of the rarity noise r (r < −0.5, < 0, < 0.5, else), blended linearly within ±0.05 of each band edge: larger → larger, sparser tunnels.', {
        s0: scale(0.75, 'Scale, r < −0.5', 'The tunnel scale where the rarity noise is below −0.5.'),
        s1: scale(1, 'Scale, −0.5 ≤ r < 0', 'The tunnel scale where the rarity noise is in −0.5 … 0.'),
        s2: scale(1.5, 'Scale, 0 ≤ r < 0.5', 'The tunnel scale where the rarity noise is in 0 … 0.5.'),
        s3: scale(2, 'Scale, r ≥ 0.5', 'The tunnel scale where the rarity noise is 0.5 or above.'),
      }),
      minY: bandY(-56, 'minY', 'The 3D tunnels'),
      maxY: bandY(320, 'maxY', 'The 3D tunnels'),
    }),
    spaghetti2d: group('Spaghetti 2D', 'Flat winding tunnels along a sloping layer: 16·clamp(max(rm·|S2d(p/rm)| + 0.083·tm, (|layerAmp·Nel + yGrad| + tm)³), −1, 1), tm = −thickness − 0.35·Nthk; rm is the scale of the rarity band (SP6a spec §1.2-§1.3).', {
      thickness: num(0.95, { ...TERRAIN, label: 'Thickness', doc: 'The constant of tm = −thickness − 0.35·Nthk: higher → wider and taller tunnels.', min: 0.5, max: 1.5, step: 0.01 }),
      layerAmp: num(8, { ...TERRAIN, label: 'Layer amplitude', doc: 'Times the elevation noise Nel: how far the tunnel layer rises and falls around its sloping height.', min: 0, max: 32, step: 0.25 }),
      scales: group('Scales', 'The tunnel scale rm of each band of the rarity noise r (r < −0.75, < −0.5, < 0.5, < 0.75, else), blended linearly within ±0.05 of each band edge.', {
        s0: scale(0.5, 'Scale, r < −0.75', 'The tunnel scale where the rarity noise is below −0.75.'),
        s1: scale(0.75, 'Scale, −0.75 ≤ r < −0.5', 'The tunnel scale where the rarity noise is in −0.75 … −0.5.'),
        s2: scale(1, 'Scale, −0.5 ≤ r < 0.5', 'The tunnel scale where the rarity noise is in −0.5 … 0.5.'),
        s3: scale(2, 'Scale, 0.5 ≤ r < 0.75', 'The tunnel scale where the rarity noise is in 0.5 … 0.75.'),
        s4: scale(3, 'Scale, r ≥ 0.75', 'The tunnel scale where the rarity noise is 0.75 or above.'),
      }),
      minY: bandY(-64, 'minY', 'The flat tunnels'),
      // 215, not 320 (SP6a spec §1.4, §4): the layer is never open above y 208, so any maxY from 208 to 244 changes no
      // generated output, and 215 is the highest of those whose U2 lower step (183) has a band witness.
      maxY: bandY(215, 'maxY', 'The flat tunnels'),
    }),
    noodles: group('Noodles', 'Thin tubes: 16·(−thickness − 0.025·Kn + ridgeMul·max(|An|, |Bn|) + 4·max(0, −Nn)), carved where it is below 0; they narrow and close where the toggle noise Nn is below 0 (SP6a spec §1.1-§1.3).', {
      thickness: num(0.075, { ...TERRAIN, label: 'Thickness', doc: 'Subtracted from the ridges: higher → wider noodles.', min: 0, max: 0.3, step: 0.0025 }),
      ridgeMul: num(1.5, { ...TERRAIN, label: 'Ridge multiplier', doc: 'Times the ridge noises max(|An|, |Bn|): higher → thinner noodles.', min: 0.5, max: 4, step: 0.05 }),
      regional: num(0.1, { ...TERRAIN, label: 'Regional swing', doc: 'Lowers the toggle noise by this × the regional noise Nrb (λ 1024), so noodles close together where Nrb is high.', min: 0, max: 0.4, step: 0.01 }),
      minY: bandY(-60, 'minY', 'Noodles'),
      maxY: bandY(64, 'maxY', 'Noodles'),
    }),
    pillars: group('Pillars', 'Rock pillars kept inside caverns: P = 16·(2·Np − 1 − rare)·(0.55 + 0.55·thickness)³.', {
      threshold: num(0.03, { ...TERRAIN, label: 'Threshold', doc: 'Rock is kept where P / 16 is at least this (lower → more and thicker pillars).', min: 0, max: 0.5, step: 0.005 }),
    }),
    entrances: group('Entrances', 'Openings that reach the surface: 16·min(Ne·(1/6) + offset + yGrad, rough + clamp(max(|E1|, |E2|) − threshold, −1, 1)), not depth-ramped.', {
      offset: num(0.37, { ...TERRAIN, label: 'Offset', doc: 'Added to the scaled entrance noise Ne·(1/6): lower → more entrances.', min: -0.5, max: 1, step: 0.01 }),
      threshold: num(0.08, { ...TERRAIN, label: 'Threshold', doc: 'Width of the entrance tunnels: carved where max(|E1|, |E2|) is below about this.', min: 0, max: 0.5, step: 0.005 }),
      minY: bandY(-64, 'minY', 'Entrances'),
      maxY: bandY(320, 'maxY', 'Entrances'),
    }),
    limits: group('Limits', 'Where the cave families may reach (SP6a spec §1.4).', {
      surfaceDepth: num(8, { ...TERRAIN, label: 'Surface depth', doc: 'The deep families fade out above this depth: + clamp((surfaceDepth − T)·2, 0, 32) (0 at T ≥ surfaceDepth, 16 at the surface).', unit: 'blocks', min: 0, max: 32, step: 1 }),
      bandSpan: int(16, { ...TERRAIN, label: 'Band span', doc: 'Outside its depth band (minY … maxY) a family narrows over this many blocks (the gentle part of its cap), then closes over the next 8.', unit: 'blocks', min: 1, max: 32 }),
      capTop: int(344, { ...TERRAIN, label: 'Cap top', doc: 'The island cap: caves narrow over the band span below capTop − 8 and are closed from capTop − 4 up (344, above the world\'s top, has no effect; 180 in floating_islands, so no cave air lies at y ≥ 176).', unit: 'y', min: 180, max: 344 }),
    }),
    noises: group('Cave noises', 'Noises read by the cave terms (noise2 / noise ops), at unscaled world block coordinates.', {
      cheese: caveNoise('Cheese noise', 'Nch of the cheese caverns (λxz 96, λy 144, double).', { dims: 3, wavelength: 96, octaves: 4, yScale: 96 / 144, double: true }, 3, CAVE_WAVELENGTH),
      layer: caveNoise('Layer noise', 'L of the cheese layer term layerAmp·L² (λxz 96, λy 16).', { dims: 3, wavelength: 96, octaves: 1, yScale: 6 }, 3, CAVE_WAVELENGTH),
      cheeseRegional: caveNoise('Cheese regional noise', 'Nra (2D): lowers the cheese offset by regional·Nra.', { dims: 2, wavelength: 1536, octaves: 2 }, 3, CAVE_WAVELENGTH),
      pillar: caveNoise('Pillar noise', 'Np of the pillars (λxz 30, λy 400).', { dims: 3, wavelength: 30, octaves: 1, yScale: 0.075 }, 3, CAVE_WAVELENGTH),
      pillarRare: caveNoise('Pillar rarity noise', 'rare of the pillars (λxz 60, λy 400).', { dims: 3, wavelength: 60, octaves: 1, yScale: 0.15 }, 3, CAVE_WAVELENGTH),
      pillarThickness: caveNoise('Pillar thickness noise', 'thickness of the pillars (λxz 60, λy 400).', { dims: 3, wavelength: 60, octaves: 1, yScale: 0.15 }, 3, CAVE_WAVELENGTH),
      roughness: caveNoise('Roughness noise', 'Nr of rough = (−0.05 − 0.05·Nrm)·(−0.4 + |Nr|).', { dims: 3, wavelength: 32, octaves: 1 }, 3, CAVE_WAVELENGTH),
      roughnessMod: caveNoise('Roughness modulation noise', 'Nrm of rough = (−0.05 − 0.05·Nrm)·(−0.4 + |Nr|).', { dims: 3, wavelength: 128, octaves: 1 }, 3, CAVE_WAVELENGTH),
      entrance: caveNoise('Entrance noise', 'Ne of the entrances (amplitudes 0.4, 0.5, 1.0).', { dims: 3, wavelength: 128, octaves: 3, amplitudes: [0.4, 0.5, 1.0] }, 3, CAVE_WAVELENGTH),
      entranceA: caveNoise('Entrance tunnel noise A', 'E1 of the entrance tunnels max(|E1|, |E2|).', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      entranceB: caveNoise('Entrance tunnel noise B', 'E2 of the entrance tunnels max(|E1|, |E2|).', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spag3dA: caveNoise('Spaghetti 3D noise A', 'S1 of the 3D tunnels max(rm·|S1(p/rm)|, rm·|S2(p/rm)|).', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spag3dB: caveNoise('Spaghetti 3D noise B', 'S2 of the 3D tunnels max(rm·|S1(p/rm)|, rm·|S2(p/rm)|).', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spag3dRarity: caveNoise('Spaghetti 3D rarity noise', 'r of the 3D tunnels: its band picks the tunnel scale rm (Spaghetti 3D, Scales).', { dims: 3, wavelength: 128, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spag3dThickness: caveNoise('Spaghetti 3D thickness noise', 'thk of the 3D tunnels, times the thickness variation.', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spagRegional: caveNoise('Spaghetti regional noise', 'Nrb (2D): widens the 3D tunnels and closes the noodles where it is high.', { dims: 2, wavelength: 1024, octaves: 2 }, 3, CAVE_WAVELENGTH),
      spag2d: caveNoise('Spaghetti 2D noise', 'S2d of the flat tunnels rm·|S2d(p/rm)|.', { dims: 3, wavelength: 128, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spag2dElevation: caveNoise('Spaghetti 2D elevation noise', 'Nel (2D): raises and lowers the flat tunnels\' layer, times the layer amplitude.', { dims: 2, wavelength: 256, octaves: 2 }, 3, CAVE_WAVELENGTH),
      spag2dThickness: caveNoise('Spaghetti 2D thickness noise', 'Nthk of tm = −thickness − 0.35·Nthk.', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      spag2dRarity: caveNoise('Spaghetti 2D rarity noise', 'r of the flat tunnels: its band picks the tunnel scale rm (Spaghetti 2D, Scales).', { dims: 3, wavelength: 128, octaves: 1 }, 3, CAVE_WAVELENGTH),
      noodleToggle: caveNoise('Noodle toggle noise', 'Nn of the noodles: they narrow and close where Nn − regional·Nrb is below 0.', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      noodleThickness: caveNoise('Noodle thickness noise', 'Kn of the noodles, times 0.025.', { dims: 3, wavelength: 64, octaves: 1 }, 3, CAVE_WAVELENGTH),
      noodleRidgeA: caveNoise('Noodle ridge noise A', 'An of the noodle ridges max(|An|, |Bn|).', { dims: 3, wavelength: 18, octaves: 1 }, 3, CAVE_WAVELENGTH),
      noodleRidgeB: caveNoise('Noodle ridge noise B', 'Bn of the noodle ridges max(|An|, |Bn|).', { dims: 3, wavelength: 18, octaves: 1 }, 3, CAVE_WAVELENGTH),
    }),
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
export interface SurfaceParams extends Value<typeof ROOT.children.surface> {}
export interface IslandParams extends Value<typeof ROOT.children.islands> {}
export interface CaveParams extends Value<typeof ROOT.children.caves> {}

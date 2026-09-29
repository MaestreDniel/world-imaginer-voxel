/**
 * The default surface-biome boxes (master §3.10, SP2a spec §3.1 and Appendix A). Bands in uniform
 * climate units: T and H edges −0.6 / −0.2 / 0.2 / 0.6 (plus −0.8 for oceans only: frozen seas are the coldest
 * ~10 % of oceans, tuned 2026-09-29); C deep ocean < −0.55, ocean < −0.22, coast
 * −0.22..−0.10, inland above; E mountains < −0.375; PV valleys < −0.6, peaks > 0.7. The boxes tile the
 * climate space (ties only on shared edges); river and frozen river come from the river flag, not boxes.
 */
import type { BoxRow, BoxTable, Interval } from './kit';

/** Box-picked surface biomes, in registry order (master §3.10 plus volcano). */
export const BOX_BIOMES = [
  'deep_ocean', 'ocean', 'warm_ocean', 'frozen_ocean',
  'beach', 'snowy_beach', 'stony_shore',
  'plains', 'meadow', 'forest', 'birch_forest', 'dark_forest', 'taiga', 'snowy_taiga', 'snowy_plains',
  'desert', 'savanna', 'swamp', 'jungle', 'badlands',
  'windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano',
] as const;
export type BoxBiome = (typeof BOX_BIOMES)[number];

const ALL: Interval = [-1, 1];
const box = (C: Interval, E: Interval, PV: Interval, T: Interval, H: Interval, priority: number, wSign: -1 | 0 | 1 = 0): BoxRow =>
  ({ C, E, PV, T, H, wSign, priority });

const OCEANS: Interval = [-1, -0.22];
const FROZEN_SEA: Interval = [-1, -0.8];
const LIQUID_SEA: Interval = [-0.8, 0.6];
const COAST: Interval = [-0.22, -0.1];
const INLAND: Interval = [-0.1, 1];
const MOUNT: Interval = [-1, -0.375];
const LOW: Interval = [-0.375, 1];
const PEAK: Interval = [0.7, 1];
const NOT_PEAK: Interval = [-1, 0.7];
const VALLEY: Interval = [-1, -0.6];
const NOT_VALLEY: Interval = [-0.6, 1];
const FROZEN: Interval = [-1, -0.6];
const COLD: Interval = [-0.6, -0.2];
const COLDISH: Interval = [-1, -0.2];
const TEMP: Interval = [-0.2, 0.2];
const MILD: Interval = [-0.2, 0.6];
const HOT: Interval = [0.6, 1];

export const BIOME_TABLE_DEFAULT: BoxTable<BoxBiome> = {
  deep_ocean: box([-1, -0.55], ALL, ALL, LIQUID_SEA, ALL, 1),
  ocean: box([-0.55, -0.22], ALL, ALL, LIQUID_SEA, ALL, 2),
  warm_ocean: box(OCEANS, ALL, ALL, HOT, ALL, 3),
  frozen_ocean: box(OCEANS, ALL, ALL, FROZEN_SEA, ALL, 4),
  beach: box(COAST, LOW, ALL, [-0.6, 1], ALL, 5),
  snowy_beach: box(COAST, LOW, ALL, FROZEN, ALL, 6),
  stony_shore: box(COAST, MOUNT, ALL, ALL, ALL, 7),
  plains: box(INLAND, LOW, [-1, 0.2], TEMP, [-1, 0.2], 8),
  meadow: box(INLAND, LOW, [0.2, 1], TEMP, [-1, 0.2], 9),
  forest: box(INLAND, LOW, ALL, MILD, [0.2, 0.6], 10, -1),
  birch_forest: box(INLAND, LOW, ALL, MILD, [0.2, 0.6], 11, 1),
  dark_forest: box(INLAND, LOW, NOT_VALLEY, MILD, [0.6, 1], 12),
  taiga: box(INLAND, LOW, ALL, COLD, ALL, 13),
  snowy_taiga: box(INLAND, LOW, ALL, FROZEN, [0.2, 1], 14),
  snowy_plains: box(INLAND, LOW, ALL, FROZEN, [-1, 0.2], 15),
  desert: box(INLAND, LOW, ALL, HOT, [-1, 0.2], 16),
  savanna: box(INLAND, LOW, ALL, [0.2, 0.6], [-1, 0.2], 17),
  swamp: box(INLAND, LOW, VALLEY, [-0.2, 1], [0.6, 1], 18),
  jungle: box(INLAND, LOW, NOT_VALLEY, HOT, [0.2, 1], 19),
  badlands: box(INLAND, MOUNT, NOT_PEAK, HOT, ALL, 20),
  windswept_hills: box(INLAND, MOUNT, NOT_PEAK, MILD, ALL, 21),
  snowy_slopes: box(INLAND, MOUNT, NOT_PEAK, COLDISH, ALL, 22),
  stony_peaks: box(INLAND, MOUNT, PEAK, MILD, ALL, 23),
  jagged_peaks: box(INLAND, MOUNT, PEAK, COLDISH, ALL, 24, 1),
  frozen_peaks: box(INLAND, MOUNT, PEAK, COLDISH, ALL, 25, -1),
  volcano: box(INLAND, MOUNT, PEAK, HOT, ALL, 26),
};

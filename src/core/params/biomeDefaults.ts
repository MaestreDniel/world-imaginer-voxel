/**
 * The default surface-biome boxes (master §3.10, SP2a spec §3.1 and Appendix A). Bands in uniform
 * climate units: T and H edges −0.6 / −0.2 / 0.2 / 0.6 (plus −0.8 for oceans only: frozen seas are the coldest
 * ~10 % of oceans, tuned 2026-09-29); C deep ocean < −0.55, ocean < −0.10, coast −0.22..−0.04, inland above;
 * E mountains < −0.375; PV valleys < −0.6, peaks > 0.7. The picker's height filter (spec §3.2) gives sea-floor
 * columns (offset0 below sea level, C < −0.10) only the ocean boxes and land columns (C > −0.14) only the others,
 * so oceans and coast share the shore band and the shoreline decides between them (tuned 2026-09-30). Per
 * height class the boxes tile the climate space (ties only on shared edges); river and frozen river come from
 * the river flag, not boxes.
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

const OCEANS: Interval = [-1, -0.1];
const FROZEN_SEA: Interval = [-1, -0.8];
const LIQUID_SEA: Interval = [-0.8, 0.6];
const COAST: Interval = [-0.22, -0.04];
const INLAND: Interval = [-0.04, 1];
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
  ocean: box([-0.55, -0.1], ALL, ALL, LIQUID_SEA, ALL, 2),
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

/**
 * Archipelago's C map φ (SP3e spec §1.3, D8) at the C endpoints the default boxes use, written as literals:
 * deep ocean −0.55 → −0.305, ocean / coast −0.1 → 0.32, coast −0.22 → 0.2, inland −0.04 → 0.38; ±1 stay.
 */
const ARCHIPELAGO_C = new Map<number, number>([[-1, -1], [-0.55, -0.305], [-0.22, 0.2], [-0.1, 0.32], [-0.04, 0.38], [1, 1]]);

function archipelagoC(c: number): number {
  const v = ARCHIPELAGO_C.get(c);
  if (v === undefined) throw new Error(`archipelago biome table: no φ literal for the C endpoint ${c}`);
  return v;
}

/**
 * The archipelago preset's boxes (SP3e spec §1.3): BIOME_TABLE_DEFAULT with every C endpoint mapped by φ, so the
 * beaches sit at the new shore (deep_ocean C [−1, −0.305], ocean [−0.305, 0.32], warm and frozen ocean [−1, 0.32],
 * COAST [0.2, 0.38], INLAND [0.38, 1]); E, PV, T, H, the W signs and the priorities are the default's.
 */
export const ARCHIPELAGO_BIOME_TABLE: BoxTable<BoxBiome> = Object.fromEntries(BOX_BIOMES.map((b): [BoxBiome, BoxRow] => {
  const r = BIOME_TABLE_DEFAULT[b];
  return [b, box([archipelagoC(r.C[0]), archipelagoC(r.C[1])], r.E, r.PV, r.T, r.H, r.priority, r.wSign)];
})) as BoxTable<BoxBiome>;

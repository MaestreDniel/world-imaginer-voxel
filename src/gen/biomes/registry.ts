/**
 * The 28 surface biomes (master §3.10 plus volcano, SP2a spec §3.1). Ids are the index in master order
 * and never change; river and frozen river come from the river flag, every other biome from a box.
 */
import { BOX_BIOMES, type BoxBiome } from '../../core/params/biomeDefaults';

const BOX = BOX_BIOMES;

export type SurfaceBiome = BoxBiome | 'river' | 'frozen_river';
export type BiomeFamily = 'ocean' | 'coast' | 'river' | 'lowland' | 'highland';

export const SURFACE_BIOMES: readonly SurfaceBiome[] = [
  'ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean',
  'beach', 'snowy_beach', 'stony_shore',
  'river', 'frozen_river',
  'plains', 'meadow', 'forest', 'birch_forest', 'dark_forest', 'taiga', 'snowy_taiga', 'snowy_plains',
  'desert', 'savanna', 'swamp', 'jungle', 'badlands',
  'windswept_hills', 'snowy_slopes', 'stony_peaks', 'jagged_peaks', 'frozen_peaks', 'volcano',
];

/** [family, 0xRRGGBB] per biome, in SURFACE_BIOMES order. */
const INFO: ReadonlyArray<readonly [BiomeFamily, number]> = [
  ['ocean', 0x1f4f9a], ['ocean', 0x0f2f6a], ['ocean', 0x2a8fb0], ['ocean', 0x8fb4d8],
  ['coast', 0xe8dca0], ['coast', 0xf2f0e6], ['coast', 0x8a8a84],
  ['river', 0x3f76e4], ['river', 0xa0c4f0],
  ['lowland', 0x8db360], ['lowland', 0xa8c96a], ['lowland', 0x3f7a2a], ['lowland', 0x6fa04a], ['lowland', 0x2a4a1c],
  ['lowland', 0x3a6b4a], ['lowland', 0x5a7a6a], ['lowland', 0xe8eef2],
  ['lowland', 0xe0c878], ['lowland', 0xbfb055], ['lowland', 0x4c6b3a], ['lowland', 0x2f8a1e], ['highland', 0xc1653a],
  ['highland', 0x7c8a6a], ['highland', 0xd8e2ea], ['highland', 0x9a9a9a], ['highland', 0xc8d0dc], ['highland', 0xaec4e0],
  ['highland', 0x5a2a24],
];

const ID = new Map<string, number>(SURFACE_BIOMES.map((n, i) => [n, i]));

export function biomeId(name: SurfaceBiome): number {
  return ID.get(name)!;
}

export function biomeName(id: number): SurfaceBiome {
  const n = SURFACE_BIOMES[id];
  if (n === undefined) throw new Error(`unknown biome id ${id}`);
  return n;
}

export function biomeFamily(id: number): BiomeFamily {
  return INFO[id]![0];
}

/** 0xRRGGBB map colour. */
export function biomeColor(id: number): number {
  return INFO[id]![1];
}

/** Biome id of each box row, in BOX_BIOMES order. */
export const BOX_TO_BIOME: readonly number[] = BOX.map((n) => ID.get(n)!);

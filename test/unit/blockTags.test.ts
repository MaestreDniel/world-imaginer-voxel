import { describe, expect, test } from 'vitest';
import { REGISTRY, TYPE_NAMES } from '../../src/world/blocks/index';
import {
  CATEGORY, CATEGORY_BUILDING, CATEGORY_NONE, CATEGORY_ORDER, CATEGORY_TERRAIN, CATEGORY_VALUES, CATEGORY_WOOL, CLIMBABLE,
  displayName, PLACEABLE, SLIPPERY,
} from '../../src/world/blocks/tags';

/** The type names whose entry in a per-type table is `code`. */
const named = (table: Uint8Array, code = 1): string[] => TYPE_NAMES.filter((_, t) => table[t] === code);

const WOOLS = [
  'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool',
  'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool',
];
/** The SP3c terrain palette (SP3c spec §2.1), in id order. */
const SP3C = [
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mud', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'gravel',
  'clay', 'calcite', 'snow_block', 'packed_ice', 'deepslate', 'terracotta', 'white_terracotta', 'orange_terracotta',
  'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta',
];
/** SP6b's seven types (SP6b spec §4, D36), in id order. */
const SP6B = ['moss_block', 'dripstone_block', 'abyss_stone', 'abyss_stone_veined', 'cracked_abyss_stone', 'abyss_shale', 'abyss_ash'];

describe('block tags, per type (SP5a spec §1.1)', () => {
  test('every table holds one entry per type id', () => {
    for (const table of [PLACEABLE, CATEGORY, SLIPPERY, CLIMBABLE]) {
      expect(table).toBeInstanceOf(Uint8Array);
      expect(table.length).toBe(REGISTRY.typeCount);
    }
  });

  test('PLACEABLE is false only for air and wall_torch', () => {
    expect(named(PLACEABLE, 0)).toEqual(['air', 'wall_torch']);
    expect(named(PLACEABLE)).toHaveLength(55);
  });

  test('CATEGORY: building the 7 of spec §1.1, wool the 16, terrain stone, bedrock, ice, the 22 SP3c types and SP6b\'s 7, none air and wall_torch', () => {
    expect(CATEGORY_VALUES).toEqual(['none', 'building', 'wool', 'terrain']);
    expect([CATEGORY_NONE, CATEGORY_BUILDING, CATEGORY_WOOL, CATEGORY_TERRAIN]).toEqual([0, 1, 2, 3]);
    expect(CATEGORY_ORDER).toEqual(['building', 'wool', 'terrain']);
    expect(named(CATEGORY, CATEGORY_BUILDING)).toEqual(['oak_planks', 'oak_log', 'cobblestone', 'bricks', 'glass', 'torch', 'ladder']);
    expect(named(CATEGORY, CATEGORY_WOOL)).toEqual(WOOLS);
    expect(named(CATEGORY, CATEGORY_TERRAIN).sort()).toEqual(['stone', 'bedrock', 'ice', ...SP3C, ...SP6B].sort());
    expect(named(CATEGORY, CATEGORY_NONE)).toEqual(['air', 'wall_torch']);
    // A placeable type has a category, and a category other than none holds only placeable types.
    for (let t = 0; t < REGISTRY.typeCount; t++) expect(CATEGORY[t] !== CATEGORY_NONE, TYPE_NAMES[t]).toBe(PLACEABLE[t] === 1);
  });

  test('SP6b\'s seven types are placeable and land in the creative palette\'s terrain category, after the older terrain types (SP6b spec D36)', () => {
    for (const name of SP6B) {
      const t = REGISTRY.typeId(name);
      expect(PLACEABLE[t], name).toBe(1);
      expect(CATEGORY[t], name).toBe(CATEGORY_TERRAIN);
      expect([SLIPPERY[t], CLIMBABLE[t]], name).toEqual([0, 0]);
    }
    expect(named(CATEGORY, CATEGORY_TERRAIN).slice(-7)).toEqual(SP6B);
    expect(displayName(REGISTRY.typeId('cracked_abyss_stone'))).toBe('Cracked abyss stone');
  });

  test('SLIPPERY is ice and packed_ice; CLIMBABLE is ladder', () => {
    expect(named(SLIPPERY).sort()).toEqual(['ice', 'packed_ice']);
    expect(named(CLIMBABLE)).toEqual(['ladder']);
    for (const table of [PLACEABLE, SLIPPERY, CLIMBABLE]) expect(table.every((v) => v === 0 || v === 1)).toBe(true);
  });

  test('displayName: the type name with _ as a space and its first letter upper case', () => {
    const id = (n: string): number => REGISTRY.typeId(n);
    expect(displayName(id('oak_planks'))).toBe('Oak planks');
    expect(displayName(id('light_blue_wool'))).toBe('Light blue wool');
    expect(displayName(id('grass_block'))).toBe('Grass block');
    expect(displayName(id('stone'))).toBe('Stone');
    expect(displayName(id('light_gray_terracotta'))).toBe('Light gray terracotta');
    expect(() => displayName(REGISTRY.typeCount)).toThrow(RangeError);
    expect(() => displayName(-1)).toThrow(RangeError);
  });
});

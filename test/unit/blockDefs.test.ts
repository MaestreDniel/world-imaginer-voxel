import { describe, expect, test } from 'vitest';
import {
  ALL_FACES, COLLIDE_CUBE, COLLIDE_NONE, FLUID_MODE_BLOCK, FLUID_MODE_DISPLACE, PASS_NONE, PASS_OPAQUE, SHAPE_CUBE,
  SHAPE_NONE, SOUND_DIRT, SOUND_GLASS, SOUND_GRASS, SOUND_GRAVEL, SOUND_NONE, SOUND_SAND, SOUND_SNOW, SOUND_STONE,
  TINT_GRASS, TINT_NONE,
} from '../../src/world/blocks/kinds';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import {
  AIR, BEDROCK, BROWN_TERRACOTTA, CALCITE, CARVABLE, CLAY, COARSE_DIRT, COLLIDE, DEEPSLATE, DEFAULT_STATE, DIRT, EMIT,
  FACE_TEX, FLUID_MODE, FULL_FACES, GRASS_BLOCK, GRAVEL, LIGHT_GRAY_TERRACOTTA, MUD, OPACITY, ORANGE_TERRACOTTA,
  PACKED_ICE, PASS, PODZOL, RED_SAND, RED_SANDSTONE, RED_TERRACOTTA, REGISTRY, REPLACEABLE, SAND, SANDSTONE, SHAPE,
  SNOW_BLOCK, SOUND, STATE_TYPE, STONE, TERRACOTTA, TINT, TYPE_NAMES, WHITE_TERRACOTTA, YELLOW_TERRACOTTA,
} from '../../src/world/blocks/index';
import { MAX_STATES } from '../../src/world/blocks/registry';
import { readStateLock } from '../harness/stateLock';

const R = REGISTRY;

/** SP3a's initial list (SP3a spec §2.2), then SP3c's terrain palette in the SP3c spec §2.1 order (state ids 3 … 24). */
const SP3A_NAMES = ['air', 'stone', 'bedrock'];
const PALETTE_NAMES = [
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mud', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'gravel',
  'clay', 'calcite', 'snow_block', 'packed_ice', 'deepslate', 'terracotta', 'white_terracotta', 'orange_terracotta',
  'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta',
];
const ALL_NAMES = [...SP3A_NAMES, ...PALETTE_NAMES];
const PALETTE_STATES = [
  GRASS_BLOCK, DIRT, COARSE_DIRT, PODZOL, MUD, SAND, RED_SAND, SANDSTONE, RED_SANDSTONE, GRAVEL, CLAY, CALCITE,
  SNOW_BLOCK, PACKED_ICE, DEEPSLATE, TERRACOTTA, WHITE_TERRACOTTA, ORANGE_TERRACOTTA, YELLOW_TERRACOTTA,
  BROWN_TERRACOTTA, RED_TERRACOTTA, LIGHT_GRAY_TERRACOTTA,
];
const COUNT = ALL_NAMES.length;
const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

const row = (s: number): number[] => [
  OPACITY[s]!, PASS[s]!, SHAPE[s]!, FULL_FACES[s]!, EMIT[s]!, CARVABLE[s]!, REPLACEABLE[s]!, COLLIDE[s]!,
  FLUID_MODE[s]!, TINT[s]!, SOUND[s]!,
];

describe('the real registry: SP3a initial list (SP3a spec §2.2) and SP3c terrain palette (SP3c spec §2.1)', () => {
  test('air 0, stone 1, bedrock 2, then the 22 palette types at 3 … 24, one state each', () => {
    expect(COUNT).toBe(25);
    expect(BLOCK_DEFS.map((d) => d.name)).toEqual(ALL_NAMES);
    expect(Object.isFrozen(BLOCK_DEFS)).toBe(true);
    expect(R.typeCount).toBe(COUNT);
    expect(R.stateCount).toBe(COUNT);
    expect(TYPE_NAMES).toEqual(ALL_NAMES);
    expect([AIR, STONE, BEDROCK]).toEqual([0, 1, 2]);
    expect(PALETTE_STATES).toEqual(ids(22).map((i) => i + 3));
    expect(ALL_NAMES.map((n) => R.typeId(n))).toEqual(ids(COUNT));
    expect(Array.from(DEFAULT_STATE)).toEqual(ids(COUNT));
    expect(Array.from(STATE_TYPE.subarray(0, COUNT))).toEqual(ids(COUNT));
    for (let t = 0; t < COUNT; t++) expect(R.typeProperties(t)).toEqual([]);
    for (const d of BLOCK_DEFS) expect(d.props, d.name).toBeUndefined();
  });

  test('canonical keys are the bare type names and parse back', () => {
    expect(ids(COUNT).map((s) => R.stateKey(s))).toEqual(ALL_NAMES);
    expect(ALL_NAMES.map((k) => R.parseStateKey(k))).toEqual(ids(COUNT));
    expect(() => R.parseStateKey('stone[]')).toThrow(/canonical/);
    expect(() => R.parseStateKey('deepslate[axis=y]')).toThrow();
  });

  test('test/stateIds.lock.json holds the 25 bare keys with their ids, the 22 palette keys appended after bedrock', () => {
    const lock = readStateLock() ?? {};
    expect(Object.keys(lock)).toEqual(ALL_NAMES);
    expect(Object.values(lock)).toEqual(ids(COUNT));
  });

  test('the SP3a §2.2 table values, as §2.1 codes', () => {
    //                     OPACITY PASS          SHAPE        FULL_FACES EMIT CARV REPL COLLIDE        FLUID_MODE           TINT       SOUND
    expect(row(AIR)).toEqual([0, PASS_NONE, SHAPE_NONE, 0, 0, 0, 1, COLLIDE_NONE, FLUID_MODE_DISPLACE, TINT_NONE, SOUND_NONE]);
    expect(row(STONE)).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 1, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_STONE]);
    expect(row(BEDROCK)).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 0, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_STONE]);
  });

  test('the SP3c §2.1 palette values: opaque full cubes; sound and tint per type; carvable except packed_ice', () => {
    const sound: Record<string, number> = {
      grass_block: SOUND_GRASS, dirt: SOUND_DIRT, coarse_dirt: SOUND_DIRT, podzol: SOUND_DIRT, mud: SOUND_DIRT,
      sand: SOUND_SAND, red_sand: SOUND_SAND, sandstone: SOUND_STONE, red_sandstone: SOUND_STONE, gravel: SOUND_GRAVEL,
      clay: SOUND_DIRT, calcite: SOUND_STONE, snow_block: SOUND_SNOW, packed_ice: SOUND_GLASS, deepslate: SOUND_STONE,
      terracotta: SOUND_STONE, white_terracotta: SOUND_STONE, orange_terracotta: SOUND_STONE,
      yellow_terracotta: SOUND_STONE, brown_terracotta: SOUND_STONE, red_terracotta: SOUND_STONE,
      light_gray_terracotta: SOUND_STONE,
    };
    expect(Object.keys(sound)).toEqual(PALETTE_NAMES);
    for (const name of PALETTE_NAMES) {
      const s = R.parseStateKey(name);
      const carvable = name === 'packed_ice' ? 0 : 1;
      const tint = name === 'grass_block' ? TINT_GRASS : TINT_NONE;
      //                         OPACITY PASS     SHAPE       FULL_FACES EMIT CARV      REPL COLLIDE       FLUID_MODE        TINT  SOUND
      expect(row(s), name).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, carvable, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, tint, sound[name]!]);
    }
  });

  test('every face texture is 0 until SP8a', () => {
    expect(Array.from(FACE_TEX.subarray(0, COUNT * 6))).toEqual(new Array<number>(COUNT * 6).fill(0));
  });

  test('the exported tables are the registry tables, sized MAX_STATES, 0 past the registered states', () => {
    const tables = { STATE_TYPE, OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE, FLUID_MODE, TINT, SOUND };
    for (const [name, table] of Object.entries(tables)) {
      expect(table, name).toBe(R[name as keyof typeof tables]);
      expect(table.length, name).toBe(MAX_STATES);
      expect(table.subarray(COUNT).every((v) => v === 0), name).toBe(true);
    }
    expect(FACE_TEX).toBe(R.FACE_TEX);
    expect(FACE_TEX.length).toBe(MAX_STATES * 6);
    expect(DEFAULT_STATE).toBe(R.DEFAULT_STATE);
    expect(TYPE_NAMES).toBe(R.TYPE_NAMES);
  });

  test('rotations, mirrors and withType of property-less types are the identity or the default', () => {
    for (const s of ids(COUNT)) {
      for (const q of [-1, 0, 1, 2, 3, 5]) expect(R.rotateState(s, q)).toBe(s);
      expect(R.mirrorState(s, 'x')).toBe(s);
      expect(R.mirrorState(s, 'z')).toBe(s);
      expect(R.propsOf(s)).toEqual({});
      expect(R.stateOf(STATE_TYPE[s]!)).toBe(s);
    }
    expect(R.withType(STONE, R.typeId('bedrock'))).toBe(BEDROCK);
    expect(R.withType(STONE, R.typeId('deepslate'))).toBe(DEEPSLATE);
  });

  test('no placeable state uses SOUND none; only air has SHAPE none', () => {
    for (let s = 0; s < R.stateCount; s++) {
      expect(SOUND[s] === SOUND_NONE, R.stateKey(s)).toBe(s === AIR);
      expect(SHAPE[s] === SHAPE_NONE, R.stateKey(s)).toBe(s === AIR);
    }
  });
});

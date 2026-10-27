import { describe, expect, test } from 'vitest';
import {
  ALL_FACES, COLLIDE_CUBE, COLLIDE_NONE, FLUID_MODE_BLOCK, FLUID_MODE_DISPLACE, FLUID_MODE_HOLD, PASS_CUTOUT, PASS_NONE,
  PASS_OPAQUE, SHAPE_BOX, SHAPE_CUBE, SHAPE_NONE, SOUND_DIRT, SOUND_GLASS, SOUND_GRASS, SOUND_GRAVEL, SOUND_NONE,
  SOUND_SAND, SOUND_SNOW, SOUND_STONE, SOUND_WOOD, SOUND_WOOL, TINT_GRASS, TINT_NONE,
} from '../../src/world/blocks/kinds';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import {
  AIR, BEDROCK, BLACK_WOOL, BLUE_WOOL, BRICKS, BROWN_TERRACOTTA, BROWN_WOOL, CALCITE, CARVABLE, CLAY, COARSE_DIRT,
  COBBLESTONE, COLLIDE, CYAN_WOOL, DEEPSLATE, DEFAULT_STATE, DIRT, EMIT, FACE_TEX, FLUID_MODE, FULL_FACES, GLASS,
  GRASS_BLOCK, GRAVEL, GRAY_WOOL, GREEN_WOOL, ICE, LADDER, LIGHT_BLUE_WOOL, LIGHT_GRAY_TERRACOTTA, LIGHT_GRAY_WOOL,
  LIME_WOOL, MAGENTA_WOOL, MUD, OAK_LOG, OAK_PLANKS, OPACITY, ORANGE_TERRACOTTA, ORANGE_WOOL, PACKED_ICE, PASS,
  PINK_WOOL, PODZOL, PURPLE_WOOL, RED_SAND, RED_SANDSTONE, RED_TERRACOTTA, RED_WOOL, REGISTRY, REPLACEABLE, SAND,
  SANDSTONE, SHAPE, SNOW_BLOCK, SOUND, STATE_TYPE, STONE, TERRACOTTA, TINT, TORCH, TYPE_NAMES, WALL_TORCH,
  WHITE_TERRACOTTA, WHITE_WOOL, YELLOW_TERRACOTTA, YELLOW_WOOL,
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
/** The SP3a and SP3c types, each with one state: ids 0 … 24. */
const COUNT = ALL_NAMES.length;
const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** The 16 wools in Minecraft's order (SP5a spec §1.1). */
const WOOL_NAMES = [
  'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool',
  'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool',
];
/** SP5a's appended types (SP5a spec §1.1), in order after `light_gray_terracotta`. */
const SP5A_NAMES = ['oak_planks', 'oak_log', 'cobblestone', 'bricks', 'glass', 'torch', 'wall_torch', 'ladder', 'ice', ...WOOL_NAMES];
const TYPES = [...ALL_NAMES, ...SP5A_NAMES];
const WOOLS = [
  WHITE_WOOL, ORANGE_WOOL, MAGENTA_WOOL, LIGHT_BLUE_WOOL, YELLOW_WOOL, LIME_WOOL, PINK_WOOL, GRAY_WOOL, LIGHT_GRAY_WOOL,
  CYAN_WOOL, PURPLE_WOOL, BLUE_WOOL, BROWN_WOOL, GREEN_WOOL, RED_WOOL, BLACK_WOOL,
];
/** Every state key of the appended types in id order: each type's default first, then mixed-radix order. */
const SP5A_KEYS = [
  'oak_planks', 'oak_log[axis=y]', 'oak_log[axis=x]', 'oak_log[axis=z]', 'cobblestone', 'bricks', 'glass', 'torch',
  'wall_torch[facing=north]', 'wall_torch[facing=east]', 'wall_torch[facing=south]', 'wall_torch[facing=west]',
  'ladder[facing=north]', 'ladder[facing=east]', 'ladder[facing=south]', 'ladder[facing=west]', 'ice', ...WOOL_NAMES,
];
/** The states of a type, in id order. */
const statesOf = (name: string): number[] => {
  const t = R.typeId(name);
  return ids(R.stateCount).filter((s) => STATE_TYPE[s] === t);
};

const row = (s: number): number[] => [
  OPACITY[s]!, PASS[s]!, SHAPE[s]!, FULL_FACES[s]!, EMIT[s]!, CARVABLE[s]!, REPLACEABLE[s]!, COLLIDE[s]!,
  FLUID_MODE[s]!, TINT[s]!, SOUND[s]!,
];

describe('the real registry: SP3a initial list (SP3a spec §2.2), SP3c terrain palette (SP3c spec §2.1), SP5a\'s appended types (SP5a spec §1.1)', () => {
  test('50 types, 58 states; the 25 SP3a/SP3c types keep ids 0 … 24; the appended types at 25 … 57 in spec §1.1\'s order', () => {
    expect(COUNT).toBe(25);
    expect(SP5A_NAMES).toHaveLength(25);
    expect(BLOCK_DEFS.map((d) => d.name)).toEqual(TYPES);
    expect(Object.isFrozen(BLOCK_DEFS)).toBe(true);
    expect(R.typeCount).toBe(50);
    expect(R.stateCount).toBe(58);
    expect(TYPE_NAMES).toEqual(TYPES);
    // The SP3a and SP3c types: air 0, stone 1, bedrock 2, the 22 palette types at 3 … 24, one state each.
    expect([AIR, STONE, BEDROCK]).toEqual([0, 1, 2]);
    expect(PALETTE_STATES).toEqual(ids(22).map((i) => i + 3));
    expect(TYPES.map((n) => R.typeId(n))).toEqual(ids(50));
    expect(Array.from(DEFAULT_STATE.subarray(0, COUNT))).toEqual(ids(COUNT));
    expect(Array.from(STATE_TYPE.subarray(0, COUNT))).toEqual(ids(COUNT));
    for (let t = 0; t < COUNT; t++) expect(R.typeProperties(t)).toEqual([]);
    for (const d of BLOCK_DEFS.slice(0, COUNT)) expect(d.props, d.name).toBeUndefined();
    // The appended types: oak_log 3 states, wall_torch and ladder 4 each, the rest one; 33 states at 25 … 57.
    expect([OAK_PLANKS, OAK_LOG, COBBLESTONE, BRICKS, GLASS, TORCH, WALL_TORCH, LADDER, ICE]).toEqual([25, 26, 29, 30, 31, 32, 33, 37, 41]);
    expect(WOOLS).toEqual(ids(16).map((i) => i + 42));
    expect(Array.from(DEFAULT_STATE.subarray(COUNT))).toEqual([25, 26, 29, 30, 31, 32, 33, 37, 41, ...WOOLS]);
    expect(ids(58).slice(COUNT).map((s) => R.stateKey(s))).toEqual(SP5A_KEYS);
    expect(SP5A_KEYS.map((k) => R.parseStateKey(k))).toEqual(ids(58).slice(COUNT));
    expect(Array.from(STATE_TYPE.subarray(COUNT, 58)).map((t) => TYPE_NAMES[t])).toEqual(SP5A_KEYS.map((k) => k.replace(/\[.*$/, '')));
  });

  test('props only on oak_log (axis, default y), wall_torch and ladder (facing4, default north)', () => {
    const withProps = BLOCK_DEFS.filter((d) => d.props !== undefined).map((d) => [d.name, d.props]);
    expect(withProps).toEqual([
      ['oak_log', [{ name: 'axis', kind: 'axis', default: 'y' }]],
      ['wall_torch', [{ name: 'facing', kind: 'facing4', default: 'north' }]],
      ['ladder', [{ name: 'facing', kind: 'facing4', default: 'north' }]],
    ]);
    for (let t = 0; t < R.typeCount; t++) {
      const name = TYPE_NAMES[t]!;
      expect(R.typeProperties(t), name).toHaveLength(['oak_log', 'wall_torch', 'ladder'].includes(name) ? 1 : 0);
    }
    expect(R.propsOf(OAK_LOG)).toEqual({ axis: 'y' });
    expect(R.propsOf(WALL_TORCH)).toEqual({ facing: 'north' });
    expect(R.propsOf(LADDER)).toEqual({ facing: 'north' });
  });

  test('canonical keys are the bare type names and parse back', () => {
    expect(ids(COUNT).map((s) => R.stateKey(s))).toEqual(ALL_NAMES);
    expect(ALL_NAMES.map((k) => R.parseStateKey(k))).toEqual(ids(COUNT));
    expect(() => R.parseStateKey('stone[]')).toThrow(/canonical/);
    expect(() => R.parseStateKey('deepslate[axis=y]')).toThrow();
  });

  test('test/stateIds.lock.json holds the 25 bare keys with their ids, the 22 palette keys appended after bedrock, then SP5a\'s 33 states at 25 … 57', () => {
    const lock = readStateLock() ?? {};
    expect(Object.keys(lock)).toEqual([...ALL_NAMES, ...SP5A_KEYS]);
    expect(Object.values(lock)).toEqual(ids(58));
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
      expect(table.subarray(R.stateCount).every((v) => v === 0), name).toBe(true);
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

  test('the SP5a §1.1 table values on every state of each appended type, as §2.1 codes', () => {
    //                   OPACITY PASS        SHAPE       FULL_FACES EMIT CARV REPL COLLIDE       FLUID_MODE           TINT       SOUND
    const opaque = (sound: number) => [15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 0, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, sound];
    const want: Record<string, number[]> = {
      oak_planks: opaque(SOUND_WOOD),
      oak_log: opaque(SOUND_WOOD),
      cobblestone: opaque(SOUND_STONE),
      bricks: opaque(SOUND_STONE),
      glass: [0, PASS_CUTOUT, SHAPE_CUBE, 0, 0, 0, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_GLASS],
      ice: [1, PASS_CUTOUT, SHAPE_CUBE, 0, 0, 0, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_GLASS],
      torch: [0, PASS_CUTOUT, SHAPE_BOX, 0, 14, 0, 0, COLLIDE_NONE, FLUID_MODE_DISPLACE, TINT_NONE, SOUND_WOOD],
      wall_torch: [0, PASS_CUTOUT, SHAPE_BOX, 0, 14, 0, 0, COLLIDE_NONE, FLUID_MODE_DISPLACE, TINT_NONE, SOUND_WOOD],
      ladder: [0, PASS_CUTOUT, SHAPE_BOX, 0, 0, 0, 0, COLLIDE_NONE, FLUID_MODE_HOLD, TINT_NONE, SOUND_WOOD],
    };
    for (const w of WOOL_NAMES) want[w] = opaque(SOUND_WOOL);
    expect(Object.keys(want).sort()).toEqual([...SP5A_NAMES].sort());
    let states = 0;
    for (const name of SP5A_NAMES) {
      for (const s of statesOf(name)) {
        expect(row(s), R.stateKey(s)).toEqual(want[name]);
        expect(Array.from(FACE_TEX.subarray(s * 6, s * 6 + 6)), R.stateKey(s)).toEqual([0, 0, 0, 0, 0, 0]);
        states++;
      }
    }
    expect(states).toBe(33);
  });

  test('every EMIT in the registry is 0 or 14', () => {
    for (let s = 0; s < R.stateCount; s++) expect([0, 14], R.stateKey(s)).toContain(EMIT[s]);
    expect(ids(R.stateCount).filter((s) => EMIT[s] === 14).map((s) => R.stateKey(s))).toEqual([
      'torch', 'wall_torch[facing=north]', 'wall_torch[facing=east]', 'wall_torch[facing=south]', 'wall_torch[facing=west]',
    ]);
  });

  test('the keys oak_log[axis=x|y|z], wall_torch[facing=…] and ladder[facing=…] parse back', () => {
    for (const name of ['oak_log', 'wall_torch', 'ladder']) {
      const prop = name === 'oak_log' ? 'axis' : 'facing';
      const values = name === 'oak_log' ? ['x', 'y', 'z'] : ['north', 'east', 'south', 'west'];
      for (const v of values) {
        const key = `${name}[${prop}=${v}]`;
        const s = R.parseStateKey(key);
        expect(R.stateKey(s), key).toBe(key);
        expect(R.propsOf(s), key).toEqual({ [prop]: v });
        expect(R.stateOf(R.typeId(name), { [prop]: v }), key).toBe(s);
      }
      expect(() => R.parseStateKey(name), name).toThrow();
    }
    expect(() => R.parseStateKey('oak_log[facing=north]')).toThrow();
    expect(() => R.parseStateKey('ladder[facing=up]')).toThrow();
  });

  test('rotateState(oak_log[axis=x], 1) is axis=z and axis=y is fixed', () => {
    const k = (key: string): number => R.parseStateKey(key);
    expect(R.rotateState(k('oak_log[axis=x]'), 1)).toBe(k('oak_log[axis=z]'));
    expect(R.rotateState(k('oak_log[axis=z]'), 1)).toBe(k('oak_log[axis=x]'));
    expect(R.rotateState(k('oak_log[axis=x]'), 2)).toBe(k('oak_log[axis=x]'));
    for (const q of [-1, 0, 1, 2, 3, 4]) expect(R.rotateState(k('oak_log[axis=y]'), q)).toBe(k('oak_log[axis=y]'));
  });

  test('wall_torch and ladder turn north → east → south → west under q 1, and q 4 is the identity', () => {
    for (const name of ['wall_torch', 'ladder']) {
      const at = (f: string): number => R.parseStateKey(`${name}[facing=${f}]`);
      expect(R.rotateState(at('north'), 1)).toBe(at('east'));
      expect(R.rotateState(at('east'), 1)).toBe(at('south'));
      expect(R.rotateState(at('south'), 1)).toBe(at('west'));
      expect(R.rotateState(at('west'), 1)).toBe(at('north'));
      for (const s of statesOf(name)) {
        expect(R.rotateState(s, 4)).toBe(s);
        expect(R.rotateState(s, -1)).toBe(R.rotateState(s, 3));
      }
    }
  });

  test('mirrorState flips facing across its axis; a log\'s axis is unchanged', () => {
    for (const name of ['wall_torch', 'ladder']) {
      const at = (f: string): number => R.parseStateKey(`${name}[facing=${f}]`);
      expect(R.mirrorState(at('east'), 'x')).toBe(at('west'));
      expect(R.mirrorState(at('west'), 'x')).toBe(at('east'));
      expect(R.mirrorState(at('north'), 'x')).toBe(at('north'));
      expect(R.mirrorState(at('south'), 'x')).toBe(at('south'));
      expect(R.mirrorState(at('north'), 'z')).toBe(at('south'));
      expect(R.mirrorState(at('south'), 'z')).toBe(at('north'));
      expect(R.mirrorState(at('east'), 'z')).toBe(at('east'));
      expect(R.mirrorState(at('west'), 'z')).toBe(at('west'));
    }
    for (const s of statesOf('oak_log')) {
      expect(R.mirrorState(s, 'x')).toBe(s);
      expect(R.mirrorState(s, 'z')).toBe(s);
    }
  });

  test('no placeable state uses SOUND none; only air has SHAPE none', () => {
    for (let s = 0; s < R.stateCount; s++) {
      expect(SOUND[s] === SOUND_NONE, R.stateKey(s)).toBe(s === AIR);
      expect(SHAPE[s] === SHAPE_NONE, R.stateKey(s)).toBe(s === AIR);
    }
  });
});

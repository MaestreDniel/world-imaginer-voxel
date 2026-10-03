import { describe, expect, test } from 'vitest';
import {
  ALL_FACES, COLLIDE_CUBE, COLLIDE_NONE, FLUID_MODE_BLOCK, FLUID_MODE_DISPLACE, PASS_NONE, PASS_OPAQUE, SHAPE_CUBE,
  SHAPE_NONE, SOUND_NONE, SOUND_STONE, TINT_NONE,
} from '../../src/world/blocks/kinds';
import { BLOCK_DEFS } from '../../src/world/blocks/defs';
import {
  AIR, BEDROCK, CARVABLE, COLLIDE, DEFAULT_STATE, EMIT, FACE_TEX, FLUID_MODE, FULL_FACES, OPACITY, PASS, REGISTRY,
  REPLACEABLE, SHAPE, SOUND, STATE_TYPE, STONE, TINT, TYPE_NAMES,
} from '../../src/world/blocks/index';
import { MAX_STATES } from '../../src/world/blocks/registry';

const R = REGISTRY;

describe('the real registry: the SP3a initial list (SP3a spec §2.2)', () => {
  test('air 0, stone 1, bedrock 2, one state each', () => {
    expect(BLOCK_DEFS.map((d) => d.name)).toEqual(['air', 'stone', 'bedrock']);
    expect(Object.isFrozen(BLOCK_DEFS)).toBe(true);
    expect(R.typeCount).toBe(3);
    expect(R.stateCount).toBe(3);
    expect(TYPE_NAMES).toEqual(['air', 'stone', 'bedrock']);
    expect([AIR, STONE, BEDROCK]).toEqual([0, 1, 2]);
    expect([R.typeId('air'), R.typeId('stone'), R.typeId('bedrock')]).toEqual([0, 1, 2]);
    expect(Array.from(DEFAULT_STATE)).toEqual([0, 1, 2]);
    expect(Array.from(STATE_TYPE.subarray(0, 3))).toEqual([0, 1, 2]);
    for (let t = 0; t < 3; t++) expect(R.typeProperties(t)).toEqual([]);
  });

  test('canonical keys are the bare type names and parse back', () => {
    expect([AIR, STONE, BEDROCK].map((s) => R.stateKey(s))).toEqual(['air', 'stone', 'bedrock']);
    expect(['air', 'stone', 'bedrock'].map((k) => R.parseStateKey(k))).toEqual([AIR, STONE, BEDROCK]);
    expect(() => R.parseStateKey('stone[]')).toThrow(/canonical/);
  });

  test('the §2.2 table values, as §2.1 codes', () => {
    const row = (s: number): number[] => [
      OPACITY[s]!, PASS[s]!, SHAPE[s]!, FULL_FACES[s]!, EMIT[s]!, CARVABLE[s]!, REPLACEABLE[s]!, COLLIDE[s]!,
      FLUID_MODE[s]!, TINT[s]!, SOUND[s]!,
    ];
    //                     OPACITY PASS          SHAPE        FULL_FACES EMIT CARV REPL COLLIDE        FLUID_MODE           TINT       SOUND
    expect(row(AIR)).toEqual([0, PASS_NONE, SHAPE_NONE, 0, 0, 0, 1, COLLIDE_NONE, FLUID_MODE_DISPLACE, TINT_NONE, SOUND_NONE]);
    expect(row(STONE)).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 1, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_STONE]);
    expect(row(BEDROCK)).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, ALL_FACES, 0, 0, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, TINT_NONE, SOUND_STONE]);
    expect(Array.from(FACE_TEX.subarray(0, 18))).toEqual(new Array<number>(18).fill(0));
  });

  test('the exported tables are the registry tables, sized MAX_STATES, 0 past the registered states', () => {
    const tables = { STATE_TYPE, OPACITY, PASS, SHAPE, FULL_FACES, EMIT, CARVABLE, REPLACEABLE, COLLIDE, FLUID_MODE, TINT, SOUND };
    for (const [name, table] of Object.entries(tables)) {
      expect(table, name).toBe(R[name as keyof typeof tables]);
      expect(table.length, name).toBe(MAX_STATES);
      expect(table.subarray(3).every((v) => v === 0), name).toBe(true);
    }
    expect(FACE_TEX).toBe(R.FACE_TEX);
    expect(FACE_TEX.length).toBe(MAX_STATES * 6);
    expect(DEFAULT_STATE).toBe(R.DEFAULT_STATE);
    expect(TYPE_NAMES).toBe(R.TYPE_NAMES);
  });

  test('rotations, mirrors and withType of property-less types are the identity or the default', () => {
    for (const s of [AIR, STONE, BEDROCK]) {
      for (const q of [-1, 0, 1, 2, 3, 5]) expect(R.rotateState(s, q)).toBe(s);
      expect(R.mirrorState(s, 'x')).toBe(s);
      expect(R.mirrorState(s, 'z')).toBe(s);
      expect(R.propsOf(s)).toEqual({});
      expect(R.stateOf(STATE_TYPE[s]!)).toBe(s);
    }
    expect(R.withType(STONE, R.typeId('bedrock'))).toBe(BEDROCK);
  });

  test('no placeable state uses SOUND none; only air has SHAPE none', () => {
    for (let s = 0; s < R.stateCount; s++) {
      expect(SOUND[s] === SOUND_NONE, R.stateKey(s)).toBe(s === AIR);
      expect(SHAPE[s] === SHAPE_NONE, R.stateKey(s)).toBe(s === AIR);
    }
  });
});

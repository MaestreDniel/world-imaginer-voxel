import { describe, expect, test } from 'vitest';
import {
  ALL_FACES, COLLIDE_BOXES, COLLIDE_CUBE, COLLIDE_NONE, COLLIDE_VALUES, FACE_COUNT, FACE_DOWN, FACE_EAST, FACE_NAMES,
  FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST, FLUID_MODE_BLOCK, FLUID_MODE_DISPLACE, FLUID_MODE_HOLD, FLUID_MODE_VALUES,
  KIND_VALUES, PASS_CUTOUT, PASS_NONE, PASS_OPAQUE, PASS_TRANSLUCENT, PASS_VALUES, PROPERTY_KINDS, SHAPE_BOX, SHAPE_CROSS,
  SHAPE_CUBE, SHAPE_FLUID, SHAPE_NONE, SHAPE_POINTED, SHAPE_VALUES, SOUND_ABYSS, SOUND_DIRT, SOUND_GLASS, SOUND_GRASS,
  SOUND_GRAVEL, SOUND_LEAVES, SOUND_METAL, SOUND_NONE, SOUND_SAND, SOUND_SNOW, SOUND_STONE, SOUND_VALUES, SOUND_WOOD,
  TINT_FIXED, TINT_FOLIAGE, TINT_GRASS, TINT_NONE, TINT_VALUES, TINT_WATER,
} from '../../src/world/blocks/kinds';
import { buildRegistry, MAX_STATES, type BlockDef, type BlockRegistry, type PropertyDef } from '../../src/world/blocks/registry';
import { AIR_TABLES, FIXTURE_BASE, FIXTURE_DEFS, FIXTURE_STATE_COUNT, SOLID_TABLES } from '../harness/blockFixtures';

const R: BlockRegistry = buildRegistry(FIXTURE_DEFS);
const T = (name: string): number => R.typeId(name);
const S = (name: string, props: Record<string, string> = {}): number => R.stateOf(T(name), props);
const allStates = (): number[] => Array.from({ length: R.stateCount }, (_, s) => s);

describe('kinds and codes (SP3a spec §2.1, §2.2)', () => {
  test('property kinds and their values, in kind order', () => {
    expect(PROPERTY_KINDS).toEqual(['axis', 'facing4', 'facing6', 'half', 'open', 'hinge', 'slabType']);
    expect(KIND_VALUES).toEqual({
      axis: ['x', 'y', 'z'],
      facing4: ['north', 'east', 'south', 'west'],
      facing6: ['north', 'east', 'south', 'west', 'up', 'down'],
      half: ['bottom', 'top'],
      open: ['false', 'true'],
      hinge: ['left', 'right'],
      slabType: ['bottom', 'top', 'double'],
    });
    expect(Object.isFrozen(KIND_VALUES)).toBe(true);
    for (const k of PROPERTY_KINDS) expect(Object.isFrozen(KIND_VALUES[k])).toBe(true);
  });

  test('enum tables store the 0-based index of the value in the §2.1 order', () => {
    expect(PASS_VALUES).toEqual(['none', 'opaque', 'cutout', 'translucent']);
    expect([PASS_NONE, PASS_OPAQUE, PASS_CUTOUT, PASS_TRANSLUCENT]).toEqual([0, 1, 2, 3]);
    expect(SHAPE_VALUES).toEqual(['none', 'cube', 'cross', 'fluid', 'pointed', 'box']);
    expect([SHAPE_NONE, SHAPE_CUBE, SHAPE_CROSS, SHAPE_FLUID, SHAPE_POINTED, SHAPE_BOX]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(COLLIDE_VALUES).toEqual(['none', 'cube', 'boxes']);
    expect([COLLIDE_NONE, COLLIDE_CUBE, COLLIDE_BOXES]).toEqual([0, 1, 2]);
    expect(FLUID_MODE_VALUES).toEqual(['block', 'hold', 'displace']);
    expect([FLUID_MODE_BLOCK, FLUID_MODE_HOLD, FLUID_MODE_DISPLACE]).toEqual([0, 1, 2]);
    expect(TINT_VALUES).toEqual(['none', 'grass', 'foliage', 'water', 'fixed']);
    expect([TINT_NONE, TINT_GRASS, TINT_FOLIAGE, TINT_WATER, TINT_FIXED]).toEqual([0, 1, 2, 3, 4]);
    expect(SOUND_VALUES).toEqual(['none', 'stone', 'dirt', 'grass', 'sand', 'gravel', 'wood', 'snow', 'glass', 'leaves', 'metal', 'abyss']);
    expect([SOUND_NONE, SOUND_STONE, SOUND_DIRT, SOUND_GRASS, SOUND_SAND, SOUND_GRAVEL, SOUND_WOOD, SOUND_SNOW, SOUND_GLASS,
      SOUND_LEAVES, SOUND_METAL, SOUND_ABYSS]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('faces follow the facing6 order; FULL_FACES bit i is face i', () => {
    expect(FACE_NAMES).toEqual(KIND_VALUES.facing6);
    expect([FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST, FACE_UP, FACE_DOWN]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(FACE_COUNT).toBe(6);
    expect(ALL_FACES).toBe(63);
  });
});

describe('ids: contiguous per type, the default first, then mixed-radix order (§2.2)', () => {
  test('types and states follow the definition order', () => {
    expect(R.typeCount).toBe(FIXTURE_DEFS.length);
    expect(R.stateCount).toBe(FIXTURE_STATE_COUNT);
    FIXTURE_DEFS.forEach((d, t) => {
      expect(R.typeId(d.name)).toBe(t);
      expect(R.typeName(t)).toBe(d.name);
      expect(R.DEFAULT_STATE[t]).toBe(FIXTURE_BASE[d.name as keyof typeof FIXTURE_BASE]);
      expect(R.stateOf(t)).toBe(R.DEFAULT_STATE[t]);
    });
  });

  test('STATE_TYPE is contiguous: each type owns [DEFAULT_STATE, next DEFAULT_STATE)', () => {
    for (let t = 0; t < R.typeCount; t++) {
      const end = t + 1 < R.typeCount ? R.DEFAULT_STATE[t + 1]! : R.stateCount;
      for (let s = R.DEFAULT_STATE[t]!; s < end; s++) expect(R.STATE_TYPE[s]).toBe(t);
    }
    expect(R.STATE_TYPE.length).toBe(MAX_STATES);
  });

  test('axis default y: base + 0 is y, then x, then z (the §2.2 example)', () => {
    const b = FIXTURE_BASE.log;
    expect([S('log', { axis: 'y' }), S('log', { axis: 'x' }), S('log', { axis: 'z' })]).toEqual([b, b + 1, b + 2]);
  });

  test('two properties, defaults not first (axis y, half top): the exact id sequence', () => {
    const b = FIXTURE_BASE.pillar;
    const seq = [0, 1, 2, 3, 4, 5].map((i) => R.propsOf(b + i));
    expect(seq).toEqual([
      { axis: 'y', half: 'top' },
      { axis: 'x', half: 'bottom' },
      { axis: 'x', half: 'top' },
      { axis: 'y', half: 'bottom' },
      { axis: 'z', half: 'bottom' },
      { axis: 'z', half: 'top' },
    ]);
    expect(R.DEFAULT_STATE[T('pillar')]).toBe(b);
    expect(R.STATE_TYPE[b + 6]).toBe(T('door'));
  });

  test('the door: 4 × 2 × 2 × 2 states, the last property varying fastest', () => {
    const b = FIXTURE_BASE.door;
    expect(R.propsOf(b)).toEqual({ facing: 'north', half: 'bottom', open: 'false', hinge: 'left' });
    expect(R.propsOf(b + 1)).toEqual({ facing: 'north', half: 'bottom', open: 'false', hinge: 'right' });
    expect(R.propsOf(b + 2)).toEqual({ facing: 'north', half: 'bottom', open: 'true', hinge: 'left' });
    expect(R.propsOf(b + 8)).toEqual({ facing: 'east', half: 'bottom', open: 'false', hinge: 'left' });
    expect(R.propsOf(b + 31)).toEqual({ facing: 'west', half: 'top', open: 'true', hinge: 'right' });
  });
});

describe('round trips over every state', () => {
  test('stateOf(propsOf(s)) = s; propsOf is frozen and lists properties in declaration order', () => {
    for (const s of allStates()) {
      const p = R.propsOf(s);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.keys(p)).toEqual((FIXTURE_DEFS[R.STATE_TYPE[s]!]!.props ?? []).map((d) => d.name));
      expect(R.stateOf(R.STATE_TYPE[s]!, p)).toBe(s);
    }
  });

  test('missing props take the defaults', () => {
    expect(R.propsOf(S('pillar', { axis: 'z' }))).toEqual({ axis: 'z', half: 'top' });
    expect(R.propsOf(S('door', { hinge: 'right' }))).toEqual({ facing: 'north', half: 'bottom', open: 'false', hinge: 'right' });
  });

  test('withProp sets one property and leaves the others; setting it back returns the state', () => {
    for (const s of allStates()) {
      const t = R.STATE_TYPE[s]!;
      const p = R.propsOf(s);
      for (const d of FIXTURE_DEFS[t]!.props ?? []) {
        for (const v of KIND_VALUES[d.kind]) {
          const s2 = R.withProp(s, d.name, v);
          expect(R.STATE_TYPE[s2]).toBe(t);
          expect(R.propsOf(s2)).toEqual({ ...p, [d.name]: v });
          expect(R.withProp(s2, d.name, p[d.name]!)).toBe(s);
        }
      }
    }
  });

  test('stateKey/parseStateKey round-trip; keys are unique ASCII', () => {
    const keys = new Set<string>();
    for (const s of allStates()) {
      const k = R.stateKey(s);
      expect(k).toMatch(/^[\x20-\x7e]+$/);
      expect(R.parseStateKey(k)).toBe(s);
      keys.add(k);
    }
    expect(keys.size).toBe(R.stateCount);
  });

  test('canonical keys: bare name without properties, every property in declaration order otherwise', () => {
    expect(R.stateKey(0)).toBe('air');
    expect(R.stateKey(S('log'))).toBe('log[axis=y]');
    expect(R.stateKey(S('pillar', { axis: 'x', half: 'bottom' }))).toBe('pillar[axis=x,half=bottom]');
    expect(R.stateKey(S('door'))).toBe('door[facing=north,half=bottom,open=false,hinge=left]');
    expect(R.stateKey(S('slab', { type: 'double' }))).toBe('slab[type=double]');
  });
});

describe('rotateState: clockwise seen from +y (§2.2)', () => {
  test('one quarter turn for every kind', () => {
    expect(R.rotateState(S('chest', { facing: 'north' }), 1)).toBe(S('chest', { facing: 'east' }));
    expect(R.rotateState(S('chest', { facing: 'west' }), 1)).toBe(S('chest', { facing: 'north' }));
    expect(R.rotateState(S('piston', { facing: 'up' }), 1)).toBe(S('piston', { facing: 'up' }));
    expect(R.rotateState(S('piston', { facing: 'down' }), 1)).toBe(S('piston', { facing: 'down' }));
    expect(R.rotateState(S('piston', { facing: 'south' }), 1)).toBe(S('piston', { facing: 'west' }));
    expect(R.rotateState(S('log', { axis: 'x' }), 1)).toBe(S('log', { axis: 'z' }));
    expect(R.rotateState(S('log', { axis: 'z' }), 1)).toBe(S('log', { axis: 'x' }));
    expect(R.rotateState(S('log', { axis: 'y' }), 1)).toBe(S('log', { axis: 'y' }));
    for (const [name, prop, values] of [['half_block', 'half', ['bottom', 'top']], ['trapdoor', 'open', ['false', 'true']],
      ['gate', 'hinge', ['left', 'right']], ['slab', 'type', ['bottom', 'top', 'double']]] as const) {
      for (const v of values) for (const q of [1, 2, 3]) expect(R.rotateState(S(name, { [prop]: v }), q)).toBe(S(name, { [prop]: v }));
    }
    expect(R.rotateState(S('door', { facing: 'south', half: 'top', open: 'true', hinge: 'right' }), 1))
      .toBe(S('door', { facing: 'west', half: 'top', open: 'true', hinge: 'right' }));
    expect(R.rotateState(0, 1)).toBe(0);
  });

  test('quarterTurns −1 and 5', () => {
    const north = S('chest', { facing: 'north' });
    expect(R.rotateState(north, -1)).toBe(S('chest', { facing: 'west' }));
    expect(R.rotateState(north, 5)).toBe(S('chest', { facing: 'east' }));
    expect(R.rotateState(north, 2)).toBe(S('chest', { facing: 'south' }));
    expect(R.rotateState(north, -6)).toBe(S('chest', { facing: 'south' }));
    expect(R.rotateState(S('log', { axis: 'x' }), -1)).toBe(S('log', { axis: 'z' }));
    expect(R.rotateState(S('log', { axis: 'x' }), 2)).toBe(S('log', { axis: 'x' }));
  });

  test('four turns are the identity; q then −q is the identity', () => {
    for (const s of allStates()) {
      let r = s;
      for (let i = 0; i < 4; i++) r = R.rotateState(r, 1);
      expect(r).toBe(s);
      for (const q of [0, 1, 2, 3, 4, -3]) expect(R.rotateState(R.rotateState(s, q), -q)).toBe(s);
    }
  });
});

describe('mirrorState (§2.2)', () => {
  test("each mirror axis for every kind", () => {
    expect(R.mirrorState(S('chest', { facing: 'east' }), 'x')).toBe(S('chest', { facing: 'west' }));
    expect(R.mirrorState(S('chest', { facing: 'north' }), 'x')).toBe(S('chest', { facing: 'north' }));
    expect(R.mirrorState(S('chest', { facing: 'north' }), 'z')).toBe(S('chest', { facing: 'south' }));
    expect(R.mirrorState(S('chest', { facing: 'east' }), 'z')).toBe(S('chest', { facing: 'east' }));
    expect(R.mirrorState(S('piston', { facing: 'west' }), 'x')).toBe(S('piston', { facing: 'east' }));
    expect(R.mirrorState(S('piston', { facing: 'south' }), 'z')).toBe(S('piston', { facing: 'north' }));
    for (const a of ['x', 'z'] as const) {
      expect(R.mirrorState(S('piston', { facing: 'up' }), a)).toBe(S('piston', { facing: 'up' }));
      expect(R.mirrorState(S('piston', { facing: 'down' }), a)).toBe(S('piston', { facing: 'down' }));
      expect(R.mirrorState(S('gate', { hinge: 'left' }), a)).toBe(S('gate', { hinge: 'right' }));
      expect(R.mirrorState(S('gate', { hinge: 'right' }), a)).toBe(S('gate', { hinge: 'left' }));
      for (const v of ['x', 'y', 'z']) expect(R.mirrorState(S('log', { axis: v }), a)).toBe(S('log', { axis: v }));
      for (const v of ['bottom', 'top']) expect(R.mirrorState(S('half_block', { half: v }), a)).toBe(S('half_block', { half: v }));
      for (const v of ['false', 'true']) expect(R.mirrorState(S('trapdoor', { open: v }), a)).toBe(S('trapdoor', { open: v }));
      for (const v of ['bottom', 'top', 'double']) expect(R.mirrorState(S('slab', { type: v }), a)).toBe(S('slab', { type: v }));
      expect(R.mirrorState(0, a)).toBe(0);
    }
    expect(R.mirrorState(S('door', { facing: 'east', half: 'top', open: 'true', hinge: 'left' }), 'x'))
      .toBe(S('door', { facing: 'west', half: 'top', open: 'true', hinge: 'right' }));
  });

  test('mirroring twice is the identity', () => {
    for (const s of allStates()) for (const a of ['x', 'z'] as const) expect(R.mirrorState(R.mirrorState(s, a), a)).toBe(s);
  });
});

describe('withType (§2.2)', () => {
  test('keeps a shared property of the same kind', () => {
    expect(R.withType(S('door', { facing: 'east', open: 'true' }), T('chest'))).toBe(S('chest', { facing: 'east' }));
    expect(R.withType(S('pillar', { axis: 'z', half: 'bottom' }), T('log'))).toBe(S('log', { axis: 'z' }));
    expect(R.withType(S('log', { axis: 'x' }), T('pillar'))).toBe(S('pillar', { axis: 'x', half: 'top' }));
    expect(R.withType(S('half_block', { half: 'top' }), T('door'))).toBe(S('door', { half: 'top' }));
  });

  test('defaults a same-named property of another kind, and every property the source lacks', () => {
    expect(R.withType(S('piston', { facing: 'up' }), T('chest'))).toBe(S('chest'));
    expect(R.withType(S('piston', { facing: 'east' }), T('chest'))).toBe(S('chest'));
    expect(R.withType(S('chest', { facing: 'east' }), T('piston'))).toBe(S('piston'));
    expect(R.withType(0, T('door'))).toBe(S('door'));
    expect(R.withType(S('door', { facing: 'west' }), T('air'))).toBe(0);
  });

  test('to its own type it is the identity', () => {
    for (const s of allStates()) expect(R.withType(s, R.STATE_TYPE[s]!)).toBe(s);
  });
});

describe('per-state tables (SoA, sized MAX_STATES)', () => {
  test('constants and functions of the state properties', () => {
    expect(MAX_STATES).toBe(4096);
    for (const tab of [R.OPACITY, R.PASS, R.SHAPE, R.FULL_FACES, R.EMIT, R.CARVABLE, R.REPLACEABLE, R.COLLIDE, R.FLUID_MODE, R.TINT, R.SOUND]) {
      expect(tab).toBeInstanceOf(Uint8Array);
      expect(tab.length).toBe(MAX_STATES);
    }
    expect(R.STATE_TYPE).toBeInstanceOf(Uint16Array);
    expect(R.FACE_TEX).toBeInstanceOf(Uint16Array);
    expect(R.FACE_TEX.length).toBe(MAX_STATES * 6);
    const air = 0;
    expect([R.OPACITY[air], R.PASS[air], R.SHAPE[air], R.FULL_FACES[air], R.CARVABLE[air], R.REPLACEABLE[air], R.COLLIDE[air],
      R.FLUID_MODE[air], R.SOUND[air]]).toEqual([0, PASS_NONE, SHAPE_NONE, 0, 0, 1, COLLIDE_NONE, FLUID_MODE_DISPLACE, SOUND_NONE]);
    const log = S('log', { axis: 'z' });
    expect([R.OPACITY[log], R.PASS[log], R.SHAPE[log], R.FULL_FACES[log], R.CARVABLE[log], R.REPLACEABLE[log], R.COLLIDE[log],
      R.FLUID_MODE[log], R.SOUND[log], R.TINT[log], R.EMIT[log]]).toEqual([15, PASS_OPAQUE, SHAPE_CUBE, 63, 1, 0, COLLIDE_CUBE, FLUID_MODE_BLOCK, SOUND_WOOD, TINT_NONE, 0]);
    expect(R.OPACITY[S('trapdoor', { open: 'true' })]).toBe(0);
    expect(R.OPACITY[S('trapdoor', { open: 'false' })]).toBe(1);
    expect(R.COLLIDE[S('trapdoor', { open: 'true' })]).toBe(COLLIDE_NONE);
    expect(R.COLLIDE[S('trapdoor', { open: 'false' })]).toBe(COLLIDE_BOXES);
    expect(R.PASS[S('trapdoor')]).toBe(PASS_CUTOUT);
    expect(R.EMIT[S('gate', { hinge: 'right' })]).toBe(7);
    expect(R.FULL_FACES[S('slab', { type: 'top' })]).toBe(1 << FACE_UP);
    expect(R.FULL_FACES[S('slab', { type: 'bottom' })]).toBe(1 << FACE_DOWN);
    expect(R.FULL_FACES[S('slab', { type: 'double' })]).toBe(ALL_FACES);
    expect(R.SHAPE[S('half_block')]).toBe(SHAPE_BOX);
    expect(R.TINT[S('pillar', { axis: 'x' })]).toBe(TINT_FOLIAGE);
    expect(R.FLUID_MODE[S('door')]).toBe(FLUID_MODE_HOLD);
  });

  test('FACE_TEX[state·6 + i] is face i; a constant fills all six', () => {
    const up = S('piston', { facing: 'up' });
    expect(Array.from(R.FACE_TEX.subarray(up * 6, up * 6 + 6))).toEqual([2, 2, 2, 2, 1, 2]);
    const east = S('piston', { facing: 'east' });
    expect(R.FACE_TEX[east * 6 + FACE_EAST]).toBe(1);
    expect(R.FACE_TEX[east * 6 + FACE_NORTH]).toBe(2);
    const log = S('log');
    expect(Array.from(R.FACE_TEX.subarray(log * 6, log * 6 + 6))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('entries past the last state stay 0', () => {
    for (const tab of [R.OPACITY, R.FULL_FACES, R.STATE_TYPE, R.SOUND]) expect(tab.subarray(R.stateCount).every((v) => v === 0)).toBe(true);
  });
});

describe('buildRegistry checks', () => {
  const opens = (n: number, name = 'many'): BlockDef => ({
    name, props: Array.from({ length: n }, (_, i): PropertyDef => ({ name: `o${i}`, kind: 'open', default: 'false' })), ...SOLID_TABLES,
  });

  test('MAX_STATES: exactly 4096 states build, one more throws', () => {
    const full = buildRegistry([opens(12)]);
    expect(full.stateCount).toBe(4096);
    expect(full.STATE_TYPE.length).toBe(MAX_STATES);
    expect(full.stateKey(4095)).toBe(`many[${Array.from({ length: 12 }, (_, i) => `o${i}=true`).join(',')}]`);
    expect(() => buildRegistry([opens(12), { name: 'air', ...AIR_TABLES }])).toThrow(/4096/);
    expect(() => buildRegistry([opens(13)])).toThrow(/4096/);
  });

  test('names, kinds and defaults', () => {
    const solid = (d: Partial<BlockDef> & { name: string }): BlockDef => ({ ...SOLID_TABLES, ...d });
    expect(() => buildRegistry([])).toThrow(/at least one/);
    expect(() => buildRegistry([solid({ name: 'Stone' })])).toThrow(/name/);
    expect(() => buildRegistry([solid({ name: '1stone' })])).toThrow(/name/);
    expect(() => buildRegistry([solid({ name: 'stone' }), solid({ name: 'stone' })])).toThrow(/duplicate/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'Axis', kind: 'axis', default: 'y' }] })])).toThrow(/name/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'a', kind: 'axis', default: 'y' }, { name: 'a', kind: 'half', default: 'top' }] })])).toThrow(/duplicate/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'a', kind: 'axis', default: 'w' }] })])).toThrow(/default/);
    expect(() => buildRegistry([solid({ name: 'log', props: [{ name: 'a', kind: 'color' as never, default: 'red' }] })])).toThrow(/kind/);
  });

  test('table values', () => {
    const bad = (d: Partial<BlockDef>) => () => buildRegistry([{ ...SOLID_TABLES, name: 'x', ...d } as BlockDef]);
    expect(bad({ opacity: 7 as never })).toThrow(/opacity/);
    expect(bad({ pass: 'glass' as never })).toThrow(/pass/);
    expect(bad({ shape: 'sphere' as never })).toThrow(/shape/);
    expect(bad({ collide: 'mesh' as never })).toThrow(/collide/);
    expect(bad({ fluidMode: 'flow' as never })).toThrow(/fluidMode/);
    expect(bad({ tint: 'red' as never })).toThrow(/tint/);
    expect(bad({ sound: 'boom' as never })).toThrow(/sound/);
    expect(bad({ fullFaces: 64 })).toThrow(/fullFaces/);
    expect(bad({ fullFaces: 1.5 })).toThrow(/fullFaces/);
    expect(bad({ emit: 16 })).toThrow(/emit/);
    expect(bad({ emit: -1 })).toThrow(/emit/);
    expect(bad({ faceTex: [0, 0, 0, 0, 0] })).toThrow(/faceTex/);
    expect(bad({ faceTex: 65536 })).toThrow(/faceTex/);
    expect(bad({ carvable: 1 as never })).toThrow(/carvable/);
    expect(bad({ opacity: (p) => (p['o'] === 'true' ? 3 : 0) as never, props: [{ name: 'o', kind: 'open', default: 'false' }] })).toThrow(/opacity.*x\[o=true\]/);
  });
});

describe('API errors', () => {
  test('unknown types, properties, values and states', () => {
    expect(() => R.typeId('stone')).toThrow(/stone/);
    expect(() => R.typeName(R.typeCount)).toThrow(RangeError);
    expect(() => R.stateOf(T('log'), { facing: 'north' })).toThrow(/facing/);
    expect(() => R.stateOf(T('log'), { axis: 'w' })).toThrow(/axis/);
    expect(() => R.stateOf(R.typeCount)).toThrow(RangeError);
    expect(() => R.withProp(S('log'), 'half', 'top')).toThrow(/half/);
    expect(() => R.withProp(S('log'), 'axis', 'up')).toThrow(/up/);
    for (const s of [-1, R.stateCount, 1.5, Number.NaN]) {
      expect(() => R.propsOf(s)).toThrow(RangeError);
      expect(() => R.stateKey(s)).toThrow(RangeError);
      expect(() => R.rotateState(s, 1)).toThrow(RangeError);
      expect(() => R.mirrorState(s, 'x')).toThrow(RangeError);
    }
    expect(() => R.rotateState(0, 0.5)).toThrow(RangeError);
    expect(() => R.mirrorState(0, 'y' as never)).toThrow(/axis/);
    expect(() => R.withType(0, -1)).toThrow(RangeError);
  });

  test('parseStateKey accepts only canonical keys of registered states', () => {
    for (const k of ['stone', 'log', 'log[]', 'log[axis=w]', 'log[axis=y ]', 'door[facing=north]',
      'door[half=bottom,facing=north,open=false,hinge=left]', 'air[]', 'pillar[axis=x, half=top]']) {
      expect(() => R.parseStateKey(k), k).toThrow(/state key/);
    }
  });

  test('the registry object is frozen', () => {
    expect(Object.isFrozen(R)).toBe(true);
  });
});

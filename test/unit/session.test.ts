import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { WorldSession } from '../../src/engine/session';

const random = () => [7, 1] as const;
const session = () => new WorldSession(random, { seedText: '1' });
const issuesOf = (r: { ok: boolean; issues?: readonly { path: string; code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => `${i.path} ${i.code}`));
const FLAT = { coord: 'C', points: [{ x: -1, y: 40, d: 0 }, { x: 1, y: 90, d: 0 }] };

describe('WorldSession', () => {
  test('defaults: default profile, empty patch, random seed written back', () => {
    const w = new WorldSession(random);
    const s = w.state;
    expect([s.seedText, s.profile, s.patch, s.epoch, w.initNotice]).toEqual(['4294967303', 'default', {}, 0, null]);
    expect(s.params).toBe(resolveProfile('default'));
    expect(w.snapshot).toEqual({ seedText: '4294967303', profile: 'default', patch: {} });
  });
  test('seed text is trimmed; the epoch bumps only when the seed changes; newSeed draws and writes back', () => {
    const w = new WorldSession(random, { seedText: '42' });
    expect(w.setSeedText('  42 ').epoch).toBe(0);
    const s = w.setSeedText('43');
    expect([s.seedText, s.seed, s.epoch]).toEqual(['43', seedFromInput('43'), 1]);
    expect(w.setSeedText('   ').seedText).toBe('4294967303');
    w.setSeedText('43');
    const n = w.newSeed();
    expect([n.seedText, n.seed, n.epoch]).toEqual(['4294967303', seedFromInput('4294967303'), 4]);
  });
  test('profiles: only ready ones; switching clears the patch', () => {
    const w = new WorldSession(random, { seedText: '1', patch: { climate: { scaleMul: 2 } } });
    expect(w.state.params.climate.scaleMul).toBe(2);
    const r = w.setProfile('large_biomes');
    expect(r.ok && [r.state.profile, r.state.patch, r.state.params.climate.scaleMul, r.state.epoch]).toEqual(['large_biomes', {}, 4, 1]);
    const bad = w.setProfile('archipelago');
    expect(issuesOf(bad)).toEqual(['profile BAD_ENUM']);
    expect(issuesOf(w.setProfile('nope' as never))).toEqual(['profile BAD_ENUM']);
    expect(w.state.profile).toBe('large_biomes');
  });
});

describe('set', () => {
  test('a leaf: the patch holds only what differs from the profile', () => {
    const w = session();
    const r = w.set('rivers.widthMin', 6);
    expect(r.ok && [r.state.params.rivers.widthMin, r.state.patch, r.state.epoch]).toEqual([6, { rivers: { widthMin: 6 } }, 1]);
    expect(w.set('rivers.widthMin', 8).ok && [w.state.patch, w.state.epoch]).toEqual([{}, 2]);
  });
  test('a group merges per key', () => {
    const w = session();
    w.set('rivers', { widthMin: 6, depthMin: 4 });
    w.set('rivers', { depthMin: 5 });
    expect(w.state.patch).toEqual({ rivers: { widthMin: 6, depthMin: 5 } });
  });
  test('a noise leaf takes a partial NoiseDef and merges per key; arrays replace', () => {
    const w = session();
    w.set('climate.C', { wavelength: 3000 });
    w.set('climate.C', { octaves: 2, amplitudes: [1, 0.5] });
    w.set('climate.C', { amplitudes: [0.5, 1] });
    expect(w.state.patch).toEqual({ climate: { C: { wavelength: 3000, octaves: 2, amplitudes: [0.5, 1] } } });
    expect(w.state.params.climate.C.persistence).toBe(DEFAULTS.climate.C.persistence);
  });
  test('spline and boxTable leaves replace whole', () => {
    const w = session();
    w.set('shape.offset', FLAT);
    w.set('shape.offset', { coord: 'E', points: [{ x: 0, y: 70, d: 0 }] });
    expect(w.state.params.shape.offset).toEqual({ coord: 'E', points: [{ x: 0, y: 70, d: 0 }] });
    const table = { ...DEFAULTS.biomes.table, plains: { ...DEFAULTS.biomes.table.plains, priority: 999 } };
    expect(w.set('biomes.table', table).ok).toBe(true);
    expect(w.state.params.biomes.table.plains.priority).toBe(999);
    expect(Object.keys(w.state.patch.biomes!.table!)).toHaveLength(26);
  });
  test('an invalid value changes nothing and returns the issues', () => {
    const w = session();
    w.set('rivers.widthMin', 6);
    const before = w.state;
    expect(issuesOf(w.set('climate.scaleMul', 99))).toEqual(['climate.scaleMul OUT_OF_RANGE']);
    expect(issuesOf(w.set('climate.C', { octaves: 3, amplitudes: [1] }))).toEqual(['climate.C.amplitudes AMPLITUDES_LENGTH']);
    expect(issuesOf(w.set('rivers', { nope: 1 }))).toEqual(['rivers.nope UNKNOWN_KEY']);
    expect(issuesOf(w.set('rivers', 5))).toEqual(['rivers NOT_OBJECT']);
    expect(issuesOf(w.set('rivers.widthMin', undefined))).toEqual(['rivers.widthMin NOT_NUMBER']);
    expect(w.state).toBe(before);
  });
  test('an equal value keeps the state object', () => {
    const w = session();
    w.set('rivers.widthMin', 6);
    const before = w.state;
    expect(w.set('rivers.widthMin', 6).ok && w.state).toBe(before);
    expect(w.set('rivers', {}).ok && w.state).toBe(before);
  });
  test('−0 is stored as 0, so the patch always encodes', () => {
    const w = session();
    w.set('rivers.coastFadeLo', -0);
    expect(Object.is(w.state.patch.rivers!.coastFadeLo, 0)).toBe(true);
    expect(canonicalJSON(w.state.patch)).toBe('{"rivers":{"coastFadeLo":0}}');
    w.set('shape.offset', { coord: 'C', points: [{ x: -0, y: -0, d: -0 }] });
    expect(() => canonicalJSON(w.state.patch)).not.toThrow();
  });
  test('the session never stores caller input; state and patch are frozen', () => {
    const w = session();
    const amps = [1, 0.5];
    const def = { octaves: 2, amplitudes: amps };
    w.set('climate.C', def);
    amps[0] = 9;
    def.octaves = 7;
    expect(w.state.params.climate.C.amplitudes).toEqual([1, 0.5]);
    expect(w.state.patch).toEqual({ climate: { C: { octaves: 2, amplitudes: [1, 0.5] } } });
    expect(Object.isFrozen(w.state)).toBe(true);
    expect(Object.isFrozen(w.state.patch.climate!.C)).toBe(true);
    expect(Object.isFrozen(w.state.patch.climate!.C!.amplitudes)).toBe(true);
  });
  test('any path other than a group or leaf path throws', () => {
    const w = session();
    expect(() => w.set('climate.C.wavelength', 1)).toThrow('unknown param path');
    expect(() => w.set('nope', 1)).toThrow('unknown param path');
    expect(() => w.reset('biomes.table.plains')).toThrow('unknown param path');
    expect(() => w.modified('rivers.')).toThrow('unknown param path');
    expect(() => w.modifiedCount('constructor')).toThrow('unknown param path');
  });
});

describe('reset and modified', () => {
  test('reset returns a leaf, a noise leaf as a whole, a group or everything to the profile', () => {
    const w = session();
    w.set('', { rivers: { widthMin: 6, depthMin: 4 }, climate: { scaleMul: 2, C: { wavelength: 3000, octaves: 4 } }, lakes: { p: 0.2 } });
    expect(w.reset('rivers.widthMin').ok && w.state.patch.rivers).toEqual({ depthMin: 4 });
    expect(w.reset('climate.C').ok && w.state.patch.climate).toEqual({ scaleMul: 2 });
    expect(w.reset('climate').ok && w.state.patch).toEqual({ rivers: { depthMin: 4 }, lakes: { p: 0.2 } });
    expect(w.reset('').ok && [w.state.patch, w.state.params]).toEqual([{}, DEFAULTS]);
    expect(w.reset('shape.offset').ok).toBe(true);
  });
  test('modified and modifiedCount on leaves, noise leaves, groups and the root', () => {
    const w = session();
    expect([w.modified(''), w.modifiedCount('')]).toEqual([false, 0]);
    w.set('rivers', { widthMin: 6, depthMin: 4 });
    w.set('climate.C', { octaves: 4 });
    w.set('climate.warp.R.amplitude', 100);
    expect([w.modified('rivers.widthMin'), w.modified('rivers.widthVar'), w.modified('climate.C'), w.modified('climate.E')]).toEqual([true, false, true, false]);
    expect([w.modifiedCount('rivers'), w.modifiedCount('climate'), w.modifiedCount('climate.warp'), w.modifiedCount('lakes'), w.modifiedCount('')]).toEqual([2, 2, 1, 0, 4]);
    expect([w.modifiedCount('climate.C'), w.modifiedCount('rivers.widthVar')]).toEqual([1, 0]);
    w.set('rivers.widthMin', 8);
    expect([w.modified('rivers.widthMin'), w.modifiedCount('')]).toEqual([false, 3]);
  });
});

describe('load', () => {
  test('with seedText: seed, profile and patch in one commit', () => {
    const w = session();
    const r = w.load({ seedText: ' 9 ', profile: 'large_biomes', patch: { rivers: { widthMin: 6 } } });
    expect(r.ok && [r.state.seedText, r.state.seed, r.state.profile, r.state.patch, r.state.params.climate.scaleMul, r.state.epoch])
      .toEqual(['9', seedFromInput('9'), 'large_biomes', { rivers: { widthMin: 6 } }, 4, 1]);
  });
  test('without seedText the seed is kept; the stored patch is minimal', () => {
    const w = session();
    const r = w.load({ profile: 'large_biomes', patch: { climate: { scaleMul: 4 }, rivers: { widthMin: 8 } } });
    expect(r.ok && [r.state.seedText, r.state.profile, r.state.patch]).toEqual(['1', 'large_biomes', {}]);
  });
  test('a load that keeps the seed and the params keeps the epoch', () => {
    const w = session();
    w.set('climate.scaleMul', 4);
    expect(w.state.epoch).toBe(1);
    const r = w.load({ profile: 'large_biomes', patch: {} });
    expect(r.ok && [r.state.profile, r.state.patch, r.state.epoch]).toEqual(['large_biomes', {}, 1]);
  });
  test('an unready profile or an invalid patch changes nothing', () => {
    const w = session();
    w.set('rivers.widthMin', 6);
    const before = w.state;
    expect(issuesOf(w.load({ seedText: '5', profile: 'archipelago', patch: {} }))).toEqual(['profile BAD_ENUM']);
    expect(issuesOf(w.load({ seedText: '5', profile: 'default', patch: { climate: { scaleMul: 99 } } }))).toEqual(['climate.scaleMul OUT_OF_RANGE']);
    expect(issuesOf(w.load({ profile: 'default', patch: null }))).toEqual([' NOT_OBJECT']);
    expect(w.state).toBe(before);
  });
  test('−0 in a loaded patch is stored as 0', () => {
    const w = session();
    w.load({ profile: 'default', patch: JSON.parse('{"rivers":{"coastFadeHi":-0}}') });
    expect(canonicalJSON(w.state.patch)).toBe('{"rivers":{"coastFadeHi":0}}');
  });
});

describe('initial state', () => {
  test('a valid init is kept, minimal and −0-free', () => {
    const w = new WorldSession(random, { seedText: '1', profile: 'large_biomes', patch: JSON.parse('{"climate":{"scaleMul":4},"rivers":{"coastFadeLo":-0}}') });
    expect([w.state.profile, canonicalJSON(w.state.patch), w.initNotice]).toEqual(['large_biomes', '{"rivers":{"coastFadeLo":0}}', null]);
  });
  test('an unready profile falls back to default and {} with a notice', () => {
    const w = new WorldSession(random, { seedText: 'x', profile: 'cave_heavy', patch: { rivers: { widthMin: 6 } } });
    expect([w.state.profile, w.state.patch, w.state.seedText]).toEqual(['default', {}, 'x']);
    expect(w.initNotice).toBe('profile cave_heavy is not available yet; opened the default profile with no changes');
  });
  test('an invalid patch over a ready non-default profile falls back to default and {} with a notice (SP2a minor 8)', () => {
    const w = new WorldSession(random, { seedText: 'x', profile: 'large_biomes', patch: { nope: 1 } });
    expect([w.state.profile, w.state.patch]).toEqual(['default', {}]);
    expect(w.state.params).toBe(resolveProfile('default'));
    expect(w.initNotice).toBe('invalid patch (nope UNKNOWN_KEY); opened the default profile with no changes');
    expect(new WorldSession(random, { patch: null }).initNotice).toBe('invalid patch (<root> NOT_OBJECT); opened the default profile with no changes');
  });
});

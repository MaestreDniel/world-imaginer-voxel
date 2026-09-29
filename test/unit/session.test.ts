import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { WorldSession } from '../../src/engine/session';

const random = () => [7, 1] as const;

describe('WorldSession', () => {
  test('defaults: default profile, empty patch, random seed written back', () => {
    const s = new WorldSession(random).state;
    expect([s.seedText, s.profile, s.patch, s.epoch]).toEqual(['4294967303', 'default', {}, 0]);
    expect(s.params).toBe(resolveProfile('default'));
  });
  test('seed text is trimmed; the epoch bumps only when the seed changes', () => {
    const w = new WorldSession(random, { seedText: '42' });
    expect(w.setSeedText('  42 ').epoch).toBe(0);
    const s = w.setSeedText('43');
    expect([s.seedText, s.seed, s.epoch]).toEqual(['43', seedFromInput('43'), 1]);
    expect(w.setSeedText('   ').seedText).toBe('4294967303');
  });
  test('profiles: only ready ones; switching clears the patch', () => {
    const w = new WorldSession(random, { seedText: '1', patch: { climate: { scaleMul: 2 } } });
    expect(w.state.params.climate.scaleMul).toBe(2);
    const r = w.setProfile('large_biomes');
    expect(r.ok && [r.state.profile, r.state.patch, r.state.params.climate.scaleMul, r.state.epoch]).toEqual(['large_biomes', {}, 4, 1]);
    const bad = w.setProfile('archipelago');
    expect(bad.ok).toBe(false);
    expect(w.state.profile).toBe('large_biomes');
  });
  test('an invalid patch changes nothing; an equivalent patch keeps the epoch', () => {
    const w = new WorldSession(random, { seedText: '1' });
    const bad = w.setPatch({ climate: { scaleMul: 99 } });
    expect(!bad.ok && bad.issues[0]!.code).toBe('OUT_OF_RANGE');
    expect(w.state.epoch).toBe(0);
    const ok = w.setPatch({ rivers: { widthMin: 6 } });
    expect(ok.ok && ok.state.params.rivers.widthMin).toBe(6);
    expect(w.state.epoch).toBe(1);
    expect(w.setPatch({ rivers: { widthMin: 6 } }).ok && w.state.epoch).toBe(1);
    expect(w.setPatch({}).ok && w.state.epoch).toBe(2);
  });
  test('an unready or invalid initial state falls back safely', () => {
    const w = new WorldSession(random, { seedText: 'x', profile: 'cave_heavy', patch: { nope: 1 } as never });
    expect([w.state.profile, w.state.patch]).toEqual(['default', {}]);
  });
});

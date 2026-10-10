/**
 * The session's tier-2 validation hook and its hashed history keys (SP3d spec §1.8 session part, §1.12),
 * with fake validators: the real `validateParamTrees` is wired by the pages (SP3d Task 15).
 */
import { describe, expect, test } from 'vitest';
import { fnv1a64, hex64, type Seed64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import type { Issue } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { draftKeyOf, WorldSession, type ParamsValidator } from '../../src/engine/session';

const random = (): Seed64 => [7, 1];
const TREE_ISSUE: Issue = { path: 'density.defs.root.b.x', code: 'UNKNOWN_OP', message: 'unknown op bogus' };
const issuesOf = (r: { ok: boolean; issues?: readonly Issue[] }) => (r.ok ? [] : r.issues!.map((i) => `${i.path} ${i.code}`));

/** A fake tier 2: refuses params whose `climate.scaleMul` is in `bad`, and logs every document it sees. */
function fake(bad: readonly number[], issue: Issue = TREE_ISSUE): { validate: ParamsValidator; seen: Params[] } {
  const seen: Params[] = [];
  const validate: ParamsValidator = (p) => {
    seen.push(p);
    return bad.includes(p.climate.scaleMul) ? [issue] : [];
  };
  return { validate, seen };
}

const notifications = (w: WorldSession) => {
  const log: string[] = [];
  w.subscribe((_s, c) => log.push(c.kind));
  return log;
};

describe('validateParams: the constructor', () => {
  test('issues take the invalid-patch branch: the default profile, no changes, the notice names the first issue', () => {
    const { validate, seen } = fake([2]);
    const w = new WorldSession(random, { seedText: 'x', profile: 'large_biomes', patch: { climate: { scaleMul: 2 } }, validateParams: validate });
    expect([w.state.profile, w.state.patch, w.state.seedText, w.state.epoch]).toEqual(['default', {}, 'x', 0]);
    expect(w.state.params).toBe(resolveProfile('default'));
    expect(w.initNotice).toBe('invalid patch (density.defs.root.b.x UNKNOWN_OP); opened the default profile with no changes');
    expect(seen.map((p) => p.climate.scaleMul)).toEqual([2]);
    expect([w.canUndo, w.canRedo]).toEqual([false, false]);
  });
  test('an issue at the empty path is named <root>', () => {
    const { validate } = fake([1], { path: '', code: 'NOT_OBJECT', message: 'x' });
    expect(new WorldSession(random, { validateParams: validate }).initNotice).toBe('invalid patch (<root> NOT_OBJECT); opened the default profile with no changes');
  });
  test('accepted params open as given; the validator sees exactly the patched document', () => {
    const { validate, seen } = fake([2]);
    const w = new WorldSession(random, { seedText: '1', profile: 'large_biomes', patch: { climate: { scaleMul: 3 } }, validateParams: validate });
    expect([w.state.profile, w.state.patch, w.initNotice]).toEqual(['large_biomes', { climate: { scaleMul: 3 } }, null]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(w.state.params);
  });
  test('a patch that applyPatch refuses keeps its own notice and never reaches the validator', () => {
    const { validate, seen } = fake([]);
    const w = new WorldSession(random, { patch: { nope: 1 }, validateParams: validate });
    expect(w.initNotice).toBe('invalid patch (nope UNKNOWN_KEY); opened the default profile with no changes');
    expect(seen).toEqual([]);
  });
});

describe('validateParams: setProfile, commits and load refuse; nothing changes', () => {
  test('setProfile refuses a profile whose params fail (large_biomes: scaleMul 4), with the issues; no step, no notification', () => {
    const issue: Issue = { path: 'surface.rules.root.rules[2].then', code: 'NOT_SOLID', message: 'air' };
    const { validate, seen } = fake([4], issue);
    const w = new WorldSession(random, { seedText: '1', patch: { rivers: { widthMin: 6 } }, validateParams: validate });
    const log = notifications(w);
    const before = w.state;
    seen.length = 0;
    const r = w.setProfile('large_biomes');
    expect(r).toEqual({ ok: false, issues: [issue] });
    expect(seen).toEqual([resolveProfile('large_biomes')]);
    expect(w.state).toBe(before);
    expect([log, w.canUndo]).toEqual([[], false]);
  });
  test('set and reset (commitPatch) refuse like an out-of-range value; the last valid draft stays', () => {
    const { validate } = fake([4, 1]);
    const w = new WorldSession(random, { seedText: '1', patch: { climate: { scaleMul: 2 } }, validateParams: validate });
    const log = notifications(w);
    const before = w.state;
    expect(issuesOf(w.set('climate.scaleMul', 4))).toEqual(['density.defs.root.b.x UNKNOWN_OP']);
    expect(issuesOf(w.set('climate', { scaleMul: 4 }))).toEqual(['density.defs.root.b.x UNKNOWN_OP']);
    expect(issuesOf(w.reset('climate.scaleMul'))).toEqual(['density.defs.root.b.x UNKNOWN_OP']);
    expect(issuesOf(w.reset(''))).toEqual(['density.defs.root.b.x UNKNOWN_OP']);
    expect(w.state).toBe(before);
    expect([log, w.canUndo]).toEqual([[], false]);
    expect(w.set('climate.scaleMul', 3).ok).toBe(true);
    expect([w.state.params.climate.scaleMul, log]).toEqual([3, ['set']]);
  });
  test('an applyPatch failure is reported before the validator runs', () => {
    const { validate, seen } = fake([]);
    const w = new WorldSession(random, { seedText: '1', validateParams: validate });
    seen.length = 0;
    expect(issuesOf(w.set('climate.scaleMul', 999))).toEqual(['climate.scaleMul OUT_OF_RANGE']);
    expect(seen).toEqual([]);
  });
  test('load refuses: seed, profile and patch all stay', () => {
    const { validate } = fake([4]);
    const w = new WorldSession(random, { seedText: '1', validateParams: validate });
    const log = notifications(w);
    const before = w.state;
    const r = w.load({ seedText: '99', profile: 'large_biomes', patch: { climate: { scaleMul: 4 } } });
    expect(issuesOf(r)).toEqual(['density.defs.root.b.x UNKNOWN_OP']);
    expect(w.state).toBe(before);
    expect([w.state.seedText, log, w.canUndo]).toEqual(['1', [], false]);
    expect(w.load({ seedText: '99', profile: 'large_biomes', patch: { climate: { scaleMul: 3 } } }).ok).toBe(true);
    expect([w.state.seedText, w.state.profile, log]).toEqual(['99', 'large_biomes', ['load']]);
  });
  test('a seed change keeps the params and does not run the validator', () => {
    const { validate, seen } = fake([]);
    const w = new WorldSession(random, { seedText: '1', validateParams: validate });
    seen.length = 0;
    w.setSeedText('2');
    w.newSeed();
    expect([w.state.seedText, seen.length]).toEqual(['4294967303', 0]);
  });
});

describe('validateParams: restore', () => {
  test('undo and redo validate the snapshot; a refusal is a bug and throws', () => {
    let bad: number[] = [];
    const validate: ParamsValidator = (p) => (bad.includes(p.climate.scaleMul) ? [TREE_ISSUE] : []);
    const w = new WorldSession(random, { seedText: '1', validateParams: validate });
    w.set('climate.scaleMul', 2);
    w.set('climate.scaleMul', 3);
    expect(w.undo() && w.state.params.climate.scaleMul).toBe(2);
    expect(w.redo() && w.state.params.climate.scaleMul).toBe(3);
    bad = [2];
    expect(() => w.undo()).toThrow('history snapshot no longer loads: density.defs.root.b.x UNKNOWN_OP');
  });
});

describe('hashed history keys (SP3d spec §1.12)', () => {
  test('draftKeyOf is fnv1a64 of the snapshot canonical text, 16 hex digits', () => {
    const snap = { seedText: '42', profile: 'default' as const, patch: { climate: { scaleMul: 2 } } };
    const text = canonicalJSON({ seedText: '42', profile: 'default', patch: { climate: { scaleMul: 2 } } });
    expect(draftKeyOf(snap)).toBe(hex64(fnv1a64(text)));
    expect(draftKeyOf(snap)).toMatch(/^[0-9a-f]{16}$/);
    expect(draftKeyOf({ ...snap, patch: { climate: { scaleMul: 3 } } })).not.toBe(draftKeyOf(snap));
    expect(draftKeyOf({ ...snap, seedText: '042' })).not.toBe(draftKeyOf(snap));
    expect(draftKeyOf({ ...snap, profile: 'large_biomes' })).not.toBe(draftKeyOf(snap));
  });
  test('undo, redo and the redo tail work on the hashed keys', () => {
    const w = new WorldSession(random, { seedText: '1' });
    for (const v of [2, 3, 4]) w.set('climate.scaleMul', v);
    expect(w.undo() && w.undo() && w.state.params.climate.scaleMul).toBe(2);
    w.set('climate.scaleMul', 2);
    expect([w.canUndo, w.canRedo]).toEqual([true, true]);
    w.beginGesture();
    w.set('climate.scaleMul', 3.5);
    expect([w.canUndo, w.canRedo]).toEqual([true, false]);
    w.set('climate.scaleMul', 2);
    w.endGesture();
    expect(w.redo() && w.state.params.climate.scaleMul).toBe(3);
    w.set('climate.scaleMul', 5);
    expect([w.canRedo, w.undo() && w.state.params.climate.scaleMul]).toEqual([false, 3]);
    expect(w.undo() && w.undo() && [w.state.params.climate.scaleMul, w.canUndo]).toEqual([1, false]);
  });
});

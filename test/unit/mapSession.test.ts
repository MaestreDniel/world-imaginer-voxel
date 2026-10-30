/**
 * The ?map page's session with the real tier 2 (SP3d spec §1.8, §1.11, §1.12): `openMapSession` wires
 * `validateParamTrees` as the session's `validateParams`, so a link, a profile switch or a `hashchange` with a
 * semantically invalid tree is refused, and a slider edit neither revalidates nor copies the trees.
 */
import { describe, expect, test, vi } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { applyPatch, diffParams } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA, type Params } from '../../src/core/params/schema';
import type { SessionChange, SessionSnapshot } from '../../src/engine/session';
import { densitySourceValidations } from '../../src/gen/density/source';
import { rulesSourceValidations } from '../../src/gen/surface/source';
import { applyMapHash, DEFAULT_MAP_STATE, decodeMapState, encodeMapState, openMapSession, openSavedSession, type MapState, type MapView } from '../../src/ui/map/mapState';
import { densityTree, editedPatch } from './fixtures/editedTrees';

/** While `hooks.badProfile` is set, `resolveProfile('large_biomes')` carries a density tree tier 2 refuses (every real profile passes, §1.8). */
const hooks = vi.hoisted(() => ({ badProfile: false }));
vi.mock('../../src/core/params/profiles', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/params/profiles')>();
  return {
    ...orig,
    resolveProfile: (id: Parameters<typeof orig.resolveProfile>[0]): Params => {
      const p = orig.resolveProfile(id);
      if (!hooks.badProfile || id !== 'large_biomes') return p;
      return { ...p, density: { ...p.density, defs: { root: { op: 'add', a: { op: 'y' }, b: { op: 'bogus' } }, defs: {} } } } as unknown as Params;
    },
  };
});

const random = (): Seed64 => [3, 9];
const VIEW: MapView = DEFAULT_MAP_STATE.view;

/** The default density tree with `root.b.x` (the islands constant) replaced by an unknown op: tier 1 passes, tier 2 does not. */
function bogusDensity(): unknown {
  const t = densityTree();
  t['root'].b.x = { op: 'bogus' };
  return t;
}
const bogusState = (view: MapView = VIEW): MapState => ({ ...DEFAULT_MAP_STATE, seed: '7', patch: { density: { defs: bogusDensity() } } as MapState['patch'], view });
const historyOf = (w: object) => (w as unknown as { history: { snap: SessionSnapshot }[] }).history;
const defsOf = (patch: unknown) => (patch as { density: { defs: unknown } }).density.defs;
const rulesOf = (patch: unknown) => (patch as { surface: { rules: unknown } }).surface.rules;

describe('openMapSession: the constructor runs tier 2', () => {
  test('a tier-2-invalid tree in the start state opens the defaults with the notice naming its path and code', () => {
    const w = openMapSession(bogusState(), random);
    expect(w.initNotice).toBe('invalid patch (density.defs.root.b.x UNKNOWN_OP); opened the default profile with no changes');
    expect([w.state.seedText, w.state.profile, w.state.patch, w.state.epoch]).toEqual(['7', 'default', {}, 0]);
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
  });

  test('a fresh tab: decodeMapState checks tier 1 only, the session refuses the tree', () => {
    const d = decodeMapState(`#${encodeMapState(bogusState())}`);
    expect(d.error).toBeNull();
    const w = openMapSession(d.state, random);
    expect(w.initNotice).toMatch(/^invalid patch \(density\.defs\.root\.b\.x UNKNOWN_OP\); /);
    expect(w.modifiedCount('')).toBe(0);
  });

  test('a valid edited start state opens as it is', () => {
    const w = openMapSession({ ...DEFAULT_MAP_STATE, patch: editedPatch() }, random);
    expect(w.initNotice).toBeNull();
    expect([w.state.profile, w.modifiedCount(''), w.modified('density.defs'), w.modified('surface.rules')]).toEqual(['default', 2, true, true]);
    expect(Object.isFrozen(w.state.params.density.defs)).toBe(true);
  });

  test('the default start state opens the default trees with no notice', () => {
    const w = openMapSession(DEFAULT_MAP_STATE, random);
    expect(w.initNotice).toBeNull();
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
    expect(w.state.params.surface.rules).toBe(DEFAULT_SURFACE_RULES);
  });
});

describe('openMapSession: setProfile, commits and loads run tier 2', () => {
  test('setProfile refuses a profile whose trees tier 2 refuses; nothing changes', () => {
    const w = openMapSession({ ...DEFAULT_MAP_STATE, patch: { climate: { scaleMul: 2 } } }, random);
    const before = w.state;
    hooks.badProfile = true;
    try {
      const r = w.setProfile('large_biomes');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['density.defs.root.b UNKNOWN_OP']);
      expect(w.state).toBe(before);
    } finally {
      hooks.badProfile = false;
    }
    expect(w.setProfile('large_biomes').ok).toBe(true);
  });

  test('a commit of a tier-2-invalid tree is refused with its path; the tree is kept', () => {
    const w = openMapSession(DEFAULT_MAP_STATE, random);
    const r = w.set('density.defs', bogusDensity());
    expect(r.ok ? [] : r.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['density.defs.root.b.x UNKNOWN_OP']);
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
  });

  test('a tier-2-invalid hash is refused through applyMapHash (hashchange): the draft and history are unchanged', () => {
    const w = openMapSession({ ...DEFAULT_MAP_STATE, patch: { climate: { scaleMul: 2 } } }, random);
    const before = w.state;
    const changes: SessionChange[] = [];
    w.subscribe((_s, c) => changes.push(c));
    const views: MapView[] = [];
    const view: MapView = { ...VIEW, x: 640, layer: 'relief' };
    expect(applyMapHash(`#${encodeMapState(bogusState(view))}`, w, (v) => views.push(v))).toBe('map URL ignored: density.defs.root.b.x UNKNOWN_OP');
    expect(w.state).toBe(before);
    expect(changes).toEqual([]);
    expect(w.canUndo).toBe(false);
    // The view is applied before the load (SP2b §1.4), so it moves; the draft does not.
    expect(views).toEqual([view]);
    // A valid edited hash then loads.
    expect(applyMapHash(`#${encodeMapState({ ...DEFAULT_MAP_STATE, patch: editedPatch() })}`, w, () => {})).toBeNull();
    expect(w.modified('density.defs')).toBe(true);
  });
});

describe('openMapSession: slider edits keep the trees (SP3d spec §1.12)', () => {
  test('a slider-only commit misses neither memo (no tier-2 revalidation)', () => {
    const w = openMapSession({ ...DEFAULT_MAP_STATE, patch: editedPatch() }, random);
    const d0 = densitySourceValidations();
    const r0 = rulesSourceValidations();
    expect(w.set('climate.scaleMul', 2).ok).toBe(true);
    expect(w.set('density.detailAmpLo', 0.7).ok).toBe(true);
    expect(w.set('surface.snowline', -0.25).ok).toBe(true);
    expect([densitySourceValidations() - d0, rulesSourceValidations() - r0]).toEqual([0, 0]);
    // So is an undo and a redo of them.
    expect(w.undo() && w.undo() && w.redo()).toBe(true);
    expect([densitySourceValidations() - d0, rulesSourceValidations() - r0]).toEqual([0, 0]);
  });

  test('two slider edits keep the same density.defs object in the state and in both history snapshots', () => {
    const w = openMapSession({ ...DEFAULT_MAP_STATE, patch: editedPatch() }, random);
    const defs = w.state.params.density.defs;
    const rules = w.state.params.surface.rules;
    expect(defs).not.toBe(DEFAULT_DENSITY_TREE);
    expect(defsOf(w.state.patch)).toBe(defs);
    expect(w.set('climate.scaleMul', 2).ok).toBe(true);
    expect(w.set('climate.scaleMul', 3).ok).toBe(true);
    expect(w.state.params.density.defs).toBe(defs);
    expect(w.state.params.surface.rules).toBe(rules);
    expect(defsOf(w.state.patch)).toBe(defs);
    const history = historyOf(w);
    expect(history.length).toBe(3);
    for (const e of history) {
      expect(defsOf(e.snap.patch)).toBe(defs);
      expect(rulesOf(e.snap.patch)).toBe(rules);
    }
    expect(w.undo()).toBe(true);
    expect([w.state.params.climate.scaleMul, w.state.params.density.defs]).toEqual([2, defs]);
    expect(w.state.params.density.defs).toBe(defs);
  });
});

describe('openSavedSession: a saved world\'s session (SP5b spec §2.1, §3.4 step 2)', () => {
  test('`openSavedSession` over amplified params equals `openMapSession` of the same seed, profile and patch', () => {
    const r = applyPatch(SCHEMA, resolveProfile('amplified'), { ...editedPatch(), climate: { scaleMul: 2 } });
    if (!r.ok) throw new Error('the amplified patch');
    const saved = openSavedSession(r.value, { seedText: 'hello', profile: 'amplified' }, random);
    const patch = diffParams(SCHEMA, resolveProfile('amplified'), r.value);
    const map = openMapSession({ ...DEFAULT_MAP_STATE, seed: 'hello', profile: 'amplified', patch }, random);
    expect(saved.initNotice).toBeNull();
    expect(saved.state).toEqual(map.state);
    expect([saved.state.seedText, saved.state.profile, saved.modifiedCount('')]).toEqual(['hello', 'amplified', 3]);
    expect(saved.state.params).toEqual(r.value);
    // Tier 2 runs on it as on the map's (the arch's uiSessions rule): a tree it refuses is refused.
    expect(saved.set('density.defs', bogusDensity()).ok).toBe(false);
  });
});

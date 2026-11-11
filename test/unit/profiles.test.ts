import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { deletePath, mapPath, migrate, MIGRATIONS, renamePath, SCHEMA_VERSION, type JsonObject, type JsonValue } from '../../src/core/params/migrate';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { CURRENT_SP } from '../../src/core/ids';
import { isProfileReady, PROFILE_IDS, PROFILES, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, genKey, stageHashes } from '../../src/core/stage/hash';
import { STAGES } from '../../src/core/stage/registry';
import { randomParams } from '../harness/params';
import { sp5cTrees, type Sp5cKind } from '../harness/sp5cTrees';
import { sp6aTrees, type Sp6aKind } from '../harness/sp6aTrees';
import { testRng } from '../harness/stats';

describe('profiles', () => {
  test('ids, readiness and overlays', () => {
    expect(Object.keys(PROFILES)).toEqual([...PROFILE_IDS]);
    expect(PROFILE_IDS.map((id) => [id, PROFILES[id].readyFrom])).toEqual([
      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3e'], ['amplified', 'SP3e'], ['floating_islands', 'SP3e'], ['cave_heavy', 'SP6b'],
    ]);
    expect(resolveProfile('large_biomes').climate.scaleMul).toBe(4);
    expect(resolveProfile('archipelago').climate.C.wavelength).toBe(840);
    expect(resolveProfile('default')).toBe(DEFAULTS);
  });
  test('readiness follows CURRENT_SP: from SP3e every profile but cave_heavy is ready (SP3e spec §11; SP4a spec §12)', () => {
    expect(CURRENT_SP).toBe('SP6a');
    expect(PROFILE_IDS.filter((id) => isProfileReady(id))).toEqual(['default', 'large_biomes', 'archipelago', 'amplified', 'floating_islands']);
    expect(isProfileReady('cave_heavy')).toBe(false);
    expect(isProfileReady('cave_heavy', 'SP6b')).toBe(true);
    expect(isProfileReady('cave_heavy', 'SP6a')).toBe(false);
    expect(isProfileReady('archipelago', 'SP3e')).toBe(true);
    expect(isProfileReady('archipelago', 'SP3d')).toBe(false);
    expect(isProfileReady('archipelago', 'SP3c')).toBe(false);
    expect(isProfileReady('archipelago', 'SP3b')).toBe(false);
    expect(isProfileReady('large_biomes', 'SP1')).toBe(false);
  });
  test('switching profile dirties exactly what its overlay touches (SP3e spec §1.1: per profile, from the overlay\'s top-level keys and the registry)', () => {
    const base = stageHashes(DEFAULTS);
    // A stage is dirty when it hashes a top-level group of the overlay, or reads a dirty stage.
    const expected = (id: (typeof PROFILE_IDS)[number]): string[] => {
      const keys = Object.keys(PROFILES[id].overlay);
      const dirty = new Set<string>();
      for (const s of STAGES) {
        if (s.params.some((p) => keys.some((k) => p === k || p.startsWith(`${k}.`))) || s.reads.some((r) => dirty.has(r))) dirty.add(s.id);
      }
      return STAGES.map((s) => s.id).filter((st) => dirty.has(st));
    };
    const all = STAGES.map((s) => s.id);
    const butClimate = all.filter((st) => st !== 'climate');
    const table: Record<(typeof PROFILE_IDS)[number], readonly string[]> = {
      default: [], large_biomes: all, archipelago: all, amplified: ['terrain', 'decorate', 'light', 'mesh'], floating_islands: butClimate, cave_heavy: [],
    };
    for (const id of PROFILE_IDS) {
      const h = stageHashes(resolveProfile(id));
      expect(dirtyStages(base, h), id).toEqual(expected(id));
      expect(dirtyStages(base, h), id).toEqual(table[id]);
      if (table[id].length === 0) expect(hex64(genKey([42, 0], h))).toBe(hex64(genKey([42, 0], base)));
    }
  });
});

describe('migrations', () => {
  test('invariant and identity at the current version', () => {
    expect(MIGRATIONS.length).toBe(SCHEMA_VERSION - 1);
    const doc = { climate: { scaleMul: 2 } } as JsonObject;
    const r = migrate(doc, SCHEMA_VERSION);
    expect(r.ok && r.value).toBe(doc);
  });
  test('SCHEMA_VERSION 4 (the user\'s check, R31): three migrations, 1 → 2 the identity, 2 → 3 the built-in trees, 3 → 4 SP6a\'s trees and noodles', () => {
    expect([SCHEMA_VERSION, MIGRATIONS.length]).toEqual([4, 3]);
  });
  test('1 → 2 (SP3d spec §1.11) is the identity (the trees a v1 document lacks are the profile\'s), and 2 → 3 keeps a document without density.defs', () => {
    const doc = { climate: { scaleMul: 2 }, density: { detailAmpLo: 0.8 } } as JsonObject;
    const r = migrate(doc, 1);
    expect(r.ok && r.value).toBe(doc);
    const imported = importPreset({ format: 'wi10-preset', schemaVersion: 1, name: 'Old', profile: 'default', params: doc });
    expect(imported.ok && imported.value.params.density.defs).toBe(DEFAULTS.density.defs);
    expect(imported.ok && imported.value.params.surface.rules).toBe(DEFAULTS.surface.rules);
  });
  describe('2 → 3 (SP6a D36, spec §12.4): SP5c\'s built-in trees become today\'s', () => {
    const TODAY: Record<Sp5cKind, JsonValue> = { default: DEFAULT_DENSITY_TREE, amplified: AMPLIFIED_DENSITY_TREE, floating_islands: FLOATING_DENSITY_TREE };
    const KINDS = Object.keys(TODAY) as Sp5cKind[];
    const v2 = (defs: unknown): JsonObject => ({ climate: { scaleMul: 2 }, density: { detailAmpLo: 0.8, defs } }) as unknown as JsonObject;

    test.each(KINDS)('the SP5c %s tree migrates to today\'s tree of its kind (the registered tree itself); every other leaf is kept', (kind) => {
      const doc = v2(sp5cTrees()[kind]);
      const r = MIGRATIONS[1]!(doc);
      expect((r['density'] as JsonObject)['defs']).toBe(TODAY[kind]);
      expect({ ...r, density: { ...(r['density'] as JsonObject), defs: null } }).toEqual({ climate: { scaleMul: 2 }, density: { detailAmpLo: 0.8, defs: null } });
      const m = migrate(doc, 2);
      expect(m.ok && (m.value['density'] as JsonObject)['defs']).toBe(TODAY[kind]);
    });

    test.each(KINDS)('the SP5c %s tree with one literal changed is kept', (kind) => {
      // The islands const −1e6 → −10 (default, amplified), or the islands term's islandMask gate 0.25 → 0.3 (floating_islands).
      const tree = sp5cTrees()[kind] as { root: { b: { x: Record<string, any> } } };
      if (kind === 'floating_islands') tree.root.b.x['x'].lo = 0.3;
      else tree.root.b.x['v'] = -10;
      const doc = v2(tree);
      expect(MIGRATIONS[1]!(doc)).toBe(doc);
    });

    test('a document without density.defs is the same object; today\'s tree is kept; the input is never mutated', () => {
      const plain = { climate: { scaleMul: 2 }, density: { detailAmpLo: 0.8 } } as JsonObject;
      expect(MIGRATIONS[1]!(plain)).toBe(plain);
      const empty = {} as JsonObject;
      expect(MIGRATIONS[1]!(empty)).toBe(empty);
      const current = v2(DEFAULT_DENSITY_TREE);
      expect(MIGRATIONS[1]!(current)).toBe(current);
      const doc = v2(sp5cTrees().default);
      const before = canonicalJSON(doc);
      const out = MIGRATIONS[1]!(doc);
      expect(out).not.toBe(doc);
      expect(canonicalJSON(doc)).toBe(before);
      // Non-object values at density or density.defs are left for checkParams to refuse.
      for (const odd of [{ density: 3 }, { density: { defs: 'x' } }, { density: { defs: null } }] as JsonObject[]) expect(MIGRATIONS[1]!(odd)).toBe(odd);
    });
  });

  describe('3 → 4 (the user\'s check, R31, R32; SP6a spec §12.4): SP6a\'s built-in trees become today\'s, and their noodle defaults with them', () => {
    const TODAY: Record<Sp6aKind, JsonValue> = { default: DEFAULT_DENSITY_TREE, amplified: AMPLIFIED_DENSITY_TREE, floating_islands: FLOATING_DENSITY_TREE };
    const KINDS = Object.keys(TODAY) as Sp6aKind[];
    const v3 = (defs: unknown, noodles: Record<string, number> = { thickness: 0.11, ridgeMul: 1.5, regional: 0.1, minY: -60, maxY: 64 }): JsonObject =>
      ({ climate: { scaleMul: 2 }, density: { detailAmpLo: 0.8, defs }, caves: { cheese: { offset: 0.4 }, noodles } }) as unknown as JsonObject;
    const noodlesOf = (d: JsonObject): JsonObject => (d['caves'] as JsonObject)['noodles'] as JsonObject;

    test('the new defaults are the migration\'s targets: thickness 0.22, maxY 48, threshold 1 (from SP6a\'s 0.11 and 64)', () => {
      expect([DEFAULTS.caves.noodles.thickness, DEFAULTS.caves.noodles.maxY, DEFAULTS.caves.noodles.threshold]).toEqual([0.22, 48, 1]);
    });

    test.each(KINDS)('the SP6a %s tree migrates to today\'s tree of its kind; thickness 0.11 → 0.22 and maxY 64 → 48; every other leaf kept; threshold left missing', (kind) => {
      const doc = v3(sp6aTrees()[kind]);
      const r = MIGRATIONS[2]!(doc);
      expect((r['density'] as JsonObject)['defs']).toBe(TODAY[kind]);
      expect(noodlesOf(r)).toEqual({ thickness: 0.22, ridgeMul: 1.5, regional: 0.1, minY: -60, maxY: 48 });
      expect({ ...r, density: { ...(r['density'] as JsonObject), defs: null }, caves: { ...(r['caves'] as JsonObject), noodles: null } })
        .toEqual({ climate: { scaleMul: 2 }, density: { detailAmpLo: 0.8, defs: null }, caves: { cheese: { offset: 0.4 }, noodles: null } });
      const m = migrate(doc, 3);
      expect(m.ok && (m.value['density'] as JsonObject)['defs']).toBe(TODAY[kind]);
    });

    test('on an SP6a tree an edited thickness or maxY is kept (each value tested apart), and a missing one stays missing', () => {
      const tree = sp6aTrees().default;
      expect(noodlesOf(MIGRATIONS[2]!(v3(tree, { thickness: 0.15, maxY: 64 })))).toEqual({ thickness: 0.15, maxY: 48 });
      expect(noodlesOf(MIGRATIONS[2]!(v3(tree, { thickness: 0.11, maxY: 120 })))).toEqual({ thickness: 0.22, maxY: 120 });
      expect(noodlesOf(MIGRATIONS[2]!(v3(tree, { ridgeMul: 2 })))).toEqual({ ridgeMul: 2 });
      const noCaves = { density: { defs: tree } } as unknown as JsonObject;
      expect(MIGRATIONS[2]!(noCaves)).toEqual({ density: { defs: DEFAULT_DENSITY_TREE } });
    });

    test.each(KINDS)('the SP6a %s tree with one literal changed is kept, with its thickness 0.11 and maxY 64', (kind) => {
      const tree = sp6aTrees()[kind] as { root: { b: { x: Record<string, any> } } };
      if (kind === 'floating_islands') tree.root.b.x['x'].lo = 0.3;
      else tree.root.b.x['v'] = -10;
      const doc = v3(tree);
      expect(MIGRATIONS[2]!(doc)).toBe(doc);
    });

    test('a document without density.defs, with today\'s tree or with an SP5c tree is the same object; the input is never mutated', () => {
      const plain = { climate: { scaleMul: 2 }, caves: { noodles: { thickness: 0.11, maxY: 64 } } } as unknown as JsonObject;
      expect(MIGRATIONS[2]!(plain)).toBe(plain);
      const empty = {} as JsonObject;
      expect(MIGRATIONS[2]!(empty)).toBe(empty);
      const current = v3(DEFAULT_DENSITY_TREE);
      expect(MIGRATIONS[2]!(current)).toBe(current);
      const sp5c = v3(sp5cTrees().default);
      expect(MIGRATIONS[2]!(sp5c)).toBe(sp5c);
      const doc = v3(sp6aTrees().default);
      const before = canonicalJSON(doc);
      const out = MIGRATIONS[2]!(doc);
      expect(out).not.toBe(doc);
      expect(canonicalJSON(doc)).toBe(before);
      for (const odd of [{ density: 3 }, { density: { defs: 'x' } }, { density: { defs: null } }] as JsonObject[]) expect(MIGRATIONS[2]!(odd)).toBe(odd);
      // Non-number or odd caves values on an SP6a tree: the tree migrates, the values are left for checkParams.
      const odd = { density: { defs: sp6aTrees().default }, caves: { noodles: { thickness: '0.11', maxY: null } } } as unknown as JsonObject;
      expect(noodlesOf(MIGRATIONS[2]!(odd))).toEqual({ thickness: '0.11', maxY: null });
      const oddCaves = { density: { defs: sp6aTrees().default }, caves: 7 } as unknown as JsonObject;
      expect(MIGRATIONS[2]!(oddCaves)['caves']).toBe(7);
    });

    test('a schema-3 preset on SP6a\'s default tree imports with today\'s tree, thickness 0.22, maxY 48 and the profile\'s threshold 1; a v2 SP5c one chains to today\'s', () => {
      const params = JSON.parse(JSON.stringify(DEFAULTS)) as Record<string, any>;
      params.density.defs = sp6aTrees().default;
      params.caves.noodles = { thickness: 0.11, ridgeMul: 1.5, regional: 0.1, minY: -60, maxY: 64 };
      const r = importPreset({ format: 'wi10-preset', schemaVersion: 3, name: 'SP6a', profile: 'default', params });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.params.density.defs).toBe(DEFAULTS.density.defs);
      expect(r.value.params.caves.noodles).toEqual(DEFAULTS.caves.noodles);
      expect(canonicalJSON(r.value.params)).toBe(canonicalJSON(DEFAULTS));
      const v2 = JSON.parse(JSON.stringify(DEFAULTS)) as Record<string, any>;
      v2.density.defs = sp5cTrees().default;
      delete v2.caves;
      const r2 = importPreset({ format: 'wi10-preset', schemaVersion: 2, name: 'SP5c', profile: 'default', params: v2 });
      expect(r2.ok && canonicalJSON(r2.value.params)).toBe(canonicalJSON(DEFAULTS));
    });
  });

  test('an injected v1 → v2 rename', () => {
    const toV2 = (d: JsonObject) => renamePath(d, 'climate.zoom', 'climate.scaleMul');
    const r = migrate({ climate: { zoom: 3, C: { octaves: 5 } } }, 1, [toV2]);
    expect(r.ok && r.value).toEqual({ climate: { scaleMul: 3, C: { octaves: 5 } } });
    expect(migrate({ climate: {} }, 1, [toV2])).toEqual({ ok: true, value: { climate: {} } });
    expect(migrate({}, 3, [toV2]).ok).toBe(false);
    expect(migrate({}, 5).ok).toBe(false);
    expect(migrate({}, 0).ok).toBe(false);
    const boom = migrate({}, 1, [() => { throw new Error('boom'); }]);
    expect(!boom.ok && boom.issues[0]!.code).toBe('MIGRATION_FAILED');
  });
  test('helpers are pure and touch only present keys', () => {
    const doc: JsonObject = { a: { b: 1, c: 2 } };
    expect(deletePath(doc, 'a.b')).toEqual({ a: { c: 2 } });
    expect(deletePath(doc, 'a.zz')).toEqual(doc);
    expect(mapPath(doc, 'a.c', (v) => (v as number) * 10)).toEqual({ a: { b: 1, c: 20 } });
    expect(mapPath(doc, 'x.y', () => 5)).toEqual(doc);
    expect(renamePath(doc, 'a.b', 'd.e')).toEqual({ a: { c: 2 }, d: { e: 1 } });
    expect(doc).toEqual({ a: { b: 1, c: 2 } });
  });
});

describe('presets', () => {
  const good = () => ({ format: 'wi10-preset', schemaVersion: 1, name: 'My world', profile: 'default', params: { climate: { scaleMul: 2 } } }) as Record<string, unknown>;
  const codes = (doc: unknown) => {
    const r = importPreset(doc);
    return r.ok ? [] : r.issues.map((i) => `${i.code} @ ${i.path}`);
  };
  test('export writes a patch over the profile; import restores the draft', () => {
    const next = testRng(171);
    for (const profile of PROFILE_IDS) {
      for (let i = 0; i < 17; i++) {
        const draft = i === 0 ? resolveProfile(profile) : randomParams(SCHEMA, next);
        const doc = JSON.parse(JSON.stringify(exportPreset(' Name ', profile, draft))) as unknown;
        const r = importPreset(doc);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(canonicalJSON(r.value.params)).toBe(canonicalJSON(draft));
          expect(r.value.name).toBe('Name');
          expect(r.value.profile).toBe(profile);
        }
      }
    }
    expect(exportPreset('x', 'large_biomes', resolveProfile('large_biomes')).params).toEqual({});
  });
  test.each<[string, (d: Record<string, unknown>) => void, string[]]>([
    ['valid', () => {}, []],
    ['unknown envelope key (all reported first)', (d) => { d.extra = 1; d.more = 2; }, ['UNKNOWN_KEY @ extra', 'UNKNOWN_KEY @ more']],
    ['bad format stops the envelope checks', (d) => { d.format = 'other'; d.name = ''; }, ['BAD_FORMAT @ format']],
    ['empty name', (d) => { d.name = '   '; }, ['BAD_NAME @ name']],
    ['long name', (d) => { d.name = 'x'.repeat(65); }, ['BAD_NAME @ name']],
    ['reserved name', (d) => { d.name = 'large_biomes'; }, ['RESERVED_NAME @ name']],
    ['unknown profile', (d) => { d.profile = 'nope'; }, ['UNKNOWN_PROFILE @ profile']],
    ['bad schema version', (d) => { d.schemaVersion = 1.5; }, ['BAD_SCHEMA_VERSION @ schemaVersion']],
    ['newer schema version', (d) => { d.schemaVersion = 5; }, ['NEWER_SCHEMA_VERSION @ schemaVersion']],
    ['params not an object', (d) => { d.params = []; }, ['NOT_OBJECT @ params']],
    ['typo in params', (d) => { d.params = { climate: { scaleMull: 4 } }; }, ['UNKNOWN_KEY @ params.climate.scaleMull']],
    ['invalid value', (d) => { d.params = { climate: { scaleMul: 99 } }; }, ['OUT_OF_RANGE @ params.climate.scaleMul']],
    ['unknown key and an invalid value together', (d) => { d.extra = 1; d.params = { climate: { scaleMul: 99 } }; }, ['UNKNOWN_KEY @ extra', 'OUT_OF_RANGE @ params.climate.scaleMul']],
  ])('%s', (_name, mutate, expected) => {
    const d = good();
    mutate(d);
    expect(codes(d)).toEqual(expected);
  });
  test('not an object', () => {
    expect(codes(5)).toEqual(['NOT_OBJECT @ ']);
  });
  test('an old document imports through injected migrations', () => {
    const toV2 = (d: JsonObject) => renamePath(d, 'climate.zoom', 'climate.scaleMul');
    const r = importPreset({ ...good(), params: { climate: { zoom: 3 } } }, [toV2]);
    expect(r.ok && r.value.params.climate.scaleMul).toBe(3);
  });
});

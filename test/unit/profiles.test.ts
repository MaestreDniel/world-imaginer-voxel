import { describe, expect, test } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { deletePath, mapPath, migrate, MIGRATIONS, renamePath, SCHEMA_VERSION, type JsonObject } from '../../src/core/params/migrate';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { CURRENT_SP } from '../../src/core/ids';
import { isProfileReady, PROFILE_IDS, PROFILES, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, genKey, stageHashes } from '../../src/core/stage/hash';
import { STAGES } from '../../src/core/stage/registry';
import { randomParams } from '../harness/params';
import { testRng } from '../harness/stats';

describe('profiles', () => {
  test('ids, readiness and overlays', () => {
    expect(Object.keys(PROFILES)).toEqual([...PROFILE_IDS]);
    expect(PROFILE_IDS.map((id) => [id, PROFILES[id].readyFrom])).toEqual([
      ['default', 'SP1'], ['large_biomes', 'SP2a'], ['archipelago', 'SP3c'], ['amplified', 'SP3c'], ['floating_islands', 'SP3c'], ['cave_heavy', 'SP6'],
    ]);
    expect(resolveProfile('large_biomes').climate.scaleMul).toBe(4);
    expect(resolveProfile('archipelago').climate.C.wavelength).toBe(840);
    expect(resolveProfile('default')).toBe(DEFAULTS);
  });
  test('readiness follows CURRENT_SP', () => {
    expect(CURRENT_SP).toBe('SP3a');
    expect(PROFILE_IDS.filter((id) => isProfileReady(id))).toEqual(['default', 'large_biomes']);
    expect(isProfileReady('archipelago', 'SP3c')).toBe(true);
    expect(isProfileReady('archipelago', 'SP3b')).toBe(false);
    expect(isProfileReady('large_biomes', 'SP1')).toBe(false);
  });
  test('switching profile dirties exactly what its overlay touches', () => {
    const base = stageHashes(DEFAULTS);
    const all = STAGES.map((s) => s.id);
    for (const id of PROFILE_IDS) {
      const h = stageHashes(resolveProfile(id));
      const empty = Object.keys(PROFILES[id].overlay).length === 0;
      expect(dirtyStages(base, h)).toEqual(empty ? [] : all);
      if (empty) expect(hex64(genKey([42, 0], h))).toBe(hex64(genKey([42, 0], base)));
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
  test('an injected v1 → v2 rename', () => {
    const toV2 = (d: JsonObject) => renamePath(d, 'climate.zoom', 'climate.scaleMul');
    const r = migrate({ climate: { zoom: 3, C: { octaves: 5 } } }, 1, [toV2]);
    expect(r.ok && r.value).toEqual({ climate: { scaleMul: 3, C: { octaves: 5 } } });
    expect(migrate({ climate: {} }, 1, [toV2])).toEqual({ ok: true, value: { climate: {} } });
    expect(migrate({}, 3, [toV2]).ok).toBe(false);
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
    ['newer schema version', (d) => { d.schemaVersion = 2; }, ['NEWER_SCHEMA_VERSION @ schemaVersion']],
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

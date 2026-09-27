import { describe, expect, test } from 'vitest';
import { fnv1a64, hex64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, bool, buildSchema, group, num } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { dirtyStages, genKey, paramsHash, stageHashes } from '../../src/core/stage/hash';
import { checkRegistry, prefixCovers, STAGES, type StageDef } from '../../src/core/stage/registry';
import { FIXTURE_DEFAULTS, FIXTURE_STAGES, PARAMS_FIXTURE } from '../../src/metrics/sp1Fixtures';

const ALL = STAGES.map((s) => s.id);

describe('registry', () => {
  test('the SP1 schema and stage list satisfy every invariant', () => {
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
    expect(ALL).toEqual(['climate', 'shape', 'surfaceEst', 'biome2d', 'terrain', 'decorate', 'light', 'mesh', 'lod', 'map']);
    expect(STAGES.every((s) => s.version === 1)).toBe(true);
  });
  test('prefixes match on dot boundaries', () => {
    expect(prefixCovers('climate', 'climate.C')).toBe(true);
    expect(prefixCovers('climate.C', 'climate.C')).toBe(true);
    expect(prefixCovers('climate.C', 'climate.CX')).toBe(false);
  });
  const T = buildSchema(group('T', 't', {
    a: group('A', 'a', { x: num(0, { label: 'x', doc: 'd', min: 0, max: 1, scope: 'climate', stage: 'climate' }) }),
    b: group('B', 'b', { y: bool(true, { label: 'y', doc: 'd', scope: 'live' }) }),
    c: group('C', 'c', { z: num(0, { label: 'z', doc: 'd', min: 0, max: 1, scope: 'decorate', stage: 'decorate' }) }),
  }));
  const st = (id: StageDef['id'], reads: StageDef['reads'], params: string[], version = 1): StageDef => ({ id, version, reads, params, checkpoint: 'none' });
  test.each<[string, StageDef[], string]>([
    ['duplicate stage', [st('climate', [], ['a']), st('climate', [], []), st('decorate', ['climate'], ['c'])], 'climate: duplicate stage'],
    ['reads a later stage', [st('climate', ['decorate'], ['a']), st('decorate', [], ['c'])], 'climate: reads decorate, which is not declared earlier'],
    ['bad version', [st('climate', [], ['a'], 0), st('decorate', [], ['c'])], 'climate: version must be an integer ≥ 1'],
    ['prefix matches nothing', [st('climate', [], ['a', 'nope']), st('decorate', [], ['c'])], 'climate: prefix "nope" matches no schema node'],
    ['live leaf hashed', [st('climate', [], ['a', 'b']), st('decorate', [], ['c'])], 'b.y: live leaf is hashed by climate'],
    ['home stage does not hash it', [st('climate', [], ['a']), st('decorate', [], [])], 'c.z: home stage decorate does not hash it'],
    ['scope differs from the first covering stage', [st('climate', [], ['a', 'c']), st('decorate', [], ['c'])], 'c.z: scope decorate but first hashed by climate (scope climate)'],
    ['light hosts params', [st('climate', [], ['a']), st('decorate', [], ['c']), st('light', [], ['a'])], 'light: hosts params, but light, lod and map host none'],
  ])('%s', (_name, stages, message) => {
    expect(checkRegistry(T, stages)).toContain(message);
  });
});

describe('stage hashes', () => {
  const H = stageHashes(DEFAULTS);
  test('preimages', () => {
    expect(hex64(H.climate!)).toBe(hex64(fnv1a64(`climate|1|${canonicalJSON({ climate: DEFAULTS.climate })}|`)));
    expect(hex64(H.shape!)).toBe(hex64(fnv1a64(`shape|1|{}|${hex64(H.climate!)}`)));
    expect(hex64(H.biome2d!)).toBe(hex64(fnv1a64(`biome2d|1|{}|${hex64(H.climate!)},${hex64(H.shape!)},${hex64(H.surfaceEst!)}`)));
  });
  test('every stage is hashed and none depends on the seed', () => {
    expect(Object.keys(H).sort()).toEqual([...ALL].sort());
    expect(stageHashes(DEFAULTS)).toEqual(H);
  });
  test('genKey preimage and seed dependence', () => {
    const seed = [42, 0] as const;
    expect(hex64(genKey(seed, H))).toBe(hex64(fnv1a64(`0|42|0|${hex64(H.decorate!)}`)));
    expect(hex64(genKey([43, 0], H))).not.toBe(hex64(genKey(seed, H)));
    expect(hex64(genKey([42, 1], H))).not.toBe(hex64(genKey(seed, H)));
  });
  test('dirtyStages: a climate edit dirties every stage; no edit dirties none', () => {
    const r = applyPatch(SCHEMA, DEFAULTS, { climate: { C: { octaves: 5 } } });
    if (!r.ok) throw new Error('setup');
    expect(dirtyStages(H, stageHashes(r.value))).toEqual(ALL);
    expect(dirtyStages(H, stageHashes(DEFAULTS))).toEqual([]);
  });
  test('paramsHash is fnv1a64 of the canonical JSON', () => {
    expect(hex64(paramsHash(DEFAULTS))).toBe(hex64(fnv1a64(canonicalJSON(DEFAULTS))));
  });
  test('the frozen params fixture hashes with its own two-stage list', () => {
    const FH = stageHashes(FIXTURE_DEFAULTS, FIXTURE_STAGES);
    expect(Object.keys(FH).sort()).toEqual(['climate', 'decorate']);
    expect(checkRegistry(PARAMS_FIXTURE, FIXTURE_STAGES)).toEqual([]);
    expect(() => genKey([1, 0], {})).toThrow(/decorate/);
  });
});

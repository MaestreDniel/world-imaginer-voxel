import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch } from '../../src/core/params/kit';
import { resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { allGoldenKeys } from '../../src/metrics/sp2aGoldens';
import { BIOME_SIZE_SCALE } from '../../src/ui/map/biomeSize';
import { DEFAULT_MAP_STATE, encodeMapState, type MapState } from '../../src/ui/map/mapState';
import { presetText } from '../../src/ui/presets/presetFile';
import {
  canonicalJson, goldenCount, ignoredLog, mapHash, parseArgs, presetProblems, readMapHash, sameJson, selftestAllMatch, SIZE_8, VIEWPORT, type MapUrlState,
} from '../tools/uiSmoke';

const EDITED: MapState = {
  v: 1, seed: '42', profile: 'default',
  patch: { rivers: { gorgeDepth: 40, widthMin: 12 }, climate: { scaleMul: BIOME_SIZE_SCALE[7]! } },
  view: { x: 5888, z: -3072, bpp: 4, layer: 'relief' },
};

describe('UI smoke test: pure parts (SP2b spec §8 Tools, §12)', () => {
  test('screenshots and the page run at 1400 × 900 CSS px, as SP2a\'s', () => {
    expect(VIEWPORT).toEqual({ width: 1400, height: 900 });
  });

  test('the slider target is the biome-size table\'s position 8', () => {
    expect(SIZE_8).toBe(BIOME_SIZE_SCALE[7]);
  });

  test('the canonical JSON sorts keys at every level, as the page\'s canonicalJSON does', () => {
    for (const v of [EDITED, { b: [{ d: 1, c: null }, 'x'], a: true }, {}, [], 0.1]) expect(canonicalJson(v)).toBe(canonicalJSON(v));
    expect(sameJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });

  test('the URL fragment is the page\'s own encoding of a map state, and reads back', () => {
    for (const s of [DEFAULT_MAP_STATE, EDITED]) {
      expect(mapHash(s as MapUrlState)).toBe(encodeMapState(s));
      expect(readMapHash(`#${encodeMapState(s)}`)).toEqual(s);
      expect(readMapHash(encodeMapState(s))).toEqual(s);
    }
    expect(readMapHash('')).toBeNull();
    expect(readMapHash('#not-base64-json')).toBeNull();
    expect(readMapHash(`#${Buffer.from(JSON.stringify({ ...DEFAULT_MAP_STATE, v: 2 })).toString('base64url')}`)).toBeNull();
  });

  test('only the favicon.ico 404 is ignored among page log errors', () => {
    const notFound = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(ignoredLog(notFound, 'http://127.0.0.1:40000/favicon.ico')).toBe(true);
    expect(ignoredLog(notFound, 'http://127.0.0.1:40000/assets/task.worker-x.js')).toBe(false);
    expect(ignoredLog(notFound, undefined)).toBe(false);
    expect(ignoredLog('Failed to load resource: net::ERR_CONNECTION_REFUSED', 'http://127.0.0.1:40000/favicon.ico')).toBe(false);
  });

  test('a downloaded preset is checked against the draft it was exported from', () => {
    const patch = { rivers: { gorgeDepth: 40 }, biomes: { zoomJitter: 0.5 } };
    const r = applyPatch(SCHEMA, resolveProfile('default'), patch);
    if (!r.ok) throw new Error('bad test patch');
    const text = presetText('smoke test', 'default', r.value);
    expect(presetProblems(text, { name: 'smoke test', profile: 'default', patch })).toEqual([]);
    expect(presetProblems(text, { name: 'other', profile: 'large_biomes', patch: {} })).toEqual(['name "smoke test"', 'profile "default"', 'params differ from the draft\'s patch']);
    expect(presetProblems('{"format":"x"}', { name: 'a', profile: 'default', patch: {} })).toEqual(['format "x"', 'name undefined', 'profile undefined', 'schemaVersion undefined', 'params differ from the draft\'s patch']);
    expect(presetProblems('{', { name: 'a', profile: 'default', patch: {} })[0]).toMatch(/^not JSON: /);
  });

  // Skipped while `npm run test:goldens` records: test/goldens.json gains the new keys only after the run.
  test.skipIf(process.env.UPDATE_GOLDENS === '1')('test/goldens.json holds every golden key of the build, the count the selftest step expects', () => {
    const text = readFileSync(new URL('../goldens.json', import.meta.url), 'utf8');
    expect(goldenCount(text)).toBe(allGoldenKeys().length);
  });

  test('the selftest step counts the goldens of test/goldens.json and matches the page summary against it', () => {
    expect(goldenCount('{"generatorVersion":3,"entries":{"a":"1","b":"2"}}')).toBe(2);
    expect(() => goldenCount('{"generatorVersion":3}')).toThrow(/entries/);
    expect(selftestAllMatch('✓ all 50 goldens match (3.2 s)', 50)).toBe(true);
    expect(selftestAllMatch('✓ all 47 goldens match (3.2 s)', 50)).toBe(false);
    expect(selftestAllMatch('✗ 1 of 50 goldens differ (3.2 s)', 50)).toBe(false);
    expect(selftestAllMatch('computing 50/50…', 50)).toBe(false);
  });

  test('arguments: build, the OS temp directory and no screenshots by default', () => {
    expect(parseArgs([])).toEqual({ build: true, profileDir: null, shots: null });
    expect(parseArgs(['--skip-build', '--profile-dir', '/tmp/p', '--shots', 'docs/x'])).toEqual({ build: false, profileDir: '/tmp/p', shots: 'docs/x' });
    expect(() => parseArgs(['--shots'])).toThrow(/--shots needs a value/);
    expect(() => parseArgs(['--what'])).toThrow(/unknown argument --what/);
  });
});

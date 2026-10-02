import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, diffParams } from '../../src/core/params/kit';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { isProfileReady, PROFILE_IDS, PROFILES, resolveProfile } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { presetFileName, presetNameProblem, presetText, readPresetText } from '../../src/ui/presets/presetFile';
import { randomParams } from '../harness/params';
import { testRng } from '../harness/stats';

const READY = PROFILE_IDS.filter((id) => isProfileReady(id));
const UNREADY = PROFILE_IDS.filter((id) => !isProfileReady(id));
const withScaleMul = (v: number) => {
  const r = applyPatch(SCHEMA, DEFAULTS, { climate: { scaleMul: v } });
  if (!r.ok) throw new Error('bad test params');
  return r.value;
};
const doc = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'wi10-preset', schemaVersion: 1, name: 'My world', profile: 'default', params: {}, ...extra });

describe('presetNameProblem', () => {
  test.each<[string, string | null]>([
    ['My world', null],
    ['  padded  ', null],
    ['x'.repeat(64), null],
    [` ${'x'.repeat(64)}\t`, null],
    ['😀'.repeat(32), null],
    ['Default', null],
    ['', 'enter a name'],
    [' \t\n ', 'enter a name'],
    ['x'.repeat(65), 'the name has 65 characters; the limit is 64'],
    ['😀'.repeat(33), 'the name has 66 characters; the limit is 64'],
    ['default', '"default" is a built-in profile name'],
    [' large_biomes ', '"large_biomes" is a built-in profile name'],
    ['archipelago', '"archipelago" is a built-in profile name'],
  ])('%j', (name, problem) => {
    expect(presetNameProblem(name)).toBe(problem);
  });
  test('accepts exactly the names importPreset accepts', () => {
    const next = testRng(4113);
    const names = [...PROFILE_IDS, ...PROFILE_IDS.map((id) => ` ${id}\n`), 'Default', '', ' ', 'a', 'x'.repeat(64), 'x'.repeat(65), '😀'.repeat(32), `${'😀'.repeat(32)}x`];
    for (let i = 0; i < 200; i++) {
      const len = next() % 80;
      names.push(String.fromCharCode(...Array.from({ length: len }, () => (next() & 3) === 0 ? 0x20 : 0x21 + (next() % 0xffde))));
    }
    for (const name of names) {
      const r = importPreset({ format: 'wi10-preset', schemaVersion: 1, name, profile: 'default', params: {} });
      expect(presetNameProblem(name) === null, JSON.stringify(name)).toBe(r.ok);
    }
  });
});

describe('presetFileName', () => {
  test.each<[string, string]>([
    ['My world', 'My world.wi10-preset.json'],
    ['a.b-c_d 9', 'a.b-c_d 9.wi10-preset.json'],
    ['  Río/2: café!  ', 'R_o_2_ caf__.wi10-preset.json'],
    ['😀 x', '_ x.wi10-preset.json'],
    ['\ud800x', '_x.wi10-preset.json'],
    ['x'.repeat(70), `${'x'.repeat(64)}.wi10-preset.json`],
    ['   ', 'preset.wi10-preset.json'],
  ])('%j → %j', (name, file) => {
    expect(presetFileName(name)).toBe(file);
  });
  test('any name gives a safe file name of at most 64 + 17 characters', () => {
    const next = testRng(907);
    for (let i = 0; i < 500; i++) {
      const name = String.fromCharCode(...Array.from({ length: next() % 90 }, () => next() % 0x10000));
      expect(presetFileName(name)).toMatch(/^[A-Za-z0-9 _.-]{1,64}\.wi10-preset\.json$/);
    }
  });
});

describe('presetText', () => {
  test('pretty JSON of exportPreset in envelope order, with a final newline', () => {
    expect(presetText(' My world ', 'default', withScaleMul(2))).toBe(
      '{\n  "format": "wi10-preset",\n  "schemaVersion": 1,\n  "name": "My world",\n  "profile": "default",\n' +
      '  "params": {\n    "climate": {\n      "scaleMul": 2\n    }\n  }\n}\n',
    );
    expect(presetText('Big', 'large_biomes', resolveProfile('large_biomes'))).toBe(
      '{\n  "format": "wi10-preset",\n  "schemaVersion": 1,\n  "name": "Big",\n  "profile": "large_biomes",\n  "params": {}\n}\n',
    );
  });
  test('equals exportPreset for random drafts', () => {
    const next = testRng(55);
    for (let i = 0; i < 20; i++) {
      const draft = randomParams(SCHEMA, next);
      expect(JSON.parse(presetText('R', 'default', draft))).toEqual(JSON.parse(JSON.stringify(exportPreset('R', 'default', draft))));
    }
  });
  test('refuses a name the file could not be imported with', () => {
    expect(() => presetText('  ', 'default', DEFAULTS)).toThrow('invalid preset name: enter a name');
    expect(() => presetText('default', 'default', DEFAULTS)).toThrow('invalid preset name: "default" is a built-in profile name');
  });
});

describe('readPresetText', () => {
  test('round trip: name, profile and the minimal patch over the profile', () => {
    const next = testRng(2024);
    for (const profile of READY) {
      for (let i = 0; i < 12; i++) {
        const draft = i === 0 ? resolveProfile(profile) : randomParams(SCHEMA, next);
        const r = readPresetText(presetText(' Name ', profile, draft));
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        expect([r.name, r.profile]).toEqual(['Name', profile]);
        expect(canonicalJSON(r.patch)).toBe(canonicalJSON(diffParams(SCHEMA, resolveProfile(profile), draft)));
        const back = applyPatch(SCHEMA, resolveProfile(profile), r.patch);
        expect(back.ok && canonicalJSON(back.value)).toBe(canonicalJSON(draft));
      }
    }
  });
  test('the patch is minimal and canonical even when the file is not', () => {
    const same = readPresetText(doc({ profile: 'large_biomes', params: { climate: { scaleMul: 4 } } }));
    expect(same.ok && same.patch).toEqual({});
    const r = readPresetText('{"format":"wi10-preset","schemaVersion":1,"name":"Z","profile":"default","params":{"lakes":{"rimSigma":-0},"climate":{"scaleMul":1}}}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(canonicalJSON(r.patch)).toBe('{"lakes":{"rimSigma":0}}');
  });
  test('JSON parse errors', () => {
    for (const text of ['', '{"format":', 'wi10']) {
      const r = readPresetText(text);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.issues.length).toBe(1);
      expect(r.issues[0]).toMatch(/^file is not JSON: ./);
    }
  });
  test.each<[string, string, string[]]>([
    ['not an object', '5', ['file: NOT_OBJECT — a preset must be a JSON object']],
    ['unknown key and an invalid value', doc({ extra: 1, params: { climate: { scaleMul: 99 } } }), [
      'extra: UNKNOWN_KEY — unknown key "extra"',
      'params.climate.scaleMul: OUT_OF_RANGE — 99 outside [0.25, 16]',
    ]],
    ['reserved name', doc({ name: 'default' }), ['name: RESERVED_NAME — "default" is a built-in profile name']],
    ['unknown profile', doc({ profile: 'nope' }), ['profile: UNKNOWN_PROFILE — unknown profile "nope"']],
    ['newer schema version', doc({ schemaVersion: 2 }), ['schemaVersion: NEWER_SCHEMA_VERSION — schemaVersion 2 is newer than this build (1)']],
    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3']],
    ['a profile that is not ready, with invalid params: import issues first', doc({ profile: 'archipelago', params: { climate: { scaleMull: 4 } } }), [
      'params.climate.scaleMull: UNKNOWN_KEY — unknown key "scaleMull"',
    ]],
  ])('%s', (_name, text, issues) => {
    expect(readPresetText(text)).toEqual({ ok: false, issues });
  });
  test('every unready profile names the sub-project it arrives in', () => {
    expect(UNREADY.length).toBeGreaterThan(0);
    for (const profile of UNREADY) {
      expect(readPresetText(presetText('Later', profile, resolveProfile(profile)))).toEqual({ ok: false, issues: [`profile ${profile} arrives in ${PROFILES[profile].readyFrom}`] });
    }
  });
});

import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, diffParams } from '../../src/core/params/kit';
import { exportPreset, importPreset } from '../../src/core/params/presets';
import { isProfileReady, PROFILE_IDS, PROFILES, resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { SCHEMA } from '../../src/core/params/schema';
import { knotAt, setKnot } from '../../src/core/spline/edit';
import { WorldSession } from '../../src/engine/session';
import { setPriority } from '../../src/ui/biomeTable/model';
import {
  applyPatchText, exportDraft, loadedNotice, loadPresetText, patchBoxText, presetFileName, presetNameHint, presetNameProblem, presetText, readPresetText,
} from '../../src/ui/presets/presetFile';
import { leafOpts } from '../../src/ui/splineEditor/model';
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

describe('presets tab logic', () => {
  const random = (): Seed64 => [1, 2];
  const open = (seedText = '42', profile: ProfileId = 'default') => new WorldSession(random, { seedText, profile });
  /** The changes a session notifies, as 'kind' plus ' urgent' when urgent. */
  const watch = (s: WorldSession): string[] => {
    const seen: string[] = [];
    s.subscribe((_state, c) => seen.push(`${c.kind}${c.urgent ? ' urgent' : ''}`));
    return seen;
  };
  /** large_biomes with a number, a noise field, a spline tangent and a table row modified: four undo steps. */
  const edited = (): WorldSession => {
    const s = open('42', 'large_biomes');
    const p = s.state.params;
    const sigma = setKnot(p.shape.sigma, [0], { d: knotAt(p.shape.sigma, [0]).d + 0.5 }, leafOpts('shape.sigma'));
    const table = setPriority(p.biomes.table, 'plains', 100);
    if (!sigma.ok || !table.ok) throw new Error('bad test edit');
    for (const [path, value] of [['rivers.widthMin', 6], ['climate.C', { octaves: 5 }], ['shape.sigma', sigma.value], ['biomes.table', table.table]] as const) {
      expect(s.set(path, value).ok, path).toBe(true);
    }
    return s;
  };
  const textOf = (r: ReturnType<typeof exportDraft>): string => {
    if (!r.ok) throw new Error(r.problem);
    return r.text;
  };

  test('the name hint shows the file name, asks for a name, or gives the reason', () => {
    expect(presetNameHint(' My world ')).toEqual({ kind: 'ok', text: 'saves My world.wi10-preset.json' });
    expect(presetNameHint('Río/2')).toEqual({ kind: 'ok', text: 'saves R_o_2.wi10-preset.json' });
    expect(presetNameHint('')).toEqual({ kind: 'empty', text: 'enter a name' });
    expect(presetNameHint(' \t')).toEqual({ kind: 'empty', text: 'enter a name' });
    expect(presetNameHint('default')).toEqual({ kind: 'problem', text: '"default" is a built-in profile name' });
    expect(presetNameHint('x'.repeat(65))).toEqual({ kind: 'problem', text: 'the name has 65 characters; the limit is 64' });
  });

  test('export = exportPreset(name, session profile, session params) as the file text, under the file name', () => {
    const s = edited();
    const r = exportDraft(' My world ', s);
    expect(r).toEqual({ ok: true, fileName: 'My world.wi10-preset.json', text: presetText(' My world ', 'large_biomes', s.state.params) });
    const doc = JSON.parse(textOf(r));
    expect(doc).toEqual(JSON.parse(JSON.stringify(exportPreset('My world', 'large_biomes', s.state.params))));
    expect(doc.params).toEqual(JSON.parse(JSON.stringify(s.state.patch)));
    expect(Object.keys(doc.params).sort()).toEqual(['biomes', 'climate', 'rivers', 'shape']);
  });

  test('export refuses an invalid name with its reason and leaves the session alone', () => {
    const s = edited();
    const seen = watch(s);
    expect(exportDraft('default', s)).toEqual({ ok: false, problem: '"default" is a built-in profile name' });
    expect(exportDraft('   ', s)).toEqual({ ok: false, problem: 'enter a name' });
    expect(seen).toEqual([]);
  });

  test('import is one load and one undo step over the file\'s profile; the seed is kept', () => {
    const from = edited();
    const text = textOf(exportDraft('Saved', from));
    const s = open('7');
    expect(s.set('rivers.widthMin', 6).ok).toBe(true);
    const before = s.snapshot;
    const seen = watch(s);
    expect(loadPresetText(s, text)).toEqual({ ok: true, name: 'Saved', changed: true });
    expect(seen).toEqual(['load urgent']);
    expect(s.state.seedText).toBe('7');
    expect(s.state.profile).toBe('large_biomes');
    expect(canonicalJSON(s.state.patch)).toBe(canonicalJSON(from.state.patch));
    expect(canonicalJSON(s.state.params)).toBe(canonicalJSON(from.state.params));
    expect(s.undo()).toBe(true);
    expect(s.snapshot).toEqual(before);
    expect(s.redo()).toBe(true);
    expect(canonicalJSON(s.state.patch)).toBe(canonicalJSON(from.state.patch));
    expect(seen).toEqual(['load urgent', 'undo urgent', 'redo urgent']);
    expect(loadedNotice('Saved')).toBe('loaded preset Saved');
  });

  test('importing the draft\'s own export changes nothing and records nothing', () => {
    const s = edited();
    const text = textOf(exportDraft('Same', s));
    const state = s.state;
    const seen = watch(s);
    expect(loadPresetText(s, text)).toEqual({ ok: true, name: 'Same', changed: false });
    expect(s.state).toBe(state);
    expect(seen).toEqual([]);
    expect(s.canRedo).toBe(false);
    expect(s.undo()).toBe(true);
    expect(s.state.params.biomes.table.plains.priority).toBe(8);
  });

  test.each<[string, string, (string | RegExp)[]]>([
    ['not JSON', '{"format":', [/^file is not JSON: ./]],
    ['an invalid parameter', doc({ params: { rivers: { widthMin: 999 } } }), ['params.rivers.widthMin: OUT_OF_RANGE — 999 outside [1, 64]']],
    ['an unknown key', doc({ extra: true }), ['extra: UNKNOWN_KEY — unknown key "extra"']],
    ['a profile that is not ready', doc({ profile: 'archipelago' }), ['profile archipelago arrives in SP3']],
  ])('a refused file (%s) lists its issues and leaves the session alone', (_name, text, issues) => {
    const s = edited();
    const state = s.state;
    const seen = watch(s);
    const r = loadPresetText(s, text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBe(issues.length);
    r.issues.forEach((line, i) => expect(line).toMatch(issues[i]!));
    expect(s.state).toBe(state);
    expect(seen).toEqual([]);
  });

  test('the patch box shows canonicalJSON of the minimal patch', () => {
    const s = open();
    expect(patchBoxText(s.state.patch)).toBe('{}');
    expect(s.set('rivers.widthMin', 6).ok).toBe(true);
    expect(s.set('climate.scaleMul', 2).ok).toBe(true);
    expect(patchBoxText(s.state.patch)).toBe('{"climate":{"scaleMul":2},"rivers":{"widthMin":6}}');
    expect(s.set('climate.scaleMul', 1).ok).toBe(true);
    expect(s.set('lakes.rimSigma', 1).ok).toBe(true);
    expect(patchBoxText(s.state.patch)).toBe('{"lakes":{"rimSigma":1},"rivers":{"widthMin":6}}');
  });

  test('applying the box replaces the whole patch over the session\'s profile in one step; the seed is kept', () => {
    const s = open('9', 'large_biomes');
    expect(s.set('rivers.widthMin', 6).ok).toBe(true);
    const before = s.snapshot;
    const seen = watch(s);
    expect(applyPatchText(s, '{ "lakes": { "rimSigma": -0 } }')).toEqual({ ok: true, changed: true });
    expect([s.state.seedText, s.state.profile]).toEqual(['9', 'large_biomes']);
    expect(patchBoxText(s.state.patch)).toBe('{"lakes":{"rimSigma":0}}');
    expect(seen).toEqual(['load urgent']);
    expect(s.undo()).toBe(true);
    expect(s.snapshot).toEqual(before);
  });

  test('an empty box clears the patch', () => {
    for (const text of ['', ' \n ']) {
      const s = open();
      expect(s.set('climate.scaleMul', 2).ok).toBe(true);
      expect(applyPatchText(s, text)).toEqual({ ok: true, changed: true });
      expect(s.state.patch).toEqual({});
      expect(s.canUndo).toBe(true);
    }
  });

  test('the same patch spelt differently changes nothing and records nothing', () => {
    const s = open();
    expect(s.set('climate.scaleMul', 2).ok).toBe(true);
    const state = s.state;
    const seen = watch(s);
    expect(applyPatchText(s, '{\n  "climate": { "scaleMul": 2.0 }\n}')).toEqual({ ok: true, changed: false });
    expect(s.state).toBe(state);
    expect(seen).toEqual([]);
  });

  test.each<[string, string, (string | RegExp)[]]>([
    ['not JSON', 'nope', [/^patch is not JSON: ./]],
    ['not an object', 'null', ['patch: NOT_OBJECT — expected an object, got null']],
    ['a value out of range', '{"rivers":{"widthMin":999}}', ['rivers.widthMin: OUT_OF_RANGE — 999 outside [1, 64]']],
    ['two problems', '{"climate":{"scaleMull":4},"rivers":{"widthMin":0}}', [
      'climate.scaleMull: UNKNOWN_KEY — unknown key "scaleMull"',
      'rivers.widthMin: OUT_OF_RANGE — 0 outside [1, 64]',
    ]],
  ])('a refused box (%s) lists its issues and leaves the session alone', (_name, text, issues) => {
    const s = edited();
    const state = s.state;
    const seen = watch(s);
    const r = applyPatchText(s, text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBe(issues.length);
    r.issues.forEach((line, i) => expect(line).toMatch(issues[i]!));
    expect(s.state).toBe(state);
    expect(seen).toEqual([]);
  });
});

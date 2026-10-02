import { describe, expect, test } from 'vitest';
import { utf8Bytes } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import { base64urlEncode } from '../../src/ui/common/base64url';
import {
  applyLabEdit, decodeLabState, DEFAULT_LAB_STATE, encodeLabState, labParams, mergePatch, type LabState,
} from '../../src/ui/lab/labState';

const enc = (text: string) => base64urlEncode(utf8Bytes(text));

describe('URL state', () => {
  test('round-trips, normalising −0 and trimming the seed', () => {
    const s: LabState = { v: 1, seed: ' abc ', noise: 'climate.T', patch: { climate: { T: { octaves: 3 } } }, view: { x: -0, z: 12.5, bpp: 0.0625, mode: 'z', plane: 'xy', slice: -0 }, b: { seed: '7', patch: { climate: { T: { wavelength: 900 } } } } };
    const hash = encodeLabState(s);
    expect(hash).not.toMatch(/[=+/]/);
    const back = decodeLabState(`#${hash}`);
    expect(back.error).toBeNull();
    expect(back.state).toEqual({ ...s, seed: 'abc', view: { ...s.view, x: 0, slice: 0 } });
    expect(Object.is(back.state.view.x, 0)).toBe(true);
  });
  test('the decoder accepts padding', () => {
    const hash = encodeLabState(DEFAULT_LAB_STATE);
    const padded = hash + '='.repeat((4 - (hash.length % 4)) % 4);
    expect(decodeLabState(padded).state).toEqual(DEFAULT_LAB_STATE);
  });
  test('an empty hash gives the defaults without a notice', () => {
    expect(decodeLabState('')).toEqual({ state: DEFAULT_LAB_STATE, error: null });
    expect(decodeLabState('#')).toEqual({ state: DEFAULT_LAB_STATE, error: null });
  });
  test.each<[string, string]>([
    ['bad base64', '#***'],
    ['not JSON', `#${enc('{not json')}`],
    ['not an object', `#${enc('[1]')}`],
    ['unknown key', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, extra: 1 }))}`],
    ['wrong version', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, v: 2 }))}`],
    ['empty seed', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, seed: '  ' }))}`],
    ['invalid patch', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, patch: { climate: { scaleMul: 99 } } }))}`],
    ['bpp out of range', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, view: { ...DEFAULT_LAB_STATE.view, bpp: 5000 } }))}`],
    ['view outside the window', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, view: { ...DEFAULT_LAB_STATE.view, x: 1e9 } }))}`],
    ['bad mode', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, view: { ...DEFAULT_LAB_STATE.view, mode: 'w' } }))}`],
    ['invalid B patch', `#${enc(JSON.stringify({ ...DEFAULT_LAB_STATE, b: { patch: { climate: { C: { octaves: 99 } } } } }))}`],
  ])('%s falls back to the defaults with a notice', (_name, hash) => {
    const r = decodeLabState(hash);
    expect(r.state).toEqual(DEFAULT_LAB_STATE);
    expect(r.error).toMatch(/^lab URL ignored: /);
  });
});

test('mergePatch deep-merges plain objects and replaces everything else', () => {
  expect(mergePatch({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({ a: { b: 1, c: [2], d: 3 } });
});

test('B layers over A', () => {
  const s: LabState = { ...DEFAULT_LAB_STATE, patch: { climate: { C: { octaves: 3 } } }, b: { patch: { climate: { C: { wavelength: 900 } } } } };
  const { a, b } = labParams(s);
  expect(a.climate.C.octaves).toBe(3);
  expect(b!.climate.C).toEqual({ ...DEFAULTS.climate.C, octaves: 3, wavelength: 900 });
  expect(labParams(DEFAULT_LAB_STATE).b).toBeNull();
});

describe('applyLabEdit', () => {
  const on = (b: LabState['b']): LabState => ({ ...DEFAULT_LAB_STATE, b });
  test('an A edit that would make the layered B invalid is rejected with B-prefixed issues', () => {
    const s = on({ patch: { climate: { C: { amplitudes: [1, 1, 1, 1, 1, 1] } } } });
    const r = applyLabEdit(s, 'A', 'climate.C', 'octaves', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.startsWith('B: climate.C.amplitudes: AMPLITUDES_LENGTH'))).toBe(true);
    expect(() => labParams(s)).not.toThrow();
  });
  test('an A remap edit that conflicts with a B double=false override is rejected', () => {
    const s = on({ patch: { climate: { warp: { shift: { noise: { double: false } } } } } });
    const r = applyLabEdit(s, 'A', 'climate.warp.shift.noise', 'remap', 'uniform');
    expect(!r.ok && r.issues.some((i) => i.startsWith('B: climate.warp.shift.noise.remap: REMAP_NEEDS_DOUBLE'))).toBe(true);
  });
  test('valid edits apply to the chosen side and keep labParams total', () => {
    const s = on({ seed: '7', patch: { climate: { C: { wavelength: 900 } } } });
    const a = applyLabEdit(s, 'A', 'climate.C', 'octaves', 5);
    expect(a.ok && a.state.patch).toEqual({ climate: { C: { octaves: 5 } } });
    const b = applyLabEdit(s, 'B', 'climate.C', 'octaves', 3);
    expect(b.ok && b.state.b).toEqual({ seed: '7', patch: { climate: { C: { wavelength: 900, octaves: 3 } } } });
    if (a.ok) expect(labParams(a.state).b!.climate.C.octaves).toBe(5);
    expect(applyLabEdit(DEFAULT_LAB_STATE, 'B', 'climate.C', 'octaves', 3)).toEqual({ ok: true, state: { ...DEFAULT_LAB_STATE, patch: { climate: { C: { octaves: 3 } } } } });
  });
  test('an invalid edit reports unprefixed A issues', () => {
    const r = applyLabEdit(DEFAULT_LAB_STATE, 'A', 'climate.C', 'double', false);
    expect(!r.ok && r.issues).toEqual(["climate.C.remap: REMAP_NEEDS_DOUBLE — remap 'uniform' needs double: true"]);
  });
});

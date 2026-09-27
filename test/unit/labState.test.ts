import { describe, expect, test } from 'vitest';
import { utf8Bytes } from '../../src/core/hash';
import { DEFAULTS } from '../../src/core/params/defaults';
import {
  base64urlDecode, base64urlEncode, decodeLabState, DEFAULT_LAB_STATE, encodeLabState, labParams, mergePatch, type LabState,
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

test('base64url helpers', () => {
  expect(base64urlEncode(Uint8Array.of(251, 255))).toBe('-_8');
  expect(Array.from(base64urlDecode('-_8')!)).toEqual([251, 255]);
  expect(base64urlDecode('a b')).toBeNull();
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

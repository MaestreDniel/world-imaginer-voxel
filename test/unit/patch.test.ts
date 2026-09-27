import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { applyPatch, bool, buildSchema, diffParams, enumOf, getPath, group, int, noise, num, patchAt, renderReference, spline } from '../../src/core/params/kit';
import { randomParams, randomPatch } from '../harness/params';
import { testRng } from '../harness/stats';

const P = (x: number, y: number, d = 0) => ({ x, y, d });
const S = buildSchema(group('Test', 'test schema', {
  a: group('A', 'group a', {
    n: num(0.5, { label: 'n', doc: 'a number', min: 0, max: 1, step: 0.05, scope: 'climate', stage: 'climate' }),
    k: int(3, { label: 'k', doc: 'an int', min: 1, max: 8, scope: 'climate', stage: 'climate' }),
    b: bool(true, { label: 'b', doc: 'a | flag', scope: 'live' }),
    e: enumOf(['p', 'q'], 'q', { label: 'e', doc: 'an enum', scope: 'decorate', stage: 'decorate' }),
    w: noise({ wavelength: 128, octaves: 3 }, { label: 'w', doc: '2D noise', scope: 'climate', stage: 'climate', wavelength: { min: 16, max: 1024 }, dims: 2 }),
    v: noise({ wavelength: 64, octaves: 2 }, { label: 'v', doc: '3D noise', scope: 'climate', stage: 'climate', wavelength: { min: 8, max: 512 }, dims: 3 }),
  }),
  s: spline({ coord: 'C', points: [P(-1, 1), P(1, 2)] }, { label: 's', doc: 'a spline', unit: 'blocks', coords: ['C', 'E'], min: -100, max: 100, scope: 'terrain', stage: 'shape' }),
}));
const D = S.defaults;

describe('applyPatch', () => {
  test('noise leaves merge per field; other leaves are replaced; untouched subtrees keep their reference', () => {
    const r = applyPatch(S, D, { a: { w: { octaves: 5 }, n: 0.25 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.a.w).toEqual({ ...D.a.w, octaves: 5 });
    expect(r.value.a.n).toBe(0.25);
    expect(r.value.s).toBe(D.s);
    expect(r.value.a.v).toBe(D.a.v);
    expect(Object.isFrozen(r.value.a)).toBe(true);
  });
  test('an empty or undefined-valued patch returns the base itself', () => {
    const r = applyPatch(S, D, { a: { n: undefined } });
    expect(r.ok && r.value).toBe(D);
    const e = applyPatch(S, D, {});
    expect(e.ok && e.value).toBe(D);
  });
  test('all issues are collected and nothing is applied', () => {
    const r = applyPatch(S, D, { a: { n: 7, k: 1.5, zz: 1, w: { remap: 'uniform', double: false } }, s: { coord: 'C', points: [] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.code} @ ${i.path}`)).toEqual([
      'UNKNOWN_KEY @ a.zz', 'OUT_OF_RANGE @ a.n', 'NOT_INTEGER @ a.k', 'REMAP_NEEDS_DOUBLE @ a.w.remap', 'EMPTY @ s.points',
    ]);
  });
  test('__proto__ is rejected and never touches a prototype', () => {
    const patch = JSON.parse('{"a":{"__proto__":{"polluted":1},"w":{"__proto__":{"x":1}}}}') as unknown;
    const r = applyPatch(S, D, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(['a.__proto__', 'a.w.__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  test('a non-object patch where a group or noise is expected', () => {
    const r = applyPatch(S, D, { a: 3, s: 4 });
    expect(!r.ok && r.issues.map((i) => `${i.code} @ ${i.path}`)).toEqual(['NOT_OBJECT @ a', 'NOT_OBJECT @ s']);
  });
});

describe('diffParams', () => {
  test('minimal patch: noise fields only where they differ; equal inputs give {}', () => {
    const r = applyPatch(S, D, { a: { w: { octaves: 5, amplitudes: [1, 0, 0.5, 0, 0] }, e: 'p' } });
    if (!r.ok) throw new Error('setup');
    expect(diffParams(S, D, r.value)).toEqual({ a: { w: { octaves: 5, amplitudes: [1, 0, 0.5, 0, 0] }, e: 'p' } });
    expect(diffParams(S, D, D)).toEqual({});
  });
  test('diff → JSON → apply is an identity on 2000 random pairs', () => {
    const next = testRng(141);
    for (let i = 0; i < 2000; i++) {
      const base = randomParams(S, next);
      const target = randomParams(S, next);
      const d = JSON.parse(JSON.stringify(diffParams(S, base, target))) as unknown;
      const r = applyPatch(S, base, d);
      expect(r.ok).toBe(true);
      if (r.ok) expect(canonicalJSON(r.value)).toBe(canonicalJSON(target));
    }
  });
  test('random patches always apply', () => {
    const next = testRng(142);
    for (let i = 0; i < 500; i++) expect(applyPatch(S, D, randomPatch(S, next)).ok).toBe(true);
  });
});

test('getPath and patchAt', () => {
  expect(getPath(D, 'a.w.octaves')).toBe(3);
  expect(getPath(D, '')).toBe(D);
  expect(getPath(D, 'a.nope')).toBeUndefined();
  expect(getPath(D, 'a.n.x')).toBeUndefined();
  expect(patchAt('a.w.octaves', 4)).toEqual({ a: { w: { octaves: 4 } } });
});

test('renderReference', () => {
  const lines = renderReference(S).split('\n');
  expect(lines[0]).toBe('| path | kind | default | range | unit | scope | doc |');
  expect(lines[1]).toBe('|---|---|---|---|---|---|---|');
  expect(lines[2]).toBe('| `a.n` | number | 0.5 | 0 … 1 |  | climate | n: a number |');
  expect(lines[4]).toBe('| `a.b` | bool | true |  |  | live | b: a \\| flag |');
  expect(lines[5]).toBe('| `a.e` | enum | "q" | p / q |  | decorate | e: an enum |');
  expect(lines[6]).toContain('| `a.w` | noise | {"amplitudes":null,"clampSigma":3,');
  expect(lines[6]).toContain('| wavelength 16 … 1024 |');
  expect(lines[8]).toContain('| blocks | terrain |');
  expect(lines.length).toBe(2 + S.leaves.length);
});

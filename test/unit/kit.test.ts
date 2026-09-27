import { describe, expect, test } from 'vitest';
import { bool, buildSchema, checkParams, enumOf, group, int, noise, num, spline, type Issue } from '../../src/core/params/kit';

const P = (x: number, y: number, d = 0) => ({ x, y, d });
const ROOT = group('Test', 'test schema', {
  a: group('A', 'group a', {
    n: num(0.5, { label: 'n', doc: 'a number', min: 0, max: 1, step: 0.05, scope: 'climate', stage: 'climate' }),
    k: int(3, { label: 'k', doc: 'an int', min: 1, max: 8, scope: 'climate', stage: 'climate' }),
    b: bool(true, { label: 'b', doc: 'a flag', scope: 'live' }),
    e: enumOf(['p', 'q'], 'q', { label: 'e', doc: 'an enum', scope: 'decorate', stage: 'decorate' }),
    w: noise({ wavelength: 128, octaves: 3 }, { label: 'w', doc: '2D noise', scope: 'climate', stage: 'climate', wavelength: { min: 16, max: 1024 }, dims: 2, components: ['x', 'z'] }),
    v: noise({ wavelength: 64, octaves: 2 }, { label: 'v', doc: '3D noise', scope: 'climate', stage: 'climate', wavelength: { min: 8, max: 512 }, dims: 3, seedName: 'old.v' }),
  }),
  s: spline({ coord: 'C', points: [P(-1, 1), P(1, 2)] }, { label: 's', doc: 'a spline', coords: ['C', 'E'], min: -100, max: 100, scope: 'terrain', stage: 'shape' }),
});
const S = buildSchema(ROOT);
const valid = () => JSON.parse(JSON.stringify(S.defaults)) as Record<string, any>;
const brief = (issues: readonly Issue[]) => issues.map((i) => `${i.code} @ ${i.path}`);
const check = (mutate: (d: Record<string, any>) => void) => {
  const d = valid();
  mutate(d);
  const r = checkParams(S, d);
  return r.ok ? [] : brief(r.issues);
};

describe('buildSchema', () => {
  test('nodes in pre-order with depth, leaves with ParamMeta', () => {
    expect(S.nodes.map((n) => `${n.depth}:${n.path}`)).toEqual(['0:', '1:a', '2:a.n', '2:a.k', '2:a.b', '2:a.e', '2:a.w', '2:a.v', '1:s']);
    expect(S.leaves.map((l) => l.path)).toEqual(['a.n', 'a.k', 'a.b', 'a.e', 'a.w', 'a.v', 's']);
    expect(S.leaves[0]!.meta).toEqual({ path: 'a.n', label: 'n', doc: 'a number', kind: 'number', min: 0, max: 1, step: 0.05, scope: 'climate', stage: 'climate' });
    expect(S.leaves[2]!.meta).toEqual({ path: 'a.b', label: 'b', doc: 'a flag', kind: 'bool', scope: 'live' });
    expect(S.leaves[3]!.meta.options).toEqual(['p', 'q']);
    expect(S.leaves[4]!.meta).toMatchObject({ kind: 'noise', dims: 2, min: 16, max: 1024 });
    expect(S.leaves[6]!.meta.coords).toEqual(['C', 'E']);
    expect(S.leaves[4]!.leaf.components).toEqual(['x', 'z']);
    expect(S.leaves[5]!.leaf.seedName).toBe('old.v');
    expect(S.byPath.get('a.w')).toBe(ROOT.children.a.children.w);
  });
  test('defaults are complete, normalised and deep-frozen', () => {
    expect(S.defaults.a.w).toEqual({ wavelength: 128, octaves: 3, persistence: 0.5, lacunarity: 2, amplitudes: null, yScale: 1, double: true, remap: 'none', clampSigma: 3 });
    expect(Object.isFrozen(S.defaults)).toBe(true);
    expect(Object.isFrozen(S.defaults.a.w)).toBe(true);
    expect(Object.isFrozen(S.defaults.s.points[0])).toBe(true);
  });
  test('invalid defaults and non-q15-stable bounds throw', () => {
    expect(() => buildSchema(group('x', 'x', { n: num(2, { label: 'n', doc: 'd', min: 0, max: 1, scope: 'live' }) }))).toThrow(/invalid schema defaults/);
    expect(() => buildSchema(group('x', 'x', { n: num(0.5, { label: 'n', doc: 'd', min: 0.1 + 0.2, max: 1, scope: 'live' }) }))).toThrow(/q15/);
    expect(() => buildSchema(group('x', 'x', { 'bad-key': num(0.5, { label: 'n', doc: 'd', min: 0, max: 1, scope: 'live' }) }))).toThrow(/key/);
  });
});

describe('checkParams codes and paths', () => {
  test('the defaults are valid', () => {
    expect(check(() => {})).toEqual([]);
  });
  test.each<[string, (d: Record<string, any>) => void, string[]]>([
    ['unknown key', (d) => { d.a.zz = 1; }, ['UNKNOWN_KEY @ a.zz']],
    ['__proto__ key', (d) => { Object.defineProperty(d.a, '__proto__', { value: 1, enumerable: true }); }, ['UNKNOWN_KEY @ a.__proto__']],
    ['missing key', (d) => { delete d.a.k; }, ['MISSING_KEY @ a.k']],
    ['group not an object', (d) => { d.a = 5; }, ['NOT_OBJECT @ a']],
    ['not a number', (d) => { d.a.n = '0.5'; }, ['NOT_NUMBER @ a.n']],
    ['not finite', (d) => { d.a.n = Infinity; }, ['NOT_FINITE @ a.n']],
    ['out of range', (d) => { d.a.n = 1.5; }, ['OUT_OF_RANGE @ a.n']],
    ['not an integer', (d) => { d.a.k = 2.5; }, ['NOT_INTEGER @ a.k']],
    ['integer too large', (d) => { d.a.k = 2e15; }, ['INT_TOO_LARGE @ a.k']],
    ['not a boolean', (d) => { d.a.b = 1; }, ['NOT_BOOL @ a.b']],
    ['bad enum', (d) => { d.a.e = 'r'; }, ['BAD_ENUM @ a.e']],
    ['noise missing field', (d) => { delete d.a.w.octaves; }, ['MISSING_KEY @ a.w.octaves']],
    ['noise unknown field', (d) => { d.a.w.gain = 1; }, ['UNKNOWN_KEY @ a.w.gain']],
    ['noise wavelength range', (d) => { d.a.w.wavelength = 8; }, ['OUT_OF_RANGE @ a.w.wavelength']],
    ['octaves range', (d) => { d.a.w.octaves = 17; }, ['OUT_OF_RANGE @ a.w.octaves']],
    ['amplitudes length', (d) => { d.a.w.amplitudes = [1, 0.5]; }, ['AMPLITUDES_LENGTH @ a.w.amplitudes']],
    ['amplitudes all zero', (d) => { d.a.w.amplitudes = [0, 0, 0]; }, ['AMPLITUDES_ZERO @ a.w.amplitudes']],
    ['amplitude range', (d) => { d.a.w.amplitudes = [1, 17, 0]; }, ['OUT_OF_RANGE @ a.w.amplitudes[1]']],
    ['amplitudes wrong type', (d) => { d.a.w.amplitudes = 3; }, ['NOT_OBJECT @ a.w.amplitudes']],
    ['yScale on a 2D noise', (d) => { d.a.w.yScale = 2; }, ['YSCALE_NOT_1 @ a.w.yScale']],
    ['uniform needs double', (d) => { d.a.w.remap = 'uniform'; d.a.w.double = false; }, ['REMAP_NEEDS_DOUBLE @ a.w.remap']],
    ['uniform needs 2D', (d) => { d.a.v.remap = 'uniform'; }, ['REMAP_NEEDS_2D @ a.v.remap']],
    ['bad remap', (d) => { d.a.w.remap = 'cdf'; }, ['BAD_ENUM @ a.w.remap']],
    ['double not boolean', (d) => { d.a.w.double = 'yes'; }, ['NOT_BOOL @ a.w.double']],
    ['spline issue keeps the spline path', (d) => { d.s.points[0].y = 999; }, ['Y_OUT_OF_RANGE @ s.points[0].y']],
    ['spline coord outside the leaf coords', (d) => { d.s.coord = 'T'; }, ['BAD_COORD @ s.coord']],
  ])('%s', (_name, mutate, expected) => {
    expect(check(mutate)).toEqual(expected);
  });
  test('every issue is collected in schema pre-order', () => {
    expect(check((d) => { d.a.n = -1; d.a.k = 0.5; d.s.points[1].y = 'x'; })).toEqual(['OUT_OF_RANGE @ a.n', 'NOT_INTEGER @ a.k', 'Y_BAD_TYPE @ s.points[1].y']);
  });
  test('numbers are normalised with q15 before the range check', () => {
    const d = valid();
    d.a.n = 1.0000000000000002;
    d.a.w.persistence = 0.1 + 0.2;
    const r = checkParams(S, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.a.n).toBe(1);
      expect(r.value.a.w.persistence).toBe(0.3);
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });
});

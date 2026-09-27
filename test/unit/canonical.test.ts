import { describe, expect, test } from 'vitest';
import { CanonicalError, canonicalJSON, q15 } from '../../src/core/params/canonical';
import { testFloat, testRng } from '../harness/stats';

describe('q15', () => {
  test('examples', () => {
    expect(Object.is(q15(-0), 0)).toBe(true);
    expect(q15(0.1 + 0.2)).toBe(0.3);
    expect(q15(123456789012345)).toBe(123456789012345);
    expect(q15(2 ** 53 - 1)).toBe(9007199254740990);
  });
  test('idempotent and monotone over 300k values spanning 80 decades', () => {
    const next = testRng(71);
    let prevX = -Infinity;
    let prevQ = -Infinity;
    const xs = Array.from({ length: 300000 }, () => (next() & 1 ? -1 : 1) * 10 ** (-40 + 80 * testFloat(next))).sort((a, b) => a - b);
    for (const x of xs) {
      const q = q15(x);
      expect(q15(q)).toBe(q);
      if (x >= prevX) expect(q >= prevQ).toBe(true);
      prevX = x;
      prevQ = q;
    }
  });
});

describe('canonicalJSON', () => {
  test('RFC 8785 ordering and number form', () => {
    expect(canonicalJSON({ b: 1, a: [1, 2, { d: 1e21, c: 1e-7 }], 'é': 'x', Z: null, u: undefined }))
      .toBe('{"Z":null,"a":[1,2,{"c":1e-7,"d":1e+21}],"b":1,"é":"x"}');
    expect(canonicalJSON([true, false, 'q"'])).toBe('[true,false,"q\\""]');
  });
  test.each([
    ['NaN', { a: NaN }, 'a'],
    ['Infinity', [1, Infinity], '[1]'],
    ['-0', { x: { y: -0 } }, 'x.y'],
    ['undefined array item', [undefined], '[0]'],
    ['Map', new Map(), ''],
    ['Date', { d: new Date(0) }, 'd'],
    ['function', { f: () => 1 }, 'f'],
  ])('rejects %s with its path', (_name, value, path) => {
    try {
      canonicalJSON(value);
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalError);
      expect((e as CanonicalError).path).toBe(path);
    }
  });
  test('depth over 64 throws', () => {
    let v: unknown = 1;
    for (let i = 0; i < 70; i++) v = [v];
    expect(() => canonicalJSON(v)).toThrow(CanonicalError);
  });
});

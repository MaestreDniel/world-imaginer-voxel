import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { detCos, detErf, detExp, detExp2, detSin, detSmoothstep } from '../../src/core/detMath';
import { f64Hex, nextDown, nextUp, refErf, testFloat, testRng } from '../harness/stats';

const grid = (lo: number, hi: number, n: number) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const uniform = (lo: number, hi: number, n: number, seed: number) => {
  const next = testRng(seed);
  return Array.from({ length: n }, () => lo + (hi - lo) * testFloat(next));
};
const maxAbsErr = (f: (x: number) => number, g: (x: number) => number, xs: readonly number[]) =>
  xs.reduce((m, x) => Math.max(m, Math.abs(f(x) - g(x))), 0);
const maxRelErr = (f: (x: number) => number, g: (x: number) => number, xs: readonly number[]) =>
  xs.reduce((m, x) => Math.max(m, Math.abs(f(x) - g(x)) / Math.abs(g(x))), 0);

describe('T-DM1 error bounds', () => {
  test('sin/cos ≤ 2e-9 absolute', () => {
    const next = testRng(51);
    const logU = Array.from({ length: 1 << 18 }, () => (next() & 1 ? -1 : 1) * 2 ** (21 * testFloat(next)));
    const nearK: number[] = [];
    for (let k = -63662; k <= 63662; k++) {
      let x = k * (Math.PI / 2);
      for (let s = 0; s < 4; s++) x = nextDown(x);
      for (let s = 0; s < 9; s++) { nearK.push(x); x = nextUp(x); }
    }
    for (const xs of [grid(-2 * Math.PI, 2 * Math.PI, 1 << 20), uniform(-1e5, 1e5, 1 << 20, 52), logU, nearK]) {
      expect(maxAbsErr(detSin, Math.sin, xs)).toBeLessThanOrEqual(2e-9);
      expect(maxAbsErr(detCos, Math.cos, xs)).toBeLessThanOrEqual(2e-9);
    }
  });
  test('exp and exp2 ≤ 2.5e-9 relative for normal results; rivers path ≤ 2e-9 absolute', () => {
    expect(maxRelErr(detExp, Math.exp, uniform(-708.39, 709.78, 1 << 20, 53))).toBeLessThanOrEqual(2.5e-9);
    expect(maxRelErr(detExp, Math.exp, grid(-1, 1, 1 << 16))).toBeLessThanOrEqual(2.5e-9);
    expect(maxRelErr(detExp2, (x) => 2 ** x, uniform(-1022, 1023.99, 1 << 20, 54))).toBeLessThanOrEqual(2.5e-9);
    expect(maxAbsErr((t) => detExp(-(t * t)), (t) => Math.exp(-(t * t)), grid(0, 50, 1 << 16))).toBeLessThanOrEqual(2e-9);
  });
  test('reference erf matches mpmath', () => {
    const mp: Array<[number, number]> = [
      [0.125, 0.1403162048013338], [0.5, 0.5204998778130465], [1, 0.8427007929497149], [1.5, 0.9661051464753108],
      [2, 0.9953222650189527], [2.1213203435596424, 0.9973002039367398], [2.5, 0.999593047982555],
      [3, 0.9999779095030014], [4, 0.9999999845827421], [6, 1.0],
    ];
    for (const [x, v] of mp) expect(Math.abs(refErf(x) - v)).toBeLessThanOrEqual(1e-13);
  });
  test('erf ≤ 1e-7 absolute', () => {
    const next = testRng(55);
    const logU = Array.from({ length: 1 << 16 }, () => (next() & 1 ? -1 : 1) * 10 ** (-12 + 15 * testFloat(next)));
    for (const xs of [grid(-2.1214, 2.1214, 1 << 20), grid(-6, 6, 1 << 20), logU]) {
      expect(maxAbsErr(detErf, refErf, xs)).toBeLessThanOrEqual(1e-7);
    }
  });
});

describe('T-DM2 special values', () => {
  const cases: Array<[string, () => number, number]> = [
    ['sin(-0)', () => detSin(-0), -0], ['sin(0)', () => detSin(0), 0], ['cos(-0)', () => detCos(-0), 1],
    ['sin(Inf)', () => detSin(Infinity), NaN], ['sin(-Inf)', () => detSin(-Infinity), NaN], ['sin(NaN)', () => detSin(NaN), NaN],
    ['cos(Inf)', () => detCos(Infinity), NaN], ['sin(2^21 + ulp)', () => detSin(2097152.0000000005), NaN],
    ['sin(MAX)', () => detSin(Number.MAX_VALUE), NaN], ['sin(5e-324)', () => detSin(5e-324), 5e-324],
    ['exp(0)', () => detExp(0), 1], ['exp(-Inf)', () => detExp(-Infinity), 0], ['exp(Inf)', () => detExp(Infinity), Infinity],
    ['exp(NaN)', () => detExp(NaN), NaN], ['exp(709.782712893384)', () => detExp(709.782712893384), 1.7976931348622732e308],
    ['exp(709.79)', () => detExp(709.79), Infinity], ['exp(-745.14)', () => detExp(-745.14), 0],
    ['exp2(-1075.5)', () => detExp2(-1075.5), 0], ['exp2(1024)', () => detExp2(1024), Infinity], ['exp2(NaN)', () => detExp2(NaN), NaN],
    ['erf(Inf)', () => detErf(Infinity), 1], ['erf(-Inf)', () => detErf(-Infinity), -1], ['erf(NaN)', () => detErf(NaN), NaN],
    ['erf(0)', () => detErf(0), 0], ['erf(-0)', () => detErf(-0), 0], ['erf(1e300)', () => detErf(1e300), 1],
    ['erf(6.1)', () => detErf(6.1), 1],
    ['smoothstep below', () => detSmoothstep(0, 1, -1), 0], ['smoothstep above', () => detSmoothstep(0, 1, 2), 1],
    ['smoothstep mid', () => detSmoothstep(0, 1, 0.5), 0.5], ['smoothstep NaN', () => detSmoothstep(0, 1, NaN), NaN],
  ];
  test.each(cases)('%s', (_name, f, expected) => {
    expect(Object.is(f(), expected)).toBe(true);
  });
  test('detSin(2^21) is finite (domain edge is inclusive)', () => {
    expect(Number.isFinite(detSin(2097152))).toBe(true);
  });
  test('exp2(k) === 2^k exactly for every integer k in [-1074, 1023]', () => {
    for (let k = -1074; k <= 1023; k++) expect(detExp2(k)).toBe(2 ** k);
  });
});

describe('T-DM3 symmetry', () => {
  test('sin odd, cos even, erf odd (x ≠ 0), bitwise', () => {
    let bad = 0;
    for (const xs of [uniform(-1e5, 1e5, 1 << 20, 56), uniform(-2097152, 2097152, 1 << 18, 57), uniform(-8, 8, 1 << 18, 62)]) {
      for (const x of xs) {
        if (!Object.is(detSin(-x), -detSin(x))) bad++;
        if (!Object.is(detCos(-x), detCos(x))) bad++;
        if (x !== 0 && !Object.is(detErf(-x), -detErf(x))) bad++;
      }
    }
    expect(bad).toBe(0);
  });
  test('sin stays odd at exact reduction ties', () => {
    const INV_PIO2 = 0.6366197723675814;
    let found = 0;
    for (let n = 0; n < 100000; n++) {
      const x = (n + 0.5) / INV_PIO2;
      if (x * INV_PIO2 !== n + 0.5) continue;
      found++;
      expect(Object.is(detSin(-x), -detSin(x))).toBe(true);
      expect(Object.is(detCos(-x), detCos(x))).toBe(true);
    }
    expect(found).toBeGreaterThanOrEqual(100);
  });
});

test('T-DM4 range', () => {
  let bad = 0;
  for (const x of uniform(-2097152, 2097152, 1 << 18, 58)) if (Math.abs(detSin(x)) > 1 || Math.abs(detCos(x)) > 1) bad++;
  for (const x of uniform(-50, 50, 1 << 18, 59)) if (Math.abs(detErf(x)) > 1) bad++;
  for (const x of uniform(-800, 800, 1 << 18, 60)) if (!(detExp(x) >= 0)) bad++;
  expect(bad).toBe(0);
});

describe('T-DM5 monotonicity', () => {
  test('erf on a 1e7-point grid over [-8, 8] and on consecutive-ulp windows', () => {
    let prev = -Infinity;
    for (let i = 0; i < 1e7; i++) {
      const v = detErf(-8 + (16 * i) / (1e7 - 1));
      if (v < prev) throw new Error(`erf decreases at grid index ${i}`);
      prev = v;
    }
    for (const start of uniform(-6, 6, 1000, 61)) {
      let x = start;
      let p = detErf(x);
      for (let s = 0; s < 1000; s++) {
        x = nextUp(x);
        const v = detErf(x);
        if (v < p) throw new Error(`erf decreases at ${x}`);
        p = v;
      }
    }
  });
  test('exp and exp2 across the k-switch points', () => {
    for (let k = -1000; k <= 1000; k++) {
      for (const [f, x0] of [[detExp, (k - 0.5) * Math.LN2], [detExp2, k - 0.5]] as const) {
        let x = x0;
        for (let s = 0; s < 500; s++) x = nextDown(x);
        let p = f(x);
        for (let s = 0; s < 1000; s++) {
          x = nextUp(x);
          const v = f(x);
          if (v < p) throw new Error(`${f.name} decreases at ${x}`);
          p = v;
        }
      }
    }
  });
});

test('T-DM7 coefficient literals: bits match their comment, shortest form, ≤ 17 significant digits', () => {
  const src = readFileSync(new URL('../../src/core/detMath.ts', import.meta.url), 'utf8');
  const found = [...src.matchAll(/^const ([A-Z0-9_]+) = ([-0-9.e+]+); \/\/ 0x([0-9A-F]{16})/gm)];
  expect(found.length).toBe(29);
  for (const [, name, lit, hex] of found) {
    expect(f64Hex(Number(lit)), name).toBe(hex);
    expect(String(Number(lit)), name).toBe(lit);
    const digits = lit!.replace(/^-/, '').replace(/e.*$/, '').replace('.', '').replace(/^0+/, '');
    expect(digits.length, name).toBeLessThanOrEqual(17);
  }
});

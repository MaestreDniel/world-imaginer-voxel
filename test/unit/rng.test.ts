import { describe, expect, test } from 'vitest';
import { splitmix32, Xoshiro128 } from '../../src/core/rng';

describe('vectors', () => {
  test('splitmix32(0)', () => {
    const sm = splitmix32(0);
    expect([sm(), sm(), sm(), sm()]).toEqual([1684164658, 3653269916, 2939563536, 2141751570]);
  });
  test('xoshiro128** from raw state [1, 2, 3, 4]', () => {
    const r = Xoshiro128.fromState(1, 2, 3, 4);
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492]);
  });
  test('xoshiro128** seeded with 12345', () => {
    const r = new Xoshiro128(12345);
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([1093274547, 203003357, 3741353573, 3803725158, 4178738660, 810247443]);
  });
});

test('nextFloat is one draw times 2^-32', () => {
  const a = new Xoshiro128(9);
  const b = new Xoshiro128(9);
  for (let i = 0; i < 1000; i++) {
    const f = a.nextFloat();
    expect(f).toBe(b.nextU32() * 2.3283064365386963e-10);
    expect(f >= 0 && f < 1).toBe(true);
  }
});

describe('nextInt', () => {
  const n = 3 * 2 ** 30;
  const chi2p = (bins: number[], total: number) => {
    const e = total / bins.length;
    const chi2 = bins.reduce((s, c) => s + (c - e) ** 2 / e, 0);
    return Math.exp(-chi2 / 2); // χ² survival function for 2 degrees of freedom
  };
  test('no modulo bias for n = 3·2^30 (χ² p > 0.01)', () => {
    const r = new Xoshiro128(7);
    const bins = [0, 0, 0];
    for (let i = 0; i < 100000; i++) bins[Math.floor(r.nextInt(n) / 2 ** 30)]!++;
    expect(chi2p(bins, 100000)).toBeGreaterThan(0.01);
  });
  test('negative control: plain modulo is biased', () => {
    const r = new Xoshiro128(7);
    const bins = [0, 0, 0];
    for (let i = 0; i < 100000; i++) bins[Math.floor((r.nextU32() % n) / 2 ** 30)]!++;
    expect(chi2p(bins, 100000)).toBeLessThan(1e-6);
  });
  test('edge sizes', () => {
    const r = new Xoshiro128(3);
    for (let i = 0; i < 100; i++) expect(r.nextInt(1)).toBe(0);
    const a = new Xoshiro128(4);
    const b = new Xoshiro128(4);
    for (let i = 0; i < 100; i++) expect(a.nextInt(4294967296)).toBe(b.nextU32());
  });
});

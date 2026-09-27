import { describe, expect, test } from 'vitest';
import { completeNoiseDef } from '../../src/core/noise/types';
import {
  histogram, ksUniform, lastOctaveWavelength, meanAbsPairDiff, meanAbsShiftDiff, Moments, pearson, Rose, roseBin, samplePoints, zeroRate,
} from '../../src/metrics/noiseStats';

test('samplePoints: deterministic, x and z in the colKey window, y in the world height', () => {
  const a = samplePoints('N1', 1000);
  const b = samplePoints('N1', 1000);
  expect(Array.from(a.x)).toEqual(Array.from(b.x));
  for (let i = 0; i < 1000; i++) {
    expect(a.x[i]! >= -524288 && a.x[i]! < 524288).toBe(true);
    expect(a.z[i]! >= -524288 && a.z[i]! < 524288).toBe(true);
    expect(a.y[i]! >= -64 && a.y[i]! < 320).toBe(true);
  }
  expect(samplePoints('N2', 10).x[0]).not.toBe(a.x[0]);
});

test('Moments', () => {
  const m = new Moments();
  for (const v of [1, 2, 3, 4]) m.add(v);
  expect([m.n, m.mean, m.min, m.max]).toEqual([4, 2.5, 1, 4]);
  expect(m.sd).toBeCloseTo(Math.sqrt(5 / 3), 12);
});

test('ksUniform', () => {
  const grid = Float64Array.from({ length: 1000 }, (_, i) => -1 + (2 * (i + 0.5)) / 1000);
  expect(ksUniform(grid)).toBeCloseTo(0.0005, 10);
  const skew = Float64Array.from({ length: 1000 }, (_, i) => -1 + (i + 0.5) / 1000);
  expect(ksUniform(skew)).toBeCloseTo(0.5, 3);
});

test('histogram clamps into the end bins', () => {
  expect(Array.from(histogram([-2, -1, -0.5, 0, 0.5, 1, 2], -1, 1, 4))).toEqual([2, 1, 1, 3]);
});

test('rose bins are centred on axes and diagonals', () => {
  expect(roseBin(1, 0)).toBe(8);
  expect(roseBin(-1, 0)).toBe(0);
  expect(roseBin(1, 1)).toBe(10);
  expect(roseBin(0, 1)).toBe(12);
  expect(roseBin(0, -1)).toBe(4);
  const r = new Rose();
  for (let k = 0; k < 16; k++) { const t = (k * Math.PI) / 8; r.add(Math.cos(t), Math.sin(t)); r.add(Math.cos(t), Math.sin(t)); }
  r.add(1, 0);
  expect(r.ratio()).toBe(1.5);
  expect(new Rose().ratio()).toBe(Infinity);
});

test('pearson', () => {
  expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
});

test('lastOctaveWavelength divides by the lacunarity per octave', () => {
  expect(lastOctaveWavelength(completeNoiseDef({ wavelength: 2400, octaves: 6 }))).toBe(75);
  expect(lastOctaveWavelength(completeNoiseDef({ wavelength: 64, octaves: 1 }))).toBe(64);
});

describe('aperiodicity and zero rate helpers', () => {
  const pts = samplePoints('test.helpers', 5000);
  const other = samplePoints('test.helpers.b', 5000);
  const periodic = (x: number) => Math.sin((2 * Math.PI * x) / 100);
  test('a periodic field has zero shift difference at its period', () => {
    const f = (x: number) => periodic(x);
    expect(meanAbsShiftDiff(f, pts, [100, 0, 0], false)).toBeLessThan(1e-9);
    expect(meanAbsPairDiff(f, pts, other, false)).toBeGreaterThan(0.5);
  });
  test('corner snapping and integer points', () => {
    expect(zeroRate((x) => x - Math.floor(x), pts, false)).toBe(1);
    expect(zeroRate((x, y, z) => (x % 4) + (y % 8) + (z % 4), pts, true)).toBe(1);
    expect(zeroRate(() => 0.5, pts, false)).toBe(0);
  });
});

import { describe, expect, test } from 'vitest';
import { deriveSeed } from '../../src/core/hash';
import { splitmix32 } from '../../src/core/rng';
import { toUniform, uMax } from '../../src/core/noise/cdf';
import { lattice3, PERLIN2_SD, PERLIN3_SD } from '../../src/core/noise/lattice3';
import { NormalNoise } from '../../src/core/noise/normal';
import { OctaveNoise } from '../../src/core/noise/octave';
import { completeNoiseDef, type NoiseDef } from '../../src/core/noise/types';
import { sampleSd, testFloat, testRng } from '../harness/stats';

const W: readonly [number, number] = [42, 0];

/** Spec §2.2 recomputed from scratch. */
function octaveRef(name: string, def: NoiseDef, dims: 2 | 3, x: number, y: number, z: number): number {
  let f = 1 / def.wavelength;
  let a = 1;
  let v = 0;
  for (let i = 0; i < def.octaves; i++) {
    const s = deriveSeed(W, `${name}#${i}`);
    const sm = splitmix32(s);
    const ox = sm() * 9.5367431640625e-7, oy = sm() * 9.5367431640625e-7, oz = sm() * 9.5367431640625e-7;
    const ai = def.amplitudes === null ? a : def.amplitudes[i]!;
    const l = dims === 2 ? lattice3(s | 0, x * f + ox, Math.floor(oy) + 0.5, z * f + oz) : lattice3(s | 0, x * f + ox, y * f * def.yScale + oy, z * f + oz);
    v += ai * l;
    f *= def.lacunarity;
    a *= def.persistence;
  }
  return v;
}

describe('OctaveNoise', () => {
  const defs = [
    completeNoiseDef({ wavelength: 2400, octaves: 6 }),
    completeNoiseDef({ wavelength: 64, octaves: 4, yScale: 0.5 }),
    completeNoiseDef({ wavelength: 300, octaves: 4, amplitudes: [1, 0, 0.5, 0] }),
  ];
  test.each(defs.map((d, i) => [i, d] as const))('def %i matches the reference bit for bit', (_i, def) => {
    const o = new OctaveNoise(W, 'test.octave', def);
    const next = testRng(95);
    for (let i = 0; i < 5000; i++) {
      const x = (testFloat(next) * 2 - 1) * 524288, y = -64 + 384 * testFloat(next), z = (testFloat(next) * 2 - 1) * 524288;
      expect(Object.is(o.sample2(x, z), octaveRef('test.octave', def, 2, x, y, z))).toBe(true);
      expect(Object.is(o.sample3(x, y, z), octaveRef('test.octave', def, 3, x, y, z))).toBe(true);
    }
  });
  test('sumA2', () => {
    expect(new OctaveNoise(W, 'a', completeNoiseDef({ wavelength: 100, octaves: 3 })).sumA2).toBe(1 + 0.25 + 0.0625);
    expect(new OctaveNoise(W, 'a', completeNoiseDef({ wavelength: 100, octaves: 2, amplitudes: [2, 0] })).sumA2).toBe(4);
  });
});

describe('NormalNoise', () => {
  test('z2 / z3 are the clamped, reciprocal-normalised double stack', () => {
    const def = completeNoiseDef({ wavelength: 900, octaves: 5 });
    const nn = new NormalNoise(W, 'climate.W', def);
    const A = new OctaveNoise(W, 'climate.W', def);
    const B = new OctaveNoise(W, "climate.W'", def);
    const S = Math.sqrt(A.sumA2 + B.sumA2);
    const inv2 = 1 / (PERLIN2_SD * S), inv3 = 1 / (PERLIN3_SD * S);
    const R = 337 / 331;
    const clamp = (v: number) => (v < -3 ? -3 : v > 3 ? 3 : v);
    const next = testRng(96);
    for (let i = 0; i < 5000; i++) {
      const x = (testFloat(next) * 2 - 1) * 524288, y = -64 + 384 * testFloat(next), z = (testFloat(next) * 2 - 1) * 524288;
      expect(Object.is(nn.z2(x, z), clamp((A.sample2(x, z) + B.sample2(x * R, z * R)) * inv2))).toBe(true);
      expect(Object.is(nn.z3(x, y, z), clamp((A.sample3(x, y, z) + B.sample3(x * R, y * R, z * R)) * inv3))).toBe(true);
    }
  });
  test('a single stack uses only A', () => {
    const def = completeNoiseDef({ wavelength: 16, octaves: 1, double: false });
    const nn = new NormalNoise(W, 'test.single', def);
    const A = new OctaveNoise(W, 'test.single', def);
    const inv2 = 1 / (PERLIN2_SD * Math.sqrt(A.sumA2));
    expect(nn.z2(10.25, -3.5)).toBe(Math.max(-3, Math.min(3, A.sample2(10.25, -3.5) * inv2)));
  });
  test('clampSigma bounds z exactly', () => {
    const nn = new NormalNoise(W, 'test.clamp', completeNoiseDef({ wavelength: 256, octaves: 3, clampSigma: 1 }));
    const next = testRng(97);
    let atClamp = 0;
    for (let i = 0; i < 20000; i++) {
      const v = nn.z2((testFloat(next) * 2 - 1) * 524288, (testFloat(next) * 2 - 1) * 524288);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      if (Math.abs(v) === 1) atClamp++;
    }
    expect(atClamp).toBeGreaterThan(0);
    expect(nn.clamp).toBe(1);
  });
  test('sd(z) ≈ 1 for the climate C definition', () => {
    const nn = new NormalNoise(W, 'climate.C', completeNoiseDef({ wavelength: 2400, octaves: 6, remap: 'uniform' }));
    const next = testRng(98);
    const v = new Float64Array(50000);
    for (let i = 0; i < v.length; i++) v[i] = nn.z2((testFloat(next) * 2 - 1) * 524288, (testFloat(next) * 2 - 1) * 524288);
    expect(Math.abs(sampleSd(v) - 1)).toBeLessThanOrEqual(0.03);
  });
  test('finite at the range extremes', () => {
    const defs = [
      completeNoiseDef({ wavelength: 16, octaves: 16, lacunarity: 4, persistence: 1 }),
      completeNoiseDef({ wavelength: 20000, octaves: 1, clampSigma: 8 }),
      completeNoiseDef({ wavelength: 16, octaves: 3, amplitudes: [0, 16, 0], yScale: 100 }),
      completeNoiseDef({ wavelength: 1024, octaves: 16, lacunarity: 1.1, persistence: 0.05, double: false }),
    ];
    const next = testRng(99);
    let bad = 0;
    for (const def of defs) {
      const nn = new NormalNoise(W, 'test.extreme', def);
      for (let i = 0; i < 5000; i++) {
        const x = (testFloat(next) * 2 - 1) * 524288, y = -64 + 384 * testFloat(next), z = (testFloat(next) * 2 - 1) * 524288;
        if (!Number.isFinite(nn.z2(x, z)) || !Number.isFinite(nn.z3(x, y, z))) bad++;
      }
    }
    expect(bad).toBe(0);
  });
});

test('CDF remap', () => {
  expect(toUniform(0)).toBe(0);
  expect(uMax(3)).toBe(0.9973002846585164);
  expect(toUniform(3)).toBe(uMax(3));
  expect(toUniform(-3)).toBe(-uMax(3));
  let prev = -Infinity;
  for (let z = -3; z <= 3; z += 0.001) {
    const u = toUniform(z);
    expect(u >= prev).toBe(true);
    prev = u;
  }
});

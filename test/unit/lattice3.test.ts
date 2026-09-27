import { describe, expect, test } from 'vitest';
import { deriveSeed, hash3 } from '../../src/core/hash';
import { completeNoiseDef, NOISE_DEF_DEFAULTS } from '../../src/core/noise/types';
import { lattice3, PERLIN2_SD, PERLIN3_SD } from '../../src/core/noise/lattice3';
import { pearson, sampleSd, testFloat, testRng } from '../harness/stats';

const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** The literal 8-call form of spec §2.1. */
function lattice3Ref(s: number, x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const corner = (dx: number, dy: number, dz: number) => {
    const g = ((hash3(s, X + dx, Y + dy, Z + dz) & 0xffff) * 12) >>> 16;
    return GX[g]! * (fx - dx) + GY[g]! * (fy - dy) + GZ[g]! * (fz - dz);
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const n000 = corner(0, 0, 0), n100 = corner(1, 0, 0), n010 = corner(0, 1, 0), n110 = corner(1, 1, 0);
  const n001 = corner(0, 0, 1), n101 = corner(1, 0, 1), n011 = corner(0, 1, 1), n111 = corner(1, 1, 1);
  const x00 = n000 + u * (n100 - n000), x10 = n010 + u * (n110 - n010), x01 = n001 + u * (n101 - n001), x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00), y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

test('NoiseDef defaults', () => {
  expect(NOISE_DEF_DEFAULTS).toEqual({ persistence: 0.5, lacunarity: 2, amplitudes: null, yScale: 1, double: true, remap: 'none', clampSigma: 3 });
  expect(completeNoiseDef({ wavelength: 900, octaves: 5, remap: 'uniform' })).toEqual({ ...NOISE_DEF_DEFAULTS, wavelength: 900, octaves: 5, remap: 'uniform' });
});

test('the fused kernel is bit-identical to the 8-call form on 300k points', () => {
  const next = testRng(81);
  let bad = 0;
  for (let i = 0; i < 300000; i++) {
    const s = next();
    const x = (testFloat(next) * 2 - 1) * 4096, y = (testFloat(next) * 2 - 1) * 4096, z = (testFloat(next) * 2 - 1) * 4096;
    if (!Object.is(lattice3(s, x, y, z), lattice3Ref(s, x, y, z))) bad++;
  }
  expect(bad).toBe(0);
});

test('the balanced 12-gradient index: 5462 counts for {0, 3, 6, 9}, 5461 for the others', () => {
  const counts = new Array<number>(12).fill(0);
  for (let h = 0; h < 65536; h++) counts[(h * 12) >>> 16]!++;
  expect(counts).toEqual([5462, 5461, 5461, 5462, 5461, 5461, 5462, 5461, 5461, 5462, 5461, 5461]);
});

describe('SD pin: closed forms within ±0.5 % per seed (4 seeds × 250k points)', () => {
  test.each([1, 2, 3, 4])('seed %i', (s) => {
    const seed = deriveSeed([s, 0], 'sp1.sdpin');
    const next = testRng(100 + s);
    const v3 = new Float64Array(250000);
    const v2 = new Float64Array(250000);
    for (let i = 0; i < 250000; i++) {
      v3[i] = lattice3(seed, testFloat(next) * 65536, testFloat(next) * 65536, testFloat(next) * 65536);
      v2[i] = lattice3(seed, testFloat(next) * 65536, Math.floor(testFloat(next) * 65536) + 0.5, testFloat(next) * 65536);
    }
    expect(Math.abs(sampleSd(v3) / PERLIN3_SD - 1)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(sampleSd(v2) / PERLIN2_SD - 1)).toBeLessThanOrEqual(0.005);
  });
  test('constants', () => {
    expect(PERLIN3_SD).toBe(Math.sqrt(35054270 / 480729249));
    expect(PERLIN2_SD).toBe(Math.sqrt(2052359 / 24972948));
    expect(PERLIN3_SD).toBeCloseTo(0.2700350823341202, 15);
    expect(PERLIN2_SD).toBeCloseTo(0.2866762789162117, 15);
  });
});

test.each([
  ['(-x, y, -z)', (x: number, y: number, z: number) => [-x, y, -z]],
  ['(-x, -y, z)', (x: number, y: number, z: number) => [-x, -y, z]],
  ['(x, -y, -z)', (x: number, y: number, z: number) => [x, -y, -z]],
] as const)('no correlation with the two-axis reflection %s', (_name, reflect) => {
  const next = testRng(91);
  const a = new Float64Array(200000);
  const b = new Float64Array(200000);
  for (let i = 0; i < 200000; i++) {
    const x = (testFloat(next) * 2 - 1) * 4096, y = (testFloat(next) * 2 - 1) * 4096, z = (testFloat(next) * 2 - 1) * 4096;
    const [rx, ry, rz] = reflect(x, y, z);
    a[i] = lattice3(1, x, y, z);
    b[i] = lattice3(1, rx!, ry!, rz!);
  }
  expect(Math.abs(pearson(a, b))).toBeLessThanOrEqual(0.02);
});

test('finite and bounded', () => {
  const next = testRng(92);
  let bad = 0;
  for (let i = 0; i < 100000; i++) {
    const v = lattice3(next(), (testFloat(next) * 2 - 1) * 1e9, (testFloat(next) * 2 - 1) * 1e9, (testFloat(next) * 2 - 1) * 1e9);
    if (!Number.isFinite(v) || Math.abs(v) > 2) bad++;
  }
  expect(bad).toBe(0);
});

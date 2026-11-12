import { describe, expect, test } from 'vitest';
import { createColumnCache } from '../../src/gen/column/columnCache';
import { columnPoint } from '../../src/gen/column/columnPoint';
import {
  buildColumnSample, gorgeAt, latticeIndex, LEVEL_FIELDS, newColumnSample, readBiome, readField, readFieldHalo, readLevel, riverWetAt,
  SAMPLE_FIELDS, type ColumnSample, type SampleField,
} from '../../src/gen/column/columnStage';
import { zoomQuart } from '../../src/gen/biomes/zoom';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef } from '../../src/core/noise/types';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const columns = (n: number, seed: number) => {
  const next = testRng(seed);
  return Array.from({ length: n }, () => [(next() % 65536) - 32768, (next() % 65536) - 32768] as const);
};

describe('DT2: batch == point, bit for bit at every lattice point', () => {
  test.each([['42', {}], ['7', { climate: { scaleMul: 4 } }]] as const)('seed %s', (seed, patch) => {
    const ctx = ctxFor(seed, patch);
    const s = newColumnSample();
    let mismatches = 0;
    for (const [cx, cz] of columns(seed === '42' ? 4096 : 512, seed === '42' ? 11 : 12)) {
      buildColumnSample(ctx, cx, cz, s);
      for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) {
        const k = latticeIndex(i, j);
        const p = columnPoint(ctx, 16 * cx + 4 * i, 16 * cz + 4 * j);
        for (const f of [...SAMPLE_FIELDS, ...LEVEL_FIELDS]) if (!Object.is(s.f[f][k], p[f])) mismatches++;
        if (s.biome[k] !== p.biome || riverWetAt(s, k) !== p.riverWet || gorgeAt(s, k) !== p.gorge) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  }, 120_000);

  test('floating_islands (SP3e spec §2.3): with the mask on, every field too, and the lattice holds 0 < m < 1 and m = 1', () => {
    const ctx = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    const s = newColumnSample();
    let mismatches = 0;
    let edge = 0;
    let full = 0;
    for (const [cx, cz] of columns(512, 13)) {
      buildColumnSample(ctx, cx, cz, s);
      for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) {
        const k = latticeIndex(i, j);
        const p = columnPoint(ctx, 16 * cx + 4 * i, 16 * cz + 4 * j);
        for (const f of [...SAMPLE_FIELDS, ...LEVEL_FIELDS]) if (!Object.is(s.f[f][k], p[f])) mismatches++;
        if (s.biome[k] !== p.biome || riverWetAt(s, k) !== p.riverWet || gorgeAt(s, k) !== p.gorge) mismatches++;
        const m = s.f.islandMask[k]!;
        if (m > 0 && m < 1) edge++;
        if (m === 1) full++;
      }
    }
    expect(mismatches).toBe(0);
    expect(edge).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
  }, 60_000);
});

describe('readout', () => {
  const ctx = ctxFor();
  const s = buildColumnSample(ctx, 3, -5, newColumnSample());
  test('exact at quart corners', () => {
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
      const x = 48 + 4 * i;
      const z = -80 + 4 * j;
      for (const f of SAMPLE_FIELDS) {
        const v = s.f[f][latticeIndex(i, j)]!;
        // The column's own block positions (lx, lz ≤ 15) see only corners i, j ≤ 3, read with weight 0: exact. The
        // far corners (x or z = 16·c + 16, the neighbour's first block) are read as v00 + (v10 − v00)·1, which can
        // round by an ulp (here steep at corner (4, 0), since the SP3b §8.4 retune).
        if (i < 4 && j < 4) expect(readField(s, f, x, z)).toBe(v);
        else expect(Math.abs(readField(s, f, x, z) - v)).toBeLessThanOrEqual(4 * Number.EPSILON * Math.max(1, Math.abs(v)));
      }
      for (const f of LEVEL_FIELDS) expect(readLevel(s, f, x, z)).toBe(s.f[f][latticeIndex(i, j)]);
    }
  });
  test('bilinear between corners', () => {
    const k = latticeIndex(1, 2);
    const a = s.f.offset;
    const expected = (a[k]! * 0.75 + a[k + 1]! * 0.25) * 0.5 + (a[k + 7]! * 0.75 + a[k + 8]! * 0.25) * 0.5;
    expect(readField(s, 'offset', 48 + 4 + 1, -80 + 8 + 2)).toBeCloseTo(expected, 10);
  });
  test('levels read the nearest corner', () => {
    expect(readLevel(s, 'surfaceWaterLevel', 48 + 5.9, -80 + 2.1)).toBe(s.f.surfaceWaterLevel[latticeIndex(1, 1)]);
  });
  test('per-block biome follows the zoom to a lattice biome', () => {
    for (let dz = 0; dz < 16; dz += 3) for (let dx = 0; dx < 16; dx += 3) {
      const [qx, qz] = zoomQuart(ctx, 48 + dx + 0.5, -80 + dz + 0.5, [0, 0]);
      expect(readBiome(s, ctx, 48 + dx + 0.5, -80 + dz + 0.5)).toBe(s.biome[latticeIndex(qx - 12, qz + 20)]);
    }
  });
});

describe('readFieldHalo (SP6b §1.2)', () => {
  const ctx = ctxFor();
  const HALO_FIELDS: readonly SampleField[] = ['C', 'E', 'H', 'surfaceEst'];
  test('readFieldHalo equals readField inside the column', () => {
    let mismatches = 0;
    for (const [cx, cz] of [[0, 0], [-1667, -2000], [40, 900]] as const) {
      const s = buildColumnSample(ctx, cx, cz, newColumnSample());
      for (let dz = 0; dz < 16; dz++) for (let dx = 0; dx < 16; dx++) {
        const x = 16 * cx + dx;
        const z = 16 * cz + dz;
        for (const f of HALO_FIELDS) if (!Object.is(readFieldHalo(s, f, x, z), readField(s, f, x, z))) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
  test('two neighbours agree bit for bit on every shared halo position', () => {
    // Nd: a fixed test noise standing in for caves.biomes.noises.depth; Y0 = surfaceEst + 10·Nd as §1.2 composes it.
    const nd = new NormalNoise([1, 2], 'test.halo.Nd', completeNoiseDef({ wavelength: 64, octaves: 3 }));
    const y0 = (s: ColumnSample, x: number, z: number) => readFieldHalo(s, 'surfaceEst', x, z) + 10 * nd.z2(x, z);
    let shared = 0;
    let mismatches = 0;
    for (const [cx, cz] of [[0, 0], [31, -1]] as const) {
      const a = buildColumnSample(ctx, cx, cz, newColumnSample());
      for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [-1, -1]] as const) {
        const b = buildColumnSample(ctx, cx + dx, cz + dz, newColumnSample());
        // Positions within 4 blocks of both columns: x ∈ [16·cx − 4, 16·cx + 20) ∩ the neighbour's, likewise z.
        const x0 = Math.max(16 * cx, 16 * (cx + dx)) - 4;
        const x1 = Math.min(16 * cx, 16 * (cx + dx)) + 20;
        const z0 = Math.max(16 * cz, 16 * (cz + dz)) - 4;
        const z1 = Math.min(16 * cz, 16 * (cz + dz)) + 20;
        for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
          shared++;
          for (const f of HALO_FIELDS) if (!Object.is(readFieldHalo(a, f, x, z), readFieldHalo(b, f, x, z))) mismatches++;
          if (!Object.is(y0(a, x, z), y0(b, x, z))) mismatches++;
        }
      }
    }
    // Per pair: 8 × 24 (x or z neighbour), 8 × 8 (diagonal); two pairs of each.
    expect(shared).toBe(2 * (8 * 24 + 8 * 24 + 8 * 8 + 8 * 8));
    expect(mismatches).toBe(0);
    const s = buildColumnSample(ctx, 3, -5, newColumnSample());
    expect(() => readFieldHalo(s, 'C', 16 * 3 + 20, -80)).toThrow(RangeError);
    expect(() => readFieldHalo(s, 'C', 16 * 3 - 5, -80)).toThrow(RangeError);
    expect(() => readFieldHalo(s, 'C', 48, -80 + 20)).toThrow(RangeError);
    expect(() => readFieldHalo(s, 'C', 48, -80 - 5)).toThrow(RangeError);
    expect(readFieldHalo(s, 'C', 16 * 3 - 4, -80 - 4)).toBe(s.f.C[latticeIndex(-1, -1)]);
    expect(Number.isFinite(readFieldHalo(s, 'C', 16 * 3 + 19.75, -80 + 19.75))).toBe(true);
  });
});

describe('column cache', () => {
  test('LRU of the given capacity; hits return the same sample; rebuilt values match', () => {
    const ctx = ctxFor();
    const cache = createColumnCache(ctx, 3);
    const a = cache.get(0, 0);
    expect(cache.get(0, 0)).toBe(a);
    cache.get(1, 0);
    cache.get(2, 0);
    cache.get(0, 0);
    cache.get(3, 0);
    expect(cache.size).toBe(3);
    const b = cache.get(1, 0);
    expect(Array.from(b.f.offset)).toEqual(Array.from(buildColumnSample(ctx, 1, 0, newColumnSample()).f.offset));
    expect(b.cx).toBe(1);
  });
});

import { describe, expect, test } from 'vitest';
import { createColumnCache } from '../../src/gen/column/columnCache';
import { columnPoint } from '../../src/gen/column/columnPoint';
import {
  buildColumnSample, gorgeAt, latticeIndex, LEVEL_FIELDS, newColumnSample, readBiome, readField, readLevel, riverWetAt, SAMPLE_FIELDS,
} from '../../src/gen/column/columnStage';
import { zoomQuart } from '../../src/gen/biomes/zoom';
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
});

describe('readout', () => {
  const ctx = ctxFor();
  const s = buildColumnSample(ctx, 3, -5, newColumnSample());
  test('exact at quart corners', () => {
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
      const x = 48 + 4 * i;
      const z = -80 + 4 * j;
      for (const f of SAMPLE_FIELDS) expect(readField(s, f, x, z)).toBe(s.f[f][latticeIndex(i, j)]);
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

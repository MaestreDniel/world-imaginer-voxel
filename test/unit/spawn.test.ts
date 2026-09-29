import { describe, expect, test } from 'vitest';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, ringOffsets } from '../../src/gen/column/spawn';
import { ctxFor } from '../harness/gen';

describe('spawn search', () => {
  test('rings are square, complete and ordered by distance', () => {
    expect(ringOffsets(0)).toEqual([[0, 0]]);
    expect(ringOffsets(1)).toEqual([[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]);
    expect(ringOffsets(3).length).toBe(24);
  });
  test('the spawn is dry, gentle, inland land and deterministic (seeds 1-16)', () => {
    for (let s = 1; s <= 16; s++) {
      const ctx = ctxFor(String(s));
      const sp = findSpawn(ctx);
      expect(sp.fallback).toBe(false);
      const p = columnPoint(ctx, sp.x, sp.z);
      expect(p.surfaceWaterLevel).toBe(-Infinity);
      expect(p.offset).toBeGreaterThanOrEqual(64);
      expect(p.steep).toBeLessThanOrEqual(1);
      expect(['lowland', 'highland']).toContain(biomeFamily(p.biome));
      expect(sp.y).toBe(Math.floor(p.surfaceEst) + 1);
      expect(findSpawn(ctxFor(String(s)))).toEqual(sp);
    }
  });
  test('an all-ocean world falls back to the least-bad point', () => {
    const ctx = ctxFor('42', { shape: { offset: { coord: 'C', points: [{ x: 0, y: 20, d: 0 }] } } });
    const sp = findSpawn(ctx);
    expect(sp.fallback).toBe(true);
    expect([sp.x, sp.z, sp.y]).toEqual([0, 0, 21]);
  }, 60_000);
});

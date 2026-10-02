import { describe, expect, test } from 'vitest';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, findSpawnAbortable, ringOffsets } from '../../src/gen/column/spawn';
import { ctxFor } from '../harness/gen';

const OCEAN = { shape: { offset: { coord: 'C' as const, points: [{ x: 0, y: 20, d: 0 }] } } };
/** A stop callback that counts its calls and fires on call `fireAt` (never when omitted). */
const counter = (fireAt = Infinity) => {
  const c = { calls: 0, stop: () => ++c.calls >= fireAt };
  return c;
};
/** Polls of a search that ends at candidate k of ring r: one per ring start and one every 32 candidates. */
const pollsUpTo = (r: number, k: number) => {
  let n = Math.floor(k / 32) + 1;
  for (let q = 0; q < r; q++) n += Math.ceil(ringOffsets(q).length / 32);
  return n;
};

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
    const ctx = ctxFor('42', OCEAN);
    const sp = findSpawn(ctx);
    expect(sp.fallback).toBe(true);
    expect([sp.x, sp.z, sp.y]).toEqual([0, 0, 21]);
  }, 60_000);
});

describe('findSpawnAbortable (SP2b spec §2.2)', () => {
  test('a stop that never fires gives findSpawn\'s spawn, polled at each ring start and every 32 candidates (seeds 1-16)', () => {
    for (let s = 1; s <= 16; s++) {
      const ctx = ctxFor(String(s));
      const c = counter();
      const sp = findSpawnAbortable(ctx, c.stop);
      expect(sp).toEqual(findSpawn(ctx));
      const r = Math.max(Math.abs(sp!.x), Math.abs(sp!.z)) / 64;
      const k = ringOffsets(r).findIndex(([dx, dz]) => dx * 64 === sp!.x && dz * 64 === sp!.z);
      expect([s, c.calls]).toEqual([s, pollsUpTo(r, k)]);
    }
  });
  test('the full search of an all-ocean world polls 545 times and still falls back', () => {
    const ctx = ctxFor('42', OCEAN);
    const c = counter();
    const sp = findSpawnAbortable(ctx, c.stop);
    expect([sp!.x, sp!.z, sp!.y, sp!.fallback]).toEqual([0, 0, 21, true]);
    // 1 (ring 0) + Σ_{r=1..64} ⌈8r / 32⌉ = 1 + 4 · (1 + … + 16).
    expect(c.calls).toBe(545);
  }, 60_000);
  test('returns null as soon as stop fires', () => {
    const ctx = ctxFor('42', OCEAN);
    expect(findSpawnAbortable(ctx, () => true)).toBeNull();
    const c = counter(3);
    expect(findSpawnAbortable(ctx, c.stop)).toBeNull();
    expect(c.calls).toBe(3);
  });
});

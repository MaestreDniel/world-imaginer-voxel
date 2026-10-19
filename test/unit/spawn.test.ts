import { describe, expect, test } from 'vitest';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, findSpawnAbortable, ringOffsets } from '../../src/gen/column/spawn';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonValue } from '../../src/core/params/json';
import { AMPLIFIED_DENSITY_TREE, deriveTree } from '../../src/core/params/presetTrees';
import { isProfileReady, PROFILE_IDS, resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
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

describe('the spawn y under another density tree (SP3e spec §1.2, Review Focus)', () => {
  const at = (seed: string, params: Params) => createGenContext(seedFromInput(seed), params);
  test('amplified: the default\'s spawn point, its y = surfaceEst3 + 1 there, never under the amplified ground (seeds 1-8)', () => {
    let buried = 0;
    for (let s = 1; s <= 8; s++) {
      const ctx = at(String(s), resolveProfile('amplified'));
      const sp = findSpawn(ctx);
      const flat = findSpawn(ctxFor(String(s)));
      // The search reads the 2D column, which amplified does not change.
      expect([s, sp.x, sp.z, sp.biome, sp.fallback]).toEqual([s, flat.x, flat.z, flat.biome, false]);
      expect(sp.y).toBe(surfaceEst3(createDensityContext(ctx), sp.x, sp.z) + 1);
      expect(sp.y).toBeGreaterThanOrEqual(flat.y);
      // The 2D estimate (⌊surfaceEst⌋ + 1, the unamplified offset) lay up to 57 blocks inside the ground (seed 7).
      if (sp.y - flat.y > 20) buried++;
    }
    expect(buried).toBeGreaterThan(0);
  });
  test('every ready profile: y = ⌊surfaceEst⌋ + 1 under the default tree, surfaceEst3 + 1 under another (seeds 1-4)', () => {
    for (const id of PROFILE_IDS.filter((p) => isProfileReady(p))) {
      const params = resolveProfile(id);
      for (let s = 1; s <= 4; s++) {
        const ctx = at(String(s), params);
        const sp = findSpawn(ctx);
        const want = params.density.defs === DEFAULT_DENSITY_TREE
          ? Math.floor(columnPoint(ctx, sp.x, sp.z).surfaceEst) + 1
          : surfaceEst3(createDensityContext(ctx), sp.x, sp.z) + 1;
        expect([id, s, sp.y]).toEqual([id, s, want]);
      }
    }
  });
  test('the default tree, also as a copy (a worker\'s params), keeps ⌊surfaceEst⌋ + 1; a tree with no terrain tap too', () => {
    const copy = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as JsonValue;
    expect(copy).not.toBe(DEFAULT_DENSITY_TREE);
    const tap = ((AMPLIFIED_DENSITY_TREE as Record<string, JsonValue>)['root'] as { a: { a: Record<string, JsonValue> } }).a.a;
    const noTerrain = deriveTree(AMPLIFIED_DENSITY_TREE, 'density.defs', 'density', [
      { path: 'root.a.a', was: { op: 'tap', name: 'terrain' }, by: { ...tap, name: 'ground' } },
    ]);
    for (const defs of [copy, noTerrain]) {
      const ctx = ctxFor('7', { density: { defs } });
      const sp = findSpawn(ctx);
      expect(sp.y).toBe(Math.floor(columnPoint(ctx, sp.x, sp.z).surfaceEst) + 1);
    }
  });
});

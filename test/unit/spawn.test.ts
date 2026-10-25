import { describe, expect, test } from 'vitest';
import { biomeFamily } from '../../src/gen/biomes/registry';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, findSpawnAbortable, landingSurface, ringOffsets } from '../../src/gen/column/spawn';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import type { JsonValue } from '../../src/core/params/json';
import { AMPLIFIED_DENSITY_TREE, deriveTree } from '../../src/core/params/presetTrees';
import { isProfileReady, PROFILE_IDS, resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { readFileSync } from 'node:fs';
import { computeSp2aGolden } from '../../src/metrics/sp2aGoldens';
import { ctxFor } from '../harness/gen';
import { GOLDENS_PATH, type GoldensFile } from '../harness/goldens';

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

describe('landingSurface (SP4c spec §3.2, D12)', () => {
  const at = (seed: string, params: Params) => createGenContext(seedFromInput(seed), params);
  /** ⌊surfaceEst⌋ and surfaceEst3 at (x, z) of `ctx`, computed directly. */
  const parts = (ctx: GenContext, dc: DensityContext, x: number, z: number) =>
    ({ flat: Math.floor(columnPoint(ctx, x, z).surfaceEst), est3: surfaceEst3(dc, x, z) });
  /** The no-`terrain` variant of the amplified tree (its tap renamed), as the spawn tests build it. */
  const noTerrainTree = (): JsonValue => {
    const tap = ((AMPLIFIED_DENSITY_TREE as Record<string, JsonValue>)['root'] as { a: { a: Record<string, JsonValue> } }).a.a;
    return deriveTree(AMPLIFIED_DENSITY_TREE, 'density.defs', 'density', [
      { path: 'root.a.a', was: { op: 'tap', name: 'terrain' }, by: { ...tap, name: 'ground' } },
    ]);
  };
  /**
   * Seed 42's first default-profile column, in ring order over the 64-block lattice within ±2,048 blocks, where
   * surfaceEst3 exceeds ⌊surfaceEst⌋ by ≥ 20 (a jagged peak the 2D estimate puts the camera inside). Pinned after the
   * first run; Task 17's teleport test reuses it.
   */
  const JAGGED = { x: -320, z: 128 } as const;

  test('landingSurface under the default tree is max(⌊surfaceEst⌋, surfaceEst3) at 64 lattice points', () => {
    const ctx = ctxFor('42');
    const dc = createDensityContext(ctx);
    let above = 0;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const x = (i - 4) * 512;
        const z = (j - 4) * 512;
        const { flat, est3 } = parts(ctx, dc, x, z);
        expect([x, z, landingSurface(ctx, x, z)]).toEqual([x, z, Math.max(flat, est3)]);
        if (est3 > flat) above++;
      }
    }
    // The 3D surface rises above the 2D estimate somewhere among them (jaggedness, overhang, detail).
    expect(above).toBeGreaterThan(0);
  });

  test('a default-profile jagged column: seed 42\'s first lattice column within ±2,048 blocks where surfaceEst3 exceeds ⌊surfaceEst⌋ by ≥ 20; there landingSurface equals surfaceEst3', () => {
    const ctx = ctxFor('42');
    const dc = createDensityContext(ctx);
    let found: { x: number; z: number } | null = null;
    for (let r = 0; r <= 32 && found === null; r++) {
      for (const [dx, dz] of ringOffsets(r)) {
        const { flat, est3 } = parts(ctx, dc, dx * 64, dz * 64);
        if (est3 - flat >= 20) { found = { x: dx * 64, z: dz * 64 }; break; }
      }
    }
    expect(found).toEqual(JAGGED);
    const { flat, est3 } = parts(ctx, dc, JAGGED.x, JAGGED.z);
    expect(est3 - flat).toBeGreaterThanOrEqual(20);
    expect(landingSurface(ctx, JAGGED.x, JAGGED.z)).toBe(est3);
  }, 60_000);

  test('under amplified, at seeds 1-8\'s spawn points, landingSurface equals surfaceEst3 and exceeds ⌊surfaceEst⌋ by > 20 at at least one', () => {
    let deep = 0;
    for (let s = 1; s <= 8; s++) {
      const ctx = at(String(s), resolveProfile('amplified'));
      const sp = findSpawn(ctx);
      const { flat, est3 } = parts(ctx, createDensityContext(ctx), sp.x, sp.z);
      const got = landingSurface(ctx, sp.x, sp.z);
      expect([s, got]).toEqual([s, est3]);
      if (got - flat > 20) deep++;
    }
    expect(deep).toBeGreaterThan(0);
  });

  test('under a tree with no reachable `terrain` tap it is ⌊surfaceEst⌋', () => {
    const ctx = ctxFor('7', { density: { defs: noTerrainTree() } });
    for (const [x, z] of [[0, 0], [640, -1280], [-2048, 1984], [5, -9]] as const) {
      expect([x, z, landingSurface(ctx, x, z)]).toEqual([x, z, Math.floor(columnPoint(ctx, x, z).surfaceEst)]);
    }
  });

  test('it refuses a position that is not an integer in the world window (RangeError, as surfaceEst3)', () => {
    const ctx = ctxFor('42');
    for (const [x, z] of [[0.5, 0], [0, Number.NaN], [524288, 0], [0, -524289]] as const) expect(() => landingSurface(ctx, x, z)).toThrow(RangeError);
  });

  test('findSpawn and `spawnY` are unchanged (the spawn goldens pass)', () => {
    const file = JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldensFile;
    expect(computeSp2aGolden('sp2a.spawn')).toBe(file.entries['sp2a.spawn']);
  }, 60_000);
});

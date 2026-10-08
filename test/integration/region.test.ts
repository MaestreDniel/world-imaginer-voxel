import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { DEEPSLATE, DIRT, GRASS_BLOCK } from '../../src/world/blocks/index';
import { GOLDENS_PATH, type GoldensFile } from '../harness/goldens';
import { genRegion, regionDiff, type GenRegionOptions, type RegionResult } from '../harness/region';

/**
 * The region harness with 4 worker threads against 1 thread (SP3a spec §6.1, §8; the surfaced T since SP3c §8): a
 * growable SharedArrayBuffer store written by 4 `worker_threads` running `test/harness/regionWorker.ts` from a dynamic
 * queue gives the same region, byte for byte (region hash and per-channel uniform/dense layout), as the in-process plain ArrayBuffer
 * store, in every dispatch order; its 8 × 8 window at (−4, −4) is the recorded `sp3a.region.T.<profile>` golden.
 * The runs are compared byte for byte (`regionDiff`, which also checks the uniform/dense layout); only the golden
 * windows are hashed. DT1 (`test/metrics/region.metric.ts`) compares whole-region hashes.
 */
const DIR = fileURLToPath(new URL('../.cache/regionIntegration/', import.meta.url));
const GOLDENS = (JSON.parse(readFileSync(GOLDENS_PATH, 'utf8')) as GoldensFile).entries;

/** Live slots of both pools, and the dense entries plus aux slots the region's records hold. */
function accounting(r: RegionResult) {
  const { store, cx0, cz0, w, h } = r.view;
  let blocks = 0;
  let bytes = 0;
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const d = r.view.descriptors(cx, cz);
      for (let sy = 0; sy < 24; sy++) {
        if (d[2 * sy]! >= 0) blocks++;
        if (d[2 * sy + 1]! >= 0) bytes++;
      }
      bytes += 2; // aux A and aux B
    }
  }
  return {
    live: [store.blockPool.slotCount() - store.blockPool.freeCount(), store.bytePool.slotCount() - store.bytePool.freeCount()],
    held: [blocks, bytes],
  };
}

describe.each(['default', 'large_biomes'] as const)('genRegion, profile %s', (profile) => {
  const base: GenRegionOptions = {
    seed: '42', params: resolveProfile(profile), cx0: -8, cz0: -8, w: 16, h: 16, upTo: 'T', order: 'spiral', threads: 1,
  };

  test('4 threads equal 1 thread in every order; the 8 × 8 window at (−4, −4) is the golden', async () => {
    const runs: Array<[string, RegionResult]> = [];
    for (const [order, threads, shuffleSeed] of [['spiral', 1, undefined], ['shuffled', 4, 3], ['spiral', 4, undefined], ['shuffled', 1, 9]] as const) {
      const r = await genRegion({ ...base, order, threads, ...(shuffleSeed === undefined ? {} : { shuffleSeed }) });
      runs.push([`${order}/${threads}`, r]);
    }
    const [, ref] = runs[0]!;
    expect(ref.view.hash(-4, -4, 8, 8)).toBe(GOLDENS[`sp3a.region.T.${profile}`]);
    expect(runs[1]![1].view.hash(-4, -4, 8, 8), 'shuffled/4').toBe(GOLDENS[`sp3a.region.T.${profile}`]);
    // The T is surfaced (SP3c §1): this region is grassland, grass_block over dirt, with deepslate at y −30.
    let grassOverDirt = 0;
    let deepslate = 0;
    for (let x = -128; x < 128; x += 3) {
      for (let z = -128; z < 128; z += 3) {
        const top = ref.view.oceanFloorWG(x, z) - 1;
        if (ref.view.block(x, top, z) === GRASS_BLOCK && ref.view.block(x, top - 1, z) === DIRT) grassOverDirt++;
        if (ref.view.block(x, -30, z) === DEEPSLATE) deepslate++;
      }
    }
    expect(grassOverDirt).toBeGreaterThan(5000);
    expect(deepslate).toBeGreaterThan(5000);
    for (const [what, r] of runs) {
      expect(regionDiff(r.view, ref.view), what).toBeNull();
      expect(r.cacheHit).toBe(false);
      expect(r.view.store.shared, what).toBe(what.endsWith('/4'));
      const a = accounting(r);
      expect(a.live, what).toEqual(a.held);
      expect(r.timings.perColumnMs.length).toBe(256);
      for (const ms of r.timings.perColumnMs) expect(ms).toBeGreaterThan(0);
      // Every column written exactly once, and with 4 threads by all four of them.
      expect(r.columnsPerThread.reduce((s, n) => s + n, 0), what).toBe(256);
      expect(r.columnsPerThread.length, what).toBe(what.endsWith('/4') ? 4 : 1);
      for (const n of r.columnsPerThread) expect(n, what).toBeGreaterThan(0);
    }
  }, 120_000);
});

test('4 threads with the cache: a miss writes the dump, a hit rebuilds it into a shared store', async () => {
  rmSync(DIR, { recursive: true, force: true });
  const o: GenRegionOptions = {
    seed: '7', params: resolveProfile('default'), cx0: 30, cz0: -12, w: 6, h: 5, upTo: 'T', order: 'shuffled', threads: 4,
    cache: true, cacheDir: DIR,
  };
  const cold = await genRegion({ ...o, threads: 1, order: 'spiral', cache: false });
  const a = await genRegion(o);
  const b = await genRegion(o);
  expect([a.cacheHit, b.cacheHit]).toEqual([false, true]);
  expect(b.view.store.shared).toBe(true);
  expect(regionDiff(a.view, cold.view)).toBeNull();
  expect(regionDiff(b.view, cold.view)).toBeNull();
  expect(b.view.hash()).toBe(cold.view.hash());
  rmSync(DIR, { recursive: true, force: true });
}, 120_000);

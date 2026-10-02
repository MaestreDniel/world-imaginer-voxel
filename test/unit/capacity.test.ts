import { describe, expect, test } from 'vitest';
import { TILE_CACHE_MIN, tileCacheCapacity } from '../../src/ui/map/capacity';
import type { MapView } from '../../src/ui/map/mapState';
import { createTileCache } from '../../src/ui/map/tileCache';
import { planTiles } from '../../src/ui/map/viewMath';

const at = (bpp: number): MapView => ({ x: 0, z: 0, bpp, layer: 'biome' });

describe('tile cache capacity (SP2b spec §2.5, SP2a minor 10)', () => {
  test('max(256, 3 × (visible target-level tiles + visible preview tiles))', () => {
    expect(TILE_CACHE_MIN).toBe(256);
    // The §2.8 hook view: 4 preview tiles and 24 level-64 tiles.
    expect(planTiles(at(64), 1100, 825)).toHaveLength(28);
    expect(tileCacheCapacity(at(64), 1100, 825)).toBe(256);
    // 4K at 64 blocks/px: 16 preview + 160 level-64 tiles.
    expect(tileCacheCapacity(at(64), 3840, 2160)).toBe(3 * (16 + 160));
    // 4K just above 128 px per level-4 tile (SP2a minor 10's thrash case): 4 preview + 540 level-4 tiles.
    expect(tileCacheCapacity(at(7.99), 3840, 2160)).toBe(3 * (4 + 540));
    // When the view's level is the preview level, its tiles are counted once.
    expect(planTiles(at(256), 3840, 2160)).toHaveLength(160);
    expect(tileCacheCapacity(at(256), 3840, 2160)).toBe(3 * 160);
  });

  test('recomputed on resize: the same view needs more entries on a larger canvas', () => {
    const v = at(16);
    const sizes: Array<[number, number]> = [[640, 480], [1100, 825], [1920, 1080], [2560, 1440], [3840, 2160]];
    const caps = sizes.map(([w, h]) => tileCacheCapacity(v, w, h));
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]!);
    expect(caps[0]).toBe(256);
    expect(caps.at(-1)).toBeGreaterThan(256);
  });

  test('the cache takes a new capacity: lowering it evicts the least recently used entries at once, with their keys', () => {
    const evicted: string[] = [];
    const c = createTileCache<number>(4, (v, key) => evicted.push(`${key}=${v}`));
    expect(c.capacity).toBe(4);
    for (const [k, v] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) c.set(k, v);
    c.get('a');
    c.setCapacity(2);
    expect([c.capacity, c.size, evicted]).toEqual([2, 2, ['b=2', 'c=3']]);
    c.setCapacity(10);
    for (const [k, v] of [['e', 5], ['f', 6], ['g', 7]] as const) c.set(k, v);
    expect([c.size, evicted.length]).toEqual([5, 2]);
    c.set('e', 50);   // a replaced value leaves the cache too
    expect(evicted.at(-1)).toBe('e=5');
    expect(() => c.setCapacity(0)).toThrow(RangeError);
  });
});

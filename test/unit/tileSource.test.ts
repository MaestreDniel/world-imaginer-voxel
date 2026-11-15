import { describe, expect, test } from 'vitest';
import { createTileSource } from '../../src/ui/map/tileSource';

const hashes = (over: Record<string, string> = {}) => ({ climate: 'c1', shape: 's1', surfaceEst: 'e1', biome2d: 'b1', map: 'm1', ...over });

describe('tile source (final review: stale keys and partial invalidation)', () => {
  test('no key before a source is set, or while the pool is in another epoch', () => {
    const src = createTileSource();
    expect(src.epoch).toBeNull();
    expect(src.keyFor('C', 64, 0, 0, 0)).toBeNull();
    src.set(3, '42.0', hashes());
    expect(src.epoch).toBe(3);
    expect(src.keyFor('C', 64, 0, 0, 3)).not.toBeNull();
    expect(src.keyFor('C', 64, 0, 0, 4)).toBeNull();
  });
  test('no clear(): a reconfigure keeps the source until the next set, and the canvas draws fallback tiles meanwhile (SP2b §2.5)', () => {
    expect('clear' in createTileSource()).toBe(false);
  });
  test('a layer key depends on the seed and its own stage only, not on the map stage chain', () => {
    const src = createTileSource();
    src.set(1, '42.0', hashes());
    const c = src.keyFor('C', 64, 1, 2, 1);
    const biome = src.keyFor('biome', 64, 1, 2, 1);
    src.set(2, '42.0', hashes({ shape: 's2', surfaceEst: 'e2', biome2d: 'b2', map: 'm2' }));
    expect(src.keyFor('C', 64, 1, 2, 2)).toBe(c);
    expect(src.keyFor('biome', 64, 1, 2, 2)).not.toBe(biome);
    src.set(3, '43.0', hashes());
    expect(src.keyFor('C', 64, 1, 2, 3)).not.toBe(c);
  });
  test('the caveBiome layer\'s key gains `:y<n>`: two y values give two keys; no other layer\'s key holds a y (SP6b spec §9.1)', () => {
    const src = createTileSource();
    src.set(1, '42.0', hashes({ terrain: 't1' }));
    const at0 = src.keyFor('caveBiome', 64, 1, 2, 1, 0);
    const at40 = src.keyFor('caveBiome', 64, 1, 2, 1, 40);
    expect(at0).toMatch(/^caveBiome\|64\|1\|2\|42\.0:t1:map\d+:y0$/);
    expect(at40!.endsWith(':y40')).toBe(true);
    expect(at40).not.toBe(at0);
    expect(src.keyFor('caveBiome', 64, 1, 2, 1, -12)!.endsWith(':y-12')).toBe(true);
    const biome = src.keyFor('biome', 64, 1, 2, 1);
    expect([src.keyFor('biome', 64, 1, 2, 1, 0), src.keyFor('biome', 64, 1, 2, 1, 40)]).toEqual([biome, biome]);
    expect(biome).not.toMatch(/:y/);
    expect(() => src.keyFor('caveBiome', 64, 1, 2, 1)).toThrow(RangeError);
  });
});

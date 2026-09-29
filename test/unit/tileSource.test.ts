import { describe, expect, test } from 'vitest';
import { createTileSource } from '../../src/ui/map/tileSource';

const hashes = (over: Record<string, string> = {}) => ({ climate: 'c1', shape: 's1', surfaceEst: 'e1', biome2d: 'b1', map: 'm1', ...over });

describe('tile source (final review: stale keys and partial invalidation)', () => {
  test('no key before a source is set, or while the pool is in another epoch', () => {
    const src = createTileSource();
    expect(src.keyFor('C', 64, 0, 0, 0)).toBeNull();
    src.set(3, '42.0', hashes());
    expect(src.keyFor('C', 64, 0, 0, 3)).not.toBeNull();
    expect(src.keyFor('C', 64, 0, 0, 4)).toBeNull();
    src.clear();
    expect(src.keyFor('C', 64, 0, 0, 3)).toBeNull();
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
});

import { describe, expect, test } from 'vitest';
import { MAP_TILE_PX } from '../../src/core/constants';
import { HIGHLIGHT_DIM_ALPHA, highlightMask } from '../../src/ui/map/highlight';

describe('biome highlight mask (SP2b spec §5.3)', () => {
  test('dims every pixel of another biome and leaves the highlighted biome clear', () => {
    const A = HIGHLIGHT_DIM_ALPHA;
    expect(A).toBeGreaterThan(0);
    expect(A).toBeLessThan(255);
    expect(Array.from(highlightMask(Uint8Array.from([3, 5, 3, 0]), 3))).toEqual([0, 0, 0, 0, 0, 0, 0, A, 0, 0, 0, 0, 0, 0, 0, A]);
    expect(Array.from(highlightMask(Uint8Array.from([3, 5]), 7))).toEqual([0, 0, 0, A, 0, 0, 0, A]);
  });

  test('a whole tile, written into a reused buffer of 4 bytes per id; another length is refused', () => {
    const ids = new Uint8Array(MAP_TILE_PX * MAP_TILE_PX);
    for (let i = 0; i < ids.length; i++) ids[i] = i % 28;
    const out = new Uint8ClampedArray(4 * ids.length).fill(9);
    expect(highlightMask(ids, 4, out)).toBe(out);
    let rgb = 0;
    let clear = 0;
    for (let i = 0; i < ids.length; i++) {
      rgb += out[4 * i]! + out[4 * i + 1]! + out[4 * i + 2]!;
      if (out[4 * i + 3] === 0) clear++;
    }
    expect([rgb, clear]).toEqual([0, ids.filter((b) => b === 4).length]);
    expect(() => highlightMask(ids, 4, new Uint8ClampedArray(16))).toThrow(RangeError);
  });
});

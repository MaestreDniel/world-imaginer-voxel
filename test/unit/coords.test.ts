import { describe, expect, test } from 'vitest';
import {
  colKey, colKeyCx, colKeyCz, columnIndex, columnInWindow, chunkCoord, inWindow, localCoord, localY, MAX_Y, quartCoord,
  quartY, QUARTS_Y, SECTION_VOXELS, sectionBaseY, sectionKey, sectionKeyColKey, sectionKeySy, sectionY, SECTIONS,
  TORUS_RECORDS, TORUS_SIZE, torusSlot, voxelIndex, voxelLx, voxelLy, voxelLz, WINDOW_HALF, yInWorld,
} from '../../src/core/coords';
import { HEIGHT, MIN_Y } from '../../src/core/constants';
import { testRng } from '../harness/stats';

/** A uniform integer in [lo, hi). */
function intIn(next: () => number, lo: number, hi: number): number {
  return lo + (next() % (hi - lo));
}

describe('constants (master §2.1)', () => {
  test('24 sections of 4096 voxels span y −64 … 319; 96 vertical quarts; a 64 × 64 torus', () => {
    expect(SECTIONS).toBe(24);
    expect(SECTION_VOXELS).toBe(4096);
    expect(MAX_Y).toBe(319);
    expect(MAX_Y - MIN_Y + 1).toBe(HEIGHT);
    expect(SECTIONS * 16).toBe(HEIGHT);
    expect(QUARTS_Y).toBe(96);
    expect(TORUS_SIZE).toBe(64);
    expect(TORUS_RECORDS).toBe(4096);
    expect(WINDOW_HALF).toBe(524288);
  });
});

describe('x/y/z ↔ cx/cz/sy/lx/ly/lz', () => {
  test('cx = x >> 4 and lx = x & 15 round-trip over the window, negatives included', () => {
    const next = testRng(101);
    for (let i = 0; i < 20000; i++) {
      const x = intIn(next, -WINDOW_HALF, WINDOW_HALF);
      const cx = chunkCoord(x), lx = localCoord(x);
      expect(lx).toBeGreaterThanOrEqual(0);
      expect(lx).toBeLessThan(16);
      expect(cx * 16 + lx).toBe(x);
    }
    expect([chunkCoord(-1), localCoord(-1)]).toEqual([-1, 15]);
    expect([chunkCoord(-16), localCoord(-16)]).toEqual([-1, 0]);
    expect([chunkCoord(-17), localCoord(-17)]).toEqual([-2, 15]);
    expect([chunkCoord(15), chunkCoord(16)]).toEqual([0, 1]);
  });

  test('sy = (y + 64) >> 4 and ly round-trip for every y; sectionBaseY is the section floor', () => {
    for (let y = MIN_Y; y <= MAX_Y; y++) {
      const sy = sectionY(y), ly = localY(y);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThan(SECTIONS);
      expect(ly).toBeGreaterThanOrEqual(0);
      expect(ly).toBeLessThan(16);
      expect(sectionBaseY(sy) + ly).toBe(y);
    }
    expect([sectionY(-64), sectionY(-49), sectionY(-48), sectionY(0), sectionY(319)]).toEqual([0, 0, 1, 4, 23]);
    expect(sectionBaseY(0)).toBe(-64);
    expect(sectionBaseY(23)).toBe(304);
  });

  test('yInWorld is the closed range [−64, 319]', () => {
    expect([yInWorld(-65), yInWorld(-64), yInWorld(319), yInWorld(320)]).toEqual([false, true, true, false]);
  });
});

describe('voxel and column indices', () => {
  test('voxelIndex = ly << 8 | lz << 4 | lx is a bijection onto 0 … 4095 and decodes back', () => {
    const seen = new Uint8Array(SECTION_VOXELS);
    for (let ly = 0; ly < 16; ly++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const i = voxelIndex(lx, ly, lz);
          expect(i).toBe(ly * 256 + lz * 16 + lx);
          expect([voxelLx(i), voxelLy(i), voxelLz(i)]).toEqual([lx, ly, lz]);
          seen[i]!++;
        }
      }
    }
    expect(seen.every((c) => c === 1)).toBe(true);
    expect(voxelIndex(15, 15, 15)).toBe(4095);
  });

  test('columnIndex = lz·16 + lx', () => {
    expect(columnIndex(0, 0)).toBe(0);
    expect(columnIndex(3, 0)).toBe(3);
    expect(columnIndex(0, 1)).toBe(16);
    expect(columnIndex(15, 15)).toBe(255);
  });
});

describe('colKey and sectionKey (numeric, < 2^32 and < 2^37)', () => {
  test('colKey = (cx + 32768)·65536 + (cz + 32768) at the window corners', () => {
    expect(colKey(-32768, -32768)).toBe(0);
    expect(colKey(32767, 32767)).toBe(4294967295);
    expect(colKey(0, 0)).toBe(32768 * 65536 + 32768);
    expect(colKey(-32768, 32767)).toBe(65535);
    expect(colKey(32767, -32768)).toBe(65535 * 65536);
  });

  test('colKey round-trips through colKeyCx/colKeyCz over the whole window', () => {
    const next = testRng(102);
    const edges = [-32768, -32767, -1, 0, 1, 32766, 32767];
    const pairs: Array<[number, number]> = [];
    for (const a of edges) for (const b of edges) pairs.push([a, b]);
    for (let i = 0; i < 20000; i++) pairs.push([intIn(next, -32768, 32768), intIn(next, -32768, 32768)]);
    for (const [cx, cz] of pairs) {
      const k = colKey(cx, cz);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(4294967296);
      expect([colKeyCx(k), colKeyCz(k)]).toEqual([cx, cz]);
    }
  });

  test('sectionKey = colKey·32 + sy round-trips, maximum included', () => {
    const next = testRng(103);
    for (let i = 0; i < 5000; i++) {
      const cx = intIn(next, -32768, 32768), cz = intIn(next, -32768, 32768), sy = intIn(next, 0, SECTIONS);
      const k = sectionKey(cx, cz, sy);
      expect(k).toBe(colKey(cx, cz) * 32 + sy);
      expect(sectionKeyColKey(k)).toBe(colKey(cx, cz));
      expect(sectionKeySy(k)).toBe(sy);
    }
    const top = sectionKey(32767, 32767, 23);
    expect(top).toBe(4294967295 * 32 + 23);
    expect(sectionKeyColKey(top)).toBe(4294967295);
    expect(sectionKeySy(top)).toBe(23);
  });
});

describe('torus slot', () => {
  test('(cx & 63) + 64·(cz & 63), with columns 64 apart on the same record', () => {
    expect(torusSlot(0, 0)).toBe(0);
    expect(torusSlot(63, 0)).toBe(63);
    expect(torusSlot(0, 1)).toBe(64);
    expect(torusSlot(-1, -1)).toBe(4095);
    expect(torusSlot(-32768, -32768)).toBe(0);
    expect(torusSlot(32767, 32767)).toBe(4095);
    expect(torusSlot(64, -64)).toBe(0);
    // The slice job's all-record-0 line: x 0 … 523264 is cx 0 … 32704, every 64th column on record 0.
    expect(torusSlot(chunkCoord(523264), 0)).toBe(0);
  });

  test('any 64 × 64 block of columns covers every record once', () => {
    for (const [cx0, cz0] of [[0, 0], [-32768, -32768], [-17, 5], [32704, 32704]] as const) {
      const seen = new Uint8Array(TORUS_RECORDS);
      for (let dz = 0; dz < TORUS_SIZE; dz++) for (let dx = 0; dx < TORUS_SIZE; dx++) seen[torusSlot(cx0 + dx, cz0 + dz)]!++;
      expect(seen.every((c) => c === 1)).toBe(true);
    }
  });
});

describe('quart coordinates', () => {
  test('qx = x >> 2 and qy = (y + 64) >> 2 in 0 … 95', () => {
    expect([quartCoord(0), quartCoord(3), quartCoord(4), quartCoord(-1), quartCoord(-4), quartCoord(-5)]).toEqual([0, 0, 1, -1, -1, -2]);
    expect([quartCoord(-WINDOW_HALF), quartCoord(WINDOW_HALF - 1)]).toEqual([-131072, 131071]);
    for (let y = MIN_Y; y <= MAX_Y; y++) {
      const qy = quartY(y);
      expect(qy).toBe(Math.floor((y - MIN_Y) / 4));
      expect(qy).toBeGreaterThanOrEqual(0);
      expect(qy).toBeLessThan(QUARTS_Y);
    }
  });
});

describe('the half-open world window [−2^19, 2^19) (SP2b §6.3)', () => {
  test('inWindow at the edges', () => {
    expect(inWindow(-524288, -524288)).toBe(true);
    expect(inWindow(524287, 524287)).toBe(true);
    expect(inWindow(524288, 0)).toBe(false);
    expect(inWindow(0, 524288)).toBe(false);
    expect(inWindow(-524289, 0)).toBe(false);
    expect(inWindow(0, -524289)).toBe(false);
    expect(inWindow(0, 0)).toBe(true);
  });

  test('columnInWindow is the window in columns, cx, cz ∈ [−32768, 32768)', () => {
    expect(columnInWindow(-32768, -32768)).toBe(true);
    expect(columnInWindow(32767, 32767)).toBe(true);
    expect(columnInWindow(32768, 0)).toBe(false);
    expect(columnInWindow(0, -32769)).toBe(false);
    expect(columnInWindow(chunkCoord(-524288), chunkCoord(524287))).toBe(true);
    expect(columnInWindow(chunkCoord(524288), 0)).toBe(false);
  });

  test('every block of the window has a column in the window', () => {
    const next = testRng(104);
    for (let i = 0; i < 5000; i++) {
      const x = intIn(next, -WINDOW_HALF, WINDOW_HALF), z = intIn(next, -WINDOW_HALF, WINDOW_HALF);
      expect(inWindow(x, z)).toBe(true);
      expect(columnInWindow(chunkCoord(x), chunkCoord(z))).toBe(true);
    }
  });
});

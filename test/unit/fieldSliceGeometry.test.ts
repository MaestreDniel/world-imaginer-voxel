import { describe, expect, test } from 'vitest';
import { HEIGHT, MIN_Y, SLICE_EXTENTS, SLICE_NS } from '../../src/core/constants';
import { MAX_Y, WINDOW_HALF } from '../../src/core/coords';
import { horizontalCoord, sliceGeometryProblem, sliceRowY, sliceSampleVoxel, squareProblem, type SliceGeometry } from '../../src/gen/inspect/fieldSlice';
import { CROSS_SECTION_POINTS, segmentPointAt, segmentProblem, type Segment } from '../../src/metrics/crossSection';

const MOUNTAIN: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const DIAGONAL: Segment = { ax: 100, az: -37, bx: -2900, bz: 4100 };

describe('the slice sizes and extents (core/constants.ts)', () => {
  test('SLICE_NS = [32, 128] and SLICE_EXTENTS = 256 … 8192, frozen', () => {
    expect(SLICE_NS).toEqual([32, 128]);
    expect(SLICE_EXTENTS).toEqual([256, 512, 1024, 2048, 4096, 8192]);
    expect(Object.isFrozen(SLICE_NS)).toBe(true);
    expect(Object.isFrozen(SLICE_EXTENTS)).toBe(true);
  });
});

describe('segmentPointAt(s, i, n): t = i/(n − 1)', () => {
  test('the default n is 512: existing callers unchanged', () => {
    expect(CROSS_SECTION_POINTS).toBe(512);
    for (const i of [0, 1, 318, 511]) expect(segmentPointAt(DIAGONAL, i, 512)).toEqual(segmentPointAt(DIAGONAL, i));
    expect(segmentPointAt(MOUNTAIN, 318)).toEqual([-1664 + 1024 * (318 / 511), 8]);
  });
  test.each(SLICE_NS.map((n) => [n]))('n = %i: A at 0, B at n − 1, evenly spaced', (n) => {
    for (const s of [MOUNTAIN, DIAGONAL]) {
      expect(segmentPointAt(s, 0, n)).toEqual([s.ax, s.az]);
      expect(segmentPointAt(s, n - 1, n)).toEqual([s.bx, s.bz]);
      const i = n >> 1;
      expect(segmentPointAt(s, i, n)).toEqual([s.ax + (s.bx - s.ax) * (i / (n - 1)), s.az + (s.bz - s.az) * (i / (n - 1))]);
    }
  });
  test('the bounding-box clamp holds at every n (B the largest double below 2^19)', () => {
    const edge: Segment = { ax: -0.1, az: 0, bx: 524287.99999999994, bz: 0 };
    expect(segmentProblem(edge)).toBeNull();
    for (const n of SLICE_NS) expect(segmentPointAt(edge, n - 1, n)).toEqual([524287.99999999994, 0]);
  });
});

describe('vertical rows: y_r = 319 − ⌊(2r + 1)·384 / (2n)⌋', () => {
  test('row centres 318 … −63 at n = 128 and 313 … −59 at n = 32', () => {
    expect([sliceRowY(0, 128), sliceRowY(127, 128)]).toEqual([318, -63]);
    expect([sliceRowY(0, 32), sliceRowY(31, 32)]).toEqual([313, -59]);
  });
  test.each(SLICE_NS.map((n) => [n]))('n = %i: integers, strictly decreasing by 384/n, inside the world', (n) => {
    const ys = Array.from({ length: n }, (_, r) => sliceRowY(r, n));
    for (let r = 0; r < n; r++) {
      expect(Number.isInteger(ys[r])).toBe(true);
      expect(ys[r]).toBe(MAX_Y - Math.floor(((2 * r + 1) * HEIGHT) / (2 * n)));
      expect(ys[r]!).toBeGreaterThanOrEqual(MIN_Y);
      expect(ys[r]!).toBeLessThanOrEqual(MAX_Y);
      if (r > 0) expect(ys[r - 1]! - ys[r]!).toBe(HEIGHT / n);
    }
  });
  test('bad rows and sizes throw', () => {
    expect(() => sliceRowY(-1, 128)).toThrow(RangeError);
    expect(() => sliceRowY(128, 128)).toThrow(RangeError);
    expect(() => sliceRowY(1.5, 128)).toThrow(RangeError);
    expect(() => sliceRowY(0, 64)).toThrow('n 64 is not a slice size (32, 128)');
  });
});

describe('horizontal coordinates: x_i = cx − E/2 + ⌊(2i + 1)·E / (2n)⌋', () => {
  test('ends and spacing', () => {
    expect([horizontalCoord(0, 256, 0, 128), horizontalCoord(0, 256, 127, 128)]).toEqual([-127, 127]);
    expect([horizontalCoord(0, 8192, 0, 128), horizontalCoord(0, 8192, 127, 128)]).toEqual([-4064, 4064]);
    expect([horizontalCoord(10, 2048, 0, 32), horizontalCoord(10, 2048, 31, 32)]).toEqual([10 - 1024 + 32, 10 + 1024 - 32]);
    expect([horizontalCoord(-7, 256, 0, 32), horizontalCoord(-7, 256, 1, 32)]).toEqual([-7 - 128 + 4, -7 - 128 + 12]);
  });
  test('integers for every allowed extent and size, evenly spaced E/n, strictly inside [c − E/2, c + E/2)', () => {
    for (const E of SLICE_EXTENTS) for (const n of SLICE_NS) for (const c of [0, -3, 524288 - E / 2, -524288 + E / 2]) {
      for (let i = 0; i < n; i++) {
        const x = horizontalCoord(c, E, i, n);
        expect(Number.isInteger(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(c - E / 2);
        expect(x).toBeLessThan(c + E / 2);
        if (i > 0) expect(x - horizontalCoord(c, E, i - 1, n)).toBe(E / n);
      }
    }
  });
  test('bad arguments throw', () => {
    expect(() => horizontalCoord(0, 300, 0, 128)).toThrow('extent 300 is not a slice extent (256, 512, 1024, 2048, 4096, 8192)');
    expect(() => horizontalCoord(0, 256, 0, 16)).toThrow(RangeError);
    expect(() => horizontalCoord(0, 256, 128, 128)).toThrow(RangeError);
    expect(() => horizontalCoord(0.5, 256, 0, 128)).toThrow(RangeError);
  });
});

describe('the square must lie inside the world window', () => {
  test('the four edges at the limit pass, one block beyond refuses', () => {
    for (const E of SLICE_EXTENTS) {
      const h = E / 2;
      expect(squareProblem(-WINDOW_HALF + h, 0, E)).toBeNull();
      expect(squareProblem(WINDOW_HALF - h, 0, E)).toBeNull();
      expect(squareProblem(0, -WINDOW_HALF + h, E)).toBeNull();
      expect(squareProblem(0, WINDOW_HALF - h, E)).toBeNull();
      expect(squareProblem(-WINDOW_HALF + h - 1, 0, E)).not.toBeNull();
      expect(squareProblem(WINDOW_HALF - h + 1, 0, E)).not.toBeNull();
      expect(squareProblem(0, -WINDOW_HALF + h - 1, E)).not.toBeNull();
      expect(squareProblem(0, WINDOW_HALF - h + 1, E)).not.toBeNull();
    }
  });
  test('the messages', () => {
    expect(squareProblem(524161, 5, 256)).toBe('the square x [524033, 524289] × z [-123, 133] leaves the world window [-524288, 524288]');
    expect(squareProblem(0, -524200, 256)).toBe('the square x [-128, 128] × z [-524328, -524072] leaves the world window [-524288, 524288]');
    expect(squareProblem(0.5, 0, 256)).toBe('the centre (0.5, 0) is not a pair of integers');
    expect(squareProblem(0, Number.NaN, 256)).toBe('the centre (0, NaN) is not a pair of integers');
    expect(squareProblem(0, 0, 100)).toBe('extent 100 is not a slice extent (256, 512, 1024, 2048, 4096, 8192)');
  });
  test('every sample of a square at the limit lies in the half-open window', () => {
    for (const E of SLICE_EXTENTS) for (const c of [-WINDOW_HALF + E / 2, WINDOW_HALF - E / 2]) {
      for (const i of [0, 127]) {
        const x = horizontalCoord(c, E, i, 128);
        expect(x >= -WINDOW_HALF && x < WINDOW_HALF).toBe(true);
      }
    }
  });
});

describe('sample voxels of both planes', () => {
  const vertical = (s: Segment, n: number): SliceGeometry => ({ plane: 'vertical', n, pointAt: (i) => segmentPointAt(s, i, n) });
  test('vertical sample (i, r) = (⌊xᵢ⌋, y_r, ⌊zᵢ⌋), points injected', () => {
    for (const n of SLICE_NS) {
      const g = vertical(DIAGONAL, n);
      expect(sliceGeometryProblem(g)).toBeNull();
      for (const [i, r] of [[0, 0], [n - 1, n - 1], [n >> 1, 3], [5, n - 2]] as const) {
        const [px, pz] = segmentPointAt(DIAGONAL, i, n);
        expect(sliceSampleVoxel(g, i, r)).toEqual([Math.floor(px), sliceRowY(r, n), Math.floor(pz)]);
      }
    }
    // A non-integer point floors toward −∞, also below 0.
    const g: SliceGeometry = { plane: 'vertical', n: 32, pointAt: () => [-0.25, 7.75] };
    expect(sliceSampleVoxel(g, 3, 0)).toEqual([-1, 313, 7]);
  });
  test('horizontal sample (i, j) of sample column j = (x_i, y, z_j)', () => {
    const g: SliceGeometry = { plane: 'horizontal', n: 128, cx: 1000, cz: -2000, y: 63, extent: 2048 };
    expect(sliceGeometryProblem(g)).toBeNull();
    expect(sliceSampleVoxel(g, 0, 0)).toEqual([1000 - 1024 + 8, 63, -2000 - 1024 + 8]);
    expect(sliceSampleVoxel(g, 5, 127)).toEqual([horizontalCoord(1000, 2048, 127, 128), 63, horizontalCoord(-2000, 2048, 5, 128)]);
  });
  test('geometry problems', () => {
    expect(sliceGeometryProblem({ plane: 'vertical', n: 64, pointAt: () => [0, 0] })).toBe('n 64 is not a slice size (32, 128)');
    expect(sliceGeometryProblem({ plane: 'horizontal', n: 32, cx: 0, cz: 0, y: 320, extent: 256 })).toBe('y 320 is not an integer in [-64, 319]');
    expect(sliceGeometryProblem({ plane: 'horizontal', n: 32, cx: 0, cz: 0, y: 2.5, extent: 256 })).toBe('y 2.5 is not an integer in [-64, 319]');
    expect(sliceGeometryProblem({ plane: 'horizontal', n: 32, cx: 524288, cz: 0, y: 0, extent: 256 })).toBe(squareProblem(524288, 0, 256));
  });
  test('sample indices outside [0, n) and points outside the window throw', () => {
    const g = vertical(MOUNTAIN, 32);
    expect(() => sliceSampleVoxel(g, 32, 0)).toThrow(RangeError);
    expect(() => sliceSampleVoxel(g, 0, -1)).toThrow(RangeError);
    expect(() => sliceSampleVoxel({ plane: 'vertical', n: 32, pointAt: () => [524288, 0] }, 0, 0)).toThrow(RangeError);
    expect(() => sliceSampleVoxel({ plane: 'vertical', n: 32, pointAt: () => [Number.NaN, 0] }, 0, 0)).toThrow(RangeError);
  });
});

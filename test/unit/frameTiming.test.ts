import { describe, expect, test } from 'vitest';
import { medianInterval, onTimeIntervalInto, percentile, snapFrameTime } from '../../src/render/frameTiming';

describe('frame timing (SP4a spec §1.2, §9.5)', () => {
  test('a delta within ±1 ms of k·interval snaps to k·interval', () => {
    expect(snapFrameTime(16.9, 16.667)).toBe(16.667);
    // k·interval exactly: 2 × 16.667 = 33.334 (ruling P20), never rounded for display.
    expect(snapFrameTime(33.0, 16.667)).toBe(2 * 16.667);
    expect(snapFrameTime(15.8, 16.667)).toBe(16.667);
  });

  test('a delta farther than 1 ms from every multiple stays as it is', () => {
    expect(snapFrameTime(20, 16.667)).toBe(20);
    expect(snapFrameTime(25, 16.667)).toBe(25);
  });

  test('k is at least 1: a short delta far from one interval stays', () => {
    expect(snapFrameTime(4, 16.667)).toBe(4);
    expect(snapFrameTime(6.5, 6.96)).toBe(6.96);
  });

  test('percentile by nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile(new Float64Array([5]), 95)).toBe(5);
    expect(Number.isNaN(percentile([], 95))).toBe(true);
  });

  test('medianInterval is the median of the deltas', () => {
    expect(medianInterval([16.5, 16, 17])).toBe(16.5);
    expect(medianInterval([6.9, 7.0, 6.95, 30])).toBeCloseTo(6.975, 9);
    expect(Number.isNaN(medianInterval([]))).toBe(true);
  });

  test('medianInterval with a scratch: the same values, sorted into the scratch, no other array', () => {
    const deltas = [17, 16.5, 16, 16.8, 15.9];
    const scratch = new Float64Array(5);
    expect(medianInterval(deltas, scratch)).toBe(medianInterval(deltas));
    expect(Array.from(scratch)).toEqual([15.9, 16, 16.5, 16.8, 17]);
    expect(medianInterval([16.5, 16, 17], new Float64Array(3))).toBe(16.5);
    expect(medianInterval([6.9, 7.0, 6.95, 30], new Float64Array(4))).toBeCloseTo(6.975, 9);
    expect(Number.isNaN(medianInterval([], new Float64Array(4)))).toBe(true);
  });

  test('medianInterval over the first n values equals the allocating median of those values (odd and even n)', () => {
    const deltas = new Float64Array([16.9, 16.1, 33.4, 16.6, 16.7, 15.2, 16.65, 99, 16.4, 16.0]);
    const scratch = new Float64Array(30);
    for (const n of [1, 2, 3, 4, 7, 8, 10]) {
      expect(medianInterval(deltas, scratch, n), `n ${n}`).toBe(medianInterval(Array.from(deltas.subarray(0, n))));
    }
    // Only scratch[0, n) is written.
    const marked = new Float64Array(8).fill(-1);
    medianInterval(deltas, marked, 5);
    expect(Array.from(marked.subarray(5))).toEqual([-1, -1, -1]);
    expect(Array.from(marked.subarray(0, 5))).toEqual(Array.from(deltas.subarray(0, 5)).sort((a, b) => a - b));
  });

  test('onTimeIntervalInto is the median of the first n values in [p10, 1.5·p10], the on-time cluster (rulings R16)', () => {
    const scratch = new Float64Array(240);
    // Sorted: 16.0 16.5 16.6 16.7 16.8 16.9 17.0 33.3 33.4 50; p10 16.0, the cluster its first 7, median 16.7.
    const window = [16.0, 16.5, 16.7, 16.8, 33.3, 33.4, 50, 16.6, 16.9, 17.0];
    expect(onTimeIntervalInto(window, scratch, 10)).toBe(16.7);
    // An even cluster takes the mean of its middle two: 16.5 16.6 16.7 16.8 (17.0 and 33.3 left out by n).
    expect(onTimeIntervalInto([16.5, 16.8, 16.6, 16.7, 33.3], scratch, 4)).toBeCloseTo(16.65, 12);
    // Two frames in three two intervals late: the slow ones never enter the cluster.
    const late = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 16.667 : 33.333));
    expect(onTimeIntervalInto(late, scratch, 30)).toBe(16.667);
    expect(onTimeIntervalInto([0, 0, 0], scratch, 3)).toBe(0);
    expect(Number.isNaN(onTimeIntervalInto([], scratch, 0))).toBe(true);
    expect(() => onTimeIntervalInto(window, new Float64Array(4), 5)).toThrow(RangeError);
  });
});

import { describe, expect, test } from 'vitest';
import { medianInterval, percentile, snapFrameTime } from '../../src/render/frameTiming';

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
});

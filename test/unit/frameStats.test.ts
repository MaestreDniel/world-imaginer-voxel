import { describe, expect, test } from 'vitest';
import { createFrameStats, nearestRank } from '../../src/ui/frameStats';

describe('frameStats', () => {
  test('empty → zeros, never NaN', () => {
    expect(createFrameStats().summary()).toEqual({ fps: 0, p50: 0, p95: 0, count: 0 });
  });

  test('non-finite and negative deltas are ignored', () => {
    const s = createFrameStats();
    s.push(Number.NaN);
    s.push(Number.POSITIVE_INFINITY);
    s.push(-3);
    expect(s.summary().count).toBe(0);
  });

  test('steady 60 Hz', () => {
    const s = createFrameStats();
    for (let i = 0; i < 60; i++) s.push(1000 / 60);
    const r = s.summary();
    expect(r.fps).toBeCloseTo(60, 6);
    expect(r.p50).toBeCloseTo(16.667, 3);
    expect(r.count).toBe(60);
  });

  test('ring buffer keeps only the last `capacity` frames', () => {
    const s = createFrameStats(4);
    for (const ms of [100, 100, 100, 100, 10, 10, 10, 10]) s.push(ms);
    expect(s.summary()).toEqual({ fps: 100, p50: 10, p95: 10, count: 4 });
  });

  test('p95 catches a spike', () => {
    const s = createFrameStats(20);
    for (let i = 0; i < 19; i++) s.push(10);
    s.push(50);
    expect(s.summary().p95).toBe(10);
    s.push(50);
    expect(s.summary().p95).toBe(50);
  });

  test('nearestRank and invalid capacity', () => {
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 3, 4], 0.95)).toBe(4);
    expect(() => createFrameStats(0)).toThrow(/capacity/);
  });
});

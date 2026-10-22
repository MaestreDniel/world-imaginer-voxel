import { describe, expect, test, vi } from 'vitest';
import { createFrameNotice, lowerRd } from '../../src/ui/world/frameNotice';

/** Pushes `n` frames of `ms` each. */
function feed(notice: { push(frameMs: number): void }, n: number, ms: number): void {
  for (let i = 0; i < n; i++) notice.push(ms);
}

describe('createFrameNotice (SP4a spec §8.5: p95 > 25 ms over the first 300 frames suggests the next lower RD)', () => {
  test('p95 26 ms over 300 frames at rd 12 suggests 10, once', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const notice = createFrameNotice(onSuggest, 12);
    feed(notice, 300, 26);
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSuggest).toHaveBeenCalledWith(10);
    feed(notice, 600, 40);
    expect(onSuggest).toHaveBeenCalledTimes(1);
  });

  test('p95 24 ms suggests nothing', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const notice = createFrameNotice(onSuggest, 12);
    feed(notice, 300, 24);
    // Only the first 300 frames count: slow frames after them suggest nothing.
    feed(notice, 300, 40);
    expect(onSuggest).not.toHaveBeenCalled();
  });

  test('nothing is suggested at rd 4', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const notice = createFrameNotice(onSuggest, 4);
    feed(notice, 300, 40);
    expect(onSuggest).not.toHaveBeenCalled();
  });

  test('nothing is suggested before 300 frames', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const notice = createFrameNotice(onSuggest, 12);
    feed(notice, 299, 40);
    expect(onSuggest).not.toHaveBeenCalled();
    notice.push(40);
    expect(onSuggest).toHaveBeenCalledWith(10);
  });

  test('p95 26 ms over 300 frames at rd 5 suggests 4, once (ruling P49)', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const notice = createFrameNotice(onSuggest, 5);
    feed(notice, 300, 26);
    feed(notice, 300, 26);
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSuggest).toHaveBeenCalledWith(4);
  });

  test('the p95 is taken over snapped frame times: 25.4 ms frames at a 120 Hz display read 3 intervals (25.0 ms)', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const notice = createFrameNotice(onSuggest, 12);
    const interval = 1000 / 120;
    // 85 % on-time frames set the median interval; 15 % at 25.4 ms are within 1 ms of 3 intervals (25.0 ms).
    for (let i = 0; i < 300; i++) notice.push(i % 20 < 17 ? interval : 25.4);
    expect(onSuggest).not.toHaveBeenCalled();
  });

  test('the 95th percentile is by nearest rank: 15 slow frames in 300 do not suggest, 16 do', () => {
    const at = (slow: number): number => {
      const onSuggest = vi.fn<(rd: number) => void>();
      const notice = createFrameNotice(onSuggest, 12);
      for (let i = 0; i < 300; i++) notice.push(i < slow ? 40 : 16.7);
      return onSuggest.mock.calls.length;
    };
    expect(at(15)).toBe(0);
    expect(at(16)).toBe(1);
  });

  test('lowerRd: rd − 2, never below 4, and none at 4', () => {
    expect(lowerRd(12)).toBe(10);
    expect(lowerRd(6)).toBe(4);
    expect(lowerRd(5)).toBe(4);
    expect(lowerRd(4)).toBeNull();
  });
});

import { describe, expect, test, vi } from 'vitest';
import { createFpsLimiter } from '../../src/render/fpsLimiter';
import { createFrameClock, createFrameNotice, lowerRd } from '../../src/ui/world/frameNotice';

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

  test('given the RD in force as a getter, it judges the RD at the 300th frame: loaded at 4, raised live to 10 within the window, it suggests 8 (final review UI-2)', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    let rd = 4;
    const notice = createFrameNotice(onSuggest, () => rd);
    feed(notice, 150, 40);
    rd = 10;
    feed(notice, 150, 40);
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSuggest).toHaveBeenCalledWith(8);
    // Lowered live to 4 before the judgement: nothing below RD_MIN to offer.
    const none = vi.fn<(rd: number) => void>();
    rd = 12;
    const later = createFrameNotice(none, () => rd);
    feed(later, 299, 40);
    rd = 4;
    later.push(40);
    expect(none).not.toHaveBeenCalled();
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

describe('createFrameClock (the page feeds the notice raw rAF deltas, before the FPS limiter)', () => {
  const HZ60 = 1000 / 60;

  test('a 30 fps cap on a fast 60 Hz display suggests nothing (the cap is the user\'s, not a slow GPU)', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const clock = createFrameClock(createFpsLimiter(30), createFrameNotice(onSuggest, 12), 0);
    const rendered: number[] = [];
    for (let i = 1; i <= 600; i++) {
      const dt = clock.tick(i * HZ60);
      if (dt !== null) rendered.push(dt);
    }
    expect(onSuggest).not.toHaveBeenCalled();
    // Every other tick renders, so the rendered frames' deltas are the cap's 33.3 ms: judged, they would suggest.
    expect(rendered.length).toBe(300);
    expect(rendered.slice(1).every((dt) => Math.abs(dt - 2 * HZ60) < 1e-6)).toBe(true);
    const judged = vi.fn<(rd: number) => void>();
    const onRendered = createFrameNotice(judged, 12);
    for (const dt of rendered) onRendered.push(dt);
    expect(judged).toHaveBeenCalledWith(10);
  });

  test('a 30 fps cap with slow frames (50 ms rAF deltas) still suggests the next lower RD', () => {
    const onSuggest = vi.fn<(rd: number) => void>();
    const clock = createFrameClock(createFpsLimiter(30), createFrameNotice(onSuggest, 12), 0);
    for (let i = 1; i <= 300; i++) clock.tick(i * 50);
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSuggest).toHaveBeenCalledWith(10);
  });

  test('without a cap every tick renders and returns its delta from the previous rendered frame', () => {
    const clock = createFrameClock(createFpsLimiter(0), createFrameNotice(() => {}, 12), 100);
    expect(clock.tick(110)).toBe(10);
    expect(clock.tick(126)).toBe(16);
    // A timestamp before the previous one (never from rAF) reads 0, not a negative delta.
    expect(clock.tick(120)).toBe(0);
  });
});

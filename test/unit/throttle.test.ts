import { describe, expect, test } from 'vitest';
import {
  THROTTLE_FAST_MS, THROTTLE_P95_MS, THROTTLE_RISE_FRAMES, THROTTLE_WINDOW, createThrottle, type Throttle,
} from '../../src/engine/throttle';

/** The user's 240 Hz panel: the thresholds stay 16.7 and 13 ms exactly. */
const HZ240 = 4.167;

function feed(t: Throttle, n: number, frameMs: number, generating = true, intervalMs = HZ240): void {
  for (let i = 0; i < n; i++) t.push(frameMs, generating, intervalMs);
}

/** A throttle of max 3 dropped to 2 by 60 frames of 20 ms with generation in flight. */
function droppedTo2(intervalMs = HZ240, slowMs = 20): Throttle {
  const t = createThrottle({ max: 3 });
  feed(t, 60, slowMs, true, intervalMs);
  expect(t.cap()).toBe(2);
  return t;
}

describe('createThrottle (SP4b spec §3.8, D29, master §4.3)', () => {
  test('the constants: a 60-frame window, p95 16.7 ms, 120 frames under 13 ms to rise', () => {
    expect([THROTTLE_WINDOW, THROTTLE_P95_MS, THROTTLE_RISE_FRAMES, THROTTLE_FAST_MS]).toEqual([60, 16.7, 120, 13]);
  });

  test('57 frames of 10 ms then 3 of 20 ms with generation in flight leave the cap 3; one more 20 ms frame drops it to 2', () => {
    const t = createThrottle({ max: 3 });
    expect(t.cap()).toBe(3);
    expect(t.max).toBe(3);
    feed(t, 57, 10);
    feed(t, 3, 20);
    expect(t.cap()).toBe(3);
    feed(t, 1, 20);
    expect(t.cap()).toBe(2);
  });

  test('60 slow frames without generation change nothing', () => {
    const t = createThrottle({ max: 3 });
    feed(t, 60, 20, false);
    expect(t.cap()).toBe(3);
  });

  test('after a drop the window restarts: 59 more slow frames keep 2, the 60th drops to 1, then it stays 1', () => {
    const t = droppedTo2();
    feed(t, 59, 20);
    expect(t.cap()).toBe(2);
    feed(t, 1, 20);
    expect(t.cap()).toBe(1);
    feed(t, 600, 40);
    expect(t.cap()).toBe(1);
  });

  test('after a drop to 2, 120 frames of 10 ms raise it to 3; 119 of 10 ms then one of 13 ms leave it 2 (13 is not under 13)', () => {
    const a = droppedTo2();
    feed(a, 119, 10);
    expect(a.cap()).toBe(2);
    feed(a, 1, 10);
    expect(a.cap()).toBe(3);
    feed(a, 240, 10);
    expect(a.cap(), 'never above max').toBe(3);

    const b = droppedTo2();
    feed(b, 119, 10);
    feed(b, 1, 13);
    expect(b.cap()).toBe(2);
  });

  test('setMax(1) clamps to 1; setMax(3) does not raise it; createThrottle({ max: 1 }) stays 1 (N = 2)', () => {
    const t = createThrottle({ max: 3 });
    t.setMax(1);
    expect(t.cap()).toBe(1);
    expect(t.max).toBe(1);
    t.setMax(3);
    expect(t.max).toBe(3);
    expect(t.cap()).toBe(1);
    t.setMax(0);
    expect(t.max, 'max(1, n)').toBe(1);

    const one = createThrottle({ max: 1 });
    expect(one.cap()).toBe(1);
    feed(one, 120, 40);
    expect(one.cap()).toBe(1);
    feed(one, 240, 5);
    expect(one.cap()).toBe(1);
  });

  test('at a 20 ms interval (50 Hz), 60 on-time frames of 20 ms with generation in flight leave the cap 3, and frames of 40 ms in a window of 60 drop it once they reach its p95', () => {
    const t = createThrottle({ max: 3 });
    feed(t, 60, 20, true, 20);
    expect(t.cap()).toBe(3);
    // The nearest-rank p95 is the 57th of 60, so 3 slow frames in the window do not reach it (as at 240 Hz), a 4th does.
    feed(t, 3, 40, true, 20);
    expect(t.cap()).toBe(3);
    feed(t, 1, 40, true, 20);
    expect(t.cap()).toBe(2);
  });

  test('at a 16.667 ms interval (60 Hz), after a drop 120 on-time frames of 16.667 ms raise it', () => {
    const t = droppedTo2(16.667, 20);
    feed(t, 119, 16.667, true, 16.667);
    expect(t.cap()).toBe(2);
    feed(t, 1, 16.667, true, 16.667);
    expect(t.cap()).toBe(3);
  });

  test('at a 4.167 ms interval (240 Hz) the thresholds are 16.7 and 13 exactly', () => {
    // Slow: a p95 of 16.7 does not drop the cap, one just above does.
    const s = createThrottle({ max: 3 });
    feed(s, 60, 16.7);
    expect(s.cap()).toBe(3);
    feed(s, 3, 16.71);
    expect(s.cap()).toBe(3);
    feed(s, 1, 16.71);
    expect(s.cap()).toBe(2);
    // Fast: 12.99 ms counts as fast, 13 does not.
    const f = droppedTo2();
    feed(f, 120, 12.99);
    expect(f.cap()).toBe(3);
  });

  test('a non-finite interval reads as 0: the thresholds are 16.7 and 13 ms (rulings R5 (a))', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      // Slow: 60 frames of 17 ms with generation in flight drop the cap.
      const s = createThrottle({ max: 3 });
      feed(s, 60, 17, true, bad);
      expect(s.cap(), `slow at interval ${bad}`).toBe(2);
      // Fast: 120 frames of 12.99 ms raise it again, 120 of 13 ms do not.
      const f = droppedTo2();
      feed(f, 120, 13, true, bad);
      expect(f.cap(), `13 ms at interval ${bad}`).toBe(2);
      feed(f, 120, 12.99, true, bad);
      expect(f.cap(), `12.99 ms at interval ${bad}`).toBe(3);
    }
  });
});

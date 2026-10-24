/**
 * The adaptive throttle (SP4b spec §3.8, D29; master §4.3): `genCap` limits the T, D and L jobs in flight, in
 * [1, max], starting at max (the coordinator passes max(1, N − 1) and re-clamps it with `setMax` whenever
 * `liveWorkers()` changes). Fed every frame's snapped frame time, whether generation is in flight and the display
 * interval: when the nearest-rank p95 of the last 60 frames is above `max(16.7 ms, interval + 0.5 ms)` while generation
 * is in flight, the cap drops by 1 and the window restarts; after 120 consecutive frames under
 * `max(13 ms, interval + 0.5 ms)` it rises by 1. The thresholds follow the display (the user's decision of 2026-10-24),
 * so a 50 Hz display's on-time 20 ms frames are not slow and a 60 Hz display's on-time 16.7 ms frames count as fast; at
 * 144-240 Hz they are 16.7 and 13 ms. A 120-value ring and a 60-value scratch, preallocated: a push allocates nothing
 * (§3.10).
 */

/** Frames in the p95 window. */
export const THROTTLE_WINDOW = 60;
/** The p95 above which, while generation is in flight, the cap drops (ms; raised to the display interval + 0.5). */
export const THROTTLE_P95_MS = 16.7;
/** Consecutive fast frames that raise the cap. */
export const THROTTLE_RISE_FRAMES = 120;
/** A frame under this is fast (ms; raised to the display interval + 0.5). */
export const THROTTLE_FAST_MS = 13;

/** The display-tied margin: a frame on time at the display's rate is neither slow nor, above 13 ms, too slow to rise. */
const INTERVAL_MARGIN_MS = 0.5;
/** The nearest-rank p95 of 60 values is the 57th smallest (ceil(0.95 · 60)). */
const P95_INDEX = Math.ceil(0.95 * THROTTLE_WINDOW) - 1;
const RING = 120;

export interface Throttle {
  /** One frame: its snapped time, whether T, D or L jobs are in flight, and the display interval (all ms). */
  push(frameMs: number, generating: boolean, intervalMs: number): void;
  /** The generation cap, in [1, max]. */
  cap(): number;
  /** Sets max to max(1, n) and clamps the cap to it (never raises the cap). */
  setMax(n: number): void;
  readonly max: number;
}

export function createThrottle(o: { max: number }): Throttle {
  let max = Math.max(1, o.max);
  let cap = max;
  const ring = new Float64Array(RING);
  const scratch = new Float64Array(THROTTLE_WINDOW);
  let head = 0; // the next ring index written
  let sinceRestart = 0; // frames pushed since the window last restarted
  let fastRun = 0; // consecutive frames under the fast threshold

  /** The nearest-rank p95 of the last 60 frames, sorted in the preallocated scratch. */
  function p95(): number {
    for (let i = 0; i < THROTTLE_WINDOW; i++) scratch[i] = ring[(head - 1 - i + RING) % RING]!;
    scratch.sort();
    return scratch[P95_INDEX]!;
  }

  return {
    push(frameMs, generating, intervalMs) {
      ring[head] = frameMs;
      head = (head + 1) % RING;
      if (sinceRestart < THROTTLE_WINDOW) sinceRestart++;
      const slowMs = Math.max(THROTTLE_P95_MS, intervalMs + INTERVAL_MARGIN_MS);
      const fastMs = Math.max(THROTTLE_FAST_MS, intervalMs + INTERVAL_MARGIN_MS);
      fastRun = frameMs < fastMs ? fastRun + 1 : 0;
      if (generating && sinceRestart >= THROTTLE_WINDOW && p95() > slowMs) {
        if (cap > 1) cap--;
        sinceRestart = 0;
        return;
      }
      if (fastRun >= THROTTLE_RISE_FRAMES) {
        if (cap < max) cap++;
        fastRun = 0;
      }
    },
    cap() { return cap; },
    setMax(n) {
      max = Math.max(1, n);
      if (cap > max) cap = max;
    },
    get max() { return max; },
  };
}

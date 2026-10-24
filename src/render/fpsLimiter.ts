import { medianInterval } from './frameTiming';

/**
 * The FPS limiter (SP4a spec §6.8, master §4.17). On each rAF tick it adds the delta Δ to an accumulator; a frame
 * renders when `acc ≥ 1000/cap − h`, h being half the display interval (the median of the last 30 rAF deltas), and then
 * `acc = clamp(acc − 1000/cap, −h, 1000/cap)`. The floor −h carries up to half an interval of deficit, so a cap that
 * does not divide the display rate still averages the cap (144 Hz at cap 60 gives 60, not 72; ruling P38); the ceiling
 * keeps a long pause (a hidden tab) from bursting frames. Cap 0 is off: every tick renders.
 */

export type FpsCap = 0 | 30 | 60 | 120 | 144;

export interface FpsLimiter {
  /** Called once per rAF with its timestamp (ms); true when this frame should render. */
  tick(now: number): boolean;
  /** Switches the cap and restarts the accumulator. */
  setCap(c: FpsCap): void;
}

/** How many recent rAF deltas give the display interval. */
const DELTA_WINDOW = 30;

export function createFpsLimiter(cap: FpsCap): FpsLimiter {
  let current: FpsCap = cap;
  // The accumulator and the previous timestamp, in a typed array: a closure variable holding a double would box it on
  // every write (SP4b spec §3.10).
  const ACC = 0;
  const PREV = 1;
  const f = Float64Array.of(0, Number.NaN);
  const deltas = new Float64Array(DELTA_WINDOW);
  // The median's sorted copy: preallocated, so a tick allocates nothing (SP4b spec §3.10).
  const scratch = new Float64Array(DELTA_WINDOW);
  let count = 0;
  let next = 0;

  return {
    tick(now) {
      const first = Number.isNaN(f[PREV]!);
      const delta = first ? 0 : now - f[PREV]!;
      f[PREV] = now;
      if (!first) {
        deltas[next] = delta;
        next = (next + 1) % DELTA_WINDOW;
        count = Math.min(count + 1, DELTA_WINDOW);
      }
      if (current === 0) return true;
      // The first tick renders: there is no delta yet to pace against.
      if (first) return true;
      const target = 1000 / current;
      const h = count === 0 ? 0 : medianInterval(deltas, scratch, count) / 2;
      const acc = f[ACC]! + delta;
      f[ACC] = acc;
      if (acc < target - h) return false;
      f[ACC] = Math.min(Math.max(acc - target, -h), target);
      return true;
    },
    setCap(c) {
      current = c;
      f[ACC] = 0;
    },
  };
}

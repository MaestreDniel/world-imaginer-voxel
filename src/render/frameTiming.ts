/**
 * Frame-time statistics of the spike and the flight route (SP4a spec §1.2, §9.5): the rAF delta snapped to the display
 * interval, nearest-rank percentiles, and the display interval itself (the median of idle rAF deltas).
 */

/** How far from a multiple of the interval a delta may be and still snap to it (spec §9.5). */
const SNAP_MS = 1;

/**
 * The frame time of a rAF delta (spec §9.5): k·interval when the delta is within ±1 ms of a multiple k ≥ 1 of the
 * display interval, so an on-time frame reads exactly one interval; otherwise the delta unchanged. The result is
 * never rounded (ruling P20: 33.0 at 16.667 gives 2 × 16.667).
 */
export function snapFrameTime(delta: number, interval: number): number {
  if (!(interval > 0) || !Number.isFinite(delta)) return delta;
  const k = Math.max(1, Math.round(delta / interval));
  const snapped = k * interval;
  return Math.abs(delta - snapped) <= SNAP_MS ? snapped : delta;
}

/** The p-th percentile (0 < p ≤ 100) by nearest rank: the ⌈p/100 · n⌉-th smallest value; NaN for no values. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(values).sort();
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(n, Math.max(1, rank)) - 1]!;
}

/** The display interval: the median of the rAF deltas (the mean of the middle two for an even count); NaN for none. */
export function medianInterval(deltas: ArrayLike<number>): number {
  const n = deltas.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(deltas).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Frame-time statistics of the spike and the flight route (SP4a spec §1.2, §9.5): the rAF delta snapped to the display
 * interval, nearest-rank percentiles, and the display interval itself (the median of idle rAF deltas; the frame step's
 * low percentile of its recent deltas, rulings R13).
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

/**
 * The p-th percentile (0 < p ≤ 100) by nearest rank of the first `n` values, sorted in a preallocated scratch (at least
 * n long; the rest of it is padded with NaN, which sorts last): the same value as `percentile` over those values, and
 * nothing allocated (SP4b spec §3.10). NaN for none. The frame step takes its display interval from it (rulings R13).
 */
export function percentileInto(values: ArrayLike<number>, p: number, scratch: Float64Array, n: number): number {
  if (n === 0) return Number.NaN;
  if (scratch.length < n || values.length < n) {
    throw new RangeError(`percentileInto: n ${n} exceeds the values (${values.length}) or the scratch (${scratch.length})`);
  }
  for (let i = 0; i < n; i++) scratch[i] = values[i]!;
  scratch.fill(Number.NaN, n);
  scratch.sort();
  const rank = Math.ceil((p / 100) * n);
  return scratch[Math.min(n, Math.max(1, rank)) - 1]!;
}

/** a sorts after b: numerically, NaN last (as a typed array's `sort`). */
const after = (a: number, b: number): boolean => a > b || (a !== a && b === b);

/**
 * The display interval: the median of the first `n` rAF deltas (the mean of the middle two for an even count); NaN for
 * none. The values are copied into `scratch[0, n)` and insertion-sorted there (30 values per frame in the FPS limiter,
 * a few hundred once elsewhere), so with a preallocated scratch nothing is allocated (SP4b spec §3.10); without one a
 * scratch of n values is made.
 */
export function medianInterval(deltas: ArrayLike<number>, scratch?: Float64Array, n = deltas.length): number {
  if (n === 0) return Number.NaN;
  const s = scratch ?? new Float64Array(n);
  if (s.length < n || deltas.length < n) {
    throw new RangeError(`medianInterval: n ${n} exceeds the deltas (${deltas.length}) or the scratch (${s.length})`);
  }
  for (let i = 0; i < n; i++) {
    const v = deltas[i]!;
    let j = i;
    while (j > 0 && after(s[j - 1]!, v)) {
      s[j] = s[j - 1]!;
      j--;
    }
    s[j] = v;
  }
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

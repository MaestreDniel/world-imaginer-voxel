/**
 * Frame-time statistics of the spike and the flight route (SP4a spec §1.2, §9.5): the rAF delta snapped to the display
 * interval, nearest-rank percentiles, and the display interval itself (the median of idle rAF deltas; the frame step's
 * median of the on-time cluster of its recent deltas, rulings R13 and R16).
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

/** The on-time cluster's upper bound as a multiple of its lower one, p10 (rulings R16): a late frame is ≥ 2 intervals. */
const ON_TIME_SPAN = 1.5;

/**
 * The display interval of the frame step (rulings R16): the median of the first `n` values that lie in [p10, 1.5·p10],
 * p10 their nearest-rank 10th percentile (the mean of the middle two for an even count). A display never delivers rAF
 * faster than its refresh, so p10 sits in the on-time frames while one frame in ten is on time (rulings R13); taking
 * the cluster's median rather than p10 itself keeps the value at the true interval under jitter (p10 reads about
 * 1.28 σ low), and frames two or more intervals late never enter the cluster. Sorted in a preallocated scratch (at
 * least n long), so nothing is allocated (SP4b spec §3.10). NaN for none.
 */
export function onTimeIntervalInto(values: ArrayLike<number>, scratch: Float64Array, n: number): number {
  if (n === 0) return Number.NaN;
  if (scratch.length < n || values.length < n) {
    throw new RangeError(`onTimeIntervalInto: n ${n} exceeds the values (${values.length}) or the scratch (${scratch.length})`);
  }
  for (let i = 0; i < n; i++) scratch[i] = values[i]!;
  scratch.fill(Number.NaN, n);
  scratch.sort();
  const lo = Math.min(n, Math.max(1, Math.ceil(0.1 * n))) - 1;
  const top = ON_TIME_SPAN * scratch[lo]!;
  let hi = lo;
  while (hi + 1 < n && scratch[hi + 1]! <= top) hi++;
  const mid = lo + hi;
  return (mid & 1) === 0 ? scratch[mid >> 1]! : (scratch[mid >> 1]! + scratch[(mid >> 1) + 1]!) / 2;
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

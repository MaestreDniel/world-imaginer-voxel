/**
 * The run-time slow-frame notice (SP4a spec §8.5, D23; ruling P49): if the first 300 frames after the reveal have a
 * snapped p95 above 25 ms, suggest the next lower render distance once (the page shows a dismissible notice linking to
 * the reload; never automatic). The next lower RD is rd − 2, so 12 → 10 → 8 follows the default ladder, never below
 * `RD_MIN`, and there is none at `RD_MIN`.
 */
import { RD_MIN } from '../../engine/renderDistance';
import { medianInterval, percentile, snapFrameTime } from '../../render/frameTiming';

/** The frames after the reveal that are judged (spec §8.5). */
export const NOTICE_FRAMES = 300;
/** The p95 above which the notice suggests a lower RD, ms (spec §8.5). */
export const NOTICE_P95_MS = 25;

/** The next lower render distance: max(RD_MIN, rd − 2) when rd > RD_MIN, else null (ruling P49). */
export function lowerRd(rd: number): number | null {
  return rd > RD_MIN ? Math.max(RD_MIN, rd - 2) : null;
}

/**
 * Collects the first 300 frame times pushed; at the 300th, snaps each to the display interval (the median of those
 * frames, spec §9.5's snapping) and calls `onSuggest(lowerRd(rd))` when their nearest-rank p95 is above 25 ms and
 * rd > RD_MIN. Frames after the 300th are ignored, so it suggests at most once.
 */
export function createFrameNotice(onSuggest: (rd: number) => void, rd: number): { push(frameMs: number): void } {
  const frames = new Float64Array(NOTICE_FRAMES);
  let n = 0;
  return {
    push(frameMs) {
      if (n >= NOTICE_FRAMES || !Number.isFinite(frameMs) || frameMs < 0) return;
      frames[n++] = frameMs;
      if (n < NOTICE_FRAMES) return;
      const lower = lowerRd(rd);
      if (lower === null) return;
      const interval = medianInterval(frames);
      const p95 = percentile(frames.map((f) => snapFrameTime(f, interval)), 95);
      if (p95 > NOTICE_P95_MS) onSuggest(lower);
    },
  };
}

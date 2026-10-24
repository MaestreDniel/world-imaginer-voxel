/**
 * The run-time slow-frame notice (SP4a spec §8.5, D23; ruling P49): if the first 300 frames after the reveal have a
 * snapped p95 above 25 ms, suggest the next lower render distance once (the page shows a dismissible notice whose
 * "Lower to RD n" applies it live on a click, SP4b spec §5; never automatic). The next lower RD is rd − 2, so
 * 12 → 10 → 8 follows the default ladder, never below `RD_MIN`, and there is none at `RD_MIN`.
 *
 * The notice judges raw rAF deltas (spec §9.5's frame times), taken before the FPS limiter: a user's FPS cap of 30
 * makes every rendered frame 33.3 ms apart, which says nothing about the GPU, while a frame too slow for the display
 * still delays the next rAF (`createFrameClock`).
 */
import { lowerRd } from '../../engine/renderDistance';
import type { FpsLimiter } from '../../render/fpsLimiter';
import { medianInterval, percentile, snapFrameTime } from '../../render/frameTiming';

/** The next lower RD (ruling P49); it lives in `engine/renderDistance.ts`, where the coordinator also reads it (SP4b). */
export { lowerRd };

/** The frames after the reveal that are judged (spec §8.5). */
export const NOTICE_FRAMES = 300;
/** The p95 above which the notice suggests a lower RD, ms (spec §8.5). */
export const NOTICE_P95_MS = 25;

/**
 * Collects the first 300 frame times pushed; at the 300th, snaps each to the display interval (the median of those
 * frames, spec §9.5's snapping) and calls `onSuggest(lowerRd(rd))` when their nearest-rank p95 is above 25 ms and
 * rd > RD_MIN. Frames after the 300th are ignored, so it suggests at most once. `rd` may be a getter of the RD in
 * force, read at the judgement: the page's live RD may change within the 300 frames (final review UI-2).
 */
export function createFrameNotice(onSuggest: (rd: number) => void, rd: number | (() => number)): { push(frameMs: number): void } {
  const frames = new Float64Array(NOTICE_FRAMES);
  let n = 0;
  return {
    push(frameMs) {
      if (n >= NOTICE_FRAMES || !Number.isFinite(frameMs) || frameMs < 0) return;
      frames[n++] = frameMs;
      if (n === NOTICE_FRAMES) judgeFrames(frames, rd, onSuggest);
    },
  };
}

/**
 * The notice's one judgement, at the 300th frame. Kept out of `push`: a closure there capturing a local would make
 * every call, the early returns included, allocate that local's context (SP4b spec §3.10).
 */
function judgeFrames(frames: Float64Array, rd: number | (() => number), onSuggest: (rd: number) => void): void {
  const lower = lowerRd(typeof rd === 'number' ? rd : rd());
  if (lower === null) return;
  const interval = medianInterval(frames);
  const p95 = percentile(frames.map((f) => snapFrameTime(f, interval)), 95);
  if (p95 > NOTICE_P95_MS) onSuggest(lower);
}

/** The frame loop's clock: one `tick` per rAF. */
export interface FrameClock {
  /**
   * Pushes the raw rAF delta (since the previous tick) to the notice, then asks the limiter; returns the delta since
   * the previous rendered frame when this tick renders, else null.
   */
  tick(now: number): number | null;
  /** The last tick's timestamp (`start` before the first): the frame step's raw delta is `now − lastTick()`. */
  lastTick(): number;
}

/**
 * Feeds `notice` every rAF delta before `limiter` decides, so the slow-frame notice sees the display's frames and
 * never the user's FPS cap; the rendered frames' deltas (the fly step, the clock, the HUD's FPS) are returned.
 * `start` is the reveal frame's timestamp.
 */
export function createFrameClock(limiter: FpsLimiter, notice: { push(frameMs: number): void }, start: number): FrameClock {
  // The last tick's and the last rendered frame's timestamps, in a typed array: TurboFan unboxes the timestamp for the
  // arithmetic, so a closure variable would box it again on every write (SP4b spec §3.10).
  const T_TICK = 0;
  const T_RENDERED = 1;
  const t = new Float64Array(2).fill(start);
  return {
    tick(now) {
      notice.push(Math.max(0, now - t[T_TICK]!));
      t[T_TICK] = now;
      if (!limiter.tick(now)) return null;
      const dt = Math.max(0, now - t[T_RENDERED]!);
      t[T_RENDERED] = now;
      return dt;
    },
    lastTick() { return t[T_TICK]!; },
  };
}

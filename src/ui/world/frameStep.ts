/**
 * The streaming frame (SP4b spec §7.2), extracted from the world page's loop so that it can be tested with fakes and
 * measured at rest (§3.10, D25). One `tick` per rAF:
 *
 * 0. The throttle (§3.8, D29): the raw rAF delta, snapped to the display interval, is pushed with that interval and
 *    whether T, D or L jobs were in flight in the previous tick's counts. The display interval is the median of the last
 *    240 raw deltas that lie in [p10, 1.5·p10], p10 their nearest-rank 10th percentile (the on-time cluster, rulings
 *    R13 and R16): a display never delivers rAF faster than its refresh, so it stays at the true interval while one
 *    frame in ten is on time (a plain median would follow sustained slow frames and switch the back-off off exactly
 *    when frames get worse), under rAF jitter (where p10 itself reads about 1.28 σ low), and 240 deltas follow a
 *    window moved to another monitor within a few seconds. It is fed on every tick, before the FPS limiter, so a cap of 30 on a 60 Hz display reads as
 *    16.7 ms frames, never as 33.3 ms ones that would hold `genCap` at 1 (SP4b plan, Review Focus 1). An interval that
 *    is not finite falls back to 1000/60 (rulings R5).
 * 1. The fly step over the raw delta (capped at 0.25 s), unless paused (the help is open, or the map owns the controls).
 * 2. `beforeUpdate` (the page's apply control, SP4c spec §4.3), `coordinator.update` from the camera, then its counts
 *    into the one reused object and `afterCounts` with them (the page's aux policy, §6.2). A fatal that `update` raises
 *    synchronously (an unload meeting `StoreCorrupt`) has the page stop the loop and dispose the coordinator, the pool
 *    and the renderer inside that call: the tick ends there (`stopped`), so nothing below runs on disposed objects.
 * (3. Results are taken in by the pool's message callbacks, between frames.)
 *
 * On the ticks the limiter renders (the rendered delta from `FrameClock`), in this order:
 * 4. `pump` under the frame's upload budget, from the last rebuild's centre and yaw (§3.9);
 * 5. the floating origin (`setOrigin` on a rebase, O(regions)) and the camera; the store's reclamation drain (§2.5);
 * 6. the eye's sky light in one read section (`lightAt` >> 4; its last value, `state.eyeSky`, for a column not
 *    Published, SP4c spec §3.4; 15 above y 319, 0 below −64), the time, the fog's RD (`fogStep`), `world.frame`
 *    (materials, translucent sort, render), then `onRendered`.
 *
 * Nothing here allocates per tick: the delta window, its scratch, the camera and the frame state are reused.
 */
import type { Coordinator, CoordinatorCounts } from '../../engine/coordinator';
import type { Throttle } from '../../engine/throttle';
import type { UploadBudget } from '../../engine/uploadBudget';
import { advanceTime } from '../../daynight/dayNight';
import { applyCameraRotation, stepFly, type FlyBounds, type FlyState } from '../../player/fly';
import type { Action } from '../../player/keymap';
import { onTimeIntervalInto, snapFrameTime } from '../../render/frameTiming';
import type { WorldRenderer } from '../../render/renderer';
import type { SectionRenderer } from '../../render/sectionRenderer';
import type { VoxelStore } from '../../world/store/store';
import type { FrameClock } from './frameNotice';

/** The longest step the fly controller takes in one tick, s: a tab back from the background does not jump. */
export const MAX_STEP_S = 0.25;
/** rAF deltas whose on-time cluster gives the display interval (rulings R13, R16): about 1 s at 240 Hz, 4 s at 60 Hz. */
const DELTA_WINDOW = 240;
/** The interval assumed while none is measured (rulings R5). */
const FALLBACK_INTERVAL_MS = 1000 / 60;
/** Only the vertical range: the world streams around the camera (SP4b spec §6.1). */
const BOUNDS: FlyBounds = { yMin: -64, yMax: 400 };

export interface FrameStepDeps {
  readonly fly: FlyState;
  held(): ReadonlySet<Action>;
  /** True while the help is open or the map owns the controls (SP4c spec §2.3): the camera does not move. */
  paused(): boolean;
  /** True once the page stopped the loop (a failure after the reveal, SP4b spec §7.4): the tick ends after `update`. */
  stopped(): boolean;
  /** `createFrameClock(limiter, notice, start)`: the rendered delta, or null on a tick the limiter skips. */
  readonly clock: FrameClock;
  readonly coordinator: Pick<Coordinator, 'update' | 'counts'>;
  /** The page's one counts object, written by `coordinator.counts` every tick. */
  readonly counts: CoordinatorCounts;
  readonly throttle: Throttle;
  readonly budget: UploadBudget;
  readonly sections: Pick<SectionRenderer, 'pump'>;
  readonly world: Pick<WorldRenderer, 'origin' | 'camera' | 'frame' | 'sections'>;
  readonly store: Pick<VoxelStore, 'enterRead' | 'exitRead' | 'lightAt' | 'drain'>;
  /**
   * The one reused FrameState (SP4b spec §3.10): `t`, `eyeSky` and `rd` are written here, `brightness` by the page; a
   * teleport resets `eyeSky` to 15 (SP4c spec §3.4).
   */
  readonly state: { t: number; brightness: number; eyeSky: number; rd: number; fogBand: number };
  /** One of `TIME_SPEEDS`, or 0 when the clock is fixed. */
  timeSpeed(): number;
  /** The fog's RD after `dtMs` (the page's easing toward the target RD, `fogEase.ts`, SP4b spec §5). */
  fogStep(dtMs: number): number;
  /** After each rendered frame, with its delta (ms). */
  onRendered(dtMs: number): void;
  /** On every tick, just before `coordinator.update`: the page's apply control (SP4c spec §4.3). */
  beforeUpdate(): void;
  /** On every tick, just after `coordinator.counts` wrote `counts` (passed): the page's aux policy (SP4c spec §6.2). */
  afterCounts(c: CoordinatorCounts): void;
}

/** The display interval the throttle is given: the measured one when finite, else 1000/60 (rulings R5). */
export function displayInterval(measuredMs: number): number {
  return Number.isFinite(measuredMs) ? measuredMs : FALLBACK_INTERVAL_MS;
}

/**
 * The sky light 0-15 at the eye (spec §6.6): 15 above y 319, 0 below −64, and `last` for a column that is not Published
 * (`lightAt`'s −1: freed by an Apply, or not yet generated), so a cave keeps its darkness while its column is rebuilt
 * (SP4c spec §3.4, D13). The frame step passes its last value (`state.eyeSky`, which a teleport resets to 15); the
 * pre-reveal frames pass 15. Call it inside a read section.
 */
export function eyeSkyLight(store: Pick<VoxelStore, 'lightAt'>, x: number, y: number, z: number, last: number): number {
  const by = Math.floor(y);
  if (by > 319) return 15;
  if (by < -64) return 0;
  const v = store.lightAt(Math.floor(x), by, Math.floor(z));
  return v < 0 ? last : v >> 4;
}

export function createFrameStep(d: FrameStepDeps): { tick(now: number): void } {
  const { fly, clock, coordinator, counts, throttle, budget, sections, world, store, state } = d;
  const deltas = new Float64Array(DELTA_WINDOW);
  const scratch = new Float64Array(DELTA_WINDOW);
  let count = 0;
  let next = 0;
  const cam = { x: fly.x, z: fly.z, yawDeg: fly.yaw };

  return {
    tick(now) {
      // 0. The throttle, every tick and before the limiter, from the previous tick's counts.
      const raw = Math.max(0, now - clock.lastTick());
      deltas[next] = raw;
      next = (next + 1) % DELTA_WINDOW;
      if (count < DELTA_WINDOW) count++;
      const interval = displayInterval(onTimeIntervalInto(deltas, scratch, count));
      const generating = counts.T.inFlight + counts.D.inFlight + counts.L.inFlight > 0;
      throttle.push(snapFrameTime(raw, interval), generating, interval);
      const dt = clock.tick(now);

      // 1-2. Motion and the coordinator on every tick, so the motion stays smooth under a cap.
      if (!d.paused()) stepFly(fly, d.held(), Math.min(raw / 1000, MAX_STEP_S), BOUNDS);
      cam.x = fly.x;
      cam.z = fly.z;
      cam.yawDeg = fly.yaw;
      d.beforeUpdate();
      coordinator.update(cam);
      // A fatal raised inside update stopped the page and released what the rest of the tick would touch.
      if (d.stopped()) return;
      coordinator.counts(counts);
      d.afterCounts(counts);
      if (dt === null) return;

      // 4. Uploads under the frame's budget, from the last rebuild's centre and yaw.
      budget.start();
      sections.pump(budget, counts.cx, counts.cz, counts.yawDeg);
      // 5. The floating origin and the camera; the reclamation drain.
      const origin = world.origin;
      if (origin.update(fly.x, fly.y, fly.z)) world.sections.setOrigin(origin.x, origin.y, origin.z);
      world.camera.position.set(fly.x - origin.x, fly.y - origin.y, fly.z - origin.z);
      applyCameraRotation(world.camera, fly);
      store.drain();
      // 6. The eye's light in one read section, the time, the fog, the render.
      store.enterRead();
      try {
        state.eyeSky = eyeSkyLight(store, fly.x, fly.y, fly.z, state.eyeSky);
      } finally {
        store.exitRead();
      }
      state.t = advanceTime(state.t, dt, d.timeSpeed());
      state.rd = d.fogStep(dt);
      world.frame(state);
      d.onRendered(dt);
    },
  };
}

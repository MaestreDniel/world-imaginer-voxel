/**
 * The teleport from the map (SP4c spec §3, D12-D14): a plain click in the world's map asks the pool's `landing` job at
 * the clicked block, then moves the camera there, about 24 blocks above the real 3D surface or the water.
 *
 * - **The block.** x and z are clamped to ±500,000 (`AT_LIMIT`, master §2.1); the landing is asked at (⌊x⌋, ⌊z⌋),
 *   since `surfaceEst3` takes integer positions and the message guard refuses anything else; the camera goes to the
 *   block's centre, (⌊x⌋ + 0.5, ⌊z⌋ + 0.5).
 * - **The height** (§3.2): `landingY(surface, water)` = min(400, max(surface, water) + 24), where `surface` is the
 *   worker's `landingSurface` (max(⌊surfaceEst⌋, `surfaceEst3`) under a `terrain` tap, the default tree included) and
 *   `water` its `surfaceWaterLevel` (−∞ off the water). Over the sea 87; over plains near 64 about 90.
 * - **Retries.** A `JobCancelled` (a configure moved the generation) is retried up to `LANDING_RETRIES` times; any other
 *   rejection, or a fourth cancel, calls `onFail` (the page's "Could not teleport") and moves nothing.
 * - **The move** (§3.3): x, z and y set, the velocity zeroed, yaw, pitch and speed kept, the eye light reset to 15
 *   (§3.4, open sky above the surface), then `onArrive`. The next tick's `coordinator.update` does the long crossing
 *   (SP4b §3.4); nothing else is told.
 * - **Walking** (SP5a spec §3.4, D15): while `walk.active()`, the feet arrive at max(surface, water) + 1 instead
 *   (`walkFeetY`) and the camera's y is that plus `EYE`: `walk.arrive` sets both feet with the velocity zeroed and the
 *   snap pending, which the walk tick completes on the column's ground once it is Published. Flight's rule is
 *   unchanged.
 * - **The latest click wins (plan; Review Focus 5).** In mode B the map stays open and the user may click again before
 *   the first landing answered; landings run on different workers and can resolve out of order. A `go` superseded by a
 *   later one before its landing settled resolves false and calls neither `onArrive` nor `onFail`, and is not retried.
 * - **Disposed** (Task 20b, the page's teardown): a `go` pending then, or called later, resolves false the same way.
 * - **A saved place** (SP5b spec §3.7, D13): `toPlace` asks no landing. It sets x, y, z, yaw and pitch exactly, the
 *   velocity zeroed, the speed and the mode kept; walking, both feet at y − `EYE` through `walk.setFeet` with no snap
 *   (`walk.arrive`'s snap would move the feet to the column's motionBlocking top: a place in a cave, under a roof or in
 *   a building would land on top), and the walk tick's unstuck (SP5a D29) lifts the body out of a block that is now
 *   there; over a column not Published the walk's unloaded rule hovers (SP5a D15). The eye light keeps its value (a
 *   place may be under a roof), which the frame step reads at the place once its column is Published. A `go` still
 *   landing is superseded, as by a later `go`.
 * - **The landing for a map point** (`landAt`): the clamp, the block and the retries above, shared with "+ Add at the
 *   pin" (the place dialog for the pin's column, D13).
 */
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import type { Place } from '../../persist/saves';
import type { FlyState } from '../../player/fly';
import { EYE } from '../../player/walk';
import { AT_LIMIT } from './query';

/** Blocks above the surface or the water the camera arrives at (SP4c spec §3.2, D12). */
export const LANDING_ABOVE = 24;
/** The arrival's highest y: the fly bounds' top (SP4b spec §6.1). */
export const LANDING_MAX_Y = 400;
/** How many times a landing cancelled by a configure is asked again before the teleport gives up. */
export const LANDING_RETRIES = 3;
/** A landing that failed (D26): in `.world-notices`, or in the tool's row while the map covers the 3D (D27). */
export const TELEPORT_FAILED_NOTICE = 'Could not teleport';
export const TELEPORT_FAILED_MS = 4000;

/** The camera's arrival y over a landing (SP4c spec §3.2): min(400, max(surface, water) + 24). */
export function landingY(surface: number, water: number): number {
  return Math.min(LANDING_MAX_Y, Math.max(surface, water) + LANDING_ABOVE);
}

/** A walking teleport's feet y over a landing (SP5a spec §3.4): max(surface, water) + 1. */
export function walkFeetY(surface: number, water: number): number {
  return Math.max(surface, water) + 1;
}

export interface TeleportLanding {
  readonly surface: number;
  readonly water: number;
  /** The camera's y: `landingY(surface, water)` flying; `walkFeetY(surface, water) + EYE` walking. */
  readonly y: number;
}

export interface TeleportOptions {
  readonly pool: Pick<WorkerPool, 'landing'>;
  /** The camera, moved in place on arrival. */
  readonly fly: FlyState;
  /** The frame step's state: `eyeSky` is reset to 15 on arrival (SP4c spec §3.4). */
  readonly state: { eyeSky: number };
  /**
   * The walk (SP5a spec §3.4): while `active()`, the arrival calls `arrive` with the feet (the block's centre,
   * `walkFeetY`), which sets both feet with the snap pending (`arriveFeet`); a place calls `setFeet` (both feet, no
   * snap: `setFeet` in `player/walk.ts`). Absent (the bench), every teleport flies.
   */
  readonly walk?: {
    active(): boolean;
    arrive(x: number, feetY: number, z: number): void;
    setFeet(x: number, feetY: number, z: number): void;
  };
  /** After the camera moved: its x and z (the block's centre) and the landing it arrived over. */
  onArrive(x: number, z: number, landing: TeleportLanding): void;
  /**
   * A landing that failed (a worker failure, or a fourth cancel): nothing moved. `cause` is the landing's rejection
   * (the bench keeps it in its JSON, final review WLD-5).
   */
  onFail(cause: unknown): void;
}

export interface Teleport {
  /** Teleports to (x, z): true once the camera moved there; false when it failed or a later `go` superseded it. */
  go(x: number, z: number): Promise<boolean>;
  /** Moves the camera to the place's exact pose at once (see the module comment); nothing after `dispose`. */
  toPlace(p: Place): void;
  /** Every pending `go` settles silently (false, nothing moved, neither callback); a later `go` asks nothing. */
  dispose(): void;
}

const clampAt = (v: number): number => Math.min(AT_LIMIT, Math.max(-AT_LIMIT, v));

/** A map point's landing: the block's centre (x, z) and the worker's surface and water there. */
export interface PointLanding {
  readonly x: number;
  readonly z: number;
  readonly surface: number;
  readonly water: number;
}

/**
 * The landing at the map point (x, z) (SP4c spec §3.2): x and z clamped to ±`AT_LIMIT`, asked at the block
 * (⌊x⌋, ⌊z⌋), a `JobCancelled` asked again up to `LANDING_RETRIES` times while `stop()` is false. Rejects with the
 * landing's last failure (a cancel seen after `stop()` turned true included).
 */
export async function landAt(
  pool: Pick<WorkerPool, 'landing'>, x: number, z: number, stop: () => boolean = () => false,
): Promise<PointLanding> {
  const bx = Math.floor(clampAt(x));
  const bz = Math.floor(clampAt(z));
  for (let attempt = 0; ; attempt++) {
    try {
      const l = await pool.landing(bx, bz);
      return { x: bx + 0.5, z: bz + 0.5, surface: l.surface, water: l.water };
    } catch (e) {
      if (stop() || !(e instanceof JobCancelled) || attempt >= LANDING_RETRIES) throw e;
    }
  }
}

export function createTeleport(o: TeleportOptions): Teleport {
  const { pool, fly, state } = o;
  // The latest `go`'s number: a landing that settles for an older one is dropped.
  let latest = 0;
  let disposed = false;
  // Superseded by a later `go`, or the teleport disposed.
  const dropped = (mine: number): boolean => disposed || mine !== latest;

  return {
    async go(x, z) {
      if (disposed) return false;
      const mine = ++latest;
      let landing: PointLanding;
      try {
        landing = await landAt(pool, x, z, () => dropped(mine));
      } catch (e) {
        if (dropped(mine)) return false;
        o.onFail(e);
        return false;
      }
      if (dropped(mine)) return false;
      const walk = o.walk !== undefined && o.walk.active() ? o.walk : null;
      const feetY = walkFeetY(landing.surface, landing.water);
      const y = walk !== null ? feetY + EYE : landingY(landing.surface, landing.water);
      fly.x = landing.x;
      fly.z = landing.z;
      fly.y = y;
      fly.vx = 0;
      fly.vy = 0;
      fly.vz = 0;
      if (walk !== null) walk.arrive(fly.x, feetY, fly.z);
      state.eyeSky = 15;
      o.onArrive(fly.x, fly.z, { surface: landing.surface, water: landing.water, y });
      return true;
    },
    toPlace(p) {
      if (disposed) return;
      // A landing still pending for an earlier `go` is dropped: the latest teleport wins.
      latest++;
      fly.x = p.x;
      fly.y = p.y;
      fly.z = p.z;
      fly.yaw = p.yaw;
      fly.pitch = p.pitch;
      fly.vx = 0;
      fly.vy = 0;
      fly.vz = 0;
      if (o.walk !== undefined && o.walk.active()) o.walk.setFeet(p.x, p.y - EYE, p.z);
    },
    dispose() {
      disposed = true;
    },
  };
}

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
 * - **The latest click wins (plan; Review Focus 5).** In mode B the map stays open and the user may click again before
 *   the first landing answered; landings run on different workers and can resolve out of order. A `go` superseded by a
 *   later one before its landing settled resolves false and calls neither `onArrive` nor `onFail`, and is not retried.
 * - **Disposed** (Task 20b, the page's teardown): a `go` pending then, or called later, resolves false the same way.
 */
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import type { FlyState } from '../../player/fly';
import { AT_LIMIT } from './query';

/** Blocks above the surface or the water the camera arrives at (SP4c spec §3.2, D12). */
export const LANDING_ABOVE = 24;
/** The arrival's highest y: the fly bounds' top (SP4b spec §6.1). */
export const LANDING_MAX_Y = 400;
/** How many times a landing cancelled by a configure is asked again before the teleport gives up. */
export const LANDING_RETRIES = 3;

/** The camera's arrival y over a landing (SP4c spec §3.2): min(400, max(surface, water) + 24). */
export function landingY(surface: number, water: number): number {
  return Math.min(LANDING_MAX_Y, Math.max(surface, water) + LANDING_ABOVE);
}

export interface TeleportLanding {
  readonly surface: number;
  readonly water: number;
  /** The camera's y: `landingY(surface, water)`. */
  readonly y: number;
}

export interface TeleportOptions {
  readonly pool: Pick<WorkerPool, 'landing'>;
  /** The camera, moved in place on arrival. */
  readonly fly: FlyState;
  /** The frame step's state: `eyeSky` is reset to 15 on arrival (SP4c spec §3.4). */
  readonly state: { eyeSky: number };
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
  /** Every pending `go` settles silently (false, nothing moved, neither callback); a later `go` asks nothing. */
  dispose(): void;
}

const clampAt = (v: number): number => Math.min(AT_LIMIT, Math.max(-AT_LIMIT, v));

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
      const bx = Math.floor(clampAt(x));
      const bz = Math.floor(clampAt(z));
      let landing: { readonly surface: number; readonly water: number } | null = null;
      for (let attempt = 0; landing === null; attempt++) {
        try {
          landing = await pool.landing(bx, bz);
        } catch (e) {
          if (dropped(mine)) return false;
          if (e instanceof JobCancelled && attempt < LANDING_RETRIES) continue;
          o.onFail(e);
          return false;
        }
      }
      if (dropped(mine)) return false;
      const y = landingY(landing.surface, landing.water);
      fly.x = bx + 0.5;
      fly.z = bz + 0.5;
      fly.y = y;
      fly.vx = 0;
      fly.vy = 0;
      fly.vz = 0;
      state.eyeSky = 15;
      o.onArrive(fly.x, fly.z, { surface: landing.surface, water: landing.water, y });
      return true;
    },
    dispose() {
      disposed = true;
    },
  };
}

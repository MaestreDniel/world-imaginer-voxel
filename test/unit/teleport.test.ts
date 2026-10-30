import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { JobCancelled, WorkerFailed } from '../../src/engine/workerPool';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { findSpawn, landingSurface } from '../../src/gen/column/spawn';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { SPEED_DEFAULT, type FlyState } from '../../src/player/fly';
import type { Place } from '../../src/persist/saves';
import { EYE, arriveFeet, createWalkState, setFeet, walkTick, type WalkReader } from '../../src/player/walk';
import { createTeleport, LANDING_ABOVE, LANDING_MAX_Y, LANDING_RETRIES, landingY } from '../../src/ui/world/teleport';
import { AIR, STONE } from '../../src/world/blocks/index';
import { ctxFor } from '../harness/gen';

type Landing = { readonly surface: number; readonly water: number };
type Arrival = [x: number, z: number, landing: { readonly surface: number; readonly water: number; readonly y: number }];

/**
 * A fake pool around the real `landingSurface` and `columnPoint` (the worker's answer, Task 7): a non-integer position
 * is refused as the message guard refuses it (BAD_MESSAGE), and every call is recorded.
 */
function fakePool(ctx: GenContext) {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    landing(x: number, z: number): Promise<Landing> {
      calls.push([x, z]);
      if (!Number.isInteger(x) || !Number.isInteger(z)) return Promise.reject(new Error('BAD_MESSAGE: malformed message'));
      return Promise.resolve({ surface: landingSurface(ctx, x, z), water: columnPoint(ctx, x, z).surfaceWaterLevel });
    },
  };
}

function camera(): FlyState {
  return { x: 10.25, y: 120, z: -7.75, yaw: 123, pitch: -31, vx: 3, vy: -2, vz: 1.5, speed: SPEED_DEFAULT * 2, mode: 'fly' };
}

/** A teleport over `pool` with a fresh camera and eye light 4; its arrivals and failures recorded. */
function rig(pool: { landing(x: number, z: number): Promise<Landing> }) {
  const fly = camera();
  const state = { eyeSky: 4 };
  const arrivals: Arrival[] = [];
  let fails = 0;
  const causes: unknown[] = [];
  const tp = createTeleport({
    pool,
    fly,
    state,
    onArrive: (x, z, landing) => { arrivals.push([x, z, { ...landing }]); },
    onFail: (cause) => {
      fails++;
      causes.push(cause);
    },
  });
  return { tp, fly, state, arrivals, fails: () => fails, causes };
}

/** A pool whose landings each wait for the test to settle them. */
function deferredPool() {
  const pending: Array<{ x: number; z: number; resolve(l: Landing): void; reject(e: unknown): void }> = [];
  return {
    pending,
    landing(x: number, z: number): Promise<Landing> {
      return new Promise<Landing>((resolve, reject) => { pending.push({ x, z, resolve, reject }); });
    },
  };
}

/** A pool that answers each call with the next scripted outcome: an Error rejects, a Landing resolves. */
function scriptedPool(script: Array<Landing | Error>) {
  let n = 0;
  return {
    get calls() { return n; },
    landing(): Promise<Landing> {
      const next = script[n++];
      if (next === undefined) throw new Error('the script ran out');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

describe('landingY (SP4c spec §3.2, D12)', () => {
  test('the constants: 24 above, at most 400, 3 retries', () => {
    expect([LANDING_ABOVE, LANDING_MAX_Y, LANDING_RETRIES]).toEqual([24, 400, 3]);
  });

  test('landingY(64, −∞) is 88; landingY(40, 63) is 87 (over the sea); landingY(330, −∞) is 354; landingY(380, −∞) is 400 (404 clamped; surfaceEst3 caps at 319, so only a synthetic value reaches the clamp)', () => {
    expect(landingY(64, -Infinity)).toBe(88);
    expect(landingY(40, 63)).toBe(87);
    expect(landingY(330, -Infinity)).toBe(354);
    expect(landingY(380, -Infinity)).toBe(400);
  });
});

describe('createTeleport (SP4c spec §3.2, §3.3, D12)', () => {
  /** Seed 42's jagged default-profile column (Task 7's `JAGGED`, `spawn.test.ts`): ⌊surfaceEst⌋ 142, surfaceEst3 169. */
  const JAGGED = { x: -320, z: 128 } as const;

  test('on Task 7\'s jagged default-profile column, the camera is 24 above `surfaceEst3` (not only above ⌊surfaceEst⌋)', async () => {
    const ctx = ctxFor('42');
    const flat = Math.floor(columnPoint(ctx, JAGGED.x, JAGGED.z).surfaceEst);
    const est3 = surfaceEst3(createDensityContext(ctx), JAGGED.x, JAGGED.z);
    expect([flat, est3]).toEqual([142, 169]);
    const r = rig(fakePool(ctx));
    // A click inside the block lands at its centre.
    await expect(r.tp.go(JAGGED.x + 0.3, JAGGED.z + 0.9)).resolves.toBe(true);
    expect(r.fly.y).toBe(est3 + 24);
    expect(r.fly.y).toBeGreaterThan(flat + 24);
    expect([r.fly.x, r.fly.z]).toEqual([JAGGED.x + 0.5, JAGGED.z + 0.5]);
  });

  test('under amplified, 24 above `surfaceEst3`', async () => {
    // Seed 7's spawn: the 2D estimate lies far inside the amplified ground there (`spawn.test.ts`).
    const ctx = createGenContext(seedFromInput('7'), resolveProfile('amplified'));
    const sp = findSpawn(ctx);
    const flat = Math.floor(columnPoint(ctx, sp.x, sp.z).surfaceEst);
    const est3 = surfaceEst3(createDensityContext(ctx), sp.x, sp.z);
    expect(est3 - flat).toBeGreaterThan(20);
    expect(columnPoint(ctx, sp.x, sp.z).surfaceWaterLevel).toBeLessThan(est3);
    const r = rig(fakePool(ctx));
    await expect(r.tp.go(sp.x, sp.z)).resolves.toBe(true);
    expect(r.fly.y).toBe(est3 + 24);
  });

  test('x 600,000 and z −600,000 clamp to ±500,000; the landing is asked at the integer block, the camera placed at its centre', async () => {
    const pool = fakePool(ctxFor('42'));
    const r = rig(pool);
    await expect(r.tp.go(600_000, -600_000)).resolves.toBe(true);
    expect(pool.calls).toEqual([[500_000, -500_000]]);
    expect([r.fly.x, r.fly.z]).toEqual([500_000.5, -499_999.5]);
    // A fractional click asks the floored block (the guard refuses non-integers) and goes to its centre.
    await expect(r.tp.go(-12.25, 7.75)).resolves.toBe(true);
    expect(pool.calls[1]).toEqual([-13, 7]);
    expect([r.fly.x, r.fly.z]).toEqual([-12.5, 7.5]);
    expect(r.fails()).toBe(0);
  });

  test('yaw, pitch and speed kept, velocity zeroed, `eyeSky` 15; onArrive gets the camera and the landing', async () => {
    const r = rig(scriptedPool([{ surface: 64, water: -Infinity }]));
    const before = { ...r.fly };
    await expect(r.tp.go(100.5, 200.5)).resolves.toBe(true);
    expect(r.fly).toEqual({ ...before, x: 100.5, y: 88, z: 200.5, vx: 0, vy: 0, vz: 0 });
    expect([r.fly.yaw, r.fly.pitch, r.fly.speed]).toEqual([123, -31, SPEED_DEFAULT * 2]);
    expect(r.state.eyeSky).toBe(15);
    expect(r.arrivals).toEqual([[100.5, 200.5, { surface: 64, water: -Infinity, y: 88 }]]);
  });

  test('two JobCancelled then success lands; four cancels or one WorkerFailed call `onFail` and move nothing', async () => {
    const lands = scriptedPool([new JobCancelled(), new JobCancelled(), { surface: 40, water: 63 }]);
    const a = rig(lands);
    await expect(a.tp.go(1, 2)).resolves.toBe(true);
    expect(lands.calls).toBe(3);
    expect([a.fly.x, a.fly.y, a.fly.z, a.fails(), a.arrivals.length]).toEqual([1.5, 87, 2.5, 0, 1]);

    const cancels = scriptedPool([new JobCancelled(), new JobCancelled(), new JobCancelled(), new JobCancelled()]);
    const b = rig(cancels);
    await expect(b.tp.go(1, 2)).resolves.toBe(false);
    expect(cancels.calls).toBe(1 + LANDING_RETRIES);
    expect(b.fly).toEqual(camera());
    expect([b.state.eyeSky, b.fails(), b.arrivals.length]).toEqual([4, 1, 0]);

    const failed = scriptedPool([new WorkerFailed('boom')]);
    const c = rig(failed);
    await expect(c.tp.go(1, 2)).resolves.toBe(false);
    expect(failed.calls).toBe(1);
    expect(c.fly).toEqual(camera());
    expect([c.state.eyeSky, c.fails(), c.arrivals.length]).toEqual([4, 1, 0]);
  });

  test('`onFail` gets the landing\'s failure: the WorkerFailed, or the fourth JobCancelled (final review WLD-5)', async () => {
    const boom = new WorkerFailed('boom');
    const c = rig(scriptedPool([boom]));
    await c.tp.go(1, 2);
    expect(c.causes).toEqual([boom]);
    const last = new JobCancelled();
    const b = rig(scriptedPool([new JobCancelled(), new JobCancelled(), new JobCancelled(), last]));
    await b.tp.go(1, 2);
    expect(b.causes).toHaveLength(1);
    expect(b.causes[0]).toBe(last);
  });

  test('Review Focus 5 (second click): two `go` calls whose landings resolve in reverse order: the camera ends at the second, and the first resolves false calling neither `onArrive` nor `onFail`', async () => {
    const pool = deferredPool();
    const r = rig(pool);
    const first = r.tp.go(10, 10);
    const second = r.tp.go(-50, 70);
    expect(pool.pending.map((p) => [p.x, p.z])).toEqual([[10, 10], [-50, 70]]);
    pool.pending[1]!.resolve({ surface: 70, water: -Infinity });
    await expect(second).resolves.toBe(true);
    pool.pending[0]!.resolve({ surface: 200, water: -Infinity });
    await expect(first).resolves.toBe(false);
    expect([r.fly.x, r.fly.y, r.fly.z]).toEqual([-49.5, 94, 70.5]);
    expect(r.arrivals).toEqual([[-49.5, 70.5, { surface: 70, water: -Infinity, y: 94 }]]);
    expect(r.fails()).toBe(0);
  });

  test('a superseded `go` whose landing fails, or is cancelled, neither fails nor retries', async () => {
    const pool = deferredPool();
    const r = rig(pool);
    const first = r.tp.go(10, 10);
    const second = r.tp.go(20, 20);
    pool.pending[0]!.reject(new JobCancelled());
    await expect(first).resolves.toBe(false);
    // No retry was asked for the superseded click.
    expect(pool.pending.length).toBe(2);
    const third = r.tp.go(30, 30);
    pool.pending[1]!.reject(new WorkerFailed('boom'));
    await expect(second).resolves.toBe(false);
    expect([r.fails(), r.arrivals.length]).toEqual([0, 0]);
    expect(r.fly).toEqual(camera());
    pool.pending[2]!.resolve({ surface: 64, water: -Infinity });
    await expect(third).resolves.toBe(true);
    expect([r.fly.x, r.fly.z, r.arrivals.length]).toEqual([30.5, 30.5, 1]);
  });

  test('Task 20b: after `dispose`, a pending landing that resolves or fails settles silently (false, no move, neither callback), and a later `go` asks nothing', async () => {
    const pool = deferredPool();
    const r = rig(pool);
    const resolved = r.tp.go(10, 10);
    const failed = r.tp.go(20, 20);
    const cancelled = r.tp.go(30, 30);
    r.tp.dispose();
    pool.pending[2]!.reject(new JobCancelled());
    await expect(cancelled).resolves.toBe(false);
    // A cancel after dispose is not retried.
    expect(pool.pending.length).toBe(3);
    pool.pending[1]!.reject(new WorkerFailed('boom'));
    await expect(failed).resolves.toBe(false);
    pool.pending[0]!.resolve({ surface: 64, water: -Infinity });
    await expect(resolved).resolves.toBe(false);
    await expect(r.tp.go(40, 40)).resolves.toBe(false);
    expect(pool.pending.length).toBe(3);
    expect(r.fly).toEqual(camera());
    expect([r.state.eyeSky, r.fails(), r.arrivals.length]).toEqual([4, 0, 0]);
  });

  test('Task 20b: the latest `go` pending at `dispose` (superseded by nothing) neither moves nor calls back, whether its landing resolves or fails', async () => {
    for (const outcome of ['resolve', 'fail'] as const) {
      const pool = deferredPool();
      const r = rig(pool);
      const only = r.tp.go(10, 10);
      r.tp.dispose();
      r.tp.dispose();
      if (outcome === 'resolve') pool.pending[0]!.resolve({ surface: 64, water: -Infinity });
      else pool.pending[0]!.reject(new WorkerFailed('boom'));
      await expect(only, outcome).resolves.toBe(false);
      expect(r.fly, outcome).toEqual(camera());
      expect([r.state.eyeSky, r.fails(), r.arrivals.length], outcome).toEqual([4, 0, 0]);
    }
  });
});

describe('the walking teleport (SP5a spec §3.4, D15)', () => {
  /** A teleport over `pool` with the camera walking (or flying) and a walk body in motion, wired as the page wires it. */
  function walkRig(pool: { landing(x: number, z: number): Promise<Landing> }, mode: 'walk' | 'fly' = 'walk') {
    const fly: FlyState = { ...camera(), mode };
    const walk = createWalkState();
    walk.px = walk.x = 3.5;
    walk.py = walk.y = 80;
    walk.pz = walk.z = -2.5;
    walk.vx = 0.2;
    walk.vy = -0.3;
    walk.vz = 0.1;
    walk.acc = 0.02;
    walk.onGround = true;
    const state = { eyeSky: 4 };
    const arrivals: Arrival[] = [];
    const tp = createTeleport({
      pool,
      fly,
      state,
      walk: {
        active: () => fly.mode === 'walk',
        arrive: (x, feetY, z) => arriveFeet(walk, x, feetY, z),
        setFeet: (x, feetY, z) => setFeet(walk, x, feetY, z),
      },
      onArrive: (x, z, landing) => { arrivals.push([x, z, { ...landing }]); },
      onFail: () => { throw new Error('no landing fails here'); },
    });
    return { tp, fly, walk, state, arrivals };
  }

  // The rig is shared with the place teleport below.
  test('walking teleport over land (surface 70, water −∞): feet 71, look kept, `snapPending`', async () => {
    const r = walkRig(scriptedPool([{ surface: 70, water: -Infinity }]));
    await expect(r.tp.go(100.25, 200.75)).resolves.toBe(true);
    // Both feet set at the block's centre, no interpolation, the velocity and the accumulator zeroed.
    expect([r.walk.px, r.walk.py, r.walk.pz, r.walk.x, r.walk.y, r.walk.z]).toEqual([100.5, 71, 200.5, 100.5, 71, 200.5]);
    expect([r.walk.vx, r.walk.vy, r.walk.vz, r.walk.acc, r.walk.onGround]).toEqual([0, 0, 0, 0, false]);
    expect(r.walk.snapPending).toBe(true);
    // The look and the speed kept; the camera's y is the eye above the feet.
    expect([r.fly.yaw, r.fly.pitch, r.fly.speed, r.fly.mode]).toEqual([123, -31, SPEED_DEFAULT * 2, 'walk']);
    expect([r.fly.x, r.fly.y, r.fly.z, r.fly.vx, r.fly.vy, r.fly.vz]).toEqual([100.5, 71 + EYE, 200.5, 0, 0, 0]);
    expect(r.state.eyeSky).toBe(15);
    expect(r.arrivals).toEqual([[100.5, 200.5, { surface: 70, water: -Infinity, y: 71 + EYE }]]);
  });

  test('over the sea (surface 40, water 62): feet 63', async () => {
    const r = walkRig(scriptedPool([{ surface: 40, water: 62 }]));
    await expect(r.tp.go(-7, 9)).resolves.toBe(true);
    expect([r.walk.x, r.walk.y, r.walk.z, r.walk.snapPending]).toEqual([-6.5, 63, 9.5, true]);
    expect(r.fly.y).toBe(63 + EYE);
  });

  test('flying with the walk wired: flight\'s landing unchanged (`landingY`) and the walk body untouched', async () => {
    const r = walkRig(scriptedPool([{ surface: 70, water: -Infinity }, { surface: 40, water: 62 }]), 'fly');
    const before = { ...r.walk };
    await expect(r.tp.go(100.25, 200.75)).resolves.toBe(true);
    expect([r.fly.x, r.fly.y, r.fly.z]).toEqual([100.5, landingY(70, -Infinity), 200.5]);
    await expect(r.tp.go(-7, 9)).resolves.toBe(true);
    expect(r.fly.y).toBe(landingY(40, 62));
    expect(r.fly.y).toBe(86);
    expect(r.walk).toEqual(before);
    expect(r.arrivals.map((a) => a[2].y)).toEqual([94, 86]);
  });

  /**
   * A world for the place teleport's walk ticks: stone below y 65 (the ground's top at 65), a stone roof at y 68, and
   * the voxels `extra` sets; every column Published but those at x ≥ `unpublishedFromX`.
   */
  function roofed(extra: ReadonlyArray<readonly [number, number, number]> = [], unpublishedFromX = Infinity): WalkReader {
    const solid = (x: number, y: number, z: number): boolean => y < 65 || y === 68 || extra.some(([ex, ey, ez]) => ex === x && ey === y && ez === z);
    const r: WalkReader = {
      blockAt: (x, y, z) => (x >= unpublishedFromX ? -1 : solid(x, y, z) ? STONE : AIR),
      fluidAt: () => 0,
      publishedAt: (x) => x < unpublishedFromX,
      // `MOTION_BLOCKING`: y + 1 of the highest voxel holding a block, null unpublished.
      heightAt: (_kind, x, z) => {
        if (x >= unpublishedFromX) return null;
        for (let y = 200; y >= -64; y--) if (r.blockAt(x, y, z) !== AIR) return y + 1;
        return -64;
      },
    };
    return r;
  }
  const place: Place = { id: 'p1', name: 'Cellar', colour: 2, x: 12.25, y: 65 + EYE, z: -30.75, yaw: 210.5, pitch: -14.25 };

  test('`toPlace` flying sets the exact pose; walking puts the feet at y − 1.62 and lifts out of a block now there', async () => {
    // Flying: x, y, z, yaw and pitch exactly the place's, the velocity zeroed, the speed and the mode kept; no landing is
    // asked, the walk body is untouched and the eye light keeps its last value (the frame step reads it there).
    const pool = deferredPool();
    const f = walkRig(pool, 'fly');
    const before = { ...f.walk };
    // A map click still landing is superseded by the place (the latest teleport wins, Review Focus 5).
    const pending = f.tp.go(500, 500);
    f.tp.toPlace(place);
    expect([f.fly.x, f.fly.y, f.fly.z, f.fly.yaw, f.fly.pitch]).toEqual([12.25, 65 + EYE, -30.75, 210.5, -14.25]);
    expect([f.fly.vx, f.fly.vy, f.fly.vz, f.fly.speed, f.fly.mode]).toEqual([0, 0, 0, SPEED_DEFAULT * 2, 'fly']);
    expect(f.walk).toEqual(before);
    expect(f.state.eyeSky).toBe(4);
    pool.pending[0]!.resolve({ surface: 70, water: -Infinity });
    await expect(pending).resolves.toBe(false);
    expect([f.fly.x, f.fly.y, f.fly.z]).toEqual([12.25, 65 + EYE, -30.75]);
    expect(f.arrivals).toEqual([]);

    // Walking: the camera at the exact pose, both feet at y − EYE with no snap pending (`setFeet`, never `arriveFeet`).
    const w = walkRig(scriptedPool([]));
    w.tp.toPlace(place);
    expect([w.fly.x, w.fly.y, w.fly.z, w.fly.yaw, w.fly.pitch, w.fly.vx, w.fly.vy, w.fly.vz]).toEqual([12.25, 65 + EYE, -30.75, 210.5, -14.25, 0, 0, 0]);
    expect([w.walk.px, w.walk.py, w.walk.pz, w.walk.x, w.walk.y, w.walk.z]).toEqual([12.25, place.y - EYE, -30.75, 12.25, place.y - EYE, -30.75]);
    expect([w.walk.vx, w.walk.vy, w.walk.vz, w.walk.acc, w.walk.snapPending]).toEqual([0, 0, 0, 0, false]);
    expect(w.fly.mode).toBe('walk');
    // A block placed since where the body stands: the next walk tick lifts the feet out of it (SP5a D29).
    walkTick(w.walk, roofed([[12, 65, -31]]), 0, 0, false, false, false);
    expect(w.walk.y).toBe(66);
    expect(w.walk.vy).toBeLessThan(0);

    // Over a column not Published yet, the walk's unloaded rule hovers (SP5a D15): the feet stay where the place put them.
    const u = walkRig(scriptedPool([]));
    u.tp.toPlace(place);
    walkTick(u.walk, roofed([], 0), 0, 0, false, false, false);
    expect([u.walk.y, u.walk.vy]).toEqual([place.y - EYE, 0]);
  });

  test('walking `toPlace` under a roof: after one `walkTick` over the Published column the feet stay at y − 1.62', () => {
    const w = walkRig(scriptedPool([]));
    w.tp.toPlace(place);
    const r = roofed();
    // The column's motionBlocking top is the roof's (69): a teleport's snap would put the feet on the roof.
    expect(r.heightAt('motionBlocking', 12, -31)).toBe(69);
    walkTick(w.walk, r, 0, 0, false, false, false);
    expect(w.walk.y).toBe(place.y - EYE);
    expect(w.walk.y).toBeCloseTo(65, 12);
    expect(w.walk.snapPending).toBe(false);
    // Twenty ticks later, still standing there, on the floor under the roof.
    for (let i = 0; i < 20; i++) walkTick(w.walk, r, 0, 0, false, false, false);
    expect(w.walk.y).toBe(place.y - EYE);
    expect(w.walk.onGround).toBe(true);
  });
});

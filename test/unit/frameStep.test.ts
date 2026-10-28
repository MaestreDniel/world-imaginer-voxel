import { PerspectiveCamera } from 'three';
import { describe, expect, test } from 'vitest';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { createCoordinatorCounts, type CoordinatorCounts } from '../../src/engine/coordinator';
import { createThrottle, type Throttle } from '../../src/engine/throttle';
import { createUploadBudget } from '../../src/engine/uploadBudget';
import { SPEED_DEFAULT, type FlyState } from '../../src/player/fly';
import type { Action } from '../../src/player/keymap';
import { createFloatingOrigin } from '../../src/render/floatingOrigin';
import { createFpsLimiter, type FpsCap } from '../../src/render/fpsLimiter';
import { createFrameClock } from '../../src/ui/world/frameNotice';
import { createFrameStep, displayInterval, eyeSkyLight, type FrameStepDeps } from '../../src/ui/world/frameStep';
import { createTeleport } from '../../src/ui/world/teleport';
import { EYE, createWalkState, type WalkState } from '../../src/player/walk';
import { AIR } from '../../src/world/blocks/index';

const HZ60 = 1000 / 60;

interface Rig {
  readonly step: { tick(now: number): void };
  readonly log: string[];
  readonly counts: CoordinatorCounts;
  readonly throttle: Throttle;
  readonly pushes: Array<[frameMs: number, generating: boolean, intervalMs: number]>;
  readonly state: FrameStepDeps['state'];
  readonly fly: FlyState;
  readonly walk: WalkState;
  light: number;
  readonly frames: number[];
  readonly rendered: number[];
  generating: boolean;
  /** The store the frame step was given, and each reader `aim` received. */
  readonly store: FrameStepDeps['store'];
  readonly aimReads: unknown[];
  /** `fly.z` when `coordinator.update` ran: the motion step came first. */
  readonly zAtUpdate: number[];
}

/** A frame step over fakes: every call it makes is logged in order; the clock, limiter and throttle are real. */
function rig(o: { cap?: FpsCap; max?: number; y?: number; held?: Action[]; paused?: () => boolean; fatalInUpdate?: () => boolean; hooks?: boolean; mode?: FlyState['mode'] } = {}): Rig {
  const log: string[] = [];
  const counts = createCoordinatorCounts();
  const throttle = createThrottle({ max: o.max ?? 3 });
  const pushes: Rig['pushes'] = [];
  const fly: FlyState = { x: 8, y: o.y ?? 100, z: 8, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT, mode: o.mode ?? 'fly' };
  const walk = createWalkState();
  const state = { t: 0.1, brightness: 0.5, eyeSky: 15, rd: 12, fogBand: MEDIUM.fogBand };
  const held: ReadonlySet<Action> = new Set(o.held ?? []);
  const origin = createFloatingOrigin(0, 0, 0);
  // The page's `stopped` flag, set by `update` when it raises a fatal synchronously (the page's failAfterReveal).
  let stopped = false;
  const r: Rig = {
    step: null as unknown as Rig['step'],
    log, counts, throttle, pushes, state, fly, walk,
    light: 0xa0,
    frames: [],
    rendered: [],
    generating: false,
    store: null as unknown as FrameStepDeps['store'],
    aimReads: [],
    zAtUpdate: [],
  };
  const store: FrameStepDeps['store'] = {
    enterRead: () => { log.push('enterRead'); },
    exitRead: () => { log.push('exitRead'); },
    lightAt: (bx, by, bz) => {
      log.push(`lightAt ${bx},${by},${bz}`);
      return r.light;
    },
    drain: () => {
      log.push('drain');
      return 0;
    },
    // Air everywhere, every column Published (the walk step's view-free reads, logged once per run of reads).
    blockAt: () => { readLog(); return AIR; },
    fluidAt: () => { readLog(); return 0; },
    publishedAt: () => { readLog(); return true; },
    heightAt: () => null,
  };
  function readLog(): void {
    if (log.at(-1) !== 'read') log.push('read');
  }
  (r as { store: FrameStepDeps['store'] }).store = store;
  const deps: FrameStepDeps = {
    fly,
    walk,
    held: () => held,
    paused: o.paused ?? (() => false),
    stopped: () => stopped,
    clock: createFrameClock(createFpsLimiter(o.cap ?? 0), { push() {} }, 0),
    coordinator: {
      update: () => {
        log.push('update');
        r.zAtUpdate.push(fly.z);
        if (o.fatalInUpdate?.() === true) stopped = true;
      },
      counts: (out) => {
        if (o.hooks === true) log.push(out === counts ? 'counts' : 'counts (another object)');
        out.T.inFlight = r.generating ? 1 : 0;
        out.cx = 3;
        out.cz = -4;
        out.yawDeg = 90;
        return out;
      },
    },
    counts,
    throttle: {
      push: (frameMs, generating, intervalMs) => {
        pushes.push([frameMs, generating, intervalMs]);
        throttle.push(frameMs, generating, intervalMs);
      },
      cap: () => throttle.cap(),
      setMax: (n) => throttle.setMax(n),
      get max() { return throttle.max; },
    },
    budget: createUploadBudget(2, 32, () => 0),
    sections: {
      pump: (_gate, cx, cz, yawDeg) => {
        log.push(`pump ${cx},${cz},${yawDeg}`);
        return 0;
      },
    },
    world: {
      origin: {
        get x() { return origin.x; },
        get y() { return origin.y; },
        get z() { return origin.z; },
        update: (x: number, y: number, z: number) => {
          log.push('origin');
          return origin.update(x, y, z);
        },
      },
      camera: new PerspectiveCamera(),
      frame: (s: FrameStepDeps['state']) => {
        log.push('frame');
        r.frames.push(s.eyeSky);
      },
      sections: { setOrigin: () => { log.push('setOrigin'); } },
    } as unknown as FrameStepDeps['world'],
    store,
    // The page's aim (SP5a spec §3.5): the DDA, the queued clicks and the outline, inside the second read section.
    aim: (read, paused) => {
      log.push(paused ? 'aim paused' : 'aim');
      r.aimReads.push(read);
    },
    state,
    timeSpeed: () => 1,
    fogStep: () => 12,
    onRendered: (dt) => { r.rendered.push(dt); },
    // The page's apply control and aux policy (SP4c spec §4.3, §6.2), logged when the case asks for them.
    beforeUpdate: () => { if (o.hooks === true) log.push('beforeUpdate'); },
    afterCounts: (c) => { if (o.hooks === true) log.push(c === counts ? 'afterCounts' : 'afterCounts (another object)'); },
  };
  (r as { step: Rig['step'] }).step = createFrameStep(deps);
  return r;
}

describe('createFrameStep (SP4b spec §7.2)', () => {
  test('update runs on every tick, pump and render only on rendered ticks (a 30 fps cap at 60 Hz renders every other tick)', () => {
    const r = rig({ cap: 30 });
    const perTick: Array<[updates: number, pumps: number, frames: number]> = [];
    for (let i = 1; i <= 60; i++) {
      r.log.length = 0;
      r.step.tick(i * HZ60);
      perTick.push([
        r.log.filter((l) => l === 'update').length,
        r.log.filter((l) => l.startsWith('pump')).length,
        r.log.filter((l) => l === 'frame').length,
      ]);
    }
    expect(perTick.every(([u]) => u === 1)).toBe(true);
    // The limiter's first tick renders, then every other one: 30 of 60.
    expect(perTick.map(([, p, f]) => (p === 1 && f === 1 ? 1 : p === 0 && f === 0 ? 0 : -1))).toEqual(
      Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : 0)),
    );
    expect(r.rendered).toHaveLength(30);
    expect(r.rendered.slice(1).every((dt) => Math.abs(dt - 2 * HZ60) < 1e-6)).toBe(true);
  });

  test('the order on a rendered tick: update, pump, origin, drain, aim and eye light inside one read section, render', () => {
    const r = rig();
    r.step.tick(HZ60);
    // The pump reads the last rebuild's centre and yaw from the counts the coordinator just wrote.
    expect(r.log).toEqual(['update', 'pump 3,-4,90', 'origin', 'drain', 'enterRead', 'aim', 'lightAt 8,100,8', 'exitRead', 'frame']);
  });

  test('the tick order: motion, update, counts, uploads, origin, drain, then one read section holding `aim` and the eye light, then `world.frame` (SP5a spec §3.5)', () => {
    const r = rig({ held: ['forward'], hooks: true });
    r.step.tick(HZ60);
    // Yaw 0 faces −z: the fly step moved the camera before the coordinator's update.
    expect(r.zAtUpdate).toHaveLength(1);
    expect(r.zAtUpdate[0]!).toBeLessThan(8);
    expect(r.log).toEqual([
      'beforeUpdate', 'update', 'counts', 'afterCounts', 'pump 3,-4,90', 'origin', 'drain',
      'enterRead', 'aim', `lightAt 8,100,${Math.floor(r.fly.z)}`, 'exitRead', 'frame',
    ]);
    // aim reads through the frame's store, inside its read section.
    expect(r.aimReads).toEqual([r.store]);
  });

  test('paused: `aim` called with `paused` true (the page hides the outline); a skipped tick: `aim` not called (SP5a spec §3.5)', () => {
    let paused = false;
    const r = rig({ cap: 30, paused: () => paused });
    const perTick: string[][] = [];
    for (let i = 1; i <= 4; i++) {
      if (i === 3) paused = true;
      r.log.length = 0;
      r.step.tick(i * HZ60);
      perTick.push(r.log.filter((l) => l.startsWith('aim')));
    }
    // A 30 fps cap at 60 Hz renders ticks 1 and 3: the frame keeps rendering behind the help, with aim told it is paused.
    expect(perTick).toEqual([['aim'], [], ['aim paused'], []]);
    expect(r.rendered).toHaveLength(2);
  });

  test('a fatal that update raises synchronously ends the tick there: no counts, pump, origin, drain, eye light or render (Task 21 review M1)', () => {
    let fatal = false;
    const r = rig({ fatalInUpdate: () => fatal });
    r.step.tick(HZ60);
    expect(r.log).toContain('frame');
    const counts = { cx: r.counts.cx, cz: r.counts.cz };
    // The page's failAfterReveal has disposed the coordinator, the pool and the renderer inside update.
    fatal = true;
    r.log.length = 0;
    r.counts.cx = -99;
    r.step.tick(2 * HZ60);
    expect(r.log).toEqual(['update']);
    expect(r.counts.cx).toBe(-99);
    expect(r.rendered).toHaveLength(1);
    expect(r.frames).toHaveLength(1);
    expect(counts).toEqual({ cx: 3, cz: -4 });
  });

  test('beforeUpdate runs before coordinator.update and afterCounts after counts, on every tick, rendered or not (SP4c spec §4.3, §6.2)', () => {
    const r = rig({ cap: 30, hooks: true });
    const heads: string[][] = [];
    const rendered: boolean[] = [];
    for (let i = 1; i <= 4; i++) {
      r.log.length = 0;
      r.step.tick(i * HZ60);
      heads.push(r.log.slice(0, 4));
      rendered.push(r.log.includes('frame'));
    }
    // A 30 fps cap at 60 Hz renders every other tick; the hooks run on all four, with the page's one counts object.
    expect(rendered).toEqual([true, false, true, false]);
    expect(heads).toEqual(Array.from({ length: 4 }, () => ['beforeUpdate', 'update', 'counts', 'afterCounts']));
  });

  test('a fatal in update ends the tick before counts: afterCounts does not run', () => {
    const r = rig({ hooks: true, fatalInUpdate: () => true });
    r.step.tick(HZ60);
    expect(r.log).toEqual(['beforeUpdate', 'update']);
  });

  test('a far move rebases the origin and moves the sections, between the pump and the drain', () => {
    const r = rig();
    r.fly.x = 5000;
    r.step.tick(HZ60);
    expect(r.log.slice(0, 5)).toEqual(['update', 'pump 3,-4,90', 'origin', 'setOrigin', 'drain']);
  });

  test('with `lightAt` −1 the eye light keeps its last value (6); 15 after a teleport; a Published column\'s light is read as today (SP4c spec §3.4, D13)', async () => {
    const r = rig();
    r.light = 0x6a;
    r.step.tick(HZ60);
    // The camera's column freed by an Apply, or not yet generated: the last value stays.
    r.light = -1;
    r.step.tick(2 * HZ60);
    r.step.tick(3 * HZ60);
    expect(r.frames).toEqual([6, 6, 6]);
    // A teleport resets it to 15 (open sky, 24 blocks above the surface); the new place is not Published yet.
    const tp = createTeleport({
      pool: { landing: () => Promise.resolve({ surface: 64, water: -Infinity }) },
      fly: r.fly,
      state: r.state,
      onArrive: () => {},
      onFail: () => {},
    });
    await expect(tp.go(5000, -3000)).resolves.toBe(true);
    r.step.tick(4 * HZ60);
    expect(r.frames.at(-1)).toBe(15);
    expect(r.log.filter((l) => l.startsWith('lightAt')).at(-1)).toBe('lightAt 5000,88,-3000');
    // Once Published, the column's light is read as today (>> 4).
    r.light = 0xa0;
    r.step.tick(5 * HZ60);
    expect(r.frames.at(-1)).toBe(10);
  });

  test('eyeSkyLight returns `last` for a −1 and the light >> 4 otherwise', () => {
    expect(eyeSkyLight({ lightAt: () => -1 }, 0.5, 70, 0.5, 6)).toBe(6);
    expect(eyeSkyLight({ lightAt: () => -1 }, 0.5, 70, 0.5, 15)).toBe(15);
    expect(eyeSkyLight({ lightAt: () => 0x3f }, 0.5, 70, 0.5, 6)).toBe(3);
  });

  test('above y 319 the eye reads sky 15 without a lightAt call (it would throw); below −64 it reads 0', () => {
    const above = rig({ y: 320.5 });
    above.step.tick(HZ60);
    expect(above.frames).toEqual([15]);
    expect(above.log.some((l) => l.startsWith('lightAt'))).toBe(false);
    // The fly bounds keep the camera at y ≥ −64, so the lower branch is the helper's alone.
    const throws = { lightAt: (): number => { throw new RangeError('outside'); } };
    expect(eyeSkyLight(throws, 0.5, -64.5, 0.5, 7)).toBe(0);
    expect(eyeSkyLight(throws, 0.5, 320, 0.5, 7)).toBe(15);
    expect(eyeSkyLight({ lightAt: (bx, by, bz) => (bx === -1 && by === -64 && bz === 3 ? 0xf3 : 0) }, -0.5, -63.5, 3.9, 7)).toBe(15);
  });

  test('the time advances by the rendered delta and the fog RD comes from fogStep on rendered ticks', () => {
    const r = rig();
    const t0 = r.state.t;
    r.step.tick(1000);
    // ×1: 1 s of a 20-minute day.
    expect(r.state.t - t0).toBeCloseTo(1000 / 1_200_000, 12);
    expect(r.state.rd).toBe(12);
  });

  test('Review Focus 1: with the FPS cap at 30 and 16.667 ms ticks for 600 ticks with generation in flight, the throttle is fed 16.667 ms on every tick and genCap stays at its maximum', () => {
    const r = rig({ cap: 30, max: 5 });
    r.generating = true;
    for (let i = 1; i <= 600; i++) r.step.tick(i * HZ60);
    expect(r.pushes).toHaveLength(600);
    expect(r.pushes.every(([ms]) => Math.abs(ms - HZ60) < 1e-6)).toBe(true);
    expect(r.pushes.every(([, , interval]) => Math.abs(interval - HZ60) < 1e-6)).toBe(true);
    // The first push reads the previous tick's counts (none yet); every later one sees generation in flight.
    expect(r.pushes.slice(1).every(([, gen]) => gen)).toBe(true);
    expect(r.throttle.cap()).toBe(5);
    // Fed the rendered frames' 33.3 ms instead, the throttle would drop to 1.
    const t = createThrottle({ max: 5 });
    for (let i = 0; i < 600; i++) t.push(2 * HZ60, true, HZ60);
    expect(t.cap()).toBe(1);
  });
});

describe('the display interval from on-time frames (rulings R13, R16)', () => {
  const HZ144 = 1000 / 144;
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

  test('steady 33.3 ms frames after a 60 Hz history with generation in flight drop genCap to 1: the interval stays 16.667 ms', () => {
    const r = rig({ max: 5 });
    r.generating = true;
    let now = 0;
    for (let i = 0; i < 240; i++) r.step.tick((now += HZ60));
    expect(r.throttle.cap()).toBe(5);
    const from = r.pushes.length;
    // Every frame two intervals long: a rolling median would follow them and read them as on time (UI-1).
    for (let i = 0; i < 200; i++) r.step.tick((now += 2 * HZ60));
    expect(r.pushes.slice(from).every(([ms, , interval]) => near(interval, HZ60) && near(ms, 2 * HZ60))).toBe(true);
    expect(r.throttle.cap()).toBe(1);
  });

  test('one frame in three, or two in three, two intervals late on a 60 Hz display with generation in flight drop genCap to 1', () => {
    for (const lateOf3 of [1, 2]) {
      const r = rig({ max: 5 });
      r.generating = true;
      let now = 0;
      for (let i = 0; i < 300; i++) r.step.tick((now += i % 3 < lateOf3 ? 3 * HZ60 : HZ60));
      expect(r.pushes.slice(30).every(([, , interval]) => near(interval, HZ60)), `${lateOf3} in 3`).toBe(true);
      expect(r.throttle.cap(), `${lateOf3} in 3`).toBe(1);
    }
  });

  /** rAF timestamps at 60 Hz, each displaced by Gaussian jitter of σ ms (an LCG and Box-Muller: the same every run). */
  function jittered(sigma: number, seed: number): () => number {
    let s = seed >>> 0;
    const u = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    let i = 0;
    return () => {
      const g = Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
      return ++i * HZ60 + sigma * g;
    };
  }

  test('rAF timestamp jitter of σ 0.5 ms on a 60 Hz display leaves the interval at 16.667 ms: the median of the on-time cluster, not the low tail (rulings R16)', () => {
    const r = rig({ max: 5 });
    r.generating = true;
    const next = jittered(0.5, 7);
    for (let i = 0; i < 3000; i++) r.step.tick(next());
    // A bare 10th percentile reads about 1.28 σ of the deltas (0.71 ms) low: about 15.76 ms.
    const intervals = r.pushes.slice(240).map(([, , interval]) => interval);
    expect(Math.min(...intervals)).toBeGreaterThan(HZ60 - 0.25);
    expect(Math.max(...intervals)).toBeLessThan(HZ60 + 0.25);
  });

  test('rAF timestamp jitter of σ 0.25 ms on a 60 Hz display, no slow frame, with generation in flight keeps genCap at its maximum on every tick (rulings R16)', () => {
    const r = rig({ max: 5 });
    r.generating = true;
    const next = jittered(0.25, 7);
    let lowest = 5;
    for (let i = 0; i < 3000; i++) {
      r.step.tick(next());
      lowest = Math.min(lowest, r.throttle.cap());
    }
    expect(lowest).toBe(5);
  });

  test('a window moved from a 60 Hz to a 144 Hz display, and back, is followed within 240 frames', () => {
    const r = rig();
    let now = 0;
    for (let i = 0; i < 300; i++) r.step.tick((now += HZ60));
    expect(near(r.pushes.at(-1)![2], HZ60)).toBe(true);
    const at144 = r.pushes.length;
    for (let i = 0; i < 300; i++) r.step.tick((now += HZ144));
    const to144 = r.pushes.slice(at144).findIndex(([, , interval]) => near(interval, HZ144));
    expect(to144).toBeGreaterThanOrEqual(0);
    expect(to144).toBeLessThan(240);
    expect(r.pushes.slice(at144 + to144).every(([ms, , interval]) => near(interval, HZ144) && near(ms, HZ144))).toBe(true);
    const at60 = r.pushes.length;
    for (let i = 0; i < 300; i++) r.step.tick((now += HZ60));
    const to60 = r.pushes.slice(at60).findIndex(([, , interval]) => near(interval, HZ60));
    expect(to60).toBeGreaterThanOrEqual(0);
    expect(to60).toBeLessThan(240);
    expect(r.pushes.slice(at60 + to60).every(([, , interval]) => near(interval, HZ60))).toBe(true);
  });
});

describe('displayInterval (rulings R5 (a))', () => {
  test('a finite median is the interval; a non-finite one falls back to 1000/60', () => {
    expect(displayInterval(4.167)).toBe(4.167);
    expect(displayInterval(Number.NaN)).toBe(HZ60);
    expect(displayInterval(Number.POSITIVE_INFINITY)).toBe(HZ60);
  });
});

describe('the frame step\'s motion and callbacks', () => {
  test('onRendered gets each rendered delta', () => {
    const r = rig();
    r.step.tick(10);
    r.step.tick(26);
    expect(r.rendered).toEqual([10, 16]);
  });

  test('W held moves the camera on every tick, rendered or not; paused (the help open), it does not move', () => {
    let paused = false;
    const r = rig({ cap: 30, held: ['forward'], paused: () => paused });
    const z: number[] = [];
    for (let i = 1; i <= 4; i++) {
      r.step.tick(i * HZ60);
      z.push(r.fly.z);
    }
    // Yaw 0 faces −z: every tick moves, the skipped ones included.
    for (let i = 1; i < z.length; i++) expect(z[i]!).toBeLessThan(z[i - 1]!);
    paused = true;
    const at = r.fly.z;
    for (let i = 5; i <= 8; i++) r.step.tick(i * HZ60);
    expect(r.fly.z).toBe(at);
  });
});

describe('the frame step\'s dispatch by mode (SP5a spec §3.1, §3.2)', () => {
  test('the frame step in walk mode calls the walk step inside one read section and never `stepFly`', () => {
    const r = rig({ mode: 'walk', held: ['up', 'forward'], hooks: true });
    // F's feet: the eye 100 − 1.62, both ticks' feet set.
    r.walk.px = r.walk.x = 8;
    r.walk.py = r.walk.y = 100 - EYE;
    r.walk.pz = r.walk.z = 8;
    // 0.16 s: three 20 Hz ticks before the coordinator's update, 0.01 s left owed.
    r.step.tick(160);
    expect(r.log).toEqual([
      'enterRead', 'read', 'exitRead', 'beforeUpdate', 'update', 'counts', 'afterCounts', 'pump 3,-4,90', 'origin', 'drain',
      'enterRead', 'aim', `lightAt 8,${Math.floor(r.fly.y)},${Math.floor(r.fly.z)}`, 'exitRead', 'frame',
    ]);
    expect(r.walk.acc).toBeCloseTo(0.01, 12);
    // Space in the air does nothing walking (flight would rise 12 blocks/s): the body falls, and the drawn eye is the
    // feet interpolated between the last two ticks (a fifth of the way) plus 1.62.
    expect(r.walk.y).toBeLessThan(r.walk.py);
    expect(r.walk.py).toBeLessThan(100 - EYE);
    expect(r.fly.y).toBeCloseTo(r.walk.py + (r.walk.y - r.walk.py) * 0.2 + EYE, 12);
    // W walks along −z in the air at 0.02 per tick of wish, far below flight's 12 blocks/s.
    expect(r.fly.z).toBeLessThan(8);
    expect(r.fly.z).toBeGreaterThan(8 - 0.1);
    expect([r.fly.vx, r.fly.vy, r.fly.vz]).toEqual([0, 0, 0]);
  });

  test('walking and paused (the help open): no walk step, no read before the update, the body does not move', () => {
    const r = rig({ mode: 'walk', held: ['forward'], paused: () => true });
    r.walk.py = r.walk.y = 100 - EYE;
    r.step.tick(100);
    expect(r.log.slice(0, 2)).toEqual(['update', 'pump 3,-4,90']);
    expect(r.log).not.toContain('read');
    expect([r.walk.x, r.walk.y, r.walk.z, r.walk.acc]).toEqual([0, 100 - EYE, 0, 0]);
    expect([r.fly.x, r.fly.y, r.fly.z]).toEqual([8, 100, 8]);
  });
});

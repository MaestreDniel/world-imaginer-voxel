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

const HZ60 = 1000 / 60;

interface Rig {
  readonly step: { tick(now: number): void };
  readonly log: string[];
  readonly counts: CoordinatorCounts;
  readonly throttle: Throttle;
  readonly pushes: Array<[frameMs: number, generating: boolean, intervalMs: number]>;
  readonly state: FrameStepDeps['state'];
  readonly fly: FlyState;
  light: number;
  readonly frames: number[];
  readonly rendered: number[];
  generating: boolean;
}

/** A frame step over fakes: every call it makes is logged in order; the clock, limiter and throttle are real. */
function rig(o: { cap?: FpsCap; max?: number; y?: number; held?: Action[]; paused?: () => boolean; fatalInUpdate?: () => boolean } = {}): Rig {
  const log: string[] = [];
  const counts = createCoordinatorCounts();
  const throttle = createThrottle({ max: o.max ?? 3 });
  const pushes: Rig['pushes'] = [];
  const fly: FlyState = { x: 8, y: o.y ?? 100, z: 8, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT };
  const state = { t: 0.1, brightness: 0.5, eyeSky: 15, rd: 12, fogBand: MEDIUM.fogBand };
  const held: ReadonlySet<Action> = new Set(o.held ?? []);
  const origin = createFloatingOrigin(0, 0, 0);
  // The page's `stopped` flag, set by `update` when it raises a fatal synchronously (the page's failAfterReveal).
  let stopped = false;
  const r: Rig = {
    step: null as unknown as Rig['step'],
    log, counts, throttle, pushes, state, fly,
    light: 0xa0,
    frames: [],
    rendered: [],
    generating: false,
  };
  const deps: FrameStepDeps = {
    fly,
    held: () => held,
    paused: o.paused ?? (() => false),
    stopped: () => stopped,
    clock: createFrameClock(createFpsLimiter(o.cap ?? 0), { push() {} }, 0),
    coordinator: {
      update: () => {
        log.push('update');
        if (o.fatalInUpdate?.() === true) stopped = true;
      },
      counts: (out) => {
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
    store: {
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
    },
    state,
    timeSpeed: () => 1,
    fogStep: () => 12,
    onRendered: (dt) => { r.rendered.push(dt); },
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

  test('the order on a rendered tick: update, pump, origin, drain, eye light inside one read section, render', () => {
    const r = rig();
    r.step.tick(HZ60);
    // The pump reads the last rebuild's centre and yaw from the counts the coordinator just wrote.
    expect(r.log).toEqual(['update', 'pump 3,-4,90', 'origin', 'drain', 'enterRead', 'lightAt 8,100,8', 'exitRead', 'frame']);
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

  test('a far move rebases the origin and moves the sections, between the pump and the drain', () => {
    const r = rig();
    r.fly.x = 5000;
    r.step.tick(HZ60);
    expect(r.log.slice(0, 5)).toEqual(['update', 'pump 3,-4,90', 'origin', 'setOrigin', 'drain']);
  });

  test('a −1 from lightAt reads as sky 15', () => {
    const r = rig();
    r.light = 0x5a;
    r.step.tick(HZ60);
    r.light = -1;
    r.step.tick(2 * HZ60);
    expect(r.frames).toEqual([5, 15]);
  });

  test('above y 319 the eye reads sky 15 without a lightAt call (it would throw); below −64 it reads 0', () => {
    const above = rig({ y: 320.5 });
    above.step.tick(HZ60);
    expect(above.frames).toEqual([15]);
    expect(above.log.some((l) => l.startsWith('lightAt'))).toBe(false);
    // The fly bounds keep the camera at y ≥ −64, so the lower branch is the helper's alone.
    const throws = { lightAt: (): number => { throw new RangeError('outside'); } };
    expect(eyeSkyLight(throws, 0.5, -64.5, 0.5)).toBe(0);
    expect(eyeSkyLight(throws, 0.5, 320, 0.5)).toBe(15);
    expect(eyeSkyLight({ lightAt: (bx, by, bz) => (bx === -1 && by === -64 && bz === 3 ? 0xf3 : 0) }, -0.5, -63.5, 3.9)).toBe(15);
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

  test('slow frames with generation in flight drop genCap (the throttle still reacts)', () => {
    const r = rig({ max: 5 });
    r.generating = true;
    // 50 ms frames, uncapped: the display interval follows them, so they are on time and nothing drops.
    for (let i = 1; i <= 120; i++) r.step.tick(i * 50);
    expect(r.throttle.cap()).toBe(5);
    // A 60 Hz display with every third frame late by 2 intervals: p95 50 ms > 17.2 ms.
    let now = 120 * 50;
    for (let i = 0; i < 120; i++) {
      now += i % 3 === 2 ? 3 * HZ60 : HZ60;
      r.step.tick(now);
    }
    expect(r.throttle.cap()).toBeLessThan(5);
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

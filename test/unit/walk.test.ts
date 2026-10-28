/**
 * The walk controller at 20 Hz (SP5a spec §3.2, D2-D5): Minecraft's per-tick constants over the swept AABB, read
 * through canned readers. Displacements "once steady" are the 201st tick's, after 200 ticks of warm-up. The unloaded
 * rule is Review Focus 3: a body walking off the Published columns keeps its height and its speed, and the unpublished
 * column's voxels (−1) never collide. `walkStep`'s accumulator runs at most 5 ticks and draws the eye between the
 * previous and the current feet.
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import {
  AIR_DRAG, EYE, GRAVITY, MAX_TICKS, TICK_S, UNSTUCK_MAX_Y, VDRAG, arriveFeet, createWalkState, setFeet, walkStep, walkTick,
  type WalkReader, type WalkState,
} from '../../src/player/walk';
import { toggleMode, type FlyState } from '../../src/player/fly';
import { bodyIntersects } from '../../src/player/physics';
import type { Action } from '../../src/player/keymap';
import { AIR, ICE, LADDER, PACKED_ICE, STONE } from '../../src/world/blocks/index';
import { LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';

interface Canned extends WalkReader {
  /** Sets one voxel (block and fluid byte); the rest follows the floor and the fluid layer. */
  set(x: number, y: number, z: number, state: number, fluid?: number): Canned;
  /** Moves the unpublished edge: columns at block x ≥ `x` are not Published from now on. */
  unpublishFromX(x: number): Canned;
}

interface World {
  /** Every y below it is `floor(x, z)` (none for −Infinity), air above. */
  floorTop?: number;
  floor?: (bx: number, bz: number) => number;
  /** The fluid byte of an unset voxel (0 when absent). */
  fluid?: (bx: number, by: number, bz: number) => number;
  /** Columns at block x ≥ this are not Published: −1, fluid 0, `publishedAt` false. */
  unpublishedFromX?: number;
}

/** A Smi key for |x|, |y − 64|, |z| < 128 (no allocation on a `Map` read): y in −64 … 191. */
const key = (x: number, y: number, z: number): number => ((x + 128) * 256 + (y - 64 + 128)) * 256 + (z + 128);

function canned(w: World = {}): Canned {
  const floorTop = w.floorTop ?? 70;
  const floor = w.floor ?? ((): number => STONE);
  const fluid = w.fluid ?? ((): number => 0);
  let unpub = w.unpublishedFromX ?? Infinity;
  const blocks = new Map<number, number>();
  const fluids = new Map<number, number>();
  const r: Canned = {
    blockAt: (x, y, z) => (x >= unpub ? -1 : (blocks.get(key(x, y, z)) ?? (y < floorTop ? floor(x, z) : AIR))),
    fluidAt: (x, y, z) => (x >= unpub ? 0 : (fluids.get(key(x, y, z)) ?? fluid(x, y, z))),
    publishedAt: (x) => x < unpub,
    // `MOTION_BLOCKING` as the store keeps it: y + 1 of the highest voxel holding a block or a fluid, null unpublished.
    heightAt: (_kind, x, z) => {
      if (x >= unpub) return null;
      for (let y = 191; y >= -64; y--) if (r.blockAt(x, y, z) !== AIR || r.fluidAt(x, y, z) !== 0) return y + 1;
      return -64;
    },
    set(x, y, z, state, f = 0) {
      blocks.set(key(x, y, z), state);
      fluids.set(key(x, y, z), f);
      return r;
    },
    unpublishFromX(x) {
      unpub = x;
      return r;
    },
  };
  return r;
}

/** A body at rest standing (or floating) at feet (x, y, z). */
function bodyAt(x: number, y: number, z: number, onGround = true): WalkState {
  const w = createWalkState();
  setFeet(w, x, y, z);
  w.onGround = onGround;
  return w;
}

interface Keys { wishX?: number; wishZ?: number; jump?: boolean; down?: boolean; sprint?: boolean }

/** Runs `n` ticks; returns the last tick's displacement (dx, dy, dz). */
function run(w: WalkState, r: WalkReader, n: number, k: Keys = {}): [number, number, number] {
  let d: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = w.x;
    const y = w.y;
    const z = w.z;
    walkTick(w, r, k.wishX ?? 0, k.wishZ ?? 0, k.jump ?? false, k.down ?? false, k.sprint ?? false);
    d = [w.x - x, w.y - y, w.z - z];
  }
  return d;
}

/** The displacement of the 201st tick, after 200 ticks of warm-up under the same keys. */
const steady = (w: WalkState, r: WalkReader, k: Keys): [number, number, number] => {
  run(w, r, 200, k);
  return run(w, r, 1, k);
};

/**
 * Warms `call` up over 100,000 calls, then expects the heap to grow by less than 256 KB over 10,000 more (the
 * zeroAlloc.test.ts pattern: up to three attempts, an attempt that saw a GC not counted).
 */
function expectNoAllocation(call: () => void): void {
  for (let i = 0; i < 100_000; i++) call();
  v8.setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
  const heapUsed = (): number => {
    let b = 0;
    for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) b += s.space_used_size;
    return b;
  };
  const readings: number[] = [];
  for (let t = 0; t < 3; t++) {
    gc();
    gc();
    const before = heapUsed();
    const profiler = new v8.GCProfiler();
    profiler.start();
    for (let i = 0; i < 10_000; i++) call();
    const after = heapUsed();
    const gcs = profiler.stop()?.statistics.length ?? 0;
    if (gcs > 0) continue;
    readings.push(after - before);
    if (after - before < 256 * 1024) break;
  }
  expect(readings.length, 'every attempt saw a GC').toBeGreaterThan(0);
  expect(readings[readings.length - 1]!, `heap growth over 10,000 calls (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
}

/** The distance slid along x after letting go (until the body stops). */
function slide(w: WalkState, r: WalkReader): number {
  const x0 = w.x;
  run(w, r, 400);
  return w.x - x0;
}

describe('walkTick on the ground (SP5a spec §3.2, D2, D4)', () => {
  test('walking: 0.2203 ± 0.0005 per tick (4.4 blocks/s); sprinting 0.2863 ± 0.0005 (5.7)', () => {
    const r = canned();
    const walk = steady(bodyAt(-60.5, 70, 0.5), r, { wishX: 1 });
    expect(Math.abs(walk[0] - 0.2203)).toBeLessThanOrEqual(0.0005);
    expect(walk[1]).toBe(0);
    expect(walk[2]).toBe(0);
    expect(walk[0] / TICK_S).toBeCloseTo(4.4, 1);
    const sprint = steady(bodyAt(-60.5, 70, 0.5), r, { wishX: 1, sprint: true });
    expect(Math.abs(sprint[0] - 0.2863)).toBeLessThanOrEqual(0.0005);
    expect(sprint[0] / TICK_S).toBeCloseTo(5.7, 1);
  });

  test('ice (`ice` and `packed_ice` under the centre at feet − 0.5): steady 0.2121 ± 0.0005; 90 % of it at tick 20 or 21; after letting go the slide is 1.75 ± 0.05 blocks (0.265 ± 0.01 on stone)', () => {
    for (const state of [ICE, PACKED_ICE]) {
      const r = canned({ floor: () => state });
      const w = bodyAt(-60.5, 70, 0.5);
      let reached = 0;
      for (let tick = 1; tick <= 200; tick++) {
        const [dx] = run(w, r, 1, { wishX: 1 });
        if (reached === 0 && dx >= 0.9 * 0.2121) reached = tick;
      }
      const [dx] = run(w, r, 1, { wishX: 1 });
      expect(Math.abs(dx - 0.2121), `steady on ${state}`).toBeLessThanOrEqual(0.0005);
      expect([20, 21], `90 % reached at tick ${reached}`).toContain(reached);
      expect(Math.abs(slide(w, r) - 1.75)).toBeLessThanOrEqual(0.05);
    }
    const stone = canned();
    const w = bodyAt(-60.5, 70, 0.5);
    run(w, stone, 201, { wishX: 1 });
    expect(Math.abs(slide(w, stone) - 0.265)).toBeLessThanOrEqual(0.01);
  });

  test('a body half over ice with its centre over stone does not slide', () => {
    // Ice under block x ≥ 1, stone under x ≤ 0; the centre at x 0.99, so 0.29 of the 0.6 footprint is over ice.
    const r = canned({ floor: (bx) => (bx >= 1 ? ICE : STONE) });
    const w = bodyAt(0.99, 70, -60.5);
    const [, , dz] = steady(w, r, { wishZ: 1 });
    expect(Math.abs(dz - 0.2203)).toBeLessThanOrEqual(0.0005);
    const z0 = w.z;
    run(w, r, 400);
    expect(Math.abs(w.z - z0 - 0.265)).toBeLessThanOrEqual(0.01);
    expect(w.x).toBe(0.99);
  });
});

describe('walkTick in the air (SP5a spec §3.2, D2)', () => {
  test('jump apex 1.2522 ± 0.01; terminal −3.92 ± 0.001 per tick', () => {
    const r = canned();
    const w = bodyAt(0.5, 70, 0.5);
    run(w, r, 3);
    const ground = w.y;
    let apex = ground;
    run(w, r, 1, { jump: true });
    expect(w.onGround).toBe(false);
    for (let i = 0; i < 40; i++) {
      run(w, r, 1);
      apex = Math.max(apex, w.y);
    }
    expect(Math.abs(apex - ground - 1.2522)).toBeLessThanOrEqual(0.01);
    // Landed again (the sweep stops 1e-7 above the face it meets).
    expect(w.y).toBeCloseTo(ground, 6);
    expect(w.onGround).toBe(true);
    // Free fall in an empty world: (vy − 0.08) · 0.98 settles at −3.92 per tick (78.4 blocks/s).
    const fall = bodyAt(0.5, 300, 0.5, false);
    const [, dy] = run(fall, canned({ floorTop: -Infinity }), 700);
    expect(Math.abs(dy + 3.92)).toBeLessThanOrEqual(0.001);
  });

  test('air: 0.02 per tick of wish, 0.026 sprinting, `·0.91`', () => {
    const r = canned({ floorTop: -Infinity });
    for (const [sprint, a] of [[false, 0.02], [true, 0.026]] as const) {
      const w = bodyAt(0.5, 200, 0.5, false);
      const [dx] = run(w, r, 1, { wishX: 1, sprint });
      expect(dx).toBeCloseTo(a, 12);
      expect(w.vx).toBeCloseTo(a * AIR_DRAG, 12);
      const [dx2] = run(w, r, 1, { wishX: 1, sprint });
      expect(dx2).toBeCloseTo(a * AIR_DRAG + a, 12);
      expect(w.vx).toBeCloseTo((a * AIR_DRAG + a) * AIR_DRAG, 12);
      // Letting go: the velocity only decays by 0.91.
      const v = w.vx;
      run(w, r, 1);
      expect(w.vx).toBeCloseTo(v * AIR_DRAG, 12);
    }
    expect(AIR_DRAG).toBe(0.91);
  });
});

describe('walkTick in fluids (SP5a spec §3.2, D3; Point 5)', () => {
  /** A deep fluid everywhere at y 0 … 299. */
  const deep = (byte: number): Canned => canned({ floorTop: -Infinity, fluid: (_x, y) => (y >= 0 && y < 300 ? byte : 0) });

  test('water: no key −0.025 ± 0.0005 per tick (0.5 blocks/s), Space +0.175, Shift −0.225, horizontal 0.1', () => {
    const r = deep(WATER_SOURCE);
    const near = (v: number, want: number): void => expect(Math.abs(v - want), `${v} vs ${want}`).toBeLessThanOrEqual(0.0005);
    near(steady(bodyAt(0.5, 150, 0.5, false), r, {})[1], -0.025);
    near(steady(bodyAt(0.5, 100, 0.5, false), r, { jump: true })[1], 0.175);
    near(steady(bodyAt(0.5, 150, 0.5, false), r, { down: true })[1], -0.225);
    const h = steady(bodyAt(-60.5, 150, 0.5, false), r, { wishX: 1 });
    near(h[0], 0.1);
    near(h[1], -0.025);
    // Sprinting does not swim faster.
    near(steady(bodyAt(-60.5, 150, 0.5, false), r, { wishX: 1, sprint: true })[0], 0.1);
  });

  test('lava: −0.04, Space +0.04, Shift −0.12, horizontal 0.04', () => {
    const r = deep(LAVA_SOURCE);
    const near = (v: number, want: number): void => expect(Math.abs(v - want), `${v} vs ${want}`).toBeLessThanOrEqual(0.0005);
    near(steady(bodyAt(0.5, 150, 0.5, false), r, {})[1], -0.04);
    near(steady(bodyAt(0.5, 150, 0.5, false), r, { jump: true })[1], 0.04);
    near(steady(bodyAt(0.5, 150, 0.5, false), r, { down: true })[1], -0.12);
    near(steady(bodyAt(-60.5, 150, 0.5, false), r, { wishX: 1 })[0], 0.04);
  });

  test('bank hop: in water against a 1-block bank with air 0.6 higher, `vy` becomes 0.3 and the body climbs out', () => {
    // Stone up to y 69; one layer of water at y 70 for x ≤ 4; a bank of stone at y 70 for x 5 … 15 (its top at 71).
    const r = canned({ fluid: (bx, by) => (bx <= 4 && by === 70 ? WATER_SOURCE : 0) });
    for (let x = 5; x <= 15; x++) for (let z = -4; z <= 4; z++) r.set(x, 70, z, STONE);
    // Floating against the bank, the feet 0.5 into the water: 0.6 higher the body clears the bank's top.
    const w = bodyAt(4.69, 70.5, 0.5, false);
    run(w, r, 1, { wishX: 1 });
    expect(w.x).toBeLessThan(4.7);
    expect(w.vy).toBe(0.3);
    run(w, r, 40, { wishX: 1 });
    expect(w.x).toBeGreaterThan(5.5);
    expect(w.y).toBeCloseTo(71, 6);
    expect(w.onGround).toBe(true);
  });
});

describe('walkTick on ladders (SP5a spec §3.2, D5)', () => {
  /** A column of ladders at x 0, z 0, y 70 … 89 (waterlogged when `water`), stone below 70. */
  function ladders(water: boolean): Canned {
    const r = canned();
    for (let y = 70; y < 90; y++) r.set(0, y, 0, LADDER, water ? WATER_SOURCE : 0);
    return r;
  }

  test('ladder: Space +0.1175 per tick (2.35 blocks/s), Shift 0, no key falls at most 0.1175; a waterlogged ladder applies the clamp after the water row', () => {
    for (const water of [false, true]) {
      const r = ladders(water);
      const up = bodyAt(0.5, 75, 0.5, false);
      for (let i = 0; i < 20; i++) expect(run(up, r, 1, { jump: true })[1]).toBeCloseTo(0.1175, 12);
      const hold = bodyAt(0.5, 75, 0.5, false);
      for (let i = 0; i < 20; i++) expect(run(hold, r, 1, { down: true })[1]).toBe(0);
      const none = bodyAt(0.5, 85, 0.5, false);
      let fastest = 0;
      for (let i = 0; i < 30; i++) fastest = Math.min(fastest, run(none, r, 1)[1]);
      expect(fastest).toBeGreaterThanOrEqual(-0.1175 - 1e-12);
      // Out of water the slide reaches the clamp; in water the water row's own sinking (−0.025) is slower.
      expect(fastest).toBeCloseTo(water ? -0.025 : -0.1175, water ? 3 : 12);
    }
    expect(2.35 * TICK_S).toBeCloseTo(0.1175, 12);
  });
});

describe('walkTick over unloaded columns (SP5a spec §3.2; Review Focus 3)', () => {
  test('walking east at 4.4 blocks/s from a Published column onto a non-Published one: `vy` 0 and y unchanged for 40 ticks while x keeps growing by 0.2203 ± 0.0005 per tick (`onGround` kept, so the ground row applies) and nothing in the unpublished column collides', () => {
    // Block x ≥ 16 is not Published; the store answers −1 there, which would be stone if it counted.
    const r = canned({ unpublishedFromX: 16 });
    const w = bodyAt(-30.5, 70, 0.5);
    run(w, r, 150, { wishX: 1 });
    expect(w.x).toBeLessThan(15.7);
    while (w.x + 0.3 <= 16) run(w, r, 1, { wishX: 1 });
    const y = w.y;
    expect(w.onGround).toBe(true);
    for (let i = 0; i < 40; i++) {
      const [dx, dy] = run(w, r, 1, { wishX: 1, jump: i === 5 });
      expect(Math.abs(dx - 0.2203), `tick ${i}: dx ${dx}`).toBeLessThanOrEqual(0.0005);
      expect(dy).toBe(0);
      expect(w.y).toBe(y);
      expect(w.vy).toBe(0);
      expect(w.onGround).toBe(true);
    }
    expect(w.x).toBeGreaterThan(16 + 39 * 0.22);
  });

  test('a body in the air over an unloaded column hovers and keeps the air row', () => {
    const r = canned({ unpublishedFromX: 0 });
    const w = bodyAt(0.5, 90, 0.5, false);
    w.vy = -1;
    const [dx, dy] = run(w, r, 1, { wishX: 1 });
    expect(dy).toBe(0);
    expect(w.vy).toBe(0);
    expect(dx).toBeCloseTo(0.02, 12);
    expect(w.onGround).toBe(false);
  });
});

describe('the walking teleport\'s snap (SP5a spec §3.4, D15)', () => {
  test('hover while unpublished (y unchanged over 20 ticks), then on publish the feet at `heightAt(\'motionBlocking\')` (65) and `snapPending` false', () => {
    // Stone below y 65 (`heightAt` 65), nothing Published yet.
    const r = canned({ floorTop: 65, unpublishedFromX: -Infinity });
    const w = createWalkState();
    expect(w.snapY).toBeNaN();
    arriveFeet(w, 0.5, 90, 0.5);
    expect([w.x, w.y, w.z, w.snapPending]).toEqual([0.5, 90, 0.5, true]);
    for (let i = 0; i < 20; i++) {
      walkTick(w, r, 0, 0, false, false, false);
      expect(w.y, `tick ${i}`).toBe(90);
      expect(w.vy).toBe(0);
      expect(w.snapPending).toBe(true);
    }
    expect(w.snapY).toBeNaN();
    r.unpublishFromX(Infinity);
    expect(r.heightAt('motionBlocking', 0, 0)).toBe(65);
    walkTick(w, r, 0, 0, false, false, false);
    // Both feet on the ground: no interpolation from the hover down to it.
    expect([w.py, w.y, w.snapY, w.snapPending]).toEqual([65, 65, 65, false]);
    // Then the body stands there.
    run(w, r, 20);
    expect(w.y).toBeCloseTo(65, 6);
    expect(w.onGround).toBe(true);
    expect(w.snapY).toBe(65);
  });

  test('over water the snap is the water\'s top (fluid counts in `motionBlocking`), and the body then sinks slowly', () => {
    // Stone below y 40, water sources up to y 62: `heightAt` 63.
    const r = canned({ floorTop: 40, fluid: (_x, y) => (y >= 40 && y < 63 ? WATER_SOURCE : 0) });
    const w = createWalkState();
    arriveFeet(w, 4.5, 63, 4.5);
    walkTick(w, r, 0, 0, false, false, false);
    expect([w.y, w.snapY, w.snapPending]).toEqual([63, 63, false]);
    run(w, r, 40);
    expect(w.y).toBeLessThan(63);
  });
});

describe('the unstuck scan (SP5a spec §3.1, §3.2, D29; Review Focus 3)', () => {
  test('`bodyIntersects` reads the body\'s voxels: a voxel collides over [by, by + top); a −1 read and `none` never', () => {
    const r = canned();
    // Standing on the floor's top (70) or 1e-7 above it, as a sweep leaves it: free; any lower, inside.
    expect(bodyIntersects(r, 0.5, 70, 0.5)).toBe(false);
    expect(bodyIntersects(r, 0.5, 70 + 1e-7, 0.5)).toBe(false);
    expect(bodyIntersects(r, 0.5, 69.999, 0.5)).toBe(true);
    // A stone at head height, and one beside the footprint's edge (0.3 from the centre).
    r.set(0, 71, 0, STONE).set(2, 70, 0, STONE);
    expect(bodyIntersects(r, 0.5, 70, 0.5)).toBe(true);
    expect(bodyIntersects(r, 1.5, 72, 0.5)).toBe(false);
    expect(bodyIntersects(r, 1.69, 70, 0.5)).toBe(false);
    expect(bodyIntersects(r, 1.71, 70, 0.5)).toBe(true);
    // A ceiling stone at y 73: the head 1e-7 under its underside, as a sweep leaves it, is free; 0.01 into it, not.
    r.set(4, 73, 0, STONE);
    expect(bodyIntersects(r, 4.5, 73 - 1e-7 - 1.8, 0.5)).toBe(false);
    expect(bodyIntersects(r, 4.5, 71.21, 0.5)).toBe(true);
    // A ladder (`none`) and an unpublished column's −1 do not collide.
    r.set(5, 70, 0, LADDER);
    expect(bodyIntersects(r, 5.5, 70, 0.5)).toBe(false);
    r.unpublishFromX(10);
    expect(bodyIntersects(r, 10.5, 60, 0.5)).toBe(false);
    // A 0.5 ledge collides over [70, 70.5) only.
    const ledge: WalkReader = { ...canned(), blockAt: (_x, y) => (y < 70 ? STONE : y === 70 ? ICE : AIR), collideTop: (st) => (st === ICE ? 0.5 : 1) };
    expect(bodyIntersects(ledge, 0.5, 70.4, 0.5)).toBe(true);
    expect(bodyIntersects(ledge, 0.5, 70.5, 0.5)).toBe(false);
  });

  test('F with the eye 1 block under the ground\'s top T: on the first tick the feet are at T + 0.38 (whole-block lifts keep the fraction), and after falling the body stands on T (feet T, `onGround`)', () => {
    const T = 70;
    const r = canned({ floorTop: T });
    const fly: FlyState = { x: 0.5, y: T - 1, z: 0.5, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, speed: 12, mode: 'fly' };
    const w = createWalkState();
    toggleMode(fly, w);
    const feet = T - 1 - EYE;
    expect(w.y).toBe(feet);
    walkTick(w, r, 0, 0, false, false, false);
    expect(w.y).toBe(feet + 1 + 1 + 1);
    expect(w.y).toBeCloseTo(T + 0.38, 12);
    // No interpolation from inside the ground: the previous feet are the lifted ones too.
    expect(w.py).toBe(w.y);
    expect(w.vy).toBeCloseTo(-GRAVITY * VDRAG, 12);
    run(w, r, 20);
    expect(w.y).toBeCloseTo(T, 6);
    expect(w.y).toBeGreaterThanOrEqual(T);
    expect(w.onGround).toBe(true);
  });

  test('after the snap onto a column published with other terrain: the footprint reaches a neighbour 2 blocks higher than `heightAt` under the centre, so the body is lifted onto it on the same tick', () => {
    // Stone below y 65; at block x 1 stone up to y 66 (its top 67). The centre at x 0.9 is over x 0 (`heightAt` 65),
    // the footprint (0.6 … 1.2) over x 1 too.
    const r = canned({ floorTop: 65, unpublishedFromX: -Infinity });
    for (let z = -2; z <= 2; z++) r.set(1, 65, z, STONE).set(1, 66, z, STONE);
    const w = createWalkState();
    arriveFeet(w, 0.9, 90, 0.5);
    run(w, r, 5);
    expect(w.y).toBe(90);
    r.unpublishFromX(Infinity);
    expect(r.heightAt('motionBlocking', 0, 0)).toBe(65);
    walkTick(w, r, 0, 0, false, false, false);
    expect([w.snapY, w.snapPending]).toEqual([65, false]);
    expect([w.py, w.y, w.vy]).toEqual([67, 67, -GRAVITY * VDRAG]);
    run(w, r, 20);
    expect(w.y).toBeCloseTo(67, 6);
    expect(w.onGround).toBe(true);
  });

  test('Review Focus 3: the column under the feet (feet at a whole y) re-published with ground 3 blocks above the feet: on the next tick the feet are at the ground\'s top, then the body falls normally', () => {
    // Standing on the old ground (top 70).
    const before = canned({ floorTop: 70 });
    const w = bodyAt(0.5, 70, 0.5);
    run(w, before, 5);
    expect(w.y).toBeCloseTo(70, 6);
    const y0 = w.y;
    // An Apply frees the column (the body hovers, as the unloaded rule says), then re-publishes it with its top at 73.
    const after = canned({ floorTop: 73, unpublishedFromX: -Infinity });
    run(w, after, 10);
    expect(w.y).toBe(y0);
    after.unpublishFromX(Infinity);
    walkTick(w, after, 0, 0, false, false, false);
    // Lifted by whole blocks from 70: the first free y is the ground's top.
    expect(y0).toBe(70);
    expect(w.y).toBe(73);
    expect(w.py).toBe(w.y);
    // Then gravity as on any tick: vy (0 − 0.08) · 0.98, and the body stays on the new ground.
    expect(w.vy).toBeCloseTo(-GRAVITY * VDRAG, 12);
    run(w, after, 1);
    expect(w.y).toBeCloseTo(73, 6);
    expect(w.y).toBeGreaterThanOrEqual(73);
    expect(w.onGround).toBe(true);
    expect(w.vy).toBeCloseTo(-GRAVITY * VDRAG, 12);
  });

  test('a stone placed into the body (an edit landing): lifted on the next tick', () => {
    const r = canned();
    const w = bodyAt(0.5, 70, 0.5);
    run(w, r, 5);
    const y0 = w.y;
    // A stone at the chest (y 71): the first free y is above it, standing on it.
    r.set(0, 71, 0, STONE);
    walkTick(w, r, 0, 0, false, false, false);
    expect(w.y).toBe(y0 + 2);
    expect(w.y).toBeCloseTo(72, 6);
    run(w, r, 20);
    expect(w.y).toBeCloseTo(72, 6);
    expect(w.onGround).toBe(true);
  });

  test('feet 1 block inside the stone floor of a 2-block air pocket under 10 blocks of stone: lifted into the pocket (the first free y), not above the stone', () => {
    // Stone below y 92; a 3 × 3 pocket of air at y 80 and 81; 10 blocks of stone (82 … 91) above it.
    const r = canned({ floorTop: 92 });
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) r.set(x, 80, z, AIR).set(x, 81, z, AIR);
    const w = bodyAt(0.5, 79, 0.5, false);
    walkTick(w, r, 0, 0, false, false, false);
    expect(w.y).toBe(80);
    run(w, r, 20);
    expect(w.y).toBeCloseTo(80, 6);
    expect(w.onGround).toBe(true);
  });

  test('a canned reader solid from −64 to 450: the scan stops with the feet at 400 (`UNSTUCK_MAX_Y`)', () => {
    const r: WalkReader = {
      blockAt: (_x, y) => (y >= -64 && y < 450 ? STONE : AIR),
      fluidAt: () => 0,
      publishedAt: () => true,
      heightAt: () => 450,
    };
    expect(UNSTUCK_MAX_Y).toBe(400);
    const w = bodyAt(0.5, 70, 0.5, false);
    walkTick(w, r, 0, 0, false, false, false);
    expect(w.y).toBe(400);
    // The tick started from rest there (vy 0), then gravity.
    expect(w.vy).toBeCloseTo(-GRAVITY * VDRAG, 12);
    // A fraction left by a lift does not take it past 400 either.
    const f = bodyAt(0.5, 70.25, 0.5, false);
    walkTick(f, r, 0, 0, false, false, false);
    expect(f.y).toBe(400);
  });

  test('the scan allocates nothing over 10,000 ticks that lift the body', () => {
    // Stone below y 70, a stone at the chest at x 0: every tick starts inside it and is lifted.
    const r = canned().set(0, 71, 0, STONE);
    const w = createWalkState();
    const call = (): void => {
      setFeet(w, 0.5, 69.5, 0.5);
      walkTick(w, r, 0, 0, false, false, false);
    };
    call();
    expect(w.y).toBe(72.5);
    expectNoAllocation(call);
  });
});

describe('walkStep: the accumulator and the drawn eye (SP5a spec §3.1, §3.2)', () => {
  const held = (...a: Action[]): ReadonlySet<Action> => new Set<Action>(a);

  test('`walkStep` with dt 0.016 runs 0 or 1 ticks and interpolates the eye; dt 0.4 runs 5 ticks', () => {
    const r = canned();
    const w = bodyAt(-60.5, 70, 0.5);
    const eye = { x: 0, y: 0, z: 0 };
    // Yaw 90 faces +x (east): W walks east; warm up to the steady speed.
    for (let i = 0; i < 300; i++) walkStep(w, r, held('forward'), 90, TICK_S, eye);
    let ticks = 0;
    for (let i = 0; i < 100; i++) {
      const x = w.x;
      walkStep(w, r, held('forward'), 90, 0.016, eye);
      const n = Math.round((w.x - x) / 0.2203);
      expect([0, 1]).toContain(n);
      ticks += n;
      expect(w.acc).toBeGreaterThanOrEqual(0);
      expect(w.acc).toBeLessThan(TICK_S);
      const t = w.acc / TICK_S;
      expect(eye.x).toBeCloseTo(w.px + (w.x - w.px) * t, 12);
      expect(eye.y).toBeCloseTo(w.py + (w.y - w.py) * t + EYE, 12);
      expect(eye.z).toBeCloseTo(w.pz + (w.z - w.pz) * t, 12);
      expect(eye.x).toBeGreaterThanOrEqual(w.px);
      expect(eye.x).toBeLessThanOrEqual(w.x);
    }
    // 100 frames of 16 ms are 1.6 s: 32 ticks.
    expect(Math.abs(ticks - 32)).toBeLessThanOrEqual(1);
    const x = w.x;
    walkStep(w, r, held('forward'), 90, 0.4, eye);
    expect((w.x - x) / 0.2203).toBeCloseTo(MAX_TICKS, 2);
    expect(MAX_TICKS).toBe(5);
    expect(w.acc).toBeLessThan(TICK_S);
    // Yaw 0 faces −z, D strafes east; the diagonal W + D is normalised.
    const d = bodyAt(-60.5, 70, 60.5);
    for (let i = 0; i < 250; i++) walkStep(d, r, held('forward', 'right'), 0, TICK_S, eye);
    const x0 = d.x;
    const z0 = d.z;
    walkStep(d, r, held('forward', 'right'), 0, TICK_S, eye);
    expect(Math.abs(Math.hypot(d.x - x0, d.z - z0) - 0.2203)).toBeLessThanOrEqual(0.0005);
    expect(d.x - x0).toBeGreaterThan(0);
    expect(d.x - x0).toBeCloseTo(-(d.z - z0), 9);
  });

  test('`setFeet` makes the drawn eye jump with no interpolation', () => {
    const r = canned();
    const w = bodyAt(0.5, 70, 0.5);
    const eye = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 30; i++) walkStep(w, r, held('forward'), 90, 0.021, eye);
    expect(w.vx).not.toBe(0);
    setFeet(w, 100.5, 80, -20.5);
    expect([w.px, w.py, w.pz, w.x, w.y, w.z]).toEqual([100.5, 80, -20.5, 100.5, 80, -20.5]);
    expect([w.vx, w.vy, w.vz, w.acc]).toEqual([0, 0, 0, 0]);
    // No stale ground: F in mid-air after an earlier walk cannot jump on its first tick.
    expect(w.onGround).toBe(false);
    // No stale snap either; the last snap's y stays (NaN: none yet).
    arriveFeet(w, 100.5, 80, -20.5);
    setFeet(w, 100.5, 80, -20.5);
    expect(w.snapPending).toBe(false);
    expect(w.snapY).toBeNaN();
    walkStep(w, r, held(), 90, 0.01, eye);
    expect(eye).toEqual({ x: 100.5, y: 80 + EYE, z: -20.5 });
    expect(EYE).toBe(1.62);
  });

  test('`walkStep` allocates nothing over 10,000 calls', () => {
    // A flat floor of stone and ice, a wall to bump into, water and a ladder on the way, an unpublished strip.
    const r: WalkReader = {
      blockAt: (x, y, z) => (x >= 40 ? -1 : y < 70 ? (z > 0 ? ICE : STONE) : x === 20 && y < 72 ? STONE : x === 10 && z === 0 ? LADDER : AIR),
      fluidAt: (x, y) => (x >= 30 && x < 40 && y < 72 ? WATER_SOURCE : 0),
      publishedAt: (x) => x < 40,
      heightAt: (_kind, x) => (x >= 40 ? null : 70),
    };
    const w = bodyAt(0.5, 70, 0.5);
    const eye = { x: 0, y: 0, z: 0 };
    const sets: ReadonlySet<Action>[] = [held('forward'), held('forward', 'sprint', 'up'), held('left', 'down'), held('back', 'right'), held()];
    let k = 0;
    // Literal dts: a double read from an array and passed on would be boxed by the test itself.
    const call = (): void => {
      const h = sets[(k >> 6) % 5]!;
      switch (k % 3) {
        case 0: walkStep(w, r, h, 90, 0.016, eye); break;
        case 1: walkStep(w, r, h, 45, 0.033, eye); break;
        default: walkStep(w, r, h, 200, 0.007, eye); break;
      }
      if ((k & 1023) === 1023) setFeet(w, 0.5, 70, 0.5);
      k++;
    };
    expectNoAllocation(call);
  });
});

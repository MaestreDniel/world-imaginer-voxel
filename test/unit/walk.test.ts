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
  AIR_DRAG, EYE, MAX_TICKS, TICK_S, createWalkState, setFeet, walkStep, walkTick, type WalkState,
} from '../../src/player/walk';
import type { VoxelReader } from '../../src/player/physics';
import type { Action } from '../../src/player/keymap';
import { AIR, ICE, LADDER, PACKED_ICE, STONE } from '../../src/world/blocks/index';
import { LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';

interface Canned extends VoxelReader {
  /** Sets one voxel (block and fluid byte); the rest follows the floor and the fluid layer. */
  set(x: number, y: number, z: number, state: number, fluid?: number): Canned;
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

/** A Smi key for |x|, |y − 64|, |z| < 128 (no allocation on a `Map` read). */
const key = (x: number, y: number, z: number): number => ((x + 128) * 256 + (y - 64 + 128)) * 256 + (z + 128);

function canned(w: World = {}): Canned {
  const floorTop = w.floorTop ?? 70;
  const floor = w.floor ?? ((): number => STONE);
  const fluid = w.fluid ?? ((): number => 0);
  const unpub = w.unpublishedFromX ?? Infinity;
  const blocks = new Map<number, number>();
  const fluids = new Map<number, number>();
  const r: Canned = {
    blockAt: (x, y, z) => (x >= unpub ? -1 : (blocks.get(key(x, y, z)) ?? (y < floorTop ? floor(x, z) : AIR))),
    fluidAt: (x, y, z) => (x >= unpub ? 0 : (fluids.get(key(x, y, z)) ?? fluid(x, y, z))),
    publishedAt: (x) => x < unpub,
    set(x, y, z, state, f = 0) {
      blocks.set(key(x, y, z), state);
      fluids.set(key(x, y, z), f);
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
function run(w: WalkState, r: VoxelReader, n: number, k: Keys = {}): [number, number, number] {
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
const steady = (w: WalkState, r: VoxelReader, k: Keys): [number, number, number] => {
  run(w, r, 200, k);
  return run(w, r, 1, k);
};

/** The distance slid along x after letting go (until the body stops). */
function slide(w: WalkState, r: VoxelReader): number {
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
    walkStep(w, r, held(), 90, 0.01, eye);
    expect(eye).toEqual({ x: 100.5, y: 80 + EYE, z: -20.5 });
    expect(EYE).toBe(1.62);
  });

  test('`walkStep` allocates nothing over 10,000 calls', () => {
    // A flat floor of stone and ice, a wall to bump into, water and a ladder on the way, an unpublished strip.
    const r: VoxelReader = {
      blockAt: (x, y, z) => (x >= 40 ? -1 : y < 70 ? (z > 0 ? ICE : STONE) : x === 20 && y < 72 ? STONE : x === 10 && z === 0 ? LADDER : AIR),
      fluidAt: (x, y) => (x >= 30 && x < 40 && y < 72 ? WATER_SOURCE : 0),
      publishedAt: (x) => x < 40,
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
  });
});

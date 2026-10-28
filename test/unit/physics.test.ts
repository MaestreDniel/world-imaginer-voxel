/**
 * The walk's swept AABB (SP5a spec §3.2, "Collision"): a 0.6 × 1.8 box at the feet, moved per axis (y, then x, then z)
 * in substeps of at most 0.35 blocks over a canned reader; `COLLIDE` cube and boxes collide, `none`, fluids and an
 * unpublished column's voxels (−1) never; a horizontal move blocked on the ground is retried 0.6 higher and lowered
 * onto what it finds (step-up, shown on a synthetic 0.5 ledge through `collideTop`); allocates nothing.
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { BODY_H, BODY_W, STEP_UP, SUBSTEP, moveBody, solidAt, type MoveOut, type VoxelReader } from '../../src/player/physics';
import { AIR, DIRT, LADDER, STONE, TORCH } from '../../src/world/blocks/index';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';

const newOut = (): MoveOut => ({ x: 0, y: 0, z: 0, hitX: false, hitY: false, hitZ: false, onGround: false });

interface Canned extends VoxelReader {
  /** Sets one voxel; the canned world is air elsewhere. */
  set(x: number, y: number, z: number, state: number, fluid?: number): Canned;
}

/** A Smi key for |x|, |y − 64|, |z| < 128 (no allocation on a `Map` read). */
const key = (x: number, y: number, z: number): number => ((x + 128) * 256 + (y - 64 + 128)) * 256 + (z + 128);

/**
 * Stone at every y ≤ `floorTop` − 1 (none for −Infinity), the voxels set, air elsewhere; the columns at block
 * x ≥ `unpublishedFromX` are not Published (−1, fluid 0, `publishedAt` false). `ledge`, when given, is the state whose
 * `collideTop` is 0.5 (every other state 1).
 */
function canned(floorTop = 70, unpublishedFromX = Infinity, ledge = -1): Canned {
  const blocks = new Map<number, number>();
  const fluids = new Map<number, number>();
  const r: Canned = {
    blockAt: (x, y, z) => (x >= unpublishedFromX ? -1 : (blocks.get(key(x, y, z)) ?? (y < floorTop ? STONE : AIR))),
    fluidAt: (x, y, z) => (x >= unpublishedFromX ? 0 : (fluids.get(key(x, y, z)) ?? 0)),
    publishedAt: (x) => x < unpublishedFromX,
    set(x, y, z, state, fluid = 0) {
      blocks.set(key(x, y, z), state);
      if (fluid !== 0) fluids.set(key(x, y, z), fluid);
      return r;
    },
  };
  if (ledge >= 0) r.collideTop = (s) => (s === ledge ? 0.5 : 1);
  return r;
}

/** A wall of `state` filling block x = `bx` over y 60 … 89 and z −8 … 8. */
function wallX(r: Canned, bx: number, state = STONE): Canned {
  for (let y = 60; y < 90; y++) for (let z = -8; z <= 8; z++) r.set(bx, y, z, state);
  return r;
}

function move(r: VoxelReader, p: readonly [number, number, number], dx: number, dy: number, dz: number, onGround: boolean): MoveOut {
  const out = newOut();
  moveBody(r, { x: p[0], y: p[1], z: p[2] }, dx, dy, dz, onGround, out);
  return out;
}

/** One walk tick's gravity on the ground ((0 − 0.08) · 0.98, spec §3.2). */
const GRAVITY_TICK = -0.0784;

describe('moveBody (SP5a spec §3.2)', () => {
  test('the body is 0.6 × 1.8, steps up 0.6 and moves in substeps of 0.35', () => {
    expect([BODY_W, BODY_H, STEP_UP, SUBSTEP]).toEqual([0.6, 1.8, 0.6, 0.35]);
  });

  test('falling 10 blocks onto stone stops with the feet at its top, onGround true', () => {
    const out = move(canned(70), [0.5, 80, 0.5], 0, -11, 0, false);
    expect(out.y).toBeCloseTo(70, 6);
    expect(out.y).toBeGreaterThanOrEqual(70);
    expect([out.x, out.z]).toEqual([0.5, 0.5]);
    expect([out.hitX, out.hitY, out.hitZ, out.onGround]).toEqual([false, true, false, true]);
    // Resting there, the next tick's gravity finds the ground again and moves nothing.
    const rest = move(canned(70), [out.x, out.y, out.z], 0, GRAVITY_TICK, 0, true);
    expect(rest.y).toBe(out.y);
    expect(rest.onGround).toBe(true);
  });

  test('a move of 2.0 in x into a wall 1.2 away stops at 0.9 (the half width), hitX', () => {
    // The feet at x −0.2, the wall's face at x 1: the body's east side (x + 0.3) stops at the face.
    const out = move(wallX(canned(70), 1), [-0.2, 70, 0.5], 2, GRAVITY_TICK, 0, true);
    expect(out.x - -0.2).toBeCloseTo(0.9, 6);
    expect(out.x + BODY_W / 2).toBeLessThanOrEqual(1);
    expect([out.y, out.z]).toEqual([70, 0.5]);
    expect([out.hitX, out.hitZ, out.onGround]).toEqual([true, false, true]);
  });

  test('a diagonal into a corner slides along the free axis', () => {
    // Walls at block x 1 and block z −2 (the corner at x 1, z −1).
    const r = wallX(canned(70), 1);
    for (let y = 60; y < 90; y++) for (let x = -8; x <= 0; x++) r.set(x, y, -2, STONE);
    // Along the x wall: x stops at the face, z goes on.
    const slide = move(r, [0.5, 70, 0.5], 1, GRAVITY_TICK, 1, true);
    expect(slide.x).toBeCloseTo(0.7, 6);
    expect(slide.z).toBeCloseTo(1.5, 12);
    expect([slide.hitX, slide.hitZ]).toEqual([true, false]);
    // Along the z wall: z stops at the face, x goes on.
    const back = move(r, [-2.5, 70, -0.5], 1, GRAVITY_TICK, -1, true);
    expect(back.x).toBeCloseTo(-1.5, 12);
    expect(back.z).toBeCloseTo(-0.7, 6);
    expect([back.hitX, back.hitZ]).toEqual([false, true]);
    // Into the corner: both stop.
    const corner = move(r, [0.5, 70, -0.5], 1, GRAVITY_TICK, -1, true);
    expect(corner.x).toBeCloseTo(0.7, 6);
    expect(corner.z).toBeCloseTo(-0.7, 6);
    expect([corner.hitX, corner.hitZ]).toEqual([true, true]);
  });

  test('substeps: a move of 3 per tick does not tunnel through a 1-block wall', () => {
    const r = wallX(canned(70), 2);
    const east = move(r, [0.5, 70, 0.5], 3, GRAVITY_TICK, 0, true);
    expect(east.x).toBeCloseTo(1.7, 6);
    expect(east.hitX).toBe(true);
    const west = move(wallX(canned(70), -2), [0.5, 70, 0.5], -3, GRAVITY_TICK, 0, true);
    expect(west.x).toBeCloseTo(-0.7, 6);
    expect(west.hitX).toBe(true);
    // A 1-block floor (stone at y 69 only, air below) stops a fall of 3 per tick.
    const floor = canned(-Infinity);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) floor.set(x, 69, z, STONE);
    const fall = move(floor, [0.5, 71.5, 0.5], 0, -3, 0, false);
    expect(fall.y).toBeCloseTo(70, 6);
    expect(fall.onGround).toBe(true);
    // And a ceiling 1 block thick stops a rise of 3: the head (feet + 1.8) stops at its underside.
    const ceil = canned(-Infinity);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) ceil.set(x, 75, z, STONE);
    const rise = move(ceil, [0.5, 72, 0.5], 0, 3, 0, false);
    expect(rise.y + BODY_H).toBeCloseTo(75, 6);
    expect([rise.hitY, rise.onGround]).toEqual([true, false]);
  });

  test('step-up onto a 0.5 ledge succeeds, the feet ending at its top; onto a 1-block wall fails', () => {
    // The ledge: `DIRT` at block x 1, y 70, colliding over y 70 … 70.5 by the canned `collideTop`.
    const ledge = canned(70, Infinity, DIRT);
    for (let z = -8; z <= 8; z++) ledge.set(1, 70, z, DIRT);
    const up = move(ledge, [0.5, 70, 0.5], 0.5, GRAVITY_TICK, 0, true);
    expect(up.x).toBeCloseTo(1, 12);
    expect(up.y).toBeCloseTo(70.5, 6);
    expect(up.y).toBeGreaterThanOrEqual(70.5);
    expect([up.hitX, up.onGround]).toEqual([false, true]);
    // In the air the same move is blocked by the ledge's side.
    const air = move(ledge, [0.5, 70, 0.5], 0.5, 0, 0, false);
    expect(air.x).toBeCloseTo(0.7, 6);
    expect(air.hitX).toBe(true);
    // A full block in its place: the retry 0.6 higher is blocked too, and the body stays at the face.
    const wall = canned(70);
    for (let z = -8; z <= 8; z++) wall.set(1, 70, z, STONE);
    const blocked = move(wall, [0.5, 70, 0.5], 0.5, GRAVITY_TICK, 0, true);
    expect(blocked.x).toBeCloseTo(0.7, 6);
    expect(blocked.y).toBe(70);
    expect([blocked.hitX, blocked.onGround]).toEqual([true, true]);
  });

  test("an unpublished column's voxels never collide", () => {
    // Block x ≥ 1 is not Published: stone there reads −1.
    const r = wallX(canned(70, 1), 1);
    expect(solidAt(r, 1, 70, 0)).toBe(false);
    expect(solidAt(r, 1, 60, 0)).toBe(false);
    const east = move(r, [0.5, 70, 0.5], 2, GRAVITY_TICK, 0, true);
    expect(east.x).toBeCloseTo(2.5, 12);
    expect(east.hitX).toBe(false);
    const fall = move(r, [2.5, 70, 0.5], 0, -5, 0, false);
    expect(fall.y).toBeCloseTo(65, 12);
    expect([fall.hitY, fall.onGround]).toEqual([false, false]);
  });

  test('solidAt: cube and boxes collide (as cube until SP8a); air, torches, ladders and water never', () => {
    const r = canned(-Infinity).set(0, 70, 0, STONE).set(1, 70, 0, TORCH).set(2, 70, 0, LADDER).set(3, 70, 0, AIR, WATER_SOURCE);
    expect([0, 1, 2, 3, 4].map((x) => solidAt(r, x, 70, 0))).toEqual([true, false, false, false, false]);
  });

  test('allocates nothing over 10,000 moves', () => {
    // A wall at block x 3, a 0.5 ledge at block x −2, columns from block x 6 not Published.
    const r = wallX(canned(70, 6, DIRT), 3);
    for (let z = -8; z <= 8; z++) r.set(-2, 70, z, DIRT);
    const p = { x: 0.5, y: 70, z: 0.5 };
    const far = { x: 6.5, y: 70, z: 0.5 };
    const out = newOut();
    let k = 0;
    let hits = 0;
    // Literal lengths: a double read from an array and passed on would be boxed by the test itself.
    const call = (): void => {
      switch (k % 6) {
        case 0: moveBody(r, p, 3, -0.0784, 0.2, true, out); break; // into the wall; the retry is dropped
        case 1: moveBody(r, p, -3, -0.0784, -0.2, true, out); break; // up the ledge
        case 2: moveBody(r, p, 0.2, 0.42, 0.5, true, out); break; // a jump
        case 3: moveBody(r, p, 0.5, -3, -0.5, false, out); break; // a fall onto the ground
        case 4: moveBody(r, far, 2, -3, 0, false, out); break; // through an unpublished column
        default: moveBody(r, p, 0, 0, 3, false, out); break;
      }
      if (out.hitX || out.hitY || out.hitZ) hits++;
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
    expect(hits).toBeGreaterThan(0);
    expect(readings.length, 'every attempt saw a GC').toBeGreaterThan(0);
    expect(readings[readings.length - 1]!, `heap growth over 10,000 moves (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
  });
});

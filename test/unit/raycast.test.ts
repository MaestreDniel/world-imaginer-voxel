/**
 * The block raycast (SP5a spec §3.5, §4.2): an Amanatides-Woo DDA over a canned reader. `'block'` passes through air and
 * fluids and hits any other state, a `SHAPE` box state by its provisional box (§1.3); `'fluid'` (the empty bucket)
 * stops at the first voxel with fluid before any block and misses at a block (a box state by its box); an unpublished
 * column (−1) ends the ray in both modes. Each hit reports the voxel, the face it entered by, the point and the state.
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { lookVectorInto } from '../../src/player/fly';
import { REACH_FLY, REACH_WALK, castRay, castRayFrom, createRayHit, type RayHit } from '../../src/player/raycast';
import { AIR, BEDROCK, LADDER, REGISTRY, STONE, TORCH } from '../../src/world/blocks/index';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';

/** A Smi key for |x|, |y − 64|, |z| < 128 (no allocation on a `Map` read). */
const key = (x: number, y: number, z: number): number => ((x + 128) * 256 + (y - 64 + 128)) * 256 + (z + 128);

interface Canned {
  blockAt(x: number, y: number, z: number): number;
  fluidAt(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, state: number, fluid?: number): Canned;
}

/** Air everywhere but the voxels set; columns at block x ≥ `unpublishedFromX` are not Published (−1, fluid 0). */
function canned(unpublishedFromX = Infinity): Canned {
  const blocks = new Map<number, number>();
  const fluids = new Map<number, number>();
  const r: Canned = {
    blockAt: (x, y, z) => (x >= unpublishedFromX ? -1 : (blocks.get(key(x, y, z)) ?? AIR)),
    fluidAt: (x, y, z) => (x >= unpublishedFromX ? 0 : (fluids.get(key(x, y, z)) ?? 0)),
    set(x, y, z, state, fluid = 0) {
      blocks.set(key(x, y, z), state);
      if (fluid !== 0) fluids.set(key(x, y, z), fluid);
      return r;
    },
  };
  return r;
}

/** The eye at the centre of voxel (0, 70, 0). */
const EYE = [0.5, 70.5, 0.5] as const;

function cast(r: Canned, o: readonly number[], d: readonly number[], reach: number, mode: 'block' | 'fluid' = 'block'): RayHit {
  return castRay(r, o[0]!, o[1]!, o[2]!, d[0]!, d[1]!, d[2]!, reach, mode, createRayHit());
}

/** The hit as [x, y, z, face, px, py, pz, state], or null on a miss. */
const hitOf = (h: RayHit): number[] | null => (h.hit ? [h.x, h.y, h.z, h.face, h.px, h.py, h.pz, h.state] : null);

const facing = (type: number, f: string): number => REGISTRY.withProp(type, 'facing', f);

/** The heap in use, less V8's code spaces (compiled code is not an allocation of the code under test). */
const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
const heapUsed = (): number => {
  let b = 0;
  for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) b += s.space_used_size;
  return b;
};

/**
 * Expects 10,000 calls of `call` (already warmed up) to grow the heap by less than 256 KB: up to 3 attempts, each after
 * two full GCs, an attempt that saw a GC discarded; the last attempt kept is the one judged. `what` names the calls.
 */
function heapGrowthOver(call: () => void, what: string): void {
  v8.setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
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
  expect(readings.length, `10,000 ${what}: every attempt saw a GC`).toBeGreaterThan(0);
  expect(readings[readings.length - 1]!, `heap growth over 10,000 ${what} (attempts: ${readings.join(', ')})`).toBeLessThan(256 * 1024);
}

describe('castRay (SP5a spec §3.5)', () => {
  test('the reaches are 6 walking and 10 flying', () => {
    expect([REACH_WALK, REACH_FLY]).toEqual([6, 10]);
  });

  test('a stone 3 blocks ahead on each of the six axes reports the facing face', () => {
    const r = canned()
      .set(3, 70, 0, STONE).set(-3, 70, 0, STONE)
      .set(0, 73, 0, STONE).set(0, 67, 0, STONE)
      .set(0, 70, 3, STONE).set(0, 70, -3, STONE);
    expect(hitOf(cast(r, EYE, [1, 0, 0], REACH_WALK))).toEqual([3, 70, 0, FACE_WEST, 3, 70.5, 0.5, STONE]);
    expect(hitOf(cast(r, EYE, [-1, 0, 0], REACH_WALK))).toEqual([-3, 70, 0, FACE_EAST, -2, 70.5, 0.5, STONE]);
    expect(hitOf(cast(r, EYE, [0, 1, 0], REACH_WALK))).toEqual([0, 73, 0, FACE_DOWN, 0.5, 73, 0.5, STONE]);
    expect(hitOf(cast(r, EYE, [0, -1, 0], REACH_WALK))).toEqual([0, 67, 0, FACE_UP, 0.5, 68, 0.5, STONE]);
    expect(hitOf(cast(r, EYE, [0, 0, 1], REACH_WALK))).toEqual([0, 70, 3, FACE_NORTH, 0.5, 70.5, 3, STONE]);
    expect(hitOf(cast(r, EYE, [0, 0, -1], REACH_WALK))).toEqual([0, 70, -3, FACE_SOUTH, 0.5, 70.5, -2, STONE]);
    // A diagonal ray enters by the face it crosses last: from (0.5, 70.5, 0.5) towards +x, +z it reaches x 3 at z 2.5.
    const d = 1 / Math.hypot(1, 0.8);
    const h = cast(canned().set(3, 70, 2, STONE), EYE, [d, 0, 0.8 * d], REACH_WALK);
    expect([h.hit, h.x, h.y, h.z, h.face]).toEqual([true, 3, 70, 2, FACE_WEST]);
    expect(h.px).toBeCloseTo(3, 12);
    expect(h.pz).toBeCloseTo(2.5, 12);
  });

  test('water in between is passed; with \'fluid\' the water voxel is the hit', () => {
    const r = canned().set(1, 70, 0, AIR, WATER_SOURCE).set(2, 70, 0, AIR, WATER_SOURCE).set(3, 70, 0, STONE);
    expect(hitOf(cast(r, EYE, [1, 0, 0], REACH_WALK))).toEqual([3, 70, 0, FACE_WEST, 3, 70.5, 0.5, STONE]);
    expect(hitOf(cast(r, EYE, [1, 0, 0], REACH_WALK, 'fluid'))).toEqual([1, 70, 0, FACE_WEST, 1, 70.5, 0.5, AIR]);
  });

  test('water behind a stone wall within reach: \'fluid\' misses', () => {
    const r = canned().set(2, 70, 0, STONE).set(3, 70, 0, AIR, WATER_SOURCE);
    expect(cast(r, EYE, [1, 0, 0], REACH_WALK, 'fluid').hit).toBe(false);
    expect(cast(r, EYE, [1, 0, 0], REACH_FLY, 'fluid').hit).toBe(false);
    expect(hitOf(cast(r, EYE, [1, 0, 0], REACH_WALK))).toEqual([2, 70, 0, FACE_WEST, 2, 70.5, 0.5, STONE]);
  });

  test('a waterlogged ladder: \'fluid\' hits it', () => {
    // A north-facing ladder's plate is at z 7/8 … 1; the water fills the voxel, which the ray enters at z 2.
    const r = canned().set(0, 70, 2, LADDER, WATER_SOURCE);
    expect(hitOf(cast(r, EYE, [0, 0, 1], REACH_WALK, 'fluid'))).toEqual([0, 70, 2, FACE_NORTH, 0.5, 70.5, 2, LADDER]);
    // A ray through the voxel at z 0.5, which misses the plate: 'fluid' hits the water, 'block' passes the voxel.
    const e = canned().set(2, 70, 0, LADDER, WATER_SOURCE);
    expect(hitOf(cast(e, EYE, [1, 0, 0], REACH_WALK, 'fluid'))).toEqual([2, 70, 0, FACE_WEST, 2, 70.5, 0.5, LADDER]);
    expect(cast(e, EYE, [1, 0, 0], REACH_WALK).hit).toBe(false);
    // An east-facing ladder's plate (x 0 … 1/8) is hit by 'block' where the ray enters its voxel.
    const east = facing(LADDER, 'east');
    expect(hitOf(cast(canned().set(2, 70, 0, east), EYE, [1, 0, 0], REACH_WALK))).toEqual([2, 70, 0, FACE_WEST, 2, 70.5, 0.5, east]);
  });

  test('a stone at 6.5 blocks: missed at reach 6, hit at 10', () => {
    const r = canned().set(0, 70, -7, STONE);
    expect(cast(r, EYE, [0, 0, -1], REACH_WALK).hit).toBe(false);
    expect(hitOf(cast(r, EYE, [0, 0, -1], REACH_FLY))).toEqual([0, 70, -7, FACE_SOUTH, 0.5, 70.5, -6, STONE]);
    // Nothing past the reach: a stone at 10.5 blocks is missed flying.
    expect(cast(canned().set(0, 70, -11, STONE), EYE, [0, 0, -1], REACH_FLY).hit).toBe(false);
  });

  test('a torch: a ray through its stick hits it, one through the cell beside the stick misses it and hits the wall behind', () => {
    // The torch's stick: x 3/8 … 5/8, y 0 … 5/8, z 3/8 … 5/8 of voxel (2, 70, 0); the wall at x 4.
    const r = canned().set(2, 70, 0, TORCH).set(4, 70, 0, STONE);
    expect(hitOf(cast(r, [0.5, 70.25, 0.5], [1, 0, 0], REACH_WALK))).toEqual([2, 70, 0, FACE_WEST, 2.375, 70.25, 0.5, TORCH]);
    expect(hitOf(cast(r, [0.5, 70.25, 0.125], [1, 0, 0], REACH_WALK))).toEqual([4, 70, 0, FACE_WEST, 4, 70.25, 0.125, STONE]);
    // Above the stick (y 70.8 > 70 + 5/8): the wall too.
    expect(hitOf(cast(r, [0.5, 70.8, 0.5], [1, 0, 0], REACH_WALK))).toEqual([4, 70, 0, FACE_WEST, 4, 70.8, 0.5, STONE]);
    // From above, the stick's top face at y 70 + 5/8.
    expect(hitOf(cast(r, [2.5, 72.5, 0.5], [0, -1, 0], REACH_WALK))).toEqual([2, 70, 0, FACE_UP, 2.5, 70.625, 0.5, TORCH]);
    // The empty bucket: a ray past the stick continues to the water behind it; one through the stick misses.
    const w = canned().set(2, 70, 0, TORCH).set(3, 70, 0, AIR, WATER_SOURCE);
    expect(hitOf(cast(w, [0.5, 70.25, 0.125], [1, 0, 0], REACH_WALK, 'fluid'))).toEqual([3, 70, 0, FACE_WEST, 3, 70.25, 0.125, AIR]);
    expect(cast(w, [0.5, 70.25, 0.5], [1, 0, 0], REACH_WALK, 'fluid').hit).toBe(false);
  });

  test('a ladder\'s plate is hit at z 7/8', () => {
    const r = canned().set(0, 70, 2, LADDER);
    expect(hitOf(cast(r, EYE, [0, 0, 1], REACH_WALK))).toEqual([0, 70, 2, FACE_NORTH, 0.5, 70.5, 2.875, LADDER]);
    // From behind (the wall's side), the plate's back on the voxel's boundary.
    expect(hitOf(cast(r, [0.5, 70.5, 4.5], [0, 0, -1], REACH_WALK))).toEqual([0, 70, 2, FACE_SOUTH, 0.5, 70.5, 3, LADDER]);
  });

  test('a ray into an unpublished column (−1) reports no hit', () => {
    // Block x ≥ 16 is column 1, not Published: the ray ends there, in both modes.
    const r = canned(16);
    expect(cast(r, [14.5, 70.5, 0.5], [1, 0, 0], REACH_FLY).hit).toBe(false);
    expect(cast(r, [14.5, 70.5, 0.5], [1, 0, 0], REACH_FLY, 'fluid').hit).toBe(false);
    // A block before the border is still hit.
    expect(hitOf(cast(r.set(15, 70, 0, STONE), [12.5, 70.5, 0.5], [1, 0, 0], REACH_FLY))).toEqual([15, 70, 0, FACE_WEST, 15, 70.5, 0.5, STONE]);
  });

  test('a ray down past y −64 reports no hit (the store\'s padded bedrock below the world is not a voxel)', () => {
    // The store reads `BEDROCK` below y −64 (store.ts `blockAt`, the padded copy's border); here the floor's bedrock
    // at y −64 is broken, so the ray goes on into the padding: no hit in either mode, at either reach.
    const below = (r: Canned): Canned => ({ ...r, blockAt: (x, y, z) => (y < -64 ? BEDROCK : r.blockAt(x, y, z)) });
    const r = below(canned());
    for (const reach of [REACH_WALK, REACH_FLY]) {
      expect(cast(r, [0.5, -62.5, 0.5], [0, -1, 0], reach).hit).toBe(false);
      expect(cast(r, [0.5, -62.5, 0.5], [0, -1, 0], reach, 'fluid').hit).toBe(false);
      const d = 1 / Math.hypot(0.4, 1, 0.3);
      expect(cast(r, [0.5, -63.5, 0.5], [0.4 * d, -d, 0.3 * d], reach).hit).toBe(false);
    }
    // The floor's own bedrock at y −64 is still hit, by its top face.
    const floor = below(canned().set(0, -64, 0, BEDROCK));
    expect(hitOf(cast(floor, [0.5, -62.5, 0.5], [0, -1, 0], REACH_WALK))).toEqual([0, -64, 0, FACE_UP, 0.5, -63, 0.5, BEDROCK]);
  });

  test('an eye inside a block hits it at the eye, by the face the look\'s main axis enters', () => {
    const r = canned().set(0, 70, 0, STONE);
    expect(hitOf(cast(r, EYE, [0, 0, -1], REACH_WALK))).toEqual([0, 70, 0, FACE_SOUTH, 0.5, 70.5, 0.5, STONE]);
    const d = 1 / Math.hypot(0.3, 1);
    expect(hitOf(cast(r, EYE, [0.3 * d, -d, 0], REACH_WALK))?.slice(0, 4)).toEqual([0, 70, 0, FACE_UP]);
  });

  test('castRay allocates nothing over 10,000 rays', () => {
    // A scene with every path: stone, water, a torch's stick hit and missed, a waterlogged ladder, an unpublished column.
    const r = canned(8)
      .set(3, 70, 0, STONE).set(0, 70, -3, STONE).set(0, 66, 0, STONE)
      .set(-2, 70, 0, TORCH).set(-4, 70, 0, STONE)
      .set(0, 70, 2, LADDER, WATER_SOURCE).set(1, 70, 1, AIR, WATER_SOURCE);
    const out = createRayHit();
    const look = new Float64Array(3);
    // Whole degrees (Smis) and literal ray arguments: a double read from an array and passed to a call is boxed at the
    // call site (16 B), which the caller's budget holds (the frame step's, `zeroAlloc.test.ts`), not castRay's.
    const yaws = Int32Array.of(0, 45, 90, 135, 180, 225, 270, 315, 12, 200);
    const pitches = Int32Array.of(0, -30, 10, -89, 60);
    const ray = (j: number, reach: number, mode: 'block' | 'fluid'): RayHit => {
      switch (j) {
        case 0: return castRay(r, 0.5, 70.5, 0.5, 1, 0, 0, reach, mode, out);
        case 1: return castRay(r, 0.5, 70.5, 0.5, 0, 0, -1, reach, mode, out);
        case 2: return castRay(r, 0.5, 70.5, 0.5, 0, -1, 0, reach, mode, out);
        case 3: return castRay(r, 0.5, 70.5, 0.5, -1, 0, 0, reach, mode, out);
        case 4: return castRay(r, 0.5, 70.5, 0.125, -1, 0, 0, reach, mode, out);
        case 5: return castRay(r, 0.5, 70.5, 0.5, 0, 0, 1, reach, mode, out);
        case 6: return castRay(r, 0.5, 70.5, 0.5, 0.7071067811865476, 0, 0.7071067811865476, reach, mode, out);
        case 7: return castRay(r, 0.5, 70.5, 0.5, 0.6, -0.48, 0.64, reach, mode, out);
        default: return castRay(r, 5.5, 75.5, 0.5, 1, 0, 0, reach, mode, out);
      }
    };
    let hits = 0;
    let k = 0;
    const call = (): void => {
      lookVectorInto(look, yaws[k % 10]!, pitches[k % 5]!);
      if (ray(k % 9, (k & 1) === 0 ? REACH_WALK : REACH_FLY, (k & 2) === 0 ? 'block' : 'fluid').hit) hits++;
      k++;
    };
    for (let i = 0; i < 100_000; i++) call();
    heapGrowthOver(call, 'rays');
    expect(hits).toBeGreaterThan(0);
  });

  test('castRay along one fixed look allocates nothing, whatever its signs: each of the 8 sign patterns on a fresh module, whose DDA has seen no other (SP5a spec §3.5, D25; Task 35)', async () => {
    // The frame's aim casts the same look every frame at rest (the zero-allocation frame step, zeroAlloc.test.ts), so
    // its DDA may be optimized having seen one sign per axis; the earlier tests here cast every sign, so a fresh module
    // instance (fresh closures, no type feedback) is cast for each pattern. Floor stone up to y 66, a ceiling from y 75:
    // a look down or up hits within 10 blocks, after several steps.
    const r = { blockAt: (_x: number, y: number, _z: number): number => (y <= 66 || y >= 75 ? STONE : AIR), fluidAt: (): number => 0 };
    // The look's components as tagged (boxed) values, as the page passes them: the harness itself allocates nothing.
    const look: number[] = [{} as never, 0, 0];
    for (let pattern = 0; pattern < 8; pattern++) {
      vi.resetModules();
      const fresh = await import('../../src/player/raycast');
      look[0] = pattern & 1 ? -0.6 : 0.6;
      look[1] = pattern & 2 ? -0.48 : 0.48;
      look[2] = pattern & 4 ? -0.64 : 0.64;
      const out = fresh.createRayHit();
      let hits = 0;
      const call = (): void => {
        if (fresh.castRay(r, 0.5, 70.5, 0.5, look[0]!, look[1]!, look[2]!, REACH_FLY, 'block', out).hit) hits++;
      };
      for (let i = 0; i < 100_000; i++) call();
      heapGrowthOver(call, `rays, pattern ${pattern}`);
      expect([hits > 0, out.y], `pattern ${pattern}`).toEqual([true, pattern & 2 ? 66 : 75]);
    }
  });

  test('castRayFrom reads the ray from an array: castRay\'s results; the frame\'s pattern (the eye and the look written into it, then the cast) allocates nothing over 10,000 casts (Task 35)', () => {
    const r = canned(8)
      .set(3, 70, 0, STONE).set(0, 66, 0, STONE).set(-2, 70, 0, TORCH).set(0, 70, 2, LADDER, WATER_SOURCE);
    const ray = new Float64Array(6);
    const rays: Array<[number, number, number, number, number, number]> = [
      [0.5, 70.5, 0.5, 1, 0, 0], [0.5, 70.5, 0.5, 0, -1, 0], [0.5, 70.5, 0.125, -1, 0, 0], [0.5, 70.5, 0.5, 0, 0, 1],
      [0.5, 70.5, 0.5, 0.6, -0.48, 0.64], [5.5, 75.5, 0.5, 1, 0, 0],
    ];
    for (const [ox, oy, oz, dx, dy, dz] of rays) {
      for (const mode of ['block', 'fluid'] as const) {
        ray.set([ox, oy, oz, dx, dy, dz]);
        const a = hitOf(castRay(r, ox, oy, oz, dx, dy, dz, REACH_FLY, mode, createRayHit()));
        expect(hitOf(castRayFrom(r, ray, REACH_FLY, mode, createRayHit())), `${[ox, oy, oz, dx, dy, dz].join(',')} ${mode}`).toEqual(a);
      }
    }
    // The page's aim: the camera's doubles and its look written into one array each frame (no double passed to a call).
    const floor = { blockAt: (_x: number, y: number, _z: number): number => (y <= 66 ? STONE : AIR), fluidAt: (): number => 0 };
    const eye = { x: 0.5, y: 70.5, z: 0.5, yaw: 37.5, pitch: -30.5 };
    const dir = ray.subarray(3);
    const out = createRayHit();
    let hits = 0;
    let calls = 0;
    const call = (): void => {
      calls++;
      ray[0] = eye.x;
      ray[1] = eye.y;
      ray[2] = eye.z;
      lookVectorInto(dir, eye.yaw, eye.pitch);
      if (castRayFrom(floor, ray, REACH_FLY, 'block', out).hit) hits++;
    };
    for (let i = 0; i < 100_000; i++) call();
    heapGrowthOver(call, 'casts');
    // Every cast hit the floor.
    expect([hits, out.hit, out.y]).toEqual([calls, true, 66]);
  });
});

/**
 * The interaction rules (SP5a spec §4.2, D7) over a canned reader: break, place (the target, the column gate, the
 * body, the fluid modes, the oriented states), the buckets, the empty bucket and pick. Each edit's `expect` is the
 * voxel's value read now (§4.1).
 */
import { describe, expect, test } from 'vitest';
import { lookVectorInto } from '../../src/player/fly';
import { bodyOf, breakAt, emptyBucketAt, pickAt, placeAt, type BodyBox, type Slot } from '../../src/player/interaction';
import { REACH_FLY, castRay, createRayHit, type RayHit } from '../../src/player/raycast';
import { AIR, BEDROCK, GLASS, LADDER, REGISTRY, STONE, TORCH, WALL_TORCH } from '../../src/world/blocks/index';
import { LAVA_SOURCE, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';

/** A Smi key for |x|, |z| < 128 and y in −64 … 319. */
const key = (x: number, y: number, z: number): number => ((x + 128) * 512 + (y + 64)) * 256 + (z + 128);

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
      fluids.set(key(x, y, z), fluid);
      return r;
    },
  };
  return r;
}

/** A hit of voxel (x, y, z) by `face`, its state read from `r`. */
function hitOf(r: Canned, x: number, y: number, z: number, face: number): RayHit {
  const h = createRayHit();
  h.hit = true;
  h.x = x;
  h.y = y;
  h.z = z;
  h.face = face;
  h.state = r.blockAt(x, y, z);
  return h;
}

const value = (state: number, fluid = 0): number => ((state << 8) | fluid) >>> 0;
const facing = (type: number, f: string): number => REGISTRY.withProp(type, 'facing', f);
const block = (type: string): Slot => ({ type, pinned: {} });
const WATER: Slot = { fluid: 'water' };
const LAVA: Slot = { fluid: 'lava' };
const EMPTY: Slot = { tool: 'emptyBucket' };
const always = (): boolean => true;
/** A body far from every target of these tests. */
const FAR: BodyBox = bodyOf('fly', 1000.5, 200, 1000.5, { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
const box = (): BodyBox => ({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });

describe('bodyOf (SP5a spec §4.2)', () => {
  test('0.6 × 1.8 with its top 0.18 above the eye, walking and flying', () => {
    for (const mode of ['walk', 'fly'] as const) {
      const b = bodyOf(mode, 10.5, 71.62, -3.5, box());
      expect([b.minX, b.maxX, b.minY, b.minZ, b.maxZ]).toEqual([10.2, 10.8, 70, -3.8, -3.2]);
      expect(b.maxY).toBeCloseTo(71.8, 12);
    }
  });
});

describe('breakAt (SP5a spec §4.2)', () => {
  test('the hit voxel becomes air, `expect` its value now; bedrock breaks', () => {
    const r = canned().set(0, 68, 0, STONE).set(1, -64, 1, BEDROCK);
    expect(breakAt(hitOf(r, 0, 68, 0, FACE_UP), r)).toEqual({ x: 0, y: 68, z: 0, op: 'set', value: value(AIR), expect: value(STONE) });
    expect(breakAt(hitOf(r, 1, -64, 1, FACE_UP), r)).toEqual({ x: 1, y: -64, z: 1, op: 'set', value: value(AIR), expect: value(BEDROCK) });
  });

  test('breaking a waterlogged ladder leaves water', () => {
    const r = canned().set(2, 70, 2, LADDER, WATER_SOURCE);
    expect(breakAt(hitOf(r, 2, 70, 2, FACE_NORTH), r)).toEqual(
      { x: 2, y: 70, z: 2, op: 'set', value: value(AIR, WATER_SOURCE), expect: value(LADDER, WATER_SOURCE) });
  });

  test('a miss or an unpublished voxel breaks nothing', () => {
    const r = canned(0);
    expect(breakAt(createRayHit(), r)).toBeNull();
    expect(breakAt(hitOf(canned().set(0, 68, 0, STONE), 0, 68, 0, FACE_UP), r)).toBeNull();
  });
});

describe('placeAt: the target (SP5a spec §4.2)', () => {
  test('a stone on a stone\'s top goes into the air above, `expect` that voxel\'s value now', () => {
    const r = canned().set(0, 68, 0, STONE);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('stone'), 0, FAR, r, always)).toEqual(
      { x: 0, y: 69, z: 0, op: 'set', value: value(STONE), expect: value(AIR) });
  });

  test('each face\'s normal picks the voxel across it', () => {
    const r = canned().set(0, 68, 0, STONE);
    const at = (face: number): number[] => {
      const e = placeAt(hitOf(r, 0, 68, 0, face), block('stone'), 0, FAR, r, always)!;
      return [e.x, e.y, e.z];
    };
    expect([FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST, FACE_UP, FACE_DOWN].map(at)).toEqual(
      [[0, 68, -1], [1, 68, 0], [0, 68, 1], [-1, 68, 0], [0, 69, 0], [0, 67, 0]]);
  });

  test('a target that is not air is refused; air holding a fluid is a target', () => {
    const r = canned().set(0, 68, 0, STONE).set(0, 69, 0, GLASS).set(1, 68, 0, AIR, packFluid(1, 3));
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('stone'), 0, FAR, r, always)).toBeNull();
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_EAST), block('stone'), 0, FAR, r, always)?.value).toBe(value(STONE));
  });

  test('outside y −64 … 319 is refused', () => {
    const r = canned().set(0, 319, 0, STONE).set(0, -64, 0, BEDROCK);
    expect(placeAt(hitOf(r, 0, 319, 0, FACE_UP), block('stone'), 0, FAR, r, always)).toBeNull();
    expect(placeAt(hitOf(r, 0, -64, 0, FACE_DOWN), block('stone'), 0, FAR, r, always)).toBeNull();
    expect(placeAt(hitOf(r, 0, 319, 0, FACE_EAST), block('stone'), 0, FAR, r, always)?.y).toBe(319);
  });

  test('the target\'s column must be editable (asked by the target\'s column, not the hit\'s)', () => {
    const r = canned().set(0, 68, 0, STONE);
    const asked: string[] = [];
    const gate = (ok: boolean) => (cx: number, cz: number): boolean => {
      asked.push(`${cx},${cz}`);
      return ok;
    };
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_WEST), block('stone'), 0, FAR, r, gate(false))).toBeNull();
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_NORTH), block('stone'), 0, FAR, r, gate(true))).not.toBeNull();
    expect(asked).toEqual(['-1,0', '0,-1']);
  });

  test('an unpublished target is refused', () => {
    const r = canned(1).set(0, 68, 0, STONE);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_EAST), block('stone'), 0, FAR, r, always)).toBeNull();
  });

  test('the empty bucket places nothing (its edit is emptyBucketAt\'s)', () => {
    const r = canned().set(0, 68, 0, STONE);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), EMPTY, 0, FAR, r, always)).toBeNull();
    expect(placeAt(createRayHit(), block('stone'), 0, FAR, r, always)).toBeNull();
  });
});

describe('placeAt: the body (SP5a spec §4.2)', () => {
  test('a stone into the walking body refused', () => {
    // Feet on the stone at (0, 68, 0); the target above it is the body's lower cell.
    const r = canned().set(0, 68, 0, STONE).set(1, 69, 0, STONE);
    const body = bodyOf('walk', 0.5, 69 + 1.62, 0.5, box());
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('stone'), 0, body, r, always)).toBeNull();
    // The cell at head height beside the body (x 1 … 2) is clear of it: body x 0.2 … 0.8.
    expect(placeAt(hitOf(r, 1, 69, 0, FACE_UP), block('stone'), 0, body, r, always)).not.toBeNull();
  });

  test('flying with the eye at y0 + 1.62 over open air: the eye\'s voxel refused, the voxel below the feet allowed', () => {
    const y0 = 70;
    const r = canned().set(0, y0 + 2, 0, GLASS).set(0, y0 - 2, 0, GLASS);
    const body = bodyOf('fly', 0.5, y0 + 1.62, 0.5, box());
    // The eye's voxel is y0 + 1, under the glass at y0 + 2.
    expect(placeAt(hitOf(r, 0, y0 + 2, 0, FACE_DOWN), block('stone'), 0, body, r, always)).toBeNull();
    // Voxel y0 − 1, above the glass at y0 − 2: its top touches the feet, which is not intersecting.
    expect(placeAt(hitOf(r, 0, y0 - 2, 0, FACE_UP), block('stone'), 0, body, r, always)).toEqual(
      { x: 0, y: y0 - 1, z: 0, op: 'set', value: value(STONE), expect: value(AIR) });
  });

  test('a state without a collision box (a torch, a ladder) is placed into the body', () => {
    const r = canned().set(0, 68, 0, STONE);
    const body = bodyOf('walk', 0.5, 69 + 1.62, 0.5, box());
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('torch'), 0, body, r, always)?.value).toBe(value(TORCH));
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('ladder'), 0, body, r, always)).not.toBeNull();
  });
});

describe('placeAt: fluids (SP5a spec §4.2)', () => {
  const FLOWING = packFluid(1, 2);

  test('`block` clears the fluid', () => {
    const r = canned().set(0, 68, 0, STONE).set(0, 69, 0, AIR, FLOWING);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('glass'), 0, FAR, r, always)).toEqual(
      { x: 0, y: 69, z: 0, op: 'set', value: value(GLASS), expect: value(AIR, FLOWING) });
  });

  test('a ladder into water keeps the water', () => {
    const r = canned().set(0, 68, 0, STONE).set(0, 68, -1, AIR, WATER_SOURCE);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_NORTH), block('ladder'), 0, FAR, r, always)).toEqual(
      { x: 0, y: 68, z: -1, op: 'set', value: value(LADDER, WATER_SOURCE), expect: value(AIR, WATER_SOURCE) });
  });

  test('a torch into water → null (`displace` is refused in a fluid); into air it holds no fluid', () => {
    const r = canned().set(0, 68, 0, STONE).set(0, 69, 0, AIR, WATER_SOURCE).set(1, 68, 0, AIR, packFluid(2, 1));
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), block('torch'), 0, FAR, r, always)).toBeNull();
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_EAST), block('torch'), 0, FAR, r, always)).toBeNull();
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_SOUTH), block('torch'), 0, FAR, r, always)?.value).toBe(value(facing(WALL_TORCH, 'south')));
  });
});

describe('placeAt: oriented states (SP5a spec §4.2)', () => {
  const r = canned().set(0, 68, 0, STONE);
  const placed = (slot: Slot, face: number, yaw = 0): number | null => {
    const e = placeAt(hitOf(r, 0, 68, 0, face), slot, yaw, FAR, r, always);
    return e === null ? null : e.value >>> 8;
  };
  const log = (axis: string): number => REGISTRY.withProp(REGISTRY.parseStateKey('oak_log[axis=y]'), 'axis', axis);

  test('log on a ±x face → axis x; on a ±z face → z; on a top or bottom face → y', () => {
    expect([placed(block('oak_log'), FACE_EAST), placed(block('oak_log'), FACE_WEST)]).toEqual([log('x'), log('x')]);
    expect([placed(block('oak_log'), FACE_NORTH), placed(block('oak_log'), FACE_SOUTH)]).toEqual([log('z'), log('z')]);
    expect([placed(block('oak_log'), FACE_UP), placed(block('oak_log'), FACE_DOWN)]).toEqual([log('y'), log('y')]);
  });

  test('torch on the top of stone → `torch`; on its east face → `wall_torch[facing=east]`; on its bottom → null', () => {
    expect(placed(block('torch'), FACE_UP)).toBe(TORCH);
    expect(placed(block('torch'), FACE_EAST)).toBe(REGISTRY.parseStateKey('wall_torch[facing=east]'));
    expect(placed(block('torch'), FACE_DOWN)).toBeNull();
  });

  test('ladder on a north face faces north; on a floor at yaw 200 → facing north; at yaw 250 → facing east', () => {
    expect(placed(block('ladder'), FACE_NORTH)).toBe(facing(LADDER, 'north'));
    expect(placed(block('ladder'), FACE_WEST)).toBe(facing(LADDER, 'west'));
    // yaw 200 looks south, slightly west: its opposite (20) is nearest north; yaw 250's opposite (70) is nearest east.
    expect(placed(block('ladder'), FACE_UP, 200)).toBe(facing(LADDER, 'north'));
    expect(placed(block('ladder'), FACE_UP, 250)).toBe(facing(LADDER, 'east'));
    expect(placed(block('ladder'), FACE_DOWN, 90)).toBe(facing(LADDER, 'west'));
  });

  test('other types take their default state', () => {
    expect(placed(block('glass'), FACE_EAST)).toBe(GLASS);
    expect(placed(block('stone'), FACE_DOWN)).toBe(STONE);
  });
});

describe('placeAt: buckets (SP5a spec §4.2)', () => {
  test('water or lava into air: a still source, any fluid there replaced', () => {
    const r = canned().set(0, 68, 0, STONE).set(1, 68, 0, AIR, packFluid(1, 5));
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), WATER, 0, FAR, r, always)).toEqual(
      { x: 0, y: 69, z: 0, op: 'set', value: value(AIR, WATER_SOURCE), expect: value(AIR) });
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), LAVA, 0, FAR, r, always)?.value).toBe(value(AIR, LAVA_SOURCE));
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_EAST), LAVA, 0, FAR, r, always)).toEqual(
      { x: 1, y: 68, z: 0, op: 'set', value: value(AIR, LAVA_SOURCE), expect: value(AIR, packFluid(1, 5)) });
  });

  test('water into a ladder → ladder + 16; lava into a ladder → null', () => {
    // The target is the voxel across the hit face: the stone floor is hit, the ladder stands on it.
    const ladder = facing(LADDER, 'north');
    const r = canned().set(0, 68, 0, STONE).set(0, 69, 0, ladder);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), WATER, 0, FAR, r, always)).toEqual(
      { x: 0, y: 69, z: 0, op: 'set', value: value(ladder, WATER_SOURCE), expect: value(ladder) });
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), LAVA, 0, FAR, r, always)).toBeNull();
  });

  test('a bucket aimed at a ladder fills the voxel in front of the hit face, not the ladder', () => {
    const r = canned().set(0, 68, 0, LADDER);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_NORTH), WATER, 0, FAR, r, always)).toEqual(
      { x: 0, y: 68, z: -1, op: 'set', value: value(AIR, WATER_SOURCE), expect: value(AIR) });
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_NORTH), LAVA, 0, FAR, r, always)).toEqual(
      { x: 0, y: 68, z: -1, op: 'set', value: value(AIR, LAVA_SOURCE), expect: value(AIR) });
  });

  test('a bucket into a block is refused, and so is one into a column that is not editable or past y 319', () => {
    const r = canned().set(0, 68, 0, STONE).set(0, 69, 0, STONE).set(0, 319, 0, STONE);
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), WATER, 0, FAR, r, always)).toBeNull();
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_EAST), WATER, 0, FAR, r, () => false)).toBeNull();
    expect(placeAt(hitOf(r, 0, 319, 0, FACE_UP), WATER, 0, FAR, r, always)).toBeNull();
  });

  test('a bucket ignores the body (a fluid has no collision box)', () => {
    const r = canned().set(0, 68, 0, STONE);
    const body = bodyOf('walk', 0.5, 69 + 1.62, 0.5, box());
    expect(placeAt(hitOf(r, 0, 68, 0, FACE_UP), WATER, 0, body, r, always)?.value).toBe(value(AIR, WATER_SOURCE));
  });
});

describe('emptyBucketAt (SP5a spec §3.5, §4.2)', () => {
  const dir = new Float64Array(3);
  const fluidRay = (r: Canned): RayHit => {
    lookVectorInto(dir, 90, 0); // east, from the centre of voxel (0, 70, 0)
    return castRay(r, 0.5, 70.5, 0.5, dir[0]!, dir[1]!, dir[2]!, REACH_FLY, 'fluid', createRayHit());
  };

  test('the empty bucket removes the first fluid on the ray', () => {
    const r = canned().set(3, 70, 0, AIR, packFluid(1, 4)).set(4, 70, 0, AIR, WATER_SOURCE);
    expect(emptyBucketAt(fluidRay(r), r)).toEqual(
      { x: 3, y: 70, z: 0, op: 'set', value: value(AIR), expect: value(AIR, packFluid(1, 4)) });
  });

  test('a waterlogged ladder keeps its ladder and loses its water', () => {
    const r = canned().set(2, 70, 0, facing(LADDER, 'east'), WATER_SOURCE);
    expect(emptyBucketAt(fluidRay(r), r)).toEqual(
      { x: 2, y: 70, z: 0, op: 'set', value: value(facing(LADDER, 'east')), expect: value(facing(LADDER, 'east'), WATER_SOURCE) });
  });

  test('water behind a wall is out of reach; a miss empties nothing', () => {
    const r = canned().set(2, 70, 0, STONE).set(3, 70, 0, AIR, WATER_SOURCE);
    expect(emptyBucketAt(fluidRay(r), r)).toBeNull();
    expect(emptyBucketAt(createRayHit(), r)).toBeNull();
  });
});

describe('pickAt (SP5a spec §4.2)', () => {
  test('pick of a wall torch → `torch`; any other state its type name; a miss → null', () => {
    const r = canned().set(0, 68, 0, facing(WALL_TORCH, 'west')).set(1, 68, 0, REGISTRY.parseStateKey('oak_log[axis=x]'))
      .set(2, 68, 0, facing(LADDER, 'south'));
    expect(pickAt(hitOf(r, 0, 68, 0, FACE_EAST))).toBe('torch');
    expect(pickAt(hitOf(r, 1, 68, 0, FACE_EAST))).toBe('oak_log');
    expect(pickAt(hitOf(r, 2, 68, 0, FACE_EAST))).toBe('ladder');
    expect(pickAt(createRayHit())).toBeNull();
  });
});

import { describe, expect, test } from 'vitest';
import {
  CAVE_BIOME, CORNER_DRY, CORNER_FULL, CORNER_SOLID, FLUID_CAP_LAVA, FLUID_CAP_WATER, FLUID_LAST_LEVEL_LAVA, FLUID_LAST_LEVEL_WATER,
  FLUID_SEARCH_LAVA, FLUID_SEARCH_WATER, FLUID_STEP_LAVA, FLUID_STEP_WATER,
} from '../../src/core/constants';
import { FLUID_LAVA, FLUID_WATER, LAVA_SOURCE, NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import {
  capOf, cornerDrop, cornerHeight, FLUID_VALUE_DRY, FLUID_VALUE_FALLING, FLUID_VALUE_SOURCE, isPassable, lastLevelOf, nearestDropDirs,
  nearestDropDirsFor, nextLevel, ruleOffers, searchOf, splitV0V2, stepOf, surfaceHeight, type FluidRuleReader, type PassableReader,
} from '../../src/world/blocks/fluidRules';
import { AIR, STONE } from '../../src/world/blocks/index';
import { FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_WEST } from '../../src/world/blocks/kinds';

const N = 1 << FACE_NORTH;
const E = 1 << FACE_EAST;
const S = 1 << FACE_SOUTH;
const W = 1 << FACE_WEST;
const ALL = N | E | S | W;
const ABYSS = CAVE_BIOME.abyss;
/** The settle's value of flowing level k (source 0 < falling 1 < flowing 1 + k). */
const flowing = (k: number): number => 1 + k;

/**
 * A hand-built world: every voxel passable unless listed solid (or `solidBelow` puts it under the plane y = 0), proto
 * fluid and cave nibbles by position.
 */
class Grid implements FluidRuleReader {
  readonly solid = new Set<string>();
  readonly open = new Set<string>();
  readonly fluid = new Map<string, number>();
  readonly nibbles = new Map<string, number>();
  readonly solidBelow: boolean;
  constructor(solidBelow = true) { this.solidBelow = solidBelow; }
  static key(x: number, y: number, z: number): string { return `${x},${y},${z}`; }
  setSolid(x: number, y: number, z: number): this { this.solid.add(Grid.key(x, y, z)); this.open.delete(Grid.key(x, y, z)); return this; }
  setOpen(x: number, y: number, z: number): this { this.open.add(Grid.key(x, y, z)); this.solid.delete(Grid.key(x, y, z)); return this; }
  setFluid(x: number, y: number, z: number, byte: number): this { this.fluid.set(Grid.key(x, y, z), byte); return this; }
  setNibble(x: number, y: number, z: number, nibble: number): this { this.nibbles.set(Grid.key(x, y, z), nibble); return this; }
  passable(x: number, y: number, z: number): boolean {
    const k = Grid.key(x, y, z);
    if (this.open.has(k)) return true;
    if (this.solid.has(k)) return false;
    return !(this.solidBelow && y < 0);
  }
  protoFluid(x: number, y: number, z: number): number { return this.fluid.get(Grid.key(x, y, z)) ?? NO_FLUID; }
  nibble(x: number, y: number, z: number): number { return this.nibbles.get(Grid.key(x, y, z)) ?? 0; }
}

/** The offers as `dx,dy,dz,value,dist` strings, sorted, and the returned flags. */
function offers(type: number, r: FluidRuleReader, x: number, y: number, z: number, value: number, dist: number, size = 45): { list: string[]; count: number; unsettled: boolean } {
  const out = new Int32Array(size);
  const ret = ruleOffers(type, r, x, y, z, value, dist, out);
  const count = ret & 15;
  const list: string[] = [];
  for (let i = 0; i < count; i++) list.push(Array.from(out.subarray(i * 5, i * 5 + 5)).join(','));
  return { list: list.sort(), count, unsettled: (ret & 16) !== 0 };
}

describe('fluidRules: the numbers (SP7a spec §4.1, D22)', () => {
  test('caps 12 / 14, searches 4 / 2, steps 1 / 2, last levels 7 / 6', () => {
    expect([FLUID_CAP_WATER, FLUID_CAP_LAVA, FLUID_SEARCH_WATER, FLUID_SEARCH_LAVA]).toEqual([12, 14, 4, 2]);
    expect([FLUID_STEP_WATER, FLUID_STEP_LAVA, FLUID_LAST_LEVEL_WATER, FLUID_LAST_LEVEL_LAVA]).toEqual([1, 2, 7, 6]);
    expect([capOf(FLUID_WATER), searchOf(FLUID_WATER), stepOf(FLUID_WATER), lastLevelOf(FLUID_WATER)]).toEqual([12, 4, 1, 7]);
    expect([capOf(FLUID_LAVA), searchOf(FLUID_LAVA), stepOf(FLUID_LAVA), lastLevelOf(FLUID_LAVA)]).toEqual([14, 2, 2, 6]);
  });

  test('nextLevel: water +1 up to 7, lava 0 → 2 → 4 → 6, −1 past the last level', () => {
    for (let k = 0; k < 7; k++) expect(nextLevel(FLUID_WATER, k)).toBe(k + 1);
    expect(nextLevel(FLUID_WATER, 7)).toBe(-1);
    expect([0, 2, 4, 6].map((k) => nextLevel(FLUID_LAVA, k))).toEqual([2, 4, 6, -1]);
  });

  test('the value order: source < falling < flowing 1 … 7 < dry', () => {
    expect(FLUID_VALUE_SOURCE).toBeLessThan(FLUID_VALUE_FALLING);
    expect(FLUID_VALUE_FALLING).toBeLessThan(flowing(1));
    expect(flowing(FLUID_LAST_LEVEL_WATER)).toBeLessThan(FLUID_VALUE_DRY);
  });
});

describe('fluidRules: passability (D22)', () => {
  test('AIR and hold / displace states pass, block states stop fluid (a synthetic modes table)', () => {
    // State 0 (AIR) reads `block` in this table: AIR passes whatever its row says.
    const modes = new Uint8Array([0, 0, 1, 2]);
    expect(AIR).toBe(0);
    expect(isPassable(AIR, modes)).toBe(true);
    expect(isPassable(1, modes)).toBe(false);
    expect(isPassable(2, modes)).toBe(true);
    expect(isPassable(3, modes)).toBe(true);
  });

  test('with the registry\'s FLUID_MODE: AIR passes, stone stops', () => {
    expect(isPassable(AIR)).toBe(true);
    expect(isPassable(STONE)).toBe(false);
  });
});

describe('fluidRules: surface and corner heights (SP7a spec §6.1, §6.2)', () => {
  test('surfaceHeight: (8 − level)/9, 1 when falling or with the same fluid above', () => {
    expect(surfaceHeight(WATER_SOURCE, false)).toBe(8 / 9);
    for (let k = 1; k <= 7; k++) expect(surfaceHeight(packFluid(FLUID_WATER, k), false)).toBe((8 - k) / 9);
    expect([0, 2, 4, 6].map((k) => surfaceHeight(packFluid(FLUID_LAVA, k), false))).toEqual([8 / 9, 6 / 9, 4 / 9, 2 / 9]);
    expect(surfaceHeight(packFluid(FLUID_WATER, 0, true), false)).toBe(1);
    expect(surfaceHeight(packFluid(FLUID_LAVA, 0, true), false)).toBe(1);
    expect(surfaceHeight(WATER_SOURCE, true)).toBe(1);
    expect(surfaceHeight(packFluid(FLUID_WATER, 5), true)).toBe(1);
  });

  test('the corner codes', () => {
    expect([CORNER_DRY, CORNER_SOLID, CORNER_FULL]).toEqual([-1, -2, 2]);
  });

  test('cornerHeight and cornerDrop: the weighted mean, h ≥ 0.8 weighing 10, dry 0 with weight 1, solid not counted', () => {
    const src = 8 / 9;
    expect(cornerHeight(src, src, src, src)).toBeCloseTo(8 / 9, 12);
    expect(cornerDrop(cornerHeight(src, src, src, src))).toBe(1);
    const sourceDry = cornerHeight(src, CORNER_DRY, CORNER_DRY, CORNER_DRY);
    expect(sourceDry).toBeCloseTo((10 * 8 / 9) / 13, 12);
    expect(sourceDry).toBeCloseTo(0.6838, 4);
    expect(cornerDrop(sourceDry)).toBe(3);
    const mixed = cornerHeight(src, 7 / 9, CORNER_DRY, CORNER_DRY);
    expect(mixed).toBeCloseTo((10 * 8 / 9 + 7 / 9) / 13, 12);
    expect(mixed).toBeCloseTo(0.7436, 4);
    expect(cornerDrop(mixed)).toBe(2);
    expect(cornerHeight(src, CORNER_SOLID, CORNER_SOLID, CORNER_SOLID)).toBeCloseTo(8 / 9, 12);
    const thin = cornerHeight(1 / 9, CORNER_DRY, CORNER_DRY, CORNER_DRY);
    expect(thin).toBeCloseTo((1 / 9) / 4, 12);
    expect(cornerDrop(thin)).toBe(8); // round(8.75) = 9, clamped to 8
    expect(cornerHeight(CORNER_SOLID, CORNER_SOLID, CORNER_SOLID, CORNER_SOLID)).toBe(0);
    for (let i = 0; i < 4; i++) {
      const h = [src, CORNER_DRY, CORNER_SOLID, 2 / 9];
      h[i] = CORNER_FULL;
      expect(cornerHeight(h[0]!, h[1]!, h[2]!, h[3]!)).toBe(1);
    }
    expect(cornerDrop(1)).toBe(0);
    expect(cornerDrop(0)).toBe(8);
  });

  test('splitV0V2: the diagonal joining the corners with the lower summed height, ties to v0-v2', () => {
    expect(splitV0V2(1, 0, 1, 0)).toBe(false);
    expect(splitV0V2(0, 1, 0, 1)).toBe(true);
    expect(splitV0V2(0.5, 0.5, 0.5, 0.5)).toBe(true);
    expect(splitV0V2(1, 0.25, 0, 0.75)).toBe(true);
  });
});

describe('fluidRules: nearestDropDirs (SP7a spec §4.1)', () => {
  /** A stone plane under y = 0 with holes at the given (x, z): each makes the voxel above it a drop. */
  const plane = (...holes: Array<[number, number]>): Grid => {
    const g = new Grid();
    for (const [x, z] of holes) g.setOpen(x, -1, z);
    return g;
  };

  test('a drop 3 east only → E; drops 3 east and 3 west → E|W', () => {
    expect(nearestDropDirs(FLUID_WATER, plane([3, 0]), 0, 0, 0)).toBe(E);
    expect(nearestDropDirs(FLUID_WATER, plane([3, 0], [-3, 0]), 0, 0, 0)).toBe(E | W);
    expect(nearestDropDirs(FLUID_WATER, plane([3, 0], [-2, 0]), 0, 0, 0)).toBe(W);
  });

  test('a drop off the axis reaches the sides that lie on a shortest path', () => {
    expect(nearestDropDirs(FLUID_WATER, plane([2, 2]), 0, 0, 0)).toBe(E | S);
  });

  test('beyond the search: a drop 5 away → 0 for water; lava: 3 away → 0, 2 away → its side', () => {
    expect(nearestDropDirs(FLUID_WATER, plane([5, 0]), 0, 0, 0)).toBe(0);
    expect(nearestDropDirs(FLUID_WATER, plane([4, 0]), 0, 0, 0)).toBe(E);
    expect(nearestDropDirs(FLUID_LAVA, plane([3, 0]), 0, 0, 0)).toBe(0);
    expect(nearestDropDirs(FLUID_LAVA, plane([0, 2]), 0, 0, 0)).toBe(S);
    expect(nearestDropDirs(FLUID_LAVA, plane([-1, 0]), 0, 0, 0)).toBe(W);
  });

  test('a wall between the voxel and the drop (no passable path) → 0', () => {
    const g = plane([3, 0]);
    for (let z = -6; z <= 6; z++) g.setSolid(2, 0, z);
    expect(nearestDropDirs(FLUID_WATER, g, 0, 0, 0)).toBe(0);
  });

  test('the path goes round a wall within the search', () => {
    // A wall block at (1, 0); the drop at (2, 0): the shortest paths go N or S round it, 4 steps.
    const g = plane([2, 0]).setSolid(1, 0, 0);
    expect(nearestDropDirs(FLUID_WATER, g, 0, 0, 0)).toBe(N | S);
    expect(nearestDropDirs(FLUID_LAVA, g, 0, 0, 0)).toBe(0);
  });

  test('no drop in reach on an open plane → 0', () => {
    const r: PassableReader = { passable: (_x, y) => y >= 0 };
    expect(nearestDropDirs(FLUID_WATER, r, 0, 0, 0)).toBe(0);
  });
});

describe('fluidRules: the nearest-drop search skips the fluid\'s own proto sources (SP7a spec §4.1, D22; rulings R21)', () => {
  /**
   * A pool of proto water sources 2 deep (y 0 and −1) over the stone plane, x −5 … −1, z −2 … 2; on its dry +x side
   * the plane at y 0 for 2 blocks, then a 1-block step down at x 2 (z −2 … 2): (2, 0, z) is a drop 3 blocks from the
   * shore source (−1, 0, 0). Every pool voxel at y 0 lies over water, which counted as a drop at distance 1 before R21.
   */
  const pool = (): Grid => {
    const g = new Grid();
    for (let x = -5; x <= -1; x++) {
      for (let z = -2; z <= 2; z++) g.setFluid(x, 0, z, WATER_SOURCE).setOpen(x, -1, z).setFluid(x, -1, z, WATER_SOURCE);
    }
    for (let z = -2; z <= 2; z++) g.setOpen(2, -1, z);
    return g;
  };

  test('a shore source of a pool finds the step on its dry side, 3 away, not the pool\'s own voxels over water', () => {
    const g = pool();
    expect(nearestDropDirsFor(FLUID_WATER, g, -1, 0, 0)).toBe(E);
    // ruleOffers' spread takes the same sides: one level-1 offer toward the step, none into the pool.
    expect(offers(FLUID_WATER, g, -1, 0, 0, FLUID_VALUE_SOURCE, 0).list).toEqual([`1,0,0,${flowing(1)},1`]);
  });

  test('a source inside the pool has no searchable side: no drop (0), so it offers to every open side (its own sources)', () => {
    const g = pool();
    expect(nearestDropDirsFor(FLUID_WATER, g, -3, 0, 0)).toBe(0);
    expect(offers(FLUID_WATER, g, -3, 0, 0, FLUID_VALUE_SOURCE, 0).count).toBe(4);
  });

  test('a pool enclosed by solid still spreads nothing outward: every offer targets one of its own sources', () => {
    const g = new Grid().setOpen(4, -1, 0);
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) g.setFluid(x, 0, z, WATER_SOURCE);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 2 || Math.abs(z) === 2) g.setSolid(x, 0, z);
    expect(nearestDropDirsFor(FLUID_WATER, g, 1, 0, 0)).toBe(0);
    const o = offers(FLUID_WATER, g, 1, 0, 0, FLUID_VALUE_SOURCE, 0);
    expect(o.count).toBeGreaterThan(0);
    for (const t of o.list) {
      const [dx, , dz] = t.split(',').map(Number);
      expect(g.protoFluid(1 + dx!, 0, dz!)).toBe(WATER_SOURCE);
    }
  });

  test('a flowing or falling proto water voxel is still walked through; a proto source in its place is not', () => {
    // The drop at (2, 0, 0); the path east crosses (1, 0, 0).
    for (const byte of [packFluid(FLUID_WATER, 3), packFluid(FLUID_WATER, 0, true)]) {
      const g = new Grid().setOpen(2, -1, 0).setFluid(1, 0, 0, byte);
      expect(nearestDropDirsFor(FLUID_WATER, g, 0, 0, 0)).toBe(E);
    }
    // A source at (1, 0, 0) closes the east side: the shortest paths go round it, N or S, 4 steps.
    const g = new Grid().setOpen(2, -1, 0).setFluid(1, 0, 0, WATER_SOURCE);
    expect(nearestDropDirsFor(FLUID_WATER, g, 0, 0, 0)).toBe(N | S);
  });

  test('lava skips its own proto sources: a lava shore source finds a drop 2 away on its dry side', () => {
    const g = new Grid().setOpen(1, -1, 0);
    for (const x of [-2, -1]) g.setFluid(x, 0, 0, LAVA_SOURCE).setOpen(x, -1, 0).setFluid(x, -1, 0, LAVA_SOURCE);
    expect(nearestDropDirsFor(FLUID_LAVA, g, -1, 0, 0)).toBe(E);
    expect(offers(FLUID_LAVA, g, -1, 0, 0, FLUID_VALUE_SOURCE, 0).list).toEqual([`1,0,0,${flowing(2)},1`]);
  });

  test('the drop test is unchanged: the fluid\'s own proto source under a searched voxel makes it a drop', () => {
    // A flowing voxel at (0, 0, 0) over stone; a proto source at (2, −1, 0) under open air at (2, 0, 0).
    const g = new Grid().setOpen(2, -1, 0).setFluid(2, -1, 0, WATER_SOURCE);
    expect(nearestDropDirsFor(FLUID_WATER, g, 0, 0, 0)).toBe(E);
  });
});

describe('fluidRules: ruleOffers, one step of §4.1\'s rules (D22)', () => {
  test('a source on a plane: four level-1 offers at distance 1', () => {
    const g = new Grid().setFluid(0, 0, 0, WATER_SOURCE);
    const o = offers(FLUID_WATER, g, 0, 0, 0, FLUID_VALUE_SOURCE, 0);
    expect(o.unsettled).toBe(false);
    expect(o.list).toEqual([`-1,0,0,${flowing(1)},1`, `0,0,-1,${flowing(1)},1`, `0,0,1,${flowing(1)},1`, `1,0,0,${flowing(1)},1`]);
  });

  test('lava\'s step: a lava source offers level 2', () => {
    const g = new Grid().setFluid(0, 0, 0, LAVA_SOURCE);
    const o = offers(FLUID_LAVA, g, 0, 0, 0, FLUID_VALUE_SOURCE, 0);
    expect(o.count).toBe(4);
    for (const t of o.list) expect(t.split(',').slice(3)).toEqual([`${flowing(2)}`, '1']);
    // Lava's last level offers nothing sideways.
    expect(offers(FLUID_LAVA, g, 5, 0, 5, flowing(6), 3).count).toBe(0);
  });

  test('flowing water spreads its level + 1 toward the nearest drop only', () => {
    const g = new Grid().setOpen(3, -1, 0);
    const o = offers(FLUID_WATER, g, 0, 0, 0, flowing(2), 4);
    expect(o.list).toEqual([`1,0,0,${flowing(3)},5`]);
    expect(offers(FLUID_WATER, g, 0, 0, 0, flowing(7), 4).count).toBe(0);
  });

  test('a falling voxel over a passable voxel: one falling offer at the same distance, no spread', () => {
    const g = new Grid(false);
    const o = offers(FLUID_WATER, g, 0, 5, 0, FLUID_VALUE_FALLING, 3);
    expect(o.list).toEqual([`0,-1,0,${FLUID_VALUE_FALLING},3`]);
    expect(o.unsettled).toBe(false);
  });

  test('a falling voxel landed on solid spreads as a source would (level 1)', () => {
    const g = new Grid();
    const o = offers(FLUID_WATER, g, 0, 0, 0, FLUID_VALUE_FALLING, 3);
    expect(o.list).toEqual([`-1,0,0,${flowing(1)},4`, `0,0,-1,${flowing(1)},4`, `0,0,1,${flowing(1)},4`, `1,0,0,${flowing(1)},4`]);
  });

  test('a flowing voxel over a proto source of its fluid spreads over it and offers no fall', () => {
    const g = new Grid(false).setFluid(0, -1, 0, WATER_SOURCE);
    const o = offers(FLUID_WATER, g, 0, 0, 0, flowing(1), 1);
    expect(o.count).toBe(4);
    expect(o.list.every((t) => t.startsWith('-1,0,0') || t.startsWith('1,0,0') || t.startsWith('0,0,'))).toBe(true);
  });

  test('at the cap beside a passable voxel: no offer, +16; against a wall: no offer, no +16', () => {
    const g = new Grid();
    const atCap = offers(FLUID_WATER, g, 0, 0, 0, flowing(3), FLUID_CAP_WATER);
    expect(atCap).toEqual({ list: [], count: 0, unsettled: true });
    const lava = offers(FLUID_LAVA, g, 0, 0, 0, flowing(2), FLUID_CAP_LAVA);
    expect(lava).toEqual({ list: [], count: 0, unsettled: true });
    // One below the cap still spreads.
    expect(offers(FLUID_WATER, g, 0, 0, 0, flowing(3), FLUID_CAP_WATER - 1).count).toBe(4);
    const walled = new Grid();
    walled.setSolid(1, 0, 0).setSolid(-1, 0, 0).setSolid(0, 0, 1).setSolid(0, 0, -1);
    expect(offers(FLUID_WATER, walled, 0, 0, 0, flowing(3), FLUID_CAP_WATER)).toEqual({ list: [], count: 0, unsettled: false });
  });

  test('new sources: a passable proto-dry voxel between two proto sources over stone is offered as a source at distance 1', () => {
    const g = new Grid().setFluid(-1, 0, 0, WATER_SOURCE).setFluid(1, 0, 0, WATER_SOURCE);
    const o = offers(FLUID_WATER, g, -1, 0, 0, FLUID_VALUE_SOURCE, 0);
    expect(o.list).toContain(`1,0,0,${FLUID_VALUE_SOURCE},1`);
    expect(o.list).toContain(`1,0,0,${flowing(1)},1`);
    expect(o.count).toBe(5);
    // Over air the gap is no new source; nor with one proto source; nor for lava.
    const overAir = new Grid().setFluid(-1, 0, 0, WATER_SOURCE).setFluid(1, 0, 0, WATER_SOURCE).setOpen(0, -1, 0);
    expect(offers(FLUID_WATER, overAir, -1, 0, 0, FLUID_VALUE_SOURCE, 0).list).not.toContain(`1,0,0,${FLUID_VALUE_SOURCE},1`);
    const single = new Grid().setFluid(-1, 0, 0, WATER_SOURCE);
    expect(offers(FLUID_WATER, single, -1, 0, 0, FLUID_VALUE_SOURCE, 0).list).not.toContain(`1,0,0,${FLUID_VALUE_SOURCE},1`);
    const lava = new Grid().setFluid(-1, 0, 0, LAVA_SOURCE).setFluid(1, 0, 0, LAVA_SOURCE);
    expect(offers(FLUID_LAVA, lava, -1, 0, 0, FLUID_VALUE_SOURCE, 0).list.some((t) => t.endsWith(`,${FLUID_VALUE_SOURCE},1`))).toBe(false);
    // Over a proto water source the gap is a new source too.
    const overSource = new Grid(false).setFluid(-1, 0, 0, WATER_SOURCE).setFluid(1, 0, 0, WATER_SOURCE).setFluid(0, -1, 0, WATER_SOURCE)
      .setSolid(-1, -1, 0);
    expect(offers(FLUID_WATER, overSource, -1, 0, 0, FLUID_VALUE_SOURCE, 0).list).toContain(`1,0,0,${FLUID_VALUE_SOURCE},1`);
  });

  test('the maximal case: nine offers (the fall, four spreads, four new sources), none lost in 45 ints (rulings P2)', () => {
    const g = new Grid().setFluid(0, 0, 0, WATER_SOURCE).setOpen(0, -1, 0);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) g.setFluid(dx, 0, dz, WATER_SOURCE);
    const out = new Int32Array(45);
    const ret = ruleOffers(FLUID_WATER, g, 0, 0, 0, FLUID_VALUE_SOURCE, 0, out);
    expect(ret).toBe(9);
    const list: string[] = [];
    for (let i = 0; i < 9; i++) list.push(Array.from(out.subarray(i * 5, i * 5 + 5)).join(','));
    expect(list.sort()).toEqual([
      `-1,0,0,${FLUID_VALUE_SOURCE},1`, `-1,0,0,${flowing(1)},1`, `0,-1,0,${FLUID_VALUE_FALLING},0`, `0,0,-1,${FLUID_VALUE_SOURCE},1`,
      `0,0,-1,${flowing(1)},1`, `0,0,1,${FLUID_VALUE_SOURCE},1`, `0,0,1,${flowing(1)},1`, `1,0,0,${FLUID_VALUE_SOURCE},1`,
      `1,0,0,${flowing(1)},1`,
    ].sort());
  });

  test('the abyss stop: water offers nothing into nibble-3 air (no fall, no spread, no +16 at the cap); lava does', () => {
    const g = new Grid().setFluid(0, 0, 0, WATER_SOURCE).setNibble(1, 0, 0, ABYSS);
    const o = offers(FLUID_WATER, g, 0, 0, 0, FLUID_VALUE_SOURCE, 0);
    expect(o.count).toBe(3);
    expect(o.list.some((t) => t.startsWith('1,0,0'))).toBe(false);
    const fall = new Grid(false).setNibble(0, 4, 0, ABYSS);
    expect(offers(FLUID_WATER, fall, 0, 5, 0, FLUID_VALUE_FALLING, 2)).toEqual({ list: [], count: 0, unsettled: false });
    const capped = new Grid().setSolid(-1, 0, 0).setSolid(0, 0, 1).setSolid(0, 0, -1).setNibble(1, 0, 0, ABYSS);
    expect(offers(FLUID_WATER, capped, 0, 0, 0, flowing(2), FLUID_CAP_WATER)).toEqual({ list: [], count: 0, unsettled: false });
    const lava = new Grid().setFluid(0, 0, 0, LAVA_SOURCE).setNibble(1, 0, 0, ABYSS);
    expect(offers(FLUID_LAVA, lava, 0, 0, 0, FLUID_VALUE_SOURCE, 0).list).toContain(`1,0,0,${flowing(2)},1`);
  });

  test('the other type\'s proto fluid counts as block', () => {
    // Water beside proto lava: no offer into it.
    const g = new Grid().setFluid(0, 0, 0, WATER_SOURCE).setFluid(1, 0, 0, LAVA_SOURCE);
    const o = offers(FLUID_WATER, g, 0, 0, 0, FLUID_VALUE_SOURCE, 0);
    expect(o.count).toBe(3);
    expect(o.list.some((t) => t.startsWith('1,0,0'))).toBe(false);
    // Falling water over proto lava: no fall; it has landed, so it spreads (level 1).
    const over = new Grid(false).setFluid(0, -1, 0, LAVA_SOURCE);
    const landed = offers(FLUID_WATER, over, 0, 0, 0, FLUID_VALUE_FALLING, 2);
    expect(landed.list).toEqual([`-1,0,0,${flowing(1)},3`, `0,0,-1,${flowing(1)},3`, `0,0,1,${flowing(1)},3`, `1,0,0,${flowing(1)},3`]);
    // Lava beside proto water likewise; and the drop search does not pass through it.
    const lava = new Grid().setFluid(0, 0, 0, LAVA_SOURCE).setFluid(-1, 0, 0, WATER_SOURCE).setOpen(1, -1, 0).setFluid(1, -1, 0, WATER_SOURCE);
    // (1, 0, 0)'s voxel below holds proto water: block for lava, so it is no drop and lava spreads to every open side.
    expect(offers(FLUID_LAVA, lava, 0, 0, 0, FLUID_VALUE_SOURCE, 0).list).toEqual([`0,0,-1,${flowing(2)},1`, `0,0,1,${flowing(2)},1`, `1,0,0,${flowing(2)},1`]);
  });
});

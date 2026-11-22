/**
 * The A parts' instruments (SP7a spec §13.1, D30; `test/harness/water.ts`) on hand-built 4 × 4-column views (a plain
 * store's proto, chunks −2 … 1 on each axis), each read after the global settle reference over the view
 * (`referenceSettle`), as the caves metric's region worker reads its regions: A1's population and dry share, A3's four
 * counts, A4's bodies, the pooled parts, and SP7a's review poses.
 */
import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, CAVE_KIND, MIN_Y } from '../../src/core/constants';
import { FLUID_WATER, LAVA_SOURCE, NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { spreadSides } from '../harness/caveMetrics';
import { referenceSettle } from '../harness/refs';
import { regionView, type RegionView } from '../harness/region';
import { protoRuleReader, waterExamples, waterParts, waterRegionCounts, type WaterBox, type WaterRegionCounts } from '../harness/water';

const MiB = 1 << 20;
const CHEESE = CAVE_KIND.cheese;
/** The hand-built views' chunks: −2 … 1 on each axis, so x and z run −32 … 31. */
const CX0 = -2;
const SIDE = 4;
const X0 = 16 * CX0;
const X1 = X0 + 16 * SIDE;
/** The whole view as the interior. */
const ALL: WaterBox = { x0: X0, z0: X0, x1: X1, z1: X1 };
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** A hand-built proto: `block(x, y, z)` everywhere, then each `cells` entry's cave byte and fluid (its block air). */
interface Hand {
  readonly block: (x: number, y: number, z: number) => number;
  readonly cells: Map<string, { cave: number; fluid: number }>;
}

/** Air of cave byte `cave` holding `fluid` over the box [x0, x1] × [y0, y1] × [z0, z1] (inclusive). */
function fill(h: Hand, cave: number, fluid: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) h.cells.set(key(x, y, z), { cave, fluid });
}

/** The hand-built proto as a 4 × 4 view over a plain store (each column committed at Proto). */
function viewOf(h: Hand): RegionView {
  const s = createStore({ shared: false, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
  const blocks = new Uint16Array(4096);
  const fluids = new Uint8Array(4096);
  const caves = new Uint8Array(4096);
  for (let cz = CX0; cz < CX0 + SIDE; cz++) {
    for (let cx = CX0; cx < CX0 + SIDE; cx++) {
      const w = s.claimColumn(cx, cz, 0);
      for (let sy = 0; sy < 24; sy++) {
        for (let i = 0; i < 4096; i++) {
          const x = 16 * cx + (i & 15);
          const y = MIN_Y + 16 * sy + (i >> 8);
          const z = 16 * cz + ((i >> 4) & 15);
          const c = h.cells.get(key(x, y, z));
          blocks[i] = c !== undefined ? AIR : h.block(x, y, z);
          fluids[i] = c?.fluid ?? NO_FLUID;
          caves[i] = c?.cave ?? 0;
        }
        w.setProto(sy, blocks, fluids, caves);
      }
      w.commit(1);
    }
  }
  return regionView(s, CX0, CX0, SIDE, SIDE);
}

/**
 * The coast: stone to y 40 under the sea (x < 0), whose sky-open water fills y 41 … 63, and to y 70 under land (x ≥ 0),
 * air above. Untagged air at y ≤ 63 over the sea holds water, as D19 writes it.
 */
function coast(): Hand {
  const h: Hand = { block: (x, y) => (y <= (x < 0 ? 40 : 70) ? STONE : AIR), cells: new Map() };
  fill(h, 0, WATER_SOURCE, X0, -1, 41, 63, X0, X1 - 1);
  return h;
}

/** A flooded cave under the sea floor (x −20 … −10, y 30 … 35, z −5 … 5) and its crack up into the sea (x −15, z 0). */
function floodedUnderSea(h: Hand): void {
  fill(h, CHEESE, WATER_SOURCE, -20, -10, 30, 35, -5, 5);
  fill(h, CHEESE, WATER_SOURCE, -15, -15, 36, 40, 0, 0);
}

/** One region's counts after the reference over the whole view. */
function counts(h: Hand, interior: WaterBox = ALL): WaterRegionCounts {
  const view = viewOf(h);
  return waterRegionCounts(view, referenceSettle(view, ALL), interior);
}

describe('A1: the dry share of cave air below y 63 not linked to the sea (SP7a §13.1)', () => {
  test('a flooded cave linked to the sea is not in the population; a dry cave under land and a sky-linked cave are, the share the dry voxels\'', () => {
    const h = coast();
    floodedUnderSea(h);
    // A dry cave under land: 6 × 6 × 6.
    fill(h, CHEESE, NO_FLUID, 5, 10, 20, 25, -5, 0);
    // A cave linked to the sky above land (6 × 6 × 6, its floor layer flooded by the aquifer) and its shaft to the
    // surface at y 70 (x 17, z 7): the sky above land, untagged air, links it to nothing.
    fill(h, CHEESE, NO_FLUID, 15, 20, 51, 55, 5, 10);
    fill(h, CHEESE, WATER_SOURCE, 15, 20, 50, 50, 5, 10);
    fill(h, CHEESE, NO_FLUID, 17, 17, 56, 70, 7, 7);
    const c = counts(h);
    // The dry cave (216), the sky-linked cave (216) and its shaft at y 56 … 62 (7); the flooded cave's 726 + 5 are not.
    expect(c.a1Population).toBe(216 + 216 + 7);
    // The dry voxels: all but the sky-linked cave's flooded floor (36).
    expect(c.a1Dry).toBe(216 + 180 + 7);
    expect(c.a1DryT).toBe(c.a1Dry);
    expect(waterParts([c]).dryShare).toBeCloseTo(403 / 439, 12);
  });

  test('an untagged pocket links a cave to the sea once the settle floods it; the settle\'s water counts after settle, not on T', () => {
    const h = coast();
    // A dry cave under the sea floor reached through a tagged corridor and an untagged air pocket in the rock (D19 would
    // flood it; here dry in T), whose top voxel lies under the sea.
    fill(h, CHEESE, NO_FLUID, -20, -10, 30, 35, -5, 5);
    for (let y = 36; y <= 40; y++) h.cells.set(key(-25, y, 0), { cave: 0, fluid: NO_FLUID });
    fill(h, CHEESE, NO_FLUID, -25, -21, 35, 35, 0, 0);
    // A dry land cave holding one proto water source on its floor, which the settle spreads over the floor.
    fill(h, CHEESE, NO_FLUID, 5, 9, 20, 22, 5, 9);
    h.cells.set(key(7, 20, 7), { cave: CHEESE, fluid: WATER_SOURCE });
    const c = counts(h);
    // The untagged pocket's top voxel (y 40) lies beside the sea, so the settle floods the pocket and links the cave.
    expect(c.a1Population).toBe(75);
    // T: the land cave dry but its source (74 of 75); after settle its floor's 25 voxels hold water.
    expect(c.a1DryT).toBe(74);
    expect(c.a1Dry).toBe(50);
  });
});

describe('A3: deep lava, aquifer lava above −10, supported lava, lava beside sky-connected cave air (SP7a §13.1)', () => {
  /** Stone to y 70, air above, with the four lava cases. */
  function lavaWorld(): Hand {
    const h: Hand = { block: (_x, y) => (y <= 70 ? STONE : AIR), cells: new Map() };
    // The bottom gully at y −55: five tagged lava voxels.
    fill(h, CHEESE, LAVA_SOURCE, -5, -1, -55, -55, 0, 0);
    // A lava spring above −10 (untagged lava in air: not aquifer lava), and a tagged lava voxel above −10 (aquifer lava).
    h.cells.set(key(10, 0, 10), { cave: 0, fluid: LAVA_SOURCE });
    h.cells.set(key(12, 5, 12), { cave: CHEESE, fluid: LAVA_SOURCE });
    // A lava source over a tagged shaft (y −20 … −11): the settle makes the shaft falling lava, supported by definition.
    fill(h, CHEESE, NO_FLUID, 0, 0, -20, -11, 10, 10);
    h.cells.set(key(0, -10, 10), { cave: CHEESE, fluid: LAVA_SOURCE });
    // A lava source over water (the other type's proto fluid is `block` to lava): unsupported.
    h.cells.set(key(20, -30, 20), { cave: CHEESE, fluid: WATER_SOURCE });
    h.cells.set(key(20, -29, 20), { cave: CHEESE, fluid: LAVA_SOURCE });
    return h;
  }

  test('the gully marks the region, the spring is not aquifer lava, falling lava is supported, lava over water is not', () => {
    const c = counts(lavaWorld());
    expect(c.lavaBelow54).toBe(5);
    expect(c.aquiferLavaAbove10).toBe(1);
    // 5 + 1 + 1 + the source and its 10 falling voxels + 1 over water.
    expect(c.lava).toBe(19);
    expect(c.lavaSupported).toBe(18);
    expect(c.lavaSky).toBe(0);
    const p = waterParts([c]);
    expect(p.lavaBelow54).toBe(1);
    expect(p.aquiferLavaAbove10).toBe(1);
    expect(p.lavaSupported).toBeCloseTo(18 / 19, 12);
    expect(p.lavaSkyRegions).toBe(0);
  });

  test('a lava voxel beside the cave air of a sky-connected component reaching 8 below its top counts', () => {
    const h = lavaWorld();
    // A shaft from the surface (y 70) down to y 40, its bottom a tagged lava source.
    fill(h, CHEESE, NO_FLUID, -20, -20, 41, 70, -20, -20);
    h.cells.set(key(-20, 40, -20), { cave: CHEESE, fluid: LAVA_SOURCE });
    const c = counts(h);
    expect(c.lavaSky).toBe(1);
    expect(waterParts([c, counts(lavaWorld())]).lavaSkyRegions).toBe(0.5);
  });
});

describe('A4: aquifer water bodies (SP7a §13.1)', () => {
  test('a sealed flooded cave is one body; a flooded cave linked to the sea, and the sea, none', () => {
    const h = coast();
    floodedUnderSea(h);
    expect(counts(h).aquiferBodies).toBe(0);
    fill(h, CHEESE, WATER_SOURCE, 5, 10, 0, 5, 10, 15);
    const c = counts(h);
    expect(c.aquiferBodies).toBe(1);
    // A body outside the interior is not counted.
    expect(counts(h, { x0: X0, z0: X0, x1: 0, z1: X1 }).aquiferBodies).toBe(0);
    expect(waterParts([c, counts(coast())]).aquiferBodies).toBe(0);
  });
});

describe('the recorded values and the interior (SP7a §13.1)', () => {
  test('skyOpenDeep counts sky-open water more than 12 below the top; the pits below sea dry after settle and in T; no probes, no margin count', () => {
    const h = coast();
    // A land pit at x 4 … 6, z 4 … 6: its top at y 50, dry (land: no level).
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) for (let y = 51; y <= 70; y++) h.cells.set(key(x, y, z), { cave: 0, fluid: NO_FLUID });
    // An untagged water pocket under land, 20 below the top (y 70).
    h.cells.set(key(20, 50, 20), { cave: 0, fluid: WATER_SOURCE });
    const c = counts(h);
    expect(c.skyOpenDeep).toBe(1);
    // The low tops: the sea's 32 × 64 positions (top 40, wet) and the pit's 9 (dry).
    expect(c.lowTops).toBe(32 * 64 + 9);
    expect(c.dryPits).toBe(9);
    expect(c.dryPitsT).toBe(9);
    expect(c.marginBarriers).toBeNaN();
    expect(waterParts([c]).dryPitsBelowSea).toBeCloseTo(9 / (32 * 64 + 9), 12);
    // The interior: the land half only.
    const land = counts(h, { x0: 0, z0: X0, x1: X1, z1: X1 });
    expect(land.lowTops).toBe(9);
    expect(land.areaKm2).toBeCloseTo((32 * 64) / 1e6, 12);
  });

  test('waterParts over no region is NaN, never ±Infinity', () => {
    for (const v of Object.values(waterParts([]))) expect(v).toBeNaN();
  });
});

describe('SP7a\'s review poses (§13.9)', () => {
  test('per pose the candidate nearest the spawn: a flooded cave under the sea, a dry cave below sea level, a river mouth, a coast, under water; no lake', () => {
    const h = coast();
    floodedUnderSea(h);
    fill(h, CHEESE, NO_FLUID, 5, 10, 20, 25, -5, 0);
    const view = viewOf(h);
    // The river: the sea's column x −1 at z 0 … 3 (river positions beside sea that is not river).
    const river = (): Uint8Array => {
      const m = new Uint8Array(64 * 64);
      for (let z = 0; z <= 3; z++) m[(z - X0) * 64 + (-1 - X0)] = 1;
      return m;
    };
    const spawn = { x: 0.5, z: 0.5 };
    const poses = waterExamples(view, referenceSettle(view, ALL), ALL, spawn, river);
    expect(poses.floodedUnderSea?.voxel).toEqual([-10, 30, 0]);
    expect(poses.dryBelowSea?.voxel).toEqual([5, 21, 0]);
    expect(poses.riverMouth?.voxel).toEqual([-1, 63, 0]);
    expect(poses.coastFancy?.voxel).toEqual([-1, 63, 0]);
    expect(poses.coastFancy?.yaw).toBe(270);
    expect(poses.underwater).toMatchObject({ voxel: [-1, 58, 0], y: 58 });
    expect(poses.lake).toBeNull();
    // A lake in the land (x 10 … 14, z 10 … 14 holding sky-open water from y 61 to its surface at 70).
    fill(h, 0, WATER_SOURCE, 10, 14, 61, 70, 10, 14);
    const lake = viewOf(h);
    expect(waterExamples(lake, referenceSettle(lake, ALL), ALL, spawn, river).lake?.voxel).toEqual([11, 70, 11]);
  });
});

describe('C7.waterWall\'s rules reader over a view\'s proto (SP7a §13.2, `protoRuleReader`)', () => {
  test('it reads the proto as the settle reference does: passable blocks, the proto fluid and the nibble; block outside the region', () => {
    const h = coast();
    // A dry cave under the land (x 5 … 9, y 20, z 0) on stone, with lava proto at (7, 20, 0) and abyss air at (9, 20, 0).
    fill(h, CHEESE, NO_FLUID, 5, 9, 20, 20, 0, 0);
    fill(h, CHEESE, LAVA_SOURCE, 7, 7, 20, 20, 0, 0);
    fill(h, CHEESE | (CAVE_BIOME.abyss << 4), NO_FLUID, 9, 9, 20, 20, 0, 0);
    const r = protoRuleReader(viewOf(h));
    expect(r.passable(5, 20, 0)).toBe(true);
    expect(r.passable(5, 19, 0)).toBe(false);
    expect(r.protoFluid(-5, 50, 0)).toBe(WATER_SOURCE);
    expect(r.protoFluid(7, 20, 0)).toBe(LAVA_SOURCE);
    expect(r.protoFluid(5, 19, 0)).toBe(NO_FLUID);
    expect(r.nibble(9, 20, 0)).toBe(CAVE_BIOME.abyss);
    expect(r.nibble(5, 20, 0)).toBe(0);
    expect(r.passable(X1, 100, 0)).toBe(false);
    expect(r.passable(0, MIN_Y - 1, 0)).toBe(false);
    // Water at (6, 20, 0): the lava proto east of it is `block` for water's rules, so west is its one open side.
    expect(spreadSides(r, packFluid(FLUID_WATER, 2), 6, 20, 0)).toBe(0b1000);
    // At (8, 20, 0): the abyss side east stays a spread side (the abyss stop), the lava west does not.
    expect(spreadSides(r, packFluid(FLUID_WATER, 2), 8, 20, 0)).toBe(0b0010);
  });
});

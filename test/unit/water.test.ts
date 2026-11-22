/**
 * The A parts' instruments (SP7a spec §13.1, D30; `test/harness/water.ts`) on hand-built 4 × 4-column views (a plain
 * store's proto, chunks −2 … 1 on each axis), each read after the global settle reference over the view
 * (`referenceSettle`), as the caves metric's region worker reads its regions: A1's population and dry share, A3's four
 * counts, A4's bodies, the pooled parts, and SP7a's review poses; A2 by origin with the water/lava contacts
 * (`referenceSettleOrigins`, `a2RegionCounts`), and the springs found from a region's proto (`springsOfRegion`, on
 * real columns of seed '42' and on hand-built side-by-side springs) with a spring's own front (`springFront`).
 */
import { describe, expect, test } from 'vitest';
import { CAVE_BIOME, CAVE_KIND, MIN_Y } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { createSettleScratch } from '../../src/gen/fluids/settle';
import { newSpringList, springTries, type SpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { LAVA_CHUNKS, WATER_CHUNKS } from '../../src/metrics/sp7aGoldens';
import { FLUID_WATER, fluidLevel, fluidUnsettled, LAVA_SOURCE, NO_FLUID, packFluid, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, STONE } from '../../src/world/blocks/index';
import { createStore } from '../../src/world/store/store';
import { spreadSides } from '../harness/caveMetrics';
import { referenceSettle, referenceSettleKey, referenceSettleOrigins } from '../harness/refs';
import { genRegion, regionView, type RegionView } from '../harness/region';
import {
  a2Parts, a2RegionCounts, ORIGIN_AQUIFER, ORIGIN_SKY_OPEN, ORIGIN_SPRING, protoRuleReader, regionSpringList, regionVoxelOf, springFront, springsOfRegion,
  waterExamples, waterParts, waterRegionCounts, type A2RegionCounts, type WaterBox, type WaterRegionCounts,
} from '../harness/water';

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

/** No springs (a view whose sources are all sky-open water or aquifer cells). */
const NO_SPRINGS: SpringList = { n: 0, pos: new Int32Array(0), kind: new Uint8Array(0), dir: new Uint8Array(0) };

/** The settle reference over the whole view, its origins and contacts, and A2's counts on the view. */
function a2Of(view: RegionView, springs: SpringList = NO_SPRINGS, settled = referenceSettle(view, ALL)): {
  settled: Map<number, number>; origins: Map<number, number>; contacts: Set<number>; a2: A2RegionCounts;
} {
  const origins = new Map<number, number>();
  const contacts = new Set<number>();
  referenceSettleOrigins(view, ALL, springs, origins, contacts);
  return { settled, origins, contacts, a2: a2RegionCounts(view, settled, ALL, origins, contacts) };
}

/** A count by origin, summed. */
const total = (c: { skyOpen: number; aquifer: number; spring: number }): number => c.skyOpen + c.aquifer + c.spring;

/** Stone to y 40 and air above, with a tagged cave corridor (dry air) over y 41 … 45 on the floor at y 40, x 0 … 20, z −3 … 3. */
function corridor(): Hand {
  const h: Hand = { block: (_x, y) => (y <= 70 ? STONE : AIR), cells: new Map() };
  fill(h, CHEESE, NO_FLUID, 0, 20, 41, 45, -3, 3);
  return h;
}

describe('A2: the fluid voxels one application of §4.1\'s rules would change, the unsettled, the contacts (SP7a §13.1)', () => {
  test('a settled spill reads 0 changes; a spill with one level raised by hand reads 1', () => {
    const h = corridor();
    h.cells.set(key(0, 41, 0), { cave: CHEESE, fluid: WATER_SOURCE });
    const view = viewOf(h);
    const { settled, origins, contacts, a2 } = a2Of(view);
    // The spill spreads from its source over the floor (levels 1 … 7), so the reference changed the view.
    expect(settled.size).toBeGreaterThan(20);
    expect(contacts.size).toBe(0);
    expect(total(a2.fluid)).toBe(settled.size + 1);
    expect(a2.fluid.aquifer).toBe(settled.size + 1);
    expect(total(a2.unsupported)).toBe(0);
    expect(total(a2.unsettled)).toBe(0);
    // One voxel at level 3 raised to 4: its feeder at level 2 would lower it back, and nothing else changes.
    const k = [...settled].find(([, b]) => fluidLevel(b) === 3)![0];
    const raised = new Map(settled).set(k, packFluid(FLUID_WATER, 4));
    const r = a2RegionCounts(view, raised, ALL, origins, contacts);
    expect(r.unsupported).toEqual({ skyOpen: 0, aquifer: 1, spring: 0 });
    expect(total(r.unsettled)).toBe(0);
    const p = a2Parts([r]);
    expect(p.unsupported).toBeCloseTo(1 / total(r.fluid), 12);
    expect(p.unsettled).toBe(0);
    expect(p.byOrigin.aquifer.unsupportedKm2).toBeCloseTo(1 / r.areaKm2, 6);
  });

  test('a truncated front\'s bit-6 voxels count in both parts', () => {
    // A 1-wide corridor down a stair (each step 3 blocks long and 1 deep, from x 0), its source at x 0: each landed fall
    // spreads as a source, so the levels restart while the distance runs on to the cap, 12, where the front is cut.
    const h: Hand = { block: (_x, y) => (y <= 70 ? STONE : AIR), cells: new Map() };
    for (let x = 0; x <= 30; x++) fill(h, CHEESE, NO_FLUID, x, x, 41 - Math.floor(x / 3), 45, 0, 0);
    h.cells.set(key(0, 41, 0), { cave: CHEESE, fluid: WATER_SOURCE });
    const { settled, a2 } = a2Of(viewOf(h));
    const cut = [...settled.values()].filter((b) => fluidUnsettled(b)).length;
    expect(cut).toBeGreaterThan(0);
    expect(a2.unsettled).toEqual({ skyOpen: 0, aquifer: cut, spring: 0 });
    expect(a2.unsupported).toEqual({ skyOpen: 0, aquifer: cut, spring: 0 });
    expect(a2.contacts).toBe(0);
  });

  test('a water/lava contact counts in contacts, not as a settle defect', () => {
    // A 1-wide corridor on the floor (z 0), a water source at x 0 and a lava source at x 6: water spreads to x 1 … 5 (the
    // lava proto is `block` to it), lava to x 3 … 5 and 7 … 9, so x 3 … 5 are reached by both: lava with bit 6.
    const h: Hand = { block: (_x, y) => (y <= 70 ? STONE : AIR), cells: new Map() };
    fill(h, CHEESE, NO_FLUID, -2, 12, 41, 41, 0, 0);
    h.cells.set(key(0, 41, 0), { cave: CHEESE, fluid: WATER_SOURCE });
    h.cells.set(key(6, 41, 0), { cave: CHEESE, fluid: LAVA_SOURCE });
    const view = viewOf(h);
    const { settled, origins, contacts, a2 } = a2Of(view);
    expect([...contacts].map((k) => regionVoxelOf(view, k)).sort((a, b) => a[0] - b[0])).toEqual([[3, 41, 0], [4, 41, 0], [5, 41, 0]]);
    for (const k of contacts) expect(fluidUnsettled(settled.get(k)!)).toBe(true);
    expect(a2.contacts).toBe(3);
    expect(total(a2.unsettled)).toBe(0);
    expect(total(a2.unsupported)).toBe(0);
    expect(a2Parts([a2]).contacts).toBe(3);
    // Without the contact set, the same bit-6 voxels would read as unsettled.
    expect(total(a2RegionCounts(view, settled, ALL, origins, new Set()).unsettled)).toBe(3);
  });

  test('a spring\'s voxels carry the spring origin, an aquifer cell\'s voxels the aquifer\'s, the sea\'s sky-open (ties to sky-open)', () => {
    const h = coast();
    // A tagged corridor off the sea (x 0 … 4, y 50, z 0, on rock) ending at an aquifer source at x 5: the sea's voxel at
    // x −1 feeds x 0, 1, 2 (x 2 at distance 3 from both: the tie goes to sky-open), the aquifer x 3 and 4.
    fill(h, CHEESE, NO_FLUID, 0, 4, 50, 50, 0, 0);
    h.cells.set(key(5, 50, 0), { cave: CHEESE, fluid: WATER_SOURCE });
    // A spring in the rock at (10, 60, 10) facing east, its outlet shaft (x 11, y 51 … 60) over a chamber at y 51 (x 11 … 15,
    // z 8 … 12): its stream falls and spreads over the chamber's floor.
    h.cells.set(key(10, 60, 10), { cave: 0, fluid: WATER_SOURCE });
    fill(h, 0, NO_FLUID, 11, 11, 52, 60, 10, 10);
    fill(h, CHEESE, NO_FLUID, 11, 15, 51, 51, 8, 12);
    const view = viewOf(h);
    const springs = newSpringList();
    springs.n = 1;
    springs.pos[0] = referenceSettleKey(view, 10, 60, 10);
    springs.dir[0] = 1;
    const { settled, origins, contacts, a2 } = a2Of(view, springs);
    expect(contacts.size).toBe(0);
    const originAt = (x: number, y: number, z: number): number | undefined => origins.get(referenceSettleKey(view, x, y, z));
    expect([0, 1, 2, 3, 4].map((x) => originAt(x, 50, 0))).toEqual([ORIGIN_SKY_OPEN, ORIGIN_SKY_OPEN, ORIGIN_SKY_OPEN, ORIGIN_AQUIFER, ORIGIN_AQUIFER]);
    expect(originAt(10, 60, 10)).toBe(ORIGIN_SPRING);
    // Every voxel the settle filled under the spring is the spring's: its shaft and the chamber's floor.
    let fed = 0;
    for (const [k] of settled) {
      const [x, , z] = regionVoxelOf(view, k);
      if (x < 11) continue;
      expect(origins.get(k), `${regionVoxelOf(view, k).join(',')}`).toBe(ORIGIN_SPRING);
      fed++;
    }
    expect(fed).toBeGreaterThan(9 + 5);
    // The proto's sea and aquifer source are their own origins (not listed); the settled voxels are all listed.
    expect(originAt(-5, 50, 0)).toBeUndefined();
    for (const k of settled.keys()) expect(origins.has(k)).toBe(true);
    expect(a2.fluid.spring).toBe(fed + 1);
    expect(a2.fluid.aquifer).toBe(1 + 2);
    expect(a2.fluid.skyOpen).toBe(32 * 64 * 23 + 3);
    expect(total(a2.unsupported)).toBe(0);
    // The spring's own front: its stream, exactly the voxels the settle filled under it.
    const front: string[] = [];
    springFront(view, springs, 0, createSettleScratch(), { set: (x, y, z) => { front.push(key(x, y, z)); } });
    expect(front.length).toBe(fed);
  });
});

describe('the springs of a region from its proto (SP7a §3.1, `springsOfRegion`)', () => {
  test('the replay finds exactly T\'s springs on 16 real columns of seed \'42\' (8 with water springs, 8 with lava springs)', async () => {
    const params = resolveProfile('default');
    const seed = seedFromInput('42');
    const ctx = createGenContext(seed, params);
    const tList = newSpringList();
    let found = 0;
    for (const [cx, cz] of [...WATER_CHUNKS.slice(0, 8), ...LAVA_CHUNKS.slice(0, 8)]) {
      // The column with its ring, so every face of its springs lies in the view.
      const { view } = await genRegion({ seed: '42', params, cx0: cx - 1, cz0: cz - 1, w: 3, h: 3, upTo: 'T', order: 'spiral', threads: 1 });
      const list = regionSpringList(view, params);
      springsOfRegion(view, seed, params, list);
      const got: number[][] = [];
      for (let i = 0; i < list.n; i++) {
        const [x, y, z] = regionVoxelOf(view, list.pos[i]!);
        if (x >> 4 === cx && z >> 4 === cz) got.push([x, y, z, list.kind[i]!, list.dir[i]!]);
      }
      terrainSpringsDebug(ctx, cx, cz, tList);
      const want: number[][] = [];
      for (let i = 0; i < tList.n; i++) {
        const j = tList.pos[i]!;
        want.push([16 * cx + (j & 15), (j >> 8) - 64, 16 * cz + ((j >> 4) & 15), tList.kind[i]!, tList.dir[i]!]);
      }
      expect(got, `chunk (${cx}, ${cz})`).toEqual(want);
      found += want.length;
    }
    expect(found).toBeGreaterThanOrEqual(16);
  }, 120_000);

  test('two side-by-side springs on a hand-built view are both found; one whose neighbour is a source at no spring is not', () => {
    // Water tries only (8 per chunk, no lava); the first chunk of the view holding two tries at horizontally adjacent
    // positions whose outlets (two, inside the view) open on neither spring's other faces.
    const base = resolveProfile('default');
    const params: Params = { ...base, springs: { ...base.springs, water: { ...base.springs.water, tries: 8 }, lava: { ...base.springs.lava, tries: 0 } } };
    const seed = seedFromInput('42');
    const draws = new Float64Array(40);
    let pair: { a: number[]; b: number[] } | null = null;
    const near = (p: readonly number[], q: readonly number[]): boolean => Math.abs(p[0]! - q[0]!) + Math.abs(p[1]! - q[1]!) === 1;
    const same = (p: readonly number[], q: readonly number[]): boolean => p[0] === q[0] && p[1] === q[1];
    const DX = [0, 1, 0, -1];
    const DZ = [-1, 0, 1, 0];
    for (let cz = CX0; cz < CX0 + SIDE && pair === null; cz++) {
      for (let cx = CX0; cx < CX0 + SIDE && pair === null; cx++) {
        springTries(seed, 'water', cx, cz, 8, draws);
        const tries = Array.from({ length: 8 }, (_, t) => {
          const x = 16 * cx + draws[5 * t]!, z = 16 * cz + draws[5 * t + 1]!, d = draws[5 * t + 2]!;
          return [x, z, d, x + DX[d]!, z + DZ[d]!];
        });
        for (const a of tries) {
          for (const b of tries) {
            const oa = a.slice(3), ob = b.slice(3);
            if (pair !== null || !near(a, b) || same(oa, ob) || same(oa, b) || same(ob, a) || near(ob, a) || near(oa, b)) continue;
            if ([oa, ob].some(([x, z]) => x! < X0 || x! >= X1 || z! < X0 || z! >= X1)) continue;
            pair = { a, b };
          }
        }
      }
    }
    expect(pair).not.toBeNull();
    const { a, b } = pair!;
    /** Rock to y 100; the two springs at y 80 with their outlets' shafts (y 72 … 80). */
    const build = (): Hand => {
      const h: Hand = { block: (_x, y) => (y <= 100 ? STONE : AIR), cells: new Map() };
      for (const s of [a, b]) {
        h.cells.set(key(s[0]!, 80, s[1]!), { cave: 0, fluid: WATER_SOURCE });
        fill(h, 0, NO_FLUID, s[3]!, s[3]!, 72, 80, s[4]!, s[4]!);
      }
      return h;
    };
    const springsOf = (h: Hand): number[][] => {
      const view = viewOf(h);
      const list = regionSpringList(view, params);
      springsOfRegion(view, seed, params, list);
      return Array.from({ length: list.n }, (_, i) => [...regionVoxelOf(view, list.pos[i]!), list.kind[i]!, list.dir[i]!]).sort((p, q) => p[0]! - q[0]! || p[2]! - q[2]!);
    };
    const want = [[a[0]!, 80, a[1]!, 0, a[2]!], [b[0]!, 80, b[1]!, 0, b[2]!]].sort((p, q) => p[0]! - q[0]! || p[2]! - q[2]!);
    expect(springsOf(build())).toEqual(want);
    // b's outlet shut with rock: b is no try's match, so a's face toward it holds a source at no spring and a is not one either.
    const h = build();
    for (let y = 72; y <= 80; y++) h.cells.delete(key(b[3]!, y, b[4]!));
    expect(springsOf(h)).toEqual([]);
  });
});

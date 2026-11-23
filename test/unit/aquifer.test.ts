import { describe, expect, test } from 'vitest';
import { AQUIFER_BARRIER, AQUIFER_EMPTY, CAVE_BIOME } from '../../src/core/constants';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import {
  caveBiomeAt, cavePickerOf, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs,
} from '../../src/gen/biomes/cavePicker';
import { caveTagAt } from '../../src/gen/caves/tags';
import { columnPoint, newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { buildColumnSample, newColumnSample, readLevel, type ColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { solidAt } from '../../src/gen/density/probe';
import {
  aquiferColumn, aquiferColumnSlow, aquiferInputs, cellCandidates, cellCentre, cellKindOf, cellOf, cellStatus, createAquiferScratch,
  inAbyssMargin, pressure, statusOf, voxelRule, type AquiferInputs, type AquiferSettings,
} from '../../src/gen/fluids/aquifer';
import { FLUID_LAVA, FLUID_WATER, LAVA_SOURCE, WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AQUIFER_NOISES, AQUIFER_SETTINGS } from '../harness/aquiferDefaults';
import { ctxFor, paramsWith } from '../harness/gen';
import { testRng } from '../harness/stats';

const ST: AquiferSettings = AQUIFER_SETTINGS;
const typeOf = (s: number): number => s >>> 16;
const levelOf = (s: number): number => (s & 0xffff) - 32768;
/** A uniform integer in lo … hi from `testRng`. */
const intIn = (next: () => number, lo: number, hi: number): number => lo + (next() % (hi - lo + 1));
const inputsFor = (seed: string): AquiferInputs => aquiferInputs(createGenContext(seedFromInput(seed), paramsWith()), ST, AQUIFER_NOISES);

describe('the aquifer cells (SP7a spec §1.1, Spec correction 3)', () => {
  test('cellOf: i = ⌊(x − 5)/16⌋, j = ⌊(y + 1)/12⌋, k = ⌊(z − 5)/16⌋', () => {
    const out = new Int32Array(3);
    const iOf = (x: number): number => (cellOf(x, 0, 0, out), out[0]!);
    const jOf = (y: number): number => (cellOf(0, y, 0, out), out[1]!);
    const kOf = (z: number): number => (cellOf(0, 0, z, out), out[2]!);
    expect([4, 5, 20, 21].map(iOf)).toEqual([-1, 0, 0, 1]);
    expect([4, 5, 20, 21].map(kOf)).toEqual([-1, 0, 0, 1]);
    expect([-2, -1, 10, 11].map(jOf)).toEqual([-1, 0, 0, 1]);
  });

  test('every centre lies within its cell\'s ranges (16i + 0 … 9, 12j + 0 … 8, 16k + 0 … 9), each jitter reaching both ends', () => {
    const inp = inputsFor('42');
    const rng = testRng(5);
    const c = new Int32Array(3);
    const seen = [new Set<number>(), new Set<number>(), new Set<number>()];
    for (let n = 0; n < 4000; n++) {
      const i = intIn(rng, -300, 300);
      const j = intIn(rng, -7, 27);
      const k = intIn(rng, -300, 300);
      cellCentre(inp, i, j, k, c);
      const d = [c[0]! - 16 * i, c[1]! - 12 * j, c[2]! - 16 * k];
      expect(d[0]).toBeGreaterThanOrEqual(0);
      expect(d[0]).toBeLessThanOrEqual(9);
      expect(d[1]).toBeGreaterThanOrEqual(0);
      expect(d[1]).toBeLessThanOrEqual(8);
      expect(d[2]).toBeGreaterThanOrEqual(0);
      expect(d[2]).toBeLessThanOrEqual(9);
      for (let a = 0; a < 3; a++) seen[a]!.add(d[a]!);
    }
    expect(seen.map((s) => s.size)).toEqual([10, 9, 10]);
  });

  test('centres are identical across call orders and two inputs of one seed, and differ for seed \'43\'', () => {
    const a = inputsFor('42');
    const b = inputsFor('42');
    const other = inputsFor('43');
    const cells: Array<[number, number, number]> = [];
    for (let i = -3; i <= 3; i++) for (let j = -7; j <= 27; j += 5) for (let k = -3; k <= 3; k++) cells.push([i, j, k]);
    const c = new Int32Array(3);
    const forward = cells.map(([i, j, k]) => (cellCentre(a, i, j, k, c), [c[0]!, c[1]!, c[2]!]));
    const backward = [...cells].reverse().map(([i, j, k]) => (cellCentre(b, i, j, k, c), [c[0]!, c[1]!, c[2]!])).reverse();
    expect(forward.length).toBe(cells.length);
    for (let n = 0; n < cells.length; n++) for (let a3 = 0; a3 < 3; a3++) expect(Object.is(forward[n]![a3], backward[n]![a3])).toBe(true);
    const fromOther = cells.map(([i, j, k]) => (cellCentre(other, i, j, k, c), [c[0]!, c[1]!, c[2]!]));
    expect(fromOther).not.toEqual(forward);
  });

  test('the 12 candidates: i … i + 1, j − 1 … j + 1, k … k + 1, i outer, j, k inner', () => {
    const out = new Int32Array(36);
    cellCandidates(21, 11, 4, out); // cell (1, 1, −1)
    const expected: number[] = [];
    for (let i = 1; i <= 2; i++) for (let j = 0; j <= 2; j++) for (let k = -1; k <= 0; k++) expected.push(i, j, k);
    expect([...out]).toEqual(expected);
  });
});

describe('the aquifer statuses (SP7a spec §1.2-§1.4)', () => {
  test('near the surface: ⌊surfaceWaterLevel⌋ water under the sea and under a lake, empty on land', () => {
    const sea = statusOf(ST, 30, 40, 63, 0, 0, 0); // centre 30 ≥ 40 − 12
    expect([typeOf(sea), levelOf(sea)]).toEqual([FLUID_WATER, 63]);
    const lake = statusOf(ST, 30, 40, 95, 0, 0, 0);
    expect([typeOf(lake), levelOf(lake)]).toEqual([FLUID_WATER, 95]);
    expect(statusOf(ST, 30, 40, -Infinity, 0, 0, 0)).toBe(AQUIFER_EMPTY);
    expect(statusOf(ST, 28, 40, 63.6, -1, 0, 0)).toBe(statusOf(ST, 28, 40, 63, 1, 1, 1)); // ⌊63.6⌋, no noise read
  });

  test('the ocean factor: offset 63 → t 0, 55 → 1, 59 → 0.5 (full threshold 0.25)', () => {
    const full = (offset: number, nf: number): boolean => cellKindOf(ST, 0, offset, -Infinity, nf) === 2;
    expect([full(63, 0.81), full(63, 0.79)]).toEqual([true, false]);
    expect([full(55, -0.29), full(55, -0.31)]).toEqual([true, false]);
    expect([full(59, 0.26), full(59, 0.24)]).toEqual([true, false]);
    const s = statusOf(ST, 0, 59, -Infinity, 0.26, 0, 0);
    expect([typeOf(s), levelOf(s)]).toEqual([FLUID_WATER, 63]);
    expect(statusOf(ST, 0, 59, -Infinity, 0.24, 0, 0)).not.toBe(s);
  });

  test('partial levels: ⌊cy/40⌋·40 + 20 + 3·round(ns·10/3)', () => {
    const level = (cy: number, ns: number): number => levelOf(statusOf(ST, cy, 200, -Infinity, 0.5, ns, 0));
    expect(level(25, 1)).toBe(29);
    expect(level(25, -1)).toBe(11);
    expect(level(25, 0.15)).toBe(23); // Math.round(0.5) = 1
    expect(level(25, 3)).toBe(29); // ns clamped to [−1, 1]
    expect(level(-5, 0)).toBe(-20); // band −40 … 0, middle −20
    expect(level(-5, 1)).toBe(-11);
    expect(level(-5, -1)).toBe(-29);
  });

  test('lava: a partial level ≤ −10 with |nlava| > 0.3 (rulings P3)', () => {
    const at = (cy: number, ns: number, nlava: number): number => statusOf(ST, cy, 200, -Infinity, 0.5, ns, nlava);
    expect(levelOf(at(-20, -0.3, 0.31))).toBe(-23);
    expect(typeOf(at(-20, -0.3, 0.31))).toBe(FLUID_LAVA);
    expect(typeOf(at(-20, -0.3, -0.31))).toBe(FLUID_LAVA);
    expect(typeOf(at(-20, -0.3, 0.29))).toBe(FLUID_WATER);
    expect(levelOf(at(-20, 1, 0.9))).toBe(-11); // the highest level of the band −40 … 0 is lava-eligible
    expect(typeOf(at(-20, 1, 0.9))).toBe(FLUID_LAVA);
    expect(levelOf(at(20, -1, 0.9))).toBe(11);
    expect(typeOf(at(20, -1, 0.9))).toBe(FLUID_WATER);
    expect(typeOf(at(-20, -0.3, 5))).toBe(FLUID_LAVA); // nlava clamped
  });

  test('under the sea (t 1) a cell floods partially at nf −0.79; empty otherwise', () => {
    expect(cellKindOf(ST, 0, 40, 63, -0.79)).toBe(3);
    expect(statusOf(ST, 0, 40, 63, -0.79, 0, 0)).not.toBe(AQUIFER_EMPTY);
    expect(cellKindOf(ST, 0, 40, 63, -0.81)).toBe(0);
    expect(statusOf(ST, 0, 40, 63, -0.81, 0, 0)).toBe(AQUIFER_EMPTY);
    expect(statusOf(ST, 0, 100, -Infinity, 0.39, 0, 0)).toBe(AQUIFER_EMPTY); // inland (t 0): partial needs nf > 0.4
  });

  test('cellKindOf names each branch; a partial cell at level 63 reads 3, not 2', () => {
    expect(cellKindOf(ST, 30, 40, 63, 0)).toBe(1);
    expect(cellKindOf(ST, 30, 40, -Infinity, 0)).toBe(1);
    expect(cellKindOf(ST, 0, 100, -Infinity, 0.9)).toBe(2);
    expect(cellKindOf(ST, 0, 100, -Infinity, 0.5)).toBe(3);
    expect(cellKindOf(ST, 0, 100, -Infinity, 0.3)).toBe(0);
    const s = statusOf(ST, 50, 200, -Infinity, 0.5, 0.3, 0); // cy 40 … 79, ns 0.3: 40 + 20 + 3
    expect([typeOf(s), levelOf(s)]).toEqual([FLUID_WATER, 63]);
    expect(s).toBe(statusOf(ST, 0, 200, -Infinity, 0.9, 0, 0)); // the same packed status as a full cell
    expect(cellKindOf(ST, 50, 200, -Infinity, 0.5)).toBe(3);
  });

  test('cellStatus equals statusOf on the sampled values at 200 cells of seed \'42\', and its kindOut cellKindOf\'s', () => {
    const ctx = ctxFor('42');
    const inp = aquiferInputs(ctx, ST, AQUIFER_NOISES);
    const rng = testRng(7);
    const rec = newPointRecord();
    const c = new Int32Array(3);
    const kind = new Int32Array(1);
    const kinds = new Set<number>();
    for (let n = 0; n < 200; n++) {
      const i = intIn(rng, -40, 40);
      const j = intIn(rng, -7, 10);
      const k = intIn(rng, -40, 40);
      cellCentre(inp, i, j, k, c);
      const [cx, cy, cz] = [c[0]!, c[1]!, c[2]!];
      const p = samplePoint(ctx, 16 * i, 16 * k, false, rec);
      const nf = inp.floodedness.z3(cx, 0.67 * cy, cz);
      const ns = inp.spread.z3(cx, 0.714 * cy, cz);
      const nlava = inp.lava.z3(64 * Math.floor(cx / 64), 40 * Math.floor(cy / 40), 64 * Math.floor(cz / 64));
      kind[0] = -1;
      expect(cellStatus(inp, i, j, k, kind)).toBe(statusOf(ST, cy, p.offset, p.surfaceWaterLevel, nf, ns, nlava));
      expect(kind[0]).toBe(cellKindOf(ST, cy, p.offset, p.surfaceWaterLevel, nf));
      expect(cellStatus(inp, i, j, k)).toBe(statusOf(ST, cy, p.offset, p.surfaceWaterLevel, nf, ns, nlava));
      kinds.add(kind[0]!);
    }
    expect([...kinds].sort()).toEqual([0, 1, 2, 3]);
  });
});

/** A packed status (Task 5's form): type << 16 | (level + 32768). */
const pk = (type: number, level: number): number => (type << 16) | (level + 32768);
const W63 = pk(FLUID_WATER, 63);
const EMPTY = AQUIFER_EMPTY;
const BARRIER = AQUIFER_BARRIER;

describe('the aquifer voxel rule (SP7a spec §1.4-§1.6, D20, Spec correction 7)', () => {
  test('pressure: water 63 against empty is 15 at y 40 and −11 at y 90; the e ≤ 0 branch; equal levels 0; water against lava both fluid 2', () => {
    expect(pressure(40, W63, EMPTY)).toBe(15);
    expect(pressure(90, W63, EMPTY)).toBe(-11);
    expect(pressure(40, EMPTY, W63)).toBe(15);
    const w29 = pk(FLUID_WATER, 29);
    expect(pressure(0, W63, w29)).toBeCloseTo(-2.55, 12); // e −45.5, o −28.5, q −25.5 → q/10
    expect(pressure(40, W63, w29)).toBeCloseTo(14.5 / 3, 12); // e −5.5, o 11.5, q 14.5 → q/3
    expect(pressure(40, W63, W63)).toBe(0);
    const wm20 = pk(FLUID_WATER, -20);
    const lm23 = pk(FLUID_LAVA, -23);
    expect(pressure(-30, wm20, lm23)).toBe(2);
    expect(pressure(-23, lm23, wm20)).toBe(2); // y ≤ level for both
    expect(pressure(-21, wm20, lm23)).toBeCloseTo(1 / 3, 12); // lava holds no fluid at −21: e 1, o 0.5
    expect(pressure(-20, pk(FLUID_WATER, -23), lm23)).toBe(0); // equal levels, neither fluid at −20
  });

  test('equal statuses, or d2 − d1 = barrierBand (30), never place a barrier: s1 fills at y ≤ level, air above (Spec correction 7)', () => {
    const band = ST.barrierBand;
    expect(band).toBe(30); // 25 until Task 27l's lever (SP7a §1.5, §13.8; rulings R21)
    expect(voxelRule(ST, 40, 3, W63, 4, W63, 3, false, false)).toBe(WATER_SOURCE);
    expect(voxelRule(ST, 63, 3, W63, 4, W63, 3, false, false)).toBe(WATER_SOURCE);
    expect(voxelRule(ST, 64, 3, W63, 4, W63, 3, false, false)).toBe(0);
    expect(voxelRule(ST, 40, 10, W63, 10 + band, EMPTY, 3, false, false)).toBe(WATER_SOURCE);
    expect(voxelRule(ST, 40, 10, EMPTY, 10 + band, W63, 3, false, false)).toBe(0);
    expect(voxelRule(ST, 40, 10, W63, 9 + band, EMPTY, 0, false, false)).toBe(BARRIER); // d2 − d1 = band − 1: inside the band
  });

  test('water 63 against empty at d2 − d1 = 5 with nb 0: a barrier at y 40, none at y 90', () => {
    expect(voxelRule(ST, 40, 10, W63, 15, EMPTY, 0, false, false)).toBe(BARRIER);
    expect(voxelRule(ST, 40, 10, EMPTY, 15, W63, 0, false, false)).toBe(BARRIER);
    expect(voxelRule(ST, 90, 10, W63, 15, EMPTY, 0, false, false)).toBe(0);
    expect(voxelRule(ST, 40, 10, W63, 15, EMPTY, -100, false, false)).toBe(BARRIER); // p 15 > 2: nb is not read
  });

  test('the barrier\'s reach ends at y < level + 4.5: p < −2 beyond it, where nb is not read (the fast path\'s +4)', () => {
    expect(pressure(67, W63, EMPTY)).toBeCloseTo(-1.8, 12);
    expect(pressure(68, W63, EMPTY)).toBeCloseTo(-2.2, 12);
    expect(voxelRule(ST, 67, 10, W63, 15, EMPTY, 1.9, false, false)).toBe(BARRIER);
    expect(voxelRule(ST, 67, 10, W63, 15, EMPTY, 1.7, false, false)).toBe(0);
    for (let y = 68; y <= 319; y++) {
      expect(pressure(y, W63, EMPTY)).toBeLessThan(-2);
      expect(voxelRule(ST, y, 10, W63, 15, EMPTY, 3, false, false)).toBe(0);
    }
  });

  test('water against lava, both fluid at y: a barrier whatever nb (pressure 2)', () => {
    const wm20 = pk(FLUID_WATER, -20);
    const lm23 = pk(FLUID_LAVA, -23);
    expect(voxelRule(ST, -30, 10, wm20, 9 + ST.barrierBand, lm23, -3, false, false)).toBe(BARRIER);
    expect(voxelRule(ST, -30, 10, lm23, 11, wm20, -3, false, false)).toBe(BARRIER);
    expect(voxelRule(ST, -30, 10, wm20, 10 + ST.barrierBand, lm23, -3, false, false)).toBe(WATER_SOURCE); // outside the band
  });

  test('the abyss: a water status reads as empty inside it (air); in the margin water is barrier rock at y ≤ level, air above; lava unaffected', () => {
    expect(voxelRule(ST, 40, 0, W63, 100, W63, 0, true, false)).toBe(0);
    expect(voxelRule(ST, 40, 10, W63, 15, EMPTY, 0, true, false)).toBe(0); // both read empty: no barrier
    expect(voxelRule(ST, 40, 0, W63, 100, EMPTY, 0, false, true)).toBe(BARRIER);
    expect(voxelRule(ST, 63, 0, W63, 100, EMPTY, 0, false, true)).toBe(BARRIER);
    expect(voxelRule(ST, 64, 0, W63, 100, EMPTY, 0, false, true)).toBe(0);
    const lm23 = pk(FLUID_LAVA, -23);
    expect(voxelRule(ST, -30, 0, lm23, 100, lm23, 0, true, false)).toBe(LAVA_SOURCE);
    expect(voxelRule(ST, -30, 0, lm23, 100, lm23, 0, false, true)).toBe(LAVA_SOURCE);
    expect(voxelRule(ST, -55, 0, W63, 100, W63, 0, true, false)).toBe(LAVA_SOURCE); // the −54 rule applies unchanged
  });

  test('an empty voxel at y −55 is a lava source, at −54 air; a water status filling there keeps its water', () => {
    expect(voxelRule(ST, -55, 0, EMPTY, 100, EMPTY, 0, false, false)).toBe(LAVA_SOURCE);
    expect(voxelRule(ST, -54, 0, EMPTY, 100, EMPTY, 0, false, false)).toBe(0);
    expect(voxelRule(ST, -55, 0, pk(FLUID_WATER, -60), 100, EMPTY, 0, false, false)).toBe(LAVA_SOURCE); // above its level
    expect(voxelRule(ST, -55, 0, pk(FLUID_WATER, -50), 100, EMPTY, 0, false, false)).toBe(WATER_SOURCE);
  });
});

/** Index of voxel (p, y) in a column's arrays: 256·(y + 64) + p. */
const vi = (p: number, y: number): number => 256 * (y + 64) + p;
/** The first index where two arrays differ, −1 when equal (a 98,304-entry `toEqual` is slow). */
function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let n = 0; n < a.length; n++) if (a[n] !== b[n]) return n;
  return -1;
}
interface Column { readonly ctx: GenContext; readonly s: ColumnSample; readonly pick: CavePickerInputs; readonly pass: CaveColumnPass }
interface Stepped { solid: Uint8Array; tags: Uint8Array; waterV: Uint8Array; fluid: Uint8Array; topFluid: Int32Array }

function columnOf(ctx: GenContext, cx: number, cz: number): Column {
  const s = buildColumnSample(ctx, cx, cz, newColumnSample());
  const pick = cavePickerOf(ctx);
  return { ctx, s, pick, pass: fillCaveColumnPass(pick, s, newCaveColumnPass()) };
}

/** Runs the aquifer step (the fast path unless `slow`) on copies of `solid` and `tags`; stale outputs are prefilled. */
function step(inp: AquiferInputs, col: Column, solid: Uint8Array, tags: Uint8Array, slow = false): Stepped {
  const o: Stepped = {
    solid: solid.slice(), tags: tags.slice(), waterV: new Uint8Array(98304).fill(7), fluid: new Uint8Array(98304).fill(7),
    topFluid: new Int32Array(256).fill(1000),
  };
  (slow ? aquiferColumnSlow : aquiferColumn)(inp, col.s, col.pick, col.pass, o.solid, o.tags, o.waterV, o.fluid, o.topFluid, createAquiferScratch());
  return o;
}

/** A synthetic column: solid at y −64 and y ≤ `top`; the air above tagged with `tag` from `tagLo` to `tagHi`. */
function synthetic(top: number, tag: number, tagLo: number, tagHi: number): { solid: Uint8Array; tags: Uint8Array } {
  const solid = new Uint8Array(98304);
  const tags = new Uint8Array(98304);
  for (let p = 0; p < 256; p++) {
    for (let y = -64; y <= 319; y++) {
      if (y === -64 || y <= top) solid[vi(p, y)] = 1;
      else if (y >= tagLo && y <= tagHi) tags[vi(p, y)] = tag;
    }
  }
  return { solid, tags };
}

/** Column (−96, −96) of seed '42' is open sea (surfaceWaterLevel 63 at every corner); (0, 0) is dry land. */
const OCEAN: readonly [number, number] = [-96, -96];
const LAND: readonly [number, number] = [0, 0];

describe('the aquifer column step (SP7a spec §1.7-§1.8, D19, D20)', () => {
  const ctx = ctxFor('42');
  const inp = aquiferInputs(ctx, ST, AQUIFER_NOISES);
  const ocean = columnOf(ctx, ...OCEAN);
  const land = columnOf(ctx, ...LAND);

  test('untagged air fills at y ≤ ⌊surfaceWaterLevel⌋ and stays dry above; dry land holds none; topFluid the highest', () => {
    for (let p = 0; p < 256; p++) {
      expect(readLevel(ocean.s, 'surfaceWaterLevel', 16 * OCEAN[0] + (p & 15), 16 * OCEAN[1] + (p >> 4))).toBe(63);
      expect(readLevel(land.s, 'surfaceWaterLevel', 16 * LAND[0] + (p & 15), 16 * LAND[1] + (p >> 4))).toBe(-Infinity);
    }
    const { solid, tags } = synthetic(20, 0, 0, -1);
    const sea = step(inp, ocean, solid, tags);
    const dry = step(inp, land, solid, tags);
    const fluid = new Uint8Array(98304);
    const waterV = new Uint8Array(98304);
    for (let p = 0; p < 256; p++) {
      for (let y = 21; y <= 63; y++) {
        fluid[vi(p, y)] = WATER_SOURCE;
        waterV[vi(p, y)] = 1;
      }
    }
    expect(firstDiff(sea.fluid, fluid)).toBe(-1);
    expect(firstDiff(sea.waterV, waterV)).toBe(-1);
    expect(firstDiff(sea.topFluid, new Int32Array(256).fill(63))).toBe(-1);
    expect(firstDiff(dry.fluid, new Uint8Array(98304))).toBe(-1);
    expect(firstDiff(dry.waterV, new Uint8Array(98304))).toBe(-1);
    expect(firstDiff(dry.topFluid, new Int32Array(256).fill(-65))).toBe(-1);
    expect(firstDiff(sea.solid, solid)).toBe(-1);
    expect(firstDiff(sea.tags, tags)).toBe(-1);
  });

  test('tagged air takes voxelRule over its two nearest centres (a brute force over the 12 candidates); a barrier ends solid with tag 0', () => {
    // Every voxel above the bedrock is tagged air, kind 1; positions p < 128 carry the abyss nibble.
    const solid = new Uint8Array(98304);
    const tags = new Uint8Array(98304);
    for (let v = 0; v < 98304; v++) {
      if (v < 256) solid[v] = 1;
      else tags[v] = 1 | ((v & 255) < 128 ? CAVE_BIOME.abyss << 4 : 0);
    }
    const col = columnOf(ctx, 3, -2);
    const out = step(inp, col, solid, tags);
    const cand = new Int32Array(36);
    const c = new Int32Array(3);
    const seen = new Map<number, number>();
    for (const p of [0, 17, 100, 127, 128, 136, 200, 255]) {
      const x = 16 * 3 + (p & 15);
      const z = 16 * -2 + (p >> 4);
      for (let y = -63; y <= 319; y++) {
        cellCandidates(x, y, z, cand);
        let d1 = Infinity, d2 = Infinity, s1 = 0, s2 = 0;
        for (let n = 0; n < 12; n++) {
          const [i, j, k] = [cand[3 * n]!, cand[3 * n + 1]!, cand[3 * n + 2]!];
          cellCentre(inp, i, j, k, c);
          const d = (x - c[0]!) ** 2 + (y - c[1]!) ** 2 + (z - c[2]!) ** 2;
          const st = cellStatus(inp, i, j, k);
          if (d < d1) { d2 = d1; s2 = s1; d1 = d; s1 = st; } else if (d < d2) { d2 = d; s2 = st; }
        }
        const abyss = p < 128;
        const margin = !abyss && inAbyssMargin(inp, col.pick, col.pass, x, y, z);
        const want = voxelRule(ST, y, d1, s1, d2, s2, inp.barrier.z3(x, 0.5 * y, z), abyss, margin);
        const v = vi(p, y);
        seen.set(want, (seen.get(want) ?? 0) + 1);
        if (want === BARRIER) {
          expect([out.solid[v], out.tags[v], out.fluid[v], out.waterV[v]]).toEqual([1, 0, 0, 0]);
        } else {
          expect([out.solid[v], out.tags[v], out.fluid[v], out.waterV[v]]).toEqual([0, tags[v], want, want === WATER_SOURCE ? 1 : 0]);
        }
        if (abyss) expect(want).not.toBe(WATER_SOURCE);
      }
    }
    // The positions hold water, barriers, lava and dry air.
    for (const r of [WATER_SOURCE, BARRIER, LAVA_SOURCE, 0]) expect(seen.get(r) ?? 0).toBeGreaterThan(0);
  });

  test('topFluid counts a tagged water voxel above the solid top (a crack: no sky-open water there)', () => {
    // No cell near the surface and every cell fully flooded: every status is water at 63.
    const flooded: AquiferSettings = {
      ...ST, surfaceBand: -1000, thresholds: { fullInland: -2, fullOcean: -2, partialInland: -2, partialOcean: -2 },
    };
    const { solid, tags } = synthetic(50, 1, 51, 55);
    const out = step(aquiferInputs(ctx, flooded, AQUIFER_NOISES), land, solid, tags);
    for (let p = 0; p < 256; p++) {
      for (let y = 51; y <= 70; y++) expect(out.fluid[vi(p, y)]).toBe(y <= 55 ? WATER_SOURCE : 0);
      expect(out.topFluid[p]).toBe(55);
    }
    expect(firstDiff(out.solid, solid)).toBe(-1);
  });

  test('enabled false: no tagged fluid and no barrier; the untagged rule unchanged', () => {
    const { solid, tags } = synthetic(-40, 1, -39, 30);
    const off = step(aquiferInputs(ctx, { ...ST, enabled: false }, AQUIFER_NOISES), ocean, solid, tags);
    const on = step(inp, ocean, solid, tags);
    let tagged = 0;
    let wrong = 0;
    for (let v = 256; v < 98304; v++) {
      const y = (v >> 8) - 64;
      if (tags[v] !== 0) {
        if (off.fluid[v] !== 0) wrong++;
        if (on.fluid[v] !== 0 || on.solid[v] !== 0) tagged++;
      } else if (solid[v] === 0) {
        if (off.fluid[v] !== (y <= 63 ? WATER_SOURCE : 0) || on.fluid[v] !== off.fluid[v]) wrong++;
      }
    }
    expect(wrong).toBe(0);
    expect(tagged).toBeGreaterThan(0); // enabled, the tagged air holds fluid or barriers
    expect(firstDiff(off.solid, solid)).toBe(-1);
    expect(firstDiff(off.tags, tags)).toBe(-1);
    expect(firstDiff(off.topFluid, new Int32Array(256).fill(63))).toBe(-1);
  });

  /**
   * 48 real columns of seed '42', each built from the point functions (`solidAt`, `caveTagAt`, `caveBiomeAt`) voxel
   * by voxel: on the default profile 12 open-sea (surfaceWaterLevel 63, offset < 55), 12 coast (offset 58 … 68) and 12
   * land (dry, offset > 75) columns, the first of each in a scan of the 25 × 25 grid cx, cz −96 … 96 step 8; 8
   * floating_islands columns (islandMask ≥ 0.9 at the centre) of its preset region R(−2, −1); and SP6b's abyss column
   * (−3000, −1182) with three neighbours. The defaults and 8 random settings (each threshold, level and band drawn in
   * a range around its default) give byte-identical outputs with and without the fast path.
   */
  test('the fast path equals aquiferColumnSlow byte for byte (fluid, solid, tags, waterV, topFluid) on 48 real columns, 9 settings', () => {
    const islands = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    const picks: Array<readonly [GenContext, number, number]> = [];
    const sea: Array<[number, number]> = [], coast: Array<[number, number]> = [], dryLand: Array<[number, number]> = [];
    for (let cz = -96; cz <= 96; cz += 8) {
      for (let cx = -96; cx <= 96; cx += 8) {
        const q = columnPoint(ctx, 16 * cx + 8, 16 * cz + 8);
        if (q.surfaceWaterLevel === 63 && q.offset < 55) sea.push([cx, cz]);
        else if (q.offset >= 58 && q.offset <= 68) coast.push([cx, cz]);
        else if (q.surfaceWaterLevel === -Infinity && q.offset > 75) dryLand.push([cx, cz]);
      }
    }
    for (const list of [sea, coast, dryLand]) {
      expect(list.length).toBeGreaterThanOrEqual(12);
      for (const [cx, cz] of list.slice(0, 12)) picks.push([ctx, cx, cz]);
    }
    const isl: Array<[number, number]> = [];
    for (let cz = -24; cz < 8 && isl.length < 8; cz += 2) {
      for (let cx = -32; cx < 0 && isl.length < 8; cx += 2) if (columnPoint(islands, 16 * cx + 8, 16 * cz + 8).islandMask >= 0.9) isl.push([cx, cz]);
    }
    expect(isl.length).toBe(8);
    for (const [cx, cz] of isl) picks.push([islands, cx, cz]);
    for (const [cx, cz] of [[-3000, -1182], [-2999, -1182], [-3000, -1181], [-2999, -1181]] as const) picks.push([ctx, cx, cz]);
    expect(picks.length).toBe(48);

    const rng = testRng(61);
    const u = (lo: number, hi: number): number => lo + ((hi - lo) * (rng() % 1_000_000)) / 1_000_000;
    const settings: AquiferSettings[] = [ST];
    for (let n = 0; n < 8; n++) {
      settings.push({
        enabled: true,
        surfaceBand: intIn(rng, 0, 32),
        thresholds: { fullInland: u(-1, 1), fullOcean: u(-1, 1), partialInland: u(-1, 1), partialOcean: u(-1, 1) },
        lavaMaxLevel: intIn(rng, -64, 64),
        lavaThreshold: u(0, 1),
        lavaLevel: intIn(rng, -64, -40),
        barrierBand: intIn(rng, 1, 64),
        abyssMargin: u(0, 0.2),
      });
    }
    const counts = { water: 0, barrier: 0, lava: 0, abyss: 0 };
    const dcs = new Map<GenContext, ReturnType<typeof createDensityContext>>();
    for (const [c, cx, cz] of picks) {
      let dc = dcs.get(c);
      if (dc === undefined) dcs.set(c, (dc = createDensityContext(c)));
      const solid = new Uint8Array(98304);
      const tags = new Uint8Array(98304);
      solid.fill(1, 0, 256);
      for (let v = 256; v < 98304; v++) {
        const x = 16 * cx + (v & 15);
        const z = 16 * cz + ((v >> 4) & 15);
        const y = (v >> 8) - 64;
        if (solidAt(dc, x, y, z)) { solid[v] = 1; continue; }
        const t = caveTagAt(dc, x, y, z);
        if (t !== 0) tags[v] = t | (caveBiomeAt(dc, x, y, z) << 4);
        if (tags[v]! >> 4 === CAVE_BIOME.abyss) counts.abyss++;
      }
      const col = columnOf(c, cx, cz);
      for (const st of settings) {
        const sInp = aquiferInputs(c, st, AQUIFER_NOISES);
        const fast = step(sInp, col, solid, tags);
        const slow = step(sInp, col, solid, tags, true);
        const where = `column (${cx}, ${cz}), settings ${settings.indexOf(st)}`;
        expect(firstDiff(fast.fluid, slow.fluid), where).toBe(-1);
        expect(firstDiff(fast.solid, slow.solid), where).toBe(-1);
        expect(firstDiff(fast.tags, slow.tags), where).toBe(-1);
        expect(firstDiff(fast.waterV, slow.waterV), where).toBe(-1);
        expect(firstDiff(fast.topFluid, slow.topFluid), where).toBe(-1);
        for (let v = 256; v < 98304; v++) {
          if (tags[v] === 0) continue;
          if (fast.solid[v] !== 0) counts.barrier++;
          else if (fast.fluid[v] === WATER_SOURCE) counts.water++;
          else if (fast.fluid[v] === LAVA_SOURCE) counts.lava++;
        }
      }
    }
    expect(counts.water).toBeGreaterThan(0);
    expect(counts.barrier).toBeGreaterThan(0);
    expect(counts.lava).toBeGreaterThan(0);
    expect(counts.abyss).toBeGreaterThan(0);
  }, 300_000);
});

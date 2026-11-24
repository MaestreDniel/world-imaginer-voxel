/**
 * U2's liveness tests (`src/metrics/liveness.ts`) for SP7a's aquifer leaves (its spec §1.9, §13.7, Task 13) and its
 * springs' leaves (§3.5: the water springs', Task 19; the island springs', §3.3, Task 20; the lava springs', §3.4,
 * Task 21; the plan's Spec correction 5:
 * each leaf group lands with its reader and its witnesses). In the `liveness` shard of CI's unit jobs (`.github/scripts/unitShards.mjs`); the pins and helpers it
 * shares with the other liveness files are in `fixtures/liveness.ts`.
 */
import { describe, expect, test } from 'vitest';
import { SEA_LEVEL } from '../../src/core/constants';
import { DEFAULTS } from '../../src/core/params/defaults';
import { getPath } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { checkRegistry, prefixCovers, STAGES } from '../../src/core/stage/registry';
import {
  aquiferWitness, CAVE_SLOTS, caveColumn, caveSlotLeaves, intendedClass, islandSpringWitness, lavaSpringWitness, leafLiveness, perturbations,
  springWitness, u2Leaves,
} from '../../src/metrics/liveness';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { fillColumnT } from '../../src/metrics/region';
import { cavePickerOf, fillCaveColumnPass, newCaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { aquiferInputs, inAbyssMargin } from '../../src/gen/fluids/aquifer';
import { createStore } from '../../src/world/store/store';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import type { GenContext } from '../../src/gen/context';
import { AQUIFER_LEAVES, CTX, ISLAND_SPRING_LEAVES, LAVA_SPRING_LEAVES, SPRING_LEAVES, U2_LEAVES, columns, leaf } from './fixtures/liveness';

/**
 * The cave air of column (cx, cz) at seed 42, re-derived from a fresh T column: the lowest y holding cave air, the column
 * sample's lattice offsets and, with `margin` set, the tagged voxels outside the abyss in the abyss margin's band between
 * `aquifer.abyssMargin`'s steps (in the margin at the widest m and not at the narrowest; 0 without `margin`).
 */
function caveAirFacts(cx: number, cz: number, margin: boolean): { lowest: number; band: number; offsets: number[] } {
  const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
  expect(fillColumnT(store, CTX, cx, cz, () => false)).toBe(true);
  const v = store.proto(cx, cz)!;
  const sample = buildColumnSample(CTX, cx, cz, newColumnSample());
  const offsets = Array.from(sample.f.offset);
  let wide = null, narrow = null, pick = null, pass = null;
  if (margin) {
    const steps = perturbations(leaf('aquifer.abyssMargin'), DEFAULTS.aquifer.abyssMargin) as number[];
    wide = aquiferInputs(CTX, { ...DEFAULTS.aquifer, abyssMargin: Math.max(DEFAULTS.aquifer.abyssMargin, ...steps) }, DEFAULTS.aquifer.noises);
    narrow = aquiferInputs(CTX, { ...DEFAULTS.aquifer, abyssMargin: Math.min(DEFAULTS.aquifer.abyssMargin, ...steps) }, DEFAULTS.aquifer.noises);
    pick = cavePickerOf(CTX);
    pass = fillCaveColumnPass(pick, sample, newCaveColumnPass());
  }
  let lowest = Infinity, band = 0;
  for (let y = -63; y <= 319; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
    const b = v.cave(lx, y, lz);
    if ((b & 15) === 0) continue;
    lowest = Math.min(lowest, y);
    const x = 16 * cx + lx, z = 16 * cz + lz;
    if (pass !== null && b >> 4 !== 3 && inAbyssMargin(wide!, pick!, pass, x, y, z) && !inAbyssMargin(narrow!, pick!, pass, x, y, z)) band++;
  }
  return { lowest, band, offsets };
}

const SPRINGS = newSpringList();
/** How many springs of kind `kind` (0 water, 1 island, 2 lava) the springs step of column (cx, cz) accepts under `ctx`. */
function springsAccepted(ctx: GenContext, cx: number, cz: number, kind: 0 | 1 | 2): number {
  terrainSpringsDebug(ctx, cx, cz, SPRINGS);
  return Array.from(SPRINGS.kind.subarray(0, SPRINGS.n)).filter((k) => k === kind).length;
}

/**
 * Each aquifer leaf's U2 verdict at seed 42 (the class columns, the cave columns among them and the intended cave class
 * first; else its bounded aquifer witness): the status leaves, `barrierBand`, `lavaLevel` and the floodedness, spread
 * and barrier noises on the cave columns, `partialInland` on the cliffSteep column, the lava noise on a land column;
 * the ocean thresholds, `surfaceBand`, the lava leaves and `abyssMargin` on their witness (the first columns of
 * `sp7a.liveness.aquifer` whose tagged air holds what the leaf acts on, `aquiferWants`, where a step changes the T
 * column; the margin's in its lateral band, where a step moves a barrier). `surfaceBand`'s witness moved from (21939,
 * −12751) to (−24882, 19024) with the lake roof (Task 15, D24: caves open under the sea and rivers).
 */
const CAVERNS = 'cave column (18487, -15384)';
const TUNNELS = 'cave column (-1986, -30779)';
const VERDICT: Readonly<Record<(typeof AQUIFER_LEAVES)[number], string>> = {
  'aquifer.enabled': CAVERNS,
  'aquifer.surfaceBand': 'aquifer witness column (-24882, 19024)',
  'aquifer.thresholds.fullInland': TUNNELS,
  'aquifer.thresholds.fullOcean': 'aquifer witness column (-24882, 19024)',
  'aquifer.thresholds.partialInland': 'cliffSteep column (-24200, -4864)',
  'aquifer.thresholds.partialOcean': 'aquifer witness column (-24882, 19024)',
  'aquifer.lavaMaxLevel': 'aquifer witness column (-24882, 19024)',
  'aquifer.lavaThreshold': 'aquifer witness column (-7222, 14133)',
  'aquifer.lavaLevel': TUNNELS,
  'aquifer.barrierBand': CAVERNS,
  'aquifer.abyssMargin': 'aquifer witness column (23901, 1718)',
  'aquifer.noises.floodedness': CAVERNS,
  'aquifer.noises.spread': CAVERNS,
  'aquifer.noises.lava': 'land column (-25833, 16792)',
  'aquifer.noises.barrier': CAVERNS,
};
/** Each leaf's own witness, searched past the class columns (`aquiferWitness(CTX, path, all)`). */
const WITNESS: Readonly<Record<(typeof AQUIFER_LEAVES)[number], string>> = {
  'aquifer.enabled': 'aquifer witness column (-23718, 24314)',
  'aquifer.surfaceBand': 'aquifer witness column (-24882, 19024)',
  'aquifer.thresholds.fullInland': 'aquifer witness column (-29063, 7580)',
  'aquifer.thresholds.fullOcean': 'aquifer witness column (-24882, 19024)',
  'aquifer.thresholds.partialInland': 'aquifer witness column (2268, -18044)',
  'aquifer.thresholds.partialOcean': 'aquifer witness column (-24882, 19024)',
  'aquifer.lavaMaxLevel': 'aquifer witness column (-24882, 19024)',
  'aquifer.lavaThreshold': 'aquifer witness column (-7222, 14133)',
  'aquifer.lavaLevel': 'aquifer witness column (-23718, 24314)',
  'aquifer.barrierBand': 'aquifer witness column (-23718, 24314)',
  'aquifer.abyssMargin': 'aquifer witness column (23901, 1718)',
  'aquifer.noises.floodedness': 'aquifer witness column (-23718, 24314)',
  'aquifer.noises.spread': 'aquifer witness column (-24882, 19024)',
  'aquifer.noises.lava': 'aquifer witness column (26606, -27568)',
  'aquifer.noises.barrier': 'aquifer witness column (-24882, 19024)',
};

describe('the aquifer\'s leaves in U2 (SP7a spec §1.9, §13.7; Task 13, Spec correction 5)', () => {
  test('the 15 aquifer leaves join SP6b\'s 193 (208; the springs\' follow), each a U2 leaf of the T stage meant for the cave class, in no cave slot\'s acceptance', () => {
    expect(SCHEMA.leaves.filter((l) => l.path.startsWith('aquifer.')).map((l) => l.path)).toEqual([...AQUIFER_LEAVES]);
    const covered = new Set(u2Leaves().map((l) => l.path));
    const springs = SPRING_LEAVES.length + ISLAND_SPRING_LEAVES.length + LAVA_SPRING_LEAVES.length;
    expect([covered.size, U2_LEAVES, U2_LEAVES - springs, U2_LEAVES - springs - AQUIFER_LEAVES.length]).toEqual([213, 213, 208, 193]);
    const slotted = new Set(CAVE_SLOTS.flatMap((slot) => caveSlotLeaves(slot).map((l) => l.path)));
    for (const p of AQUIFER_LEAVES) {
      expect([p, covered.has(p), leaf(p).meta.scope, leaf(p).meta.stage, intendedClass(p), slotted.has(p)]).toEqual([p, true, 'terrain', 'terrain', 'cave', false]);
      // First hashed by the terrain stage (its params gain 'aquifer', SP7a §15.3).
      expect(STAGES.find((s) => s.params.some((q) => prefixCovers(q, p)))?.id).toBe('terrain');
    }
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
  });

  test('each of the 15 is decided: live on its pinned column, and its bounded aquifer witness finds a column whose tagged air holds what it acts on', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const lines: string[] = [];
    for (const p of AQUIFER_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      lines.push(`${p}: ${r.live ? 'live' : 'DEAD'} via ${r.via}`);
      expect([p, r.live, r.via]).toEqual([p, true, VERDICT[p]]);
      const w = aquiferWitness(CTX, p, all);
      lines.push(`${p}: witness ${w.via} (draws ${w.draws}, examined ${w.examined}, checks ${w.checks})`);
      expect([p, w.via]).toEqual([p, WITNESS[p]]);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(w.examined, p).toBeLessThanOrEqual(256);
      expect(w.draws, p).toBeLessThanOrEqual(32768);
      // The witness column's tagged air holds what the leaf acts on (re-derived from a fresh T column).
      const [cx, cz] = w.via!.slice('aquifer witness column ('.length, -1).split(', ').map(Number) as [number, number];
      const steps = perturbations(leaf(p), getPath(DEFAULTS, p)) as number[];
      // The margin's witness: a tagged voxel outside the abyss in the margin at the widest m and not at the narrowest.
      const { lowest, band } = caveAirFacts(cx, cz, p === 'aquifer.abyssMargin');
      if (p === 'aquifer.abyssMargin') expect(band, p).toBeGreaterThan(0);
      else if (p === 'aquifer.lavaLevel') expect(lowest, p).toBeLessThan(Math.max(DEFAULTS.aquifer.lavaLevel, ...steps));
      else if (p === 'aquifer.lavaMaxLevel') expect(lowest, p).toBeLessThanOrEqual(Math.max(DEFAULTS.aquifer.lavaMaxLevel, ...steps));
      else if (p === 'aquifer.lavaThreshold' || p === 'aquifer.noises.lava') expect(lowest, p).toBeLessThanOrEqual(DEFAULTS.aquifer.lavaMaxLevel);
      else expect(lowest, p).toBeLessThanOrEqual(63);
    }
    console.log(`the aquifer's leaves:\n${lines.join('\n')}`);
    expect(() => aquiferWitness(CTX, 'caves.cheese.offset')).toThrow('not an aquifer leaf');
  }, 600_000);
});

/**
 * Each water springs leaf's U2 verdict at seed 42: dead on the class columns (no class column's springs step accepts a
 * spring, and no step makes one), live on its bounded mountain witness (`springWitness`: the first examined column of
 * `sp7a.liveness.springs` whose springs step accepts a water spring at the defaults and whose T column a step changes).
 */
const SPRING_VERDICT: Readonly<Record<(typeof SPRING_LEAVES)[number], string>> = {
  'springs.water.tries': 'mountain witness column (-3035, 11917)',
  'springs.water.minFall': 'mountain witness column (1250, -30453)',
};

describe('the water springs\' leaves in U2 (SP7a spec §3.5, §13.7; Task 19, Spec correction 5)', () => {
  test('the 2 water springs leaves, each a U2 leaf of the T stage (Terrain scope, D21), in no cave slot\'s acceptance', () => {
    expect(SCHEMA.leaves.filter((l) => l.path.startsWith('springs.water.')).map((l) => l.path)).toEqual([...SPRING_LEAVES]);
    const covered = new Set(u2Leaves().map((l) => l.path));
    const slotted = new Set(CAVE_SLOTS.flatMap((slot) => caveSlotLeaves(slot).map((l) => l.path)));
    for (const p of SPRING_LEAVES) {
      expect([p, covered.has(p), leaf(p).meta.scope, leaf(p).meta.stage, slotted.has(p)]).toEqual([p, true, 'terrain', 'terrain', false]);
      expect(STAGES.find((s) => s.params.some((q) => prefixCovers(q, p)))?.id).toBe('terrain');
    }
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
  });

  test('each of the 2 is decided on the mountain witness: a column whose springs step accepts a water spring at the defaults, where a step changes the T column', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const lines: string[] = [];
    for (const p of SPRING_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      lines.push(`${p}: ${r.live ? 'live' : 'DEAD'} via ${r.via}`);
      const w = springWitness(CTX, p, all);
      lines.push(`${p}: witness ${w.via} (draws ${w.draws}, examined ${w.examined}, checks ${w.checks})`);
      expect([p, r.live, r.via]).toEqual([p, true, SPRING_VERDICT[p]]);
      expect([p, w.via]).toEqual([p, SPRING_VERDICT[p]]);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(w.examined, p).toBeLessThanOrEqual(1024);
      expect(w.draws, p).toBeLessThanOrEqual(65536);
      // The witness column's springs step accepts a water spring at the defaults (re-derived).
      const [cx, cz] = w.via!.slice('mountain witness column ('.length, -1).split(', ').map(Number) as [number, number];
      expect(springsAccepted(CTX, cx, cz, 0), p).toBeGreaterThan(0);
    }
    console.log(`the water springs' leaves:\n${lines.join('\n')}`);
    expect(() => springWitness(CTX, 'aquifer.enabled')).toThrow('not a springs leaf');
  }, 600_000);
});

/**
 * The island springs leaf's U2 verdict at seed 42 (SP7a spec §3.3, §13.7; Task 20; the least fall is the constant
 * `ISLAND_SPRING_MIN_FALL`, not a leaf: Task 20's Spec correction, ruling R18): dead on the default base's class
 * columns (`islands.enabled` is off there, so no island try runs), live on its bounded island witness on the
 * floating_islands base (`islandSpringWitness`: the first examined column of `sp7a.liveness.islandSprings` whose
 * lattice holds an islandMask above 0, whose springs step on that base accepts an island spring and whose T column a
 * step changes).
 */
const ISLAND_SPRING_VERDICT: Readonly<Record<(typeof ISLAND_SPRING_LEAVES)[number], string>> = {
  'springs.island.tries': 'island witness column (11988, -20453)',
};

describe('the island springs\' leaves in U2 (SP7a spec §3.3, §3.5, §13.7; Task 20, Spec correction 5)', () => {
  test('the island springs leaf, a U2 leaf of the T stage (Terrain scope, D21), in no cave slot\'s acceptance', () => {
    expect(SCHEMA.leaves.filter((l) => l.path.startsWith('springs.island.')).map((l) => l.path)).toEqual([...ISLAND_SPRING_LEAVES]);
    const covered = new Set(u2Leaves().map((l) => l.path));
    const slotted = new Set(CAVE_SLOTS.flatMap((slot) => caveSlotLeaves(slot).map((l) => l.path)));
    for (const p of ISLAND_SPRING_LEAVES) {
      expect([p, covered.has(p), leaf(p).meta.scope, leaf(p).meta.stage, slotted.has(p)]).toEqual([p, true, 'terrain', 'terrain', false]);
      expect(STAGES.find((s) => s.params.some((q) => prefixCovers(q, p)))?.id).toBe('terrain');
    }
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
  });

  test('springs.island.tries is decided on the island witness: a floating_islands column whose springs step accepts an island spring at the defaults, where a step changes the T column', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const fi = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    const lines: string[] = [];
    for (const p of ISLAND_SPRING_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      lines.push(`${p}: ${r.live ? 'live' : 'DEAD'} via ${r.via}`);
      const w = islandSpringWitness(CTX, p, all);
      lines.push(`${p}: witness ${w.via} (draws ${w.draws}, examined ${w.examined}, checks ${w.checks})`);
      expect([p, r.live, r.via]).toEqual([p, true, ISLAND_SPRING_VERDICT[p]]);
      expect([p, w.via]).toEqual([p, ISLAND_SPRING_VERDICT[p]]);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(w.examined, p).toBeLessThanOrEqual(2048);
      expect(w.draws, p).toBeLessThanOrEqual(65536);
      // The witness column's springs step on the floating_islands base accepts an island spring (re-derived).
      const [cx, cz] = w.via!.slice('island witness column ('.length, -1).split(', ').map(Number) as [number, number];
      expect(springsAccepted(fi, cx, cz, 1), p).toBeGreaterThan(0);
      // On the default base (islands off) the same column holds no island spring.
      expect(springsAccepted(CTX, cx, cz, 1), p).toBe(0);
    }
    console.log(`the island springs' leaves:\n${lines.join('\n')}`);
    expect(() => islandSpringWitness(CTX, 'springs.water.tries')).toThrow('not an island springs leaf');
  }, 600_000);
});

/**
 * The lava springs leaves' U2 verdicts at seed 42 (SP7a spec §3.4, §13.7; Task 21): dead on the class columns (no class
 * column reaches the abyss's walls with an accepted lava try), live on their bounded abyss witness
 * (`lavaSpringWitness`: the first examined column of `sp7a.liveness.lavaSprings` whose cave-biome pass gives the abyss on
 * its grid, whose springs step accepts a lava spring at the defaults and whose T column a step changes). `minFall` is
 * live by its range's floor (yLo = −55 + minFall moves every try's height), so it stays a leaf (ruling R18's test).
 */
const LAVA_SPRING_VERDICT: Readonly<Record<(typeof LAVA_SPRING_LEAVES)[number], string>> = {
  'springs.lava.tries': 'abyss witness column (-6733, -6066)',
  'springs.lava.minFall': 'abyss witness column (-20648, -1215)',
};

describe('the lava springs\' leaves in U2 (SP7a spec §3.4, §3.5, §13.7; Task 21, Spec correction 5)', () => {
  test('U2_LEAVES is 213: SP6b\'s 193, the 15 aquifer leaves, the 2 water, 1 island and 2 lava springs leaves, each lava leaf a U2 leaf of the T stage (Terrain scope, D21) meant for the cave class, in no cave slot\'s acceptance', () => {
    expect(SCHEMA.leaves.filter((l) => l.path.startsWith('springs.')).map((l) => l.path)).toEqual([...SPRING_LEAVES, ...ISLAND_SPRING_LEAVES, ...LAVA_SPRING_LEAVES]);
    const covered = new Set(u2Leaves().map((l) => l.path));
    expect([covered.size, U2_LEAVES]).toEqual([213, 213]);
    const slotted = new Set(CAVE_SLOTS.flatMap((slot) => caveSlotLeaves(slot).map((l) => l.path)));
    for (const p of LAVA_SPRING_LEAVES) {
      expect([p, covered.has(p), leaf(p).meta.scope, leaf(p).meta.stage, intendedClass(p), slotted.has(p)]).toEqual([p, true, 'terrain', 'terrain', 'cave', false]);
      expect(STAGES.find((s) => s.params.some((q) => prefixCovers(q, p)))?.id).toBe('terrain');
    }
    expect(checkRegistry(SCHEMA, STAGES)).toEqual([]);
  });

  test('each of the 2 is decided on the abyss witness: a column whose springs step accepts a lava spring at the defaults, where a step changes the T column', () => {
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const lines: string[] = [];
    for (const p of LAVA_SPRING_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      lines.push(`${p}: ${r.live ? 'live' : 'DEAD'} via ${r.via}`);
      const w = lavaSpringWitness(CTX, p, all);
      lines.push(`${p}: witness ${w.via} (draws ${w.draws}, examined ${w.examined}, checks ${w.checks})`);
      expect([p, r.live, r.via]).toEqual([p, true, LAVA_SPRING_VERDICT[p]]);
      expect([p, w.via]).toEqual([p, LAVA_SPRING_VERDICT[p]]);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(w.examined, p).toBeLessThanOrEqual(1024);
      expect(w.draws, p).toBeLessThanOrEqual(32768);
      // The witness column's springs step accepts a lava spring at the defaults (re-derived).
      const [cx, cz] = w.via!.slice('abyss witness column ('.length, -1).split(', ').map(Number) as [number, number];
      expect(springsAccepted(CTX, cx, cz, 2), p).toBeGreaterThan(0);
    }
    console.log(`the lava springs' leaves:\n${lines.join('\n')}`);
    expect(() => lavaSpringWitness(CTX, 'springs.water.tries')).toThrow('not a lava springs leaf');
  }, 600_000);
});

/**
 * U2's full-tier audit over SP7a's leaves (SP7a spec §13.7, Task 30; the plan's leaf table, "U2 decides it on"): each new
 * leaf's deciding column, the one U2 reports (the verdicts above, each pinned against `leafLiveness`), is the witness the
 * leaf table names for it: the status leaves, the thresholds, `surfaceBand`, `barrierBand` and the floodedness, spread
 * and barrier noises on a column with cave air at or below y 63, under land (every lattice offset above sea level) for
 * some and under the sea (every lattice offset below it) for others; the lava leaves on a deep cell (cave air at or below
 * `aquifer.lavaMaxLevel`); `aquifer.lavaLevel` on a gully (cave air below it: −50 since Task 27n, rulings R23);
 * `abyssMargin` on an abyss-margin column (a tagged voxel outside the abyss in the margin's band between its steps); the
 * springs' leaves on a mountain, an island (floating_islands) and an abyss witness (their springs step accepts a spring
 * of the kind at the defaults). No leaf group is left to a column the table does not name.
 */
type WitnessKind = 'land' | 'sea' | 'deep' | 'gully' | 'margin' | 'mountain' | 'island' | 'abyss';
const LEAF_TABLE: Readonly<Record<string, readonly [via: string, kind: WitnessKind]>> = {
  'aquifer.enabled': [VERDICT['aquifer.enabled'], 'land'],
  'aquifer.surfaceBand': [VERDICT['aquifer.surfaceBand'], 'sea'],
  'aquifer.thresholds.fullInland': [VERDICT['aquifer.thresholds.fullInland'], 'land'],
  'aquifer.thresholds.fullOcean': [VERDICT['aquifer.thresholds.fullOcean'], 'sea'],
  'aquifer.thresholds.partialInland': [VERDICT['aquifer.thresholds.partialInland'], 'land'],
  'aquifer.thresholds.partialOcean': [VERDICT['aquifer.thresholds.partialOcean'], 'sea'],
  'aquifer.lavaMaxLevel': [VERDICT['aquifer.lavaMaxLevel'], 'deep'],
  'aquifer.lavaThreshold': [VERDICT['aquifer.lavaThreshold'], 'deep'],
  'aquifer.lavaLevel': [VERDICT['aquifer.lavaLevel'], 'gully'],
  'aquifer.barrierBand': [VERDICT['aquifer.barrierBand'], 'land'],
  'aquifer.abyssMargin': [VERDICT['aquifer.abyssMargin'], 'margin'],
  'aquifer.noises.floodedness': [VERDICT['aquifer.noises.floodedness'], 'land'],
  'aquifer.noises.spread': [VERDICT['aquifer.noises.spread'], 'land'],
  'aquifer.noises.lava': [VERDICT['aquifer.noises.lava'], 'deep'],
  'aquifer.noises.barrier': [VERDICT['aquifer.noises.barrier'], 'land'],
  'springs.water.tries': [SPRING_VERDICT['springs.water.tries'], 'mountain'],
  'springs.water.minFall': [SPRING_VERDICT['springs.water.minFall'], 'mountain'],
  'springs.island.tries': [ISLAND_SPRING_VERDICT['springs.island.tries'], 'island'],
  'springs.lava.tries': [LAVA_SPRING_VERDICT['springs.lava.tries'], 'abyss'],
  'springs.lava.minFall': [LAVA_SPRING_VERDICT['springs.lava.minFall'], 'abyss'],
};

describe('U2\'s full-tier audit over SP7a\'s leaves (SP7a spec §13.7; Task 30)', () => {
  test('every new leaf\'s deciding column is the witness the plan\'s leaf table names: cave air under land and sea, a deep cell, a gully, an abyss margin; a mountain, an island and an abyss', () => {
    const leaves = [...AQUIFER_LEAVES, ...SPRING_LEAVES, ...ISLAND_SPRING_LEAVES, ...LAVA_SPRING_LEAVES];
    expect(Object.keys(LEAF_TABLE)).toEqual(leaves);
    expect(leaves.length).toBe(U2_LEAVES - 193);
    // The status leaves' columns lie both under land and under the sea.
    expect(new Set(Object.values(LEAF_TABLE).map(([, k]) => k))).toEqual(new Set(['land', 'sea', 'deep', 'gully', 'margin', 'mountain', 'island', 'abyss']));
    const fi = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
    const lines: string[] = [];
    for (const p of leaves) {
      const [via, kind] = LEAF_TABLE[p]!;
      const [cx, cz] = via.slice(via.lastIndexOf('(') + 1, -1).split(', ').map(Number) as [number, number];
      if (kind === 'mountain' || kind === 'island' || kind === 'abyss') {
        const n = springsAccepted(kind === 'island' ? fi : CTX, cx, cz, kind === 'mountain' ? 0 : kind === 'island' ? 1 : 2);
        lines.push(`${p}: ${via}, ${kind}, ${n} accepted`);
        expect([p, n > 0]).toEqual([p, true]);
        continue;
      }
      const { lowest, band, offsets } = caveAirFacts(cx, cz, kind === 'margin');
      const lo = Math.min(...offsets), hi = Math.max(...offsets);
      lines.push(`${p}: ${via}, ${kind}, lowest cave air ${lowest}, offset ${lo.toFixed(1)} … ${hi.toFixed(1)}${kind === 'margin' ? `, ${band} in the margin's band` : ''}`);
      if (kind === 'land') expect([p, lowest <= SEA_LEVEL, lo > SEA_LEVEL]).toEqual([p, true, true]);
      else if (kind === 'sea') expect([p, lowest <= SEA_LEVEL, hi < SEA_LEVEL]).toEqual([p, true, true]);
      else if (kind === 'deep') expect([p, lowest <= DEFAULTS.aquifer.lavaMaxLevel]).toEqual([p, true]);
      else if (kind === 'gully') expect([p, lowest < DEFAULTS.aquifer.lavaLevel]).toEqual([p, true]);
      else expect([p, band > 0]).toEqual([p, true]);
    }
    console.log(`SP7a's leaves, each deciding column and its witness:\n${lines.join('\n')}`);
  }, 600_000);
});

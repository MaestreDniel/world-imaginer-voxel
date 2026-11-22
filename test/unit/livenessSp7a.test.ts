/**
 * U2's liveness tests (`src/metrics/liveness.ts`) for SP7a's aquifer leaves (its spec §1.9, §13.7, Task 13) and its
 * springs' leaves (§3.5, Task 19; the plan's Spec correction 5: each leaf group lands with its reader and its
 * witnesses). In the `liveness` shard of CI's unit jobs (`.github/scripts/unitShards.mjs`); the pins and helpers it
 * shares with the other liveness files are in `fixtures/liveness.ts`.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { getPath } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { checkRegistry, prefixCovers, STAGES } from '../../src/core/stage/registry';
import {
  aquiferWitness, CAVE_SLOTS, caveColumn, caveSlotLeaves, intendedClass, leafLiveness, perturbations, springWitness, u2Leaves,
} from '../../src/metrics/liveness';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { fillColumnT } from '../../src/metrics/region';
import { cavePickerOf, fillCaveColumnPass, newCaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { aquiferInputs, inAbyssMargin } from '../../src/gen/fluids/aquifer';
import { createStore } from '../../src/world/store/store';
import { AQUIFER_LEAVES, CTX, SPRING_LEAVES, U2_LEAVES, columns, leaf } from './fixtures/liveness';

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
  'aquifer.enabled': 'aquifer witness column (-24882, 19024)',
  'aquifer.surfaceBand': 'aquifer witness column (-24882, 19024)',
  'aquifer.thresholds.fullInland': 'aquifer witness column (-29063, 7580)',
  'aquifer.thresholds.fullOcean': 'aquifer witness column (-24882, 19024)',
  'aquifer.thresholds.partialInland': 'aquifer witness column (2268, -18044)',
  'aquifer.thresholds.partialOcean': 'aquifer witness column (-24882, 19024)',
  'aquifer.lavaMaxLevel': 'aquifer witness column (-24882, 19024)',
  'aquifer.lavaThreshold': 'aquifer witness column (-7222, 14133)',
  'aquifer.lavaLevel': 'aquifer witness column (-23718, 24314)',
  'aquifer.barrierBand': 'aquifer witness column (-24882, 19024)',
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
    expect([covered.size, U2_LEAVES, U2_LEAVES - SPRING_LEAVES.length, U2_LEAVES - SPRING_LEAVES.length - AQUIFER_LEAVES.length]).toEqual([210, 210, 208, 193]);
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
      const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
      expect(fillColumnT(store, CTX, cx, cz, () => false)).toBe(true);
      const v = store.proto(cx, cz)!;
      const steps = perturbations(leaf(p), getPath(DEFAULTS, p)) as number[];
      // The margin's witness: a tagged voxel outside the abyss in the margin at the widest m and not at the narrowest.
      const wide = aquiferInputs(CTX, { ...DEFAULTS.aquifer, abyssMargin: Math.max(DEFAULTS.aquifer.abyssMargin, ...steps) }, DEFAULTS.aquifer.noises);
      const narrow = aquiferInputs(CTX, { ...DEFAULTS.aquifer, abyssMargin: Math.min(DEFAULTS.aquifer.abyssMargin, ...steps) }, DEFAULTS.aquifer.noises);
      const pick = cavePickerOf(CTX);
      const pass = fillCaveColumnPass(pick, buildColumnSample(CTX, cx, cz, newColumnSample()), newCaveColumnPass());
      let lowest = Infinity, band = 0;
      for (let y = -63; y <= 319; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const b = v.cave(lx, y, lz);
        if ((b & 15) === 0) continue;
        lowest = Math.min(lowest, y);
        const x = 16 * cx + lx, z = 16 * cz + lz;
        if (p === 'aquifer.abyssMargin' && b >> 4 !== 3 && inAbyssMargin(wide, pick, pass, x, y, z) && !inAbyssMargin(narrow, pick, pass, x, y, z)) band++;
      }
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
  'springs.water.tries': 'mountain witness column (8652, -18898)',
  'springs.water.minFall': 'mountain witness column (11344, 3591)',
};

describe('the water springs\' leaves in U2 (SP7a spec §3.5, §13.7; Task 19, Spec correction 5)', () => {
  test('U2_LEAVES is 210: SP6b\'s 193, the 15 aquifer leaves and the 2 water springs leaves, each a U2 leaf of the T stage (Terrain scope, D21), in no cave slot\'s acceptance', () => {
    expect(SCHEMA.leaves.filter((l) => l.path.startsWith('springs.')).map((l) => l.path)).toEqual([...SPRING_LEAVES]);
    const covered = new Set(u2Leaves().map((l) => l.path));
    expect([covered.size, U2_LEAVES]).toEqual([210, 210]);
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
    const list = newSpringList();
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
      terrainSpringsDebug(CTX, cx, cz, list);
      expect(list.n, p).toBeGreaterThan(0);
    }
    console.log(`the water springs' leaves:\n${lines.join('\n')}`);
    expect(() => springWitness(CTX, 'aquifer.enabled')).toThrow('not a springs leaf');
  }, 600_000);
});

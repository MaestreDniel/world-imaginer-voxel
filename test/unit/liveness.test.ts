import { describe, expect, test } from 'vitest';
import { canonicalJSON } from '../../src/core/params/canonical';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, bool, buildSchema, checkLeaf, getPath, group, patchAt, type BoxTable, type Issue } from '../../src/core/params/kit';
import { SCHEMA, type ParamsPatch } from '../../src/core/params/schema';
import type { NestedSpline } from '../../src/core/spline/types';
import { buildColumnSample, gorgeAt, newColumnSample, riverWetAt, type ColumnSample } from '../../src/gen/column/columnStage';
import { cellEligible, lakeCell } from '../../src/gen/column/lakes';
import { fnv1a32, hex64 } from '../../src/core/hash';
import { latticeIndex } from '../../src/gen/column/columnStage';
import { biomeName } from '../../src/gen/biomes/registry';
import {
  amplifiedBandWitness, bandWindow, bandWitness, capTopWitness, CAVE_SLOTS, caveColumn, caveFamilyCounts, caveLeaves, caveSlotLeaves, cellProbe, findWitness, intendedClass, islandColumn, islandLeaves, leafLiveness, livenessColumns, perturbations, stageOutputHash, surfaceAcceptance,
  scaleBandCarves, scaleWitness, SURFACE_CLASSES, surfacePrefilter, surfaceSlotLeaves, u2Leaves,
  type CaveSlot,
  type LivenessClass,
  type LivenessColumn,
  type SurfaceClass,
} from '../../src/metrics/liveness';
import { samplePoints } from '../../src/metrics/noiseStats';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { resolveProfile } from '../../src/core/params/profiles';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { ctxFor } from '../harness/gen';

/** SP3e's island class column at seed 42 (spec §5.6) and its index among the U2.islands draws. */
const ISLAND_PIN: LivenessColumn = { cx: 975, cz: -735, cls: 'island' };
const ISLAND_DRAW = 33;
/** SP6a's cave class columns at seed 42 (its spec §4), one per scan slot, and their indices among the sp6a.liveness.caves draws. */
const CAVE_PINS: Readonly<Record<CaveSlot, readonly [LivenessColumn, number]>> = {
  caverns: [{ cx: 546, cz: 25857, cls: 'cave' }, 7],
  tunnels: [{ cx: 4705, cz: -24478, cls: 'cave' }, 224],
};
/**
 * The leaves of SP6a Tasks 6, 7, 8 and 9 (the caves group so far): U2 covers 73 + 19 + 30 + 11 + 1 + 1 = 135 leaves
 * (Task 9: the island cap's capTop, then the wet roof's waterDepth).
 */
const U2_LEAVES = 135;
/** The spaghetti scale leaves (SP6a Task 7), decided on the class columns or on their bounded witness search (ruling P5). */
const SCALE_LEAVES = [
  'caves.spaghetti3d.scales.s0', 'caves.spaghetti3d.scales.s1', 'caves.spaghetti3d.scales.s2', 'caves.spaghetti3d.scales.s3',
  'caves.spaghetti2d.scales.s0', 'caves.spaghetti2d.scales.s1', 'caves.spaghetti2d.scales.s2', 'caves.spaghetti2d.scales.s3',
  'caves.spaghetti2d.scales.s4',
] as const;

/** The depth-band leaves (SP6a Task 8), decided on the class columns or on their bounded band witness (rulings P3, P4, R5). */
const BAND_LEAVES = [
  'caves.cheese.minY', 'caves.cheese.maxY', 'caves.spaghetti3d.minY', 'caves.spaghetti3d.maxY',
  'caves.spaghetti2d.minY', 'caves.spaghetti2d.maxY', 'caves.noodles.minY', 'caves.noodles.maxY',
  'caves.entrances.minY', 'caves.entrances.maxY',
] as const;
/**
 * Each depth-band leaf's U2 verdict at seed 42 (SP6a spec §4): the minY leaves and the noodle's maxY on a class column
 * (P4), the maxY leaves of cheese, spaghetti 3D and the entrances on the amplified base (P3: the default base's scan has
 * none), spaghetti 2D's maxY 215 on its witness (R5).
 */
const BAND_PINS: Readonly<Record<(typeof BAND_LEAVES)[number], string>> = {
  'caves.cheese.minY': 'cave column (546, 25857)',
  'caves.cheese.maxY': 'amplified witness column (-20297, -13632)',
  'caves.spaghetti3d.minY': 'cave column (546, 25857)',
  'caves.spaghetti3d.maxY': 'amplified witness column (-1430, 31644)',
  'caves.spaghetti2d.minY': 'cave column (4705, -24478)',
  'caves.spaghetti2d.maxY': 'witness column (-8539, 19151)',
  'caves.noodles.minY': 'cave column (4705, -24478)',
  'caves.noodles.maxY': 'cave column (546, 25857)',
  'caves.entrances.minY': 'badlands column (-26426, -31088)',
  'caves.entrances.maxY': 'amplified witness column (9157, 4188)',
};
/**
 * The leaves whose default sits at a range end, so U2 has one step for them: the band leaves (320 → 272; −64 → −54)
 * and the island cap's top (344 → 292; Task 9).
 */
const ONE_STEP = ['caves.cheese.maxY', 'caves.spaghetti3d.maxY', 'caves.spaghetti2d.minY', 'caves.entrances.minY', 'caves.entrances.maxY', 'caves.limits.capTop'];

/** The island cap's top (SP6a Task 9), decided on a floating_islands base at its own witness. */
const CAP_TOP = 'caves.limits.capTop';
/** The wet roof's depth (SP6a Task 9), meant for the coast class column (it acts under water only). */
const WATER_DEPTH = 'caves.limits.waterDepth';
/** capTop's witness at seed 42: its column and the scan's figures (draws of sp6a.liveness.capTop, examined, hashed). */
const CAP_TOP_PIN = { via: 'floating_islands witness column (28062, -9459)', draws: 350, examined: 17, checks: 1 } as const;

const leaf = (path: string) => {
  const info = SCHEMA.leaves.find((l) => l.path === path);
  if (info === undefined) throw new Error(`no leaf ${path}`);
  return info;
};
const CTX = ctxFor('42');
const moved = (path: string, value: unknown) => ctxFor('42', patchAt(path, value) as ParamsPatch);

const CLASSES: readonly LivenessClass[] = [
  'land', 'land', 'coast', 'coast', 'channel', 'channel', 'gorge', 'gorge', 'basin', 'basin', 'rim', 'rim',
  'threshold:lakes.p', 'threshold:lakes.minC', 'threshold:lakes.offsetMin', 'threshold:lakes.offsetMax',
  'cliffY', 'cliffSteep', 'snowline', 'patch', 'badlands',
];
/** SP3b's 16 class columns at seed 42 (the third pass leaves them, and every verdict decided on them, unchanged). */
const SP3B_COLUMNS: readonly (readonly [number, number])[] = [
  [-25833, 16792], [-15542, -30245], [23279, 27598], [-1451, 21847], [6298, -18132], [13027, -10891], [-2619, 6024],
  [31185, -27596], [-13409, -28645], [-22814, -6798], [-10536, 924], [-31628, -24239], [-24389, -23313], [23605, 2444],
  [-16278, -8451], [26525, 25423],
];
/** SP3c spec §3.5's pins: (cx, cz) and the stream index of each surface class column at seed 42. */
const SURFACE_PINS: Readonly<Record<SurfaceClass, readonly [number, number, number]>> = {
  cliffY: [17107, 13836, 53],
  cliffSteep: [-24200, -4864, 61],
  snowline: [-25681, 32120, 255],
  patch: [-20548, -22882, 11],
  badlands: [-26426, -31088, 35],
};
const SURFACE_LEAVES = SCHEMA.leaves.filter((l) => l.path.startsWith('surface.')).map((l) => l.path);
let cached: LivenessColumn[] | null = null;
/** The class columns of seed 42 and the default params (the scan runs once per file). */
const columns = (): LivenessColumn[] => (cached ??= livenessColumns(CTX));

const PATCH_BIOMES = ['taiga', 'snowy_taiga', 'savanna', 'jungle', 'swamp', 'windswept_hills', 'stony_shore', 'volcano', 'stony_peaks', 'frozen_peaks'];
/**
 * SP3c spec §3.5's corner prefilters at the default params, written from the spec: a dry corner (surfaceWaterLevel −∞)
 * of the 25 quart corners (i, j ∈ 0 … 4) with T_top = T − lapse·max(0, surfaceEst − lapseBase).
 */
function surfaceShows(s: ColumnSample): Record<SurfaceClass, () => boolean> {
  const f = s.f;
  const p = DEFAULTS.surface;
  const corners = Array.from({ length: 25 }, (_, n) => latticeIndex(n % 5, Math.floor(n / 5)));
  const dry = (holds: (k: number) => boolean) => () => corners.some((k) => f.surfaceWaterLevel[k] === -Infinity && holds(k));
  const tTop = (k: number) => f.T[k]! - p.lapse * Math.max(0, f.surfaceEst[k]! - p.lapseBase);
  return {
    cliffY: dry((k) => f.steep[k]! >= 0.85 * p.cliffSteep && f.surfaceEst[k]! >= 0.85 * p.cliffMinY - 8 && f.surfaceEst[k]! <= 1.15 * p.cliffMinY + 8),
    cliffSteep: dry((k) => f.steep[k]! >= 0.85 * p.cliffSteep && f.surfaceEst[k]! >= p.cliffMinY - 8),
    snowline: dry((k) => f.steep[k]! < p.cliffSteep && f.surfaceEst[k]! >= p.lapseBase && Math.abs(tTop(k) - p.snowline) <= 0.1),
    patch: dry((k) => f.steep[k]! < p.cliffSteep && tTop(k) >= p.snowline && PATCH_BIOMES.includes(biomeName(s.biome[k]!))),
    badlands: dry((k) => biomeName(s.biome[k]!) === 'badlands'),
  };
}

describe('perturbations', () => {
  test('every leaf of the schema gets two distinct perturbed values (a json leaf its one pinned variant, a bool leaf its negation, a leaf at a range end one), each valid for the leaf', () => {
    for (const p of ONE_STEP) {
      const l = leaf(p).leaf;
      expect([p, getPath(DEFAULTS, p) === l.min || getPath(DEFAULTS, p) === l.max]).toEqual([p, true]);
    }
    expect(perturbations(leaf('caves.cheese.maxY'), 320)).toEqual([272]);
    expect(perturbations(leaf('caves.entrances.minY'), -64)).toEqual([-54]);
    for (const info of SCHEMA.leaves) {
      const value = getPath(DEFAULTS, info.path);
      const values = perturbations(info, value);
      const n = info.leaf.kind === 'json' || info.leaf.kind === 'bool' || ONE_STEP.includes(info.path) ? 1 : 2;
      expect(values, info.path).toHaveLength(n);
      expect(new Set([value, ...values].map((v) => canonicalJSON(v))).size, info.path).toBe(n + 1);
      for (const v of values) {
        const issues: Issue[] = [];
        checkLeaf(info.leaf, v, info.path, issues);
        expect(issues, info.path).toEqual([]);
      }
    }
  });

  test('bool (SP3e spec §5.6): one variant, the negation', () => {
    const S = buildSchema(group('Test', 'test schema', { flag: bool(false, { label: 'Flag', doc: 'a switch', scope: 'terrain', stage: 'shape' }) }));
    const info = S.leaves[0]!;
    expect(perturbations(info, false)).toEqual([true]);
    expect(perturbations(info, true)).toEqual([false]);
    for (const v of [true, false]) {
      const issues: Issue[] = [];
      checkLeaf(info.leaf, perturbations(info, v)[0], info.path, issues);
      expect(issues).toEqual([]);
    }
  });

  test('number: ±15 % of |v|, or of the range span when v is 0 or the step leaves the range; clamped', () => {
    expect(perturbations(leaf('climate.scaleMul'), 1)).toEqual([0.85, 1.15]);
    expect(perturbations(leaf('lakes.minC'), -0.1)).toEqual([-0.115, -0.085]);
    expect(perturbations(leaf('rivers.coastFadeLo'), 0)).toEqual([-0.3, 0.3]);
    // 64 − 9.6 is below the minimum 63; 64 − 15 % of the span 65 is too, so it clamps to 63.
    expect(perturbations(leaf('rivers.valleyFloor'), 64)).toEqual([63, 73.6]);
    // At the maximum the upward step clamps back to v and is dropped.
    expect(perturbations(leaf('lakes.p'), 1)).toEqual([0.85]);
  });

  test('noise: wavelength × 0.85 and × 1.15 within the leaf range', () => {
    const def = DEFAULTS.climate.C;
    expect(perturbations(leaf('climate.C'), def)).toEqual([{ ...def, wavelength: 2040 }, { ...def, wavelength: 2760 }]);
    expect(perturbations(leaf('climate.C'), { ...def, wavelength: 20000 })).toEqual([{ ...def, wavelength: 17000 }]);
  });

  test('spline: every numeric knot moves by ±15 % of the leaf y span, clamped to the range; x and d stay', () => {
    const offset = DEFAULTS.shape.offset;
    const [down, up] = perturbations(leaf('shape.offset'), offset) as NestedSpline[];
    expect(down!.points[0]).toEqual({ ...offset.points[0], y: -41.6 });
    expect(up!.points[0]).toEqual({ ...offset.points[0], y: 73.6 });
    const nested = up!.points[5]!.y as NestedSpline;
    expect(nested.points.map((p) => p.y)).toEqual([127.6, 121.6, 120.6]);
    expect(nested.points.map((p) => [p.x, p.d])).toEqual((offset.points[5]!.y as NestedSpline).points.map((p) => [p.x, p.d]));
    const [jagDown] = perturbations(leaf('shape.jag'), DEFAULTS.shape.jag) as NestedSpline[];
    expect(jagDown!.points[0]!.y).toBe(-16);
  });

  test('density leaves (SP3b spec §3.3): every perturbation stays inside the leaf range (the json leaf has none)', () => {
    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    expect(density.map((l) => l.path)).toEqual([
      'density.noises.jag', 'density.noises.overhang', 'density.noises.detail', 'density.noises.islands', 'density.detailAmpLo',
      'density.detailAmpHi', 'density.defs',
    ]);
    for (const info of density.filter((l) => l.leaf.kind !== 'json')) {
      const lo = info.leaf.min!;
      const hi = info.leaf.max!;
      for (const v of perturbations(info, getPath(DEFAULTS, info.path))) {
        const x = info.leaf.kind === 'noise' ? (v as { wavelength: number }).wavelength : (v as number);
        expect(x >= lo && x <= hi, `${info.path}: ${x} in [${lo}, ${hi}]`).toBe(true);
      }
    }
    expect(perturbations(leaf('density.detailAmpLo'), 0.6)).toEqual([0.51, 0.69]);
    expect((perturbations(leaf('density.noises.detail'), DEFAULTS.density.noises.detail) as { wavelength: number }[]).map((d) => d.wavelength))
      .toEqual([8.5, 11.5]);
    // At the top of the range the upward step clamps back to the value and is dropped.
    expect(perturbations(leaf('density.detailAmpHi'), 8)).toEqual([6.8]);
  });

  test('boxTable: every interval shrunk and grown by 15 % of its width about its centre, within [−1, 1]', () => {
    const [shrunk, grown] = perturbations(leaf('biomes.table'), DEFAULTS.biomes.table) as BoxTable[];
    expect(shrunk!['beach']!.C).toEqual([-0.2065, -0.0535]);
    expect(grown!['beach']!.C).toEqual([-0.2335, -0.0265]);
    expect(shrunk!['beach']!.PV).toEqual([-0.85, 0.85]);
    expect(grown!['beach']!.PV).toEqual([-1, 1]);
    expect([grown!['beach']!.wSign, grown!['beach']!.priority]).toEqual([0, 5]);
  });

  test('json (SP3d spec §7): density.defs mutes the terrain tap to 0, surface.rules moves the deepslate gradient top 8 → 12; nothing else changes', () => {
    const tree = DEFAULTS.density.defs as Record<string, any>;
    const [muted] = perturbations(leaf('density.defs'), tree) as Record<string, any>[];
    expect(muted!.root.a.a.a.x.a).toEqual({ ...tree.root.a.a.a.x.a, mute: 0 });
    // The terrain tap sits at root.a.a.a.x.a, inside the precave tap (SP6a §1.1); with it put back the trees are equal.
    const back = JSON.parse(JSON.stringify(muted)) as Record<string, any>;
    back['root'].a.a.a.x.a = tree.root.a.a.a.x.a;
    expect(canonicalJSON(back)).toBe(canonicalJSON(tree));
    expect(tree.root.a.a.a.x.a.mute).toBeUndefined();
    const rules = DEFAULTS.surface.rules as Record<string, any>;
    const [higher] = perturbations(leaf('surface.rules'), rules) as Record<string, any>[];
    expect(rules.rules[2].if).toMatchObject({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 });
    expect(higher!.rules[2].if).toEqual({ ...rules.rules[2].if, falseAtAndAbove: 12 });
    expect(canonicalJSON({ ...higher, rules: rules.rules })).toBe(canonicalJSON(rules));
    // A tree without the pinned node (an edited profile) has no U2 variant: a clear error, not a wrong one.
    expect(() => perturbations(leaf('density.defs'), { root: { op: 'y' }, defs: {} })).toThrow(/density\.defs has no/);
    expect(() => perturbations(leaf('surface.rules'), { kind: 'sequence', rules: [] })).toThrow(/surface\.rules has no/);
  });
});

describe('lake cells', () => {
  test('cellProbe reproduces lakeCell eligibility, with the default params and with a variant', () => {
    for (const ctx of [CTX, ctxFor('42', { lakes: { p: 0.3, minC: -0.4, offsetMax: 150 } })]) {
      let enabled = 0;
      for (let j = -20; j <= 20; j++) {
        for (let i = -20; i <= 20; i++) {
          const cell = lakeCell(ctx, i, j);
          expect(cellEligible(cellProbe(ctx, cell), ctx.params.lakes), `cell (${i}, ${j})`).toBe(cell.enabled);
          if (cell.enabled) enabled++;
        }
      }
      expect(enabled).toBeGreaterThan(20);
    }
  });
});

describe('class columns', () => {
  test('the scan of samplePoints(sp2b.liveness, 200000) fills every class with distinct columns', () => {
    const got = columns().map((c) => c.cls);
    const empty = [...new Set(CLASSES)].filter((c) => got.filter((g) => g === c).length < CLASSES.filter((e) => e === c).length);
    expect(empty, `empty classes: ${empty.join(', ')}`).toEqual([]);
    expect(got).toEqual(CLASSES);
    expect(new Set(columns().map((c) => `${c.cx},${c.cz}`)).size).toBe(21);
  });

  test('the first 16 columns are SP3b\'s; the surface classes come after, in the third pass order', () => {
    expect(columns().slice(0, 16).map((c) => [c.cx, c.cz])).toEqual(SP3B_COLUMNS);
    expect(SURFACE_CLASSES).toEqual(['cliffY', 'cliffSteep', 'snowline', 'patch', 'badlands']);
    expect(columns().slice(16).map((c) => c.cls)).toEqual(SURFACE_CLASSES);
  });

  test('the surface class columns are the pinned ones (SP3c spec §3.5), each at its pinned stream index', () => {
    const pts = samplePoints('sp2b.liveness', 512);
    const firstIndex = (cx: number, cz: number): number =>
      Array.from({ length: 512 }, (_, n) => n).find((n) => Math.floor(pts.x[n]! / 16) === cx && Math.floor(pts.z[n]! / 16) === cz) ?? -1;
    for (const cls of SURFACE_CLASSES) {
      const c = columns().find((x) => x.cls === cls)!;
      const [cx, cz, index] = SURFACE_PINS[cls];
      expect([c.cx, c.cz], cls).toEqual([cx, cz]);
      expect(firstIndex(c.cx, c.cz), cls).toBe(index);
    }
  });

  test('each column shows its class on its ColumnSample lattice', () => {
    const s: ColumnSample = newColumnSample();
    const any = (p: (k: number) => boolean): boolean => Array.from({ length: 49 }, (_, k) => k).some(p);
    for (const c of columns()) {
      const f = buildColumnSample(CTX, c.cx, c.cz, s).f;
      const river = (k: number) => riverWetAt(s, k) || gorgeAt(s, k);
      const shows: Record<string, () => boolean> = {
        land: () => !any((k) => f.surfaceWaterLevel[k]! > -Infinity),
        coast: () => any((k) => Math.abs(f.offset0[k]! - 63) <= 8),
        channel: () => any((k) => river(k) && f.riverStrength[k]! > 0 && f.offset0[k]! >= 63 && f.offset0[k]! < 120),
        gorge: () => any((k) => river(k) && f.offset0[k]! > 120 && f.offset0[k]! < 170),
        basin: () => any((k) => f.lakeMask[k] === 1),
        rim: () => any((k) => f.lakeMask[k]! > 0 && f.lakeMask[k]! < 1),
        ...surfaceShows(s),
      };
      const ok = c.cls.startsWith('threshold:') ? any((k) => f.lakeMask[k]! > 0) : shows[c.cls]!();
      expect(ok, `${c.cls} (${c.cx}, ${c.cz})`).toBe(true);
    }
  });

  test('the surface prefilters, written here from SP3c spec §3.5, hold on their columns at a dry corner', () => {
    const s = newColumnSample();
    for (const cls of SURFACE_CLASSES) {
      const c = columns().find((x) => x.cls === cls)!;
      expect(surfaceShows(buildColumnSample(CTX, c.cx, c.cz, s))[cls](), cls).toBe(true);
    }
    // The cliff column met by the cliffY prefilter in SP3c's pre-measurement is a coast column of the first passes.
    expect(surfaceShows(buildColumnSample(CTX, 23279, 27598, s)).cliffY()).toBe(true);
  });

  test('each threshold column changes its shape hash when its gate leaf moves', () => {
    for (const c of columns().filter((x) => x.cls.startsWith('threshold:'))) {
      const path = c.cls.slice('threshold:'.length);
      const base = stageOutputHash(CTX, 'shape', c.cx, c.cz);
      const hashes = perturbations(leaf(path), getPath(DEFAULTS, path)).map((v) => stageOutputHash(moved(path, v), 'shape', c.cx, c.cz));
      expect(hashes.some((h) => h !== base), c.cls).toBe(true);
    }
  });

  test('a gate whose closing band is empty within the scan falls back to the band a variant opens', () => {
    // lakes.p = 0: no cell is eligible, so no variant closes a lake; the variant p = 0.15 opens some.
    const ctx0 = ctxFor('42', { lakes: { p: 0 } });
    const cols = livenessColumns(ctx0, 400);
    expect(cols.map((c) => c.cls)).toEqual([
      'land', 'land', 'coast', 'coast', 'channel', 'channel', 'gorge', 'gorge', 'threshold:lakes.p', ...SURFACE_CLASSES,
    ]);
    const p = cols[8]!;
    const s = buildColumnSample(ctx0, p.cx, p.cz, newColumnSample());
    expect(Array.from(s.f.lakeMask).every((m) => m === 0)).toBe(true);
    expect(stageOutputHash(moved('lakes.p', 0.15), 'shape', p.cx, p.cz)).not.toBe(stageOutputHash(ctx0, 'shape', p.cx, p.cz));
  });

  test('intendedClass names the class meant to exercise a leaf', () => {
    expect(intendedClass('lakes.minC')).toBe('threshold:lakes.minC');
    expect(intendedClass('lakes.rimRise')).toBe('rim');
    expect(intendedClass('lakes.depthVar')).toBe('basin');
    expect(intendedClass('rivers.gorgeDepth')).toBe('gorge');
    expect(intendedClass('rivers.coastFadeHi')).toBe('coast');
    expect(intendedClass('rivers.wetMargin')).toBe('channel');
    expect(intendedClass('climate.C')).toBe('land');
    expect(intendedClass('biomes.zoomJitter')).toBe('land');
    expect(intendedClass('surface.cliffMinY')).toBe('cliffY');
    expect(intendedClass('surface.cliffSteep')).toBe('cliffSteep');
    for (const p of ['surface.snowline', 'surface.lapse', 'surface.lapseBase']) expect(intendedClass(p), p).toBe('snowline');
    for (const p of ['surface.noises.patch', 'surface.patchThreshold']) expect(intendedClass(p), p).toBe('patch');
    for (const p of ['surface.noises.depth', 'surface.depthMul']) expect(intendedClass(p), p).toBe('land');
    expect(intendedClass('surface.noises.bandOffset')).toBe('badlands');
    for (const p of ['density.noises.islands', 'islands.enabled', 'islands.noise', 'islands.lo', 'islands.hi']) expect(intendedClass(p), p).toBe('island');
    for (const p of ['caves.cheese.offset', 'caves.pillars.threshold', 'caves.limits.surfaceDepth', 'caves.noises.entrance', 'caves.spaghetti3d.scales.s2', 'caves.noodles.regional', 'caves.noises.noodleToggle']) expect(intendedClass(p), p).toBe('cave');
  });
});

describe('surface class columns (SP3c spec §3.5)', () => {
  test('the slots serve every surface.* leaf except the depth ones and the rule tree, which belong to land', () => {
    expect(SURFACE_CLASSES.map((c) => surfaceSlotLeaves(c))).toEqual([
      ['surface.cliffMinY'], ['surface.cliffSteep'], ['surface.snowline', 'surface.lapse', 'surface.lapseBase'],
      ['surface.noises.patch', 'surface.patchThreshold'], ['surface.noises.bandOffset'],
    ]);
    const served = [...SURFACE_CLASSES.flatMap((c) => surfaceSlotLeaves(c)), 'surface.noises.depth', 'surface.depthMul', 'surface.rules'];
    expect([...served].sort()).toEqual([...SURFACE_LEAVES].sort());
  });

  test('every leaf a surface column serves acts on it (the acceptance check)', () => {
    const acceptance = surfaceAcceptance(CTX);
    for (const cls of SURFACE_CLASSES) {
      const c = columns().find((x) => x.cls === cls)!;
      expect(acceptance.accepts(cls, c.cx, c.cz), cls).toBe(true);
      for (const path of surfaceSlotLeaves(cls)) expect(acceptance.leafActs(path, c.cx, c.cz), `${cls}: ${path}`).toBe(true);
    }
  });

  test('surfacePrefilter equals the prefilters written from the spec on the first 400 stream columns', () => {
    const pts = samplePoints('sp2b.liveness', 400);
    const s = newColumnSample();
    const hits = new Map<SurfaceClass, number>(SURFACE_CLASSES.map((c) => [c, 0]));
    for (let n = 0; n < 400; n++) {
      buildColumnSample(CTX, Math.floor(pts.x[n]! / 16), Math.floor(pts.z[n]! / 16), s);
      const shows = surfaceShows(s);
      for (const cls of SURFACE_CLASSES) {
        const want = shows[cls]();
        expect(surfacePrefilter(CTX, cls, s), `${cls} at stream index ${n}`).toBe(want);
        if (want) hits.set(cls, hits.get(cls)! + 1);
      }
    }
    for (const cls of SURFACE_CLASSES) expect(hits.get(cls)!, cls).toBeGreaterThan(3);
  });

  test('the acceptance check looks below the top: the depth leaves act on the first land column', () => {
    // surfaceDepth never changes a top voxel's block (every SKIN gate holds there), only how many under blocks follow it.
    const acceptance = surfaceAcceptance(CTX);
    const land = columns()[0]!;
    for (const path of ['surface.noises.depth', 'surface.depthMul']) expect(acceptance.leafActs(path, land.cx, land.cz), path).toBe(true);
  });

  test('a prefiltered column whose leaf cannot act is rejected: coast column (23279, 27598) for cliffY', () => {
    // Its dry steep corners meet the cliffY prefilter, but its land tops lie at y 63-64, far below cliffMinY ± 15 %.
    const acceptance = surfaceAcceptance(CTX);
    expect(acceptance.leafActs('surface.cliffMinY', 23279, 27598)).toBe(false);
    expect(acceptance.accepts('cliffY', 23279, 27598)).toBe(false);
    expect(() => acceptance.leafActs('density.detailAmpLo', 23279, 27598)).toThrow(/not a surface leaf/);
  });
});

describe('stage output hashes', () => {
  test('biomes.zoomJitter moves only the biome2d hash, through the per-block zoom', () => {
    const c = columns().find((x) => x.cls === 'gorge')!;
    const jitter = moved('biomes.zoomJitter', 1.725);
    expect(stageOutputHash(jitter, 'climate', c.cx, c.cz)).toBe(stageOutputHash(CTX, 'climate', c.cx, c.cz));
    expect(stageOutputHash(jitter, 'shape', c.cx, c.cz)).toBe(stageOutputHash(CTX, 'shape', c.cx, c.cz));
    expect(stageOutputHash(jitter, 'biome2d', c.cx, c.cz)).not.toBe(stageOutputHash(CTX, 'biome2d', c.cx, c.cz));
    const lattice = (ctx: typeof CTX) => Array.from(buildColumnSample(ctx, c.cx, c.cz, newColumnSample()).biome);
    expect(lattice(jitter)).toEqual(lattice(CTX));
  });

  test('terrain: the region hash of the 1 × 1 window after fillColumnT on a fresh ArrayBuffer store', () => {
    for (const c of columns().filter((x) => x.cls === 'land' || x.cls === 'coast')) {
      const store = createStore({ shared: false, maxBlockBytes: 1 << 20, maxByteBytes: 1 << 20 });
      expect(fillColumnT(store, CTX, c.cx, c.cz, () => false)).toBe(true);
      const expected = hex64(regionHash(store, c.cx, c.cz, 1, 1));
      expect(stageOutputHash(CTX, 'terrain', c.cx, c.cz), `${c.cls} (${c.cx}, ${c.cz})`).toBe(expected);
      expect(stageOutputHash(CTX, 'terrain', c.cx, c.cz)).toBe(expected);
    }
    const c = columns()[0]!;
    const h = (['climate', 'shape', 'biome2d', 'terrain'] as const).map((st) => stageOutputHash(CTX, st, c.cx, c.cz));
    expect(new Set(h).size).toBe(4);
  });

  test('a density leaf moves only the terrain hash', () => {
    // On the retuned defaults (SP3b §8.4) the first land column's solidity does not flip at detailAmpHi 1.725; the
    // second does (U2 decides the leaf there too). The 2D hashes stay on both.
    const lands = columns().filter((x) => x.cls === 'land');
    expect(lands.length).toBe(2);
    const amp = moved('density.detailAmpHi', 1.725);
    let movedTerrain = 0;
    for (const c of lands) {
      for (const st of ['climate', 'shape', 'biome2d'] as const) {
        expect(stageOutputHash(amp, st, c.cx, c.cz), st).toBe(stageOutputHash(CTX, st, c.cx, c.cz));
      }
      if (stageOutputHash(amp, 'terrain', c.cx, c.cz) !== stageOutputHash(CTX, 'terrain', c.cx, c.cz)) movedTerrain++;
    }
    expect(movedTerrain).toBeGreaterThan(0);
  });

  test('a climate leaf moves the climate hash; the three hashes are distinct and repeatable', () => {
    const c = columns()[0]!;
    const h = (['climate', 'shape', 'biome2d'] as const).map((st) => stageOutputHash(CTX, st, c.cx, c.cz));
    expect(new Set(h).size).toBe(3);
    expect(stageOutputHash(CTX, 'shape', c.cx, c.cz)).toBe(h[1]);
    expect(stageOutputHash(moved('climate.scaleMul', 1.15), 'climate', c.cx, c.cz)).not.toBe(h[0]);
  });
});

describe('the terrain stage in U2 (SP3b spec §3.3)', () => {
  test('U2 covers the leaves of the climate, shape, biome2d and terrain stages, every density.* and surface.* leaf among them', () => {
    const stages = ['climate', 'shape', 'biome2d', 'terrain'];
    const surface = SCHEMA.leaves.filter((l) => l.path.startsWith('surface.'));
    expect(surface.length).toBe(11);
    for (const l of surface) expect(l.meta.stage, l.path).toBe('terrain');
    const expected = SCHEMA.leaves.filter((l) => l.meta.stage !== undefined && stages.includes(l.meta.stage)).map((l) => l.path);
    expect(u2Leaves().map((l) => l.path)).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(surface.map((l) => l.path)));
    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.'));
    expect(density.length).toBe(7);
    for (const l of density) expect(l.meta.stage, l.path).toBe('terrain');
    expect(expected).toEqual(expect.arrayContaining(density.map((l) => l.path)));
    expect(intendedClass('density.detailAmpLo')).toBe('land');
    for (const p of ['density.defs', 'surface.rules']) expect(intendedClass(p), p).toBe('land');
  });

  test('every density.* leaf but density.noises.islands is decided on a land or coast column; NI is dead on the default base', () => {
    const density = SCHEMA.leaves.filter((l) => l.path.startsWith('density.') && l.path !== 'density.noises.islands');
    expect(density.length).toBe(6);
    // No default tree reads NI (SP3e spec §5.6): it is decided on the islands base (below).
    expect(leafLiveness(CTX, 'density.noises.islands', columns())).toEqual({ path: 'density.noises.islands', live: false, via: null, cls: 'island' });
    for (const l of density) {
      const r = leafLiveness(CTX, l.path, columns());
      expect(r.live, `${l.path}: ${r.via ?? 'dead'}`).toBe(true);
      expect(r.via, l.path).toMatch(/^(land|coast) column \(-?\d+, -?\d+\)$/);
      expect(r.cls === 'land' || r.cls === 'coast', l.path).toBe(true);
    }
  });

  test('every surface.* leaf is decided: each on its own class column, the depth leaves and the rule tree on a land column', () => {
    for (const path of SURFACE_LEAVES) {
      const r = leafLiveness(CTX, path, columns());
      const cls = intendedClass(path);
      const c = columns().find((x) => x.cls === cls)!;
      expect(r, path).toEqual({ path, live: true, via: `${cls} column (${c.cx}, ${c.cz})`, cls });
    }
  });

  test('a surface leaf whose class column is missing is dead, never a silent pass: cliffMinY on SP3b\'s 16 columns', () => {
    expect(leafLiveness(CTX, 'surface.cliffMinY', columns().slice(0, 16))).toEqual({ path: 'surface.cliffMinY', live: false, via: null, cls: 'cliffY' });
  });

  test('a terrain leaf is tried on the land, coast and surface columns only, with no stream witness', () => {
    const terrain: readonly LivenessClass[] = ['land', 'coast', ...SURFACE_CLASSES];
    const others = columns().filter((c) => !terrain.includes(c.cls));
    expect(others.length).toBe(12);
    // bandOffset acts only through the badlands bands: dead without the badlands column, never a silent pass.
    expect(leafLiveness(CTX, 'surface.noises.bandOffset', columns().filter((c) => c.cls !== 'badlands')))
      .toEqual({ path: 'surface.noises.bandOffset', live: false, via: null, cls: 'badlands' });
    expect(leafLiveness(CTX, 'density.noises.detail', others)).toEqual({ path: 'density.noises.detail', live: false, via: null, cls: 'land' });
  });
});

describe('the islands base (SP3e spec §5.6)', () => {
  const ISLANDS = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
  let found: LivenessColumn | null | undefined;
  /** The island class column of seed 42 on floating_islands (searched once per file). */
  const island = (): LivenessColumn => {
    if (found === undefined) found = islandColumn(ISLANDS);
    expect(found, 'no island column').not.toBeNull();
    return found!;
  };

  test(`the islands leaves are density.noises.islands and the islands.* group, decided apart; U2 covers ${U2_LEAVES} leaves`, () => {
    expect(islandLeaves().map((l) => l.path)).toEqual(['density.noises.islands', 'islands.enabled', 'islands.noise', 'islands.lo', 'islands.hi']);
    expect(u2Leaves().length).toBe(U2_LEAVES);
    // The islands leaves come right before the first caves.* leaf (SP6a appends the caves group after islands).
    const paths = u2Leaves().map((l) => l.path);
    const firstCave = paths.findIndex((p) => p.startsWith('caves.'));
    expect(paths.slice(firstCave - 4, firstCave)).toEqual(islandLeaves().slice(1).map((l) => l.path));
  });

  test('the island column: the first draw of U2.islands whose lattice holds 0 < m < 1 and m ≥ 0.75 and on which every islands leaf acts', () => {
    const c = island();
    expect(c).toEqual(ISLAND_PIN);
    const m = Array.from(buildColumnSample(ISLANDS, c.cx, c.cz, newColumnSample()).f.islandMask);
    expect(m.some((v) => v > 0 && v < 1)).toBe(true);
    expect(m.some((v) => v >= 0.75)).toBe(true);
    // The draws of Xoshiro128(fnv1a32('U2.islands')), uniform in [−2048, 2048)²: the column is among the first 4096.
    const r = new Xoshiro128(fnv1a32('U2.islands'));
    const draws = Array.from({ length: 4096 }, () => [-2048 + r.nextInt(4096), -2048 + r.nextInt(4096)] as const);
    const at = draws.findIndex(([cx, cz]) => cx === c.cx && cz === c.cz);
    expect(at).toBe(ISLAND_DRAW);
  });

  test('every islands leaf is live on the island column: islands.* through the shape digest, NI through the T column', () => {
    const c = island();
    for (const l of islandLeaves()) {
      expect(leafLiveness(ISLANDS, l.path, [c]), l.path).toEqual({ path: l.path, live: true, via: `island column (${c.cx}, ${c.cz})`, cls: 'island' });
    }
    // Only the mask moves: the shape digest changes, the climate digest does not.
    const off = createGenContext(ISLANDS.seed, (() => {
      const r = applyPatch(SCHEMA, ISLANDS.params, { islands: { enabled: false } });
      if (!r.ok) throw new Error('bad patch');
      return r.value;
    })());
    expect(stageOutputHash(off, 'shape', c.cx, c.cz)).not.toBe(stageOutputHash(ISLANDS, 'shape', c.cx, c.cz));
    expect(stageOutputHash(off, 'climate', c.cx, c.cz)).toBe(stageOutputHash(ISLANDS, 'climate', c.cx, c.cz));
  });

  test('no island column where the mask is off: the default base finds none (U2 then fails with "no island column")', () => {
    expect(islandColumn(CTX, islandLeaves(), 64)).toBeNull();
  });
});

describe('the cave class columns (SP6a spec §4)', () => {
  const found = new Map<CaveSlot, LivenessColumn | null>();
  /** The cave class column of seed 42 on the default base for `slot` (searched once per file). */
  const cave = (slot: CaveSlot): LivenessColumn => {
    if (!found.has(slot)) found.set(slot, caveColumn(CTX, slot));
    expect(found.get(slot), `no cave column (${slot})`).not.toBeNull();
    return found.get(slot)!;
  };
  const caves = (): LivenessColumn[] => CAVE_SLOTS.map(cave);

  test('the caves leaves are the caves.* group, in schema order, after the islands leaves; the slots share them but the scale leaves', () => {
    expect(caveLeaves().map((l) => l.path)).toEqual(SCHEMA.leaves.filter((l) => l.path.startsWith('caves.')).map((l) => l.path));
    expect(caveLeaves().length).toBe(62);
    expect(CAVE_SLOTS).toEqual(['caverns', 'tunnels']);
    const tunnels = caveSlotLeaves('tunnels').map((l) => l.path);
    expect(tunnels).toEqual([
      'caves.spaghetti3d.thickness', 'caves.spaghetti3d.thicknessVar', 'caves.spaghetti3d.regional',
      'caves.spaghetti2d.thickness', 'caves.spaghetti2d.layerAmp',
      'caves.noodles.thickness', 'caves.noodles.ridgeMul', 'caves.noodles.regional',
      'caves.noises.spag3dA', 'caves.noises.spag3dB', 'caves.noises.spag3dRarity', 'caves.noises.spag3dThickness',
      'caves.noises.spagRegional', 'caves.noises.spag2d', 'caves.noises.spag2dElevation', 'caves.noises.spag2dThickness',
      'caves.noises.spag2dRarity', 'caves.noises.noodleToggle', 'caves.noises.noodleThickness', 'caves.noises.noodleRidgeA',
      'caves.noises.noodleRidgeB',
    ]);
    // Task 6's 19 leaves and caves.limits.bandSpan are the caverns' (its cave column is unchanged).
    expect(caveSlotLeaves('caverns').length).toBe(20);
    expect(caveSlotLeaves('caverns').map((l) => l.path)).toContain('caves.limits.bandSpan');
    const slotted = new Set([...caveSlotLeaves('caverns'), ...caveSlotLeaves('tunnels')].map((l) => l.path));
    const apart: readonly string[] = [...SCALE_LEAVES, ...BAND_LEAVES, CAP_TOP, WATER_DEPTH];
    expect(caveLeaves().map((l) => l.path).filter((p) => !slotted.has(p))).toEqual(caveLeaves().map((l) => l.path).filter((p) => apart.includes(p)));
    expect(apart.length).toBe(21);
  });

  test('each slot\'s column: the first land column of sp6a.liveness.caves where its families act and every leaf of its slot changes the T column', () => {
    const pts = samplePoints('sp6a.liveness.caves', 4096);
    const dc = createDensityContext(CTX);
    for (const slot of CAVE_SLOTS) {
      const c = cave(slot);
      const [pin, draw] = CAVE_PINS[slot];
      expect(c, slot).toEqual(pin);
      let n = 0;
      while (Math.floor(pts.x[n]! / 16) !== c.cx || Math.floor(pts.z[n]! / 16) !== c.cz) n++;
      expect([slot, n]).toEqual([slot, draw]);
      const f = caveFamilyCounts(dc, DEFAULTS.caves.pillars.threshold, c.cx, c.cz);
      const families = slot === 'caverns' ? [f.entrances, f.cheese, f.pillars] : [f.spag3d, f.spag2d, f.noodle];
      for (const v of families) expect(v, slot).toBeGreaterThan(0);
      // A land column: no water on its lattice (SP2b's land test).
      const s = buildColumnSample(CTX, c.cx, c.cz, newColumnSample());
      expect(Array.from(s.f.surfaceWaterLevel).every((w) => w === -Infinity)).toBe(true);
    }
    // No draw up to the tunnels' column holds the tunnels' families and accepts every leaf of both slots (none of the
    // first 4096 draws holds every family and accepts every leaf, a 7 s scan left out here), hence the two slots.
    expect(caveColumn(CTX, 'tunnels', [...caveSlotLeaves('caverns'), ...caveSlotLeaves('tunnels')], CAVE_PINS.tunnels[1] + 1)).toBeNull();
  });

  test('every caves leaf but the scale and band leaves, capTop and waterDepth is live on a cave column (the class it is meant for), and only through the T stage', () => {
    const cs = caves();
    const apart: readonly string[] = [...SCALE_LEAVES, ...BAND_LEAVES, CAP_TOP, WATER_DEPTH];
    for (const l of caveLeaves().filter((x) => !apart.includes(x.path))) {
      expect(intendedClass(l.path)).toBe('cave');
      const r = leafLiveness(CTX, l.path, [...columns(), ...cs]);
      expect([l.path, r.live, r.cls]).toEqual([l.path, true, 'cave']);
      expect(cs.map((c) => `cave column (${c.cx}, ${c.cz})`)).toContain(r.via);
    }
  });

  test('the wet roof\'s waterDepth is meant for the coast class column and live on it, through the T stage (SP6a §1.4, Task 9)', () => {
    expect(intendedClass(WATER_DEPTH)).toBe('coast');
    const coast = columns().filter((c) => c.cls === 'coast');
    expect(coast.length).toBe(2);
    const r = leafLiveness(CTX, WATER_DEPTH, [...columns(), ...caves()]);
    expect([r.live, r.cls]).toEqual([true, 'coast']);
    expect(coast.map((c) => `coast column (${c.cx}, ${c.cz})`)).toContain(r.via);
    // U2's steps of 16 (int, 8 … 48): 14 and 18.
    expect(perturbations(leaf(WATER_DEPTH), DEFAULTS.caves.limits.waterDepth)).toEqual([14, 18]);
  });

  test('every spaghetti scale leaf is live on a class column or on its bounded witness (ruling P5)', () => {
    const all = [...columns(), ...caves()];
    for (const p of SCALE_LEAVES) {
      const r = leafLiveness(CTX, p, all);
      expect([p, r.live]).toEqual([p, true]);
      // Wherever it is decided, its own witness search finds a column too: one where band k meets rock the family carves.
      const w = scaleWitness(CTX, p, all);
      expect(w.via, p).toMatch(/^witness column \(-?\d+, -?\d+\)$/);
      const [cx, cz] = w.via!.slice('witness column ('.length, -1).split(', ').map(Number) as [number, number];
      expect(scaleBandCarves(createDensityContext(CTX), p, cx, cz), p).toBeGreaterThan(0);
      expect(w.checks, p).toBeLessThanOrEqual(64);
      expect(findWitness(CTX, p, all)).toBe(w.via);
    }
  });

  test('a caves leaf is a terrain leaf: tried on the terrain class columns only, with no stream witness (dead on the others)', () => {
    const terrain: readonly LivenessClass[] = ['land', 'coast', ...SURFACE_CLASSES];
    const others = columns().filter((c) => !terrain.includes(c.cls));
    expect(leafLiveness(CTX, 'caves.pillars.threshold', others)).toEqual({ path: 'caves.pillars.threshold', live: false, via: null, cls: 'cave' });
    expect(caveColumn(CTX, 'caverns', caveSlotLeaves('caverns'), 0)).toBeNull();
    expect(() => scaleWitness(CTX, 'caves.noodles.regional')).toThrow('not a spaghetti scale leaf');
  });
});

describe('the depth-band leaves (SP6a Task 8; rulings P3, P4, R5)', () => {
  let found: LivenessColumn[] | null = null;
  /** The class columns with the two cave columns (searched once per describe). */
  const all = (): LivenessColumn[] => (found ??= [...columns(), ...CAVE_SLOTS.map((s) => caveColumn(CTX, s)!)]);
  /** The family's air above y `above` on (cx, cz) of `ctx`: voxels the pre-cave density holds solid where its tap is ≤ 0. */
  const airAbove = (ctx: GenContext, tap: string, cx: number, cz: number, above: number): number => {
    const dc = createDensityContext(ctx);
    dc.column(cx, cz);
    let n = 0;
    for (let y = above + 1; y < 320; y++) {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        if (dc.compiled.tapFn('precave', lx, y, lz) > 0 && dc.compiled.tapFn(tap, lx, y, lz) <= 0) n++;
      }
    }
    return n;
  };
  const columnOf = (via: string): [number, number] => via.slice(via.indexOf('(') + 1, -1).split(', ').map(Number) as [number, number];

  test('each band leaf is live: on a class column, else on its band witness (the amplified base for three maxY leaves)', () => {
    for (const p of BAND_LEAVES) {
      expect(intendedClass(p)).toBe('cave');
      const r = leafLiveness(CTX, p, all());
      expect([p, r.live, r.via]).toEqual([p, true, BAND_PINS[p]]);
    }
  }, 120_000); // about 8 s alone (the default base's 2,048-column maxY scan among them), 37 s under test:goldens

  test('the windows: every y a step of the leaf can change, 7 blocks past the steps, clipped to y −63 … 319', () => {
    expect(bandWindow(CTX, 'caves.cheese.maxY')).toEqual([265, 319]);
    expect(bandWindow(CTX, 'caves.cheese.minY')).toEqual([-63, -41]);
    expect(bandWindow(CTX, 'caves.entrances.minY')).toEqual([-63, -47]);
    expect(bandWindow(CTX, 'caves.noodles.maxY')).toEqual([47, 319]);
    expect(bandWindow(CTX, 'caves.spaghetti2d.maxY')).toEqual([176, 319]);
    expect(() => bandWindow(CTX, 'caves.limits.bandSpan')).toThrow('not a depth-band leaf');
    expect(() => bandWitness(CTX, 'caves.noodles.regional')).toThrow('not a depth-band leaf');
    expect(() => amplifiedBandWitness(CTX, 'caves.noodles.maxY')).toThrow('not decided on an amplified base');
  });

  test('P3: the maxY 320 of cheese, spaghetti 3D and the entrances has no witness on the default base; each has one on the amplified base, holding its air above y 272', () => {
    const amplified = createGenContext(seedFromInput('42'), resolveProfile('amplified'));
    const draws: Record<string, number> = { 'caves.cheese.maxY': 42, 'caves.spaghetti3d.maxY': 1351, 'caves.entrances.maxY': 686 };
    const taps: Record<string, string> = { 'caves.cheese.maxY': 'cheese', 'caves.spaghetti3d.maxY': 'spag3d', 'caves.entrances.maxY': 'entrances' };
    for (const p of Object.keys(draws)) {
      expect(getPath(DEFAULTS, p)).toBe(320);
      // The default base: 2,048 columns of sp6a.liveness.mountain examined, none with the family's air in y 265 … 319.
      expect([p, bandWitness(CTX, p, all())]).toEqual([p, { via: null, draws: 2048, examined: 2048, checks: 0, span: [265, 319] }]);
      const w = amplifiedBandWitness(CTX, p);
      expect([p, w.via, w.draws]).toEqual([p, BAND_PINS[p as (typeof BAND_LEAVES)[number]], draws[p]]);
      const [cx, cz] = columnOf(w.via!);
      expect([p, airAbove(amplified, taps[p]!, cx, cz, 272) > 0]).toEqual([p, true]);
    }
  });

  test('R5: spaghetti 2D\'s maxY 215 is the highest default from 208 to 244 whose lower step has a witness, and moves no generated output', () => {
    expect(DEFAULTS.caves.spaghetti2d.maxY).toBe(215);
    // 215's steps are 183 and 247; on the witness the lower one changes the T column, the upper one does not.
    expect(perturbations(leaf('caves.spaghetti2d.maxY'), 215)).toEqual([183, 247]);
    const w = bandWitness(CTX, 'caves.spaghetti2d.maxY', all());
    expect([w.via, w.draws, w.checks, w.span]).toEqual([BAND_PINS['caves.spaghetti2d.maxY'], 28559, 1, [176, 319]]);
    const [cx, cz] = columnOf(w.via!);
    const at = (maxY: number) => stageOutputHash(moved('caves.spaghetti2d.maxY', maxY), 'terrain', cx, cz);
    expect([at(183) !== at(215), at(247) !== at(215)]).toEqual([true, false]);
    // The layer is never open above y 208, so maxY 208 … 244 changes no output: here 215 gives the T column of 320.
    expect(at(320)).toBe(at(215));
    expect(airAbove(CTX, 'spag2d', cx, cz, 183)).toBeGreaterThan(0);
    expect(airAbove(CTX, 'spag2d', cx, cz, 208)).toBe(0);
    // 216 (step 184) has none: the witness's highest air is at y 184, which a cap from 184 does not reach.
    const w216 = bandWitness(moved('caves.spaghetti2d.maxY', 216), 'caves.spaghetti2d.maxY', all());
    expect([w216.via, w216.draws]).toEqual([null, 32768]);
  });

  test('P4: each minY leaf (and the noodle\'s maxY) also has its own band witness off the class columns, near the bottom', () => {
    const pins: Array<[string, string, number]> = [
      ['caves.cheese.minY', 'witness column (-26773, -930)', 2],
      ['caves.spaghetti3d.minY', 'witness column (8300, 13717)', 18],
      ['caves.spaghetti2d.minY', 'witness column (-17888, 14467)', 8],
      ['caves.noodles.minY', 'witness column (-26773, -930)', 2],
      ['caves.entrances.minY', 'witness column (10701, -27440)', 13],
      ['caves.noodles.maxY', 'witness column (-22165, -25285)', 3],
    ];
    for (const [p, via, draws] of pins) {
      const w = bandWitness(CTX, p, all());
      expect([p, w.via, w.draws]).toEqual([p, via, draws]);
      expect(w.checks).toBeLessThanOrEqual(64);
    }
  });
});

describe('the island cap\'s capTop (SP6a Task 9; spec §1.4, §4)', () => {
  const FLOATING = createGenContext(seedFromInput('42'), resolveProfile('floating_islands'));
  /** Noise-cave air of (cx, cz) in y 176 … 200 on `ctx`: the pre-cave density holds the voxel solid, the root does not. */
  const caveAir = (ctx: GenContext, cx: number, cz: number): number => {
    const dc = createDensityContext(ctx);
    dc.column(cx, cz);
    let n = 0;
    for (let y = 176; y <= 200; y++) {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        if (dc.compiled.tapFn('precave', lx, y, lz) > 0 && !(dc.compiled.voxelFn(lx, y, lz) > 0)) n++;
      }
    }
    return n;
  };

  test('capTop is live on its floating_islands witness, not on the default base\'s class columns or the island class column', () => {
    expect(intendedClass(CAP_TOP)).toBe('cave');
    // Its default 344 lies above the world: U2's one step (292) changes no class column of the default base.
    expect(perturbations(leaf(CAP_TOP), 344)).toEqual([292]);
    const all = [...columns(), ...CAVE_SLOTS.map((slot) => caveColumn(CTX, slot)!)];
    const r = leafLiveness(CTX, CAP_TOP, all);
    expect(r).toEqual({ path: CAP_TOP, live: true, via: CAP_TOP_PIN.via, cls: null });
    expect(capTopWitness(CTX)).toEqual(CAP_TOP_PIN);
    // On floating_islands capTop is 180; its lower step clamps back to 180, so 207 is U2's one effective step.
    expect(FLOATING.params.caves.limits.capTop).toBe(180);
    expect(perturbations(leaf(CAP_TOP), 180)).toEqual([207]);
    const [cx, cz] = CAP_TOP_PIN.via.slice(CAP_TOP_PIN.via.indexOf('(') + 1, -1).split(', ').map(Number) as [number, number];
    expect([cx, cz]).not.toEqual([ISLAND_PIN.cx, ISLAND_PIN.cz]);
    // The witness: noise-cave air in y 176 … 200 at capTop 207, none at 180, and a pre-cave top at y ≥ 200.
    const at207 = createGenContext(FLOATING.seed, (() => {
      const p = applyPatch(SCHEMA, FLOATING.params, { caves: { limits: { capTop: 207 } } });
      if (!p.ok) throw new Error('bad capTop patch');
      return p.value;
    })());
    expect(caveAir(at207, cx, cz)).toBeGreaterThan(0);
    expect(caveAir(FLOATING, cx, cz)).toBe(0);
    const dc = createDensityContext(FLOATING);
    dc.column(cx, cz);
    let top = -64;
    for (let y = 319; y >= -63 && top === -64; y--) for (let p = 0; p < 256; p++) if (dc.compiled.tapFn('precave', p & 15, y, p >> 4) > 0) { top = y; break; }
    expect(top).toBeGreaterThanOrEqual(200);
    expect(stageOutputHash(at207, 'terrain', cx, cz)).not.toBe(stageOutputHash(FLOATING, 'terrain', cx, cz));
  });
});

describe('witnesses', () => {
  test('the lake-cell spiral finds a witness for lakes.minC', () => {
    expect(findWitness(CTX, 'lakes.minC')).toBe('witness cell (-12, 4) → column (-235, 87)');
  });

  test('a flipped cell whose centre column keeps its hash does not end the spiral', () => {
    // Cell (2, 6) comes first in the spiral and minC −0.115 enables it, but the lake warp puts its lake off its centre column.
    const cell = lakeCell(CTX, 2, 6);
    const probe = cellProbe(CTX, cell);
    const loose = moved('lakes.minC', -0.115);
    expect([cellEligible(probe, CTX.params.lakes), cellEligible(probe, loose.params.lakes)]).toEqual([false, true]);
    const cx = Math.floor(cell.cx / 16);
    const cz = Math.floor(cell.cz / 16);
    expect(stageOutputHash(loose, 'shape', cx, cz)).toBe(stageOutputHash(CTX, 'shape', cx, cz));
  });

  test('other leaves take the next stream columns that are not class columns', () => {
    expect(findWitness(CTX, 'climate.C', columns())).toMatch(/^witness column \(-?\d+, -?\d+\)$/);
  });
});

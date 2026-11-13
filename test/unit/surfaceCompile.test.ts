import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { compileSurfaceRules, surfaceFastPath, type CompiledSurfaceRules, type SurfaceFastPath } from '../../src/gen/surface/compile';
import { createSurfaceReference } from '../../src/gen/surface/reference';
import { RuleValidationError, ruleLeaves, type Condition, type Rule, type StrataRule, type SurfaceNoiseSource } from '../../src/gen/surface/rules';
import { strataOffset, strataState, strataTable } from '../../src/gen/surface/bands';
import {
  classifyCaveBiomes, newSurfaceScan, scanColumn, surfaceScanSettings, type SurfaceScan, type SurfaceScanSettings,
} from '../../src/gen/surface/scan';
import { AIR, BEDROCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import { caveBiomeHere } from '../../src/gen/surface/conditions';
import { caveBiomeOfPass } from '../../src/gen/biomes/cavePicker';
import type { CaveBiomeSettings } from '../../src/gen/biomes/caveRegistry';
import {
  fuzzCavePicker, handCavePass, randomSurfaceColumn, randomSurfaceParams, randomSurfaceRules, SURFACE_FUZZ_CAVE_SETTINGS, SURFACE_FUZZ_PARAMS,
  surfaceFuzzNoiseSource, surfaceFuzzSettings, withCaveBiomes, type CaveFields, type SurfaceFuzzColumn, type SurfaceFuzzStyle,
} from '../harness/surfaceFuzz';
import { testRng } from '../harness/stats';
import { legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { DEFAULTS } from '../../src/core/params/defaults';

const SEED: Seed64 = [42, 0];
const NOISES = surfaceFuzzNoiseSource(SEED);
const at = (p: number, y: number): number => 256 * (y + 64) + p;
const UNTOUCHED = 0xffff;

const B = (state: string): Rule => ({ kind: 'block', state });
const IF = (c: Condition, then: Rule): Rule => ({ kind: 'condition', if: c, then });
const IFS = (cs: Condition[], then: Rule): Rule => cs.reduceRight<Rule>((r, c) => IF(c, r), then);
const SEQ = (...rules: Rule[]): Rule => ({ kind: 'sequence', rules });
const NOT = (c: Condition): Condition => ({ kind: 'not', if: c });
const SKY: Condition = { kind: 'skyOpen' };
const floor = (offset: number, addSurfaceDepth: boolean): Condition => ({ kind: 'stoneDepth', side: 'floor', offset, addSurfaceDepth });
const TOP = floor(0, false), SKIN = floor(0, true), BAND4 = floor(4, true);
const grad = (lo: number, hi: number): Condition => ({ kind: 'verticalGradient', trueAtAndBelow: lo, falseAtAndAbove: hi });
const yAbove = (minY: number, runTop: boolean): Condition => ({ kind: 'yAbove', minY, runTop });
const biome = (...biomes: string[]): Condition => ({ kind: 'biome', biomes } as Condition);
const P: Condition = { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: 0.55, max: 8 };
const ceil = (offset: number, addSurfaceDepth: boolean): Condition => ({ kind: 'stoneDepth', side: 'ceiling', offset, addSurfaceDepth });

/**
 * The voxels the SP3c fast path (before SP6b's per-class bounds) took without evaluating: solid, in a constant band,
 * floorDepth > maxSurfaceDepth or, in a sky-gated tree, a run without sky. `fillColumn` evaluated the rest.
 */
function sp3cEvaluated(fp: SurfaceFastPath, scan: SurfaceScan): number {
  const bandAt = new Int32Array(384).fill(-1);
  for (const b of fp.bands) for (let y = b.yMin; y <= b.yMax; y++) bandAt[y + 64] = b.state;
  let evaluated = 0;
  for (let p = 0; p < 256; p++) {
    for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
      const sky = r === scan.skyRun[p];
      for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y--) {
        if (!(bandAt[y + 64]! >= 0 && (scan.runTop[r]! - y > fp.maxSurfaceDepth || (fp.skyGated && !sky)))) evaluated++;
      }
    }
  }
  return evaluated;
}

/**
 * §4's default tree in shape (Decision 6's order), with this chain's three states standing in for the palette (the
 * palette and defaults.ts are other tasks'): bedrock gradient, the sky-open branch, the deepslate gradient (bedrock).
 */
const DEFAULT_SHAPE: Rule = SEQ(
  IF(grad(-64, -59), B('bedrock')),
  IF(SKY, SEQ(
    IFS([NOT({ kind: 'water', offset: 0, runTop: false }), SKIN], SEQ(
      IF(biome('warm_ocean', 'beach'), B('air')),
      IFS([biome('river'), P], B('bedrock')),
      IFS([{ kind: 'lake' }, { kind: 'water', offset: -2, runTop: true }], B('air')),
      IF(NOT({ kind: 'water', offset: -10, runTop: true }), B('bedrock')),
      B('stone'),
    )),
    IFS([{ kind: 'steep', min: 1.2 }, yAbove(80, true), SKIN], SEQ(IF(biome('frozen_peaks'), B('bedrock')), B('stone'))),
    IFS([TOP, { kind: 'temperatureBelow', t: -0.6 }], B('air')),
    IF(SKIN, SEQ(IF(biome('desert'), B('air')), IF(TOP, SEQ(IFS([biome('plains'), P], B('bedrock')), B('air'))), B('bedrock'))),
    IF(BAND4, SEQ(IF(biome('desert', 'beach'), B('bedrock')), IF(biome('badlands'), B('air')))),
  )),
  IF(grad(0, 8), B('bedrock')),
);

const band = (yMin: number, yMax: number, state: number) => ({ yMin, yMax, dither: false, state });
const dither = (yMin: number, yMax: number) => ({ yMin, yMax, dither: true, state: -1 });

/** A noise source whose depth noise is pinned at +clampSigma, so surfaceDepth = SD_MAX at every position. */
function maxDepthNoises(): SurfaceNoiseSource {
  return (name) => {
    const n = NOISES(name);
    if (n === undefined || name !== 'surface.noises.depth') return n;
    return { ...n, z2: () => n.clampSigma };
  };
}

/** Ground −63 … top(p) at every position, no water, the readouts of a random sample. */
function handColumn(top: (p: number) => number): SurfaceFuzzColumn {
  const col = randomSurfaceColumn(testRng(1));
  col.solid.fill(0);
  col.water.fill(0);
  col.sample.f.lakeLevel.fill(-Infinity);
  for (let p = 0; p < 256; p++) {
    col.solid[at(p, -64)] = 1;
    for (let y = -63; y <= top(p); y++) col.solid[at(p, y)] = 1;
  }
  return col;
}

const scanOf = (col: SurfaceFuzzColumn, set: SurfaceScanSettings): SurfaceScan =>
  scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes, col.tags ?? null, col.cave ?? null);

function fill(c: CompiledSurfaceRules, scan: SurfaceScan, fast: boolean): { out: Uint16Array; evaluated: number } {
  const out = new Uint16Array(98304).fill(UNTOUCHED);
  return { out, evaluated: c.fillColumn(scan, out, fast) };
}

/**
 * The voxels §3.4 and SP6b §3.5 (D20 1-3) let take their band: solid, in a constant band, floorDepth beyond the run's
 * floor bound (the sky-open run's: the larger of the two floor classes'; any other run's: the non-sky class's) and
 * ceilDepth beyond the ceiling class's bound, a class's bound −1 for a run whose floor (ceiling) biome its biome-gated
 * skip leaves out. (A tree with here-gated leaves, item 4, takes more: this counts only the bands whose state is one.)
 */
function fastVoxels(fp: SurfaceFastPath, scan: SurfaceScan): { fast: number; noSkyNearTop: number; solid: number } {
  const bandAt = new Int32Array(384).fill(-1);
  for (const b of fp.bands) for (let y = b.yMin; y <= b.yMax; y++) bandAt[y + 64] = b.state;
  const skipped = (set: number, biome: number) => set >= 0 && (biome < 0 || ((set >> biome) & 1) === 0);
  let fast = 0, noSkyNearTop = 0, solid = 0;
  for (let p = 0; p < 256; p++) {
    for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
      const sky = r === scan.skyRun[p];
      const other = skipped(fp.floorBiomes, scan.runFloorBiome[r]!) ? -1 : fp.floorBound;
      const ceilBound = skipped(fp.ceilBiomes, scan.runCeilBiome[r]!) ? -1 : fp.ceilBound;
      const floorBound = sky ? Math.max(fp.skyFloorBound, other) : other;
      for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y--) {
        solid++;
        const depth = scan.runTop[r]! - y;
        if (bandAt[y + 64]! >= 0 && depth > floorBound && y - scan.runBottom[r]! > ceilBound) {
          fast++;
          if (!sky && depth <= fp.maxSurfaceDepth) noSkyNearTop++;
        }
      }
    }
  }
  return { fast, noSkyNearTop, solid };
}

type CaveSide = 'floor' | 'ceiling' | 'here';
type CaveName = 'plain' | 'lush' | 'dripstone' | 'abyss';
const CB = (side: CaveSide, ...biomes: CaveName[]): Condition => ({ kind: 'caveBiome', side, biomes });
const PATCH = (min: number, max: number): Condition => ({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min, max });
/** §3.3's abyss layers. */
const ABYSS_LAYERS = [
  { state: 'abyss_stone', weight: 50, maxLen: 8 }, { state: 'abyss_shale', weight: 25, maxLen: 4 },
  { state: 'cracked_abyss_stone', weight: 15, maxLen: 3 }, { state: 'abyss_stone_veined', weight: 10, maxLen: 1 },
];

/**
 * Rule 4 (SP6b spec §3.4) as Task 22 writes it, with `surface.noises.patch` standing in for `cavePatch` and
 * `surface.noises.bandOffset` for `strataOffset` (both 2D, remap none: the leaves Task 22 adds do not exist yet).
 */
const RULE4: Rule = SEQ(
  IF(CB('here', 'abyss'), SEQ(
    IFS([floor(1, false), CB('floor', 'abyss'), PATCH(-0.84, 8)], B('abyss_ash')),
    { kind: 'strata', layers: ABYSS_LAYERS, minLen: 1, maxLen: 6, noise: 'surface.noises.bandOffset', amp: 6 },
  )),
  IFS([floor(1, false), CB('floor', 'lush')], SEQ(IF(PATCH(0.84, 8), B('clay')), B('moss_block'))),
  IFS([floor(1, false), CB('floor', 'dripstone'), NOT(PATCH(-8, -0.97))], B('dripstone_block')),
  IFS([ceil(0, false), CB('ceiling', 'lush'), PATCH(-0.52, 8)], B('moss_block')),
  IFS([ceil(1, false), CB('ceiling', 'dripstone'), NOT(PATCH(-8, -0.97))], B('dripstone_block')),
);

/** The default's shape with `inserted` at root.rules[2] (rule 4's place). */
function withRule(inserted: Rule): Rule {
  const [rule1, sky, rule2] = (DEFAULT_SHAPE as Extract<Rule, { kind: 'sequence' }>).rules;
  return SEQ(rule1!, sky!, inserted, rule2!);
}

/** Position p's classification (`classifyCaveBiomes`) as a mask per y + 64 (0 when the scan has no picker). */
function classMasks(scan: SurfaceScan, p: number): Uint8Array {
  const out = new Uint8Array(384);
  const n = classifyCaveBiomes(scan, p);
  for (let i = 0; i < n; i++) {
    const hi = i === 0 ? 319 : scan.caveRangeLow[i - 1]! - 1;
    for (let y = scan.caveRangeLow[i]!; y <= hi; y++) out[y + 64] = scan.caveRangeMask[i]!;
  }
  return out;
}

/** p's (2J + 1)² neighbourhood in a pass: every box's climate test there and the extreme Y0s. */
function neighbourhood(pass: ReturnType<typeof handCavePass>, st: CaveBiomeSettings, p: number) {
  const j = pass.j;
  let abyssAll = true, lushAll = true, y0Min = Infinity, y0Max = -Infinity;
  for (let dz = -j; dz <= j; dz++) {
    for (let dx = -j; dx <= j; dx++) {
      const k = ((p >> 4) + 4 + dz) * 24 + (p & 15) + 4 + dx;
      abyssAll &&= pass.e[k]! <= st.abyss.eMax && pass.c[k]! > st.abyss.cMin;
      lushAll &&= pass.h[k]! >= st.lush.hMin;
      y0Min = Math.min(y0Min, pass.y0[k]!);
      y0Max = Math.max(y0Max, pass.y0[k]!);
    }
  }
  return { abyssAll, lushAll, y0Min, y0Max };
}

/**
 * An abyss column (under a mountain: ground −63 … 180-186): the pass's E′ −0.8 rising by 0.06 a block past local x 8,
 * so the abyss's climate test is surely true at local x ≤ 10, mixed around 11-14 and surely false beyond, C′ 0.2,
 * H′ `h(lz)`, and Y0 sloping across the neighbourhood (160 + 1.3·lx + 0.7·lz + a quarter-block wobble).
 */
function abyssColumn(settings: CaveBiomeSettings, h: (lz: number) => number = () => 0): SurfaceFuzzColumn & { cave: NonNullable<SurfaceFuzzColumn['cave']> } {
  const col = handColumn((p) => 180 + (p % 7));
  const { cx, cz } = col.sample;
  const pass = handCavePass(cx, cz, settings.edgeJitter, (x, z): CaveFields => {
    const lx = x - 16 * cx, lz = z - 16 * cz;
    return { c: 0.2, e: -0.8 + 0.06 * Math.max(0, lx - 8), h: h(lz), y0: 160 + 1.3 * lx + 0.7 * lz + 0.25 * (((x * 7 + z * 3) % 5 + 5) % 5) };
  });
  return { ...col, cave: { inputs: fuzzCavePicker(settings), pass } };
}

describe('surface rule compiler (SP3c spec §3.4)', () => {
  const set = surfaceFuzzSettings(SEED);

  test('compiling validates the tree and binds the settings', () => {
    expect(() => compileSurfaceRules(SEED, { kind: 'block', state: 'not_a_block' }, NOISES, set)).toThrow(RuleValidationError);
    expect(() => compileSurfaceRules(SEED, { kind: 'bandlands' }, (n) => (n === 'surface.noises.bandOffset' ? undefined : NOISES(n)), set)).toThrow(/NO_BAND_NOISE/);
    expect(() => compileSurfaceRules(SEED, { kind: 'bandlands' }, NOISES, set, new Uint16Array(193))).toThrow(RangeError);
    const c = compileSurfaceRules(SEED, DEFAULT_SHAPE, NOISES, set);
    expect(c.rules).toBe(DEFAULT_SHAPE);
    expect(c.settings).toBe(set);
  });

  test("the default tree's shape: maxSurfaceDepth = SD_MAX + 4, sky-gated, bands −59 … 0 and 8 … 319 (§3.4)", () => {
    expect(set.sdMax).toBe(11);
    expect(compileSurfaceRules(SEED, DEFAULT_SHAPE, NOISES, set).fastPath).toEqual({
      maxSurfaceDepth: 15,
      skyGated: true,
      skyFloorBound: 15,
      floorBound: -1,
      ceilBound: -1,
      floorBiomes: -1,
      ceilBiomes: -1,
      here: false,
      bands: [dither(-63, -60), band(-59, 0, BEDROCK), dither(1, 7), band(8, 319, STONE)],
    });
    // SD_MAX comes from the live settings: depthMul 0 gives 3, so 7.
    const set0 = surfaceFuzzSettings(SEED, { ...SURFACE_FUZZ_PARAMS, depthMul: 0 });
    expect(set0.sdMax).toBe(3);
    expect(surfaceFastPath(DEFAULT_SHAPE, set0.sdMax)?.maxSurfaceDepth).toBe(7);
  });

  test('leaf classes: any leaf neither depth-bounded, ceiling-bounded (SP6b §3.5) nor Y-only turns the fast path off', () => {
    const offPaths: Condition[] = [
      NOT(SKIN), NOT(NOT(SKIN)), NOT(ceil(2, false)), yAbove(70, true), biome('desert'),
      SKY, { kind: 'water', offset: 0, runTop: false }, { kind: 'lake' }, { kind: 'steep', min: 1 }, P, { kind: 'temperatureBelow', t: 0 },
      NOT(yAbove(70, true)), NOT(SKY),
    ];
    for (const c of offPaths) {
      for (const tree of [SEQ(IF(SKIN, B('air')), IF(c, B('bedrock'))), SEQ(IF(c, B('bedrock')), IF(grad(0, 8), B('air'))), IF(grad(0, 8), IF(c, B('air')))]) {
        expect([c, surfaceFastPath(tree, 11)]).toEqual([c, null]);
      }
      // The same condition on a depth-bounded path does not matter.
      expect(surfaceFastPath(SEQ(IFS([c, TOP], B('air')), IF(grad(0, 8), B('bedrock'))), 11)).not.toBeNull();
    }
    // Y-only leaves: gradients, yAbove{runTop false} and nots of these, at any nesting; an unconditioned leaf.
    for (const tree of [B('stone'), IF(NOT(NOT(yAbove(5, false))), B('air')), IFS([grad(-3, 4), NOT(grad(10, 12)), yAbove(-20, false)], B('air'))]) {
      expect(surfaceFastPath(tree, 11)).not.toBeNull();
    }
  });

  test('maxSurfaceDepth: the smallest gate bound on a path, the largest over leaves; −1 without depth-bounded leaves', () => {
    const fp = (tree: Rule, sdMax: number) => surfaceFastPath(tree, sdMax)!;
    expect(fp(IFS([floor(5, false), floor(2, true)], B('air')), 11).maxSurfaceDepth).toBe(5);
    expect(fp(IFS([floor(5, false), floor(2, true)], B('air')), 1).maxSurfaceDepth).toBe(3);
    expect(fp(SEQ(IF(floor(3, false), B('air')), IF(floor(-2, true), B('air')), IF(floor(20, false), IF(floor(9, false), B('air')))), 11).maxSurfaceDepth).toBe(9);
    expect(fp(SEQ(IF(floor(3, false), B('air')), IF(floor(-2, true), B('air'))), 11).maxSurfaceDepth).toBe(9);
    expect(fp(IF(floor(-3, false), B('air')), 11).maxSurfaceDepth).toBe(-1);
    expect(fp(SEQ(), 11)).toEqual({
      maxSurfaceDepth: -1, skyGated: true, skyFloorBound: -1, floorBound: -1, ceilBound: -1, floorBiomes: -1, ceilBiomes: -1, here: false,
      bands: [band(-63, 319, STONE)],
    });
    expect(fp(IF(grad(0, 8), B('air')), 11).skyGated).toBe(true);
    // Sky gate: a skyOpen `if` on every depth-bounded path, not under a not; the Y-only leaves need none.
    expect(fp(SEQ(IFS([SKY, TOP], B('air')), IFS([floor(2, false), yAbove(3, true), SKY], B('air')), B('bedrock')), 11).skyGated).toBe(true);
    expect(fp(SEQ(IFS([SKY, TOP], B('air')), IF(floor(2, false), B('air'))), 11).skyGated).toBe(false);
    expect(fp(IFS([NOT(NOT(SKY)), TOP], B('air')), 11).skyGated).toBe(false);
  });

  test('per-class bounds (SP6b §3.5, D20 1-2, Spec correction 6): sky floor, other floor, ceiling; a leaf with a floor gate is floor-bounded only', () => {
    const fp = (tree: Rule, sdMax = 11) => surfaceFastPath(tree, sdMax)!;
    const A = B('air');
    const bounds = (f: SurfaceFastPath) => [f.skyFloorBound, f.floorBound, f.ceilBound, f.maxSurfaceDepth, f.skyGated];
    // A skyOpen-gated floor leaf and an ungated one: two floor classes; maxSurfaceDepth the larger.
    expect(bounds(fp(SEQ(IFS([SKY, floor(3, false)], A), IF(floor(1, false), A))))).toEqual([3, 1, -1, 3, false]);
    expect(bounds(fp(SEQ(IFS([SKY, floor(1, false)], A), IF(floor(3, false), A))))).toEqual([1, 3, -1, 3, false]);
    // Ceiling-bounded: every depth gate a ceiling one; the smallest gate bound on a path (+ SD_MAX with
    // addSurfaceDepth), the largest over leaves, −1 when every bound is negative.
    expect(bounds(fp(IF(ceil(2, false), A)))).toEqual([-1, -1, 2, -1, false]);
    expect(fp(IFS([ceil(5, false), ceil(1, true)], A)).ceilBound).toBe(5);
    expect(fp(IFS([ceil(5, false), ceil(1, true)], A), 1).ceilBound).toBe(2);
    expect(fp(SEQ(IF(ceil(0, false), A), IF(ceil(1, false), A), IF(grad(0, 8), A))).ceilBound).toBe(1);
    expect(fp(IF(ceil(-3, false), A)).ceilBound).toBe(-1);
    // A ceiling leaf under skyOpen is still the one ceiling class (every depth-bounded leaf sky-gated: skyGated).
    expect(bounds(fp(IFS([SKY, ceil(2, false)], A)))).toEqual([-1, -1, 2, -1, true]);
    // Spec correction 6: floating_islands' island leaves hold stoneDepth{ceiling, 100} under stoneDepth{floor, 4 + SD}:
    // floor-bounded only (the floor gate already excludes every voxel beyond it), never the bottom 100 of every run.
    expect(bounds(fp(IFS([yAbove(181, true), ceil(100, false), BAND4], SEQ(IF(TOP, A), IF(ceil(2, false), A), A))))).toEqual([-1, 15, -1, 15, false]);
    expect(bounds(fp(IFS([ceil(0, false), SKY, TOP], A)))).toEqual([0, -1, -1, 0, true]);
  });

  test("the default tree (SP6b §3.5): bounds (15, −1, −1), and fillColumn evaluates exactly SP3c's voxels on 64 columns", () => {
    const real = legacyDefaultSurfaceRules(DEFAULTS.surface);
    for (const tree of [DEFAULT_SHAPE, real]) {
      const c = compileSurfaceRules(SEED, tree, NOISES, set);
      const fp = c.fastPath!;
      expect([fp.skyFloorBound, fp.floorBound, fp.ceilBound, fp.maxSurfaceDepth, fp.skyGated]).toEqual([15, -1, -1, 15, true]);
      const next = testRng(1401);
      let evaluated = 0, solid = 0;
      for (let k = 0; k < 64; k++) {
        const scan = scanOf(randomSurfaceColumn(next), set);
        const fast = fill(c, scan, true);
        expect(fast.evaluated).toBe(sp3cEvaluated(fp, scan));
        evaluated += fast.evaluated;
        solid += fastVoxels(fp, scan).solid;
        if (k % 8 === 0) expect(Buffer.from(fast.out).equals(Buffer.from(fill(c, scan, false).out))).toBe(true);
      }
      expect(evaluated).toBeLessThan(solid / 2);
    }
  });

  test("rule 4's ceiling leaves without their caveBiome gates (SP6b §3.4-§3.5): ceilBound 1, each run's bottom 2 voxels plus the floor class's", () => {
    // stoneDepth{ceiling, 0} → cavePatch → moss_block; stoneDepth{ceiling, 1} → not(cavePatch) → dripstone_block, with
    // surface.noises.patch standing in for cavePatch (Task 22's leaf) and no floor gate; inserted at root.rules[2] of
    // the default's shape. With the caveBiome{ceiling} gates back the tree keeps this fast path, and the biome-gated
    // skip (extension 3) leaves out the runs whose ceiling biome no leaf names.
    const CEILING_LEAVES = SEQ(
      IFS([ceil(0, false), { kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -0.52, max: 8 }], B('moss_block')),
      IFS([ceil(1, false), NOT({ kind: 'noiseThreshold', noise: 'surface.noises.patch', min: -8, max: -0.97 })], B('dripstone_block')),
    );
    const [rule1, sky, rule2] = (DEFAULT_SHAPE as Extract<Rule, { kind: 'sequence' }>).rules;
    const tree = SEQ(rule1!, sky!, CEILING_LEAVES, rule2!);
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    const fp = c.fastPath!;
    expect([fp.skyFloorBound, fp.floorBound, fp.ceilBound, fp.maxSurfaceDepth, fp.skyGated]).toEqual([15, -1, 1, 15, false]);
    expect(fp.bands).toEqual(compileSurfaceRules(SEED, DEFAULT_SHAPE, NOISES, set).fastPath!.bands);
    const ref = createSurfaceReference(SEED, tree, NOISES);
    const next = testRng(1402);
    let evaluated = 0, solid = 0, ceilingStates = 0;
    for (let k = 0; k < 16; k++) {
      const scan = scanOf(randomSurfaceColumn(next), set);
      const slow = fill(c, scan, false), fast = fill(c, scan, true);
      expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
      // Evaluated: the dither intervals, the sky-open run's top 16 (floorDepth ≤ 15) and every run's bottom 2.
      let want = 0;
      for (let p = 0; p < 256; p++) {
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          const top = scan.runTop[r]!, bottom = scan.runBottom[r]!;
          for (let y = top; y >= bottom; y--) {
            solid++;
            const dithered = (y >= -63 && y <= -60) || (y >= 1 && y <= 7);
            if (dithered || (r === scan.skyRun[p] && top - y <= 15) || y - bottom <= 1) want++;
            const s = slow.out[at(p, y)]!;
            if (y - bottom <= 1 && (s === REGISTRY.parseStateKey('moss_block') || s === REGISTRY.parseStateKey('dripstone_block'))) ceilingStates++;
            if (p % 16 === k) expect(s).toBe(ref.state(scan, set, p, y));
          }
        }
      }
      expect(fast.evaluated).toBe(want);
      evaluated += fast.evaluated;
    }
    expect(ceilingStates).toBeGreaterThan(1000);
    expect(evaluated).toBeLessThan(solid / 2);
  });

  test('bands are cut only by the Y-only leaves: minY of yAbove{runTop false}, gradient ends; dither intervals evaluated', () => {
    const tree = SEQ(
      IF(yAbove(100, false), B('bedrock')),
      IFS([SKY, SKIN, yAbove(200, true), grad(30, 40), yAbove(50, false)], B('air')), // depth-bounded: cuts nothing
      IF(NOT(yAbove(20, false)), IF(grad(-10, -5), B('air'))),
      IF(grad(150, 151), B('stone')),
      IF(grad(-200, -100), B('air')), // ends outside the world
      IF(grad(300, 400), B('bedrock')), // dither through the world top
    );
    expect(surfaceFastPath(tree, 11)).toEqual({
      maxSurfaceDepth: 11,
      skyGated: true,
      skyFloorBound: 11,
      floorBound: -1,
      ceilBound: -1,
      floorBiomes: -1,
      ceilBiomes: -1,
      here: false,
      bands: [
        band(-63, -10, AIR), dither(-9, -6), band(-5, 19, STONE), band(20, 99, STONE), band(100, 150, BEDROCK), band(151, 300, BEDROCK),
        dither(301, 319),
      ],
    });
  });

  test('bandlands: a band whose first holding Y-only leaf is bandlands is always evaluated (state −1, not a dither); compiled == reference', () => {
    const BAND: Rule = { kind: 'bandlands' };
    const tree = SEQ(
      IF(grad(0, 8), B('bedrock')),
      IFS([yAbove(40, false), NOT(yAbove(60, false))], BAND),
      IFS([SKY, TOP], BAND),
    );
    const fp = surfaceFastPath(tree, 11)!;
    expect(fp).toEqual({
      maxSurfaceDepth: 0,
      skyGated: true,
      skyFloorBound: 0,
      floorBound: -1,
      ceilBound: -1,
      floorBiomes: -1,
      ceilBiomes: -1,
      here: false,
      bands: [band(-63, 0, BEDROCK), dither(1, 7), band(8, 39, STONE), { yMin: 40, yMax: 59, dither: false, state: -1 }, band(60, 319, STONE)],
    });
    const col = handColumn((p) => 70 + (p % 5));
    const scan = scanOf(col, set);
    const ref = createSurfaceReference(SEED, tree, NOISES);
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    const slow = fill(c, scan, false), fast = fill(c, scan, true);
    expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
    expect(fast.evaluated).toBe(fastVoxels(fp, scan).solid - fastVoxels(fp, scan).fast);
    const colours = new Set<number>();
    for (let p = 0; p < 256; p++) {
      for (let y = -63; y <= scan.runTop[scan.runFirst[p]!]!; y++) {
        expect(slow.out[at(p, y)]).toBe(ref.state(scan, set, p, y));
        if (y >= 40 && y <= 59) colours.add(slow.out[at(p, y)]!);
      }
    }
    // The bands vary along y and with the offset noise: several terracottas in y 40 … 59, all rule-evaluated.
    expect(colours.size).toBeGreaterThanOrEqual(4);
    expect([...colours].every((s) => REGISTRY.stateKey(s).endsWith('terracotta'))).toBe(true);
    // A table passed in is the one used.
    const flat = new Uint16Array(192).fill(AIR);
    expect(compileSurfaceRules(SEED, tree, NOISES, set, flat).state(scan, 0, 50)).toBe(AIR);
  });

  test('fillColumn: band states below maxSurfaceDepth and in runs without sky, rules elsewhere, non-solid untouched', () => {
    const noises = maxDepthNoises();
    const mset = surfaceScanSettings(SEED, SURFACE_FUZZ_PARAMS, noises);
    const col = handColumn(() => 10);
    // Position 5: an overhang 60 … 70 (sky-open) over the ground run (no sky). Position 6: a cave pocket at 6 … 8.
    for (let y = 60; y <= 70; y++) col.solid[at(5, y)] = 1;
    for (let y = 6; y <= 8; y++) col.solid[at(6, y)] = 0;
    col.water[at(6, 6)] = 1;
    const scan = scanOf(col, mset);
    expect(Array.from(new Set(scan.surfaceDepth))).toEqual([11]);
    // The skin (floorDepth ≤ 4 + surfaceDepth = 15) of sky-open runs is air; below it the deepslate stand-in.
    const tree = SEQ(IF(SKY, IF(BAND4, B('air'))), IF(grad(0, 8), B('bedrock')));
    const c = compileSurfaceRules(SEED, tree, noises, mset);
    expect(c.fastPath).toMatchObject({ maxSurfaceDepth: 15, skyGated: true });
    const slow = fill(c, scan, false), fast = fill(c, scan, true);
    expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
    const ref = createSurfaceReference(SEED, tree, noises);
    let solid = 0;
    for (let p = 0; p < 256; p++) {
      for (let y = -64; y <= 319; y++) {
        const s = slow.out[at(p, y)]!;
        if (y === -64 || col.solid[at(p, y)] === 0) { expect(s).toBe(UNTOUCHED); continue; }
        solid++;
        expect(s).toBe(ref.state(scan, mset, p, y));
        expect(c.state(scan, p, y)).toBe(s);
      }
    }
    expect(slow.evaluated).toBe(solid);
    // Exactly at floorDepth 15 (y −5) the skin still holds; one below, the band.
    expect([slow.out[at(0, -5)], slow.out[at(0, -6)], slow.out[at(0, 1)]]).toEqual([AIR, BEDROCK, AIR]);
    // The overhang's ground run has no sky: its top voxels take the bands (stone at 8 … 10, bedrock at y ≤ 0); the
    // dither interval 1 … 7 is evaluated.
    expect([slow.out[at(5, 10)], slow.out[at(5, 0)], slow.out[at(5, 70)], slow.out[at(5, 55)]]).toEqual([STONE, BEDROCK, AIR, UNTOUCHED]);
    // Evaluated with the fast path: y 10 … −5 of the 254 plain positions, the overhang's 11 and its ground's dither 7,
    // the pocket position's 2 sky-open voxels (9, 10) and its no-sky run's dither voxels 1 … 5.
    expect(fast.evaluated).toBe(254 * 16 + 11 + 7 + 2 + 5);
    expect(fast.evaluated).toBe(fastVoxels(c.fastPath!, scan).solid - fastVoxels(c.fastPath!, scan).fast);
  });

  test('fillColumn and state check their arguments; a tree without a fast path is fully evaluated', () => {
    const col = handColumn((p) => (p === 9 ? -63 : 30));
    const scan = scanOf(col, set);
    const c = compileSurfaceRules(SEED, SEQ(IF(biome('plains'), B('air')), IF(grad(0, 8), B('bedrock'))), NOISES, set);
    expect(c.fastPath).toBeNull();
    const slow = fill(c, scan, false), fast = fill(c, scan, true);
    expect(fast.evaluated).toBe(slow.evaluated);
    expect(fast.evaluated).toBe(255 * 94 + 1);
    expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
    expect(() => c.fillColumn(scan, new Uint16Array(98303), true)).toThrow(RangeError);
    expect(() => c.state(scan, 0, 31)).toThrow(/not solid/);
    expect(() => c.state(scan, 9, -62)).toThrow(/not solid/);
    expect(() => c.state(scan, 0, -64)).toThrow(RangeError);
    expect(() => c.state(scan, 0, 320)).toThrow(RangeError);
    expect(() => c.state(scan, 256, 0)).toThrow(RangeError);
    expect(() => c.state(scan, -1, 0)).toThrow(RangeError);
    expect(() => c.state(scan, 0.5, 0)).toThrow(RangeError);
    expect(() => c.state(scan, 0, 1.5)).toThrow(RangeError);
  });

  test('fuzz: compiled == reference, and the fast path == full evaluation, on random trees and columns', () => {
    const next = testRng(7101);
    const cases: Array<[SurfaceFuzzStyle, boolean | undefined]> = [
      ['free', undefined], ['fastPath', true], ['fastPath', false], ['fastPath', undefined], ['nearMiss', true], ['nearMiss', undefined],
    ];
    const isFloor = (c: Condition) => c.kind === 'stoneDepth' && c.side === 'floor';
    const tally = {
      refChecked: 0, voxels: 0, fast: 0, noSkyNearTop: 0, fastTrees: 0, offTrees: 0, gated: 0, ungated: 0, yBefore: 0, yAfter: 0, bandlandsBands: 0,
    };
    // The columns from a stream of their own, so the trees' draws (SP6b's strata leaves) no longer move them; 48 rounds
    // (44 before), so the solid voxels checked stay above 3,000,000 on that stream.
    const nextColumn = testRng(7102);
    for (let round = 0; round < 48; round++) {
      const seed: Seed64 = [next(), next()];
      const noises = surfaceFuzzNoiseSource(SEED);
      const rset = surfaceFuzzSettings(seed, round % 2 === 0 ? randomSurfaceParams(next) : undefined, noises);
      // Cave biomes from a stream of their own.
      const col = withCaveBiomes(randomSurfaceColumn(nextColumn), 7101 + round);
      const scan = scanOf(col, rset);
      for (const [style, skyGated] of cases) {
        const tree = randomSurfaceRules(next, { style, skyGated });
        const c = compileSurfaceRules(seed, tree, noises, rset);
        const ref = createSurfaceReference(seed, tree, noises);
        const fp = c.fastPath;
        if (style === 'nearMiss') expect(fp).toBeNull();
        if (style === 'fastPath') expect(fp).not.toBeNull();
        const slow = fill(c, scan, false), fast = fill(c, scan, true);
        for (let i = 0; i < 98304; i++) {
          if (fast.out[i] !== slow.out[i]) {
            throw new Error(`round ${round} ${style}/${String(skyGated)}: fast path ${fast.out[i]} ≠ full ${slow.out[i]} at p ${i & 255} y ${(i >> 8) - 64}`);
          }
        }
        // compiled == reference on every solid voxel of a sampled set of positions (all of them every 4th tree).
        const step = (round + tally.fastTrees) % 4 === 0 ? 1 : 5;
        for (let p = next() % step; p < 256; p += step) {
          for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
            for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y--) {
              const want = ref.state(scan, rset, p, y);
              if (slow.out[at(p, y)] !== want || c.state(scan, p, y) !== want) {
                throw new Error(`round ${round} ${style}: compiled ${slow.out[at(p, y)]} / ${c.state(scan, p, y)} ≠ reference ${want} at p ${p} y ${y}`);
              }
              tally.refChecked++;
            }
          }
        }
        if (fp === null) {
          tally.offTrees++;
          expect(fast.evaluated).toBe(slow.evaluated);
          continue;
        }
        const v = fastVoxels(fp, scan);
        expect(slow.evaluated).toBe(v.solid);
        // Here-gated leaves (SP6b §3.5 item 4, a free tree's): the classification takes more than the constant bands.
        if (fp.here) expect(fast.evaluated).toBeLessThanOrEqual(v.solid - v.fast);
        else expect(fast.evaluated).toBe(v.solid - v.fast);
        tally.fastTrees++;
        tally.voxels += v.solid;
        tally.fast += v.fast;
        tally.noSkyNearTop += v.noSkyNearTop;
        if (fp.skyGated) tally.gated++; else tally.ungated++;
        if (fp.bands.some((b) => !b.dither && b.state < 0)) tally.bandlandsBands++;
        const leaves = ruleLeaves(c.rules);
        const db = leaves.map((l) => l.conditions.some(isFloor));
        if (db.indexOf(false) >= 0 && db.indexOf(false) < db.indexOf(true)) tally.yBefore++;
        if (db.lastIndexOf(false) > db.lastIndexOf(true)) tally.yAfter++;
      }
    }
    expect(tally.refChecked).toBeGreaterThan(3_000_000);
    expect(tally.offTrees).toBeGreaterThanOrEqual(80);
    expect(tally.fastTrees).toBeGreaterThanOrEqual(120);
    expect(tally.fast / tally.voxels).toBeGreaterThan(0.5);
    expect(tally.noSkyNearTop).toBeGreaterThan(10_000);
    expect(tally.gated).toBeGreaterThan(40);
    expect(tally.ungated).toBeGreaterThan(40);
    expect(tally.yBefore).toBeGreaterThan(30);
    expect(tally.yAfter).toBeGreaterThan(30);
    // Fast-path trees with a band a Y-only bandlands leaf decides (evaluated, state −1).
    expect(tally.bandlandsBands).toBeGreaterThan(10);
  });

  test('caveBiome (SP6b spec §3.2): compiled == reference on every solid voxel of four columns holding every biome, each side', () => {
    const CB = (side: 'floor' | 'ceiling' | 'here', ...biomes: Array<'plain' | 'lush' | 'dripstone' | 'abyss'>): Condition => ({ kind: 'caveBiome', side, biomes });
    const columns = [3, 5, 8, 13].map((k) => withCaveBiomes(randomSurfaceColumn(testRng(k)), k));
    const scans = columns.map((col) => scanOf(col, set));
    // Each column holds every cave biome on the floor side, the ceiling side and at its solid voxels (here).
    for (const [i, scan] of scans.entries()) {
      const floors = new Set<number>(), ceilings = new Set<number>(), here = new Set<number>();
      const col = columns[i]!;
      for (let r = 0; r < scan.runFirst[256]!; r++) { floors.add(scan.runFloorBiome[r]!); ceilings.add(scan.runCeilBiome[r]!); }
      for (let p = 0; p < 256; p++) {
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y -= 3) {
            here.add(caveBiomeHere(col.cave.inputs, col.cave.pass, 16 * col.sample.cx + (p & 15), y, 16 * col.sample.cz + (p >> 4)));
          }
        }
      }
      for (const s of [floors, ceilings, here]) expect([i, [0, 1, 2, 3].every((b) => s.has(b))]).toEqual([i, true]);
    }
    for (const side of ['floor', 'ceiling', 'here'] as const) {
      const trees: Rule[] = [
        SEQ(
          IF(CB(side, 'lush'), B('moss_block')),
          IF(CB(side, 'dripstone', 'abyss'), SEQ(IF(TOP, B('dripstone_block')), B('abyss_stone'))),
          IF(NOT(CB(side, 'plain')), B('clay')),
          IFS([TOP, CB(side, 'abyss', 'plain', 'lush')], B('abyss_ash')),
        ),
        // Under a floor gate (a depth-bounded path: the fast path stays, SP6b's rulings P11).
        SEQ(IFS([floor(1, false), CB(side, 'lush', 'abyss')], B('moss_block')), IFS([TOP, CB(side, 'dripstone')], B('dripstone_block')), IF(grad(0, 8), B('bedrock'))),
      ];
      for (const tree of trees) {
        const c = compileSurfaceRules(SEED, tree, NOISES, set);
        const ref = createSurfaceReference(SEED, tree, NOISES);
        const states = new Set<number>();
        for (const [i, scan] of scans.entries()) {
          const slow = fill(c, scan, false), fast = fill(c, scan, true);
          expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
          for (let p = 0; p < 256; p++) {
            for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
              for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y--) {
                const want = ref.state(scan, set, p, y);
                if (slow.out[at(p, y)] !== want || c.state(scan, p, y) !== want) {
                  throw new Error(`${side} column ${i}: compiled ${slow.out[at(p, y)]} / ${c.state(scan, p, y)} ≠ reference ${want} at p ${p} y ${y}`);
                }
                states.add(want);
              }
            }
          }
        }
        // Every branch yields somewhere, but clay on the here side: a voxel always has a biome there (none, −1, only on
        // the floor and ceiling sides), so not(plain) is left only to biomes the earlier branches took.
        expect([side, states.size]).toEqual([side, tree !== trees[0] ? 4 : side === 'here' ? 5 : 6]);
      }
      // trees[0]'s ungated floor and ceiling leaves are in no class; on the here side its leaves are here-gated (SP6b
      // §3.5 item 4) but for the floor-bounded last one.
      expect(compileSurfaceRules(SEED, trees[0]!, NOISES, set).fastPath?.here ?? null).toBe(side === 'here' ? true : null);
      expect(compileSurfaceRules(SEED, trees[1]!, NOISES, set).fastPath).toMatchObject({ maxSurfaceDepth: 1 });
    }
  });

  test('strata (SP6b spec §3.3): a Y-only strata leaf decides an evaluated band; compiled == reference; y and y + 192 alike; amp 0 ignores the noise', () => {
    const layers = [
      { state: 'abyss_stone', weight: 50, maxLen: 8 }, { state: 'abyss_shale', weight: 25, maxLen: 4 },
      { state: 'cracked_abyss_stone', weight: 15, maxLen: 3 }, { state: 'abyss_stone_veined', weight: 10, maxLen: 1 },
    ];
    const ST = (noise: string, amp: number): StrataRule => ({ kind: 'strata', layers, minLen: 1, maxLen: 6, noise, amp });
    const a = ST('surface.noises.fuzzB', 6);
    const tree = (flat: StrataRule): Rule => SEQ(IFS([SKY, TOP], flat), IF(grad(0, 8), B('bedrock')), IF(yAbove(-40, false), a));
    const t1 = tree(ST('surface.noises.patch', 0)), t2 = tree(ST('surface.noises.fuzzB', 0));
    // The strata leaf is Y-only: the band it decides (8 … 319) has no constant state and is evaluated.
    expect(surfaceFastPath(t1, 11)).toEqual({
      maxSurfaceDepth: 0, skyGated: true, skyFloorBound: 0, floorBound: -1, ceilBound: -1, floorBiomes: -1, ceilBiomes: -1, here: false,
      bands: [band(-63, -41, BEDROCK), band(-40, 0, BEDROCK), dither(1, 7), { yMin: 8, yMax: 319, dither: false, state: -1 }],
    });
    const col = handColumn((p) => 300 + (p % 7));
    const scan = scanOf(col, set);
    const c1 = compileSurfaceRules(SEED, t1, NOISES, set), c2 = compileSurfaceRules(SEED, t2, NOISES, set);
    const ref = createSurfaceReference(SEED, t1, NOISES);
    const slow = fill(c1, scan, false), fast = fill(c1, scan, true);
    expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
    // amp 0 ignores the noise: the top voxels take table[top mod 192] whichever noise the node names.
    expect(Buffer.from(fill(c2, scan, true).out).equals(Buffer.from(slow.out))).toBe(true);
    // k: the node's index among the tree's strata nodes in depth-first order (the top's is 0, a 1).
    const tTop = strataTable(SEED, 0, ST('surface.noises.patch', 0)), ta = strataTable(SEED, 1, a);
    const fuzzB = NOISES('surface.noises.fuzzB')!;
    for (let p = 0; p < 256; p++) {
      const top = 300 + (p % 7);
      const o = strataOffset(fuzzB.z2(16 * col.sample.cx + (p & 15), 16 * col.sample.cz + (p >> 4)), 6, fuzzB.clampSigma);
      expect(slow.out[at(p, top)]).toBe(strataState(tTop, top, 0));
      for (let y = -63; y <= top; y++) {
        const want = ref.state(scan, set, p, y);
        if (slow.out[at(p, y)] !== want || c1.state(scan, p, y) !== want) throw new Error(`p ${p} y ${y}: compiled ${slow.out[at(p, y)]} ≠ reference ${want}`);
        if (y >= 8 && y < top) {
          expect(want).toBe(strataState(ta, y, o));
          if (y + 192 < top) expect(slow.out[at(p, y + 192)]).toBe(want);
        }
      }
    }
  });

  test('strata under caveBiome{here} (SP6b spec §3.3, §3.4): compiled == reference on columns holding every cave biome', () => {
    const st: StrataRule = {
      kind: 'strata', layers: [{ state: 'abyss_stone', weight: 2, maxLen: 3 }, { state: 'abyss_shale', weight: 1, maxLen: 2 }, { state: 'stone', weight: 1, maxLen: 1 }],
      minLen: 1, maxLen: 3, noise: 'surface.noises.patch', amp: 4,
    };
    const tree = SEQ(IFS([TOP, { kind: 'caveBiome', side: 'floor', biomes: ['abyss'] }], B('abyss_ash')), IF({ kind: 'caveBiome', side: 'here', biomes: ['abyss'] }, st));
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    const ref = createSurfaceReference(SEED, tree, NOISES);
    // The strata leaf is here-gated, the ash leaf in the floor class under its caveBiome{floor} gate (SP6b §3.5 3-4).
    expect(c.fastPath).toMatchObject({ floorBound: 0, floorBiomes: 1 << 3, here: true });
    const states = new Set<number>();
    for (const k of [3, 5, 8, 13]) {
      const col = withCaveBiomes(randomSurfaceColumn(testRng(k)), k);
      const scan = scanOf(col, set);
      const slow = fill(c, scan, false);
      expect(Buffer.from(fill(c, scan, true).out).equals(Buffer.from(slow.out))).toBe(true);
      for (let p = 0; p < 256; p++) {
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y--) {
            const want = ref.state(scan, set, p, y);
            if (slow.out[at(p, y)] !== want) throw new Error(`column ${k} p ${p} y ${y}: compiled ${slow.out[at(p, y)]} ≠ reference ${want}`);
            states.add(want);
          }
        }
      }
    }
    expect([...states].map((s) => REGISTRY.stateKey(s)).sort()).toEqual(['abyss_ash', 'abyss_shale', 'abyss_stone', 'stone']);
  });

  test('the biome masks and every condition compile alike for every surface biome', () => {
    // One leaf per surface biome over a column whose positions cycle through all of them.
    const col = handColumn(() => 64);
    for (let p = 0; p < 256; p++) col.biomes[p] = p % SURFACE_BIOMES.length;
    const scan = scanOf(col, set);
    const tree = SEQ(...SURFACE_BIOMES.map((b, i) => IFS([TOP, biome(b)], B(i % 2 === 0 ? 'air' : 'bedrock'))));
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    for (let p = 0; p < 256; p++) {
      expect(c.state(scan, p, 64)).toBe(REGISTRY.parseStateKey((p % SURFACE_BIOMES.length) % 2 === 0 ? 'air' : 'bedrock'));
      expect(c.state(scan, p, 63)).toBe(STONE);
    }
  });
  test('the caveBiome{here} classification (SP6b §3.5 item 4): sound for the picker; the abyss surely abyss under its climate; overlaps mixed', () => {
    const st = SURFACE_FUZZ_CAVE_SETTINGS;
    const J = st.edgeJitter;
    // Soundness: the picker's biome at every voxel lies in its range's mask, over the abyss column and eight columns of
    // every biome (their own boxes, overlapping one time in four, D 16 … 128, J 0 … 4).
    const sound = [abyssColumn(st), abyssColumn({ ...st, lush: { ...st.lush, depthMax: 1.5 } }, (lz) => (lz < 8 ? 0.6 : 0)),
      ...[3, 5, 8, 13, 21, 34, 55, 89].map((k) => withCaveBiomes(randomSurfaceColumn(testRng(k)), k))];
    let picks = 0, single = 0;
    for (const col of sound) {
      const scan = scanOf(col, set);
      const { inputs, pass } = col.cave!;
      for (let p = 0; p < 256; p++) {
        const n = classifyCaveBiomes(scan, p);
        expect(n).toBeGreaterThan(0);
        expect(n).toBeLessThanOrEqual(16);
        expect(scan.caveRangeLow[n - 1]).toBe(-63);
        for (let i = 1; i < n; i++) expect(scan.caveRangeLow[i]!).toBeLessThan(scan.caveRangeLow[i - 1]!);
        const masks = classMasks(scan, p);
        for (let y = -63; y <= 319; y++) {
          const b = caveBiomeOfPass(inputs, pass, 16 * col.sample.cx + (p & 15), y, 16 * col.sample.cz + (p >> 4));
          const m = masks[y + 64]!;
          if (((m >> b) & 1) === 0) throw new Error(`column ${sound.indexOf(col)} p ${p} y ${y}: the picker's ${b} is not in mask ${m}`);
          picks++;
          if ((m & (m - 1)) === 0) single++;
        }
      }
    }
    expect(picks).toBe(10 * 256 * 383);
    expect(single / picks).toBeGreaterThan(0.5);

    // The default boxes over 64 positions of the abyss column: where the abyss's climate test is surely true over the
    // position's (2J + 1)² neighbourhood, every voxel below min Y0 − (128 + J) is surely abyss and none above
    // max Y0 − 128 + J is; nowhere else is any voxel surely abyss.
    const col = abyssColumn(st);
    const scan = scanOf(col, set);
    let sure = 0, unsure = 0;
    for (let p = 0; p < 256; p += 4) {
      const nb = neighbourhood(col.cave.pass, st, p);
      const masks = classMasks(scan, p);
      if (nb.abyssAll) sure++; else unsure++;
      for (let y = -63; y <= 319; y++) {
        const m = masks[y + 64]!;
        if (nb.abyssAll && y < nb.y0Min - (128 + J)) expect([p, y, m]).toEqual([p, y, 8]);
        if (y > nb.y0Max - 128 + J || !nb.abyssAll) expect([p, y, m === 8]).toEqual([p, y, false]);
      }
    }
    expect([sure, unsure].every((n) => n >= 16)).toBe(true);

    // A tree whose bands depend on the cave biome: the abyss's strata and lush's moss_block are here-gated leaves.
    const st4: StrataRule = { kind: 'strata', layers: ABYSS_LAYERS, minLen: 1, maxLen: 6, noise: 'surface.noises.patch', amp: 4 };
    const tree = SEQ(IF(CB('here', 'abyss'), st4), IF(CB('here', 'lush'), B('moss_block')));
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    expect(c.fastPath).toMatchObject({ floorBound: -1, ceilBound: -1, here: true, bands: [{ yMin: -63, yMax: 319, dither: false, state: -1 }] });
    const ref = createSurfaceReference(SEED, tree, NOISES);
    // Evaluated: the voxels whose mask holds biomes with different results (abyss: the strata lookup; lush: moss;
    // plain and dripstone: stone); with lush.depthMax 1.5 and H′ 0.6 at local z < 8, the overlap y range where lush
    // and abyss are both possible is evaluated.
    const result = (b: number) => (b === 3 ? 'A' : b === 1 ? 'L' : 'S');
    const mixed = (m: number) => new Set([0, 1, 2, 3].filter((b) => (m >> b) & 1).map(result)).size > 1;
    const counts: number[] = [];
    for (const [k, c2] of [abyssColumn(st), abyssColumn({ ...st, lush: { ...st.lush, depthMax: 1.5 } }, (lz) => (lz < 8 ? 0.6 : 0))].entries()) {
      const scan2 = scanOf(c2, set);
      const slow = fill(c, scan2, false), fast = fill(c, scan2, true);
      expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
      let want = 0, overlap = 0, abyssRock = 0;
      for (let p = 0; p < 256; p++) {
        const masks = classMasks(scan2, p);
        // Where the abyss's climate test is surely true (and lush's surely false), the mixed voxels are a band across
        // the depth border no thicker than the neighbourhood's Y0 spread plus the jitter.
        const nb = neighbourhood(c2.cave.pass, st, p);
        let mixedHere = 0;
        for (let y = -63; y <= scan2.runTop[scan2.runFirst[p]!]!; y++) {
          const m = masks[y + 64]!;
          if (mixed(m)) { want++; mixedHere++; }
          if ((m & 10) === 10) overlap++;
          if (m === 8) abyssRock++;
          if (p % 16 === k) expect(slow.out[at(p, y)]).toBe(ref.state(scan2, set, p, y));
        }
        if (k === 0 && nb.abyssAll) expect(mixedHere).toBeLessThanOrEqual(Math.ceil(nb.y0Max - nb.y0Min) + 2 * J + 2);
      }
      expect(fast.evaluated).toBe(want);
      counts.push(want, overlap, abyssRock);
    }
    const [evalDefault, overlapDefault, rockDefault, evalOverlap, overlap] = counts;
    // Default boxes: no voxel where lush and abyss are both possible (H′ 0: lush surely false); the rock surely abyss
    // (taken without evaluation) outweighs the evaluated voxels, which lie mostly in the columns of mixed climate. With
    // the overlap, a band of about 64 blocks under half the column.
    expect(overlapDefault).toBe(0);
    expect(rockDefault!).toBeGreaterThan(evalDefault!);
    expect(overlap!).toBeGreaterThan(64 * 40);
    expect(evalOverlap!).toBeGreaterThanOrEqual(evalDefault! + overlap!);
  });

  test("Task 14's ceiling tree with its caveBiome{ceiling} gates back (SP6b §3.5 item 3): output unchanged, only the named runs' ceiling voxels evaluated", () => {
    const CEILING_LEAVES = SEQ(
      IFS([ceil(0, false), CB('ceiling', 'lush'), PATCH(-0.52, 8)], B('moss_block')),
      IFS([ceil(1, false), CB('ceiling', 'dripstone'), NOT(PATCH(-8, -0.97))], B('dripstone_block')),
    );
    const tree = withRule(CEILING_LEAVES);
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    const fp = c.fastPath!;
    expect([fp.skyFloorBound, fp.floorBound, fp.ceilBound, fp.floorBiomes, fp.ceilBiomes, fp.here]).toEqual([15, -1, 1, -1, (1 << 1) | (1 << 2), false]);
    const ref = createSurfaceReference(SEED, tree, NOISES);
    let named = 0, unnamed = 0, ceilingStates = 0;
    for (let k = 0; k < 16; k++) {
      const col = withCaveBiomes(randomSurfaceColumn(testRng(1510 + k)), 1510 + k);
      const scan = scanOf(col, set);
      const slow = fill(c, scan, false), fast = fill(c, scan, true);
      expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
      // Evaluated: the dither intervals, the sky-open run's top 16 and the bottom 2 of the runs whose ceiling biome is
      // lush or dripstone.
      let want = 0;
      for (let p = 0; p < 256; p++) {
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          const top = scan.runTop[r]!, bottom = scan.runBottom[r]!;
          const cb = scan.runCeilBiome[r]!;
          const isNamed = cb === 1 || cb === 2;
          if (isNamed) named++; else unnamed++;
          for (let y = top; y >= bottom; y--) {
            const dithered = (y >= -63 && y <= -60) || (y >= 1 && y <= 7);
            if (dithered || (r === scan.skyRun[p] && top - y <= 15) || (isNamed && y - bottom <= 1)) want++;
            const s = slow.out[at(p, y)]!;
            if (s === REGISTRY.parseStateKey('moss_block') || s === REGISTRY.parseStateKey('dripstone_block')) ceilingStates++;
            if (p % 16 === k) expect(s).toBe(ref.state(scan, set, p, y));
          }
        }
      }
      expect(fast.evaluated).toBe(want);
    }
    expect(named).toBeGreaterThan(500);
    expect(unnamed).toBeGreaterThan(named);
    expect(ceilingStates).toBeGreaterThan(300);
  });

  test('rule 4 over a column holding each cave biome (SP6b §3.4-§3.5): the floor class plus about 3 voxels per biome run end, and the mixed abyss', () => {
    const tree = withRule(RULE4);
    const c = compileSurfaceRules(SEED, tree, NOISES, set);
    const fp = c.fastPath!;
    expect([fp.skyFloorBound, fp.floorBound, fp.ceilBound, fp.floorBiomes, fp.ceilBiomes, fp.here]).toEqual([15, 1, 1, 0b1110, 0b0110, true]);
    // The default's cuts; no band's result is one state for every cave biome (the abyss's is the strata lookup).
    expect(fp.bands).toEqual(compileSurfaceRules(SEED, DEFAULT_SHAPE, NOISES, set).fastPath!.bands.map((b) => ({ ...b, state: -1 })));
    const ref = createSurfaceReference(SEED, tree, NOISES);
    // A column of four quadrants (lush, dripstone, abyss, plain; J 2, D 128), ground −63 … about 170, and two caves per
    // position, 66-70 and 146-150 blocks under the top (depth about 0.6 and 1.2), tagged with the picker's biome.
    const quadrant = (): SurfaceFuzzColumn & { tags: Uint8Array; cave: NonNullable<SurfaceFuzzColumn['cave']> } => {
      const col = handColumn((p) => 168 + (((p & 15) + (p >> 4)) >> 2));
      const { cx, cz } = col.sample;
      const pass = handCavePass(cx, cz, 2, (x, z): CaveFields => {
        const lx = x - 16 * cx, lz = z - 16 * cz;
        const top = 168 + ((Math.min(15, Math.max(0, lx)) + Math.min(15, Math.max(0, lz))) >> 2);
        const f = lz < 8 ? (lx < 8 ? { c: 0, e: 0, h: 0.7 } : { c: 0.85, e: 0, h: 0 }) : lx < 8 ? { c: 0.2, e: -0.8, h: 0 } : { c: 0, e: 0, h: 0 };
        return { ...f, y0: top + 10 + 0.1 * lx };
      });
      const inputs = fuzzCavePicker(SURFACE_FUZZ_CAVE_SETTINGS);
      const tags = new Uint8Array(98304);
      for (let p = 0; p < 256; p++) {
        const top = 168 + (((p & 15) + (p >> 4)) >> 2);
        for (const [a, b] of [[top - 70, top - 66], [top - 150, top - 146]] as const) {
          for (let y = a; y <= b; y++) {
            col.solid[at(p, y)] = 0;
            tags[at(p, y)] = 1 | (caveBiomeOfPass(inputs, pass, 16 * cx + (p & 15), y, 16 * cz + (p >> 4)) << 4);
          }
        }
      }
      return { ...col, tags, cave: { inputs, pass } };
    };
    const columns = [quadrant(), ...[3, 5, 8, 13].map((k) => withCaveBiomes(randomSurfaceColumn(testRng(k)), k))];
    const stats: number[][] = [];
    for (const [k, col] of columns.entries()) {
      const scan = scanOf(col, set);
      const slow = fill(c, scan, false), fast = fill(c, scan, true);
      expect(Buffer.from(fast.out).equals(Buffer.from(slow.out))).toBe(true);
      // Evaluated: the floor classes (the dither intervals, the sky-open run's top 16), the top 2 of each run whose
      // floor biome is lush, dripstone or abyss and the bottom 2 of each whose ceiling biome is lush or dripstone, and
      // beyond those the voxels where the picker may return the abyss or another biome (the strata or the band).
      let want = 0, floorClass = 0, runEnds = 0, mixedAbyss = 0, abyssRock = 0, mixedInside = 0, inside = 0;
      const states = new Set<string>();
      for (let p = 0; p < 256; p++) {
        const masks = classMasks(scan, p);
        const nb = neighbourhood(col.cave.pass, col.cave.inputs.settings, p);
        if (nb.abyssAll) inside++;
        for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
          const top = scan.runTop[r]!, bottom = scan.runBottom[r]!;
          const fb = scan.runFloorBiome[r]!, cb = scan.runCeilBiome[r]!;
          const floorNamed = fb >= 1 && fb <= 3, ceilNamed = cb === 1 || cb === 2;
          runEnds += (floorNamed ? 1 : 0) + (ceilNamed ? 1 : 0);
          for (let y = top; y >= bottom; y--) {
            const m = masks[y + 64]!;
            const dithered = (y >= -63 && y <= -60) || (y >= 1 && y <= 7);
            const skyTop = r === scan.skyRun[p] && top - y <= 15;
            const window = dithered || skyTop || (floorNamed && top - y <= 1) || (ceilNamed && y - bottom <= 1);
            if (dithered || skyTop) floorClass++;
            if (m === 8) abyssRock++;
            if (window) want++;
            else if ((m & 8) !== 0 && m !== 8) {
              want++;
              mixedAbyss++;
              if (nb.abyssAll) mixedInside++;
            }
            states.add(REGISTRY.stateKey(slow.out[at(p, y)]!));
            if (p % 16 === k) expect(slow.out[at(p, y)]).toBe(ref.state(scan, set, p, y));
          }
        }
      }
      expect(fast.evaluated).toBe(want);
      expect(fast.evaluated).toBeLessThanOrEqual(floorClass + 3 * runEnds + mixedAbyss);
      stats.push([fast.evaluated, floorClass, runEnds, mixedAbyss, abyssRock, states.size, mixedInside, inside]);
    }
    // The quadrant column: every rule-4 block occurs; the rock surely abyss is taken without evaluation; the mixed
    // abyss voxels lie within J of the abyss's climate border (§1.5: the here test is evaluated per voxel only there)
    // but for a band across its depth border inside it (the Y0 spread, up to 2.4 blocks, plus 2J: up to 7 voxels a
    // position); the rest is the floor class and 2 voxels per biome run end.
    const [evaluated, floorClass, runEnds, mixedAbyss, abyssRock, kinds, mixedInside, inside] = stats[0]!;
    expect(kinds!).toBeGreaterThanOrEqual(8);
    // Per quadrant position: lush and dripstone name a cave floor and a cave ceiling, the abyss its deep cave's floor.
    expect(runEnds!).toBe(64 * 5);
    // Surely abyss: the 6 × 6 positions whose neighbourhood lies inside the abyss quadrant, about 110 voxels each.
    expect(inside).toBe(36);
    expect(abyssRock!).toBeGreaterThan(36 * 100);
    expect(mixedInside!).toBeLessThanOrEqual(36 * 7);
    expect(mixedAbyss!).toBeGreaterThan(mixedInside!);
    expect(evaluated!).toBeLessThanOrEqual(floorClass! + 3 * runEnds! + mixedAbyss!);
  });
});

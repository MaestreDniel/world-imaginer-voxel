import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { compileSurfaceRules, surfaceFastPath, type CompiledSurfaceRules, type SurfaceFastPath } from '../../src/gen/surface/compile';
import { createSurfaceReference } from '../../src/gen/surface/reference';
import { RuleValidationError, ruleLeaves, type Condition, type Rule, type SurfaceNoiseSource } from '../../src/gen/surface/rules';
import { newSurfaceScan, scanColumn, surfaceScanSettings, type SurfaceScan, type SurfaceScanSettings } from '../../src/gen/surface/scan';
import { AIR, BEDROCK, REGISTRY, STONE } from '../../src/world/blocks/index';
import {
  randomSurfaceColumn, randomSurfaceParams, randomSurfaceRules, SURFACE_FUZZ_PARAMS, surfaceFuzzNoiseSource, surfaceFuzzSettings,
  type SurfaceFuzzColumn, type SurfaceFuzzStyle,
} from '../harness/surfaceFuzz';
import { testRng } from '../harness/stats';

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
  scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes);

function fill(c: CompiledSurfaceRules, scan: SurfaceScan, fast: boolean): { out: Uint16Array; evaluated: number } {
  const out = new Uint16Array(98304).fill(UNTOUCHED);
  return { out, evaluated: c.fillColumn(scan, out, fast) };
}

/** The voxels §3.4 lets take their band: solid, in a constant band, floorDepth > maxSurfaceDepth or (sky-gated) no sky. */
function fastVoxels(fp: SurfaceFastPath, scan: SurfaceScan): { fast: number; noSkyNearTop: number; solid: number } {
  const bandAt = new Int32Array(384).fill(-1);
  for (const b of fp.bands) for (let y = b.yMin; y <= b.yMax; y++) bandAt[y + 64] = b.state;
  let fast = 0, noSkyNearTop = 0, solid = 0;
  for (let p = 0; p < 256; p++) {
    for (let r = scan.runFirst[p]!; r < scan.runFirst[p + 1]!; r++) {
      const sky = r === scan.runFirst[p];
      for (let y = scan.runTop[r]!; y >= scan.runBottom[r]!; y--) {
        solid++;
        const depth = scan.runTop[r]! - y;
        if (bandAt[y + 64]! >= 0 && (depth > fp.maxSurfaceDepth || (fp.skyGated && !sky))) {
          fast++;
          if (!sky && depth <= fp.maxSurfaceDepth) noSkyNearTop++;
        }
      }
    }
  }
  return { fast, noSkyNearTop, solid };
}

describe('surface rule compiler (SP3c spec §3.4)', () => {
  const set = surfaceFuzzSettings(SEED);

  test('compiling validates the tree and binds the settings', () => {
    expect(() => compileSurfaceRules(SEED, { kind: 'block', state: 'not_a_block' }, NOISES, set)).toThrow(RuleValidationError);
    expect(() => compileSurfaceRules(SEED, { kind: 'bandlands' }, NOISES, set)).toThrow(/UNKNOWN_KIND/);
    const c = compileSurfaceRules(SEED, DEFAULT_SHAPE, NOISES, set);
    expect(c.rules).toBe(DEFAULT_SHAPE);
    expect(c.settings).toBe(set);
  });

  test("the default tree's shape: maxSurfaceDepth = SD_MAX + 4, sky-gated, bands −59 … 0 and 8 … 319 (§3.4)", () => {
    expect(set.sdMax).toBe(11);
    expect(compileSurfaceRules(SEED, DEFAULT_SHAPE, NOISES, set).fastPath).toEqual({
      maxSurfaceDepth: 15,
      skyGated: true,
      bands: [dither(-63, -60), band(-59, 0, BEDROCK), dither(1, 7), band(8, 319, STONE)],
    });
    // SD_MAX comes from the live settings: depthMul 0 gives 3, so 7.
    const set0 = surfaceFuzzSettings(SEED, { ...SURFACE_FUZZ_PARAMS, depthMul: 0 });
    expect(set0.sdMax).toBe(3);
    expect(surfaceFastPath(DEFAULT_SHAPE, set0.sdMax)?.maxSurfaceDepth).toBe(7);
  });

  test('leaf classes: any leaf neither depth-bounded nor Y-only turns the fast path off', () => {
    const offPaths: Condition[] = [
      NOT(SKIN), NOT(NOT(SKIN)), { kind: 'stoneDepth', side: 'ceiling', offset: 2, addSurfaceDepth: false }, yAbove(70, true), biome('desert'),
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
    expect(fp(SEQ(), 11)).toEqual({ maxSurfaceDepth: -1, skyGated: true, bands: [band(-63, 319, STONE)] });
    expect(fp(IF(grad(0, 8), B('air')), 11).skyGated).toBe(true);
    // Sky gate: a skyOpen `if` on every depth-bounded path, not under a not; the Y-only leaves need none.
    expect(fp(SEQ(IFS([SKY, TOP], B('air')), IFS([floor(2, false), yAbove(3, true), SKY], B('air')), B('bedrock')), 11).skyGated).toBe(true);
    expect(fp(SEQ(IFS([SKY, TOP], B('air')), IF(floor(2, false), B('air'))), 11).skyGated).toBe(false);
    expect(fp(IFS([NOT(NOT(SKY)), TOP], B('air')), 11).skyGated).toBe(false);
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
      bands: [
        band(-63, -10, AIR), dither(-9, -6), band(-5, 19, STONE), band(20, 99, STONE), band(100, 150, BEDROCK), band(151, 300, BEDROCK),
        dither(301, 319),
      ],
    });
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
    const tally = { refChecked: 0, voxels: 0, fast: 0, noSkyNearTop: 0, fastTrees: 0, offTrees: 0, gated: 0, ungated: 0, yBefore: 0, yAfter: 0 };
    for (let round = 0; round < 40; round++) {
      const seed: Seed64 = [next(), next()];
      const noises = surfaceFuzzNoiseSource(SEED);
      const rset = surfaceFuzzSettings(seed, round % 2 === 0 ? randomSurfaceParams(next) : undefined, noises);
      const col = randomSurfaceColumn(next);
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
        expect(fast.evaluated).toBe(v.solid - v.fast);
        tally.fastTrees++;
        tally.voxels += v.solid;
        tally.fast += v.fast;
        tally.noSkyNearTop += v.noSkyNearTop;
        if (fp.skyGated) tally.gated++; else tally.ungated++;
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
});

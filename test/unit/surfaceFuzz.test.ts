import { describe, expect, test } from 'vitest';
import { SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import {
  CONDITION_KINDS, RULE_KINDS, ruleLeaves, validateRules, type Condition, type Rule, type RuleLeaf,
} from '../../src/gen/surface/rules';
import { newSurfaceScan, scanColumn, type SurfaceScan } from '../../src/gen/surface/scan';
import { compileSurfaceRules } from '../../src/gen/surface/compile';
import { resolveRules } from '../../src/gen/surface/source';
import { validateParamTrees } from '../../src/gen/trees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { CAVE_BIOME_NAMES, caveKindOf, type CaveBiomeName } from '../../src/core/constants';
import { deriveSeed } from '../../src/core/hash';
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef } from '../../src/core/noise/types';
import {
  caveBiomeOfPass, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs,
} from '../../src/gen/biomes/cavePicker';
import type { CaveBiomeSettings } from '../../src/gen/biomes/caveRegistry';
import { buildColumnSample, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { terrainStage } from '../../src/gen/pipeline/terrainStage';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { surfaceProbeColumn } from '../../src/gen/surface/probe';
import { createStore } from '../../src/world/store/store';
import {
  fuzzCavePicker, randomSurfaceColumn, randomSurfaceParams, randomSurfaceRules, SCHEMA_SURFACE_NOISES, SURFACE_FUZZ_BIOMES,
  SURFACE_FUZZ_CAVE_SETTINGS, SURFACE_FUZZ_NOISES, surfaceFuzzNoiseSource, surfaceFuzzSettings, withCaveBiomes, type SurfaceFuzzStyle,
} from '../harness/surfaceFuzz';
import { mutateTree } from '../harness/treeMutator';
import { testFloat, testRng } from '../harness/stats';
import { ctxFor } from '../harness/gen';

const NOISES = surfaceFuzzNoiseSource();
const at = (p: number, y: number): number => 256 * (y + 64) + p;

/** Every rule and condition node with its nesting depth (the root at 1, as validateRules counts). */
function nodes(r: Rule): Array<{ node: Rule | Condition; depth: number }> {
  const out: Array<{ node: Rule | Condition; depth: number }> = [];
  const cond = (c: Condition, d: number) => { out.push({ node: c, depth: d }); if (c.kind === 'not') cond(c.if, d + 1); };
  const rule = (x: Rule, d: number) => {
    out.push({ node: x, depth: d });
    if (x.kind === 'sequence') for (const c of x.rules) rule(c, d + 1);
    else if (x.kind === 'condition') { cond(x.if, d + 1); rule(x.then, d + 1); }
  };
  rule(r, 1);
  return out;
}

/** §3.4's leaf classes, written out here as the generator's contract (the compiler's analysis is compile.ts's). */
const isFloorGate = (c: Condition): boolean => c.kind === 'stoneDepth' && c.side === 'floor';
const isYOnly = (c: Condition): boolean =>
  c.kind === 'verticalGradient' || (c.kind === 'yAbove' && !c.runTop) || (c.kind === 'not' && isYOnly(c.if));
const depthBounded = (l: RuleLeaf): boolean => l.conditions.some(isFloorGate);
/** SP6b spec §3.5 (Spec correction 6): a ceiling `stoneDepth` gate and no floor one. */
const isCeilGate = (c: Condition): boolean => c.kind === 'stoneDepth' && c.side === 'ceiling';
const ceilBounded = (l: RuleLeaf): boolean => !depthBounded(l) && l.conditions.some(isCeilGate);
const yOnlyLeaf = (l: RuleLeaf): boolean => l.conditions.every(isYOnly);
const skyGatedLeaf = (l: RuleLeaf): boolean => l.conditions.some((c) => c.kind === 'skyOpen');

/**
 * A 'fastPath' tree with SP6b §3.5's cave gates (items 3-4): each depth-bounded branch, three times in four, under a
 * `caveBiome{floor}`, a `caveBiome{ceiling}` or both; each other branch, two times in three, under a `caveBiome{here}`
 * or its `not`; one time in two a here-gated `strata` branch (rule 4's shape, with a floor leaf before the strata one
 * time in two) at a random place. Lists of 1-4 distinct cave biomes in any order.
 */
function withCaveGates(next: () => number, tree: Rule): Rule {
  const pick = <T,>(xs: readonly T[]): T => xs[next() % xs.length]!;
  const list = (): CaveBiomeName[] => {
    const pool = [...CAVE_BIOME_NAMES];
    const out: CaveBiomeName[] = [];
    for (let n = 1 + (next() % pool.length); n > 0; n--) out.push(pool.splice(next() % pool.length, 1)[0]!);
    return out;
  };
  const cb = (side: 'floor' | 'ceiling' | 'here'): Condition => ({ kind: 'caveBiome', side, biomes: list() });
  const IF = (c: Condition, then: Rule): Rule => ({ kind: 'condition', if: c, then });
  const strata = (): Rule => ({
    kind: 'strata',
    layers: Array.from({ length: 1 + (next() % 4) }, () => ({
      state: pick(['abyss_stone', 'abyss_shale', 'cracked_abyss_stone', 'abyss_stone_veined', 'stone', 'deepslate', 'clay']),
      weight: 1 + (next() % 50), maxLen: 1 + (next() % 8),
    })),
    minLen: 1 + (next() % 3), maxLen: 4 + (next() % 5), noise: pick(['surface.noises.patch', 'surface.noises.bandOffset']), amp: next() % 13,
  });
  if (tree.kind !== 'sequence') return tree;
  const branches = tree.rules.map((b): Rule => {
    const depth = ruleLeaves(b).some((l) => l.conditions.some((c) => c.kind === 'stoneDepth'));
    if (depth) {
      switch (next() % 4) {
        case 1: return IF(cb('floor'), b);
        case 2: return IF(cb('ceiling'), b);
        case 3: return IF(cb('floor'), IF(cb('ceiling'), b));
        default: return b;
      }
    }
    switch (next() % 3) {
      case 1: return IF(cb('here'), b);
      case 2: return IF({ kind: 'not', if: cb('here') }, b);
      default: return b;
    }
  });
  if (next() % 2 === 0) {
    const leaf = next() % 2 === 0
      ? strata()
      : { kind: 'sequence', rules: [IF({ kind: 'stoneDepth', side: 'floor', offset: 1, addSurfaceDepth: false }, IF(cb('floor'), { kind: 'block', state: 'abyss_ash' })), strata()] } as Rule;
    branches.splice(next() % (branches.length + 1), 0, IF(cb('here'), leaf));
  }
  return { kind: 'sequence', rules: branches };
}

/**
 * Random `caves.biomes` settings over §6.1's ranges, with overlapping boxes: hMin, cMin −0.2 … 0.9; eMax −0.9 … 0.2,
 * the abyss's cMin −0.6 … 0.4; lush and dripstone depthMin 0 … 1 and depthMax up to 2 (one time in 8 below depthMin,
 * the lint's case), the abyss's depthMin 0 … 1.5; D 32 … 256; edgeJitter 0 … 4; the warps from `warp`.
 */
function randomCaveSettings(next: () => number, warp: readonly [number, number]): CaveBiomeSettings {
  const f = (lo: number, hi: number) => lo + (hi - lo) * testFloat(next);
  const range = () => {
    const depthMin = f(0, 1);
    return { depthMin, depthMax: next() % 8 === 0 ? f(0, depthMin) : f(depthMin, 2) };
  };
  return {
    lush: { hMin: f(-0.2, 0.9), ...range() },
    dripstone: { cMin: f(-0.2, 0.9), ...range() },
    abyss: { eMax: f(-0.9, 0.2), cMin: f(-0.6, 0.4), depthMin: f(0, 1.5) },
    depthScale: 32 + (next() % 225),
    borderWarp: warp[0],
    depthWarp: warp[1],
    edgeJitter: next() % 5,
  };
}

/** The warps (borderWarp, depthWarp) the fuzz's settings take: the generated columns' passes are filled once per pair. */
const WARPS: readonly (readonly [number, number])[] = [[0, 0], [0.05, 10], [0.2, 32], [0.1, 3]];
/** Sixteen columns of seed '42' for the generated half of the fuzz (the terrain stage's fixtures and a spread). */
const GENERATED: readonly (readonly [number, number])[] = [
  [-1963, -2000], [-2000, -2000], [-1001, -2000], [-742, -2000], [-1667, -2000], [-1238, -2000], [-1689, -2000], [546, 25857],
  [4, -10], [0, 0], [100, 37], [-300, 412], [1234, -567], [-2500, 1800], [3000, 3000], [-50, -50],
];

describe('surfaceFuzz: random rule trees and hand-built columns (SP3c spec §3.4, §8)', () => {
  const trees = (seed: number, n: number, style: SurfaceFuzzStyle, skyGated?: boolean): Rule[] => {
    const next = testRng(seed);
    return Array.from({ length: n }, () => randomSurfaceRules(next, { style, skyGated }));
  };

  test('the fuzz noises: 2D, remap none, within ±clampSigma, the depth noise among them; the band offset noise for bandlands', () => {
    expect(SURFACE_FUZZ_NOISES).toContain('surface.noises.depth');
    expect(SURFACE_FUZZ_NOISES).not.toContain('surface.noises.bandOffset');
    for (const id of [...SURFACE_FUZZ_NOISES, 'surface.noises.bandOffset']) {
      const n = NOISES(id)!;
      expect(n).toMatchObject({ dims: 2, remap: 'none' });
      const v = n.z2(13, -7);
      expect(Math.abs(v)).toBeLessThanOrEqual(n.clampSigma);
      expect(v).not.toBe(n.z2(29, -7));
    }
    expect(surfaceFuzzSettings().sdMax).toBe(11);
    const next = testRng(5);
    for (let i = 0; i < 200; i++) {
      const p = randomSurfaceParams(next);
      expect(p.depthMul).toBeGreaterThanOrEqual(0);
      expect(p.depthMul).toBeLessThanOrEqual(2);
      expect(p.lapse).toBeGreaterThanOrEqual(0);
      expect(p.lapse).toBeLessThanOrEqual(0.05);
      expect(Number.isInteger(p.lapseBase) && p.lapseBase >= -64 && p.lapseBase <= 319).toBe(true);
    }
  });

  test('every tree of every style validates, is reproducible from its seed and stays well inside the depth bound', () => {
    for (const style of ['free', 'fastPath', 'nearMiss'] as const) {
      const a = trees(21, 300, style), b = trees(21, 300, style);
      for (let i = 0; i < a.length; i++) {
        expect(validateRules(a[i], NOISES)).toEqual([]);
        expect(JSON.stringify(a[i])).toBe(JSON.stringify(b[i]));
        expect(JSON.stringify(a[i])).not.toContain('-0,');
        const depth = Math.max(...nodes(a[i]!).map((n) => n.depth));
        expect(depth).toBeLessThanOrEqual(style === 'free' ? 7 : 16);
      }
      expect(new Set(a.map((t) => JSON.stringify(t))).size).toBeGreaterThan(240);
    }
    const deep = randomSurfaceRules(testRng(22), { maxDepth: 24 });
    expect(validateRules(deep, NOISES)).toEqual([]);
    expect(() => randomSurfaceRules(testRng(22), { maxDepth: 2 })).toThrow(RangeError);
  });

  test('free trees use every rule kind, every condition kind and both values of every boolean field', () => {
    const kinds = new Set<string>();
    const flags = new Set<string>();
    const blocks = new Set<string>();
    let gradientNoBand = 0, emptySeq = 0, equalRange = 0, bandlands = 0, leaves = 0;
    for (const t of trees(23, 400, 'free')) {
      for (const { node } of nodes(t)) {
        kinds.add(node.kind);
        if (node.kind === 'stoneDepth') flags.add(`${node.side}.${node.addSurfaceDepth}`);
        if (node.kind === 'water' || node.kind === 'yAbove') flags.add(`${node.kind}.${node.runTop}`);
        if (node.kind === 'block') blocks.add(node.state);
        if (node.kind === 'block' || node.kind === 'bandlands') leaves++;
        if (node.kind === 'bandlands') bandlands++;
        if (node.kind === 'verticalGradient' && node.falseAtAndAbove === node.trueAtAndBelow + 1) gradientNoBand++;
        if (node.kind === 'sequence' && node.rules.length === 0) emptySeq++;
        if (node.kind === 'noiseThreshold' && node.min === node.max) equalRange++;
      }
    }
    expect([...kinds].sort()).toEqual([...RULE_KINDS, ...CONDITION_KINDS].sort());
    expect([...flags].sort()).toEqual([
      'ceiling.false', 'ceiling.true', 'floor.false', 'floor.true', 'water.false', 'water.true', 'yAbove.false', 'yAbove.true',
    ]);
    expect(blocks.has('air')).toBe(false);
    expect(blocks.size).toBeGreaterThanOrEqual(2);
    expect(gradientNoBand).toBeGreaterThan(0);
    expect(emptySeq).toBeGreaterThan(0);
    expect(equalRange).toBeGreaterThan(0);
    // One leaf in 8 is a bandlands.
    expect(Math.abs(bandlands / leaves - 1 / 8)).toBeLessThan(0.03);
  });

  test('fastPath trees: every leaf depth-bounded or Y-only; Y-only leaves before and after depth-bounded ones; bandlands in both classes', () => {
    let before = 0, after = 0, gated = 0, ungated = 0, yOnPath = 0, yBandlands = 0, dbBandlands = 0;
    for (const skyGated of [true, false, undefined]) {
      for (const t of trees(24, 300, 'fastPath', skyGated)) {
        const leaves = ruleLeaves(t);
        expect(leaves.every((l) => depthBounded(l) || yOnlyLeaf(l))).toBe(true);
        const db = leaves.filter(depthBounded);
        expect(db.length).toBeGreaterThan(0);
        const allSky = db.every(skyGatedLeaf);
        if (skyGated === true) expect(allSky).toBe(true);
        if (skyGated === false) expect(db.some(skyGatedLeaf)).toBe(false);
        if (allSky) gated++; else ungated++;
        const firstDb = leaves.findIndex(depthBounded);
        const lastDb = leaves.length - 1 - [...leaves].reverse().findIndex(depthBounded);
        if (leaves.slice(0, firstDb).some((l) => !depthBounded(l))) before++;
        if (leaves.slice(lastDb + 1).some((l) => !depthBounded(l))) after++;
        if (db.some((l) => l.conditions.some((c) => c.kind === 'yAbove' || c.kind === 'verticalGradient'))) yOnPath++;
        if (leaves.some((l) => l.rule.kind === 'bandlands' && !depthBounded(l))) yBandlands++;
        if (db.some((l) => l.rule.kind === 'bandlands')) dbBandlands++;
      }
    }
    expect(before).toBeGreaterThan(100);
    expect(after).toBeGreaterThan(100);
    expect(gated).toBeGreaterThan(300);
    expect(ungated).toBeGreaterThan(300);
    expect(yOnPath).toBeGreaterThan(100);
    expect(yBandlands).toBeGreaterThan(50);
    expect(dbBandlands).toBeGreaterThan(50);
  });

  test('caveBiome (SP6b spec §3.2): every side, lists of 1-4 distinct cave biomes, every length and every name, in fastPath trees too', () => {
    const sides = new Set<string>(), lengths = new Set<number>(), names = new Set<string>(), firsts = new Set<string>();
    let inFastPath = 0;
    for (const style of ['free', 'fastPath'] as const) {
      for (const t of trees(28, 400, style)) {
        for (const { node } of nodes(t)) {
          if (node.kind !== 'caveBiome') continue;
          if (style === 'fastPath') inFastPath++;
          sides.add(node.side);
          lengths.add(node.biomes.length);
          firsts.add(node.biomes[0]!);
          for (const b of node.biomes) names.add(b);
          expect(new Set(node.biomes).size).toBe(node.biomes.length);
        }
      }
    }
    expect([...sides].sort()).toEqual(['ceiling', 'floor', 'here']);
    expect([...lengths].sort()).toEqual([1, 2, 3, 4]);
    expect([...names].sort()).toEqual([...CAVE_BIOME_NAMES].sort());
    expect([...firsts].sort()).toEqual([...CAVE_BIOME_NAMES].sort());
    expect(inFastPath).toBeGreaterThan(50);
  });

  test('withCaveBiomes: reproducible from its seed, the column untouched; tags only in air; every biome on each side and in the rock', () => {
    const base = randomSurfaceColumn(testRng(29));
    const a = withCaveBiomes(base, 4), b = withCaveBiomes(randomSurfaceColumn(testRng(29)), 4);
    expect(Buffer.from(a.tags).equals(Buffer.from(b.tags))).toBe(true);
    expect(Array.from(a.cave.pass.y0)).toEqual(Array.from(b.cave.pass.y0));
    expect(a.cave.inputs.settings).toEqual(b.cave.inputs.settings);
    const fresh = randomSurfaceColumn(testRng(29));
    expect([a.solid, a.water, a.biomes, a.sample]).toEqual([fresh.solid, fresh.water, fresh.biomes, fresh.sample]);
    expect(Buffer.from(withCaveBiomes(base, 5).tags).equals(Buffer.from(a.tags))).toBe(false);

    const set = surfaceFuzzSettings();
    const scan = newSurfaceScan();
    const floors = new Set<number>(), ceilings = new Set<number>(), rock = new Set<number>(), jitters = new Set<number>();
    let pickerNibbles = 0, otherNibbles = 0, untaggedNibbles = 0, overlaps = 0;
    const next = testRng(30);
    for (let k = 0; k < 40; k++) {
      const col = withCaveBiomes(randomSurfaceColumn(next), 300 + k);
      const { inputs, pass } = col.cave;
      jitters.add(pass.j);
      if (inputs.settings.lush.depthMax > 0.9) overlaps++;
      expect([pass.cx, pass.cz]).toEqual([col.sample.cx, col.sample.cz]);
      for (let i = 0; i < 98304; i++) {
        const t = col.tags[i]!;
        if (t === 0) continue;
        expect(col.solid[i]).toBe(0);
        const p = i & 255, y = (i >> 8) - 64;
        if ((t & 15) === 0) { untaggedNibbles++; continue; }
        if (t >> 4 === caveBiomeOfPass(inputs, pass, 16 * col.sample.cx + (p & 15), y, 16 * col.sample.cz + (p >> 4))) pickerNibbles++;
        else otherNibbles++;
      }
      scanColumn(scan, set, col.sample, col.solid, col.water, col.biomes, col.tags, col.cave);
      for (let r = 0; r < scan.runFirst[256]!; r++) { floors.add(scan.runFloorBiome[r]!); ceilings.add(scan.runCeilBiome[r]!); }
      for (let p = 0; p < 256; p += 5) {
        for (let y = -63; y <= 319; y += 2) {
          if (col.solid[at(p, y)] !== 0) rock.add(caveBiomeOfPass(inputs, pass, 16 * col.sample.cx + (p & 15), y, 16 * col.sample.cz + (p >> 4)));
        }
      }
    }
    for (const s of [floors, ceilings]) expect([...s].sort()).toEqual([-1, 0, 1, 2, 3]);
    expect([...rock].sort()).toEqual([0, 1, 2, 3]);
    expect([...jitters].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(overlaps).toBeGreaterThan(3);
    expect(pickerNibbles).toBeGreaterThan(otherNibbles);
    expect(otherNibbles).toBeGreaterThan(1000);
    expect(untaggedNibbles).toBeGreaterThan(100);
  });

  test('nearMiss trees: at least one leaf is in no class: neither depth-bounded, ceiling-bounded nor Y-only', () => {
    for (const t of trees(25, 300, 'nearMiss')) {
      const leaves = ruleLeaves(t);
      expect(leaves.some((l) => !depthBounded(l) && !ceilBounded(l) && !yOnlyLeaf(l))).toBe(true);
    }
  });

  test('the fast path equals full evaluation (SP6b spec §3.5, D20 1-2): 300 treeMutator trees with ceiling gates, over 32 columns', () => {
    // 'fastPath' trees whose depth-bounded branches are ceiling-gated one time in 2, on the schema's noises, each mutated
    // once by a preserving mutation (a literal, a sibling swap, a ref, a wrap, a def) and accepted as a surface.rules value.
    const next = testRng(1407);
    const columns = Array.from({ length: 32 }, (_, k) => withCaveBiomes(randomSurfaceColumn(testRng(1408 + k)), 1408 + k));
    const set = surfaceFuzzSettings([14, 7]);
    const scans: SurfaceScan[] = columns.map((col) => scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes, col.tags, col.cave));
    const fast = new Uint16Array(98304), full = new Uint16Array(98304);
    let trees = 0, ceilTrees = 0, floorCeilLeaves = 0, voxels = 0, fastEvaluated = 0;
    for (let i = 0; trees < 300; i++) {
      expect(i, 'too few accepted trees').toBeLessThan(3000);
      const base = randomSurfaceRules(next, { style: 'fastPath', ceilingGates: true, noises: SCHEMA_SURFACE_NOISES });
      const m = mutateTree(next, base, 'surfaceRules', { cls: 'preserving' });
      const r = applyPatch(SCHEMA, DEFAULTS, { surface: { rules: m.value } });
      if (!r.ok || validateParamTrees(r.value).length > 0) continue;
      const rules = resolveRules(r.value.surface.rules, r.value);
      const leaves = ruleLeaves(rules);
      if (!leaves.some(ceilBounded)) continue;
      trees++;
      floorCeilLeaves += leaves.filter((l) => depthBounded(l) && l.conditions.some(isCeilGate)).length;
      const c = compileSurfaceRules([14, 7], rules, NOISES, set);
      if (c.fastPath !== null && c.fastPath.ceilBound >= 0) ceilTrees++;
      for (let k = 0; k < 32; k++) {
        fast.fill(0);
        full.fill(0);
        fastEvaluated += c.fillColumn(scans[k]!, fast, true);
        voxels += c.fillColumn(scans[k]!, full, false);
        if (!Buffer.from(fast.buffer).equals(Buffer.from(full.buffer))) expect([i, k, Array.from(fast)]).toEqual([i, k, Array.from(full)]);
      }
    }
    // Most trees keep a fast path with a ceiling class; some leaves hold both gates (floor-bounded only, Spec correction 6);
    // the fast fills evaluate a minority of the solid voxels.
    expect(ceilTrees).toBeGreaterThan(250);
    expect(floorCeilLeaves).toBeGreaterThan(10);
    expect(voxels).toBeGreaterThan(200_000_000);
    expect(fastEvaluated).toBeLessThan(voxels / 2);
  }, 120_000);

  test('the fast path equals full evaluation over caveBiome and strata trees and random cave-biome settings (§3.5)', () => {
    // 16 hand-built columns whose tags hold every biome (withCaveBiomes: the picker's nibble half the time) and 16
    // generated by the terrain stage (seed '42'), their tagged voxels given the picker's nibble on the default boxes
    // with the real border and depth noises, as T will write it.
    const ctx = ctxFor('42');
    const sc = surfaceContextOf(ctx);
    const set = surfaceFuzzSettings([15, 1]);
    const noise = (name: string, wavelength: number) => new NormalNoise(ctx.seed, name, completeNoiseDef({ wavelength, octaves: 2 }));
    const real = {
      borderC: noise('caveBiome.C', 64), borderE: noise('caveBiome.E', 64), borderH: noise('caveBiome.H', 64),
      depth: noise('caves.biomes.noises.depth', 96), jitterSeed: deriveSeed(ctx.seed, 'caveBiome.jitter'),
    };
    const store = createStore({ shared: false, maxBlockBytes: 64 << 20, maxByteBytes: 64 << 20 });
    const generated: Array<{ scan: SurfaceScan; sample: ColumnSample; passes: CaveColumnPass[] }> = [];
    let taggedVoxels = 0;
    const nibbles = new Set<number>();
    for (const [cx, cz] of GENERATED) {
      const w = store.claimColumn(cx, cz, 0);
      expect(terrainStage(ctx, cx, cz, w, () => false)).toBe(true);
      w.commit(1);
      const view = store.proto(cx, cz)!;
      const col = surfaceProbeColumn(sc, cx, cz);
      const sample = buildColumnSample(ctx, cx, cz, newColumnSample());
      // One pass per warp pair, filled at J 4 (its j set per tree: the positions within a smaller J hold the same values).
      const passes = WARPS.map(([borderWarp, depthWarp]) =>
        fillCaveColumnPass({ ...real, settings: { ...SURFACE_FUZZ_CAVE_SETTINGS, borderWarp, depthWarp, edgeJitter: 4 } }, sample, newCaveColumnPass()));
      const inputs: CavePickerInputs = { ...real, settings: SURFACE_FUZZ_CAVE_SETTINGS };
      const pass = fillCaveColumnPass(inputs, sample, newCaveColumnPass());
      const tags = new Uint8Array(98304);
      for (let i = 256; i < 98304; i++) {
        const p = i & 255, y = (i >> 8) - 64;
        const kind = caveKindOf(view.cave(p & 15, y, p >> 4));
        if (kind === 0) continue;
        const b = caveBiomeOfPass(inputs, pass, 16 * cx + (p & 15), y, 16 * cz + (p >> 4));
        tags[i] = kind | (b << 4);
        taggedVoxels++;
        nibbles.add(b);
      }
      const scan = scanColumn(newSurfaceScan(), set, sample, col.solid.slice(), col.water.slice(), col.biomes.slice(), tags, { inputs, pass });
      generated.push({ scan, sample, passes });
    }
    expect(taggedVoxels).toBeGreaterThan(16 * 1000);
    expect(nibbles.size).toBeGreaterThanOrEqual(2);
    const hand = Array.from({ length: 16 }, (_, k) => withCaveBiomes(randomSurfaceColumn(testRng(1501 + k)), 1501 + k));
    const handScans = hand.map((col) => scanColumn(newSurfaceScan(), set, col.sample, col.solid, col.water, col.biomes, col.tags, col.cave));

    const next = testRng(1500);
    const fast = new Uint16Array(98304), full = new Uint16Array(98304);
    const tally = { trees: 0, fastTrees: 0, here: 0, floorSkip: 0, ceilSkip: 0, voxels: 0, fastEvaluated: 0 };
    for (let i = 0; tally.trees < 300; i++) {
      expect(i, 'too few accepted trees').toBeLessThan(3000);
      const base = withCaveGates(next, randomSurfaceRules(next, { style: 'fastPath', ceilingGates: true, noises: SCHEMA_SURFACE_NOISES }));
      const m = mutateTree(next, base, 'surfaceRules', { cls: 'preserving' });
      const r = applyPatch(SCHEMA, DEFAULTS, { surface: { rules: m.value } });
      if (!r.ok || validateParamTrees(r.value).length > 0) continue;
      const rules = resolveRules(r.value.surface.rules, r.value);
      tally.trees++;
      const c = compileSurfaceRules([15, 1], rules, NOISES, set);
      const fp = c.fastPath;
      if (fp !== null) {
        tally.fastTrees++;
        if (fp.here) tally.here++;
        if (fp.floorBiomes >= 0 && fp.floorBound >= 0) tally.floorSkip++;
        if (fp.ceilBiomes >= 0 && fp.ceilBound >= 0) tally.ceilSkip++;
      }
      // This tree's cave-biome settings: the generated columns' pass for its warps, the hand-built columns' own pass
      // (hand-filled fields), both read with its jitter.
      const wi = next() % WARPS.length;
      const st = randomCaveSettings(next, WARPS[wi]!);
      const scans: SurfaceScan[] = [];
      for (const g of generated) {
        const pass = g.passes[wi]!;
        pass.j = st.edgeJitter;
        g.scan.cavePicker = { ...real, settings: st };
        g.scan.cavePass = pass;
        scans.push(g.scan);
      }
      for (const [k, scan] of handScans.entries()) {
        const pass = hand[k]!.cave.pass;
        pass.j = st.edgeJitter;
        scan.cavePicker = fuzzCavePicker(st, hand[k]!.cave.inputs.jitterSeed);
        scan.cavePass = pass;
        scans.push(scan);
      }
      for (const [k, scan] of scans.entries()) {
        fast.fill(0);
        full.fill(0);
        tally.fastEvaluated += c.fillColumn(scan, fast, true);
        tally.voxels += c.fillColumn(scan, full, false);
        if (!Buffer.from(fast.buffer).equals(Buffer.from(full.buffer))) expect([i, k, Array.from(fast)]).toEqual([i, k, Array.from(full)]);
      }
    }
    // Most trees keep a fast path; many have here-gated leaves (item 4) or a biome-gated floor or ceiling class
    // (item 3); the fast fills evaluate a minority of the solid voxels.
    expect(tally.fastTrees).toBeGreaterThan(250);
    expect(tally.here).toBeGreaterThan(100);
    expect(tally.floorSkip).toBeGreaterThan(30);
    expect(tally.ceilSkip).toBeGreaterThan(30);
    expect(tally.voxels).toBeGreaterThan(200_000_000);
    expect(tally.fastEvaluated).toBeLessThan(tally.voxels / 2);
  }, 360_000);

  test('columns: reproducible; overhangs, caves, water above / over a gap / in two segments, empty positions, every regime', () => {
    const a = randomSurfaceColumn(testRng(26)), b = randomSurfaceColumn(testRng(26));
    expect(Buffer.from(a.solid).equals(Buffer.from(b.solid))).toBe(true);
    expect(Buffer.from(a.water).equals(Buffer.from(b.water))).toBe(true);
    expect(Array.from(a.biomes)).toEqual(Array.from(b.biomes));
    expect([a.sample.cx, a.sample.cz]).toEqual([b.sample.cx, b.sample.cz]);

    const next = testRng(27);
    const set = surfaceFuzzSettings();
    const scan = newSurfaceScan();
    const stats = { multiRun: 0, noSkyNearTop: 0, noSkyWater: 0, waterAbove: 0, waterGap: 0, twoSegments: 0, empty: 0, below0: 0, dither: 0, top319: 0, lake: 0, dry: 0 };
    const biomes = new Set<number>();
    const tops = new Set<number>();
    for (let k = 0; k < 120; k++) {
      const col = randomSurfaceColumn(next);
      expect(col.sample.cx).toBeGreaterThanOrEqual(-32768);
      expect(col.sample.cx).toBeLessThan(32768);
      for (let p = 0; p < 256; p++) expect(col.solid[at(p, -64)]).toBe(1);
      scanColumn(scan, set, col.sample, col.solid, col.water, col.biomes);
      for (let p = 0; p < 256; p++) {
        biomes.add(col.biomes[p]!);
        const r0 = scan.runFirst[p]!, r1 = scan.runFirst[p + 1]!;
        if (r1 === r0) { stats.empty++; continue; }
        if (r1 - r0 > 1) stats.multiRun++;
        for (let r = r0 + 1; r < r1; r++) {
          if (scan.runTop[r]! >= scan.runTop[r0]! - 30) stats.noSkyNearTop++;
          if (scan.runWaterAbove[r]) stats.noSkyWater++;
        }
        const top = scan.runTop[r0]!;
        tops.add(top);
        if (scan.runWaterAbove[r0]) {
          stats.waterAbove++;
          let w = top + 1;
          while (w < 319 && col.solid[at(p, w + 1)] === 0 && col.water[at(p, w + 1)] !== 0) w++;
          if (w < 319 && col.water[at(p, w + 2)] !== 0 && col.solid[at(p, w + 1)] === 0) stats.twoSegments++;
        } else if (top < 318 && col.water[at(p, top + 2)] !== 0) {
          stats.waterGap++;
        }
        if (top < 0) stats.below0++;
        if (top >= 1 && top <= 7) stats.dither++;
        if (top === 319) stats.top319++;
        if (Number.isFinite(scan.lakeLevel[p]!)) stats.lake++; else stats.dry++;
      }
    }
    for (const [k, v] of Object.entries(stats)) expect([k, v > 20]).toEqual([k, true]);
    expect([...biomes].sort((x, y) => x - y)).toEqual(SURFACE_FUZZ_BIOMES.map((n) => SURFACE_BIOMES.indexOf(n)).sort((x, y) => x - y));
    expect(Math.min(...tops)).toBe(-63);
    expect(Math.max(...tops)).toBe(319);
  });
});

import { describe, expect, test } from 'vitest';
import { SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import {
  CONDITION_KINDS, RULE_KINDS, ruleLeaves, validateRules, type Condition, type Rule, type RuleLeaf,
} from '../../src/gen/surface/rules';
import { newSurfaceScan, scanColumn } from '../../src/gen/surface/scan';
import {
  randomSurfaceColumn, randomSurfaceParams, randomSurfaceRules, SURFACE_FUZZ_BIOMES, SURFACE_FUZZ_NOISES, surfaceFuzzNoiseSource,
  surfaceFuzzSettings, type SurfaceFuzzStyle,
} from '../harness/surfaceFuzz';
import { testRng } from '../harness/stats';

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
const yOnlyLeaf = (l: RuleLeaf): boolean => l.conditions.every(isYOnly);
const skyGatedLeaf = (l: RuleLeaf): boolean => l.conditions.some((c) => c.kind === 'skyOpen');

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

  test('nearMiss trees: at least one leaf is neither depth-bounded nor Y-only', () => {
    for (const t of trees(25, 300, 'nearMiss')) {
      const leaves = ruleLeaves(t);
      expect(leaves.some((l) => !depthBounded(l) && !yOnlyLeaf(l))).toBe(true);
    }
  });

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

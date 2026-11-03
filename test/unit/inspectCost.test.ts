import { describe, expect, test } from 'vitest';
import { DENSITY_COLUMN_COST_MAX, RULES_COLUMN_COST_MAX } from '../../src/core/constants';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE } from '../../src/core/params/presetTrees';
import { countTreeNodes } from '../../src/core/params/json';
import type { Params } from '../../src/core/params/schema';
import { EXPR_CHILD_KEYS, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { resolveDensity } from '../../src/gen/density/source';
import { densityColumnCost, rulesColumnCost, structuralCost, workCost } from '../../src/gen/inspect/cost';
import { surfaceFastPath } from '../../src/gen/surface/compile';
import type { Rule } from '../../src/gen/surface/rules';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { legacyDefaultDensityExpr, legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { paramsWith } from '../harness/gen';
import { sp5cTrees } from '../harness/sp5cTrees';
import { testRng } from '../harness/stats';
import { randomSurfaceRules, withRegisteredBlocks } from '../harness/surfaceFuzz';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A mutable deep copy of a JSON value. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The object at a dotted path with `[i]` items (`root.a.a.a.x.a`, `rules[2].if`). */
function at(v: unknown, path: string): Rec {
  let x: unknown = v;
  for (const part of path.split('.')) {
    const m = /^(\w+)((?:\[\d+\])*)$/.exec(part)!;
    x = (x as Rec)[m[1]!];
    for (const i of m[2]!.matchAll(/\[(\d+)\]/g)) x = (x as unknown[])[Number(i[1])];
  }
  if (!isRec(x)) throw new Error(`no object at ${path}`);
  return x;
}
const src = DEFAULT_DENSITY_TREE as unknown as { root: unknown; defs: unknown };

/** The SP3c static maximum of SD_MAX: ⌊3.25 + 2.75 · 2 · 8⌋ (depthMul ≤ 2, clampSigma ≤ 8). */
const SD_MAX_STATIC = 47;
const VOXELS = 98304;
const CORNERS = 1225;

/** Recursive oracles of the three density costs (small trees only): §1.7 and §5.2 as written. */
function oracle(e: unknown, defs: Readonly<Record<string, unknown>>, mode: 'structural' | 'column' | { params: Params }, corner = false): number {
  const n = e as Rec;
  const op = n['op'] as string;
  if (op === 'ref') return oracle(defs[n['name'] as string], defs, mode, corner);
  const keys = op === 'recip' ? ['x'] : op === 'param' ? [] : EXPR_CHILD_KEYS[op as Expr['op']];
  const muted = mode === 'column' && op === 'tap' && Object.hasOwn(n, 'mute');
  const inner = corner || op === 'interpolated';
  if (mode === 'column') {
    const own = (op === 'noise' || op === 'noise2' || op === 'noiseScaled' ? 128 : 1) * (corner ? CORNERS : VOXELS);
    if (muted) return own + (inner ? CORNERS : VOXELS);
    return own + keys.reduce((s, k) => s + oracle(n[k], defs, mode, inner), 0);
  }
  let own = 1;
  if (typeof mode === 'object' && (op === 'noise' || op === 'noise2' || op === 'noiseScaled')) {
    const d = (mode.params.density.noises as Readonly<Record<string, { octaves: number; double: boolean }>>)[n['id'] as string]!;
    own = 4 * d.octaves * (d.double ? 2 : 1);
  }
  const kids = keys.reduce((s, k) => s + oracle(n[k], defs, mode, inner), 0);
  return own + (op === 'interpolated' ? 8 : 1) * kids;
}

describe('structural and work costs (SP3d spec §1.7, §5.2)', () => {
  test('the default root costs 2,522 as source and 2,455 resolved (SP6a: the SP5c tree\'s 333 and the legacy-built 322, plus the cave terms)', () => {
    // SP6a §1.1: the body moved into defs.body (a ref costs its def), the root gained the precave tap, two mins and two
    // slots (338 and 327 before the cave terms), and the cave terms (Task 6): E, C, keep with defs.pillars, detailG.
    expect(structuralCost(src.root, src.defs)).toBe(2522);
    const resolved = resolveDensity(DEFAULT_DENSITY_TREE, DEFAULTS);
    expect(structuralCost(resolved.root, resolved.defs)).toBe(2455);
    const legacy = legacyDefaultDensityExpr(DEFAULTS.density);
    expect(structuralCost(legacy.root, legacy.defs)).toBe(322);
    const sp5c = sp5cTrees().default as { root: unknown; defs: unknown };
    expect(structuralCost(sp5c.root, sp5c.defs)).toBe(333);
  });

  test('the default work cost is 4,366 at DEFAULTS: 2,455 units, 209 of them noises (the body\'s jag and overhang at 5 corner reads)', () => {
    const resolved = resolveDensity(DEFAULT_DENSITY_TREE, DEFAULTS);
    expect(workCost(resolved, DEFAULTS)).toBe(4366);
    // SP5c's 574: 327 units, 17 of them noises (8 jag, 8 overhang corners, 1 detail).
    expect(327 - 17 + 8 * 16 + 8 * 16 + 8).toBe(574);
    // SP6a: `ref body` is read at the corners by the terrain tap, detailG, cheese's sky, roof and ramp (5 × 8 jag and
    // overhang corners); the cave noises at their corners: entrance (12), roughnessMod, roughness, entranceA, entranceB,
    // layer (4 each), cheese (32), cheeseRegional (8), 8 each; pillar and pillarRare 16, pillarThickness 32 (4 each).
    const noiseUnits = 40 * 16 + 40 * 16 + 8 + 8 * 12 + 5 * 8 * 4 + 8 * 32 + 8 * 8 + 16 * 4 + 16 * 4 + 32 * 4;
    expect(2455 - 209 + noiseUnits).toBe(4366);
    // The legacy-built tree (SP5c's values without the root's slots) stays at 569.
    expect(workCost(legacyDefaultDensityExpr(DEFAULTS.density), DEFAULTS)).toBe(569);
    // The configured leaf: 3 octaves of a single-stack jag weigh 12 each.
    const p = paramsWith({ density: { noises: { jag: { octaves: 3, double: false } } } });
    expect(workCost(resolveDensity(DEFAULT_DENSITY_TREE, p), p)).toBe(4366 - 40 * 16 + 40 * 12);
  });

  test('a ref costs its def; interpolated 1 + 8 × child; a muted tap counts its child; mutes ignored', () => {
    const y = { op: 'y' };
    const defs = { d: { op: 'add', a: y, b: y } };
    expect(structuralCost({ op: 'ref', name: 'd' }, defs)).toBe(3);
    expect(structuralCost({ op: 'neg', x: { op: 'ref', name: 'd' } }, defs)).toBe(4);
    expect(structuralCost({ op: 'interpolated', x: { op: 'ref', name: 'd' } }, defs)).toBe(1 + 8 * 3);
    expect(structuralCost({ op: 'tap', name: 't', mute: 0, x: { op: 'ref', name: 'd' } }, defs)).toBe(4);
    expect(structuralCost({ op: 'recip', x: { op: 'param', path: 'density.noises.jag.clampSigma' } })).toBe(2);
    expect(workCost({ root: { op: 'mul', a: { op: 'noise', id: 'detail' }, b: { op: 'noise2', id: 'jag' } }, defs: {} }, DEFAULTS)).toBe(1 + 8 + 16);
    // A noise the params do not hold weighs the static maximum, 4 × 16 × 2.
    expect(workCost({ root: { op: 'noise', id: 'nope' }, defs: {} }, DEFAULTS)).toBe(128);
  });

  test('a caves.noises noise (SP6a spec §1.5) weighs 4 · octaves · (double ? 2 : 1) of its configured leaf, as a density noise', () => {
    const n = DEFAULTS.caves.noises;
    expect(workCost({ root: { op: 'noise', id: 'cheese' }, defs: {} }, DEFAULTS)).toBe(4 * 4 * 2);
    expect(workCost({ root: { op: 'noise', id: 'entrance' }, defs: {} }, DEFAULTS)).toBe(4 * 3);
    expect(workCost({ root: { op: 'noise2', id: 'cheeseRegional' }, defs: {} }, DEFAULTS)).toBe(4 * 2);
    expect(workCost({ root: { op: 'noiseScaled', id: 'layer', s: 2 }, defs: {} }, DEFAULTS)).toBe(4);
    for (const id of Object.keys(n) as (keyof typeof n)[]) {
      expect(workCost({ root: { op: 'noise', id }, defs: {} }, DEFAULTS)).toBe(4 * n[id].octaves * (n[id].double ? 2 : 1));
    }
    const p = paramsWith({ caves: { noises: { cheese: { octaves: 3, double: false }, layer: { octaves: 5, double: true } } } });
    expect(workCost({ root: { op: 'add', a: { op: 'noise', id: 'cheese' }, b: { op: 'noise', id: 'layer' } }, defs: {} }, p)).toBe(1 + 4 * 3 + 4 * 5 * 2);
    // An unknown id still weighs the static maximum.
    expect(workCost({ root: { op: 'noise', id: 'nope' }, defs: {} }, p)).toBe(128);
  });

  test('a noiseScaled leaf costs what a noise leaf costs, inside and outside interpolated: 4 · octaves · (double ? 2 : 1) (SP6a §1.5)', () => {
    const tree = (leaf: unknown) => ({ root: { op: 'add', a: leaf, b: { op: 'interpolated', x: { op: 'neg', x: leaf } } }, defs: {} });
    const noise = { op: 'noise', id: 'detail' }, scaled = { op: 'noiseScaled', id: 'detail', s: 0.75 };
    for (const p of [DEFAULTS, paramsWith({ density: { noises: { detail: { octaves: 3, double: true } } } }), paramsWith({ density: { noises: { detail: { octaves: 2, double: false } } } })]) {
      const d = p.density.noises.detail;
      const weight = 4 * d.octaves * (d.double ? 2 : 1);
      expect(workCost({ root: scaled, defs: {} }, p)).toBe(weight);
      expect(workCost({ root: { op: 'interpolated', x: scaled }, defs: {} }, p)).toBe(1 + 8 * weight);
      expect(workCost(tree(scaled), p)).toBe(workCost(tree(noise), p));
    }
    expect(workCost({ root: { op: 'noiseScaled', id: 'nope', s: 1 }, defs: {} }, DEFAULTS)).toBe(128);
    expect(structuralCost(tree(scaled).root)).toBe(structuralCost(tree(noise).root));
    expect(densityColumnCost(tree(scaled))).toBe(densityColumnCost(tree(noise)));
    expect(densityColumnCost({ root: scaled, defs: {} })).toBe(128 * VOXELS);
    expect(densityColumnCost({ root: { op: 'interpolated', x: scaled }, defs: {} })).toBe(VOXELS + 128 * CORNERS);
  });

  test('own-property lookups: Object.prototype member names are ordinary def names, inherited members are not defs', () => {
    const defs = { constructor: { op: 'neg', x: { op: 'y' } }, toString: { op: 'ref', name: 'constructor' } };
    expect(structuralCost({ op: 'ref', name: 'toString' }, defs)).toBe(2);
    expect(structuralCost({ op: 'ref', name: 'hasOwnProperty' }, defs)).toBe(1);
    expect(structuralCost({ op: 'ref', name: 'valueOf' }, {})).toBe(1);
    expect(densityColumnCost({ root: { op: 'ref', name: 'constructor' }, defs })).toBe(2 * VOXELS);
  });

  test('saturating at 2^31, never throwing: shared-def chains, cycles, 100,000-deep chains, junk', () => {
    const defs: Rec = { d0: { op: 'y' } };
    for (let i = 1; i <= 60; i++) defs[`d${i}`] = { op: 'add', a: { op: 'ref', name: `d${i - 1}` }, b: { op: 'ref', name: `d${i - 1}` } };
    expect(structuralCost({ op: 'ref', name: 'd20' }, defs)).toBe(2 ** 21 - 1);
    expect(structuralCost({ op: 'ref', name: 'd60' }, defs)).toBe(2 ** 31);
    expect(densityColumnCost({ root: { op: 'ref', name: 'd60' }, defs })).toBe(2 ** 31);
    expect(workCost({ root: { op: 'ref', name: 'd60' }, defs }, DEFAULTS)).toBe(2 ** 31);
    const cyc = { a: { op: 'neg', x: { op: 'ref', name: 'b' } }, b: { op: 'ref', name: 'a' } };
    expect(structuralCost({ op: 'ref', name: 'a' }, cyc)).toBe(2 ** 31);
    expect(densityColumnCost({ root: { op: 'ref', name: 'a' }, defs: cyc })).toBe(2 ** 31);
    let deep: unknown = { op: 'y' };
    for (let i = 0; i < 100_000; i++) deep = { op: 'neg', x: deep };
    expect(structuralCost(deep)).toBe(100_001);
    expect(densityColumnCost({ root: deep, defs: {} })).toBe(2 ** 31);
    expect(structuralCost(null)).toBe(0);
    expect(structuralCost({ op: 'bogus', x: { op: 'y' } })).toBe(1);
    expect(structuralCost({ op: 'add', a: 3, b: [1] })).toBe(1);
    expect(densityColumnCost('x')).toBe(0);
    expect(rulesColumnCost(7)).toBe(0);
    let deepRule: unknown = { kind: 'block', state: 'stone' };
    for (let i = 0; i < 100_000; i++) deepRule = { kind: 'sequence', rules: [deepRule] };
    expect(rulesColumnCost(deepRule)).toBe(100_001 * 256);
  });

  test('the three costs equal their recursive oracles on 300 random trees over the schema noises', () => {
    const next = testRng(4040);
    const p = paramsWith({ density: { noises: { overhang: { octaves: 5 }, detail: { double: false } } } });
    for (let n = 0; n < 300; n++) {
      const e: DensityExpr = randomDensityExpr(next, { noises: SCHEMA_DENSITY_NOISES });
      expect(structuralCost(e.root, e.defs)).toBe(oracle(e.root, e.defs, 'structural'));
      expect(workCost(e, p)).toBe(oracle(e.root, e.defs, { params: p }));
      expect(densityColumnCost(e)).toBe(oracle(e.root, e.defs, 'column'));
      for (const name of Object.keys(e.defs)) expect(structuralCost(e.defs[name], e.defs)).toBe(oracle(e.defs[name], e.defs, 'structural'));
    }
  });
});

describe('column costs and their maxima (SP3d spec §1.7 "The two column-cost maxima")', () => {
  /**
   * SP6a's default: SP3d's 14,907,917 plus 5 voxel-level nodes (the precave tap, two mins, two slots) × 98,304 (15,399,437
   * before the cave terms), then the cave terms (Task 6): 16 more voxel-level nodes and 3,319 more corner units.
   */
  const DENSITY_DEFAULT = 21_038_076;
  /** The SP3d default tree's column cost, which `DENSITY_COLUMN_COST_MAX` stays pinned to (SP6a D24). */
  const SP3D_DENSITY_DEFAULT = 14_907_917;
  const RULES_DEFAULT = 163 * 256 * (1 + 4 + SD_MAX_STATIC);

  test('the default density column cost: 169 units × 98,304 outside interpolated, 3,612 × 1,225 inside', () => {
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBe(DENSITY_DEFAULT);
    expect(169 * VOXELS + 3612 * CORNERS).toBe(DENSITY_DEFAULT);
    expect(densityColumnCost(sp5cTrees().default)).toBe(SP3D_DENSITY_DEFAULT);
    expect(148 * VOXELS + 293 * CORNERS).toBe(SP3D_DENSITY_DEFAULT);
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBe(oracle(src.root, src.defs as Rec, 'column'));
  });

  test('the default rules column cost: 163 nodes × 256 × (1 + 51), the depth bound 4 + SD_MAX 47', () => {
    expect(countTreeNodes(DEFAULT_SURFACE_RULES, 'surfaceRules')).toBe(163);
    expect(rulesColumnCost(DEFAULT_SURFACE_RULES)).toBe(RULES_DEFAULT);
    expect(RULES_DEFAULT).toBe(2_169_856);
    // The compiler's fast path agrees on the resolved default with SD_MAX at its static maximum.
    const resolved = legacyDefaultSurfaceRules(DEFAULTS.surface);
    expect(surfaceFastPath(resolved, SD_MAX_STATIC)!.maxSurfaceDepth).toBe(4 + SD_MAX_STATIC);
    expect(rulesColumnCost(resolved)).toBe(RULES_DEFAULT);
  });

  test('the maxima are 64 × the SP3d default density tree (SP6a D24) and 64 × the default rules, below the saturation', () => {
    expect(DENSITY_COLUMN_COST_MAX).toBe(64 * SP3D_DENSITY_DEFAULT);
    expect(DENSITY_COLUMN_COST_MAX).toBe(64 * 14_907_917);
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBeLessThanOrEqual(DENSITY_COLUMN_COST_MAX);
    expect(RULES_COLUMN_COST_MAX).toBe(64 * rulesColumnCost(DEFAULT_SURFACE_RULES));
    expect(DENSITY_COLUMN_COST_MAX).toBeLessThan(2 ** 31);
    expect(RULES_COLUMN_COST_MAX).toBeLessThan(2 ** 31);
  });

  test('U2 variants and uiSmoke trees stay within the maxima', () => {
    const muted = copy(DEFAULT_DENSITY_TREE);
    expect(at(muted, 'root.a.a.a.x.a')['name']).toBe('terrain');
    at(muted, 'root.a.a.a.x.a')['mute'] = 0;
    const islands = copy(DEFAULT_DENSITY_TREE);
    expect(at(islands, 'root.b')['name']).toBe('islands');
    at(islands, 'root.b.x')['v'] = -10;
    const gradient = copy(DEFAULT_SURFACE_RULES);
    expect(at(gradient, 'rules[2].if')).toEqual({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 });
    at(gradient, 'rules[2].if')['falseAtAndAbove'] = 12;
    // Muting terrain replaces the interpolated subtree (1 × 98,304 + 293 × 1,225) by one const at voxel placement.
    expect(densityColumnCost(muted)).toBe(DENSITY_DEFAULT - 293 * CORNERS);
    expect(densityColumnCost(islands)).toBe(DENSITY_DEFAULT);
    expect(rulesColumnCost(gradient)).toBe(RULES_DEFAULT);
    for (const t of [muted, islands, AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE]) expect(densityColumnCost(t)).toBeLessThanOrEqual(DENSITY_COLUMN_COST_MAX);
    expect(rulesColumnCost(gradient)).toBeLessThanOrEqual(RULES_COLUMN_COST_MAX);
  });

  test('a default-sized rule tree without a fast path costs 384 / 52 ≈ 7.4 × the default, within 64 ×', () => {
    const noFast = copy(DEFAULT_SURFACE_RULES);
    const stack: unknown[] = [noFast];
    while (stack.length > 0) {
      const x = stack.pop();
      if (Array.isArray(x)) stack.push(...(x as unknown[]));
      else if (isRec(x)) {
        if (x['kind'] === 'stoneDepth') x['side'] = 'ceiling';
        stack.push(...Object.values(x));
      }
    }
    expect(countTreeNodes(noFast, 'surfaceRules')).toBe(163);
    expect(surfaceFastPath(withRegisteredBlocks(noFast) as Rule, SD_MAX_STATIC)).toBeNull();
    expect(rulesColumnCost(noFast)).toBe(163 * VOXELS);
    expect(rulesColumnCost(noFast) / RULES_DEFAULT).toBeCloseTo(384 / 52, 12);
    expect(rulesColumnCost(noFast)).toBeLessThanOrEqual(RULES_COLUMN_COST_MAX);
  });

  test('refs in a floor offset take the end of their static range that maximises the bound', () => {
    const tree = (offset: unknown, add: boolean): unknown => ({
      kind: 'condition', if: { kind: 'stoneDepth', side: 'floor', offset, addSurfaceDepth: add }, then: { kind: 'block', state: 'dirt' },
    });
    expect(rulesColumnCost(tree(2, false))).toBe(3 * 256 * 3);
    expect(rulesColumnCost(tree(2, true))).toBe(3 * 256 * (3 + SD_MAX_STATIC));
    // surface.cliffMinY ∈ [−64, 319]: 319 at most, or 0 − (−64) = 64 negated; a bound of 383 or more is the whole column.
    expect(rulesColumnCost(tree({ param: 'surface.cliffMinY' }, false))).toBe(3 * 256 * 320);
    expect(rulesColumnCost(tree({ param: 'surface.cliffMinY', neg: true }, false))).toBe(3 * 256 * 65);
    expect(rulesColumnCost(tree({ param: 'surface.cliffMinY' }, true))).toBe(3 * 256 * (320 + SD_MAX_STATIC));
    expect(rulesColumnCost(tree(384, true))).toBe(3 * VOXELS);
    // A negative bound clamps to one voxel per position; an unknown target or a junk offset counts as unbounded.
    expect(rulesColumnCost(tree(-20, false))).toBe(3 * 256);
    expect(rulesColumnCost(tree({ param: 'surface.nope' }, false))).toBe(3 * VOXELS);
    expect(rulesColumnCost(tree('x', false))).toBe(3 * VOXELS);
  });

  test('rulesColumnCost decides the fast path as surfaceFastPath does, on 600 random trees of the three fuzz styles', () => {
    const next = testRng(4041);
    let fast = 0;
    for (let n = 0; n < 600; n++) {
      const style = (['free', 'fastPath', 'nearMiss'] as const)[n % 3]!;
      const rules = withRegisteredBlocks(randomSurfaceRules(next, { style })) as Rule;
      const fp = surfaceFastPath(rules, SD_MAX_STATIC);
      const nodes = countTreeNodes(rules, 'surfaceRules');
      const perNode = fp === null ? VOXELS : Math.min(VOXELS, 256 * (1 + Math.max(0, fp.maxSurfaceDepth)));
      if (fp !== null) fast++;
      expect(rulesColumnCost(rules)).toBe(Math.min(2 ** 31, nodes * perNode));
    }
    expect(fast).toBeGreaterThan(100);
    expect(fast).toBeLessThan(500);
  });
});

import { describe, expect, test } from 'vitest';
import { DENSITY_COLUMN_COST_MAX, RULES_COLUMN_COST_MAX } from '../../src/core/constants';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { countTreeNodes } from '../../src/core/params/json';
import type { Params } from '../../src/core/params/schema';
import { EXPR_CHILD_KEYS, type DensityExpr, type Expr } from '../../src/gen/density/expr';
import { densityColumnCost, rulesColumnCost, structuralCost, workCost } from '../../src/gen/inspect/cost';
import { surfaceFastPath } from '../../src/gen/surface/compile';
import type { Rule } from '../../src/gen/surface/rules';
import { randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { legacyDefaultDensityExpr, legacyDefaultSurfaceRules } from '../harness/legacyTrees';
import { paramsWith } from '../harness/gen';
import { testRng } from '../harness/stats';
import { randomSurfaceRules, withRegisteredBlocks } from '../harness/surfaceFuzz';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A mutable deep copy of a JSON value. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The object at a dotted path with `[i]` items (`root.a.a`, `rules[2].if`). */
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
    const own = (op === 'noise' || op === 'noise2' ? 128 : 1) * (corner ? CORNERS : VOXELS);
    if (muted) return own + (inner ? CORNERS : VOXELS);
    return own + keys.reduce((s, k) => s + oracle(n[k], defs, mode, inner), 0);
  }
  let own = 1;
  if (typeof mode === 'object' && (op === 'noise' || op === 'noise2')) {
    const d = (mode.params.density.noises as Readonly<Record<string, { octaves: number; double: boolean }>>)[n['id'] as string]!;
    own = 4 * d.octaves * (d.double ? 2 : 1);
  }
  const kids = keys.reduce((s, k) => s + oracle(n[k], defs, mode, inner), 0);
  return own + (op === 'interpolated' ? 8 : 1) * kids;
}

describe('structural and work costs (SP3d spec §1.7, §5.2)', () => {
  test('the default root costs 333 as source and 322 as the legacy-built tree', () => {
    expect(structuralCost(src.root, src.defs)).toBe(333);
    const legacy = legacyDefaultDensityExpr(DEFAULTS.density);
    expect(structuralCost(legacy.root, legacy.defs)).toBe(322);
  });

  test('the default work cost is 569 at DEFAULTS: 322 units, 17 of them noises (8 jag, 8 overhang corners, 1 detail)', () => {
    const legacy = legacyDefaultDensityExpr(DEFAULTS.density);
    expect(workCost(legacy, DEFAULTS)).toBe(569);
    expect(322 - 17 + 8 * 16 + 8 * 16 + 8).toBe(569);
    // The configured leaf: 3 octaves of a single-stack jag weigh 12 each.
    const p = paramsWith({ density: { noises: { jag: { octaves: 3, double: false } } } });
    expect(workCost(legacy, p)).toBe(569 - 8 * 16 + 8 * 12);
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
  const DENSITY_DEFAULT = 14_907_917;
  const RULES_DEFAULT = 163 * 256 * (1 + 4 + SD_MAX_STATIC);

  test('the default density column cost: 148 units × 98,304 outside interpolated, 293 × 1,225 inside', () => {
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBe(DENSITY_DEFAULT);
    expect(148 * VOXELS + 293 * CORNERS).toBe(DENSITY_DEFAULT);
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

  test('the maxima are 64 × the defaults and below the saturation', () => {
    expect(DENSITY_COLUMN_COST_MAX).toBe(64 * densityColumnCost(DEFAULT_DENSITY_TREE));
    expect(RULES_COLUMN_COST_MAX).toBe(64 * rulesColumnCost(DEFAULT_SURFACE_RULES));
    expect(DENSITY_COLUMN_COST_MAX).toBeLessThan(2 ** 31);
    expect(RULES_COLUMN_COST_MAX).toBeLessThan(2 ** 31);
  });

  test('U2 variants and uiSmoke trees stay within the maxima', () => {
    const muted = copy(DEFAULT_DENSITY_TREE);
    expect(at(muted, 'root.a.a')['name']).toBe('terrain');
    at(muted, 'root.a.a')['mute'] = 0;
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
    for (const t of [muted, islands]) expect(densityColumnCost(t)).toBeLessThanOrEqual(DENSITY_COLUMN_COST_MAX);
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

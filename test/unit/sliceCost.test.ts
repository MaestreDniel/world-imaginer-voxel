import { describe, expect, test } from 'vitest';
import {
  COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, DRAFT_BUDGET, PART_BUDGET, REQUEST_BUDGET, SLICE_RULE_NA,
} from '../../src/core/constants';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { densityColumnCost, ruleNodeCount, rulesColumnCost, tColumnCost, workCost } from '../../src/gen/inspect/cost';
import { evaluatedExpression, sliceCostOf } from '../../src/gen/inspect/fieldSlice';
import { paramsWith } from '../harness/gen';
import { steepTree, terrainMuted } from './fixtures/editedTrees';

type Tree = Record<string, any>;

/** Params with `density.defs` = `tree`. */
const withTree = (tree: Tree): Params => paramsWith({ density: { defs: tree } } as never);


describe('the slice work-bound constants (SP3d spec §5.2, core/constants.ts)', () => {
  test('acquisition costs, budgets and the rule field\'s n/a value', () => {
    expect([COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST]).toEqual([2 ** 15, 2 ** 11, 5 * 2 ** 10]);
    expect([PART_BUDGET, DRAFT_BUDGET, REQUEST_BUDGET]).toEqual([2 ** 23, 2 ** 24, 2 ** 27]);
    expect(SLICE_RULE_NA).toBe(255);
  });
});

describe('the T column work and the rule node count (SP3d spec §5.2, gen/inspect/cost.ts)', () => {
  test('the default trees: density column work at the configured noise weights, rules column cost, node count', () => {
    // Voxel placement: 20 nodes + detail (1 octave, double: 8) = 28 units; under interpolated: 37 nodes + jag and
    // overhang (2 octaves, double: 16 each) = 69 units.
    expect(densityColumnCost(DEFAULT_DENSITY_TREE, DEFAULTS)).toBe(28 * 98304 + 69 * 1225);
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBe(14_907_917);
    expect(ruleNodeCount(DEFAULT_SURFACE_RULES)).toBe(163);
    expect(rulesColumnCost(DEFAULT_SURFACE_RULES)).toBe(2_169_856);
    expect(tColumnCost(DEFAULTS)).toBe(2_837_037 + 2_169_856);
  });

  test('every noise at its static maximum weight gives the static density column cost', () => {
    const max = { octaves: 16, double: true };
    const p = {
      ...DEFAULTS,
      density: { ...DEFAULTS.density, noises: { jag: { ...DEFAULTS.density.noises.jag, ...max }, overhang: { ...DEFAULTS.density.noises.overhang, ...max }, detail: { ...DEFAULTS.density.noises.detail, ...max } } },
    } as Params;
    expect(densityColumnCost(DEFAULT_DENSITY_TREE, p)).toBe(densityColumnCost(DEFAULT_DENSITY_TREE));
  });

  test('a muted terrain tap drops its subtree from the T column work, mutes applied', () => {
    const p = withTree(terrainMuted(0));
    // The interpolated node (voxel placement) becomes the mute's const; its 69 corner units go.
    expect(densityColumnCost(p.density.defs, p)).toBe(28 * 98304);
    expect(tColumnCost(p)).toBe(28 * 98304 + 2_169_856);
  });
});

describe('sliceCostOf (SP3d spec §5.2)', () => {
  test('the defaults: vertical 128² ≈ 13.5 M and horizontal 128² ≈ 42.9 M units', () => {
    expect(workCost(evaluatedExpression(DEFAULTS, 'density', ''), DEFAULTS)).toBe(569);
    const v = sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128);
    const h = sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 128);
    expect(v).toBe(128 * 569 + COLUMN_SAMPLE_COST);
    expect(h).toBe(128 * (569 + CORNER_SAMPLE_COST));
    expect(128 * v).toBe(13_516_800);
    expect(128 * h).toBe(42_876_928);
    expect(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 32)).toBe(32 * 569 + COLUMN_SAMPLE_COST);
    expect(sliceCostOf(DEFAULTS, 'node', 'root', 'vertical', 128)).toBe(v);
  });

  test('a node inside interpolated is costed wrapped (1 + 8 × its subtree); one outside is not', () => {
    const inside = evaluatedExpression(DEFAULTS, 'node', 'root.a.a.x.x.a');
    expect(inside.root.op).toBe('interpolated');
    const bare = { root: (inside.root as { x: unknown }).x, defs: inside.defs };
    const c = workCost(inside, DEFAULTS);
    expect(c).toBe(1 + 8 * workCost(bare, DEFAULTS));
    expect(sliceCostOf(DEFAULTS, 'node', 'root.a.a.x.x.a', 'vertical', 128)).toBe(128 * c + COLUMN_SAMPLE_COST);
    expect(sliceCostOf(DEFAULTS, 'node', 'root.a.a.x.x.a', 'horizontal', 32)).toBe(32 * (c + CORNER_SAMPLE_COST));
    const tap = evaluatedExpression(DEFAULTS, 'node', 'root.a.a');
    expect(tap.root.op).toBe('tap');
    expect(workCost(tap, DEFAULTS)).toBe(1 + workCost({ root: (tap.root as { x: unknown }).x, defs: {} }, DEFAULTS));
    // The detail term (voxel placement): mul(noise detail, amplitude) = 1 + 8 + its amplitude's folded nodes.
    expect(evaluatedExpression(DEFAULTS, 'node', 'root.a.b').root.op).toBe('mul');
  });

  test('horizontal: a node reading col steep through the evaluated expression pays CORNER_STEEP_COST per sample', () => {
    const p = withTree(steepTree());
    const c = workCost(evaluatedExpression(p, 'density', ''), p);
    expect(c).toBe(569 + 2);
    expect(sliceCostOf(p, 'density', '', 'horizontal', 128)).toBe(128 * (c + CORNER_STEEP_COST));
    expect(sliceCostOf(p, 'node', 'root.b', 'horizontal', 128)).toBe(128 * (workCost(evaluatedExpression(p, 'node', 'root.b'), p) + CORNER_STEEP_COST));
    expect(sliceCostOf(p, 'node', 'root.a', 'horizontal', 128)).toBe(128 * (workCost(evaluatedExpression(p, 'node', 'root.a'), p) + CORNER_SAMPLE_COST));
    expect(sliceCostOf(p, 'density', '', 'vertical', 128)).toBe(128 * c + COLUMN_SAMPLE_COST);
  });

  test('a steep-reading horizontal 128² slice of a default-weight tree fits REQUEST_BUDGET, and its 32² draft DRAFT_BUDGET', () => {
    // The acquisition alone must leave room in every budget: n² × CORNER_STEEP_COST = REQUEST_BUDGET at n = 128 with
    // 2^13 (every steep-reading tree refused, "limit 0"); calibrated at 5 × 2^10 (64.5 µs measured, Task 19) it leaves
    // 3,072 units per sample for a 128² slice (5.4 × the default's 569) and 11,264 for a draft.
    const room = (n: number, budget: number, perSample: number) => Math.min(Math.floor(budget / (n * n)), Math.floor(PART_BUDGET / n)) - perSample;
    expect([room(128, REQUEST_BUDGET, CORNER_STEEP_COST), room(32, DRAFT_BUDGET, CORNER_STEEP_COST)]).toEqual([3072, 11_264]);
    expect([room(128, REQUEST_BUDGET, CORNER_SAMPLE_COST), room(32, DRAFT_BUDGET, CORNER_SAMPLE_COST)]).toEqual([6144, 14_336]);
    expect(CORNER_STEEP_COST).toBeGreaterThan(CORNER_SAMPLE_COST);
    for (const n of [32, 128]) expect(room(n, n === 32 ? DRAFT_BUDGET : REQUEST_BUDGET, CORNER_STEEP_COST), `n ${n}`).toBeGreaterThanOrEqual(4 * 569);
    const p = withTree(steepTree());
    for (const [field, path] of [['density', ''], ['node', 'root.b'], ['node', 'root.b.x']] as const) {
      const c = workCost(evaluatedExpression(p, field, path), p);
      for (const [n, budget] of [[32, DRAFT_BUDGET], [128, REQUEST_BUDGET]] as const) {
        const cost = sliceCostOf(p, field, path, 'horizontal', n);
        expect(cost, `${field} ${path} ${n}`).toBe(n * (c + CORNER_STEEP_COST));
        expect(n * cost, `${field} ${path} ${n}`).toBeLessThanOrEqual(budget);
        expect(cost, `${field} ${path} ${n}`).toBeLessThanOrEqual(PART_BUDGET);
      }
    }
  });

  test('blocks: one T column per sample column; rule: plus n × the rule node count', () => {
    const t = tColumnCost(DEFAULTS);
    expect(sliceCostOf(DEFAULTS, 'blocks', '', 'vertical', 128)).toBe(t);
    expect(sliceCostOf(DEFAULTS, 'blocks', '', 'vertical', 32)).toBe(t);
    expect(sliceCostOf(DEFAULTS, 'rule', 'root.rules[2]', 'vertical', 128)).toBe(t + 128 * 163);
    expect(sliceCostOf(DEFAULTS, 'rule', 'root', 'vertical', 32)).toBe(t + 32 * 163);
  });

  test('the costs follow the configured params: a muted tap and the noise octaves', () => {
    const muted = withTree(terrainMuted(0));
    expect(sliceCostOf(muted, 'node', 'root.a.a.x', 'vertical', 128)).toBe(sliceCostOf(DEFAULTS, 'node', 'root.a.a.x', 'vertical', 128));
    expect(sliceCostOf(muted, 'density', '', 'vertical', 128)).toBeLessThan(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128));
    const octaves = paramsWith({ density: { noises: { detail: { octaves: 4 } } } } as never);
    expect(workCost(evaluatedExpression(octaves, 'density', ''), octaves)).toBe(569 - 8 + 32);
  });

  test('refusals: an n outside SLICE_NS, blocks or rule on a horizontal plane, a path naming no node', () => {
    expect(() => sliceCostOf(DEFAULTS, 'density', '', 'vertical', 64)).toThrow(RangeError);
    expect(() => sliceCostOf(DEFAULTS, 'blocks', '', 'horizontal', 128)).toThrow(/no horizontal slice/);
    expect(() => sliceCostOf(DEFAULTS, 'rule', 'root', 'horizontal', 32)).toThrow(/no horizontal slice/);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root.zz', 'vertical', 32)).toThrow(RangeError);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root.a.lo', 'vertical', 32)).toThrow(RangeError);
  });
});

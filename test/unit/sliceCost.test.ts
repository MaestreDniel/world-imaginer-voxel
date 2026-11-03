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
import { steepDefaultTree, steepTree, terrainMuted } from './fixtures/editedTrees';

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
    // Voxel placement: 25 nodes (SP6a §1.1: SP5c's 20 plus the precave tap, two mins and two slots) + detail (1 octave,
    // double: 8) = 33 units, and SP6a's cave terms' 16 voxel nodes (detailG's rangeChoice, interpolated and const; the
    // caves slot's max, min, the two family taps and their interpolated nodes, keep's rangeChoice, mul and two consts,
    // and twice defs.pillars' tap and interpolated, less the slot's const) = 49 units, and Task 7's 31 (the caves slot's two
    // more mins, the spaghetti taps and their interpolated nodes, the noodle's voxel-level combine) = 80 units; under
    // interpolated: the body's 37 nodes + jag and overhang (2 octaves, double: 16 each) = 69 units, read 9 times (the
    // terrain tap, detailG, cheese's sky, roof and ramp, each spaghetti slot's sky and ramp), plus the cave terms' corner
    // nodes and noises, 802 units (203 with Task 6's): 1,423 (548 with Task 6's).
    expect(densityColumnCost(DEFAULT_DENSITY_TREE, DEFAULTS)).toBe(80 * 98304 + 1423 * 1225);
    expect(1423).toBe(9 * 69 + 802);
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBe(35_349_375);
    expect(ruleNodeCount(DEFAULT_SURFACE_RULES)).toBe(163);
    expect(rulesColumnCost(DEFAULT_SURFACE_RULES)).toBe(2_169_856);
    expect(tColumnCost(DEFAULTS)).toBe(9_607_495 + 2_169_856);
  });

  test('every noise at its static maximum weight gives the static density column cost', () => {
    const max = { octaves: 16, double: true };
    const atMax = <T extends object>(noises: T): T => Object.fromEntries(Object.entries(noises).map(([id, d]) => [id, { ...d, ...max }])) as T;
    // The density noises and SP6a's cave noises (the default tree reads both).
    const p = {
      ...DEFAULTS,
      density: { ...DEFAULTS.density, noises: atMax(DEFAULTS.density.noises) },
      caves: { ...DEFAULTS.caves, noises: atMax(DEFAULTS.caves.noises) },
    } as Params;
    expect(densityColumnCost(DEFAULT_DENSITY_TREE, p)).toBe(densityColumnCost(DEFAULT_DENSITY_TREE));
  });

  test('a muted terrain tap drops its subtree from the T column work, mutes applied', () => {
    const p = withTree(terrainMuted(0));
    // The interpolated node (voxel placement) becomes the mute's const; its 69 corner units go (detailG and the cave
    // terms still read the body at the corners).
    expect(densityColumnCost(p.density.defs, p)).toBe(80 * 98304 + (1423 - 69) * 1225);
    expect(tColumnCost(p)).toBe(80 * 98304 + 1354 * 1225 + 2_169_856);
  });
});

describe('sliceCostOf (SP3d spec §5.2)', () => {
  test('the defaults: vertical 128² ≈ 189.9 M and horizontal 128² ≈ 219.2 M units (75.7 M and 105.1 M with Task 6\'s cave terms, 13.6 M and 43.0 M before them)', () => {
    expect(workCost(evaluatedExpression(DEFAULTS, 'density', ''), DEFAULTS)).toBe(11332);
    const v = sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128);
    const h = sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 128);
    expect(v).toBe(128 * 11332 + COLUMN_SAMPLE_COST);
    expect(h).toBe(128 * (11332 + CORNER_SAMPLE_COST));
    expect(128 * v).toBe(189_857_792);
    expect(128 * h).toBe(219_217_920);
    // SP6a Task 7: both exceed their request budget (2^27 = 134,217,728: 7,936 work units per vertical sample, 6,144 per
    // horizontal one), so the 128² slices of the default are refused and drawn as their 32² drafts, which fit
    // DRAFT_BUDGET; every sample column fits the part budget.
    expect([128 * v <= REQUEST_BUDGET, 128 * h <= REQUEST_BUDGET, v <= PART_BUDGET, h <= PART_BUDGET]).toEqual([false, false, true, true]);
    expect(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 32)).toBe(32 * 11332 + COLUMN_SAMPLE_COST);
    expect([32 * sliceCostOf(DEFAULTS, 'density', '', 'vertical', 32), 32 * sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 32)].every((c) => c <= DRAFT_BUDGET)).toBe(true);
    expect(sliceCostOf(DEFAULTS, 'node', 'root', 'vertical', 128)).toBe(v);
  });

  test('a node inside interpolated is costed wrapped (1 + 8 × its subtree); one outside is not', () => {
    const inside = evaluatedExpression(DEFAULTS, 'node', 'defs.body.a');
    expect(inside.root.op).toBe('interpolated');
    const bare = { root: (inside.root as { x: unknown }).x, defs: inside.defs };
    const c = workCost(inside, DEFAULTS);
    expect(c).toBe(1 + 8 * workCost(bare, DEFAULTS));
    expect(sliceCostOf(DEFAULTS, 'node', 'defs.body.a', 'vertical', 128)).toBe(128 * c + COLUMN_SAMPLE_COST);
    expect(sliceCostOf(DEFAULTS, 'node', 'defs.body.a', 'horizontal', 32)).toBe(32 * (c + CORNER_SAMPLE_COST));
    const tap = evaluatedExpression(DEFAULTS, 'node', 'root.a.a.a.x.a');
    expect(tap.root.op).toBe('tap');
    expect(workCost(tap, DEFAULTS)).toBe(1 + workCost({ root: (tap.root as { x: unknown }).x, defs: tap.defs }, DEFAULTS));
    // detailG and the detail term inside it (voxel placement): mul(noise detail, amplitude) = 1 + 8 + its amplitude's
    // folded nodes; detailG's interpolated(ref body) is an interpolated node outside interpolated (not wrapped again).
    expect(evaluatedExpression(DEFAULTS, 'node', 'root.a.a.a.x.b').root.op).toBe('rangeChoice');
    expect(evaluatedExpression(DEFAULTS, 'node', 'root.a.a.a.x.b.inside').root.op).toBe('mul');
    // A cave family's slot child (SP6a §1.1) is costed wrapped: the interpolated entrances slot's child.
    const e = evaluatedExpression(DEFAULTS, 'node', 'root.a.a.b.a.a.a.a.x.x');
    expect(e.root.op).toBe('interpolated');
    expect(workCost(e, DEFAULTS)).toBe(1 + 8 * workCost({ root: (e.root as { x: unknown }).x, defs: e.defs }, DEFAULTS));
  });

  test('horizontal: a node reading col steep through the evaluated expression pays CORNER_STEEP_COST per sample', () => {
    const p = withTree(steepTree());
    const c = workCost(evaluatedExpression(p, 'density', ''), p);
    expect(c).toBe(574 + 2);
    expect(sliceCostOf(p, 'density', '', 'horizontal', 128)).toBe(128 * (c + CORNER_STEEP_COST));
    expect(sliceCostOf(p, 'node', 'root.b', 'horizontal', 128)).toBe(128 * (workCost(evaluatedExpression(p, 'node', 'root.b'), p) + CORNER_STEEP_COST));
    expect(sliceCostOf(p, 'node', 'root.a', 'horizontal', 128)).toBe(128 * (workCost(evaluatedExpression(p, 'node', 'root.a'), p) + CORNER_SAMPLE_COST));
    expect(sliceCostOf(p, 'density', '', 'vertical', 128)).toBe(128 * c + COLUMN_SAMPLE_COST);
  });

  test('a steep-reading horizontal 128² slice of a tree of the default\'s weight without its cave terms fits REQUEST_BUDGET, and its 32² draft DRAFT_BUDGET', () => {
    // The acquisition alone must leave room in every budget: n² × CORNER_STEEP_COST = REQUEST_BUDGET at n = 128 with
    // 2^13 (every steep-reading tree refused, "limit 0"); calibrated at 5 × 2^10 (64.5 µs measured, Task 19) it leaves
    // 3,072 units per sample for a 128² slice (5.4 × the default's 574 before SP6a's cave terms) and 11,264 for a draft.
    const room = (n: number, budget: number, perSample: number) => Math.min(Math.floor(budget / (n * n)), Math.floor(PART_BUDGET / n)) - perSample;
    expect([room(128, REQUEST_BUDGET, CORNER_STEEP_COST), room(32, DRAFT_BUDGET, CORNER_STEEP_COST)]).toEqual([3072, 11_264]);
    expect([room(128, REQUEST_BUDGET, CORNER_SAMPLE_COST), room(32, DRAFT_BUDGET, CORNER_SAMPLE_COST)]).toEqual([6144, 14_336]);
    expect(CORNER_STEEP_COST).toBeGreaterThan(CORNER_SAMPLE_COST);
    for (const n of [32, 128]) expect(room(n, n === 32 ? DRAFT_BUDGET : REQUEST_BUDGET, CORNER_STEEP_COST), `n ${n}`).toBeGreaterThanOrEqual(4 * 574);
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

  test('SP6a: the steep edit of today\'s default (11,332 + 2) is refused at a horizontal 128² slice (room 3,072) and, since Task 7, at its 32² draft (room 11,264), as the plain default is at 128²', () => {
    const p = withTree(steepDefaultTree());
    const c = workCost(evaluatedExpression(p, 'density', ''), p);
    expect(c).toBe(11332 + 2);
    expect(128 * sliceCostOf(p, 'density', '', 'horizontal', 128)).toBeGreaterThan(REQUEST_BUDGET);
    // 32 × 32 × (11,334 + 5,120) = 16,848,896: 71,680 units above DRAFT_BUDGET (Task 6's 4,368 fitted).
    expect(32 * sliceCostOf(p, 'density', '', 'horizontal', 32)).toBe(16_848_896);
    expect(32 * sliceCostOf(p, 'density', '', 'horizontal', 32) - DRAFT_BUDGET).toBe(71_680);
    // Its vertical 128² slice samples columns (no corner steep): refused too since Task 7 (11,334 > 7,936 per sample).
    expect(128 * sliceCostOf(p, 'density', '', 'vertical', 128)).toBeGreaterThan(REQUEST_BUDGET);
    // The plain default's horizontal 128² slice: 11,332 > 6,144 per sample (it fitted at Task 6's 4,366).
    expect(128 * sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 128)).toBeGreaterThan(REQUEST_BUDGET);
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
    expect(sliceCostOf(muted, 'node', 'root.a.a.a.x.a.x', 'vertical', 128)).toBe(sliceCostOf(DEFAULTS, 'node', 'root.a.a.a.x.a.x', 'vertical', 128));
    expect(sliceCostOf(muted, 'density', '', 'vertical', 128)).toBeLessThan(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128));
    const octaves = paramsWith({ density: { noises: { detail: { octaves: 4 } } } } as never);
    expect(workCost(evaluatedExpression(octaves, 'density', ''), octaves)).toBe(11332 - 8 + 32);
    // A cave noise's octaves count too (SP6a §1.5): entrance 3 → 5 octaves at its 8 corner reads.
    const cave = paramsWith({ caves: { noises: { entrance: { octaves: 5, amplitudes: null } } } } as never);
    expect(workCost(evaluatedExpression(cave, 'density', ''), cave)).toBe(11332 - 8 * 12 + 8 * 20);
  });

  test('refusals: an n outside SLICE_NS, blocks or rule on a horizontal plane, a path naming no node', () => {
    expect(() => sliceCostOf(DEFAULTS, 'density', '', 'vertical', 64)).toThrow(RangeError);
    expect(() => sliceCostOf(DEFAULTS, 'blocks', '', 'horizontal', 128)).toThrow(/no horizontal slice/);
    expect(() => sliceCostOf(DEFAULTS, 'rule', 'root', 'horizontal', 32)).toThrow(/no horizontal slice/);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root.zz', 'vertical', 32)).toThrow(RangeError);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root.a.lo', 'vertical', 32)).toThrow(RangeError);
  });
});

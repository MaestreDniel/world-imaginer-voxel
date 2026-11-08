import { describe, expect, test } from 'vitest';
import {
  COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, DRAFT_BUDGET, PART_BUDGET, REQUEST_BUDGET, SLICE_EXTENTS, SLICE_RULE_NA,
} from '../../src/core/constants';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { densityColumnCost, memoWorkCost, ruleNodeCount, rulesColumnCost, tColumnCost, workCost } from '../../src/gen/inspect/cost';
import { evaluatedExpression, sliceColumnCorners, sliceCostOf } from '../../src/gen/inspect/fieldSlice';
import { isRefusableField, planFieldSlice } from '../../src/workers/protocol';
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
    // nodes and noises, 802 units (203 with Task 6's): 1,423 (548 with Task 6's). Task 8: the noodle's cap, 48 voxel nodes
    // (128 units), and the four slots' caps (4 × 48) with nb's 4 at the corners (998 units, 1,619). Task 9: the island cap,
    // 23 nodes in each cap: 23 more voxel nodes (151 units) and 4 × 23 more corner units (1,090, 1,711). Task 9's wet
    // roof: 52 more voxel nodes (the noodle cap's g_w, its add and its `interpolated`, 18; S_w's 16 through each of its
    // two refs; the root's two adds: 203 units) and at the corners each slot cap's g_w and add (17) and seven more reads
    // of the body's 69 (the four slots' g_w, the noodle cap's and S_w's two: 1,158 cave units, 2,262). D25's lever 5
    // (Task 15b): cheese 4 → 3 octaves (double: 32 → 24) and entrance 3 → 2 (12 → 8) at the corners: 1,146 cave units,
    // 2,250.
    expect(densityColumnCost(DEFAULT_DENSITY_TREE, DEFAULTS)).toBe(203 * 98304 + 2250 * 1225);
    expect(2262).toBe(16 * 69 + 1158);
    expect(1158 - 1146).toBe((32 - 24) + (12 - 8));
    expect(2250).toBe(16 * 69 + 1146);
    expect(998 - 802).toBe(4 * 48 + 4);
    expect([151 - 128, 1090 - 998]).toEqual([23, 4 * 23]);
    expect([203 - 151, 1158 - 1090]).toEqual([18 + 2 * 16 + 2, 4 * 17]);
    expect(densityColumnCost(DEFAULT_DENSITY_TREE)).toBe(50_389_342);
    expect(ruleNodeCount(DEFAULT_SURFACE_RULES)).toBe(163);
    expect(rulesColumnCost(DEFAULT_SURFACE_RULES)).toBe(2_169_856);
    expect(tColumnCost(DEFAULTS)).toBe(22_711_962 + 2_169_856);
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
    expect(densityColumnCost(p.density.defs, p)).toBe(203 * 98304 + (2250 - 69) * 1225);
    expect(tColumnCost(p)).toBe(203 * 98304 + 2181 * 1225 + 2_169_856);
  });
});

describe('memoWorkCost: the work under the slice reference\'s corner memo (SP6a §7.4, rulings R7, R9)', () => {
  const D = (root: Tree, defs: Tree = {}) => ({ root, defs });
  const detail = { op: 'noise', id: 'detail' };
  const I = (x: Tree) => ({ op: 'interpolated', x });
  const ref = (name: string) => ({ op: 'ref', name });

  test('voxel: workCost with each interpolated node costing 1; corner: each interpolated child and each def once', () => {
    // No interpolated: all voxel work.
    const flat = D({ op: 'mul', a: detail, b: { op: 'y' } });
    expect(memoWorkCost(flat, DEFAULTS)).toEqual({ voxel: workCost(flat, DEFAULTS), corner: 0 });
    // interpolated(noise detail): 1 at the voxel, the noise (8: 1 octave, double) at each corner.
    expect(memoWorkCost(D(I(detail)), DEFAULTS)).toEqual({ voxel: 1, corner: 8 });
    // Two interpolated nodes reading one def: the def (mul, noise, y: 10) counted once per corner, its refs nothing.
    const d = { op: 'mul', a: detail, b: { op: 'y' } };
    const twice = D({ op: 'add', a: I(ref('d')), b: I(ref('d')) }, { d });
    expect(workCost(twice, DEFAULTS)).toBe(1 + 2 * (1 + 8 * 10));
    expect(memoWorkCost(twice, DEFAULTS)).toEqual({ voxel: 3, corner: 10 });
    // One interpolated object read twice (by identity), or through two refs to its def: one child per corner.
    const shared = I(detail);
    expect(memoWorkCost(D({ op: 'add', a: shared, b: shared }), DEFAULTS)).toEqual({ voxel: 3, corner: 8 });
    expect(memoWorkCost(D({ op: 'add', a: ref('s'), b: ref('s') }, { s: I(detail) }), DEFAULTS)).toEqual({ voxel: 3, corner: 8 });
    // A def read by a def at corner placement is counted once too; a ref to a missing def costs 1.
    expect(memoWorkCost(D(I({ op: 'add', a: ref('a'), b: ref('b') }), { a: { op: 'add', a: ref('b'), b: ref('b') }, b: detail }), DEFAULTS)).toEqual({ voxel: 1, corner: 1 + 1 + 8 });
    expect(memoWorkCost(D(I(ref('nope'))), DEFAULTS)).toEqual({ voxel: 1, corner: 1 });
    expect(memoWorkCost(null, DEFAULTS)).toEqual({ voxel: 0, corner: 0 });
    expect(memoWorkCost({ root: 7 }, DEFAULTS)).toEqual({ voxel: 0, corner: 0 });
  });

  test('the default tree: 179 per sample and 1,104 per corner (workCost 17,451 = 179 + 8 × 2,159: its defs\' CSE at a corner)', () => {
    const e = evaluatedExpression(DEFAULTS, 'density', '');
    // D25's lever 5 (Task 15b): 1,116 and 2,171 before it, less cheese's 8 and entrance's 4 per corner.
    expect(memoWorkCost(e, DEFAULTS)).toEqual({ voxel: 179, corner: 1104 });
    expect(workCost(e, DEFAULTS)).toBe(179 + 8 * 2159);
  });

  test('never above workCost\'s 8 corners per sample: voxel + 8 × corner ≤ workCost on the presets and the edited trees', () => {
    for (const p of [DEFAULTS, withTree(steepTree()), withTree(steepDefaultTree()), withTree(terrainMuted(0))]) {
      for (const [field, path] of [['density', ''], ['node', 'root.a'], ['node', 'defs.body']] as const) {
        const e = evaluatedExpression(p, field, path);
        const w = memoWorkCost(e, p);
        expect(w.voxel + 8 * w.corner, `${field} ${path}`).toBeLessThanOrEqual(workCost(e, p));
      }
    }
  });
});

describe('sliceColumnCorners: the distinct corners one sample column reads (SP6a §7.4)', () => {
  test('vertical: 49 corner layers × 4 at n = 32 and 128; horizontal: 8n without sharing (E / n ≥ 8), fewer below', () => {
    expect([sliceColumnCorners('vertical', 32), sliceColumnCorners('vertical', 128)]).toEqual([196, 196]);
    // A 32² draft never shares (E / n ≥ 8 at every extent): 8 × 32.
    for (const e of SLICE_EXTENTS) expect(sliceColumnCorners('horizontal', 32, e), `E ${e}`).toBe(256);
    // 128²: step 2 (E 256) puts two samples in a cell, step 4 (E 512) one per cell: 5 corners i per chunk column
    // (one more chunk column when the square is not aligned to it), × 2 corner rows j × 2 layers k; from step 8 none.
    expect(SLICE_EXTENTS.map((e) => sliceColumnCorners('horizontal', 128, e))).toEqual([328, 644, 1024, 1024, 1024, 1024]);
    expect(() => sliceColumnCorners('horizontal', 128)).toThrow(RangeError);
    expect(() => sliceColumnCorners('horizontal', 128, 300)).toThrow(RangeError);
    expect(() => sliceColumnCorners('vertical', 64)).toThrow(RangeError);
  });
});

describe('sliceCostOf (SP3d spec §5.2; SP6a §7.4\'s memo-aware bound, rulings R7, R9)', () => {
  const vCost = (p: Params, field: 'density' | 'node', path: string, n: number) => {
    const w = memoWorkCost(evaluatedExpression(p, field, path), p);
    return n * w.voxel + sliceColumnCorners('vertical', n) * w.corner + COLUMN_SAMPLE_COST;
  };
  const hCost = (p: Params, field: 'density' | 'node', path: string, n: number, e: number, perSample: number) => {
    const w = memoWorkCost(evaluatedExpression(p, field, path), p);
    return n * (w.voxel + perSample) + sliceColumnCorners('horizontal', n, e) * w.corner;
  };

  test('the defaults: n × 179 + K × 1,104 plus the acquisition; vertical 128² 34.8 M units, horizontal 128² 82.8 M at E 256, 127.5 M at 512, 181.2 M from 1024', () => {
    const v128 = sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128);
    expect(v128).toBe(128 * 179 + 196 * 1104 + COLUMN_SAMPLE_COST);
    expect(v128).toBe(272_064);
    expect(128 * v128).toBe(34_824_192);
    expect(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 32)).toBe(32 * 179 + 196 * 1104 + COLUMN_SAMPLE_COST);
    expect(SLICE_EXTENTS.map((e) => 128 * sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 128, e))).toEqual([
      82_837_504, 127_492_096, 181_190_656, 181_190_656, 181_190_656, 181_190_656,
    ]);
    for (const e of SLICE_EXTENTS) {
      expect(sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 128, e)).toBe(hCost(DEFAULTS, 'density', '', 128, e, CORNER_SAMPLE_COST));
      expect(sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 32, e)).toBe(32 * (179 + CORNER_SAMPLE_COST) + 256 * 1104);
    }
    // The vertical plane ignores the extent; the node at the root is the density.
    expect(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128, 8192)).toBe(v128);
    expect(sliceCostOf(DEFAULTS, 'node', 'root', 'vertical', 128)).toBe(v128);
    // Without the memo (SP6a Tasks 7-12): 128 × 17,451 + COLUMN_SAMPLE_COST per vertical sample column, 8 corners per sample.
    expect(v128).toBeLessThan(128 * 17_451 + COLUMN_SAMPLE_COST);
  });

  test('the default tree\'s admission (ruling R9 (3)): its 32² draft on both planes at every extent, its full vertical 128², its full horizontal 128² at 256 and 512 only', () => {
    const admitted = (cost: number, n: number, budget: number) => cost <= PART_BUDGET && n * cost <= budget;
    // The vertical draft: 8,156,160 of DRAFT_BUDGET (margin 8,621,056, 51.4 %).
    const vDraft = sliceCostOf(DEFAULTS, 'density', '', 'vertical', 32);
    expect([32 * vDraft, DRAFT_BUDGET - 32 * vDraft, admitted(vDraft, 32, DRAFT_BUDGET)]).toEqual([8_156_160, 8_621_056, true]);
    // The horizontal draft at every extent (no corner shared): 11,324,416 (margin 5,452,800, 32.5 %).
    for (const e of SLICE_EXTENTS) {
      const h = sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 32, e);
      expect([32 * h, DRAFT_BUDGET - 32 * h, admitted(h, 32, DRAFT_BUDGET)], `E ${e}`).toEqual([11_324_416, 5_452_800, true]);
    }
    // The full vertical 128²: 34,824,192 of REQUEST_BUDGET (margin 99,393,536).
    const v = sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128);
    expect([REQUEST_BUDGET - 128 * v, admitted(v, 128, REQUEST_BUDGET)]).toEqual([99_393_536, true]);
    // The full horizontal 128²: admitted at 256 (margin 51,380,224) and 512 (6,725,632, 5.0 %); refused from 1024 (its
    // samples share no corner), where the draft is shown with the notice.
    expect(SLICE_EXTENTS.map((e) => {
      const h = sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 128, e);
      return [REQUEST_BUDGET - 128 * h, admitted(h, 128, REQUEST_BUDGET)];
    })).toEqual([[51_380_224, true], [6_725_632, true], [-46_972_928, false], [-46_972_928, false], [-46_972_928, false], [-46_972_928, false]]);
  });

  test('a node inside interpolated is costed wrapped (1 per sample, its subtree once per corner); one outside is not', () => {
    const inside = evaluatedExpression(DEFAULTS, 'node', 'defs.body.a');
    expect(inside.root.op).toBe('interpolated');
    const bare = { root: (inside.root as { x: unknown }).x, defs: inside.defs };
    const w = memoWorkCost(inside, DEFAULTS);
    expect(workCost(inside, DEFAULTS)).toBe(1 + 8 * workCost(bare, DEFAULTS));
    expect(w).toEqual({ voxel: 1, corner: workCost(bare, DEFAULTS) });
    expect(sliceCostOf(DEFAULTS, 'node', 'defs.body.a', 'vertical', 128)).toBe(128 + 196 * w.corner + COLUMN_SAMPLE_COST);
    expect(sliceCostOf(DEFAULTS, 'node', 'defs.body.a', 'horizontal', 32, 2048)).toBe(32 * (1 + CORNER_SAMPLE_COST) + 256 * w.corner);
    const tap = evaluatedExpression(DEFAULTS, 'node', 'root.a.a.a.x.a');
    expect(tap.root.op).toBe('tap');
    expect(workCost(tap, DEFAULTS)).toBe(1 + workCost({ root: (tap.root as { x: unknown }).x, defs: tap.defs }, DEFAULTS));
    // detailG and the detail term inside it (voxel placement): mul(noise detail, amplitude) = 1 + 8 + its amplitude's
    // folded nodes; detailG's interpolated(ref body) is an interpolated node outside interpolated (not wrapped again).
    expect(evaluatedExpression(DEFAULTS, 'node', 'root.a.a.a.x.b').root.op).toBe('rangeChoice');
    expect(evaluatedExpression(DEFAULTS, 'node', 'root.a.a.a.x.b.inside').root.op).toBe('mul');
    // A cave family's slot child (SP6a §1.1) is costed wrapped: the interpolated entrances slot's child.
    const e = evaluatedExpression(DEFAULTS, 'node', 'root.a.a.b.a.a.a.a.a.x.x');
    expect(e.root.op).toBe('interpolated');
    expect(workCost(e, DEFAULTS)).toBe(1 + 8 * workCost({ root: (e.root as { x: unknown }).x, defs: e.defs }, DEFAULTS));
    expect(memoWorkCost(e, DEFAULTS).voxel).toBe(1);
  });

  test('horizontal: a node reading col steep through the evaluated expression pays CORNER_STEEP_COST per sample', () => {
    const p = withTree(steepTree());
    expect(workCost(evaluatedExpression(p, 'density', ''), p)).toBe(574 + 2);
    expect(memoWorkCost(evaluatedExpression(p, 'density', ''), p)).toEqual({ voxel: 32, corner: 68 });
    for (const e of SLICE_EXTENTS) {
      expect(sliceCostOf(p, 'density', '', 'horizontal', 128, e)).toBe(hCost(p, 'density', '', 128, e, CORNER_STEEP_COST));
      expect(sliceCostOf(p, 'node', 'root.b', 'horizontal', 128, e)).toBe(hCost(p, 'node', 'root.b', 128, e, CORNER_STEEP_COST));
      expect(sliceCostOf(p, 'node', 'root.a', 'horizontal', 128, e)).toBe(hCost(p, 'node', 'root.a', 128, e, CORNER_SAMPLE_COST));
    }
    expect(sliceCostOf(p, 'density', '', 'vertical', 128)).toBe(vCost(p, 'density', '', 128));
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
      for (const [n, budget] of [[32, DRAFT_BUDGET], [128, REQUEST_BUDGET]] as const) {
        for (const e of SLICE_EXTENTS) {
          const cost = sliceCostOf(p, field, path, 'horizontal', n, e);
          expect(cost, `${field} ${path} ${n} ${e}`).toBe(hCost(p, field, path, n, e, CORNER_STEEP_COST));
          expect(n * cost, `${field} ${path} ${n} ${e}`).toBeLessThanOrEqual(budget);
          expect(cost, `${field} ${path} ${n} ${e}`).toBeLessThanOrEqual(PART_BUDGET);
        }
      }
    }
  });

  test('SP6a: the steep edit of today\'s default: its 32² horizontal draft fits DRAFT_BUDGET at every extent, its 128² horizontal slice at 256 only; its vertical 128² fits', () => {
    const p = withTree(steepDefaultTree());
    expect(workCost(evaluatedExpression(p, 'density', ''), p)).toBe(17451 + 2);
    expect(memoWorkCost(evaluatedExpression(p, 'density', ''), p)).toEqual({ voxel: 181, corner: 1104 });
    // 32 × (32 × (181 + 5,120) + 256 × 1,104) = 14,472,192: 2,305,024 below DRAFT_BUDGET (6,435,840 above it without the
    // memo-aware bound, at Task 9's wet roof).
    for (const e of SLICE_EXTENTS) expect(DRAFT_BUDGET - 32 * sliceCostOf(p, 'density', '', 'horizontal', 32, e), `E ${e}`).toBe(2_305_024);
    expect(SLICE_EXTENTS.map((e) => 128 * sliceCostOf(p, 'density', '', 'horizontal', 128, e) <= REQUEST_BUDGET)).toEqual([true, false, false, false, false, false]);
    expect(REQUEST_BUDGET - 128 * sliceCostOf(p, 'density', '', 'horizontal', 128, 256)).toBe(1_015_808);
    // Its vertical 128² slice samples columns (no corner steep).
    expect(128 * sliceCostOf(p, 'density', '', 'vertical', 128)).toBeLessThanOrEqual(REQUEST_BUDGET);
  });

  test('blocks: one T column per sample column; rule: plus n × the rule node count', () => {
    const t = tColumnCost(DEFAULTS);
    expect(sliceCostOf(DEFAULTS, 'blocks', '', 'vertical', 128)).toBe(t);
    expect(sliceCostOf(DEFAULTS, 'blocks', '', 'vertical', 32)).toBe(t);
    expect(sliceCostOf(DEFAULTS, 'rule', 'root.rules[2]', 'vertical', 128)).toBe(t + 128 * 163);
    expect(sliceCostOf(DEFAULTS, 'rule', 'root', 'vertical', 32)).toBe(t + 32 * 163);
  });

  test('caves (SP6a §7.4): n × (voxel + 64) + the chunk columns visited; vertical with K × corner, horizontal with 50 corners per visit', () => {
    // A visit: the ColumnSample (COLUMN_SAMPLE_COST) and the carver window (32,768); on a horizontal plane also the 50
    // corners at one y of its chunk column (50 × 1,104 at the defaults).
    const visitV = COLUMN_SAMPLE_COST + 32768;
    const visitH = visitV + 50 * 1104;
    for (const n of [32, 128]) {
      expect(sliceCostOf(DEFAULTS, 'caves', '', 'vertical', n)).toBe(n * (179 + 64) + 196 * 1104 + visitV);
      expect(sliceCostOf(DEFAULTS, 'caves', '', 'vertical', n, 8192)).toBe(sliceCostOf(DEFAULTS, 'caves', '', 'vertical', n));
    }
    expect(sliceCostOf(DEFAULTS, 'caves', '', 'vertical', 128)).toBe(313_024);
    // Horizontal: ⌈(the row's chunk columns, over every alignment) × visit / r⌉, r = max(1, ⌊16n / E⌋) rows per chunk row.
    const rows = (n: number, e: number) => Math.max(1, Math.floor((16 * n) / e));
    const chunks128 = [17, 33, 65, 128, 128, 128];
    const chunks32 = [17, 32, 32, 32, 32, 32];
    SLICE_EXTENTS.forEach((e, i) => {
      expect(sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 128, e), `128 at ${e}`).toBe(128 * 243 + Math.ceil((chunks128[i]! * visitH) / rows(128, e)));
      expect(sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 32, e), `32 at ${e}`).toBe(32 * 243 + Math.ceil((chunks32[i]! * visitH) / rows(32, e)));
    });
    expect(sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 128, 256)).toBe(287_668);
    // It follows the configured tree's work (the stage's compile of the resolved tree), not the selection.
    const steep = withTree(steepTree());
    const w = memoWorkCost(evaluatedExpression(steep, 'density', ''), steep);
    expect(sliceCostOf(steep, 'caves', '', 'vertical', 128)).toBe(128 * (w.voxel + 64) + 196 * w.corner + visitV);
    expect(sliceCostOf(DEFAULTS, 'caves', 'root', 'vertical', 128)).toBe(313_024);
    expect(() => sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 128)).toThrow(/extent/);
  });

  test('caves is refusable like density: the vertical draft and 128², the horizontal 128² at 256 and 512 admitted; every horizontal draft and the 128² from 1024 refused', () => {
    expect(isRefusableField('caves')).toBe(true);
    const refused = (cost: number, n: number, budget: number) => planFieldSlice(n, cost, 4, budget).refused;
    expect(refused(sliceCostOf(DEFAULTS, 'caves', '', 'vertical', 32), 32, DRAFT_BUDGET)).toBe(false);
    expect(refused(sliceCostOf(DEFAULTS, 'caves', '', 'vertical', 128), 128, REQUEST_BUDGET)).toBe(false);
    expect(SLICE_EXTENTS.map((e) => refused(sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 128, e), 128, REQUEST_BUDGET))).toEqual([false, false, true, true, true, true]);
    // A horizontal draft visits a chunk column per sample (a 32² draft's samples share few): refused, so the 256 and 512
    // planes ask for the 128² slice at once (ruling R9); from 1024 nothing is drawn but the notice.
    expect(SLICE_EXTENTS.map((e) => refused(sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 32, e), 32, DRAFT_BUDGET))).toEqual([true, true, true, true, true, true]);
    // The 512 plane's margin: 128 × 1,027,176 of REQUEST_BUDGET.
    expect(REQUEST_BUDGET - 128 * sliceCostOf(DEFAULTS, 'caves', '', 'horizontal', 128, 512)).toBe(2_739_200);
  });

  test('the costs follow the configured params: a muted tap and the noise octaves', () => {
    const muted = withTree(terrainMuted(0));
    expect(sliceCostOf(muted, 'node', 'root.a.a.a.x.a.x', 'vertical', 128)).toBe(sliceCostOf(DEFAULTS, 'node', 'root.a.a.a.x.a.x', 'vertical', 128));
    // Muting the terrain tap drops its interpolated(ref body) from the evaluated tree (workCost: one body read of 8 ×
    // 69 fewer), but the memo still evaluates the body once per corner for its other readers: the same memoised cost.
    expect(workCost(evaluatedExpression(muted, 'density', ''), muted)).toBeLessThan(workCost(evaluatedExpression(DEFAULTS, 'density', ''), DEFAULTS));
    expect(sliceCostOf(muted, 'density', '', 'vertical', 128)).toBe(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128));
    const octaves = paramsWith({ density: { noises: { detail: { octaves: 4 } } } } as never);
    expect(workCost(evaluatedExpression(octaves, 'density', ''), octaves)).toBe(17451 - 8 + 32);
    expect(sliceCostOf(octaves, 'density', '', 'vertical', 128)).toBe(sliceCostOf(DEFAULTS, 'density', '', 'vertical', 128) + 128 * (32 - 8));
    // A cave noise's octaves count too (SP6a §1.5): entrance 2 → 5 octaves at its 8 corner reads (once per corner).
    const cave = paramsWith({ caves: { noises: { entrance: { octaves: 5, amplitudes: null } } } } as never);
    expect(workCost(evaluatedExpression(cave, 'density', ''), cave)).toBe(17451 - 8 * 8 + 8 * 20);
    expect(memoWorkCost(evaluatedExpression(cave, 'density', ''), cave)).toEqual({ voxel: 179, corner: 1104 - 8 + 20 });
  });

  test('refusals: an n outside SLICE_NS, blocks or rule on a horizontal plane, a path naming no node', () => {
    expect(() => sliceCostOf(DEFAULTS, 'density', '', 'vertical', 64)).toThrow(RangeError);
    expect(() => sliceCostOf(DEFAULTS, 'blocks', '', 'horizontal', 128, 256)).toThrow(/no horizontal slice/);
    expect(() => sliceCostOf(DEFAULTS, 'rule', 'root', 'horizontal', 32, 256)).toThrow(/no horizontal slice/);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root.zz', 'vertical', 32)).toThrow(RangeError);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root.a.lo', 'vertical', 32)).toThrow(RangeError);
    // A horizontal density or node slice needs an extent of SLICE_EXTENTS.
    expect(() => sliceCostOf(DEFAULTS, 'density', '', 'horizontal', 32)).toThrow(/extent/);
    expect(() => sliceCostOf(DEFAULTS, 'node', 'root', 'horizontal', 128, 100)).toThrow(/extent/);
  });
});

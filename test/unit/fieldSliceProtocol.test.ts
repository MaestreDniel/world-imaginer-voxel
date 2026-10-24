import { describe, expect, test } from 'vitest';
import * as core from '../../src/core/constants';
import {
  COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, DRAFT_BUDGET, fieldSliceBytes, fieldSlicePartProblem, isRefusableField, PART_BUDGET,
  parseFromWorker, parseToWorker, planFieldSlice, REQUEST_BUDGET, SLICE_RULE_NA, type FieldSlicePlan,
} from '../../src/workers/protocol';
import { workCost } from '../../src/gen/inspect/cost';
import { evaluatedExpression, sliceCostOf } from '../../src/gen/inspect/fieldSlice';
import { paramsWith } from '../harness/gen';
import { steepTree } from './fixtures/editedTrees';

const V = { type: 'fieldSlice', jobId: 1, epoch: 2, scope: 2, plane: 'vertical', ax: -1664, az: 8, bx: -640, bz: 8, y: 63, n: 128, field: 'density', path: '', from: 0, to: 64 };
const H = { type: 'fieldSlice', jobId: 1, epoch: 2, scope: 2, plane: 'horizontal', cx: 0, cz: 0, y: 63, extent: 2048, n: 32, field: 'node', path: 'root.a', from: 3, to: 9 };
const P = { type: 'fieldProbe', jobId: 4, epoch: 2, scope: 2, field: 'rule', path: 'root.rules[2]', x: 5, y: 63, z: -9 };
const without = (m: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(m).filter(([key]) => key !== k));

describe('fieldSlice and fieldProbe messages: parseToWorker checks the shape only (SP3d spec §5.1, §5.3)', () => {
  test('both planes and the probe parse; values the handler refuses (n, window, y, extent, range, path) still parse', () => {
    for (const m of [V, H, P, { ...V, n: 64, ax: 9e9, y: 1000, from: -3, to: 1.5, path: 'nope' }, { ...H, extent: 300, cx: 0.5, field: 'blocks' }, { ...P, x: Number.NaN, field: 'density', path: '' }]) {
      expect(parseToWorker(m), JSON.stringify(m)).not.toBeNull();
    }
    expect(parseToWorker({ ...V, path: 'x'.repeat(512) })).not.toBeNull();
  });
  test('the plane\'s keys must be present and the other plane\'s absent; y is required on both planes', () => {
    for (const k of ['ax', 'az', 'bx', 'bz', 'y', 'n', 'from', 'to', 'path', 'field', 'jobId', 'epoch']) expect(parseToWorker(without(V, k)), `vertical without ${k}`).toBeNull();
    for (const k of ['cx', 'cz', 'y', 'extent', 'n', 'from', 'to', 'path', 'field']) expect(parseToWorker(without(H, k)), `horizontal without ${k}`).toBeNull();
    for (const k of ['cx', 'cz', 'extent']) expect(parseToWorker({ ...V, [k]: 0 }), `vertical with ${k}`).toBeNull();
    for (const k of ['ax', 'az', 'bx', 'bz']) expect(parseToWorker({ ...H, [k]: 0 }), `horizontal with ${k}`).toBeNull();
    expect(parseToWorker({ ...V, cx: undefined })).toBeNull();
  });
  test('types: integer jobId and epoch, numeric coordinates, a known plane and field, a path string of at most 512 characters', () => {
    for (const m of [
      { ...V, jobId: 1.5 }, { ...V, epoch: null }, { ...V, plane: 'diagonal' }, { ...V, field: 'steep' }, { ...V, field: 'constructor' }, { ...V, path: 3 },
      { ...V, path: 'x'.repeat(513) }, { ...V, ax: '0' }, { ...V, y: null }, { ...V, n: '128' }, { ...V, from: undefined }, { ...H, extent: '2048' }, { ...H, cz: null },
    ]) expect(parseToWorker(m), JSON.stringify(m).slice(0, 120)).toBeNull();
    for (const m of [{ ...P, field: 'blocks' }, { ...P, path: null }, { ...P, path: 'x'.repeat(513) }, { ...P, x: '1' }, without(P, 'z'), { ...P, jobId: 'a' }]) {
      expect(parseToWorker(m), JSON.stringify(m).slice(0, 120)).toBeNull();
    }
  });
});

describe('fieldSliceResult and fieldProbeResult: parseFromWorker and the guard-failure outcome (SP3d spec §5.1, §5.3)', () => {
  const result = (field: string, n: number, from: number, to: number, values: unknown, fluid: unknown = null, jobId: unknown = 7) =>
    ({ type: 'fieldSliceResult', jobId, epoch: 2, n, field, from, to, values, fluid });
  const ok = (field: string, n: number, from: number, to: number) => {
    const b = fieldSliceBytes(n, field as never, to - from);
    return result(field, n, from, to, new ArrayBuffer(b.values), b.fluid === 0 ? null : new ArrayBuffer(b.fluid));
  };

  test('the exact byte lengths: Float64 for density and node, u16 states plus u8 fluid for blocks, u8 for rule', () => {
    expect([fieldSliceBytes(128, 'density', 3), fieldSliceBytes(32, 'node', 32), fieldSliceBytes(128, 'blocks', 1), fieldSliceBytes(32, 'rule', 5)])
      .toEqual([{ values: 3072, fluid: 0 }, { values: 8192, fluid: 0 }, { values: 256, fluid: 128 }, { values: 160, fluid: 0 }]);
    for (const field of ['density', 'node', 'blocks', 'rule']) {
      for (const [n, from, to] of [[128, 0, 128], [32, 31, 32], [128, 79, 100]] as const) expect(parseFromWorker(ok(field, n, from, to)), `${field} ${n} [${from}, ${to})`).toMatchObject({ type: 'fieldSliceResult' });
    }
  });
  test('a readable envelope with a failing body is {bad, jobId, reason}: n, field, range and byte lengths', () => {
    const bad = (m: unknown) => parseFromWorker(m) as { bad?: boolean; jobId?: number; reason?: string } | null;
    const f64 = (k: number) => new ArrayBuffer(8 * k);
    for (const m of [
      result('density', 64, 0, 64, f64(64 * 64)), result('density', 128, 0, 129, f64(128 * 129)), result('density', 128, 5, 5, f64(0)), result('density', 128, 1.5, 3, f64(128)),
      result('steep', 32, 0, 1, f64(32)), result('density', 32, 0, 1, f64(31)), result('density', 32, 0, 1, new Float64Array(32)), result('density', 32, 0, 1, f64(32), new ArrayBuffer(32)),
      result('blocks', 32, 0, 1, new ArrayBuffer(64), null), result('blocks', 32, 0, 1, new ArrayBuffer(64), new ArrayBuffer(31)), result('blocks', 32, 0, 1, new ArrayBuffer(32), new ArrayBuffer(32)),
      result('rule', 32, 0, 2, new ArrayBuffer(63)), result('node', 32, 0, 1, f64(32), new ArrayBuffer(0)), { ...ok('rule', 32, 0, 1), epoch: null },
    ]) {
      const r = bad(m);
      expect(r, JSON.stringify(m)).toMatchObject({ bad: true, jobId: 7 });
      expect(typeof r!.reason).toBe('string');
      expect(r!.reason!.length).toBeGreaterThan(0);
    }
    expect(bad(result('density', 64, 0, 64, f64(64 * 64)))!.reason).toMatch(/^fieldSliceResult: n 64/);
    expect(bad(result('density', 32, 0, 1, f64(31)))!.reason).toBe('fieldSliceResult: values of 248 bytes, expected 256');
    // Without a readable jobId the reply is not a job's: null, as before.
    expect(parseFromWorker(result('density', 64, 0, 64, f64(64 * 64), null, 1.5))).toBeNull();
    expect(parseFromWorker(result('density', 32, 0, 1, f64(32), null, null))).toBeNull();
  });
  test('fieldProbeResult accepts any number, NaN and ±∞ included', () => {
    for (const value of [0, -1.5e300, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, SLICE_RULE_NA]) {
      const r = parseFromWorker({ type: 'fieldProbeResult', jobId: 3, epoch: 1, value });
      expect(r).toMatchObject({ type: 'fieldProbeResult', jobId: 3, epoch: 1 });
      expect(Object.is((r as { value: number }).value, value)).toBe(true);
    }
    for (const value of ['1', null, undefined, 1n]) expect(parseFromWorker({ type: 'fieldProbeResult', jobId: 3, epoch: 1, value })).toMatchObject({ bad: true, jobId: 3 });
  });
  test('every job reply with a readable jobId fails as {bad} rather than null, so the pool can free the worker', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ type: 'tile', jobId: 1, epoch: 0, rgba: new ArrayBuffer(10) }, /^tile: /],
      [{ type: 'pointResult', jobId: 1, epoch: 0, fields: null }, /^pointResult: /],
      [{ type: 'spawnResult', jobId: 1, epoch: 0 }, /^spawnResult: /],
      [{ type: 'statsResult', jobId: 1, epoch: 0, kind: 'nope', data: new ArrayBuffer(8) }, /^statsResult: /],
      [{ type: 'sliceResult', jobId: 1, epoch: 0, from: 0, to: 512, blocks: new ArrayBuffer(1), fluid: new ArrayBuffer(1) }, /^sliceResult: /],
      [{ type: 'surfaceProbeResult', jobId: 1, epoch: 0, state: -1, path: [] }, /^surfaceProbeResult: /],
      [{ type: 'selftestResult', jobId: 1, key: 3, actual: null, error: null }, /^selftestResult: /],
      [{ type: 'error', jobId: 1, epoch: 0, code: 5, message: 'x' }, /^error: /],
    ];
    for (const [m, reason] of cases) {
      const r = parseFromWorker(m) as { bad?: boolean; jobId?: number; reason?: string } | null;
      expect(r, JSON.stringify(m)).toMatchObject({ bad: true, jobId: 1 });
      expect(r!.reason).toMatch(reason);
    }
    for (const m of [{ type: 'ready', epoch: 'x' }, { type: 'nope', jobId: 1 }, 'x', null, { type: 'tile', jobId: '1' }, { type: 'error', jobId: null, epoch: 1.5, code: 'X', message: 'x' }]) expect(parseFromWorker(m)).toBeNull();
  });
});

describe('planFieldSlice: the one split and refusal math (SP3d spec §5.2, P3)', () => {
  const accepted = (p: FieldSlicePlan) => {
    if (p.refused) throw new Error(`refused, limit ${p.limit}`);
    return p;
  };
  /** §5.2's column cost of a density/node sample column of per-sample work cost c. */
  const vertical = (n: number, c: number) => n * c + COLUMN_SAMPLE_COST;
  const horizontal = (n: number, c: number) => n * (c + CORNER_SAMPLE_COST);

  test('the acquisition costs and budgets are core\'s, re-exported once', () => {
    expect([COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, PART_BUDGET, DRAFT_BUDGET, REQUEST_BUDGET, SLICE_RULE_NA])
      .toEqual([core.COLUMN_SAMPLE_COST, core.CORNER_SAMPLE_COST, core.CORNER_STEEP_COST, core.PART_BUDGET, core.DRAFT_BUDGET, core.REQUEST_BUDGET, core.SLICE_RULE_NA]);
    expect([PART_BUDGET, DRAFT_BUDGET, REQUEST_BUDGET]).toEqual([2 ** 23, 2 ** 24, 2 ** 27]);
  });
  test('at the defaults (c = 569): k = 79 vertical and 25 horizontal; parts max(poolSize, ⌈n / k⌉), equal contiguous ranges of at most k', () => {
    const v = accepted(planFieldSlice(128, vertical(128, 569), 6, REQUEST_BUDGET));
    expect([vertical(128, 569), v.k, v.ranges]).toEqual([105_600, 79, [[0, 21], [21, 42], [42, 64], [64, 85], [85, 106], [106, 128]]]);
    expect(accepted(planFieldSlice(128, vertical(128, 569), 1, REQUEST_BUDGET)).ranges).toEqual([[0, 64], [64, 128]]);
    const h = accepted(planFieldSlice(128, horizontal(128, 569), 2, REQUEST_BUDGET));
    expect([horizontal(128, 569), h.k, h.ranges.length]).toEqual([334_976, 25, 6]);
    expect(h.ranges).toEqual([[0, 21], [21, 42], [42, 64], [64, 85], [85, 106], [106, 128]]);
    expect(accepted(planFieldSlice(32, vertical(32, 569), 3, DRAFT_BUDGET)).ranges).toEqual([[0, 10], [10, 21], [21, 32]]);
  });
  test('refusal limits: a 128² slice above c = 7,936 vertical / 6,144 horizontal, a draft above 15,360 / 14,336; the limit is the largest column cost accepted', () => {
    for (const [n, budget, cost, c] of [
      [128, REQUEST_BUDGET, vertical, 7936], [128, REQUEST_BUDGET, horizontal, 6144], [32, DRAFT_BUDGET, vertical, 15_360], [32, DRAFT_BUDGET, horizontal, 14_336],
    ] as const) {
      expect(planFieldSlice(n, cost(n, c), 6, budget).refused, `${n} c ${c}`).toBe(false);
      expect(planFieldSlice(n, cost(n, c + 1), 6, budget), `${n} c ${c + 1}`).toEqual({ refused: true, limit: Math.floor(budget / n) });
    }
    // One sample column above PART_BUDGET is refused whatever the budget.
    expect(planFieldSlice(4, PART_BUDGET + 1, 2, 2 ** 40)).toEqual({ refused: true, limit: PART_BUDGET });
    expect(accepted(planFieldSlice(4, PART_BUDGET, 2, 2 ** 40)).ranges).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
  });
  test('a steep-reading tree of default weight: its horizontal 128² slice and draft are planned, never refused with limit 0', () => {
    const steep = (n: number, c: number) => n * (c + CORNER_STEEP_COST);
    const p = paramsWith({ density: { defs: steepTree() } } as never);
    expect(workCost(evaluatedExpression(p, 'density', ''), p)).toBe(571);
    const full = accepted(planFieldSlice(128, sliceCostOf(p, 'density', '', 'horizontal', 128), 4, REQUEST_BUDGET));
    expect([sliceCostOf(p, 'density', '', 'horizontal', 128), full.k, full.ranges.length]).toEqual([steep(128, 571), 11, 12]);
    expect(accepted(planFieldSlice(32, sliceCostOf(p, 'node', 'root.b', 'horizontal', 32), 4, DRAFT_BUDGET)).ranges.length).toBe(4);
    // The steep refusal limits: 3,072 per sample for a 128² slice, 11,264 for a draft; above them the limit is planFieldSlice's.
    for (const [n, budget, c] of [[128, REQUEST_BUDGET, 3072], [32, DRAFT_BUDGET, 11_264]] as const) {
      expect(planFieldSlice(n, steep(n, c), 6, budget).refused, `${n} c ${c}`).toBe(false);
      expect(planFieldSlice(n, steep(n, c + 1), 6, budget), `${n} c ${c + 1}`).toEqual({ refused: true, limit: Math.floor(budget / n) });
    }
    // Every acquisition leaves a per-sample room of at least 1 under every budget (the notice never says "limit 0").
    for (const [n, budget] of [[32, DRAFT_BUDGET], [128, REQUEST_BUDGET]] as const) {
      const limit = Math.min(PART_BUDGET, Math.floor(budget / n));
      for (const per of [CORNER_SAMPLE_COST, CORNER_STEEP_COST]) expect(Math.floor(limit / n) - per, `${n} ${per}`).toBeGreaterThanOrEqual(1);
      expect(Math.floor((limit - COLUMN_SAMPLE_COST) / n), `${n} vertical`).toBeGreaterThanOrEqual(1);
    }
  });
  test('budget null (blocks, rule) is never refused: k = 1 and one part per sample column above PART_BUDGET / 2', () => {
    expect(['density', 'node', 'blocks', 'rule'].map((f) => isRefusableField(f as never))).toEqual([true, true, false, false]);
    const t = accepted(planFieldSlice(32, 5_006_893, 6, null));
    expect([t.k, t.ranges.length, t.ranges[31]]).toEqual([1, 32, [31, 32]]);
    expect(accepted(planFieldSlice(128, 64 * 5_006_893, 2, null)).ranges.length).toBe(128);
  });
  test('the parts are contiguous, cover [0, n), never exceed k, and each passes the handler\'s bound check', () => {
    for (const n of [32, 128]) {
      for (const size of [1, 2, 3, 6]) {
        for (const cc of [1, 569, 50_976, 105_600, PART_BUDGET / 4, 2_796_203, PART_BUDGET / 2 + 1, PART_BUDGET, 2 ** 31]) {
          for (const field of ['density', 'blocks'] as const) {
            const p = planFieldSlice(n, cc, size, field === 'density' ? 2 ** 40 : null);
            if (p.refused) { expect(cc).toBeGreaterThan(PART_BUDGET); continue; }
            expect(p.ranges[0]![0]).toBe(0);
            expect(p.ranges.at(-1)![1]).toBe(n);
            expect(p.ranges.length).toBe(Math.min(n, Math.max(size, Math.ceil(n / p.k))));
            p.ranges.forEach(([from, to], i) => {
              expect(to - from).toBeGreaterThan(0);
              expect(to - from).toBeLessThanOrEqual(p.k);
              if (i > 0) expect(from).toBe(p.ranges[i - 1]![1]);
              expect(fieldSlicePartProblem(to - from, cc, field), `${n} ${size} ${cc} ${field}`).toBeNull();
            });
          }
        }
      }
    }
  });
  test('the handler\'s bound: a density or node part of w columns above PART_BUDGET, a blocks or rule part of more than k columns', () => {
    expect(fieldSlicePartProblem(79, 105_600, 'density')).toBeNull();
    expect(fieldSlicePartProblem(80, 105_600, 'node')).toBe(`too heavy: 80 × 105600 work units exceed the part budget ${PART_BUDGET}`);
    expect(fieldSlicePartProblem(1, PART_BUDGET + 1, 'density')).toMatch(/^too heavy: /);
    expect(fieldSlicePartProblem(1, 2 ** 31, 'blocks')).toBeNull();
    expect(fieldSlicePartProblem(2, 5_006_893, 'rule')).toBe('too heavy: 2 sample columns of cost 5006893, at most 1 per part');
    expect(fieldSlicePartProblem(3, 2_000_000, 'blocks')).toBeNull();
    expect(fieldSlicePartProblem(5, 2_000_000, 'blocks')).toMatch(/^too heavy: /);
  });
  test('bad arguments are RangeErrors', () => {
    const cases: Array<[number, number, number, number | null]> = [[0, 1, 1, null], [1.5, 1, 1, null], [32, 0, 1, null], [32, Number.NaN, 1, null], [32, Infinity, 1, null], [32, 1, 0, null], [32, 1, 1.5, null], [32, 1, 1, 0], [32, 1, 1, Number.NaN]];
    for (const args of cases) {
      expect(() => planFieldSlice(...args), JSON.stringify(args)).toThrow(RangeError);
    }
  });
});

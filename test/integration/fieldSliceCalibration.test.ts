import { loadavg } from 'node:os';
import { describe, expect, test } from 'vitest';
import { COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, PART_BUDGET, REQUEST_BUDGET } from '../../src/core/constants';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { workCost } from '../../src/gen/inspect/cost';
import { createCornerSampler, evaluatedExpression, evaluateFieldSlice, horizontalCoord, sliceCostOf, type SliceGeometry } from '../../src/gen/inspect/fieldSlice';
import { surfaceContextOf } from '../../src/gen/surface/context';
import { validateParamTrees } from '../../src/gen/trees';
import { segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { planFieldSlice } from '../../src/workers/protocol';
import { paramsWith } from '../harness/gen';
import { noiseSumTree, PART_WORST_LEAVES, partWorstParams } from '../harness/sliceTrees';

/**
 * The work bound's calibration (SP3d spec §5.2 "Calibration", §9 `slice.partWorst`).
 *
 * Always run: `slice.partWorst`'s tree (`test/harness/sliceTrees.ts`) — an `interpolated` `add` of PART_WORST_LEAVES
 * `noise detail` leaves at 16 octaves, double — passes tier 2, and 253 is the largest leaf count whose 32-sample vertical
 * column fits PART_BUDGET.
 *
 * Run on demand on a quiet machine (`SLICE_CALIBRATION=1 npx vitest run --project integration
 * test/integration/fieldSliceCalibration.test.ts`): one thread, in-process, p50 of 9 runs, each on a fresh GenContext
 * (cold caches: the case right after an edit). It measures the unit (ns per work unit of reference evaluation, the
 * ColumnSamples already cached) on the default tree and on partWorst's tree, the time of a part at PART_BUDGET (the
 * default's 128² vertical part of k = 79 sample columns, its 128² horizontal part at extent 8192 of k = 25 rows, and
 * partWorst's one 32-sample column), and the three acquisition costs (a ColumnSample per chunk column along the mountain
 * line; a corner sample without and with steep at extent 8192, where no two samples share a corner) in units of the
 * default tree's unit. It prints `MEASUREMENT:` lines and fails — the spec's STOP — when a part at PART_BUDGET takes more
 * than 250 ms p50 or an acquisition cost differs from its constant by more than 2 ×.
 */
const CALIBRATE = process.env['SLICE_CALIBRATION'] === '1';
const MOUNTAIN: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const NEVER = (): boolean => false;
const RUNS = 9;
const PART_P50_MAX_MS = 250;

/** A sample column's work cost per sample of partWorst's tree with L leaves: 1 + 8 × (L − 1 adds + 128 L). */
const worstSampleCost = (leaves: number) => 1 + 8 * (leaves - 1 + 128 * leaves);

describe('slice.partWorst\'s tree (SP3d spec §9)', () => {
  test(`${PART_WORST_LEAVES} leaves: passes tier 2, and is the largest count whose 32-sample vertical column fits PART_BUDGET`, () => {
    const p = partWorstParams();
    expect(validateParamTrees(p)).toEqual([]);
    expect(p.density.noises.detail).toMatchObject({ octaves: 16, double: true });
    expect(workCost(evaluatedExpression(p, 'density', ''), p)).toBe(worstSampleCost(PART_WORST_LEAVES));
    expect(worstSampleCost(PART_WORST_LEAVES)).toBe(261_089);
    expect(sliceCostOf(p, 'density', '', 'vertical', 32)).toBe(32 * 261_089 + COLUMN_SAMPLE_COST);
    expect(sliceCostOf(p, 'density', '', 'vertical', 32)).toBe(8_387_616);
    expect(sliceCostOf(p, 'density', '', 'vertical', 32)).toBeLessThanOrEqual(PART_BUDGET);
    const more = partWorstParams(PART_WORST_LEAVES + 1);
    expect(validateParamTrees(more)).toEqual([]);
    expect(sliceCostOf(more, 'density', '', 'vertical', 32)).toBe(8_420_640);
    expect(sliceCostOf(more, 'density', '', 'vertical', 32)).toBeGreaterThan(PART_BUDGET);
  });
  test('the tree is a balanced add: its depth is ⌈log2 L⌉ adds under the interpolated', () => {
    let depth = 0;
    let level: unknown[] = [(noiseSumTree() as { root: { x: unknown } }).root.x];
    let leaves = 0;
    while (level.length > 0) {
      const next: unknown[] = [];
      for (const e of level as Array<Record<string, unknown>>) {
        if (e['op'] === 'add') next.push(e['a'], e['b']);
        else { expect(e).toEqual({ op: 'noise', id: 'detail' }); leaves++; }
      }
      if (next.length > 0) depth++;
      level = next;
    }
    expect([leaves, depth]).toEqual([PART_WORST_LEAVES, 8]);
  });
});

const now = () => Number(process.hrtime.bigint()) / 1e6;
const p50 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1]!;
const fresh = (params: Params): GenContext => createGenContext(seedFromInput('42'), params);
const vertical = (n: number): SliceGeometry => ({ plane: 'vertical', n, pointAt: (i) => segmentPointAt(MOUNTAIN, i, n) });
const HORIZONTAL_8192: SliceGeometry = { plane: 'horizontal', n: 128, cx: 0, cz: 0, y: 63, extent: 8192 };

interface Part { readonly name: string; readonly params: Params; readonly geometry: SliceGeometry; readonly to: number }
const PARTS: readonly Part[] = [
  { name: 'default vertical 128² part [0, 79)', params: DEFAULTS, geometry: vertical(128), to: 79 },
  { name: 'default horizontal 128² part at extent 8192 [0, 25)', params: DEFAULTS, geometry: HORIZONTAL_8192, to: 25 },
  { name: `partWorst (${PART_WORST_LEAVES} leaves) vertical 32² part [0, 1)`, params: partWorstParams(), geometry: vertical(32), to: 1 },
];

/** Times evaluateFieldSlice of [0, to): cold (fresh context) and, for vertical planes, warm (the same part again). */
function timePart(part: Part): { cold: number; warm: number } {
  const ctx = fresh(part.params);
  const req = { geometry: part.geometry, field: 'density' as const, path: '', from: 0, to: part.to };
  let t = now();
  evaluateFieldSlice(ctx, req, NEVER);
  const cold = now() - t;
  t = now();
  evaluateFieldSlice(ctx, req, NEVER);
  return { cold, warm: now() - t };
}

/**
 * SP3d final review (untrusted I1, workers I1): a slide's knot count is free in every cost model, so a fan-out of refs to
 * one long slide (the reference evaluator does not merge refs) must not run over the part budget. The tree: a balanced
 * `add` of `refs` refs to `defs.s = slide(const 1, knots)`, its work cost 3 × refs + 5 under the 128² limit.
 */
function slideFanParams(refs: number, knots: number): Params {
  let level: unknown[] = Array.from({ length: refs }, () => ({ op: 'ref', name: 's' }));
  while (level.length > 1) {
    const next: unknown[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push({ op: 'add', a: level[i], b: level[i + 1] });
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
  }
  const slide = { op: 'slide', x: { op: 'const', v: 1 }, knots: Array.from({ length: knots }, (_, i) => [-80 + (i * 400) / knots, (i % 3) - 1]) };
  return paramsWith({ density: { defs: { root: level[0], defs: { s: slide } } } } as never);
}

describe('a slide fan-out at the knot cap stays within the part budget (SP3d final review)', () => {
  test('1,024 knots are refused by tier 2 (TOO_MANY_KNOTS); at 64 knots the largest planned 128² part takes ≤ 250 ms', () => {
    expect(validateParamTrees(slideFanParams(2000, 1024)).map((i) => `${i.path}: ${i.code}`)).toEqual(['density.defs.defs.s.knots: TOO_MANY_KNOTS']);
    const p = slideFanParams(2000, 64);
    expect(validateParamTrees(p)).toEqual([]);
    const geometry = vertical(128);
    const plan = planFieldSlice(128, sliceCostOf(p, 'density', '', 'vertical', 128), 6, REQUEST_BUDGET);
    if (plan.refused) throw new Error(`refused, limit ${plan.limit}`);
    const widest = plan.ranges.reduce((a, r) => (r[1] - r[0] > a[1] - a[0] ? r : a));
    const ctx = fresh(p);
    const t = now();
    evaluateFieldSlice(ctx, { geometry, field: 'density', path: '', from: widest[0], to: widest[1] }, NEVER);
    const ms = now() - t;
    console.log(`MEASUREMENT: slide fan-out (2,000 refs, 64 knots): part [${widest[0]}, ${widest[1]}) of ${plan.ranges.length}, ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(PART_P50_MAX_MS);
  });
});

describe.runIf(CALIBRATE)('calibration of the work unit and the acquisition costs (SP3d spec §5.2) — SLICE_CALIBRATION=1', () => {
  test('a part at PART_BUDGET takes ≤ 250 ms p50 on one thread; the acquisition costs are within 2 × of their constants', () => {
    const lines: string[] = [`load average at start ${loadavg().map((v) => v.toFixed(2)).join(' ')}`];
    const units: Record<string, number> = {};
    const partP50: Record<string, number> = {};
    for (const part of PARTS) {
      const runs = Array.from({ length: RUNS }, () => timePart(part));
      const columnCost = sliceCostOf(part.params, 'density', '', part.geometry.plane, part.geometry.n);
      const c = workCost(evaluatedExpression(part.params, 'density', ''), part.params);
      const cold = p50(runs.map((r) => r.cold));
      partP50[part.name] = cold;
      lines.push(`${part.name}: ${part.to} × ${columnCost} = ${part.to * columnCost} units (${((100 * part.to * columnCost) / PART_BUDGET).toFixed(1)} % of PART_BUDGET), cold p50 ${cold.toFixed(1)} ms (min ${Math.min(...runs.map((r) => r.cold)).toFixed(1)}, max ${Math.max(...runs.map((r) => r.cold)).toFixed(1)})`);
      if (part.geometry.plane === 'vertical') {
        const warm = p50(runs.map((r) => r.warm));
        const evalUnits = part.to * part.geometry.n * c;
        units[part.name] = (warm * 1e6) / evalUnits;
        lines.push(`  unit: warm p50 ${warm.toFixed(1)} ms for ${part.to} × ${part.geometry.n} samples × ${c} units = ${evalUnits} units → ${units[part.name]!.toFixed(2)} ns/unit`);
      }
    }
    const unit = units[PARTS[0]!.name]!;

    // A ColumnSample per chunk column along the mountain line (z = 8: chunk row 0), on a fresh context, after one warm-up column.
    const columnRuns: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const columns = surfaceContextOf(fresh(DEFAULTS)).density.columns;
      columns.get(-200, 0);
      const t = now();
      for (let cx = -104; cx < -40; cx++) columns.get(cx, 0);
      columnRuns.push((now() - t) / 64);
    }
    // Corner samples at the 128² horizontal plane of extent 8192 centred on (0, 0), rows [0, 25): 3,200 samples 64 blocks apart.
    const cornerRuns = (steep: boolean): number[] => Array.from({ length: RUNS }, () => {
      const sampler = createCornerSampler(fresh(DEFAULTS), steep);
      sampler.sample(4096, 4096);
      const t = now();
      for (let j = 0; j < 25; j++) {
        const z = horizontalCoord(0, 8192, j, 128);
        for (let i = 0; i < 128; i++) sampler.sample(horizontalCoord(0, 8192, i, 128), z);
      }
      return (now() - t) / 3200;
    });
    const acquisitions: Array<[string, number, number]> = [
      ['COLUMN_SAMPLE_COST', p50(columnRuns), COLUMN_SAMPLE_COST],
      ['CORNER_SAMPLE_COST', p50(cornerRuns(false)), CORNER_SAMPLE_COST],
      ['CORNER_STEEP_COST', p50(cornerRuns(true)), CORNER_STEEP_COST],
    ];
    const ratios: Record<string, number> = {};
    for (const [name, ms, constant] of acquisitions) {
      const measured = (ms * 1e6) / unit;
      ratios[name] = measured / constant;
      lines.push(`${name}: ${(ms * 1000).toFixed(1)} µs p50 = ${Math.round(measured)} units at ${unit.toFixed(2)} ns/unit (constant ${constant}, ratio ${ratios[name]!.toFixed(2)})`);
    }
    lines.push(`load average at end ${loadavg().map((v) => v.toFixed(2)).join(' ')}`);
    for (const l of lines) console.log(`MEASUREMENT: ${l}`);

    for (const [name, ms] of Object.entries(partP50)) expect(ms, `${name}: p50 ${ms.toFixed(1)} ms`).toBeLessThanOrEqual(PART_P50_MAX_MS);
    for (const [name, r] of Object.entries(ratios)) expect(r >= 0.5 && r <= 2, `${name}: ratio ${r.toFixed(2)}`).toBe(true);
  }, 600_000);
});

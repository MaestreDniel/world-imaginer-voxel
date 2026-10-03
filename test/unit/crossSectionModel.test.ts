import { describe, expect, test } from 'vitest';
import { JobCancelled, type WorkerPool } from '../../src/engine/workerPool';
import {
  CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength, summarizeCrossSection, type CrossSectionProfile, type Segment,
} from '../../src/metrics/crossSection';
import {
  areaPath, createSectionRequests, CUT_ARMED, CUT_OFF, cutButton, cutClick, cutOverlay, flagRuns, nearestPoint, runSpan, sameSegment,
  sectionRange, sectionReadout, sectionStatus, sectionSummary, sectionView, segmentDistance, segmentText, waterRuns, type CutTool,
} from '../../src/ui/crossSection/model';
import type { Plot } from '../../src/ui/splineEditor/model';
import type { StatsArgs, StatsKind } from '../../src/workers/protocol';
import { ctxFor } from '../harness/gen';

const N = CROSS_SECTION_POINTS;
/** The metric test's coast line: sea, two river channels, two gorges and a lake at level 153 (seed 42, defaults). */
const COAST: Segment = { ax: 5120, az: 3072, bx: 6656, bz: 3072 };
const coastSum = (seed = '42'): Float64Array<ArrayBuffer> => {
  const out = new Float64Array(crossSectionLength());
  crossSectionInto(ctxFor(seed), COAST, 0, N, out);
  return out;
};
const coast = (): CrossSectionProfile => summarizeCrossSection(coastSum(), COAST);

/** A profile from per-point values (the fields of a crossSection sum), along 0 → 1022 on z = 0: point i is 2i blocks from A. */
interface Values {
  offset0?(i: number): number; offset?(i: number): number; sigma?(i: number): number; jag?(i: number): number;
  wet?(i: number): boolean; gorge?(i: number): boolean; lake?(i: number): number; water?(i: number): number;
}
const LINE: Segment = { ax: 0, az: 0, bx: 1022, bz: 0 };
function profileOf(v: Values): CrossSectionProfile {
  const sum = new Float64Array(crossSectionLength());
  for (let i = 0; i < N; i++) {
    const f = [v.offset0?.(i) ?? 70, v.offset?.(i) ?? 70, v.sigma?.(i) ?? 0, v.jag?.(i) ?? 0, v.wet?.(i) === true ? 1 : 0, v.gorge?.(i) === true ? 1 : 0,
      v.lake?.(i) ?? -Infinity, v.water?.(i) ?? -Infinity];
    f.forEach((x, k) => { sum[k * N + i] = x; });
  }
  return summarizeCrossSection(sum, LINE);
}
/** A plot where point i of LINE sits at x = 10 + i px and y = 100 − value px. */
const PLOT: Plot = { left: 10, top: 0, width: 511, height: 100, xMin: 0, xMax: 1022, yMin: 0, yMax: 100 };

describe('the cut-line tool (SP2b spec §4.5)', () => {
  test('armed, the first click sets A and the second B; clicks are rounded to whole blocks', () => {
    expect(cutClick(CUT_OFF, 1, 2)).toEqual({ tool: CUT_OFF, line: null, problem: null });
    const a = cutClick(CUT_ARMED, 5119.6, 3071.5);
    expect(a).toEqual({ tool: { mode: 'b', a: [5120, 3072] }, line: null, problem: null });
    const b = cutClick(a.tool, 6655.8, 3072.4);
    expect(b).toEqual({ tool: CUT_OFF, line: COAST, problem: null });
    const zero = cutClick(CUT_ARMED, -0.4, -0.5).tool;
    expect(zero.mode === 'b' && zero.a.every((v) => Object.is(v, 0))).toBe(true);
  });
  test('a click outside the half-open world window, or a B in A\'s block, is refused and the tool keeps waiting', () => {
    expect(cutClick(CUT_ARMED, 524287.6, 0)).toEqual({ tool: CUT_ARMED, line: null, problem: 'cut line: A (524288, 0) is outside the world window' });
    expect(cutClick(CUT_ARMED, -524288.4, 524287.4).tool).toEqual({ mode: 'b', a: [-524288, 524287] });
    const waiting: CutTool = { mode: 'b', a: [10, 20] };
    expect(cutClick(waiting, 0, -524288.6)).toEqual({ tool: waiting, line: null, problem: 'cut line: B (0, -524289) is outside the world window' });
    expect(cutClick(waiting, 10.3, 19.8)).toEqual({ tool: waiting, line: null, problem: 'cut line: B is in the same block as A; click another point' });
    expect(cutClick(CUT_ARMED, Number.NaN, 0).problem).toBe('cut line: A (NaN, 0) is outside the world window');
  });
  test('cutOverlay: the rubber band from A to the pointer while B is placed, else the line', () => {
    const line: Segment = { ax: 1, az: 2, bx: 3, bz: 4 };
    expect(cutOverlay(CUT_OFF, null, [5, 5])).toBeNull();
    expect(cutOverlay(CUT_ARMED, null, null)).toBeNull();
    expect(cutOverlay(CUT_OFF, line, [5, 5])).toEqual({ a: [1, 2], b: [3, 4], pending: false });
    expect(cutOverlay(CUT_ARMED, line, [5, 5])).toEqual({ a: [1, 2], b: [3, 4], pending: false });
    expect(cutOverlay({ mode: 'b', a: [7, 8] }, line, [5.5, 6])).toEqual({ a: [7, 8], b: [5.5, 6], pending: true });
    expect(cutOverlay({ mode: 'b', a: [7, 8] }, null, null)).toEqual({ a: [7, 8], b: [7, 8], pending: true });
  });
  test('cutButton: the toolbar button\'s label, tip and pressed state', () => {
    expect(cutButton(CUT_OFF)).toEqual({ label: 'Cut line', tip: 'Draw a cross-section line on the map: click its start A, then its end B', pressed: false });
    expect(cutButton(CUT_ARMED)).toEqual({ label: 'Cut line: click A', tip: 'Click the start A of the line on the map (Escape or this button cancels)', pressed: true });
    expect(cutButton({ mode: 'b', a: [0, 0] })).toEqual({ label: 'Cut line: click B', tip: 'Click the end B of the line on the map (Escape or this button cancels)', pressed: true });
  });
  test('segmentDistance: from a map point to the line, in blocks (a click within 6 px of the line shows its profile)', () => {
    expect(segmentDistance(COAST, 5888, 3072)).toBe(0);
    expect(segmentDistance(COAST, 5888, 3080)).toBe(8);
    expect(segmentDistance(COAST, 5100, 3072)).toBe(20);
    expect(segmentDistance(COAST, 6659, 3076)).toBe(5);
    expect(segmentDistance({ ax: 0, az: 0, bx: 10, bz: 10 }, 10, 0)).toBeCloseTo(Math.SQRT2 * 5, 12);
  });
  test('segmentText and sameSegment', () => {
    expect(segmentText(COAST)).toBe('A (5120, 3072) → B (6656, 3072) · 1 536 blocks');
    expect(segmentText({ ax: -100, az: 0, bx: 200, bz: -400 })).toBe('A (-100, 0) → B (200, -400) · 500 blocks');
    expect(sameSegment(COAST, { ...COAST })).toBe(true);
    expect(sameSegment(COAST, { ...COAST, bz: 3073 })).toBe(false);
    expect(sameSegment(null, null)).toBe(true);
    expect(sameSegment(COAST, null)).toBe(false);
  });
});

describe('the profile\'s requests and stale state', () => {
  test('sectionView and sectionStatus: none before a profile, fresh on its draft, stale from the next change or during a gesture', () => {
    expect(sectionView(null, 3, false)).toBe('none');
    expect(sectionView(3, 3, false)).toBe('fresh');
    expect(sectionView(3, 3, true)).toBe('stale');
    expect(sectionView(2, 3, false)).toBe('stale');
    expect(sectionStatus('none', false, false)).toBe('no line: press Cut line in the toolbar, then click A and B on the map');
    expect(sectionStatus('none', false, true)).toBe('the profile follows when the preview settles');
    expect(sectionStatus('none', true, true)).toBe('computing…');
    expect(sectionStatus('fresh', false, true)).toBe('');
    expect(sectionStatus('stale', false, true)).toBe('stale: updates when the preview settles');
    expect(sectionStatus('stale', true, true)).toBe('stale: computing…');
  });

  interface StatsCall {
    readonly kind: StatsKind;
    readonly n: number;
    readonly args: unknown;
    resolve(v: Float64Array<ArrayBuffer>): void;
    reject(e: unknown): void;
  }
  /** createSectionRequests over a fake session (epoch 3), a pool whose stats calls the test settles, and a visibility switch. */
  const requests = () => {
    const calls: StatsCall[] = [];
    const session = { state: { epoch: 3 }, inGesture: false };
    const failures: string[] = [];
    let visible = true;
    let changes = 0;
    const pool: Pick<WorkerPool, 'stats'> = {
      stats: <K extends StatsKind>(kind: K, n: number, args: StatsArgs<K>) =>
        new Promise<Float64Array<ArrayBuffer>>((resolve, reject) => { calls.push({ kind, n, args, resolve, reject }); }),
    };
    const r = createSectionRequests({ session, pool, visible: () => visible, changed: () => { changes++; }, failed: (m) => { failures.push(m); } });
    return { r, calls, session, failures, show: (v: boolean) => { visible = v; }, changes: () => changes };
  };
  const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

  test('requests crossSection for the line once per session epoch, only when settled, on screen, outside a gesture and with a line', async () => {
    const h = requests();
    h.r.request(true);
    expect(h.calls).toHaveLength(0);
    h.r.setLine(COAST);
    expect(h.r.line).toEqual(COAST);
    expect(h.changes()).toBe(1);
    h.r.request(false);
    h.show(false);
    h.r.request(true);
    h.show(true);
    h.session.inGesture = true;
    h.r.request(true);
    expect(h.calls).toHaveLength(0);
    h.session.inGesture = false;
    h.r.request(true);
    expect(h.calls.map((c) => [c.kind, c.n, c.args])).toEqual([['crossSection', 512, { len: 4096, ...COAST }]]);
    expect(h.r.pending).toBe(3);
    h.r.request(true);
    expect(h.calls).toHaveLength(1);
    h.calls[0]!.resolve(coastSum());
    await flush();
    expect(h.r.pending).toBeNull();
    expect(h.r.shown?.epoch).toBe(3);
    expect(h.r.shown?.value).toEqual(coast());
    expect(h.changes()).toBe(3);
    h.r.request(true);
    expect(h.calls).toHaveLength(1);
    h.session.state = { epoch: 4 };
    h.r.request(true);
    expect(h.calls).toHaveLength(2);
    expect([h.r.pending, h.r.shown?.epoch]).toEqual([4, 3]);
  });
  test('a new line drops the shown profile and the pending request; the same line again changes nothing', async () => {
    const h = requests();
    h.r.setLine(COAST);
    h.r.request(true);
    h.calls[0]!.resolve(coastSum());
    await flush();
    h.session.state = { epoch: 4 };
    h.r.request(true);
    const before = h.changes();
    h.r.setLine({ ...COAST });
    expect([h.changes(), h.r.pending, h.r.shown?.epoch]).toEqual([before, 4, 3]);
    const other: Segment = { ax: 0, az: 0, bx: 100, bz: 0 };
    h.r.setLine(other);
    expect([h.r.line, h.r.pending, h.r.shown]).toEqual([other, null, null]);
    h.calls[1]!.resolve(coastSum());
    await flush();
    expect(h.r.shown).toBeNull();
    h.r.request(true);
    expect(h.calls.map((c) => c.args)).toEqual([{ len: 4096, ...COAST }, { len: 4096, ...COAST }, { len: 4096, ...other }]);
    h.r.setLine(null);
    expect([h.r.line, h.r.pending]).toEqual([null, null]);
    h.r.request(true);
    expect(h.calls).toHaveLength(3);
  });
  test('JobCancelled keeps the last profile (stale) silently; any other error also reports the failure', async () => {
    const h = requests();
    h.r.setLine(COAST);
    h.r.request(true);
    h.calls[0]!.resolve(coastSum());
    await flush();
    const shown = h.r.shown;
    h.session.state = { epoch: 4 };
    h.r.request(true);
    h.calls[1]!.reject(new JobCancelled());
    await flush();
    expect([h.r.shown, h.r.pending, h.failures]).toEqual([shown, null, []]);
    expect(sectionView(h.r.shown!.epoch, h.session.state.epoch, false)).toBe('stale');
    h.r.request(true);
    h.calls[2]!.reject(new Error('BAD_ARGS: args.len 4095, expected 4096'));
    await flush();
    expect([h.r.shown, h.r.pending, h.failures]).toEqual([shown, null, ['BAD_ARGS: args.len 4095, expected 4096']]);
  });
});

describe('the plot model', () => {
  test('flagRuns: maximal runs of set flags as inclusive index ranges', () => {
    const p = profileOf({ wet: (i) => i === 0 || i === 5 || i === 6 || i === 511, gorge: (i) => i >= 300 && i < 310 });
    expect(flagRuns(p.riverWet)).toEqual([{ from: 0, to: 0 }, { from: 5, to: 6 }, { from: 511, to: 511 }]);
    expect(flagRuns(p.gorge)).toEqual([{ from: 300, to: 309 }]);
    expect(flagRuns(new Uint8Array(4))).toEqual([]);
  });
  test('waterRuns: water above the ground, at sea level or in a lake, one run per kind and level', () => {
    const p = profileOf({
      offset: (i) => (i < 100 ? 50 : i < 120 ? 66 : 120),
      water: (i) => (i < 120 ? 63 : i >= 300 && i < 310 ? 130 : i >= 310 && i < 315 ? 131 : -Infinity),
      lake: (i) => (i >= 300 && i < 310 ? 130 : i >= 310 && i < 315 ? 131 : -Infinity),
    });
    expect(waterRuns(p)).toEqual([
      { from: 0, to: 99, kind: 'sea', level: 63 },
      { from: 300, to: 309, kind: 'lake', level: 130 },
      { from: 310, to: 314, kind: 'lake', level: 131 },
    ]);
  });
  test('sectionRange: every drawn value and sea level, padded by 5 % (at least 4 blocks), whole blocks; jag up to a power of two from 8', () => {
    const p = profileOf({
      offset: (i) => (i < 100 ? 50 : 120), sigma: () => 3, jag: (i) => i / 10,
      water: (i) => (i < 100 ? 63 : i >= 300 && i < 310 ? 130 : -Infinity), lake: (i) => (i >= 300 && i < 310 ? 130 : -Infinity),
    });
    expect(sectionRange(p)).toEqual({ lo: 42, hi: 135, jagMax: 64 });
    expect(sectionRange(profileOf({ offset: () => 64 }))).toEqual({ lo: 59, hi: 74, jagMax: 8 });
    const c = coast();
    const r = sectionRange(c);
    let lo = 63;
    let hi = 63;
    for (let i = 0; i < N; i++) {
      for (const v of [c.offset0[i]!, c.offset[i]! - c.sigma[i]!, c.offset[i]! + c.sigma[i]!, c.surfaceWaterLevel[i]!, c.lakeLevel[i]!]) {
        if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
    }
    expect(r.lo).toBe(Math.floor(lo - Math.max(4, (hi - lo) * 0.05)));
    expect(r.hi).toBe(Math.ceil(hi + Math.max(4, (hi - lo) * 0.05)));
    expect(r.jagMax).toBe(64);
  });
  test('areaPath and runSpan: polygons over a run, widened by half a point spacing at each end on request, clamped to the line', () => {
    const p = profileOf({});
    expect(areaPath(PLOT, p, { from: 2, to: 4 }, () => 50, () => 10, false)).toBe('M12,50L13,50L14,50L14,90L13,90L12,90Z');
    expect(areaPath(PLOT, p, { from: 2, to: 4 }, () => 50, () => 10, true)).toBe('M11.5,50L12,50L13,50L14,50L14.5,50L14.5,90L14,90L13,90L12,90L11.5,90Z');
    expect(areaPath(PLOT, p, { from: 0, to: 0 }, (i) => 50 + i, () => 0, true)).toBe('M10,50L10.5,50L10.5,100L10,100Z');
    expect(areaPath(PLOT, p, { from: 511, to: 511 }, () => 25.25, () => 0, true)).toBe('M520.5,74.75L521,74.75L521,100L520.5,100Z');
    expect(runSpan(PLOT, p, { from: 2, to: 4 })).toEqual({ x0: 11.5, x1: 14.5 });
    expect(runSpan(PLOT, p, { from: 0, to: 511 })).toEqual({ x0: 10, x1: 521 });
  });
  test('nearestPoint: the point under a plot pixel, clamped to the line', () => {
    expect([13.4, 13.6, 10, -50, 1000, Number.NaN].map((px) => nearestPoint(PLOT, px))).toEqual([3, 4, 0, 0, 511, 0]);
  });
  test('sectionSummary and sectionReadout on the coast line', () => {
    const c = coast();
    expect(sectionSummary(c)).toBe('offset 22.1 to 209.1 blocks · water on 48.0 % of the line · 2 river channels · 2 gorges · 1 lake at 153');
    expect(sectionReadout(c, 318)).toBe('955.9 blocks from A · x 6075.9 z 3072.0 · offset0 143.20 · offset 90.65 ± 0.50 · jag 0.00 · gorge');
    const sea = `0.0 blocks from A · x 5120.0 z 3072.0 · offset0 ${c.offset0[0]!.toFixed(2)} · offset ${c.offset[0]!.toFixed(2)} ± ${c.sigma[0]!.toFixed(2)} · jag 0.00`;
    expect(sectionReadout(c, 0)).toBe(`${sea} · water at sea level 63, ${(63 - c.offset[0]!).toFixed(2)} deep`);
    expect(sectionReadout(c, 480)).toMatch(/ · lake at 153, \d+\.\d\d deep$/);
    expect(sectionReadout(c, 257)).toMatch(/ · water at sea level 63, \d+\.\d\d deep · river channel$/);
    expect(sectionReadout(c, 269)).toMatch(/ · jag \d+\.\d\d · river channel$/);
    expect(sectionSummary(profileOf({ offset: (i) => 60 + i / 100 }))).toBe('offset 60.0 to 65.1 blocks · water on 0.0 % of the line · no river channel · no gorge · no lake');
  });
  test('the coast line\'s runs: sea, rivers, gorges and the lake', () => {
    const c = coast();
    expect(waterRuns(c)).toEqual([
      { from: 0, to: 198, kind: 'sea', level: 63 }, { from: 221, to: 231, kind: 'sea', level: 63 }, { from: 257, to: 258, kind: 'sea', level: 63 },
      { from: 465, to: 498, kind: 'lake', level: 153 },
    ]);
    expect(flagRuns(c.riverWet)).toEqual([{ from: 257, to: 259 }, { from: 268, to: 271 }]);
    expect(flagRuns(c.gorge)).toEqual([{ from: 317, to: 319 }, { from: 350, to: 351 }]);
  });
});

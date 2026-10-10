/**
 * The slice viewer's drawing model (SP3d spec §4.3, §4.1 field select, §3.7 first show, §6 `sliceModel.test.ts`): the
 * diverging colormap (auto and fixed scale, s = 0 drawn white with "constant 0", the fixed scale's accepted range), the
 * 0-level contour by marching squares, the 64-bin histogram with nearest-rank p1/p50/p99, sd and % < 0 against
 * hand-computed values (incl. p1 = p99), the field select and `selected`'s resolution, `initialSliceState` and the
 * vertical empty state, and the model's use of the geometry (Task 11's `gen/inspect/fieldSlice.ts` functions and
 * metrics' `segmentPointAt`; the formulas themselves are pinned by `fieldSliceGeometry.test.ts`, not re-derived here);
 * and the request stream (§4.5) with a fake pool of deferred promises: draft then full, supersession (cancel, discarded
 * results: P1), stale and failed states, requests on the pool's resolved configure, the node path in the key only for
 * `selected`, and the work bound's two notices with `planFieldSlice`'s limits (P3).
 */
import { describe, expect, test } from 'vitest';
import { COLUMN_SAMPLE_COST, CORNER_SAMPLE_COST, CORNER_STEEP_COST, DRAFT_BUDGET, REQUEST_BUDGET, SLICE_RULE_NA } from '../../src/core/constants';
import { WINDOW_HALF } from '../../src/core/coords';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { JobCancelled, SliceTooHeavy, type FieldSliceOptions, type FieldSliceResult } from '../../src/engine/workerPool';
import { horizontalCoord, sliceCostOf, sliceRowY, sliceSampleVoxel, squareProblem } from '../../src/gen/inspect/fieldSlice';
import { segmentPointAt, segmentProblem, type Segment } from '../../src/metrics/crossSection';
import { voxelRgb } from '../../src/ui/crossSection/voxels';
import type { Selection } from '../../src/ui/inspector/model';
import {
  autoScale, blocksLegend, blocksRgba, clampCentre, contourSegments, divergingRgb, FIELD_CHOICES, fieldOptions, formatSliceValue,
  histogram, histogramLabels, imageOrder, initialSliceState, levelLine, NO_LINE_TEXT, parseScale, pixelSample, pixelVoxel,
  ruleRgba, ruleShare, ruleShareText, resolveField, SCALE_MAX, SLICE_BLUE, SLICE_DEFAULT_EXTENT, SLICE_DEFAULT_Y, SLICE_GREY,
  SLICE_RED, SLICE_WHITE, RULE_NA, RULE_OFF, RULE_ON, scaleOf, sliceAxisLabels, sliceEmptyText, sliceGeometryOf, sliceRgba,
  sliceStats, type SliceState,
  createFieldSliceRequests, fieldSliceSpec, fieldSliceView, sliceRequestKey, tooHeavyText, BLOCKS_HORIZONTAL_NOTE, RULE_HORIZONTAL_NOTE,
  SLICE_DRAFT_N, SLICE_DRAFT_PRIORITY, SLICE_FULL_N, SLICE_FULL_PRIORITY, type ConfiguredDraft, type SliceWant,
} from '../../src/ui/inspector/sliceModel';
import { planFieldSlice, type FieldSliceSpec } from '../../src/workers/protocol';
import { partWorstParams } from '../harness/sliceTrees';
import { paramsWith } from '../harness/gen';
import { steepTree } from './fixtures/editedTrees';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { AIR, REGISTRY, STONE } from '../../src/world/blocks/index';

const W = WINDOW_HALF;
const pixel = (img: Uint8ClampedArray, i: number): number[] => [img[4 * i]!, img[4 * i + 1]!, img[4 * i + 2]!, img[4 * i + 3]!];
const rgb = (img: Uint8ClampedArray, i: number): number[] => pixel(img, i).slice(0, 3);
const DENSITY_SEL: Selection = { leaf: 'density.defs', path: 'root.a.x' };
const RULE_SEL: Selection = { leaf: 'surface.rules', path: 'root.rules[1]' };
const LINE: Segment = { ax: -1664, az: 8, bx: -640, bz: 8 };
const DIAG: Segment = { ax: -27136.5, az: -31992.25, bx: -26113.75, bz: -31000.5 };

describe('colormap', () => {
  test('diverging and centred on 0: blue below, white at 0, red above, linear in v / s clamped to [-1, 1]', () => {
    expect(divergingRgb(0, 1)).toEqual(SLICE_WHITE);
    expect(divergingRgb(-0, 1)).toEqual(SLICE_WHITE);
    expect(divergingRgb(1, 1)).toEqual(SLICE_RED);
    expect(divergingRgb(-1, 1)).toEqual(SLICE_BLUE);
    expect(divergingRgb(250, 2)).toEqual(SLICE_RED);
    expect(divergingRgb(-1e300, 2)).toEqual(SLICE_BLUE);
    // Halfway: the white–end average per channel, rounded.
    const half = (end: readonly number[]) => end.map((c) => Math.round(255 + (c - 255) * 0.5));
    expect(divergingRgb(2, 4)).toEqual(half(SLICE_RED));
    expect(divergingRgb(-2, 4)).toEqual(half(SLICE_BLUE));
    const quarter = (end: readonly number[]) => end.map((c) => Math.round(255 + (c - 255) * 0.25));
    expect(divergingRgb(0.25, 1)).toEqual(quarter(SLICE_RED));
  });

  test('s = 0 draws every sample white; a non-finite value is grey whatever the scale', () => {
    for (const v of [0, 5, -5, 1e100]) expect(divergingRgb(v, 0)).toEqual(SLICE_WHITE);
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(divergingRgb(v, 1)).toEqual(SLICE_GREY);
      expect(divergingRgb(v, 0)).toEqual(SLICE_GREY);
    }
  });

  test('the fixed scale is accepted when finite and in (0, 1e100]', () => {
    expect(SCALE_MAX).toBe(1e100);
    expect(parseScale('2')).toBe(2);
    expect(parseScale(' 0.5 ')).toBe(0.5);
    expect(parseScale('1e100')).toBe(1e100);
    expect(parseScale('5e-324')).toBe(5e-324);
    for (const t of ['', ' ', '0', '-0', '-1', '1e101', 'Infinity', 'NaN', 'abc', '1e999']) expect(parseScale(t)).toBeNull();
  });

  test('the auto scale is max(|p1|, |p99|) of the finite values; a fixed scale replaces it', () => {
    const v = Float64Array.from({ length: 100 }, (_, i) => i - 89); // -89 … 10
    const st = sliceStats(v)!;
    expect([st.p1, st.p99]).toEqual([-89, 9]);
    expect(autoScale(st)).toBe(89);
    expect(scaleOf(st, null)).toBe(89);
    expect(scaleOf(st, 4)).toBe(4);
    expect(autoScale(null)).toBe(0);
    expect(scaleOf(null, null)).toBe(0);
  });

  test('a constant 0 field (a tap muted to 0): auto scale 0, every pixel white, the histogram says "constant 0"', () => {
    const n = 32;
    const v = new Float64Array(n * n);
    const st = sliceStats(v)!;
    expect(autoScale(st)).toBe(0);
    const img = sliceRgba(v, n, 'vertical', scaleOf(st, null));
    for (let i = 0; i < n * n; i++) expect(pixel(img, i)).toEqual([...SLICE_WHITE, 255]);
    expect(histogramLabels(st)).toEqual(['constant 0']);
  });

  test('the image is in plane order and draws a non-finite sample grey', () => {
    const n = 2;
    // Sample (c, k) at c·n + k. Vertical: c is the pixel column, k the row; horizontal: c is the row (z), k the column (x).
    const v = Float64Array.from([1, NaN, -1, 0]);
    const vert = sliceRgba(v, n, 'vertical', 1);
    expect([rgb(vert, 0), rgb(vert, 1), rgb(vert, 2), rgb(vert, 3)]).toEqual([SLICE_RED, SLICE_BLUE, SLICE_GREY, SLICE_WHITE]);
    const hor = sliceRgba(v, n, 'horizontal', 1);
    expect([rgb(hor, 0), rgb(hor, 1), rgb(hor, 2), rgb(hor, 3)]).toEqual([SLICE_RED, SLICE_GREY, SLICE_BLUE, SLICE_WHITE]);
    for (let i = 0; i < 4; i++) expect(vert[4 * i + 3]).toBe(255);
  });

  test('imageOrder transposes a vertical plane and keeps a horizontal one', () => {
    const v = Uint16Array.from({ length: 9 }, (_, i) => i);
    expect(Array.from(imageOrder(v, 3, 'vertical'))).toEqual([0, 3, 6, 1, 4, 7, 2, 5, 8]);
    expect(imageOrder(v, 3, 'vertical')).toBeInstanceOf(Uint16Array);
    expect(imageOrder(v, 3, 'horizontal')).toBe(v);
    expect(() => imageOrder(v, 4, 'vertical')).toThrow(RangeError);
  });
});

describe('contour (marching squares on the sample grid, the 0 level: solid when v > 0)', () => {
  // Grids in image order (row-major, row 0 at the top); sample (px, py)'s centre at (px + 0.5, py + 0.5).
  const img = (rows: number[][]): Float64Array => Float64Array.from(rows.flat());

  test('one cell: the crossing is linear between the two samples of an edge', () => {
    expect(contourSegments(img([[-1, 1], [-1, 1]]), 2)).toEqual([[1, 0.5, 1, 1.5]]);
    expect(contourSegments(img([[-1, 3], [-1, 3]]), 2)).toEqual([[0.75, 0.5, 0.75, 1.5]]);
    expect(contourSegments(img([[1, 1], [-1, -3]]), 2)).toEqual([[0.5, 1, 1.5, 0.75]]);
    // One solid corner (top left): left edge to top edge.
    expect(contourSegments(img([[1, -1], [-1, -1]]), 2)).toEqual([[0.5, 1, 1, 0.5]]);
    // 0 is not solid: the crossing sits on the 0 sample.
    expect(contourSegments(img([[0, 2], [0, 2]]), 2)).toEqual([[0.5, 0.5, 0.5, 1.5]]);
  });

  test('no segment on a uniform cell; a non-finite sample is not solid and crosses at the midpoint', () => {
    expect(contourSegments(img([[1, 2], [3, 4]]), 2)).toEqual([]);
    expect(contourSegments(img([[-1, 0], [-3, -4]]), 2)).toEqual([]);
    expect(contourSegments(img([[NaN, 1], [NaN, 1]]), 2)).toEqual([[1, 0.5, 1, 1.5]]);
    expect(contourSegments(img([[Infinity, -1], [-1, -1]]), 2)).toEqual([]);
  });

  test('saddles are decided by the mean of the four samples', () => {
    // Top left and bottom right solid; mean 0 (not solid): the two solid corners are cut off.
    expect(contourSegments(img([[1, -1], [-1, 1]]), 2)).toEqual([[0.5, 1, 1, 0.5], [1, 1.5, 1.5, 1]]);
    // Mean 1: the solid corners join and the two air corners are cut off.
    expect(contourSegments(img([[3, -1], [-1, 3]]), 2)).toEqual([[1.25, 0.5, 1.5, 0.75], [0.5, 1.25, 0.75, 1.5]]);
    // The other diagonal.
    expect(contourSegments(img([[-1, 1], [1, -1]]), 2)).toEqual([[1, 0.5, 1.5, 1], [0.5, 1, 1, 1.5]]);
    expect(contourSegments(img([[-1, 3], [3, -1]]), 2)).toEqual([[0.5, 0.75, 0.75, 0.5], [1.25, 1.5, 1.5, 1.25]]);
  });

  test('a vertical plane solid below y 100 gives one horizontal line of n − 1 segments between the rows around y 100', () => {
    const n = 32;
    const v = new Float64Array(n * n);
    for (let c = 0; c < n; c++) for (let k = 0; k < n; k++) v[c * n + k] = 100 - sliceRowY(k, n);
    const segs = contourSegments(imageOrder(v, n, 'vertical'), n);
    expect(segs.length).toBe(n - 1);
    const r = Array.from({ length: n }, (_, k) => k).findIndex((k) => 100 - sliceRowY(k, n) > 0); // first solid row
    const above = 100 - sliceRowY(r - 1, n);
    const below = 100 - sliceRowY(r, n);
    const y = r - 1 + 0.5 + above / (above - below);
    for (const [i, s] of segs.entries()) expect(s).toEqual([i + 0.5, y, i + 1.5, y]);
  });

  test('a 3 × 3 grid with one solid centre gives a closed diamond of four segments', () => {
    const segs = contourSegments(img([[-1, -1, -1], [-1, 1, -1], [-1, -1, -1]]), 3);
    expect(segs.length).toBe(4);
    const pts = new Set(segs.flatMap(([x0, y0, x1, y1]) => [`${x0},${y0}`, `${x1},${y1}`]));
    expect([...pts].sort()).toEqual(['1,1.5', '1.5,1', '1.5,2', '2,1.5']);
  });
});

describe('histogram', () => {
  test('nearest-rank percentiles, population sd and % < 0 over 1 … 100 (shuffled)', () => {
    const v = Float64Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1);
    const st = sliceStats(v)!;
    expect(st).toEqual({ count: 100, nonFinite: 0, p1: 1, p50: 50, p99: 99, mean: 50.5, sd: Math.sqrt(833.25), below0: 0 });
    const h = histogram(v, st);
    expect([h.lo, h.hi, h.counts.length]).toEqual([1, 99, 64]);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(100);
    // Bin b holds v with ⌊(v − 1) / 98 · 64⌋ = b (bins 1.53 wide; 100 falls in the end bin): bin 0 holds 1, 2; bin 1 3, 4;
    // bin 62 96, 97; bin 63 98, 99 and 100.
    expect([h.counts[0], h.counts[1], h.counts[62], h.counts[63]]).toEqual([2, 2, 2, 3]);
    expect(histogramLabels(st)).toEqual(['p1 1 · p50 50 · p99 99', 'sd 28.87 · < 0: 0.0 %']);
  });

  test('a small sample with non-finite values: ranks ⌈q·N⌉, the non-finite counted apart', () => {
    const v = Float64Array.from([2, NaN, -1, 0, Infinity, -2, 1, -Infinity]);
    const st = sliceStats(v)!;
    expect(st).toEqual({ count: 5, nonFinite: 3, p1: -2, p50: 0, p99: 2, mean: 0, sd: Math.SQRT2, below0: 0.4 });
    const h = histogram(v, st);
    // 64 bins over [-2, 2]: -2 → 0, -1 → 16, 0 → 32, 1 → 48, 2 → 63 (the end bin); the non-finite are left out.
    expect([h.counts[0], h.counts[16], h.counts[32], h.counts[48], h.counts[63]]).toEqual([1, 1, 1, 1, 1]);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(histogramLabels(st)).toEqual(['p1 -2 · p50 0 · p99 2', 'sd 1.414 · < 0: 40.0 %', '3 non-finite']);
  });

  test('values outside [p1, p99] fall in the end bins; p1 = p99 gives one bar and "constant v"', () => {
    const v = new Float64Array(200).fill(5);
    v[17] = 7;
    v[150] = 3;
    const st = sliceStats(v)!;
    expect([st.p1, st.p50, st.p99]).toEqual([5, 5, 5]);
    const h = histogram(v, st);
    expect(h).toEqual({ lo: 5, hi: 5, counts: [200] });
    expect(histogramLabels(st)).toEqual(['constant 5']);
    const w = Float64Array.from({ length: 300 }, (_, i) => i);
    w[0] = -1e9;
    w[299] = 1e9;
    const sw = sliceStats(w)!;
    expect([sw.p1, sw.p99]).toEqual([2, 296]);
    const hw = histogram(w, sw);
    // Bins 4.59 wide over [2, 296]: bin 0 holds -1e9 and 1 (below p1) and 2 … 6; bin 63 holds 292 … 296 and 297, 298, 1e9.
    expect(hw.counts[0]).toBe(2 + 5);
    expect(hw.counts[63]).toBe(5 + 3);
  });

  test('no finite value: no statistics', () => {
    const st = sliceStats(Float64Array.from([NaN, Infinity]));
    expect(st).toBeNull();
    expect(histogramLabels(st)).toEqual(['no finite value']);
    expect(histogramLabels(sliceStats(Float64Array.from([NaN, 0, 0, 0])))).toEqual(['constant 0', '1 non-finite']);
  });

  test('value text: NaN, +∞, −∞, integers as they are, others to 4 significant digits', () => {
    expect([NaN, Infinity, -Infinity, 0, -0, 63, -1000000, 0.123456, 1e100, -2.5e-7].map(formatSliceValue))
      .toEqual(['NaN', '+∞', '−∞', '0', '0', '63', '-1000000', '0.1235', '1e+100', '-2.5e-7']);
  });
});

describe('blocks and rule fields', () => {
  test('blocks use the Voxels palette, water darker with depth in blocks from the top of its run', () => {
    const n = 32;
    const stone = STONE;
    const states = new Uint16Array(n * n);
    const fluid = new Uint8Array(n * n);
    // Sample column 3: air above y 100, water from y 100 down to y 40, stone below.
    for (let k = 0; k < n; k++) {
      const y = sliceRowY(k, n);
      states[3 * n + k] = y < 40 ? stone : AIR;
      fluid[3 * n + k] = y >= 40 && y < 100 ? WATER_SOURCE : 0;
    }
    const img = blocksRgba(states, fluid, n);
    const top = Array.from({ length: n }, (_, k) => k).find((k) => fluid[3 * n + k] !== 0)!;
    for (let k = 0; k < n; k++) {
      const want = voxelRgb(states[3 * n + k]!, fluid[3 * n + k]!, fluid[3 * n + k] !== 0 ? sliceRowY(top, n) - sliceRowY(k, n) : 0);
      expect(rgb(img, k * n + 3)).toEqual([...want]);
    }
    expect(rgb(img, 0)).toEqual([...voxelRgb(AIR, 0, 0)]);
    const legend = blocksLegend(states, fluid);
    expect(legend.map((k) => k.label)).toEqual([REGISTRY.stateKey(AIR), REGISTRY.stateKey(stone), 'water']);
    expect(() => blocksRgba(states, fluid.subarray(1), n)).toThrow(RangeError);
  });

  test('rule masks: two colours and grey for n/a; the share of 1s among the solid voxels', () => {
    const n = 2;
    const v = Uint8Array.from([1, RULE_NA, 0, 1]);
    const vert = ruleRgba(v, n, 'vertical');
    expect([rgb(vert, 0), rgb(vert, 1), rgb(vert, 2), rgb(vert, 3)]).toEqual([RULE_ON, RULE_OFF, SLICE_GREY, RULE_ON]);
    expect(RULE_NA).toBe(255);
    expect(RULE_NA).toBe(SLICE_RULE_NA);
    expect(ruleShare(v)).toEqual({ ones: 2, solid: 3, na: 1 });
    expect(ruleShareText(ruleShare(v))).toBe('rule share 66.7 % (2 of 3 solid voxels)');
    expect(ruleShareText(ruleShare(Uint8Array.from([RULE_NA, RULE_NA])))).toBe('no solid voxel');
  });
});

describe('field select', () => {
  test('density, selected and blocks; blocks and a rule node have no horizontal slice', () => {
    expect(FIELD_CHOICES).toEqual(['density', 'selected', 'blocks']);
    const on = (o: ReturnType<typeof fieldOptions>) => o.map((x) => [x.value, x.disabled]);
    expect(on(fieldOptions('vertical', DENSITY_SEL))).toEqual([['density', false], ['selected', false], ['blocks', false]]);
    expect(on(fieldOptions('vertical', RULE_SEL))).toEqual([['density', false], ['selected', false], ['blocks', false]]);
    expect(on(fieldOptions('horizontal', DENSITY_SEL))).toEqual([['density', false], ['selected', false], ['blocks', true]]);
    const hr = fieldOptions('horizontal', RULE_SEL);
    expect(on(hr)).toEqual([['density', false], ['selected', true], ['blocks', true]]);
    expect(hr[1]!.note).toBe('a rule node has a mask on vertical planes only');
    expect(hr[2]!.note).toBe('blocks have no horizontal slice');
    expect(fieldOptions('vertical', DENSITY_SEL).every((o) => o.note === null)).toBe(true);
  });

  test('selected follows the selection: a density node gives node, a rule node or condition rule', () => {
    expect(resolveField('density', 'vertical', RULE_SEL)).toEqual({ ok: true, field: 'density', path: '' });
    expect(resolveField('density', 'horizontal', DENSITY_SEL)).toEqual({ ok: true, field: 'density', path: '' });
    expect(resolveField('selected', 'vertical', DENSITY_SEL)).toEqual({ ok: true, field: 'node', path: 'root.a.x' });
    expect(resolveField('selected', 'horizontal', { leaf: 'density.defs', path: 'defs.base' })).toEqual({ ok: true, field: 'node', path: 'defs.base' });
    expect(resolveField('selected', 'vertical', RULE_SEL)).toEqual({ ok: true, field: 'rule', path: 'root.rules[1]' });
    expect(resolveField('selected', 'vertical', { leaf: 'surface.rules', path: 'root.rules[1].if.if' })).toEqual({ ok: true, field: 'rule', path: 'root.rules[1].if.if' });
    expect(resolveField('selected', 'horizontal', RULE_SEL)).toEqual({ ok: false, note: 'a rule node has a mask on vertical planes only' });
    expect(resolveField('blocks', 'vertical', DENSITY_SEL)).toEqual({ ok: true, field: 'blocks', path: '' });
    expect(resolveField('blocks', 'horizontal', DENSITY_SEL)).toEqual({ ok: false, note: 'blocks have no horizontal slice' });
  });
});

describe('first show and empty state', () => {
  test('vertical when a line exists, field density, y 63, extent 2048; the centre from the pin, else the view centre', () => {
    expect([SLICE_DEFAULT_Y, SLICE_DEFAULT_EXTENT]).toEqual([63, 2048]);
    expect(initialSliceState({ line: LINE, viewCentre: [10.7, -3.2], pin: null }))
      .toEqual({ plane: 'vertical', field: 'density', y: 63, extent: 2048, cx: 10, cz: -4 });
    expect(initialSliceState({ line: LINE, viewCentre: [10.7, -3.2], pin: [-500, 77] }))
      .toEqual({ plane: 'vertical', field: 'density', y: 63, extent: 2048, cx: -500, cz: 77 });
    expect(initialSliceState({ line: null, viewCentre: [10.7, -3.2], pin: null }))
      .toEqual({ plane: 'horizontal', field: 'density', y: 63, extent: 2048, cx: 10, cz: -4 });
    expect(initialSliceState({ line: null, viewCentre: [10.7, -3.2], pin: [-500.5, 77.9] }))
      .toEqual({ plane: 'horizontal', field: 'density', y: 63, extent: 2048, cx: -501, cz: 77 });
  });

  test('the centre is clamped into the world window for the extent', () => {
    expect(initialSliceState({ line: null, viewCentre: [W - 0.5, -W - 900], pin: null }))
      .toEqual({ plane: 'horizontal', field: 'density', y: 63, extent: 2048, cx: W - 1024, cz: -W + 1024 });
    expect(clampCentre(0, 0, 8192)).toEqual([0, 0]);
    expect(clampCentre(W, W, 8192)).toEqual([W - 4096, W - 4096]);
    expect(clampCentre(-W - 1e9, 3.99, 256)).toEqual([-W + 128, 3]);
    for (const e of [256, 512, 1024, 2048, 4096, 8192]) {
      const [cx, cz] = clampCentre(1e12, -1e12, e);
      expect(squareProblem(cx, cz, e)).toBeNull();
    }
    expect(() => clampCentre(0, 0, 300)).toThrow(RangeError);
    expect(() => clampCentre(NaN, 0, 256)).toThrow(RangeError);
  });

  test('the vertical plane without a line shows the empty-state text', () => {
    expect(NO_LINE_TEXT).toBe('Draw a cut line on the map for a vertical slice');
    const v: SliceState = initialSliceState({ line: LINE, viewCentre: [0, 0], pin: null });
    expect(sliceEmptyText(v, null)).toBe(NO_LINE_TEXT);
    expect(sliceEmptyText(v, LINE)).toBeNull();
    expect(sliceEmptyText({ ...v, plane: 'horizontal' }, null)).toBeNull();
  });
});

describe('the geometry, used from gen/inspect/fieldSlice.ts and metrics/crossSection.ts', () => {
  test('vertical: pixel (px, py) is sample point px, row py; the voxel is sliceSampleVoxel over segmentPointAt', () => {
    const s = initialSliceState({ line: DIAG, viewCentre: [0, 0], pin: null });
    for (const n of [32, 128]) {
      const g = sliceGeometryOf(s, DIAG, n);
      if (!g.ok) throw new Error(g.problem);
      expect(g.geometry.plane).toBe('vertical');
      const ref = { plane: 'vertical' as const, n, pointAt: (i: number) => segmentPointAt(DIAG, i, n) };
      for (const [px, py] of [[0, 0], [n - 1, n - 1], [5, 17], [n - 1, 0], [0, n - 1]] as const) {
        expect(pixelSample('vertical', n, px, py)).toEqual({ c: px, k: py });
        expect(pixelVoxel(g.geometry, px, py)).toEqual(sliceSampleVoxel(ref, px, py));
      }
      expect(pixelVoxel(g.geometry, 0, 0)).toEqual([Math.floor(DIAG.ax), sliceRowY(0, n), Math.floor(DIAG.az)]);
      expect(pixelVoxel(g.geometry, n - 1, n - 1)).toEqual([Math.floor(DIAG.bx), sliceRowY(n - 1, n), Math.floor(DIAG.bz)]);
    }
    expect(sliceGeometryOf(s, null, 32)).toEqual({ ok: false, problem: NO_LINE_TEXT });
    const same: Segment = { ax: 4, az: 4, bx: 4, bz: 4 };
    expect(sliceGeometryOf(s, same, 32)).toEqual({ ok: false, problem: segmentProblem(same) });
    expect(sliceGeometryOf(s, LINE, 64)).toEqual({ ok: false, problem: 'n 64 is not a slice size (32, 128)' });
  });

  test('horizontal: pixel (px, py) is sample x_px of row z_py; the voxel is sliceSampleVoxel; a square outside the window is a problem', () => {
    const s: SliceState = { plane: 'horizontal', field: 'density', y: 63, extent: 8192, cx: -301, cz: 1999 };
    for (const n of [32, 128]) {
      const g = sliceGeometryOf(s, LINE, n);
      if (!g.ok) throw new Error(g.problem);
      expect(g.geometry).toEqual({ plane: 'horizontal', n, cx: -301, cz: 1999, y: 63, extent: 8192 });
      for (const [px, py] of [[0, 0], [n - 1, n - 1], [7, 3]] as const) {
        expect(pixelSample('horizontal', n, px, py)).toEqual({ c: py, k: px });
        expect(pixelVoxel(g.geometry, px, py)).toEqual(sliceSampleVoxel(g.geometry, py, px));
        expect(pixelVoxel(g.geometry, px, py)).toEqual([horizontalCoord(-301, 8192, px, n), 63, horizontalCoord(1999, 8192, py, n)]);
      }
    }
    const edge: SliceState = { ...s, cx: W - 100 };
    expect(sliceGeometryOf(edge, null, 128)).toEqual({ ok: false, problem: squareProblem(W - 100, 1999, 8192) });
    const [cx, cz] = clampCentre(edge.cx, edge.cz, edge.extent);
    expect(sliceGeometryOf({ ...edge, cx, cz }, null, 128).ok).toBe(true);
    expect(sliceGeometryOf({ ...s, y: 320 }, null, 32)).toEqual({ ok: false, problem: 'y 320 is not an integer in [-64, 319]' });
    expect(() => pixelSample('horizontal', 32, 32, 0)).toThrow(RangeError);
    expect(() => pixelSample('vertical', 32, 0.5, 0)).toThrow(RangeError);
  });

  test('levels and axes: the y level at its voxel centre on a vertical image; the axes in blocks', () => {
    expect(levelLine(319, 128)).toBeCloseTo(0.5 * 128 / 384, 12);
    expect(levelLine(-64, 128)).toBeCloseTo(383.5 * 128 / 384, 12);
    expect(levelLine(63, 128)).toBeCloseTo((319.5 - 63) * 128 / 384, 12);
    const v = initialSliceState({ line: LINE, viewCentre: [0, 0], pin: null });
    expect(sliceAxisLabels(v, LINE)).toEqual({ left: 'A (-1664, 8)', right: 'B (-640, 8) · 1024 blocks', top: 'y 319', bottom: 'y -64' });
    expect(sliceAxisLabels({ ...v, plane: 'horizontal', cx: 0, cz: 100, extent: 256 }, null))
      .toEqual({ left: 'x -128', right: 'x 128', top: 'z -28', bottom: 'z 228' });
  });
});

describe('the request stream (§4.5: draft then full on the resolved configure, supersession, stale and failed)', () => {
  const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });
  interface Call {
    readonly req: FieldSliceSpec;
    readonly opts: FieldSliceOptions;
    resolve(r: FieldSliceResult): void;
    reject(e: unknown): void;
    cancelled: boolean;
  }
  /**
   * A fake pool of deferred promises: `cancel()` only records the cancellation (the real pool rejects JobCancelled at
   * once; here the stream's token must discard a result that still lands, as a running part's does, P1).
   */
  const harness = (params: Params = DEFAULTS) => {
    const calls: Call[] = [];
    const pool = {
      size: 3,
      epoch: 4,
      fieldSlice(req: FieldSliceSpec, opts: FieldSliceOptions) {
        let resolve!: (r: FieldSliceResult) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<FieldSliceResult>((a, b) => { resolve = a; reject = b; });
        const call: Call = { req, opts, resolve, reject, cancelled: false };
        calls.push(call);
        return { promise, cancel: () => { call.cancelled = true; } };
      },
    };
    const h = {
      calls, pool,
      session: { state: { epoch: 7 } },
      cfg: { poolEpoch: 4, sessionEpoch: 7, params } as ConfiguredDraft | null,
      visible: true,
      changes: 0,
    };
    const r = createFieldSliceRequests({
      pool: h.pool, session: h.session, configured: () => h.cfg, visible: () => h.visible, changed: () => { h.changes++; },
    });
    return { ...h, r, h };
  };
  const density = (n: number, v = n): FieldSliceResult => ({ n, field: 'density', values: new Float64Array(n * n).fill(v), fluid: null });
  const VERT: SliceState = { plane: 'vertical', field: 'density', y: 63, extent: 2048, cx: 0, cz: 0 };
  const HORI: SliceState = { ...VERT, plane: 'horizontal', cx: 100, cz: -200, extent: 512 };
  const TAP_TERRAIN: Selection = { leaf: 'density.defs', path: 'root.a.a' };
  const TAP_ISLANDS: Selection = { leaf: 'density.defs', path: 'root.b' };
  const want = (state: SliceState = VERT, line: Segment | null = LINE, selection: Selection = TAP_TERRAIN): SliceWant => ({ state, line, selection });

  test('a 32² draft at priority 2, then the 128² slice at priority 500, with sliceCostOf\'s column costs and the two budgets', async () => {
    expect([SLICE_DRAFT_N, SLICE_FULL_N, SLICE_DRAFT_PRIORITY, SLICE_FULL_PRIORITY]).toEqual([32, 128, 2, 500]);
    const { r, calls } = harness();
    r.request(want());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req).toEqual({ plane: 'vertical', ax: -1664, az: 8, bx: -640, bz: 8, y: 63, n: 32, field: 'density', path: '' });
    expect(calls[0]!.opts).toEqual({ priority: 2, columnCost: sliceCostOf(DEFAULTS, 'density', '', 'vertical', 32), budget: DRAFT_BUDGET });
    expect(r.key).toBe(sliceRequestKey(VERT, LINE, 'density', ''));
    expect(r.pending).toEqual({ sessionEpoch: 7, key: r.key, n: 32 });
    expect([r.shown, r.notice, fieldSliceView(r, 7)]).toEqual([null, null, 'none']);
    r.request(want());
    expect(calls).toHaveLength(1);
    const d = density(32);
    calls[0]!.resolve(d);
    await flush();
    expect(r.shown?.result).toBe(d);
    expect([r.shown?.sessionEpoch, r.shown?.key, fieldSliceView(r, 7)]).toEqual([7, r.key, 'fresh']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req).toEqual({ ...calls[0]!.req, n: 128 });
    expect(calls[1]!.opts).toEqual({ priority: 500, columnCost: 105_600, budget: REQUEST_BUDGET });
    expect(r.pending).toEqual({ sessionEpoch: 7, key: r.key, n: 128 });
    const f = density(128);
    calls[1]!.resolve(f);
    await flush();
    expect([r.shown?.result, r.pending, r.notice, fieldSliceView(r, 7)]).toEqual([f, null, null, 'fresh']);
    // The shown geometry is the result's: a pixel names the voxel that was evaluated.
    const g = sliceGeometryOf(VERT, LINE, 128);
    if (!g.ok) throw new Error(g.problem);
    expect(pixelVoxel(r.shown!.geometry, 127, 64)).toEqual(pixelVoxel(g.geometry, 127, 64));
    // One result per (session epoch, key): asking again sends nothing.
    r.request(want());
    expect(calls).toHaveLength(2);
  });

  test('a horizontal plane sends its own keys only, with the corner-sample cost', () => {
    const { r, calls } = harness();
    r.request(want(HORI, LINE));
    expect(calls[0]!.req).toEqual({ plane: 'horizontal', cx: 100, cz: -200, extent: 512, y: 63, n: 32, field: 'density', path: '' });
    expect(calls[0]!.opts.columnCost).toBe(32 * (569 + CORNER_SAMPLE_COST));
    expect(fieldSliceSpec(HORI, null, 'node', 'root.b', 128)).toEqual({ plane: 'horizontal', cx: 100, cz: -200, extent: 512, y: 63, n: 128, field: 'node', path: 'root.b' });
  });

  test('requests run on the pool\'s resolved configure, for the session epoch it holds; a newer session shows the slice stale', async () => {
    const { r, calls, h } = harness();
    h.cfg = null;
    r.request(want());
    expect([calls.length, r.pending]).toEqual([0, null]);
    expect(r.key).toBe(sliceRequestKey(VERT, LINE, 'density', ''));
    // A configure is in flight (the pool's epoch is past the resolved one): wait for its resolution.
    h.cfg = { poolEpoch: 5, sessionEpoch: 7, params: DEFAULTS };
    h.pool.epoch = 6;
    r.request(want());
    expect(calls).toHaveLength(0);
    h.pool.epoch = 5;
    r.request(want());
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(density(32));
    await flush();
    calls[1]!.resolve(density(128));
    await flush();
    // An edit: the session is at 8, the pool still holds 7's draft. Nothing new to ask; the slice is stale.
    h.session.state.epoch = 8;
    r.request(want());
    expect(calls).toHaveLength(2);
    expect(fieldSliceView(r, 8)).toBe('stale');
    // The configure of 8 resolves: a draft for 8.
    h.cfg = { poolEpoch: 6, sessionEpoch: 8, params: DEFAULTS };
    h.pool.epoch = 6;
    r.request(want());
    expect(calls).toHaveLength(3);
    expect([calls[2]!.req.n, r.pending?.sessionEpoch, fieldSliceView(r, 8)]).toEqual([32, 8, 'stale']);
    calls[2]!.resolve(density(32, 8));
    await flush();
    expect([r.shown?.sessionEpoch, fieldSliceView(r, 8)]).toEqual([8, 'fresh']);
    // A result older than the session is stale whatever its key.
    expect(fieldSliceView(r, 9)).toBe('stale');
  });

  test('a new request supersedes the previous one: its queued parts are cancelled and its running parts\' results discarded (P1)', async () => {
    const { r, calls } = harness();
    r.request(want());
    const other: Segment = { ax: -1664, az: 8, bx: -640, bz: 600 };
    r.request(want(VERT, other));
    expect(calls.map((c) => c.cancelled)).toEqual([true, false]);
    expect(calls[1]!.req).toMatchObject({ bz: 600, n: 32 });
    // The superseded draft still lands (a running part finishes): discarded.
    calls[0]!.resolve(density(32, 1));
    await flush();
    expect(r.shown).toBeNull();
    expect(calls).toHaveLength(2);
    const d = density(32, 2);
    calls[1]!.resolve(d);
    await flush();
    expect(r.shown?.result).toBe(d);
    // Superseded during the full slice: the draft stays shown (stale: another key) until the new draft lands.
    r.request(want());
    expect(calls.map((c) => c.cancelled)).toEqual([true, false, true, false]);
    calls[2]!.resolve(density(128, 3));
    await flush();
    expect([r.shown?.result, fieldSliceView(r, 7)]).toEqual([d, 'stale']);
    expect(r.pending).toEqual({ sessionEpoch: 7, key: sliceRequestKey(VERT, LINE, 'density', ''), n: 32 });
  });

  test('JobCancelled keeps the last image silently and asks again; any other error is `failed: …` and is not retried at that epoch and key', async () => {
    const { r, calls, h } = harness();
    r.request(want());
    calls[0]!.reject(new JobCancelled());
    await flush();
    expect([r.shown, r.pending, r.notice]).toEqual([null, null, null]);
    r.request(want());
    expect(calls).toHaveLength(2);
    calls[1]!.reject(new Error('BAD_ARGS: path "root.zz" names no node of density.defs'));
    await flush();
    expect(r.notice).toBe('failed: BAD_ARGS: path "root.zz" names no node of density.defs');
    expect(r.pending).toBeNull();
    r.request(want());
    expect(calls).toHaveLength(2);
    // The next session epoch asks again and clears the notice; a failure of the full slice keeps the draft.
    h.cfg = { poolEpoch: 4, sessionEpoch: 8, params: DEFAULTS };
    h.session.state.epoch = 8;
    r.request(want());
    expect([calls.length, r.notice]).toEqual([3, null]);
    const d = density(32);
    calls[2]!.resolve(d);
    await flush();
    calls[3]!.reject(new Error('worker 2 of 3 failed: boom'));
    await flush();
    expect([r.shown?.result, r.notice, r.pending, fieldSliceView(r, 8)]).toEqual([d, 'failed: worker 2 of 3 failed: boom', null, 'fresh']);
    // JobCancelled during the full slice: the draft stays, the next request starts again with a draft.
    h.cfg = { poolEpoch: 4, sessionEpoch: 9, params: DEFAULTS };
    r.request(want());
    calls[4]!.resolve(density(32, 9));
    await flush();
    calls[5]!.reject(new JobCancelled());
    await flush();
    expect([r.shown?.sessionEpoch, r.shown?.result.n, r.pending, r.notice]).toEqual([9, 32, null, null]);
    r.request(want());
    expect(calls.map((c) => c.req.n)).toEqual([32, 32, 32, 128, 32, 128, 32]);
  });

  test('the node path is in the key only for the selected field', () => {
    const { r, calls } = harness();
    r.request(want(VERT, LINE, TAP_TERRAIN));
    r.request(want(VERT, LINE, TAP_ISLANDS));
    r.request(want(VERT, LINE, RULE_SEL));
    expect(calls).toHaveLength(1);
    r.request(want({ ...VERT, field: 'blocks' }, LINE, TAP_TERRAIN));
    r.request(want({ ...VERT, field: 'blocks' }, LINE, TAP_ISLANDS));
    expect(calls.map((c) => [c.req.field, c.req.path])).toEqual([['density', ''], ['blocks', '']]);
    r.request(want({ ...VERT, field: 'selected' }, LINE, TAP_TERRAIN));
    r.request(want({ ...VERT, field: 'selected' }, LINE, TAP_TERRAIN));
    r.request(want({ ...VERT, field: 'selected' }, LINE, TAP_ISLANDS));
    r.request(want({ ...VERT, field: 'selected' }, LINE, RULE_SEL));
    expect(calls.slice(2).map((c) => [c.req.field, c.req.path])).toEqual([['node', 'root.a.a'], ['node', 'root.b'], ['rule', 'root.rules[1]']]);
    expect(calls.map((c) => c.cancelled)).toEqual([true, true, true, true, false]);
    expect(calls[2]!.opts.columnCost).toBe(sliceCostOf(DEFAULTS, 'node', 'root.a.a', 'vertical', 32));
    expect(calls[4]!.opts.columnCost).toBe(sliceCostOf(DEFAULTS, 'rule', 'root.rules[1]', 'vertical', 32));
    // The keys: y is part of a horizontal plane's key only.
    expect(sliceRequestKey(VERT, LINE, 'density', 'root.b')).toBe(sliceRequestKey(VERT, LINE, 'density', ''));
    expect(sliceRequestKey(VERT, LINE, 'blocks', 'root.b')).toBe(sliceRequestKey(VERT, LINE, 'blocks', ''));
    expect(sliceRequestKey(VERT, LINE, 'node', 'root.b')).not.toBe(sliceRequestKey(VERT, LINE, 'node', 'root.a'));
    expect(sliceRequestKey({ ...VERT, y: 10 }, LINE, 'density', '')).toBe(sliceRequestKey(VERT, LINE, 'density', ''));
    expect(sliceRequestKey({ ...HORI, y: 10 }, null, 'density', '')).not.toBe(sliceRequestKey(HORI, null, 'density', ''));
    expect(sliceRequestKey({ ...HORI, extent: 256 }, null, 'density', '')).not.toBe(sliceRequestKey(HORI, null, 'density', ''));
  });

  test('nothing to slice: a disabled field or a missing line is the notice, with no request; a hidden view asks nothing', () => {
    const { r, calls, h } = harness();
    h.visible = false;
    r.request(want());
    expect([calls.length, r.key, r.notice]).toEqual([0, null, null]);
    h.visible = true;
    r.request(want());
    expect(calls).toHaveLength(1);
    r.request(want({ ...HORI, field: 'selected' }, LINE, RULE_SEL));
    expect([calls[0]!.cancelled, r.key, r.notice, r.pending]).toEqual([true, null, RULE_HORIZONTAL_NOTE, null]);
    r.request(want({ ...HORI, field: 'blocks' }));
    expect([r.key, r.notice]).toEqual([null, BLOCKS_HORIZONTAL_NOTE]);
    r.request(want(VERT, null));
    expect([r.key, r.notice]).toEqual([null, NO_LINE_TEXT]);
    expect(calls).toHaveLength(1);
    // Back to a valid plane: a request, and the notice is gone.
    r.request(want(HORI, null));
    expect([calls.length, r.notice]).toEqual([2, null]);
  });

  describe('the work bound\'s notices, with planFieldSlice\'s limits (P3)', () => {
    // An interpolated sum of L 16-octave double detail noises: work cost 1 + 8 × (129·L − 1) per sample.
    const P8 = partWorstParams(8);
    const P16 = partWorstParams(16);

    test('the full slice refused: the draft is kept with "node too heavy for a 128² slice" (vertical limit 7 936, horizontal 6 144)', async () => {
      for (const [state, limit] of [[VERT, 7936], [HORI, 6144]] as const) {
        const { r, calls } = harness(P8);
        const plan = planFieldSlice(128, sliceCostOf(P8, 'density', '', state.plane, 128), 3, REQUEST_BUDGET);
        if (!plan.refused) throw new Error('expected a refusal');
        expect(state.plane === 'vertical' ? (plan.limit - COLUMN_SAMPLE_COST) / 128 : plan.limit / 128 - CORNER_SAMPLE_COST).toBe(limit);
        r.request(want(state));
        expect(calls).toHaveLength(1);
        const d = density(32);
        calls[0]!.resolve(d);
        await flush();
        expect(calls).toHaveLength(1);
        expect([r.shown?.result, r.pending]).toEqual([d, null]);
        expect(r.notice).toBe(`node too heavy for a 128² slice (cost 8 249, limit ${limit === 7936 ? '7 936' : '6 144'})`);
        r.request(want(state));
        expect(calls).toHaveLength(1);
      }
    });

    test('the draft refused: no job and "node too heavy to slice" (vertical limit 15 360, horizontal 14 336)', () => {
      for (const [state, limit] of [[VERT, '15 360'], [HORI, '14 336']] as const) {
        const { r, calls } = harness(P16);
        r.request(want(state));
        expect([calls.length, r.pending, r.shown]).toEqual([0, null, null]);
        expect(r.notice).toBe(`node too heavy to slice (cost 16 505, limit ${limit})`);
        // The selected node of the same tree (its root) is refused alike; a blocks slice never is.
        r.request(want({ ...state, field: 'selected' }, LINE, { leaf: 'density.defs', path: 'root' }));
        expect(r.notice).toBe(`node too heavy to slice (cost 16 505, limit ${limit})`);
        if (state.plane === 'vertical') {
          r.request(want({ ...state, field: 'blocks' }));
          expect([calls.length, calls[0]!.opts.budget, r.notice]).toEqual([1, DRAFT_BUDGET, null]);
        }
      }
    });

    test('a tree that reads col steep: the horizontal draft and then the 128² slice are requested with no notice; its limit is 3 072, never 0', async () => {
      const steep = paramsWith({ density: { defs: steepTree() } } as never);
      const { r, calls } = harness(steep);
      r.request(want(HORI));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.opts).toEqual({ priority: 2, columnCost: 32 * (571 + CORNER_STEEP_COST), budget: DRAFT_BUDGET });
      calls[0]!.resolve(density(32));
      await flush();
      expect(calls).toHaveLength(2);
      expect([calls[1]!.req.n, calls[1]!.opts]).toEqual([128, { priority: 500, columnCost: 128 * (571 + CORNER_STEEP_COST), budget: REQUEST_BUDGET }]);
      const f = density(128);
      calls[1]!.resolve(f);
      await flush();
      expect([r.shown?.result, r.pending, r.notice]).toEqual([f, null, null]);
      // The notice a heavier steep tree would get: the limit is the largest work cost accepted, 3 072 (11 264 for a draft).
      expect(tooHeavyText('full', steep, 'density', '', 128, sliceCostOf(steep, 'density', '', 'horizontal', 128), 2 ** 20)).toBe('node too heavy for a 128² slice (cost 571, limit 3 072)');
      expect(tooHeavyText('draft', steep, 'density', '', 32, sliceCostOf(steep, 'density', '', 'horizontal', 32), 2 ** 19)).toBe('node too heavy to slice (cost 571, limit 11 264)');
    });

    test('a SliceTooHeavy from the pool gives the same notice; tooHeavyText converts planFieldSlice\'s column-cost limit', async () => {
      const { r, calls } = harness();
      r.request(want());
      calls[0]!.reject(new SliceTooHeavy(calls[0]!.opts.columnCost, 2 ** 19));
      await flush();
      expect(r.notice).toBe('node too heavy to slice (cost 569, limit 15 360)');
      expect(tooHeavyText('full', DEFAULTS, 'density', '', 128, 105_600, 2 ** 20)).toBe('node too heavy for a 128² slice (cost 569, limit 7 936)');
    });
  });
});

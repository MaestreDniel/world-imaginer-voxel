/**
 * The slice viewer's drawing model (SP3d spec §4.3, §4.1 field select, §3.7 first show, §6 `sliceModel.test.ts`): the
 * diverging colormap (auto and fixed scale, s = 0 drawn white with "constant 0", the fixed scale's accepted range), the
 * 0-level contour by marching squares, the 64-bin histogram with nearest-rank p1/p50/p99, sd and % < 0 against
 * hand-computed values (incl. p1 = p99), the field select and `selected`'s resolution, `initialSliceState` and the
 * vertical empty state, and the model's use of the geometry (Task 11's `gen/inspect/fieldSlice.ts` functions and
 * metrics' `segmentPointAt`; the formulas themselves are pinned by `fieldSliceGeometry.test.ts`, not re-derived here).
 */
import { describe, expect, test } from 'vitest';
import { WINDOW_HALF } from '../../src/core/coords';
import { horizontalCoord, sliceRowY, sliceSampleVoxel, squareProblem } from '../../src/gen/inspect/fieldSlice';
import { segmentPointAt, segmentProblem, type Segment } from '../../src/metrics/crossSection';
import { voxelRgb } from '../../src/ui/crossSection/voxels';
import type { Selection } from '../../src/ui/inspector/model';
import {
  autoScale, blocksLegend, blocksRgba, clampCentre, contourSegments, divergingRgb, FIELD_CHOICES, fieldOptions, formatSliceValue,
  histogram, histogramLabels, imageOrder, initialSliceState, levelLine, NO_LINE_TEXT, parseScale, pixelSample, pixelVoxel,
  ruleRgba, ruleShare, ruleShareText, resolveField, SCALE_MAX, SLICE_BLUE, SLICE_DEFAULT_EXTENT, SLICE_DEFAULT_Y, SLICE_GREY,
  SLICE_RED, SLICE_WHITE, RULE_NA, RULE_OFF, RULE_ON, scaleOf, sliceAxisLabels, sliceEmptyText, sliceGeometryOf, sliceRgba,
  sliceStats, type SliceState,
} from '../../src/ui/inspector/sliceModel';
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

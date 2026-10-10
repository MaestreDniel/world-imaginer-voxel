/**
 * The Density tab's slice viewer model, drawing half (SP3d spec §4.1 field select, §4.3 drawing, §3.7 first show and
 * empty state, D16, D18). Pure; no DOM (`sliceView.ts` binds it). The request stream is added by a later task.
 *
 * - **Planes and pixels.** A slice holds n × n samples in sample order, sample k of sample column c at c·n + k (the
 *   worker's reply layout). Vertical: sample column c is the line's point c (A on the left), sample k the row of
 *   y_k (319 at the top); horizontal: sample column c is the row z_c (north, −z, at the top), sample k the column x_k
 *   (east to the right). `imageOrder` turns a slice into row-major image order (pixel (px, py) at py·n + px), so the
 *   drawing functions below work on one layout. The voxel under a pixel is gen's `sliceSampleVoxel`, over metrics'
 *   `segmentPointAt` on vertical planes (`sliceGeometryOf`), so a pixel always names the voxel that was evaluated.
 * - **Colormap.** Diverging and centred on 0: blue below, white at 0, red above, linear in v / s clamped to [−1, 1],
 *   s = max(|p1|, |p99|) of the finite values (auto) or a fixed number in (0, 1e100]. s = 0 draws every sample white
 *   ("constant 0"); a non-finite value is grey and counted.
 * - **Contour.** The 0 level (solid when v > 0) by marching squares on the sample grid, in image coordinates (a
 *   sample's centre at (px + 0.5, py + 0.5)), the crossing linear along each cell edge; saddles are decided by the mean
 *   of the cell's four samples.
 * - **Histogram.** 64 bins over [p1, p99] (outside values in the end bins), nearest-rank percentiles
 *   (`sorted[⌈q·N⌉ − 1]`), population sd and the share below 0, all over the finite values; p1 = p99 is one bar and
 *   "constant v".
 * - **Blocks** use the Voxels palette and legend; **rule** masks two colours, grey for n/a, and the share of 1s among
 *   the solid voxels.
 */
import { HEIGHT, MIN_Y, SEA_LEVEL, SLICE_EXTENTS } from '../../core/constants';
import { MAX_Y, WINDOW_HALF } from '../../core/coords';
import { sliceGeometryProblem, sliceRowY, sliceSampleVoxel, type SliceGeometry } from '../../gen/inspect/fieldSlice';
import { segmentLength, segmentPointAt, segmentProblem, type Segment } from '../../metrics/crossSection';
import { fluidType } from '../../world/blocks/fluid';
import { AIR, REGISTRY } from '../../world/blocks/index';
import { VOXEL_COLORS, voxelRgb, type Rgb } from '../crossSection/voxels';
import type { SlicePlane } from '../map/clickAction';
import type { Selection } from './model';

// ---------------------------------------------------------------- fields

/** The field select's choices (§4.1): `selected` follows the tree's selection. */
export type FieldChoice = 'density' | 'selected' | 'blocks';
export const FIELD_CHOICES: readonly FieldChoice[] = Object.freeze(['density', 'selected', 'blocks']);

/** The evaluated field of a slice (§4.1, the worker's `field`): `selected` resolves to `node` or `rule`. */
export type SliceFieldKind = 'density' | 'node' | 'blocks' | 'rule';

/** A choice resolved on a plane: the field and its node path ('' for density and blocks), or why it has no slice. */
export type ResolvedField =
  | { readonly ok: true; readonly field: SliceFieldKind; readonly path: string }
  | { readonly ok: false; readonly note: string };

export const RULE_HORIZONTAL_NOTE = 'a rule node has a mask on vertical planes only';
export const BLOCKS_HORIZONTAL_NOTE = 'blocks have no horizontal slice';

/** The field select's options on a plane for a selection; a disabled option carries its note. */
export interface FieldOption {
  readonly value: FieldChoice;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

/**
 * `density` is the resolved tree's root; `selected` a density node's value (`node`) or a rule node's or condition's
 * mask (`rule`, vertical planes only); `blocks` the T stage's states (vertical planes only). Selecting a node never
 * changes the choice.
 */
export function resolveField(choice: FieldChoice, plane: SlicePlane, sel: Selection): ResolvedField {
  if (choice === 'density') return { ok: true, field: 'density', path: '' };
  if (choice === 'blocks') return plane === 'vertical' ? { ok: true, field: 'blocks', path: '' } : { ok: false, note: BLOCKS_HORIZONTAL_NOTE };
  if (sel.leaf === 'density.defs') return { ok: true, field: 'node', path: sel.path };
  return plane === 'vertical' ? { ok: true, field: 'rule', path: sel.path } : { ok: false, note: RULE_HORIZONTAL_NOTE };
}

export function fieldOptions(plane: SlicePlane, sel: Selection): FieldOption[] {
  return FIELD_CHOICES.map((value) => {
    const r = resolveField(value, plane, sel);
    return { value, label: value, disabled: !r.ok, note: r.ok ? null : r.note };
  });
}

// ---------------------------------------------------------------- state, first show, geometry

/** The y level of both planes' control and the horizontal extent at first (§4.2). */
export const SLICE_DEFAULT_Y = SEA_LEVEL;
export const SLICE_DEFAULT_EXTENT = 2048;
export const NO_LINE_TEXT = 'Draw a cut line on the map for a vertical slice';

/**
 * The slice viewer's own state: the plane, the field choice, the y control (shown on both planes) and the horizontal
 * square (integer centre, extent of SLICE_EXTENTS). The vertical plane is the cross-section's line, kept elsewhere.
 */
export interface SliceState {
  readonly plane: SlicePlane;
  readonly field: FieldChoice;
  readonly y: number;
  readonly extent: number;
  readonly cx: number;
  readonly cz: number;
}

export interface SliceStart {
  /** The cross-section's line, or null. */
  readonly line: Segment | null;
  /** The map view's centre in blocks. */
  readonly viewCentre: readonly [number, number];
  /** The map's pin in blocks, or null. */
  readonly pin: readonly [number, number] | null;
}

const W = WINDOW_HALF;
const isExtent = (e: number): boolean => (SLICE_EXTENTS as readonly number[]).includes(e);

/**
 * A horizontal centre for `extent`: (⌊x⌋, ⌊z⌋) clamped so the square [c − E/2, c + E/2] lies inside the world window
 * [−2^19, 2^19] (the worker refuses a square outside it, `squareProblem`).
 */
export function clampCentre(x: number, z: number, extent: number): [number, number] {
  if (!isExtent(extent)) throw new RangeError(`extent ${extent} is not a slice extent (${SLICE_EXTENTS.join(', ')})`);
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError(`centre (${x}, ${z}) is not finite`);
  const h = extent / 2;
  const clamp = (v: number) => Math.min(Math.max(Math.floor(v), -W + h), W - h);
  return [clamp(x), clamp(z)];
}

/**
 * The tab's first state (§3.7): the vertical plane when a line exists, else the horizontal plane; field `density`;
 * y 63; extent 2048; the centre at the pin when set, else at the map view's centre, clamped into the window (kept on
 * both planes, so switching to horizontal later has a centre).
 */
export function initialSliceState(s: SliceStart): SliceState {
  const [x, z] = s.pin ?? s.viewCentre;
  const [cx, cz] = clampCentre(x, z, SLICE_DEFAULT_EXTENT);
  return { plane: s.line !== null ? 'vertical' : 'horizontal', field: 'density', y: SLICE_DEFAULT_Y, extent: SLICE_DEFAULT_EXTENT, cx, cz };
}

/** The slice area's empty-state text, or null: the vertical plane without a line. */
export function sliceEmptyText(s: SliceState, line: Segment | null): string | null {
  return s.plane === 'vertical' && line === null ? NO_LINE_TEXT : null;
}

export type SliceGeometryResult = { readonly ok: true; readonly geometry: SliceGeometry } | { readonly ok: false; readonly problem: string };

/**
 * The sample geometry of a state at size n (§4.2), or why there is none: vertical planes need a line without a
 * `segmentProblem` and take their points from `segmentPointAt(line, i, n)`; both are checked by gen's
 * `sliceGeometryProblem` (n ∈ SLICE_NS; horizontal y and square).
 */
export function sliceGeometryOf(s: SliceState, line: Segment | null, n: number): SliceGeometryResult {
  let g: SliceGeometry;
  if (s.plane === 'vertical') {
    if (line === null) return { ok: false, problem: NO_LINE_TEXT };
    const p = segmentProblem(line);
    if (p !== null) return { ok: false, problem: p };
    const seg: Segment = { ax: line.ax, az: line.az, bx: line.bx, bz: line.bz };
    g = { plane: 'vertical', n, pointAt: (i) => segmentPointAt(seg, i, n) };
  } else {
    g = { plane: 'horizontal', n, cx: s.cx, cz: s.cz, y: s.y, extent: s.extent };
  }
  const problem = sliceGeometryProblem(g);
  return problem === null ? { ok: true, geometry: g } : { ok: false, problem };
}

function checkPixel(n: number, px: number, py: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`size ${n} is not a positive integer`);
  for (const [v, what] of [[px, 'pixel x'], [py, 'pixel y']] as const) {
    if (!Number.isInteger(v) || v < 0 || v >= n) throw new RangeError(`${what} ${v} is outside [0, ${n})`);
  }
}

/** The sample (sample column c, sample k) shown at image pixel (px, py). */
export function pixelSample(plane: SlicePlane, n: number, px: number, py: number): { c: number; k: number } {
  checkPixel(n, px, py);
  return plane === 'vertical' ? { c: px, k: py } : { c: py, k: px };
}

/** The voxel [x, y, z] evaluated for image pixel (px, py): gen's `sliceSampleVoxel` of that sample. */
export function pixelVoxel(g: SliceGeometry, px: number, py: number): [number, number, number] {
  const { c, k } = pixelSample(g.plane, g.n, px, py);
  return sliceSampleVoxel(g, c, k);
}

/** The image y (in pixels of an n-row vertical slice, 0 at the top = the top of y 319) of the centre of level y. */
export function levelLine(y: number, n: number): number {
  return ((MAX_Y + 0.5 - y) * n) / HEIGHT;
}

/** The axes' end labels, in blocks: a vertical slice is L blocks by 384, not to scale. */
export interface SliceAxisLabels {
  readonly left: string;
  readonly right: string;
  readonly top: string;
  readonly bottom: string;
}

export function sliceAxisLabels(s: SliceState, line: Segment | null): SliceAxisLabels {
  if (s.plane === 'vertical') {
    const ends = line === null
      ? { left: '', right: '' }
      : { left: `A (${line.ax}, ${line.az})`, right: `B (${line.bx}, ${line.bz}) · ${Math.round(segmentLength(line))} blocks` };
    return { ...ends, top: `y ${MAX_Y}`, bottom: `y ${MIN_Y}` };
  }
  const h = s.extent / 2;
  return { left: `x ${s.cx - h}`, right: `x ${s.cx + h}`, top: `z ${s.cz - h}`, bottom: `z ${s.cz + h}` };
}

// ---------------------------------------------------------------- image order

type SliceArray = Float64Array | Uint16Array | Uint8Array;

function checkLength(len: number, n: number, what: string): void {
  if (!Number.isInteger(n) || n < 1 || len !== n * n) throw new RangeError(`${what} holds ${len} values, expected ${n} × ${n}`);
}

/**
 * A slice in image order (pixel (px, py) at py·n + px): a vertical slice transposed (sample column c is the pixel
 * column), a horizontal one as it is (the same object).
 */
export function imageOrder<T extends SliceArray>(v: T, n: number, plane: SlicePlane): T {
  checkLength(v.length, n, 'slice');
  if (plane === 'horizontal') return v;
  const out = v.slice() as T;
  for (let c = 0; c < n; c++) for (let k = 0; k < n; k++) out[k * n + c] = v[c * n + k]!;
  return out;
}

// ---------------------------------------------------------------- colormap

export const SLICE_WHITE: Rgb = Object.freeze([255, 255, 255] as const);
export const SLICE_BLUE: Rgb = Object.freeze([33, 102, 172] as const);
export const SLICE_RED: Rgb = Object.freeze([178, 24, 43] as const);
/** Non-finite values and the rule field's n/a. */
export const SLICE_GREY: Rgb = Object.freeze([128, 128, 128] as const);
/** The largest fixed scale accepted. */
export const SCALE_MAX = 1e100;

/** A fixed scale typed by the user: a finite number in (0, 1e100], else null. */
export function parseScale(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 && v <= SCALE_MAX ? v : null;
}

/** The colour of value v at scale s: grey when v is not finite, white when s is 0. */
export function divergingRgb(v: number, s: number): Rgb {
  if (!Number.isFinite(v)) return SLICE_GREY;
  if (!(s > 0)) return SLICE_WHITE;
  const t = Math.min(1, Math.max(-1, v / s));
  const end = t >= 0 ? SLICE_RED : SLICE_BLUE;
  const a = Math.abs(t);
  return [Math.round(255 + (end[0] - 255) * a), Math.round(255 + (end[1] - 255) * a), Math.round(255 + (end[2] - 255) * a)];
}

function rgbaOf(n: number, colour: (i: number) => Rgb): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(4 * n * n);
  for (let i = 0; i < n * n; i++) {
    const c = colour(i);
    out[4 * i] = c[0];
    out[4 * i + 1] = c[1];
    out[4 * i + 2] = c[2];
    out[4 * i + 3] = 255;
  }
  return out;
}

/** A `density` or `node` slice (sample order) as an n × n RGBA image at scale s. */
export function sliceRgba(values: Float64Array, n: number, plane: SlicePlane, s: number): Uint8ClampedArray<ArrayBuffer> {
  const img = imageOrder(values, n, plane);
  return rgbaOf(n, (i) => divergingRgb(img[i]!, s));
}

// ---------------------------------------------------------------- statistics and histogram

/** Statistics over the finite values of a slice (§4.3). */
export interface SliceStats {
  /** Finite values. */
  readonly count: number;
  readonly nonFinite: number;
  readonly p1: number;
  readonly p50: number;
  readonly p99: number;
  readonly mean: number;
  /** Population standard deviation. */
  readonly sd: number;
  /** Share of the values below 0 (−0 is not). */
  readonly below0: number;
}

/** The statistics of a slice's values, or null when none is finite. Percentiles are nearest-rank, ⌈q·N⌉ in integers. */
export function sliceStats(values: ArrayLike<number>): SliceStats | null {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) count++;
  if (count === 0) return null;
  const sorted = new Float64Array(count);
  let j = 0;
  let sum = 0;
  let neg = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    sorted[j++] = v;
    sum += v;
    if (v < 0) neg++;
  }
  sorted.sort();
  const rank = (num: number, den: number): number => sorted[Math.ceil((num * count) / den) - 1]!;
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < count; i++) sq += (sorted[i]! - mean) * (sorted[i]! - mean);
  return {
    count, nonFinite: values.length - count, p1: rank(1, 100), p50: rank(1, 2), p99: rank(99, 100), mean, sd: Math.sqrt(sq / count), below0: neg / count,
  };
}

/** The automatic scale: max(|p1|, |p99|), 0 without statistics. */
export function autoScale(st: SliceStats | null): number {
  return st === null ? 0 : Math.max(Math.abs(st.p1), Math.abs(st.p99));
}

/** The scale in use: the fixed one when set, else the automatic one. */
export function scaleOf(st: SliceStats | null, fixed: number | null): number {
  return fixed ?? autoScale(st);
}

export const HISTOGRAM_BINS = 64;

/** Bin counts over [lo, hi] = [p1, p99]: 64 bins, or one bar when p1 = p99. */
export interface Histogram {
  readonly lo: number;
  readonly hi: number;
  readonly counts: number[];
}

export function histogram(values: ArrayLike<number>, st: SliceStats): Histogram {
  const lo = st.p1;
  const hi = st.p99;
  if (lo === hi) return { lo, hi, counts: [st.count] };
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    const b = Math.floor(((v - lo) / (hi - lo)) * HISTOGRAM_BINS);
    counts[Math.min(HISTOGRAM_BINS - 1, Math.max(0, b))]!++;
  }
  return { lo, hi, counts };
}

/** A value as the slice and the readouts print it: `NaN`, `+∞`, `−∞`; integers below 10^6 whole; else 4 significant digits. */
export function formatSliceValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+∞';
  if (v === -Infinity) return '−∞';
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
  return String(Number(v.toPrecision(4)));
}

/** The text beside the histogram: the percentiles, sd and % < 0, or "constant v"; and the non-finite count. */
export function histogramLabels(st: SliceStats | null): string[] {
  if (st === null) return ['no finite value'];
  const f = formatSliceValue;
  const lines = st.p1 === st.p99
    ? [`constant ${f(st.p1)}`]
    : [`p1 ${f(st.p1)} · p50 ${f(st.p50)} · p99 ${f(st.p99)}`, `sd ${f(st.sd)} · < 0: ${(100 * st.below0).toFixed(1)} %`];
  if (st.nonFinite > 0) lines.push(`${st.nonFinite} non-finite`);
  return lines;
}

// ---------------------------------------------------------------- contour

/** A contour segment [x0, y0, x1, y1] in image pixels (a sample's centre at (px + 0.5, py + 0.5)). */
export type ContourSegment = readonly [number, number, number, number];

const solid = (v: number): boolean => Number.isFinite(v) && v > 0;
/** Where 0 lies between u and v along an edge, in [0, 1]; the midpoint when it cannot be interpolated. */
function crossing(u: number, v: number): number {
  if (!Number.isFinite(u) || !Number.isFinite(v) || u === v) return 0.5;
  return Math.min(1, Math.max(0, u / (u - v)));
}

/**
 * The 0-level contour of an image-ordered n × n grid by marching squares: in each cell of four sample centres the
 * solid corners (v > 0, finite) are separated from the others by segments between edge crossings; a saddle joins its
 * solid corners when the mean of the four values is > 0. Cells in row-major order.
 */
export function contourSegments(img: ArrayLike<number>, n: number): ContourSegment[] {
  checkLength(img.length, n, 'grid');
  const out: ContourSegment[] = [];
  for (let py = 0; py + 1 < n; py++) {
    for (let px = 0; px + 1 < n; px++) {
      const a = img[py * n + px]!;
      const b = img[py * n + px + 1]!;
      const c = img[(py + 1) * n + px + 1]!;
      const d = img[(py + 1) * n + px]!;
      const kase = (solid(a) ? 8 : 0) | (solid(b) ? 4 : 0) | (solid(c) ? 2 : 0) | (solid(d) ? 1 : 0);
      if (kase === 0 || kase === 15) continue;
      const x0 = px + 0.5;
      const y0 = py + 0.5;
      const T = (): [number, number] => [x0 + crossing(a, b), y0];
      const R = (): [number, number] => [x0 + 1, y0 + crossing(b, c)];
      const B = (): [number, number] => [x0 + crossing(d, c), y0 + 1];
      const L = (): [number, number] => [x0, y0 + crossing(a, d)];
      const seg = (p: () => [number, number], q: () => [number, number]) => out.push([...p(), ...q()]);
      const centreSolid = (): boolean => solid((a + b + c + d) / 4);
      switch (kase) {
        case 1: case 14: seg(L, B); break;
        case 2: case 13: seg(B, R); break;
        case 3: case 12: seg(L, R); break;
        case 4: case 11: seg(T, R); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(L, T); break;
        case 5: if (centreSolid()) { seg(L, T); seg(B, R); } else { seg(T, R); seg(L, B); } break;
        case 10: if (centreSolid()) { seg(T, R); seg(L, B); } else { seg(L, T); seg(B, R); } break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- blocks and rule

const isWater = (state: number, fluid: number): boolean => state === AIR && fluidType(fluid) !== 0;

/**
 * A `blocks` slice (vertical only; states and fluid in sample order) as an n × n RGBA image in the Voxels palette:
 * water darkens with its depth in blocks below the top of its run in the sample column (`sliceRowY` of the rows).
 */
export function blocksRgba(states: Uint16Array, fluid: Uint8Array, n: number): Uint8ClampedArray<ArrayBuffer> {
  checkLength(states.length, n, 'blocks');
  checkLength(fluid.length, n, 'fluid');
  const colours = new Array<Rgb>(n * n);
  for (let c = 0; c < n; c++) {
    let top = 0;
    let wet = false;
    for (let k = 0; k < n; k++) {
      const s = states[c * n + k]!;
      const f = fluid[c * n + k]!;
      const y = sliceRowY(k, n);
      const water = isWater(s, f);
      if (water && !wet) top = y;
      wet = water;
      colours[k * n + c] = voxelRgb(s, f, water ? top - y : 0);
    }
  }
  return rgbaOf(n, (i) => colours[i]!);
}

/** A key of the blocks legend. */
export interface BlocksLegendKey {
  readonly label: string;
  readonly rgb: Rgb;
}

/** The blocks legend (in the histogram's place): the states present in state order, then water when present. */
export function blocksLegend(states: Uint16Array, fluid: Uint8Array): BlocksLegendKey[] {
  const present = new Set<number>();
  let water = false;
  for (let i = 0; i < states.length; i++) {
    present.add(states[i]!);
    if (isWater(states[i]!, fluid[i] ?? 0)) water = true;
  }
  const keys: BlocksLegendKey[] = [...present].sort((p, q) => p - q).map((s) => ({ label: REGISTRY.stateKey(s), rgb: voxelRgb(s, 0, 0) }));
  if (water) keys.push({ label: 'water', rgb: VOXEL_COLORS.water });
  return keys;
}

/** The rule field's n/a (air and water: no surface run), as the worker writes it. */
export const RULE_NA = 255;
export const RULE_ON: Rgb = Object.freeze([230, 126, 34] as const);
export const RULE_OFF: Rgb = Object.freeze([44, 62, 80] as const);

/** A `rule` mask (sample order) as an n × n RGBA image: 1 and 0 in two colours, n/a grey. */
export function ruleRgba(values: Uint8Array, n: number, plane: SlicePlane): Uint8ClampedArray<ArrayBuffer> {
  const img = imageOrder(values, n, plane);
  return rgbaOf(n, (i) => (img[i] === 1 ? RULE_ON : img[i] === 0 ? RULE_OFF : SLICE_GREY));
}

export interface RuleShare {
  /** Solid voxels where the rule holds. */
  readonly ones: number;
  /** Solid voxels (0 or 1). */
  readonly solid: number;
  /** Air and water voxels (n/a). */
  readonly na: number;
}

export function ruleShare(values: Uint8Array): RuleShare {
  let ones = 0;
  let zeros = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 1) ones++;
    else if (values[i] === 0) zeros++;
  }
  return { ones, solid: ones + zeros, na: values.length - ones - zeros };
}

/** The share line (in the histogram's place). */
export function ruleShareText(r: RuleShare): string {
  if (r.solid === 0) return 'no solid voxel';
  return `rule share ${((100 * r.ones) / r.solid).toFixed(1)} % (${r.ones} of ${r.solid} solid voxels)`;
}

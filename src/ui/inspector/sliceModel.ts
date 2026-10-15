/**
 * The Density tab's slice viewer model (SP3d spec §4.1 field select, §4.3 drawing, §3.7 first show and empty state, §4.5
 * requests, §5.2 refusal notices, D16, D18, P1, P3). Pure; no DOM (`sliceView.ts` binds it).
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
 * - **Requests** (`createFieldSliceRequests`, §4.5): per (session epoch, request key), a 32² draft at priority 2 then the
 *   128² slice at priority 500, on the draft the pool's last resolved configure holds; a new request supersedes the
 *   previous one (its queued parts dropped, its running parts' results discarded: P1); a density or node slice refused
 *   by the work bound (`planFieldSlice`, never re-derived: P3) keeps the draft with its notice.
 * - **Pinned slices** (§11's cut line, built; master §5.5: up to 3 side by side): a pin is a frozen copy of the live
 *   slice's want (its plane with the line or the square and y, its field, its node) with a request stream of its own,
 *   asked again on every edit like the live slice (`createSlicePins`); `sliceImage` draws a pin as the live image.
 * - **The view's rules** (`sliceView.ts`, `mapPage.ts`, §4.3, §3.6, §3.7): the square box's side, the pointer → pixel
 *   `⌊(px / side) · n⌋`, the slice and map hover voxels and readouts, the centre and extent changes clamped into the
 *   window, the y control, the map's square, the status and hover lines, and the params of the configured draft.
 */
import { DRAFT_BUDGET, HEIGHT, MIN_Y, REQUEST_BUDGET, SEA_LEVEL, SLICE_EXTENTS, SLICE_NS, SLICE_RULE_NA } from '../../core/constants';
import { MAX_Y, WINDOW_HALF } from '../../core/coords';
import type { Params } from '../../core/params/schema';
import { JobCancelled, SliceTooHeavy, type FieldSliceHandle, type FieldSliceResult, type WorkerPool } from '../../engine/workerPool';
import { workCost } from '../../gen/inspect/cost';
import {
  evaluatedExpression, sliceCostOf, sliceGeometryProblem, sliceRowY, sliceSampleVoxel, type SliceField, type SliceGeometry,
} from '../../gen/inspect/fieldSlice';
import { segmentLength, segmentPointAt, segmentProblem, type Segment } from '../../metrics/crossSection';
import { fluidType } from '../../world/blocks/fluid';
import { AIR, REGISTRY } from '../../world/blocks/index';
import { isRefusableField, planFieldSlice, type FieldSliceSpec } from '../../workers/protocol';
import { countText } from '../biomeTable/model';
import { VOXEL_COLORS, voxelRgb, type Rgb } from '../crossSection/voxels';
import type { SlicePlane } from '../map/clickAction';
import type { MapSquare } from '../map/mapView';
import type { HoverVoxel } from './hoverModel';
import type { Selection } from './model';

// ---------------------------------------------------------------- fields

/** The field select's choices (§4.1): `selected` follows the tree's selection. */
export type FieldChoice = 'density' | 'selected' | 'blocks';
export const FIELD_CHOICES: readonly FieldChoice[] = Object.freeze(['density', 'selected', 'blocks']);

/** A choice resolved on a plane: the field and its node path ('' for density and blocks), or why it has no slice. */
export type ResolvedField =
  | { readonly ok: true; readonly field: SliceField; readonly path: string }
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

/** The contour's segments as an SVG path (`M x0 y0 L x1 y1` per segment, in image pixels). */
export function contourPath(segs: readonly ContourSegment[]): string {
  return segs.map(([x0, y0, x1, y1]) => `M${x0} ${y0}L${x1} ${y1}`).join('');
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

/** The rule field's n/a (air and water: no surface run), as the worker writes it (core's SLICE_RULE_NA). */
export const RULE_NA = SLICE_RULE_NA;
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

// ---------------------------------------------------------------- requests (§4.5)

/** The draft's and the full slice's sizes (SLICE_NS) and priorities: the draft follows the preview tiles at distance 0 and 1, the full slice queues behind every preview tile. */
export const SLICE_DRAFT_N = SLICE_NS[0];
export const SLICE_FULL_N = SLICE_NS[1];
export const SLICE_DRAFT_PRIORITY = 2;
export const SLICE_FULL_PRIORITY = 500;

/** What the view wants sliced now: its state, the cross-section's line and the tree's selection. */
export interface SliceWant {
  readonly state: SliceState;
  readonly line: Segment | null;
  readonly selection: Selection;
}

/**
 * The request key of a resolved field on a state: everything the samples depend on besides the session epoch. The
 * plane's own geometry only (the line on a vertical plane; the centre, extent and y on a horizontal one: y is unused by
 * a vertical evaluation), and the node path only for `node` and `rule` (the `selected` choice), so selecting another
 * node never re-requests a density or blocks slice.
 */
export function sliceRequestKey(s: SliceState, line: Segment | null, field: SliceField, path: string): string {
  const p = field === 'node' || field === 'rule' ? path : '';
  if (s.plane === 'vertical') {
    if (line === null) throw new RangeError('sliceRequestKey: a vertical plane needs a line');
    return `vertical|${field}|${p}|${line.ax},${line.az},${line.bx},${line.bz}`;
  }
  return `horizontal|${field}|${p}|${s.cx},${s.cz},${s.extent},${s.y}`;
}

/** The pool's request for a field at size n: the plane's own keys only. */
export function fieldSliceSpec(s: SliceState, line: Segment | null, field: SliceField, path: string, n: number): FieldSliceSpec {
  if (s.plane === 'vertical') {
    if (line === null) throw new RangeError('fieldSliceSpec: a vertical plane needs a line');
    return { plane: 'vertical', ax: line.ax, az: line.az, bx: line.bx, bz: line.bz, y: s.y, n, field, path };
  }
  return { plane: 'horizontal', cx: s.cx, cz: s.cz, extent: s.extent, y: s.y, n, field, path };
}

/**
 * The refusal notice of a density or node slice whose column cost exceeds `limit` (`planFieldSlice`'s, in column-cost
 * units), in §5.2's per-sample units: c = the evaluated expression's work cost, L = the largest c accepted =
 * c + ⌊(limit − columnCost) / n⌋ (the column cost is n × c plus the acquisition, linear in c). The draft's (`draft`)
 * reads "node too heavy to slice", the full slice's "node too heavy for a 128² slice".
 */
export function tooHeavyText(stage: 'draft' | 'full', params: Params, field: 'density' | 'node', path: string, n: number, columnCost: number, limit: number): string {
  const c = workCost(evaluatedExpression(params, field, path), params);
  const l = c + Math.floor((limit - columnCost) / n);
  const what = stage === 'draft' ? 'node too heavy to slice' : `node too heavy for a ${SLICE_FULL_N}² slice`;
  return `${what} (cost ${countText(c)}, limit ${countText(l)})`;
}

/** The pool's last resolved configure (`DriverStatus.poolEpoch`, `sessionEpoch`) and the params of the draft it holds. */
export interface ConfiguredDraft {
  readonly poolEpoch: number;
  readonly sessionEpoch: number;
  readonly params: Params;
}

export interface FieldSliceSource {
  readonly pool: Pick<WorkerPool, 'fieldSlice' | 'size' | 'epoch'>;
  /** The session's current epoch: a result of an older one is stale. */
  readonly session: { readonly state: { readonly epoch: number } };
  /** The pool's last resolved configure, null before the first. */
  configured(): ConfiguredDraft | null;
  /** Whether the slice view is on screen (the Density tab shown): a hidden view requests nothing. */
  visible(): boolean;
  /** The shown result, the request in flight, the key or the notice changed. */
  changed(): void;
}

/** A slice as it is shown: the session epoch and key it ran for, its plane and geometry (the hover's pixel → voxel) and its samples. */
export interface SliceShown {
  readonly sessionEpoch: number;
  readonly key: string;
  readonly geometry: SliceGeometry;
  readonly result: FieldSliceResult;
}

export interface FieldSliceRequests {
  /**
   * The view's current want (call it on every edit of the state, the line or the selection, and on every driver status
   * change). A different key supersedes the request in flight; then, once the pool's resolved configure is its current
   * epoch, requests the draft and the full slice for (that configure's session epoch, key), unless they are already in
   * flight or done (shown, refused or failed) for it.
   */
  request(want: SliceWant): void;
  /** The current key; null when nothing can be sliced (a disabled field, no line, a refused geometry). */
  readonly key: string | null;
  /** The last slice drawn (the draft, then the full one); kept across keys and epochs until replaced (shown stale). */
  readonly shown: SliceShown | null;
  /** The stage in flight: its session epoch, key and size. */
  readonly pending: { readonly sessionEpoch: number; readonly key: string; readonly n: number } | null;
  /** The field's note, the geometry's problem, a refusal notice or `failed: <message>`; null when there is none. */
  readonly notice: string | null;
  /**
   * Drops the request in flight (an unpinned slice): its queued parts are cancelled and whatever still lands is
   * discarded (P1); the key and the notice are cleared, the shown slice kept. The next `request` starts afresh.
   */
  stop(): void;
}

/** How the view shows the last slice: none yet; fresh when it is of the current key and session epoch; else stale (dimmed). */
export function fieldSliceView(r: Pick<FieldSliceRequests, 'key' | 'shown'>, sessionEpoch: number): 'none' | 'fresh' | 'stale' {
  if (r.shown === null) return 'none';
  return r.shown.key === r.key && r.shown.sessionEpoch === sessionEpoch ? 'fresh' : 'stale';
}

interface Run {
  readonly sessionEpoch: number;
  readonly key: string;
  n: number;
  handle: FieldSliceHandle | null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The slice view's request stream (§4.5), the cross-section streams' rules (`createLineRequests`): one result per
 * (session epoch, request key), a token per request, JobCancelled keeps the last image silently (the next `request`
 * asks again), any other error is the notice `failed: <message>` and is not retried at that epoch and key.
 */
export function createFieldSliceRequests(src: FieldSliceSource): FieldSliceRequests {
  let key: string | null = null;
  let notice: string | null = null;
  let shown: SliceShown | null = null;
  let run: Run | null = null;
  /** The session epoch whose request for `key` is over (full slice shown, refused or failed). */
  let done: number | null = null;

  /** Drops the request in flight: its queued parts are dropped, its running parts finish and their results are discarded (P1). */
  const supersede = () => {
    const r = run;
    run = null;
    r?.handle?.cancel();
  };

  const finish = (r: Run, text: string | null) => {
    run = null;
    done = r.sessionEpoch;
    notice = text;
    src.changed();
  };

  const stage = (r: Run, want: SliceWant, cfg: ConfiguredDraft, field: SliceField, path: string, n: number) => {
    const { state, line } = want;
    const g = sliceGeometryOf(state, line, n);
    if (!g.ok) { finish(r, g.problem); return; }
    let cost: number;
    try {
      cost = sliceCostOf(cfg.params, field, path, state.plane, n);
    } catch (e) {
      finish(r, `failed: ${messageOf(e)}`);
      return;
    }
    const draft = n === SLICE_DRAFT_N;
    const budget = draft ? DRAFT_BUDGET : REQUEST_BUDGET;
    const heavy = (limit: number): string =>
      tooHeavyText(draft ? 'draft' : 'full', cfg.params, field as 'density' | 'node', path, n, cost, limit);
    if (isRefusableField(field)) {
      const plan = planFieldSlice(n, cost, src.pool.size, budget);
      if (plan.refused) { finish(r, heavy(plan.limit)); return; }
    }
    r.n = n;
    const handle = src.pool.fieldSlice(fieldSliceSpec(state, line, field, path, n), {
      priority: draft ? SLICE_DRAFT_PRIORITY : SLICE_FULL_PRIORITY, columnCost: cost, budget,
    });
    r.handle = handle;
    handle.promise.then((result) => {
      if (run !== r) return;
      shown = { sessionEpoch: r.sessionEpoch, key: r.key, geometry: g.geometry, result };
      if (draft) {
        stage(r, want, cfg, field, path, SLICE_FULL_N);
        if (run === r) src.changed();
      } else finish(r, null);
    }, (e: unknown) => {
      if (run !== r) return;
      if (e instanceof JobCancelled) {
        run = null;
        src.changed();
        return;
      }
      finish(r, e instanceof SliceTooHeavy && isRefusableField(field) ? heavy(e.limit) : `failed: ${messageOf(e)}`);
    });
  };

  const block = (text: string) => {
    if (key === null && notice === text && run === null) return;
    supersede();
    key = null;
    done = null;
    notice = text;
    src.changed();
  };

  return {
    request(want) {
      if (!src.visible()) return;
      const f = resolveField(want.state.field, want.state.plane, want.selection);
      if (!f.ok) { block(f.note); return; }
      const g = sliceGeometryOf(want.state, want.line, SLICE_DRAFT_N);
      if (!g.ok) { block(g.problem); return; }
      const k = sliceRequestKey(want.state, want.line, f.field, f.path);
      let moved = false;
      if (k !== key) {
        supersede();
        key = k;
        done = null;
        notice = null;
        moved = true;
      }
      const cfg = src.configured();
      // Requests run on the pool's resolved configure only: while a newer configure is in flight, its resolution
      // changes the driver's status and the view calls `request` again.
      if (cfg === null || src.pool.epoch !== cfg.poolEpoch || run?.sessionEpoch === cfg.sessionEpoch || done === cfg.sessionEpoch) {
        if (moved) src.changed();
        return;
      }
      supersede();
      notice = null;
      const r: Run = { sessionEpoch: cfg.sessionEpoch, key: k, n: SLICE_DRAFT_N, handle: null };
      run = r;
      stage(r, want, cfg, f.field, f.path, SLICE_DRAFT_N);
      if (run === r) src.changed();
    },
    get key() { return key; },
    get shown() { return shown; },
    get pending() { return run === null ? null : { sessionEpoch: run.sessionEpoch, key: run.key, n: run.n }; },
    get notice() { return notice; },
    stop() {
      supersede();
      key = null;
      done = null;
      notice = null;
    },
  };
}

// ---------------------------------------------------------------- one image, and the pinned slices (§11's cut line)

/** A slice's pixels as drawn: RGBA in image order, the 0-contour (density and node) and the statistics (density and node). */
export interface SliceImage {
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  readonly contour: readonly ContourSegment[];
  readonly stats: SliceStats | null;
}

/**
 * The image of a slice result on its plane, as the live view and every pin draw it: density and node through the
 * diverging colormap at `scaleOf(stats, fixed)` (one fixed scale for all, else each image's own auto scale) with the
 * 0-contour; blocks in the Voxels palette; rule masks in their two colours and grey.
 */
export function sliceImage(r: FieldSliceResult, plane: SlicePlane, fixed: number | null): SliceImage {
  switch (r.field) {
    case 'density': case 'node': {
      const stats = sliceStats(r.values);
      return {
        rgba: sliceRgba(r.values, r.n, plane, scaleOf(stats, fixed)),
        contour: contourSegments(imageOrder(r.values, r.n, plane), r.n),
        stats,
      };
    }
    case 'blocks': return { rgba: blocksRgba(r.values, r.fluid, r.n), contour: [], stats: null };
    case 'rule': return { rgba: ruleRgba(r.values, r.n, plane), contour: [], stats: null };
  }
}

/** Pinned slices beside the live one (master §5.5: up to 3 side by side). */
export const PIN_MAX = 3;
export const PIN_FULL_TEXT = `at most ${PIN_MAX} pinned slices: unpin one first`;
export const PIN_DUPLICATE_TEXT = 'this slice is already pinned';

export type PinWant =
  | { readonly ok: true; readonly want: SliceWant; readonly key: string; readonly label: string }
  | { readonly ok: false; readonly note: string };

/**
 * What a pin of the live want holds: a frozen copy of its state, of its line (vertical planes; a horizontal pin holds
 * none, its key and job read the square and y) and of its selection, so the pin keeps its own plane, field and node
 * whatever the live slice, the cut line or the tree's selection do next; its request key and its label
 * (`<field> · <plane>`: `density`, `blocks`, `node <path>` or `rule <path>`, then `(ax, az) → (bx, bz)` or
 * `y <y>, <extent> at (cx, cz)`). Nothing to pin (a disabled field, no line, a refused geometry): `nothing to pin: <why>`.
 */
export function pinWant(want: SliceWant): PinWant {
  const s = want.state;
  const f = resolveField(s.field, s.plane, want.selection);
  if (!f.ok) return { ok: false, note: `nothing to pin: ${f.note}` };
  const g = sliceGeometryOf(s, want.line, SLICE_DRAFT_N);
  if (!g.ok) return { ok: false, note: `nothing to pin: ${g.problem}` };
  const l = s.plane === 'vertical' ? want.line : null;
  const line: Segment | null = l === null ? null : Object.freeze({ ax: l.ax, az: l.az, bx: l.bx, bz: l.bz });
  const state: SliceState = Object.freeze({ plane: s.plane, field: s.field, y: s.y, extent: s.extent, cx: s.cx, cz: s.cz });
  const selection: Selection = Object.freeze({ leaf: want.selection.leaf, path: want.selection.path });
  const what = f.field === 'node' || f.field === 'rule' ? `${f.field} ${f.path}` : f.field;
  const where = line !== null
    ? `(${line.ax}, ${line.az}) → (${line.bx}, ${line.bz})`
    : `y ${state.y}, ${state.extent} at (${state.cx}, ${state.cz})`;
  return {
    ok: true,
    want: Object.freeze({ state, line, selection }),
    key: sliceRequestKey(state, line, f.field, f.path),
    label: `${what} · ${where}`,
  };
}

/** A pinned slice: its id (1, 2, … never reused), its frozen want, key and label, and its own request stream. */
export interface SlicePin {
  readonly id: number;
  readonly want: SliceWant;
  readonly key: string;
  readonly label: string;
  readonly requests: FieldSliceRequests;
}

export interface SlicePins {
  /** The pins in the order they were added. */
  readonly pins: readonly SlicePin[];
  /** Pins the live want and requests it at once; null, or why it is refused (PIN_FULL_TEXT, PIN_DUPLICATE_TEXT, nothing to pin). */
  add(want: SliceWant): string | null;
  /** Unpins: its request in flight is dropped (`stop`). False for an unknown id. */
  remove(id: number): boolean;
  /** Something a slice depends on changed (an edit, a driver status change, the tab shown): every pin asks again for its own want. */
  update(): void;
}

/**
 * The pinned slices (§11's cut line): each pin is a `createFieldSliceRequests` stream of its own on the same source
 * (pool, session, resolved configure, visibility), asked with its frozen want, so it re-renders on every edit like the
 * live slice (a draft then the full slice per session epoch, stale in between) under the same budgets and refusals.
 */
export function createSlicePins(src: FieldSliceSource): SlicePins {
  let pins: readonly SlicePin[] = Object.freeze([]);
  let nextId = 1;
  return {
    get pins() { return pins; },
    add(want) {
      if (pins.length >= PIN_MAX) return PIN_FULL_TEXT;
      const p = pinWant(want);
      if (!p.ok) return p.note;
      if (pins.some((q) => q.key === p.key)) return PIN_DUPLICATE_TEXT;
      const pin: SlicePin = Object.freeze({ id: nextId++, want: p.want, key: p.key, label: p.label, requests: createFieldSliceRequests(src) });
      pins = Object.freeze([...pins, pin]);
      pin.requests.request(pin.want);
      src.changed();
      return null;
    },
    remove(id) {
      const pin = pins.find((q) => q.id === id);
      if (pin === undefined) return false;
      pins = Object.freeze(pins.filter((q) => q !== pin));
      pin.requests.stop();
      src.changed();
      return true;
    },
    update() {
      for (const p of pins) p.requests.request(p.want);
    },
  };
}

// ---------------------------------------------------------------- the view's rules (sliceView.ts, mapPage.ts)

/** The slice box's smallest side in CSS px (§3.1, §4.3); the drawer scrolls below it. */
export const SLICE_BOX_MIN_PX = 128;

/** The side of the square slice box: the smaller of its cell's width and height, at least SLICE_BOX_MIN_PX (§4.3). */
export function sliceBoxSide(width: number, height: number): number {
  const s = Math.floor(Math.min(width, height));
  return Number.isFinite(s) && s > SLICE_BOX_MIN_PX ? s : SLICE_BOX_MIN_PX;
}

/**
 * The image pixel (one axis) under a pointer `offset` CSS px into a box of `side` px showing n pixels: ⌊(offset / side) · n⌋
 * (§4.3), or null outside [0, side) (the pointer left the image).
 */
export function slicePixel(offset: number, side: number, n: number): number | null {
  if (!(side > 0) || !(offset >= 0) || !(offset < side) || !(n >= 1)) return null;
  return Math.min(n - 1, Math.floor((offset / side) * n));
}

/**
 * A pointer over a slice box, as fractions of the box (§4.3). The views keep this, not the sample indices, so a slice of
 * another size that replaces the shown one (the 32² draft, then the 128² slice) reads the sample under the pointer.
 */
export interface SlicePointer { readonly fx: number; readonly fy: number }

/** The pointer at CSS offset (x, y) in a box of `width` × `height` px, or null outside [0, width) × [0, height). */
export function slicePointer(x: number, y: number, width: number, height: number): SlicePointer | null {
  if (!(width > 0) || !(height > 0) || !(x >= 0) || !(x < width) || !(y >= 0) || !(y < height)) return null;
  return { fx: x / width, fy: y / height };
}

/** The sample under the pointer in a slice of n × n samples (`slicePixel` on the box), or null (no pointer, n < 1). */
export function pointerPixel(p: SlicePointer | null, n: number): { readonly px: number; readonly py: number } | null {
  if (p === null) return null;
  const px = slicePixel(p.fx, 1, n), py = slicePixel(p.fy, 1, n);
  return px === null || py === null ? null : { px, py };
}

/** The shown field's value at a sample (from the slice buffer: the function that computed it), as the readouts print it. */
function sampleText(r: FieldSliceResult, i: number): string {
  switch (r.field) {
    case 'density': case 'node': return formatSliceValue(r.values[i]!);
    case 'blocks': return isWater(r.values[i]!, r.fluid[i]!) ? 'water' : REGISTRY.stateKey(r.values[i]!);
    case 'rule': return r.values[i] === 1 ? 'yes' : r.values[i] === 0 ? 'no' : r.values[i] === RULE_NA ? 'n/a' : String(r.values[i]);
  }
}

/**
 * The slice hover (§3.6): the voxel of image pixel (px, py) of a shown slice and its readout, `(x, y, z) · <field> <value>`
 * with the value from the slice buffer. Throws a RangeError for a pixel outside the slice.
 */
export function sliceHoverText(shown: SliceShown, px: number, py: number): { readonly voxel: HoverVoxel; readonly text: string } {
  const g = shown.geometry;
  const [x, y, z] = pixelVoxel(g, px, py);
  const { c, k } = pixelSample(g.plane, g.n, px, py);
  return { voxel: { x, y, z }, text: `(${x}, ${y}, ${z}) · ${shown.result.field} ${sampleText(shown.result, c * g.n + k)}` };
}

/** The voxel of a map hover while the Density tab is shown (§3.6): the hovered block at the y control; null outside the world window. */
export function mapHoverVoxel(x: number, z: number, y: number): HoverVoxel | null {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  if (!(bx >= -W && bx < W && bz >= -W && bz < W)) return null;
  return { x: bx, y, z: bz };
}

/** A map click on the horizontal plane (§3.7): the centre at the clicked block, clamped into the window for the extent. */
export function withCentre(s: SliceState, x: number, z: number): SliceState {
  const [cx, cz] = clampCentre(x, z, s.extent);
  return { ...s, cx, cz };
}

/** Another extent (SLICE_EXTENTS, else a RangeError): the centre is kept where the square fits, else clamped. */
export function withExtent(s: SliceState, extent: number): SliceState {
  const [cx, cz] = clampCentre(s.cx, s.cz, extent);
  return { ...s, extent, cx, cz };
}

/** The y control's text: an integer in −64 … 319, else null (refused). */
export function parseSliceY(text: string): number | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const y = Number(t);
  return y >= MIN_Y && y <= MAX_Y ? y : null;
}

/** The horizontal plane's square on the map (§3.7), or null (no state yet, or the vertical plane). */
export function sliceSquare(s: SliceState | null): MapSquare | null {
  return s === null || s.plane !== 'horizontal' ? null : { cx: s.cx, cz: s.cz, extent: s.extent };
}

/** The field select's label: `selected` names the selected node's path (§4.1). */
export function fieldOptionLabel(choice: FieldChoice, sel: Selection): string {
  return choice === 'selected' ? `selected (${sel.path})` : choice;
}

/** The status line: the shown slice (its size when fresh, "stale" otherwise), then the stage in flight. */
export function sliceStatusText(r: Pick<FieldSliceRequests, 'key' | 'shown' | 'pending'>, sessionEpoch: number): string {
  const view = fieldSliceView(r, sessionEpoch);
  const parts: string[] = [];
  if (view === 'fresh') parts.push(`${r.shown!.result.n}²`);
  else if (view === 'stale') parts.push('stale');
  if (r.pending !== null) parts.push(`slicing ${r.pending.n}² …`);
  return parts.join(' · ');
}

/** The form's "value at the hover" (§3.6): the value (and a rule node's rule suffix) at the voxel, or null (nothing to show). */
export function hoverLineText(voxel: HoverVoxel | null, value: string, rule: string): string | null {
  if (voxel === null || value === '') return null;
  return `${value}${rule} at (${voxel.x}, ${voxel.y}, ${voxel.z})`;
}

/** The params of the drafts handed to the preview driver, by session epoch: `configured` names the one the pool holds. */
export interface DraftLog {
  /**
   * The draft of session epoch `sessionEpoch`, handed to the driver; `resolved` is the session epoch of the pool's last
   * resolved configure (`DriverStatus.sessionEpoch`, null before one): the drafts below it are dropped, so the log holds
   * only the resolved and the in-flight drafts even while no slice view asks `configured`.
   */
  remember(sessionEpoch: number, params: Params, resolved: number | null): void;
  /** The pool's last resolved configure (`DriverStatus`) and its draft's params; null before one or for an unknown draft. */
  configured(status: { readonly poolEpoch: number | null; readonly sessionEpoch: number | null }): ConfiguredDraft | null;
  /** Drafts remembered. */
  readonly size: number;
}

/**
 * Configures resolve in session order, so the drafts before the configured one are never configured again and are
 * dropped (`DriverStatus` holds no params: SP3d spec §4.5 costs a slice on the draft the workers hold).
 */
export function createDraftLog(): DraftLog {
  const drafts = new Map<number, Params>();
  return {
    remember(sessionEpoch, params, resolved) {
      drafts.set(sessionEpoch, params);
      if (resolved !== null) for (const e of drafts.keys()) if (e < resolved) drafts.delete(e);
    },
    configured({ poolEpoch, sessionEpoch }) {
      if (poolEpoch === null || sessionEpoch === null) return null;
      const params = drafts.get(sessionEpoch);
      if (params === undefined) return null;
      for (const e of drafts.keys()) if (e < sessionEpoch) drafts.delete(e);
      return { poolEpoch, sessionEpoch, params };
    },
    get size() { return drafts.size; },
  };
}

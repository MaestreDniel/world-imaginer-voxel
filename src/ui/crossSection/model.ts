/**
 * The cross-section's pure parts (SP2b spec §4.5), unit-tested:
 * - the map's two-click cut-line tool: armed from the toolbar or the tab, the first click sets A, the second B
 *   (both rounded to whole blocks, inside the half-open world window, B ≠ A); what the map draws of it;
 * - the requests: one `crossSection` stats job (the profile) or one `slice` job (the Voxels mode, SP3a spec §5.2)
 *   per session epoch and line, made when the preview driver settles while the view is on screen, so it runs on
 *   the draft the map shows; their stale state and the tab's two modes;
 * - the plot model: the value range, the runs of river channels, gorges and water, SVG area paths, the summary
 *   line and the hover readout.
 */
import { SEA_LEVEL } from '../../core/constants';
import { JobCancelled, type SliceResult, type WorkerPool } from '../../engine/workerPool';
import {
  CROSS_SECTION_POINTS, crossSectionLength, segmentLength, segmentPointAt, summarizeCrossSection, type CrossSectionProfile, type Segment,
} from '../../metrics/crossSection';
import { pointInWindow } from '../../workers/protocol';
import { countText } from '../biomeTable/model';
import { toPx, type Plot } from '../splineEditor/model';

const LAST = CROSS_SECTION_POINTS - 1;

// ---------------------------------------------------------------- the cut-line tool

/** A world position (x, z) in blocks. */
export type CutPoint = readonly [number, number];
/** Off; armed and waiting for A; or waiting for B after A. */
export type CutTool = { readonly mode: 'off' } | { readonly mode: 'a' } | { readonly mode: 'b'; readonly a: CutPoint };
export const CUT_OFF: CutTool = Object.freeze({ mode: 'off' });
export const CUT_ARMED: CutTool = Object.freeze({ mode: 'a' });

/** What a click did: the tool's next state, the finished line (after B) and a refusal to show. */
export interface CutStep {
  readonly tool: CutTool;
  readonly line: Segment | null;
  readonly problem: string | null;
}

/** The block nearest to a coordinate (never −0). */
const block = (v: number): number => Math.round(v) + 0;

/**
 * A click at world (x, z) while the tool is armed: rounded to whole blocks, it becomes A, then B, which ends the
 * tool with the line A → B. A point outside the half-open world window, or a B in A's block, is refused and the
 * tool keeps waiting. With the tool off the click is not the tool's (the page pins the point).
 */
export function cutClick(tool: CutTool, x: number, z: number): CutStep {
  if (tool.mode === 'off') return { tool, line: null, problem: null };
  const p: CutPoint = [block(x), block(z)];
  const end = tool.mode === 'a' ? 'A' : 'B';
  if (!pointInWindow(p[0], p[1])) return { tool, line: null, problem: `cut line: ${end} (${p[0]}, ${p[1]}) is outside the world window` };
  if (tool.mode === 'a') return { tool: { mode: 'b', a: p }, line: null, problem: null };
  if (p[0] === tool.a[0] && p[1] === tool.a[1]) return { tool, line: null, problem: 'cut line: B is in the same block as A; click another point' };
  return { tool: CUT_OFF, line: { ax: tool.a[0], az: tool.a[1], bx: p[0], bz: p[1] }, problem: null };
}

/** The line as the map draws it: from A to B, dashed (`pending`) while B is being placed. */
export interface CutOverlay {
  readonly a: CutPoint;
  readonly b: CutPoint;
  readonly pending: boolean;
}

/** While B is being placed, the rubber band from A to the pointer (to A itself before the pointer moves); else the line, if any. */
export function cutOverlay(tool: CutTool, line: Segment | null, pointer: CutPoint | null): CutOverlay | null {
  if (tool.mode === 'b') return { a: tool.a, b: pointer ?? tool.a, pending: true };
  return line === null ? null : { a: [line.ax, line.az], b: [line.bx, line.bz], pending: false };
}

export interface CutButton {
  readonly label: string;
  readonly tip: string;
  readonly pressed: boolean;
}

/** The toolbar button: it arms the tool, and cancels it while armed. */
export function cutButton(tool: CutTool): CutButton {
  if (tool.mode === 'off') return { label: 'Cut line', tip: 'Draw a cross-section line on the map: click its start A, then its end B', pressed: false };
  const which = tool.mode === 'a' ? 'start A' : 'end B';
  return { label: `Cut line: click ${tool.mode === 'a' ? 'A' : 'B'}`, tip: `Click the ${which} of the line on the map (Escape or this button cancels)`, pressed: true };
}

/** The distance from map point (x, z) to the line, in blocks (the page reopens the profile on a click near the line). */
export function segmentDistance(s: Segment, x: number, z: number): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
  return Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
}

/** `A (x, z) → B (x, z) · N blocks`. */
export function segmentText(s: Segment): string {
  return `A (${s.ax}, ${s.az}) → B (${s.bx}, ${s.bz}) · ${countText(Math.round(segmentLength(s)))} blocks`;
}

export function sameSegment(a: Segment | null, b: Segment | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ax === b.ax && a.az === b.az && a.bx === b.bx && a.bz === b.bz;
}

// ---------------------------------------------------------------- requests and stale state

/** What a cut-line request stream reads and reports (the profile's and the Voxels mode's). */
export interface LineSource {
  /** The draft's session epoch and whether a gesture is active (a WorldSession). */
  readonly session: { readonly state: { readonly epoch: number }; readonly inGesture: boolean };
  /** Whether this stream's view is on screen (its tab, and its mode): a hidden view requests nothing. */
  visible(): boolean;
  /** The line, the pending request or the shown result changed. */
  changed(): void;
  /** A request failed with something other than JobCancelled (the result stays stale). */
  failed(message: string): void;
}

export interface LineRequests<R> {
  /** The line (null: none). A different line drops the shown result and the pending request. */
  setLine(line: Segment | null): void;
  readonly line: Segment | null;
  /**
   * Requests the line's result for the draft when `settled`, the view is on screen, a line is set and no gesture
   * is active, unless the shown result or the pending request is already for this session epoch. The caller
   * passes the driver's settled state (true from inside onSettled, whose status still reads false).
   */
  request(settled: boolean): void;
  /** The line's last result and the session epoch of the draft it ran on. */
  readonly shown: { readonly epoch: number; readonly value: R } | null;
  /** The session epoch of the request in flight, if any. Only its result is shown. */
  readonly pending: number | null;
}

/**
 * One result per session epoch and line from `fetch` (a pool job). JobCancelled (a newer configure) keeps the last
 * result silently, any other error reports it; either way the next settle requests again.
 */
export function createLineRequests<R>(src: LineSource, fetch: (line: Segment) => Promise<R>): LineRequests<R> {
  let line: Segment | null = null;
  let shown: LineRequests<R>['shown'] = null;
  /** A token per request, so that a result for a line replaced in the meantime is dropped even at the same epoch. */
  let pending: { readonly epoch: number } | null = null;
  return {
    setLine(next) {
      if (sameSegment(line, next)) return;
      line = next === null ? null : { ax: next.ax, az: next.az, bx: next.bx, bz: next.bz };
      shown = null;
      pending = null;
      src.changed();
    },
    get line() { return line; },
    request(settled) {
      const at = line;
      if (!settled || at === null || src.session.inGesture || !src.visible()) return;
      const epoch = src.session.state.epoch;
      if (shown?.epoch === epoch || pending?.epoch === epoch) return;
      const token = { epoch };
      pending = token;
      src.changed();
      fetch(at).then((value) => {
        if (pending !== token) return;
        pending = null;
        shown = { epoch, value };
        src.changed();
      }, (e: unknown) => {
        if (pending !== token) return;
        pending = null;
        if (!(e instanceof JobCancelled)) src.failed(e instanceof Error ? e.message : String(e));
        src.changed();
      });
    },
    get shown() { return shown; },
    get pending() { return pending?.epoch ?? null; },
  };
}

export interface SectionSource extends LineSource {
  readonly pool: Pick<WorkerPool, 'stats'>;
}

export type SectionRequests = LineRequests<CrossSectionProfile>;

/** The profile's requests (spec §4.5): `pool.stats('crossSection', 512, …)` (one job) per session epoch and line. */
export function createSectionRequests(src: SectionSource): SectionRequests {
  return createLineRequests(src, (at) => src.pool.stats('crossSection', CROSS_SECTION_POINTS, { len: crossSectionLength(), ax: at.ax, az: at.az, bx: at.bx, bz: at.bz })
    .then((sum) => summarizeCrossSection(sum, at)));
}

export interface SliceSource extends LineSource {
  readonly pool: Pick<WorkerPool, 'slice'>;
}

export type SliceRequests = LineRequests<SliceResult>;

/** The Voxels mode's requests (SP3a spec §5.2): `pool.slice(line)` (one job, abortable) per session epoch and line. */
export function createSliceRequests(src: SliceSource): SliceRequests {
  return createLineRequests(src, (at) => src.pool.slice(at));
}

/** The Cross-section tab's modes (SP3a spec §5.2): the SP2b profile, or the voxels of the vertical slice. */
export type SectionMode = 'profile' | 'voxels';
export const SECTION_MODES: readonly SectionMode[] = Object.freeze(['profile', 'voxels']);

export type SectionView = 'none' | 'fresh' | 'stale';

/**
 * How the tab shows its last profile: none before the first (for this line); fresh while it ran on the draft
 * (same session epoch) and no gesture is active; stale from the next session change, or during a gesture.
 */
export function sectionView(shownEpoch: number | null, epoch: number, inGesture: boolean): SectionView {
  if (shownEpoch === null) return 'none';
  return !inGesture && shownEpoch === epoch ? 'fresh' : 'stale';
}

/** The status next to the tab's title; empty while fresh. */
export function sectionStatus(view: SectionView, pending: boolean, hasLine: boolean, mode: SectionMode = 'profile'): string {
  if (!hasLine) return 'no line: press Cut line in the toolbar, then click A and B on the map';
  if (view === 'fresh') return '';
  if (view === 'none') return pending ? 'computing…' : `the ${mode === 'profile' ? 'profile' : 'slice'} follows when the preview settles`;
  return pending ? 'stale: computing…' : 'stale: updates when the preview settles';
}

// ---------------------------------------------------------------- plot model

/** The main plot's y range in whole blocks, and the jag strip's top. */
export interface SectionRange {
  readonly lo: number;
  readonly hi: number;
  readonly jagMax: number;
}

/**
 * The y range over every value the main plot draws (offset0, offset ± σ, the water and lake levels) and sea
 * level, padded by 5 % of the span (at least 4 blocks) and widened to whole blocks. The jag strip runs from 0 to
 * the smallest power of two from 8 that holds the largest jag.
 */
export function sectionRange(p: CrossSectionProfile): SectionRange {
  let lo = SEA_LEVEL;
  let hi = SEA_LEVEL;
  let jag = 0;
  const take = (v: number) => {
    if (!Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (let i = 0; i < CROSS_SECTION_POINTS; i++) {
    take(p.offset0[i]!);
    take(p.offset[i]! - p.sigma[i]!);
    take(p.offset[i]! + p.sigma[i]!);
    take(p.surfaceWaterLevel[i]!);
    take(p.lakeLevel[i]!);
    if (p.jag[i]! > jag) jag = p.jag[i]!;
  }
  const pad = Math.max(4, (hi - lo) * 0.05);
  let jagMax = 8;
  while (jagMax < jag) jagMax *= 2;
  return { lo: Math.floor(lo - pad), hi: Math.ceil(hi + pad), jagMax };
}

/** Points from..to, inclusive. */
export interface Run {
  readonly from: number;
  readonly to: number;
}

/** Maximal runs of consecutive points whose flag is set. */
export function flagRuns(flags: ArrayLike<number>): Run[] {
  const out: Run[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] !== 0;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push({ from: start, to: i - 1 });
      start = -1;
    }
  }
  return out;
}

/** Water at sea level (the ocean, and river channels below it), or in a lake basin at the lake's level. */
export type WaterKind = 'sea' | 'lake';

export interface WaterRun extends Run {
  readonly kind: WaterKind;
  readonly level: number;
}

/** Maximal runs of points with water above the ground (surface water level > offset), split where the kind or the level changes. */
export function waterRuns(p: CrossSectionProfile): WaterRun[] {
  const out: WaterRun[] = [];
  let run: { from: number; kind: WaterKind; level: number } | null = null;
  for (let i = 0; i <= CROSS_SECTION_POINTS; i++) {
    let kind: WaterKind | null = null;
    let level = 0;
    if (i < CROSS_SECTION_POINTS) {
      const w = p.surfaceWaterLevel[i]!;
      if (Number.isFinite(w) && w > p.offset[i]!) {
        kind = Number.isFinite(p.lakeLevel[i]!) ? 'lake' : 'sea';
        level = w;
      }
    }
    if (run !== null && (kind !== run.kind || level !== run.level)) {
      out.push({ from: run.from, to: i - 1, kind: run.kind, level: run.level });
      run = null;
    }
    if (kind !== null && run === null) run = { from: i, kind, level };
  }
  return out;
}

/** Half the distance between two points, in blocks: a run is drawn this much wider at each end. */
const halfStep = (p: CrossSectionProfile): number => p.length / (2 * LAST);

/** A run's widened ends in blocks from A, clamped to the line. */
const runEnds = (p: CrossSectionProfile, r: Run): readonly [number, number] => {
  const h = halfStep(p);
  return [Math.max(0, p.distance[r.from]! - h), Math.min(p.length, p.distance[r.to]! + h)];
};

/** A run's x span in plot pixels, widened by half a point spacing at each end (clamped to the line). */
export function runSpan(plot: Plot, p: CrossSectionProfile, r: Run): { readonly x0: number; readonly x1: number } {
  const [d0, d1] = runEnds(p, r);
  return { x0: toPx(plot, d0, 0).px, x1: toPx(plot, d1, 0).px };
}

const px2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * A closed SVG polygon over the points of a run, in plot pixels rounded to 2 decimals: along `top` forwards,
 * then along `bottom` backwards. With `widen`, each end gets an extra vertex half a point spacing further out
 * (clamped to the line; none where the clamp leaves it on the end point), so a one-point run still has a width.
 */
export function areaPath(plot: Plot, p: CrossSectionProfile, r: Run, top: (i: number) => number, bottom: (i: number) => number, widen: boolean): string {
  const xs: number[] = [];
  const at: number[] = [];
  if (widen) {
    const [d0] = runEnds(p, r);
    if (d0 !== p.distance[r.from]) { xs.push(d0); at.push(r.from); }
  }
  for (let i = r.from; i <= r.to; i++) { xs.push(p.distance[i]!); at.push(i); }
  if (widen) {
    const [, d1] = runEnds(p, r);
    if (d1 !== p.distance[r.to]) { xs.push(d1); at.push(r.to); }
  }
  const pt = (k: number, y: number): string => {
    const q = toPx(plot, xs[k]!, y);
    return `${px2(q.px)},${px2(q.py)}`;
  };
  let d = '';
  for (let k = 0; k < xs.length; k++) d += `${k === 0 ? 'M' : 'L'}${pt(k, top(at[k]!))}`;
  for (let k = xs.length - 1; k >= 0; k--) d += `L${pt(k, bottom(at[k]!))}`;
  return `${d}Z`;
}

/** The point nearest to plot pixel x, clamped to the line (point 0 for a non-finite x). */
export function nearestPoint(plot: Plot, px: number): number {
  const i = Math.round(((px - plot.left) / plot.width) * LAST);
  return Number.isFinite(i) ? Math.min(LAST, Math.max(0, i)) : 0;
}

const count = (n: number, one: string, many: string): string => (n === 0 ? `no ${one}` : `${n} ${n === 1 ? one : many}`);
/** A level without trailing zeros: 153, 152.5. */
const level = (v: number): string => String(Number(v.toFixed(2)));

/** `offset LO to HI blocks · water on P % of the line · N river channels · N gorges · N lakes at L1, L2`. */
export function sectionSummary(p: CrossSectionProfile): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of p.offset) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const water = waterRuns(p);
  const wet = water.reduce((a, r) => a + r.to - r.from + 1, 0);
  const lakes = water.filter((r) => r.kind === 'lake');
  const parts = [
    `offset ${lo.toFixed(1)} to ${hi.toFixed(1)} blocks`,
    `water on ${((wet / CROSS_SECTION_POINTS) * 100).toFixed(1)} % of the line`,
    count(flagRuns(p.riverWet).length, 'river channel', 'river channels'),
    count(flagRuns(p.gorge).length, 'gorge', 'gorges'),
    `${count(lakes.length, 'lake', 'lakes')}${lakes.length === 0 ? '' : ` at ${lakes.map((r) => level(r.level)).join(', ')}`}`,
  ];
  return parts.join(' · ');
}

/** The hover readout of point i: its distance from A, position, shape values, water above the ground and flags. */
export function sectionReadout(p: CrossSectionProfile, i: number): string {
  const [x, z] = segmentPointAt(p.segment, i);
  const off = p.offset[i]!;
  let text = `${p.distance[i]!.toFixed(1)} blocks from A · x ${x.toFixed(1)} z ${z.toFixed(1)} · offset0 ${p.offset0[i]!.toFixed(2)} · offset ${off.toFixed(2)} ± ${p.sigma[i]!.toFixed(2)} · jag ${p.jag[i]!.toFixed(2)}`;
  const w = p.surfaceWaterLevel[i]!;
  if (Number.isFinite(w) && w > off) {
    text += Number.isFinite(p.lakeLevel[i]!) ? ` · lake at ${level(w)}, ${(w - off).toFixed(2)} deep` : ` · water at sea level ${level(w)}, ${(w - off).toFixed(2)} deep`;
  }
  if (p.riverWet[i] === 1) text += ' · river channel';
  if (p.gorge[i] === 1) text += ' · gorge';
  return text;
}

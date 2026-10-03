/**
 * The Cross-section tab of the drawer (SP2b spec §4.5): the columns along the map's cut line A → B at 512
 * points, from one `crossSection` stats job on the pool.
 * - Header: the line (A, B and its length), the status, and the buttons New line (arms the map's cut-line
 *   tool), Clear and Close; a summary line (offset range, water, river channels, gorges, lakes) under it.
 * - Plot (SVG): distance from A on x, blocks on y. The ground under offset; offset ± σ as a band around the
 *   offset line; offset0 as a thin dashed line; water above the ground (at sea level, and lakes labelled with
 *   their level); sea level 63 as a dashed line; river channels and gorges as stripes with a marker on the top
 *   edge; under the axis a strip with jag. Hovering the plot reads the nearest point.
 * - A `Profile | Voxels` toggle in the header (SP3a spec §5.2). Voxels draws the vertical slice under the line
 *   from one `slice` job: one pixel per sample (512 × 384, row 0 at y 319) scaled to the drawer, in the palette
 *   of voxels.ts, with the sea-level line at 63; hovering reads the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋), its block and fluid.
 * - The current mode's result is requested (model.ts createSectionRequests, createSliceRequests) when the preview
 *   driver settles while the tab is on screen, when the tab or the mode comes on screen while it is settled and
 *   when a new line is set, so it always runs on the draft the map shows. It is stale (dimmed, with its status)
 *   from the next session change, or during a gesture, until a new result arrives; a cancelled request stays
 *   stale silently, any other failure also shows a notice. The mode is not stored: a page starts on Profile.
 */
import './section.css';
import { SEA_LEVEL } from '../../core/constants';
import type { WorldSession } from '../../engine/session';
import type { WorkerPool } from '../../engine/workerPool';
import type { SliceResult } from '../../engine/workerPool';
import { segmentLength, type CrossSectionProfile, type Segment } from '../../metrics/crossSection';
import { WATER_SOURCE } from '../../world/blocks/fluid';
import { AIR } from '../../world/blocks/index';
import { SLICE_POINTS, SLICE_ROWS } from '../../workers/protocol';
import { el } from '../common/dom';
import type { Notices } from '../common/notice';
import type { PreviewDriver } from '../map/previewDriver';
import { curvePath, niceTicks, toPx, type Plot } from '../splineEditor/model';
import {
  areaPath, createSectionRequests, createSliceRequests, flagRuns, nearestPoint, runSpan, sectionRange, sectionReadout, sectionStatus, sectionSummary,
  sectionView, segmentText, waterRuns, SECTION_MODES, type Run, type SectionMode,
} from './model';
import { sliceRgba, sliceSummary, SEA_LEVEL_Y, VOXEL_COLORS, voxelCell, voxelPlots, voxelReadout, voxelRgb, type Rgb } from './voxels';

export interface SectionDeps {
  readonly session: WorldSession;
  readonly notices: Notices;
  /** The pool's statistics jobs (spec §5.4) and slice jobs (SP3a spec §5.1). */
  readonly pool: Pick<WorkerPool, 'stats' | 'slice'>;
  /** The preview driver: the profile is requested when it settles. */
  readonly driver: Pick<PreviewDriver, 'onSettled' | 'status'>;
  /** Whether the drawer shows this tab. */
  visible(): boolean;
  /** Arms the map's cut-line tool (New line). */
  arm(): void;
  /** Removes the line from the map and from this tab (Clear). */
  clear(): void;
  /** Closes the drawer (Close). */
  close(): void;
}

export interface CrossSection {
  readonly element: HTMLElement;
  /** Profiles `line` (null: none); requests the current mode's result at once if the tab is on screen and the driver is settled. */
  setLine(line: Segment | null): void;
  readonly line: Segment | null;
  /** The tab came on screen: renders and requests the current mode's result if the driver is settled and it is not current. */
  shown(): void;
  /** Profile or Voxels (the header's toggle). */
  readonly mode: SectionMode;
  setMode(mode: SectionMode): void;
  /** Stops following the session and the driver (the DOM stays). */
  dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number>> = {}, text = ''): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== '') e.textContent = text;
  return e;
}

/** Margins in CSS px: y tick labels on the left; under the main plot its x tick labels, a gap and the jag strip. */
const MARGIN = { left: 46, right: 12, top: 12 } as const;
const X_TICKS_PX = 14;
const GAP_PX = 6;
const JAG_PX = 34;
const BOTTOM_PX = 4;
const MARKER_PX = 6;
const CLIP_ID = 'cs-plot-clip';
const HINT = 'hover the plot to read a point';
const VOXEL_HINT = 'hover the voxels to read a block';
const MODE_LABELS: Readonly<Record<SectionMode, readonly [string, string]>> = {
  profile: ['Profile', 'The 2D shape along the line: offset, σ, water, rivers, gorges and jag'],
  voxels: ['Voxels', 'The voxels of the vertical slice under the line (the provisional terrain stage)'],
};
const css = (c: Rgb): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const tickText = (v: number): string => String(v).replace('-', '−');

export function createCrossSection(host: HTMLElement, deps: SectionDeps): CrossSection {
  const { session } = deps;
  const element = el('div', 'cs');
  const button = (text: string, tip: string, run: () => void): HTMLButtonElement => {
    const b = el('button', '', text);
    b.type = 'button';
    b.title = tip;
    b.addEventListener('click', run);
    return b;
  };

  const head = el('div', 'cs-head');
  const lineText = el('span', 'cs-line');
  const status = el('span', 'cs-status');
  const actions = el('div', 'cs-actions');
  const newBtn = button('New line', 'Draw a new line on the map: click its start A, then its end B (Escape cancels)', () => deps.arm());
  const clearBtn = button('Clear', 'Remove the line from the map and this tab', () => deps.clear());
  actions.append(newBtn, clearBtn, button('Close', 'Close the drawer (Escape)', () => deps.close()));
  const modes = el('div', 'cs-modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Cross-section mode');
  const modeButtons = SECTION_MODES.map((m) => {
    const b = button(MODE_LABELS[m][0], MODE_LABELS[m][1], () => setMode(m));
    b.className = 'cs-mode';
    b.dataset['mode'] = m;
    modes.append(b);
    return b;
  });
  head.append(el('strong', 'cs-title', 'Cross-section'), modes, lineText, status, actions);
  const summary = el('div', 'cs-summary');
  const plotHost = el('div', 'cs-plotwrap');
  const root = svg('svg', { class: 'cs-plot', role: 'img', 'aria-label': 'Cross-section profile' });
  /** The Voxels image: SLICE_POINTS × SLICE_ROWS pixels under the SVG, placed over its plot and scaled by CSS. */
  const canvas = el('canvas', 'cs-voxels');
  canvas.width = SLICE_POINTS;
  canvas.height = SLICE_ROWS;
  canvas.hidden = true;
  plotHost.append(canvas, root);
  const legend = el('div', 'cs-legend');
  for (const [cls, label] of [
    ['cs-key-offset', 'offset'], ['cs-key-band', 'offset ± σ'], ['cs-key-offset0', 'offset0'], ['cs-key-sea', 'water at sea level'],
    ['cs-key-lake', 'lake'], ['cs-key-sealine', `sea level ${SEA_LEVEL}`], ['cs-key-river', 'river channel'], ['cs-key-gorge', 'gorge'], ['cs-key-jag', 'jag'],
  ] as const) {
    const item = el('span', 'cs-key');
    item.append(el('span', `cs-swatch ${cls}`), el('span', '', label));
    legend.append(item);
  }
  const voxelLegend = el('div', 'cs-legend');
  voxelLegend.hidden = true;
  const deep = voxelRgb(AIR, WATER_SOURCE, 48);
  for (const [bg, label] of [
    [css(VOXEL_COLORS.sky), 'air'], [css(VOXEL_COLORS.stone), 'stone'], [css(VOXEL_COLORS.bedrock), 'bedrock'],
    [`linear-gradient(to right, ${css(VOXEL_COLORS.water)}, ${css(deep)})`, 'water, darker with depth'],
  ] as const) {
    const item = el('span', 'cs-key');
    const sw = el('span', 'cs-swatch');
    sw.style.background = bg;
    item.append(sw, el('span', '', label));
    voxelLegend.append(item);
  }
  const seaKey = el('span', 'cs-key');
  const seaSwatch = el('span', 'cs-swatch cs-key-sealine');
  seaSwatch.style.borderTopColor = css(VOXEL_COLORS.seaLevel);
  seaKey.append(seaSwatch, el('span', '', `sea level ${SEA_LEVEL_Y}`));
  voxelLegend.append(seaKey);
  const readout = el('div', 'cs-readout', HINT);
  element.append(head, summary, plotHost, legend, voxelLegend, readout);
  host.replaceChildren(element);

  let w = 0;
  let h = 0;
  let mode: SectionMode = 'profile';
  /** The main plot of the last draw (the profile's, or the Voxels sample cells), for the hover readout. */
  let plot: Plot | null = null;
  let cursor: SVGLineElement | null = null;
  /** The Voxels mode's horizontal cursor. */
  let cursorY: SVGLineElement | null = null;
  /** The slice whose pixels the canvas holds. */
  let painted: SliceResult | null = null;
  const summaries = new WeakMap<SliceResult, string>();

  const requests = createSectionRequests({
    session, pool: deps.pool,
    visible: () => deps.visible() && mode === 'profile',
    changed: () => render(),
    failed: (m) => deps.notices.show(`cross-section failed: ${m}`, { kind: 'warn' }),
  });
  const slices = createSliceRequests({
    session, pool: deps.pool,
    visible: () => deps.visible() && mode === 'voxels',
    changed: () => render(),
    failed: (m) => deps.notices.show(`voxel slice failed: ${m}`, { kind: 'warn' }),
  });
  const current = () => (mode === 'profile' ? requests : slices);

  function draw(p: CrossSectionProfile | null, stale: boolean): void {
    plot = null;
    cursor = null;
    cursorY = null;
    canvas.hidden = true;
    root.setAttribute('aria-label', 'Cross-section profile');
    if (p === null || w <= 0 || h <= 0) {
      root.replaceChildren();
      return;
    }
    const range = sectionRange(p);
    const height = Math.max(20, h - MARGIN.top - X_TICKS_PX - GAP_PX - JAG_PX - BOTTOM_PX);
    const width = Math.max(20, w - MARGIN.left - MARGIN.right);
    const main: Plot = { left: MARGIN.left, top: MARGIN.top, width, height, xMin: 0, xMax: p.length, yMin: range.lo, yMax: range.hi };
    const jagTop = MARGIN.top + height + X_TICKS_PX + GAP_PX;
    const jagPlot: Plot = { left: MARGIN.left, top: jagTop, width, height: JAG_PX, xMin: 0, xMax: p.length, yMin: 0, yMax: range.jagMax };
    plot = main;
    root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    const right = main.left + width;
    const bottom = main.top + height;
    const xAt = (d: number): number => toPx(main, d, 0).px;
    const yAt = (y: number): number => toPx(main, 0, y).py;
    const all: Run = { from: 0, to: p.offset.length - 1 };
    const out: SVGElement[] = [];

    const defs = svg('defs');
    const clip = svg('clipPath', { id: CLIP_ID });
    clip.append(svg('rect', { x: main.left, y: main.top, width, height }));
    defs.append(clip);
    out.push(defs, svg('rect', { class: 'cs-frame', x: main.left, y: main.top, width, height }), svg('rect', { class: 'cs-frame cs-jag-frame', x: main.left, y: jagTop, width, height: JAG_PX }));

    // Grid and ticks: distance from A on x (through both strips), blocks on y.
    for (const t of niceTicks(0, p.length, Math.max(2, Math.floor(width / 70)))) {
      out.push(svg('line', { class: 'cs-grid', x1: xAt(t), y1: main.top, x2: xAt(t), y2: jagTop + JAG_PX }));
      out.push(svg('text', { class: 'cs-tick', x: xAt(t), y: bottom + 11, 'text-anchor': 'middle' }, tickText(t)));
    }
    for (const t of niceTicks(range.lo, range.hi, Math.max(3, Math.floor(height / 24)))) {
      out.push(svg('line', { class: 'cs-grid', x1: main.left, y1: yAt(t), x2: right, y2: yAt(t) }));
      out.push(svg('text', { class: 'cs-tick', x: main.left - 4, y: yAt(t) + 3, 'text-anchor': 'end' }, tickText(t)));
    }
    out.push(svg('text', { class: 'cs-axis-label', x: 0, y: 0, transform: `translate(11 ${main.top + height / 2}) rotate(-90)`, 'text-anchor': 'middle' }, 'blocks'));

    // The profile, clipped to the main plot: ground, water, the σ band, offset and offset0, sea level, rivers and gorges.
    const g = svg('g', { 'clip-path': `url(#${CLIP_ID})` });
    g.append(svg('path', { class: 'cs-ground', d: areaPath(main, p, all, (i) => p.offset[i]!, () => range.lo, false) }));
    for (const r of waterRuns(p)) {
      const water = svg('path', { class: `cs-water cs-water-${r.kind}`, d: areaPath(main, p, r, () => r.level, (i) => p.offset[i]!, true) });
      water.append(svg('title', {}, r.kind === 'lake' ? `lake at ${r.level}` : `water at sea level ${r.level}`));
      g.append(water);
    }
    g.append(svg('path', { class: 'cs-band', d: areaPath(main, p, all, (i) => p.offset[i]! + p.sigma[i]!, (i) => p.offset[i]! - p.sigma[i]!, false) }));
    g.append(svg('path', { class: 'cs-offset', d: curvePath(main, p.distance, p.offset) }));
    g.append(svg('path', { class: 'cs-offset0', d: curvePath(main, p.distance, p.offset0) }));
    g.append(svg('line', { class: 'cs-sealine', x1: main.left, y1: yAt(SEA_LEVEL), x2: right, y2: yAt(SEA_LEVEL) }));
    const stripes = (runs: readonly Run[], cls: string, name: string) => {
      for (const r of runs) {
        const s = runSpan(main, p, r);
        const mid = (s.x0 + s.x1) / 2;
        const stripe = svg('g', { class: cls });
        stripe.append(svg('rect', { class: 'cs-stripe', x: s.x0, y: main.top, width: Math.max(1, s.x1 - s.x0), height }));
        stripe.append(svg('path', { class: 'cs-marker', d: `M${mid - MARKER_PX / 2},${main.top}L${mid + MARKER_PX / 2},${main.top}L${mid},${main.top + MARKER_PX}Z` }));
        stripe.append(svg('title', {}, `${name}: ${p.distance[r.from]!.toFixed(0)}-${p.distance[r.to]!.toFixed(0)} blocks from A`));
        g.append(stripe);
      }
    };
    stripes(flagRuns(p.riverWet), 'cs-river', 'river channel');
    stripes(flagRuns(p.gorge), 'cs-gorge', 'gorge');
    out.push(g);
    for (const r of waterRuns(p)) {
      if (r.kind !== 'lake') continue;
      const s = runSpan(main, p, r);
      out.push(svg('text', { class: 'cs-lake-label', x: (s.x0 + s.x1) / 2, y: yAt(r.level) - 3, 'text-anchor': 'middle' }, `lake ${r.level}`));
    }
    out.push(svg('text', { class: 'cs-sea-label', x: main.left + 4, y: yAt(SEA_LEVEL) - 3 }, `sea ${SEA_LEVEL}`));
    out.push(svg('text', { class: 'cs-end-label', x: main.left + 3, y: main.top - 2 }, 'A'));
    out.push(svg('text', { class: 'cs-end-label', x: right - 3, y: main.top - 2, 'text-anchor': 'end' }, 'B'));

    // The jag strip.
    out.push(svg('path', { class: 'cs-jag', d: areaPath(jagPlot, p, all, (i) => p.jag[i]!, () => 0, false) }));
    out.push(svg('text', { class: 'cs-tick', x: main.left - 4, y: jagTop + 8, 'text-anchor': 'end' }, String(range.jagMax)));
    out.push(svg('text', { class: 'cs-tick', x: main.left - 4, y: jagTop + JAG_PX, 'text-anchor': 'end' }, '0'));
    out.push(svg('text', { class: 'cs-axis-label', x: main.left + 4, y: jagTop + 10 }, 'jag'));

    if (stale) out.push(svg('text', { class: 'cs-stale-label', x: right - 4, y: main.top + 12, 'text-anchor': 'end' }, 'profile stale'));
    cursor = svg('line', { class: 'cs-cursor', x1: 0, y1: main.top, x2: 0, y2: jagTop + JAG_PX, visibility: 'hidden' });
    out.push(cursor);
    root.replaceChildren(...out);
  }

  /** The Voxels plot: the slice's pixels on the canvas, and over it in the SVG the axes, the sea level and the cursors. */
  function drawVoxels(s: SliceResult | null, line: Segment | null, stale: boolean): void {
    plot = null;
    cursor = null;
    cursorY = null;
    root.setAttribute('aria-label', 'Cross-section voxels');
    if (s === null || line === null || w <= 0 || h <= 0) {
      canvas.hidden = true;
      root.replaceChildren();
      return;
    }
    const height = Math.max(20, h - MARGIN.top - X_TICKS_PX - BOTTOM_PX);
    const width = Math.max(20, w - MARGIN.left - MARGIN.right);
    const length = segmentLength(line);
    const { cells, distance } = voxelPlots({ left: MARGIN.left, top: MARGIN.top, width, height }, length);
    plot = cells;
    if (painted !== s) {
      canvas.getContext('2d')?.putImageData(new ImageData(sliceRgba(s), SLICE_POINTS, SLICE_ROWS), 0, 0);
      painted = s;
    }
    Object.assign(canvas.style, { left: `${cells.left}px`, top: `${cells.top}px`, width: `${width}px`, height: `${height}px` });
    canvas.hidden = false;
    root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    const right = cells.left + width;
    const bottom = cells.top + height;
    const rowY = (y: number): number => toPx(cells, 0, y + 0.5).py;
    const out: SVGElement[] = [svg('rect', { class: 'cs-frame cs-voxel-frame', x: cells.left, y: cells.top, width, height })];
    for (const t of niceTicks(0, length, Math.max(2, Math.floor(width / 70)))) {
      const x = toPx(distance, t, 0).px;
      out.push(svg('line', { class: 'cs-tickmark', x1: x, y1: bottom, x2: x, y2: bottom + 3 }));
      out.push(svg('text', { class: 'cs-tick', x, y: bottom + 11, 'text-anchor': 'middle' }, tickText(t)));
    }
    for (const t of niceTicks(-64, 319, Math.max(3, Math.floor(height / 24)))) {
      out.push(svg('line', { class: 'cs-tickmark', x1: cells.left - 3, y1: rowY(t), x2: cells.left, y2: rowY(t) }));
      out.push(svg('text', { class: 'cs-tick', x: cells.left - 4, y: rowY(t) + 3, 'text-anchor': 'end' }, tickText(t)));
    }
    out.push(svg('text', { class: 'cs-axis-label', x: 0, y: 0, transform: `translate(11 ${cells.top + height / 2}) rotate(-90)`, 'text-anchor': 'middle' }, 'y'));
    const sea = rowY(SEA_LEVEL_Y);
    out.push(svg('line', { class: 'cs-voxel-sealine', x1: cells.left, y1: sea, x2: right, y2: sea, stroke: css(VOXEL_COLORS.seaLevel) }));
    out.push(svg('text', { class: 'cs-sea-label', x: cells.left + 4, y: sea - 3 }, `sea ${SEA_LEVEL_Y}`));
    out.push(svg('text', { class: 'cs-end-label', x: cells.left + 3, y: cells.top - 2 }, 'A'));
    out.push(svg('text', { class: 'cs-end-label', x: right - 3, y: cells.top - 2, 'text-anchor': 'end' }, 'B'));
    if (stale) out.push(svg('text', { class: 'cs-stale-label', x: right - 4, y: cells.top + 12, 'text-anchor': 'end' }, 'voxels stale'));
    cursor = svg('line', { class: 'cs-cursor', x1: 0, y1: cells.top, x2: 0, y2: bottom, visibility: 'hidden' });
    cursorY = svg('line', { class: 'cs-cursor', x1: cells.left, y1: 0, x2: right, y2: 0, visibility: 'hidden' });
    out.push(cursor, cursorY);
    root.replaceChildren(...out);
  }

  /** What was drawn last, so that a session change that leaves it as it was does not redraw it. */
  let drawn: { readonly mode: SectionMode; readonly value: unknown; readonly stale: boolean; readonly w: number; readonly h: number } | null = null;

  const sliceText = (s: SliceResult): string => {
    let t = summaries.get(s);
    if (t === undefined) {
      t = sliceSummary(s);
      summaries.set(s, t);
    }
    return t;
  };

  function hint(): void {
    readout.textContent = mode === 'profile' ? HINT : VOXEL_HINT;
    delete readout.dataset['point'];
    delete readout.dataset['y'];
  }

  function render(): void {
    const req = current();
    const line = req.line;
    const shown = req.shown;
    const view = sectionView(shown?.epoch ?? null, session.state.epoch, session.inGesture);
    element.dataset['state'] = view;
    element.dataset['mode'] = mode;
    element.setAttribute('aria-busy', String(req.pending !== null));
    lineText.textContent = line === null ? '' : segmentText(line);
    status.textContent = sectionStatus(view, req.pending !== null, line !== null, mode);
    clearBtn.disabled = line === null;
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset['mode'] === mode));
    legend.hidden = mode !== 'profile';
    voxelLegend.hidden = mode !== 'voxels';
    const profile = mode === 'profile' ? requests.shown?.value ?? null : null;
    const slice = mode === 'voxels' ? slices.shown?.value ?? null : null;
    summary.textContent = profile !== null ? sectionSummary(profile) : slice !== null ? sliceText(slice) : '';
    plotHost.classList.toggle('cs-stale', view === 'stale');
    if (!deps.visible()) return;
    const stale = view === 'stale';
    const value = profile ?? slice;
    if (drawn !== null && drawn.mode === mode && drawn.value === value && drawn.stale === stale && drawn.w === w && drawn.h === h) return;
    drawn = { mode, value, stale, w, h };
    if (mode === 'profile') draw(profile, stale);
    else drawVoxels(slice, line, stale);
    hint();
  }

  function setMode(next: SectionMode): void {
    if (next === mode) return;
    mode = next;
    render();
    current().request(deps.driver.status.settled);
  }

  function hoverVoxels(e: PointerEvent): void {
    const s = slices.shown?.value;
    const line = slices.line;
    if (plot === null || cursor === null || cursorY === null || s === undefined || line === null) return;
    const r = root.getBoundingClientRect();
    const cell = voxelCell(plot, e.clientX - r.left, e.clientY - r.top);
    if (cell === null) {
      cursor.setAttribute('visibility', 'hidden');
      cursorY.setAttribute('visibility', 'hidden');
      hint();
      return;
    }
    const x = toPx(plot, cell.i + 0.5, 0).px;
    const y = toPx(plot, 0, cell.y + 0.5).py;
    cursor.setAttribute('x1', String(x));
    cursor.setAttribute('x2', String(x));
    cursorY.setAttribute('y1', String(y));
    cursorY.setAttribute('y2', String(y));
    cursor.setAttribute('visibility', 'visible');
    cursorY.setAttribute('visibility', 'visible');
    readout.textContent = voxelReadout(line, s, cell.i, cell.y);
    readout.dataset['point'] = String(cell.i);
    readout.dataset['y'] = String(cell.y);
  }

  root.addEventListener('pointermove', (e) => {
    if (mode === 'voxels') {
      hoverVoxels(e);
      return;
    }
    const p = requests.shown?.value;
    if (plot === null || cursor === null || p === undefined) return;
    const r = root.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < plot.left - 2 || px > plot.left + plot.width + 2) {
      cursor.setAttribute('visibility', 'hidden');
      readout.textContent = HINT;
      return;
    }
    const i = nearestPoint(plot, px);
    const x = toPx(plot, p.distance[i]!, 0).px;
    cursor.setAttribute('x1', String(x));
    cursor.setAttribute('x2', String(x));
    cursor.setAttribute('visibility', 'visible');
    readout.textContent = sectionReadout(p, i);
    readout.dataset['point'] = String(i);
  });
  root.addEventListener('pointerleave', () => {
    cursor?.setAttribute('visibility', 'hidden');
    cursorY?.setAttribute('visibility', 'hidden');
    hint();
  });

  new ResizeObserver(() => {
    const r = plotHost.getBoundingClientRect();
    w = Math.floor(r.width);
    h = Math.floor(r.height);
    render();
  }).observe(plotHost);

  const offSession = session.subscribe(() => render());
  // The driver's status still reads unsettled while it runs its onSettled listeners.
  const offSettled = deps.driver.onSettled(() => current().request(true));
  render();

  return {
    element,
    setLine(line) {
      requests.setLine(line);
      slices.setLine(line);
      current().request(deps.driver.status.settled);
    },
    get line() { return requests.line; },
    shown() {
      render();
      current().request(deps.driver.status.settled);
    },
    get mode() { return mode; },
    setMode,
    dispose() {
      offSession();
      offSettled();
    },
  };
}

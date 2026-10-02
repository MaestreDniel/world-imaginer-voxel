/**
 * The Cross-section tab of the drawer (SP2b spec §4.5): the columns along the map's cut line A → B at 512
 * points, from one `crossSection` stats job on the pool.
 * - Header: the line (A, B and its length), the status, and the buttons New line (arms the map's cut-line
 *   tool), Clear and Close; a summary line (offset range, water, river channels, gorges, lakes) under it.
 * - Plot (SVG): distance from A on x, blocks on y. The ground under offset; offset ± σ as a band around the
 *   offset line; offset0 as a thin dashed line; water above the ground (at sea level, and lakes labelled with
 *   their level); sea level 63 as a dashed line; river channels and gorges as stripes with a marker on the top
 *   edge; under the axis a strip with jag. Hovering the plot reads the nearest point.
 * - The profile is requested (model.ts createSectionRequests) when the preview driver settles while the tab is
 *   on screen, when the tab comes on screen while it is settled and when a new line is set, so it always runs on
 *   the draft the map shows. It is stale (dimmed, with its status) from the next session change, or during a
 *   gesture, until a new result arrives; a cancelled request stays stale silently, any other failure also
 *   shows a notice.
 */
import './section.css';
import { SEA_LEVEL } from '../../core/constants';
import type { WorldSession } from '../../engine/session';
import type { WorkerPool } from '../../engine/workerPool';
import type { CrossSectionProfile, Segment } from '../../metrics/crossSection';
import { el } from '../common/dom';
import type { Notices } from '../common/notice';
import type { PreviewDriver } from '../map/previewDriver';
import { curvePath, niceTicks, toPx, type Plot } from '../splineEditor/model';
import {
  areaPath, createSectionRequests, flagRuns, nearestPoint, runSpan, sectionRange, sectionReadout, sectionStatus, sectionSummary, sectionView,
  segmentText, waterRuns, type Run,
} from './model';

export interface SectionDeps {
  readonly session: WorldSession;
  readonly notices: Notices;
  /** The pool's statistics jobs (spec §5.4). */
  readonly pool: Pick<WorkerPool, 'stats'>;
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
  /** Profiles `line` (null: none); requests it at once if the tab is on screen and the driver is settled. */
  setLine(line: Segment | null): void;
  readonly line: Segment | null;
  /** The tab came on screen: renders and requests the profile if the driver is settled and it is not current. */
  shown(): void;
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
  head.append(el('strong', 'cs-title', 'Cross-section'), lineText, status, actions);
  const summary = el('div', 'cs-summary');
  const plotHost = el('div', 'cs-plotwrap');
  const root = svg('svg', { class: 'cs-plot', role: 'img', 'aria-label': 'Cross-section profile' });
  plotHost.append(root);
  const legend = el('div', 'cs-legend');
  for (const [cls, label] of [
    ['cs-key-offset', 'offset'], ['cs-key-band', 'offset ± σ'], ['cs-key-offset0', 'offset0'], ['cs-key-sea', 'water at sea level'],
    ['cs-key-lake', 'lake'], ['cs-key-sealine', `sea level ${SEA_LEVEL}`], ['cs-key-river', 'river channel'], ['cs-key-gorge', 'gorge'], ['cs-key-jag', 'jag'],
  ] as const) {
    const item = el('span', 'cs-key');
    item.append(el('span', `cs-swatch ${cls}`), el('span', '', label));
    legend.append(item);
  }
  const readout = el('div', 'cs-readout', HINT);
  element.append(head, summary, plotHost, legend, readout);
  host.replaceChildren(element);

  let w = 0;
  let h = 0;
  /** The main plot of the last draw, for the hover readout. */
  let plot: Plot | null = null;
  let cursor: SVGLineElement | null = null;

  const requests = createSectionRequests({
    session, pool: deps.pool,
    visible: () => deps.visible(),
    changed: () => render(),
    failed: (m) => deps.notices.show(`cross-section failed: ${m}`, { kind: 'warn' }),
  });

  function draw(p: CrossSectionProfile | null, stale: boolean): void {
    plot = null;
    cursor = null;
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

  /** The profile drawn last, so that a session change that leaves it as it was does not redraw it. */
  let drawn: { readonly profile: CrossSectionProfile | null; readonly stale: boolean; readonly w: number; readonly h: number } | null = null;

  function render(): void {
    const line = requests.line;
    const shown = requests.shown;
    const view = sectionView(shown?.epoch ?? null, session.state.epoch, session.inGesture);
    element.dataset['state'] = view;
    element.setAttribute('aria-busy', String(requests.pending !== null));
    lineText.textContent = line === null ? '' : segmentText(line);
    status.textContent = sectionStatus(view, requests.pending !== null, line !== null);
    clearBtn.disabled = line === null;
    const profile = shown?.profile ?? null;
    summary.textContent = profile === null ? '' : sectionSummary(profile);
    plotHost.classList.toggle('cs-stale', view === 'stale');
    if (!deps.visible()) return;
    const stale = view === 'stale';
    if (drawn !== null && drawn.profile === profile && drawn.stale === stale && drawn.w === w && drawn.h === h) return;
    drawn = { profile, stale, w, h };
    draw(profile, stale);
    readout.textContent = HINT;
    delete readout.dataset['point'];
  }

  root.addEventListener('pointermove', (e) => {
    const p = requests.shown?.profile;
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
    readout.textContent = HINT;
    delete readout.dataset['point'];
  });

  new ResizeObserver(() => {
    const r = plotHost.getBoundingClientRect();
    w = Math.floor(r.width);
    h = Math.floor(r.height);
    render();
  }).observe(plotHost);

  const offSession = session.subscribe(() => render());
  // The driver's status still reads unsettled while it runs its onSettled listeners.
  const offSettled = deps.driver.onSettled(() => requests.request(true));
  render();

  return {
    element,
    setLine(line) {
      requests.setLine(line);
      requests.request(deps.driver.status.settled);
    },
    get line() { return requests.line; },
    shown() {
      render();
      requests.request(deps.driver.status.settled);
    },
    dispose() {
      offSession();
      offSettled();
    },
  };
}

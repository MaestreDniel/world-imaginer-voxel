/**
 * The spline drawer's plot (SP2b spec §4.2, §4.3): an SVG of the open node. The x axis is the node's coord over
 * [min(−1, x_first), max(1, x_last)] with the hold regions beyond the end knots shaded and marks at ±L; the y
 * axis is the leaf's range in its unit, with sea level for offset. The curve is the generator's evaluation at
 * the probe; nested knots are hollow at their child's value. Overlays: the coordinate histogram over [−1, 1]
 * and, under the axis, the land and world share of every segment and hold region (dimmed while stale).
 *
 * Interaction: a click selects a knot (empty space clears the selection); dragging a knot or a tangent handle
 * of the selected knot reports pointer moves between dragStart and dragEnd (release, cancel or lost capture;
 * the plot's x range is frozen during a drag); a double click opens a nested knot or inserts on empty plot
 * space; a context menu on a knot asks for the knot menu. The plot only reports: the drawer edits.
 */
import type { NestedSpline, SplineCoord } from '../../core/spline/types';
import type { SplineStatsSummary } from '../../metrics/splineStats';
import {
  curvePath, formatShare, fromPx, hitHandle, hitKnot, histogramBars, knotViews, niceTicks, plotFor, regionBands, regionText, sampleCurve,
  tangentFromPointer, tangentHandles, toPx, type KnotView, type LeafView, type Plot, type PlotBox,
} from './model';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number>> = {}, text = ''): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== '') e.textContent = text;
  return e;
}

/** Margins in CSS px: the y tick labels on the left; the x tick labels and the two share rows at the bottom. */
const MARGIN = { left: 46, right: 12, top: 10, bottom: 56 } as const;
const KNOT_R = 5;
const KNOT_HIT_PX = 8;
const HANDLE_LEN_PX = 30;
const HANDLE_HIT_PX = 7;
/** Curve samples: one per this many pixels of plot width. */
const PX_PER_SAMPLE = 2;
/** The tallest histogram bar, as a fraction of the plot height. */
const HISTOGRAM_FRACTION = 0.35;
/** A share row's height and the narrowest band that shows its percentage. */
const ROW_PX = 15;
const LABEL_MIN_PX = 38;
/** A press must move this far before it becomes a drag. */
const DRAG_START_PX = 2;
const CLIP_ID = 'sd-plot-clip';

export interface PlotOverlay {
  readonly summary: SplineStatsSummary;
  readonly stale: boolean;
}

export interface PlotInput {
  readonly view: LeafView;
  readonly node: NestedSpline;
  readonly probe: Float64Array;
  readonly selected: number | null;
  /** Knots of this node that a lint names. */
  readonly linted: ReadonlySet<number>;
  /** The ±L marks of the node's coord (none for PV). */
  readonly marks: readonly number[];
  readonly overlay: PlotOverlay | null;
}

export interface PlotEvents {
  /** A press on a knot, or on empty space (null). */
  select(k: number | null): void;
  /** The first move of a knot or tangent drag, and its end (release, cancel or lost capture). */
  dragStart(): void;
  dragEnd(): void;
  /** A knot drag move: the pointer in data units, not clamped. */
  moveKnot(e: PointerEvent, k: number, x: number, y: number): void;
  /** A tangent-handle drag move: the tangent the pointer sets (model.ts tangentFromPointer). */
  moveTangent(e: PointerEvent, k: number, d: number): void;
  /** A double click on a nested knot (k), or on empty plot space at data x (k = null). */
  doubleClick(e: MouseEvent, k: number | null, x: number): void;
  /** A context menu on knot k. */
  menu(e: MouseEvent, k: number): void;
}

export interface SplinePlot {
  readonly element: SVGSVGElement;
  render(input: PlotInput): void;
  /** The transform of the last draw, or null before the first. */
  readonly plot: Plot | null;
}

interface Drag {
  readonly kind: 'knot' | 'tangent';
  readonly k: number;
  readonly pointerId: number;
  readonly px: number;
  readonly py: number;
  /** A knot drag keeps the knot where it was grabbed relative to the pointer (it does not jump to the pointer). */
  readonly gx: number;
  readonly gy: number;
  /** The transform at the press: the x range does not follow a knot dragged past ±1 until the release. */
  readonly plot: Plot;
  started: boolean;
}

const tickText = (v: number): string => String(v).replace('-', '−');

export function createSplinePlot(host: HTMLElement, ev: PlotEvents): SplinePlot {
  const root = svg('svg', { class: 'sd-plot', tabindex: 0, role: 'img', 'aria-label': 'Spline plot' });
  host.append(root);
  let w = 0;
  let h = 0;
  let input: PlotInput | null = null;
  let plot: Plot | null = null;
  let views: KnotView[] = [];
  let drag: Drag | null = null;

  const box = (): PlotBox => ({
    left: MARGIN.left, top: MARGIN.top,
    width: Math.max(10, w - MARGIN.left - MARGIN.right), height: Math.max(10, h - MARGIN.top - MARGIN.bottom),
  });

  function overlayGroup(p: Plot, o: PlotOverlay, coord: SplineCoord): SVGGElement {
    const g = svg('g', { class: `sd-overlay${o.stale ? ' sd-stale' : ''}` });
    const bottom = p.top + p.height;
    const bars = svg('g', { class: 'sd-bars', 'clip-path': `url(#${CLIP_ID})` });
    for (const b of histogramBars(p, o.summary.histogram, HISTOGRAM_FRACTION * p.height)) {
      if (b.height > 0) bars.append(svg('rect', { class: 'sd-bar', x: b.x0, y: bottom - b.height, width: Math.max(0, b.x1 - b.x0 - 0.5), height: b.height }));
    }
    g.append(bars);
    const bands = regionBands(p, o.summary.regions);
    const rows: ReadonlyArray<readonly ['land' | 'world', number]> = [['land', bottom + 20], ['world', bottom + 20 + ROW_PX + 2]];
    for (const [row, y] of rows) {
      let max = 0;
      for (const b of bands) if (b[row] > max) max = b[row];
      g.append(svg('text', { class: 'sd-row-label', x: p.left - 4, y: y + ROW_PX - 4, 'text-anchor': 'end' }, row));
      for (const b of bands) {
        const share = b[row];
        const band = svg('g', { class: `sd-band sd-band-${row}`, 'data-region': b.index });
        band.append(svg('rect', { x: b.x0 + 0.5, y, width: Math.max(0, b.x1 - b.x0 - 1), height: ROW_PX, 'fill-opacity': max > 0 ? 0.12 + (0.6 * share) / max : 0.12 }));
        if (b.x1 - b.x0 >= LABEL_MIN_PX) band.append(svg('text', { x: (b.x0 + b.x1) / 2, y: y + ROW_PX - 4, 'text-anchor': 'middle' }, formatShare(share)));
        band.append(svg('title', {}, regionText(coord, o.summary.regions[b.index]!)));
        g.append(band);
      }
    }
    if (o.stale) g.append(svg('text', { class: 'sd-stale-label', x: p.left + 4, y: p.top + 12 }, 'statistics stale'));
    return g;
  }

  function draw(): void {
    if (input === null || w <= 0 || h <= 0) return;
    const { view, node, probe, selected } = input;
    const p = drag?.plot ?? plotFor(node, view.yMin, view.yMax, box());
    plot = p;
    views = knotViews(node, probe);
    root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    const right = p.left + p.width;
    const bottom = p.top + p.height;
    const xAt = (x: number): number => toPx(p, x, 0).px;
    const yAt = (y: number): number => toPx(p, 0, y).py;
    const out: SVGElement[] = [];

    const defs = svg('defs');
    const clip = svg('clipPath', { id: CLIP_ID });
    clip.append(svg('rect', { x: p.left, y: p.top, width: p.width, height: p.height }));
    defs.append(clip);
    out.push(defs, svg('rect', { class: 'sd-frame', x: p.left, y: p.top, width: p.width, height: p.height }));

    // Hold regions: beyond the end knots the curve holds the end knot's value.
    const x0 = xAt(node.points[0]!.x);
    const x1 = xAt(node.points[node.points.length - 1]!.x);
    if (x0 > p.left) out.push(svg('rect', { class: 'sd-hold', x: p.left, y: p.top, width: x0 - p.left, height: p.height }));
    if (x1 < right) out.push(svg('rect', { class: 'sd-hold', x: x1, y: p.top, width: right - x1, height: p.height }));

    if (input.overlay !== null) out.push(overlayGroup(p, input.overlay, node.coord));

    // Grid and ticks.
    for (const t of niceTicks(p.xMin, p.xMax, Math.max(3, Math.floor(p.width / 60)))) {
      out.push(svg('line', { class: 'sd-grid', x1: xAt(t), y1: p.top, x2: xAt(t), y2: bottom }));
      out.push(svg('text', { class: 'sd-tick', x: xAt(t), y: bottom + 12, 'text-anchor': 'middle' }, tickText(t)));
    }
    for (const t of niceTicks(p.yMin, p.yMax, Math.max(3, Math.floor(p.height / 26)))) {
      out.push(svg('line', { class: 'sd-grid', x1: p.left, y1: yAt(t), x2: right, y2: yAt(t) }));
      out.push(svg('text', { class: 'sd-tick', x: p.left - 4, y: yAt(t) + 3, 'text-anchor': 'end' }, tickText(t)));
    }
    out.push(svg('text', { class: 'sd-axis-label', x: right - 4, y: p.top + 12, 'text-anchor': 'end' }, node.coord));
    out.push(svg('text', { class: 'sd-axis-label', x: 0, y: 0, transform: `translate(11 ${p.top + p.height / 2}) rotate(-90)`, 'text-anchor': 'middle' }, view.unit));
    if (view.seaLevel !== null) {
      out.push(svg('line', { class: 'sd-sea', x1: p.left, y1: yAt(view.seaLevel), x2: right, y2: yAt(view.seaLevel) }));
      out.push(svg('text', { class: 'sd-sea-label', x: p.left + 4, y: yAt(view.seaLevel) - 3 }, `sea ${view.seaLevel}`));
    }
    for (const m of input.marks) {
      const mark = svg('line', { class: 'sd-reach', x1: xAt(m), y1: p.top, x2: xAt(m), y2: bottom });
      mark.append(svg('title', {}, `${node.coord} reaches ±${Math.abs(m).toFixed(4)} at the current clamp`));
      out.push(mark);
    }

    // The curve at the probe, clipped to the plot.
    const n = Math.max(2, Math.round(p.width / PX_PER_SAMPLE));
    const c = sampleCurve(node, probe, p.xMin, p.xMax, n);
    out.push(svg('path', { class: 'sd-curve', d: curvePath(p, c.xs, c.ys), 'clip-path': `url(#${CLIP_ID})` }));

    // The selected knot's tangent handles, then the knots (selected and linted ones marked).
    const sel = selected !== null ? views[selected] : undefined;
    if (sel !== undefined) {
      const [a, b] = tangentHandles(p, sel, HANDLE_LEN_PX);
      out.push(svg('line', { class: 'sd-tangent', x1: a.px, y1: a.py, x2: b.px, y2: b.py }));
      for (const q of [a, b]) out.push(svg('circle', { class: 'sd-handle', cx: q.px, cy: q.py, r: 3.5, 'data-k': selected! }));
    }
    views.forEach((v, k) => {
      const q = toPx(p, v.x, v.y);
      const cls = `sd-knot${v.nested ? ' sd-nested' : ''}${k === selected ? ' sd-selected' : ''}${input!.linted.has(k) ? ' sd-linted' : ''}`;
      const dot = svg('circle', { class: cls, cx: q.px, cy: q.py, r: k === selected ? KNOT_R + 1.5 : KNOT_R, 'data-k': k });
      dot.append(svg('title', {}, `knot ${k}: ${node.coord} = ${v.x}, ${v.nested ? `${view.key} ${v.y.toFixed(2)} at the probe (nested)` : `y = ${v.y}`}, d = ${v.d}`));
      out.push(dot);
    });
    root.replaceChildren(...out);
  }

  const local = (e: MouseEvent): { readonly px: number; readonly py: number } => {
    const r = root.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const inside = (p: Plot, px: number, py: number): boolean => px >= p.left && px <= p.left + p.width && py >= p.top && py <= p.top + p.height;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || input === null || plot === null || drag !== null) return;
    root.focus({ preventScroll: true });
    const { px, py } = local(e);
    const sel = input.selected;
    const begin = (kind: Drag['kind'], k: number) => {
      const q = toPx(plot!, views[k]!.x, views[k]!.y);
      const grab = kind === 'knot';
      drag = { kind, k, pointerId: e.pointerId, px, py, gx: grab ? q.px - px : 0, gy: grab ? q.py - py : 0, plot: plot!, started: false };
      root.setPointerCapture(e.pointerId);
    };
    if (sel !== null && views[sel] !== undefined && hitHandle(plot, views[sel], px, py, HANDLE_LEN_PX, HANDLE_HIT_PX)) {
      begin('tangent', sel);
      return;
    }
    const k = hitKnot(plot, views, px, py, KNOT_HIT_PX);
    ev.select(k);
    if (k !== null) begin('knot', k);
  });
  root.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const { px, py } = local(e);
    if (!drag.started) {
      if (Math.abs(px - drag.px) < DRAG_START_PX && Math.abs(py - drag.py) < DRAG_START_PX) return;
      drag.started = true;
      ev.dragStart();
    }
    if (drag.kind === 'knot') {
      const d = fromPx(drag.plot, px + drag.gx, py + drag.gy);
      ev.moveKnot(e, drag.k, d.x, d.y);
    } else {
      const v = views[drag.k];
      if (v !== undefined) ev.moveTangent(e, drag.k, tangentFromPointer(drag.plot, v, px, py));
    }
  });
  const end = (e: PointerEvent) => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const started = drag.started;
    drag = null;
    if (started) ev.dragEnd();
    draw();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', end);
  root.addEventListener('dblclick', (e) => {
    if (input === null || plot === null) return;
    const { px, py } = local(e);
    const k = hitKnot(plot, views, px, py, KNOT_HIT_PX);
    if (k !== null) {
      if (views[k]!.nested) ev.doubleClick(e, k, views[k]!.x);
      return;
    }
    if (inside(plot, px, py)) ev.doubleClick(e, null, fromPx(plot, px, py).x);
  });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (input === null || plot === null) return;
    const { px, py } = local(e);
    const k = hitKnot(plot, views, px, py, KNOT_HIT_PX);
    if (k === null) return;
    ev.select(k);
    ev.menu(e, k);
  });

  new ResizeObserver(() => {
    const r = host.getBoundingClientRect();
    w = Math.floor(r.width);
    h = Math.floor(r.height);
    draw();
  }).observe(host);

  return {
    element: root,
    render(next) {
      input = next;
      draw();
    },
    get plot() { return plot; },
  };
}

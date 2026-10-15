/**
 * The Density tab's slice viewer (SP3d spec §4, §3.6, §3.7, D16, D18): the DOM over `sliceModel.ts`.
 * - Controls: the plane (vertical along the cut line, or horizontal XZ), the field (`density`, `selected` naming the
 *   selected node, `blocks`; options that cannot slice on the plane are disabled with their note), the y control (shown
 *   on both planes: the plane's level when horizontal, a line across a vertical slice), the horizontal extent, and the
 *   colour scale (Auto, or a fixed number in (0, 1e100]). Under them the note that the 2D map is upstream of the terrain.
 * - The image: n × n canvas pixels scaled by CSS (`image-rendering: pixelated`) into a square box whose side is the
 *   smaller of its cell's width and height (at least 128 px), with an SVG overlay (the 0-contour, the sea level and the y
 *   level on vertical planes), the axes' end labels in blocks, a hover readout overlay and a "stale" label (dimmed).
 * - Beside it the histogram and its statistics for `density`/`node`, the Voxels legend for `blocks`, the share of 1s
 *   for `rule`; a status line and the request stream's notice (the field's note, a refusal, `failed: …`).
 * - Requests (§4.5): `createFieldSliceRequests` on the pool's resolved configure; the page calls `update()` on every
 *   session change, driver status change, line change and selection change. The state starts at the first show
 *   (`initialSliceState`) and is reported to the page (`onState`: the map's square and the click routing); a map click on
 *   the horizontal plane sets the centre (`setCentre`). The slice hover reports its voxel (`onHover`) for the form's value.
 * - Pinned slices (§11's cut line; master §5.5): "Pin" copies the live slice's plane, field and node into a pin (up to
 *   3, side by side under the live slice); each pin has its own request stream (`createSlicePins`), asked on every
 *   `update()` like the live one, and shows its label, image (the live scale setting, the 0-contour and the sea level),
 *   a hover readout of its own samples (not fed to the form), stale dimming, its status and its notice; × unpins it.
 * Text only through `textContent`. DOM only: the rules are in sliceModel.ts.
 */
import { SEA_LEVEL, SLICE_EXTENTS } from '../../core/constants';
import type { WorkerPool } from '../../engine/workerPool';
import type { Segment } from '../../metrics/crossSection';
import { el } from '../common/dom';
import type { SlicePlane } from '../map/clickAction';
import type { HoverVoxel } from './hoverModel';
import type { Selection } from './model';
import {
  blocksLegend, contourPath, createFieldSliceRequests, createSlicePins, fieldOptionLabel, fieldOptions, fieldSliceView, histogram,
  histogramLabels, initialSliceState, levelLine, parseScale, parseSliceY, PIN_FULL_TEXT, PIN_MAX, pointerPixel, ruleShare,
  ruleShareText, sliceAxisLabels, sliceBoxSide, sliceEmptyText, sliceHoverText, sliceImage, slicePointer, sliceStatusText,
  withCentre, withExtent, type ConfiguredDraft, type FieldChoice, type SlicePin, type SlicePointer, type SliceShown,
  type SliceStart, type SliceState,
} from './sliceModel';

/** The note under the plane controls (§3.1, §1.5). */
export const DENSITY_NOTE = 'Tree edits show in the slices, the Voxels mode and the hover values; the 2D map is upstream of the terrain';

export interface SliceViewDeps {
  /** The session's current epoch: a slice of an older one is stale. */
  readonly session: { readonly state: { readonly epoch: number } };
  readonly pool: Pick<WorkerPool, 'fieldSlice' | 'size' | 'epoch'>;
  /** The pool's last resolved configure and its draft's params (null before one). */
  configured(): ConfiguredDraft | null;
  /** The cross-section's line (the vertical plane). */
  line(): Segment | null;
  /** The tree's selection (the `selected` field). */
  selection(): Selection;
  /** The first show's inputs: the line, the map view's centre and the pin (§3.7). */
  start(): SliceStart;
  /** The state changed (the page draws the horizontal square and routes map clicks by the plane). */
  onState(state: SliceState): void;
  /** The pointer is over a slice sample's voxel, or left the image (null). */
  onHover(voxel: HoverVoxel | null): void;
}

export interface SliceView {
  readonly element: HTMLElement;
  /** Null until the first show. */
  readonly state: SliceState | null;
  /** The tab is on screen or not: the first show sets the state; a hidden view requests nothing. */
  setShown(shown: boolean): void;
  /** A map click on the horizontal plane: the centre moves there (clamped into the window). */
  setCentre(x: number, z: number): void;
  /** Something a slice depends on changed: requests (when needed) and redraws. */
  update(): void;
  dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number>> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
/** The aside's width and its gap to the box (CSS px; inspector.css's .sv-aside and .sv-row). */
const ASIDE_PX = 168 + 10;
const PLANE_LABELS: Readonly<Record<SlicePlane, string>> = { vertical: 'vertical (cut line)', horizontal: 'horizontal (XZ)' };
const PIN_TITLE = `Pin this slice: it keeps its plane, field and node and follows every edit (up to ${PIN_MAX})`;
const rgbCss = (c: readonly [number, number, number]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export function createSliceView(host: HTMLElement, deps: SliceViewDeps): SliceView {
  let state: SliceState | null = null;
  let shown = false;
  let fixedScale: number | null = null;
  /** The image last drawn: redrawn only when the shown slice or the scale changes. */
  let drawn: { readonly shown: SliceShown; readonly fixed: number | null } | null = null;
  /** The pointer over the live box (fractions: the sample under it follows the shown slice's n). */
  let hoverAt: SlicePointer | null = null;

  // ---------------------------------------------------------------- DOM
  const element = el('div', 'sv');
  const controls = el('div', 'sv-controls');
  const label = (text: string, control: HTMLElement): HTMLLabelElement => {
    const l = el('label', 'sv-control');
    l.append(el('span', 'sv-label', text), control);
    return l;
  };
  const planeSelect = el('select', 'sv-select');
  for (const p of ['vertical', 'horizontal'] as const) {
    const o = el('option', '', PLANE_LABELS[p]);
    o.value = p;
    planeSelect.append(o);
  }
  const fieldSelect = el('select', 'sv-select');
  const yInput = el('input', 'sv-input');
  yInput.type = 'text';
  yInput.inputMode = 'numeric';
  yInput.size = 4;
  yInput.title = 'y level (−64 … 319): the horizontal plane, or a line across the vertical slice';
  const extentSelect = el('select', 'sv-select');
  for (const e of SLICE_EXTENTS) {
    const o = el('option', '', `${e} blocks`);
    o.value = String(e);
    extentSelect.append(o);
  }
  const extentControl = label('extent', extentSelect);
  const autoBox = el('input');
  autoBox.type = 'checkbox';
  autoBox.checked = true;
  const scaleInput = el('input', 'sv-input');
  scaleInput.type = 'text';
  scaleInput.size = 7;
  scaleInput.disabled = true;
  scaleInput.title = 'A fixed colour scale: a number in (0, 1e100]';
  const autoLabel = el('label', 'sv-check');
  autoLabel.append(autoBox, el('span', '', 'Auto'));
  const scaleControl = el('span', 'sv-control');
  scaleControl.append(el('span', 'sv-label', 'scale'), autoLabel, scaleInput);
  const pinButton = el('button', 'sv-button', 'Pin');
  pinButton.type = 'button';
  pinButton.title = PIN_TITLE;
  controls.append(label('plane', planeSelect), label('field', fieldSelect), label('y', yInput), extentControl, scaleControl, pinButton);
  const note = el('div', 'sv-note', DENSITY_NOTE);

  const body = el('div', 'sv-body');
  const row = el('div', 'sv-row');
  const topLabel = el('div', 'sv-axis');
  const box = el('div', 'sv-box');
  const canvas = el('canvas', 'sv-image');
  const overlay = svg('svg', { class: 'sv-overlay', preserveAspectRatio: 'none' });
  const contourEl = svg('path', { class: 'sv-contour' });
  const seaLine = svg('line', { class: 'sv-sea' });
  const yLine = svg('line', { class: 'sv-level' });
  overlay.append(contourEl, seaLine, yLine);
  const readout = el('div', 'sv-readout');
  readout.hidden = true;
  const staleLabel = el('div', 'sv-stale-label', 'stale');
  const empty = el('div', 'sv-empty');
  box.append(canvas, overlay, staleLabel, readout);
  const bottomLabel = el('div', 'sv-axis');
  const ends = el('div', 'sv-ends');
  const leftLabel = el('span', '');
  const rightLabel = el('span', '');
  ends.append(leftLabel, rightLabel);
  const aside = el('div', 'sv-aside');
  const histo = svg('svg', { class: 'sv-histogram', viewBox: '0 0 64 40', preserveAspectRatio: 'none' });
  const stats = el('div', 'sv-stats');
  const legend = el('div', 'sv-legend');
  aside.append(histo, stats, legend);
  row.append(box, aside);
  body.append(topLabel, row, empty, bottomLabel, ends);
  const status = el('div', 'sv-status');
  const notice = el('div', 'sv-notice');
  const pinNotice = el('div', 'sv-notice');
  pinNotice.hidden = true;
  const pinStrip = el('div', 'sv-pins');
  pinStrip.hidden = true;
  element.append(controls, note, status, notice, pinNotice, body, pinStrip);
  host.append(element);

  const source = {
    pool: deps.pool,
    session: deps.session,
    configured: () => deps.configured(),
    visible: () => shown && state !== null,
    changed: () => render(),
  };
  const requests = createFieldSliceRequests(source);
  const pins = createSlicePins(source);
  /** The pins' DOM by id, created on add and removed on unpin. */
  const pinViews = new Map<number, PinView>();
  const showPinNotice = (text: string | null): void => {
    pinNotice.textContent = text ?? '';
    pinNotice.hidden = text === null;
  };
  pinButton.addEventListener('click', () => {
    if (state === null) return;
    showPinNotice(pins.add({ state, line: deps.line(), selection: deps.selection() }));
  });

  // ---------------------------------------------------------------- state
  const setState = (next: SliceState): void => {
    state = next;
    deps.onState(next);
    update();
  };
  planeSelect.addEventListener('change', () => {
    if (state !== null) setState({ ...state, plane: planeSelect.value as SlicePlane });
  });
  fieldSelect.addEventListener('change', () => {
    if (state !== null) setState({ ...state, field: fieldSelect.value as FieldChoice });
  });
  yInput.addEventListener('change', () => {
    if (state === null) return;
    const y = parseSliceY(yInput.value);
    yInput.classList.toggle('sv-invalid', y === null);
    if (y !== null) setState({ ...state, y });
  });
  yInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state === null) return;
    yInput.value = String(state.y);
    yInput.classList.remove('sv-invalid');
  });
  extentSelect.addEventListener('change', () => {
    if (state !== null) setState(withExtent(state, Number(extentSelect.value)));
  });
  const scaleChanged = (): void => {
    scaleInput.disabled = autoBox.checked;
    const v = autoBox.checked ? null : parseScale(scaleInput.value);
    scaleInput.classList.toggle('sv-invalid', !autoBox.checked && v === null);
    if (autoBox.checked || v !== null) fixedScale = v;
    render();
  };
  autoBox.addEventListener('change', scaleChanged);
  scaleInput.addEventListener('change', scaleChanged);

  // ---------------------------------------------------------------- the square box and the hover
  // The box's cell is the body less its axis labels and the aside (always reserved, so the box does not jump).
  const resize = new ResizeObserver(() => {
    const r = body.getBoundingClientRect();
    const labels = topLabel.offsetHeight + bottomLabel.offsetHeight + ends.offsetHeight;
    const side = sliceBoxSide(r.width - ASIDE_PX, r.height - labels);
    box.style.width = `${side}px`;
    box.style.height = `${side}px`;
    ends.style.minWidth = `${side}px`;
    aside.style.maxHeight = `${side}px`;
  });
  resize.observe(body);

  const showHover = (): void => {
    const s = requests.shown;
    const at = s === null ? null : pointerPixel(hoverAt, s.result.n);
    if (at === null || s === null || s.result.n !== s.geometry.n || at.px >= s.geometry.n || at.py >= s.geometry.n) {
      readout.hidden = true;
      deps.onHover(null);
      return;
    }
    const h = sliceHoverText(s, at.px, at.py);
    readout.textContent = h.text;
    readout.title = h.text;
    readout.hidden = false;
    deps.onHover(h.voxel);
  };
  box.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const next = slicePointer(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    const n = requests.shown?.result.n ?? 0;
    const was = pointerPixel(hoverAt, n), now = pointerPixel(next, n);
    hoverAt = next;
    if (was?.px === now?.px && was?.py === now?.py) return;
    showHover();
  });
  box.addEventListener('pointerleave', () => {
    hoverAt = null;
    showHover();
  });

  // ---------------------------------------------------------------- drawing
  const syncControls = (s: SliceState): void => {
    planeSelect.value = s.plane;
    const sel = deps.selection();
    const opts = fieldOptions(s.plane, sel);
    const key = opts.map((o) => `${o.value}:${o.disabled}:${fieldOptionLabel(o.value, sel)}`).join('|');
    if (fieldSelect.dataset['key'] !== key) {
      fieldSelect.dataset['key'] = key;
      fieldSelect.replaceChildren(...opts.map((o) => {
        const opt = el('option', '', fieldOptionLabel(o.value, sel));
        opt.value = o.value;
        opt.disabled = o.disabled;
        if (o.note !== null) opt.title = o.note;
        return opt;
      }));
    }
    fieldSelect.value = s.field;
    if (document.activeElement !== yInput && !yInput.classList.contains('sv-invalid')) yInput.value = String(s.y);
    extentSelect.value = String(s.extent);
    extentControl.hidden = s.plane !== 'horizontal';
  };

  const drawImage = (s: SliceShown): void => {
    const r = s.result;
    const n = r.n;
    const plane = s.geometry.plane;
    canvas.width = n;
    canvas.height = n;
    overlay.setAttribute('viewBox', `0 0 ${n} ${n}`);
    const img = sliceImage(r, plane, fixedScale);
    histo.replaceChildren();
    legend.replaceChildren();
    histo.style.display = 'none';
    switch (r.field) {
      case 'density': case 'node': {
        const st = img.stats;
        stats.textContent = histogramLabels(st).join('\n');
        if (st !== null) {
          const h = histogram(r.values, st);
          const max = Math.max(...h.counts);
          const w = 64 / h.counts.length;
          histo.append(...h.counts.map((c, i) => svg('rect', { class: 'sv-bar', x: i * w, width: w, y: 40 - (40 * c) / max, height: (40 * c) / max })));
          histo.style.display = '';
        }
        break;
      }
      case 'blocks':
        stats.textContent = '';
        legend.append(...blocksLegend(r.values, r.fluid).map((k) => {
          const key = el('span', 'sv-key');
          const sw = el('span', 'sv-swatch');
          sw.style.background = rgbCss(k.rgb);
          key.append(sw, el('span', '', k.label));
          return key;
        }));
        break;
      case 'rule':
        stats.textContent = ruleShareText(ruleShare(r.values));
        break;
    }
    canvas.getContext('2d')?.putImageData(new ImageData(img.rgba, n, n), 0, 0);
    contourEl.setAttribute('d', contourPath(img.contour));
  };

  function render(): void {
    if (state === null) return;
    const s = state;
    syncControls(s);
    const line = deps.line();
    const emptyText = sliceEmptyText(s, line);
    const shownSlice = requests.shown;
    const view = fieldSliceView(requests, deps.session.state.epoch);
    empty.textContent = emptyText ?? '';
    empty.hidden = emptyText === null;
    box.hidden = emptyText !== null || shownSlice === null;
    box.classList.toggle('sv-stale', view === 'stale');
    staleLabel.hidden = view !== 'stale';
    status.textContent = sliceStatusText(requests, deps.session.state.epoch);
    const n = requests.notice;
    notice.textContent = n !== null && n !== emptyText ? n : '';
    notice.hidden = notice.textContent === '';
    const labels = sliceAxisLabels(s, line);
    topLabel.textContent = emptyText === null ? labels.top : '';
    bottomLabel.textContent = emptyText === null ? labels.bottom : '';
    leftLabel.textContent = emptyText === null ? labels.left : '';
    rightLabel.textContent = emptyText === null ? labels.right : '';
    aside.hidden = shownSlice === null || emptyText !== null;
    if (shownSlice !== null && (drawn === null || drawn.shown !== shownSlice || drawn.fixed !== fixedScale)) {
      drawn = { shown: shownSlice, fixed: fixedScale };
      drawImage(shownSlice);
      showHover();
    }
    // The sea level and the y control's level across a vertical slice (§4.2, §4.3), at the shown slice's size.
    const vertical = shownSlice !== null && shownSlice.geometry.plane === 'vertical';
    for (const [lineEl, y] of [[seaLine, SEA_LEVEL], [yLine, s.y]] as const) {
      lineEl.style.display = vertical ? '' : 'none';
      if (!vertical) continue;
      const at = levelLine(y, shownSlice.result.n);
      lineEl.setAttribute('x1', '0');
      lineEl.setAttribute('x2', String(shownSlice.result.n));
      lineEl.setAttribute('y1', String(at));
      lineEl.setAttribute('y2', String(at));
    }
    renderPins();
  }

  // ---------------------------------------------------------------- pinned slices
  interface PinView {
    readonly element: HTMLElement;
    readonly box: HTMLElement;
    readonly canvas: HTMLCanvasElement;
    readonly overlay: SVGSVGElement;
    readonly contour: SVGPathElement;
    readonly sea: SVGLineElement;
    readonly stale: HTMLElement;
    readonly readout: HTMLElement;
    readonly status: HTMLElement;
    readonly notice: HTMLElement;
    drawn: { readonly shown: SliceShown; readonly fixed: number | null } | null;
    /** The pointer over the pin's box (fractions, as the live box's). */
    hoverAt: SlicePointer | null;
  }

  const pinHover = (pin: SlicePin, v: PinView): void => {
    const s = pin.requests.shown;
    const h = s === null ? null : pointerPixel(v.hoverAt, s.result.n);
    if (h === null || s === null || s.result.n !== s.geometry.n || h.px >= s.geometry.n || h.py >= s.geometry.n) {
      v.readout.hidden = true;
      return;
    }
    const t = sliceHoverText(s, h.px, h.py).text;
    v.readout.textContent = t;
    v.readout.title = t;
    v.readout.hidden = false;
  };

  const createPinView = (pin: SlicePin): PinView => {
    const cell = el('div', 'sv-pin');
    const head = el('div', 'sv-pin-head');
    const title = el('span', 'sv-pin-label', pin.label);
    title.title = pin.label;
    const close = el('button', 'sv-pin-close', '×');
    close.type = 'button';
    close.title = 'Unpin this slice';
    close.addEventListener('click', () => {
      pins.remove(pin.id);
      showPinNotice(null);
    });
    head.append(title, close);
    const pbox = el('div', 'sv-pin-box');
    const pcanvas = el('canvas', 'sv-image');
    const pover = svg('svg', { class: 'sv-overlay', preserveAspectRatio: 'none' });
    const pcontour = svg('path', { class: 'sv-contour' });
    const psea = svg('line', { class: 'sv-sea' });
    pover.append(pcontour, psea);
    const pstale = el('div', 'sv-stale-label', 'stale');
    const preadout = el('div', 'sv-readout');
    preadout.hidden = true;
    pbox.append(pcanvas, pover, pstale, preadout);
    const pstatus = el('div', 'sv-status');
    const pnotice = el('div', 'sv-notice');
    cell.append(head, pbox, pstatus, pnotice);
    const v: PinView = {
      element: cell, box: pbox, canvas: pcanvas, overlay: pover, contour: pcontour, sea: psea, stale: pstale, readout: preadout,
      status: pstatus, notice: pnotice, drawn: null, hoverAt: null,
    };
    pbox.addEventListener('pointermove', (e) => {
      const r = pcanvas.getBoundingClientRect();
      v.hoverAt = slicePointer(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      pinHover(pin, v);
    });
    pbox.addEventListener('pointerleave', () => {
      v.hoverAt = null;
      pinHover(pin, v);
    });
    return v;
  };

  const drawPin = (v: PinView, s: SliceShown): void => {
    const n = s.result.n;
    const img = sliceImage(s.result, s.geometry.plane, fixedScale);
    v.canvas.width = n;
    v.canvas.height = n;
    v.overlay.setAttribute('viewBox', `0 0 ${n} ${n}`);
    v.canvas.getContext('2d')?.putImageData(new ImageData(img.rgba, n, n), 0, 0);
    v.contour.setAttribute('d', contourPath(img.contour));
    const vertical = s.geometry.plane === 'vertical';
    v.sea.style.display = vertical ? '' : 'none';
    if (vertical) {
      const at = String(levelLine(SEA_LEVEL, n));
      v.sea.setAttribute('x1', '0');
      v.sea.setAttribute('x2', String(n));
      v.sea.setAttribute('y1', at);
      v.sea.setAttribute('y2', at);
    }
  };

  function renderPins(): void {
    const list = pins.pins;
    const ids = new Set(list.map((p) => p.id));
    for (const [id, v] of pinViews) {
      if (ids.has(id)) continue;
      v.element.remove();
      pinViews.delete(id);
    }
    const epoch = deps.session.state.epoch;
    for (const pin of list) {
      let v = pinViews.get(pin.id);
      if (v === undefined) {
        v = createPinView(pin);
        pinViews.set(pin.id, v);
        pinStrip.append(v.element);
      }
      const s = pin.requests.shown;
      const view = fieldSliceView(pin.requests, epoch);
      v.box.classList.toggle('sv-stale', view === 'stale');
      v.stale.hidden = view !== 'stale';
      v.box.classList.toggle('sv-pin-empty', s === null);
      v.status.textContent = sliceStatusText(pin.requests, epoch);
      v.notice.textContent = pin.requests.notice ?? '';
      v.notice.hidden = pin.requests.notice === null;
      if (s !== null && (v.drawn === null || v.drawn.shown !== s || v.drawn.fixed !== fixedScale)) {
        v.drawn = { shown: s, fixed: fixedScale };
        drawPin(v, s);
        pinHover(pin, v);
      }
    }
    pinStrip.hidden = list.length === 0;
    pinButton.disabled = list.length >= PIN_MAX;
    pinButton.title = list.length >= PIN_MAX ? PIN_FULL_TEXT : PIN_TITLE;
  }

  function update(): void {
    if (state === null) return;
    if (shown) {
      requests.request({ state, line: deps.line(), selection: deps.selection() });
      pins.update();
    }
    render();
  }

  return {
    element,
    get state() { return state; },
    setShown(on) {
      shown = on;
      if (on && state === null) {
        setState(initialSliceState(deps.start()));
        return;
      }
      if (!on) {
        hoverAt = null;
        readout.hidden = true;
        for (const v of pinViews.values()) {
          v.hoverAt = null;
          v.readout.hidden = true;
        }
      }
      update();
    },
    setCentre(x, z) {
      if (state !== null) setState(withCentre(state, x, z));
    },
    update,
    dispose() {
      resize.disconnect();
    },
  };
}

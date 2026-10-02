/**
 * The spline drawer (SP2b spec §4.2-4.4), the editor of one spline leaf under the map.
 * - Header: the leaf label, breadcrumbs from the typed coords (a crumb goes up), probe sliders for the coords
 *   the plot does not show (default 0), auto tangents (node, spline), reset spline, export and import shape,
 *   close.
 * - Tree on the left (tree.ts), the plot (plot.ts), and a side column: the selected knot's numeric fields
 *   (x, y, d), the statistics line, the lints (a click opens the lint's node and selects its knot) and the last
 *   refusal or import message.
 * - Every edit is a pure operation of core/spline/edit.ts written with `session.set(leaf, spline)`: a knot or
 *   tangent drag is one gesture (one undo step); insert, delete, nest, flatten, auto tangents, typed values,
 *   reset and import are one urgent step each. The drawer follows the session: after an undo, a reset or an
 *   import it shows the deepest node of its path that still exists.
 * - Statistics (§4.3): `splineStats` for the open node is requested when the preview driver settles, and when a
 *   node opens while it is settled, so it always runs on the draft the pool holds; the overlays are stale from
 *   the next session change (or during a gesture) until a new result arrives. A cancelled request stays stale
 *   silently; any other failure also shows a notice.
 * - Lints are recomputed at most once per animation frame, after urgent changes and probe moves, never per
 *   pointer move of a drag (a pass over the default offset costs ≈ 18 ms).
 */
import './drawer.css';
import { autoTangentsAt, deleteKnot, flattenKnot, insertKnot, knotAt, nestKnot, nodeAt, setKnot, type SplineEdit } from '../../core/spline/edit';
import type { KnotPath, NestedSpline, SplineCoord } from '../../core/spline/types';
import type { SplineIssue } from '../../core/spline/validate';
import type { SessionResult, WorldSession } from '../../engine/session';
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import { splineOfLeaf, summarizeSplineStats, type SplineLeaf, type SplineStatsSummary } from '../../metrics/splineStats';
import { el } from '../common/dom';
import { downloadText, readTextFile } from '../common/files';
import { isTextEntry } from '../common/keys';
import type { Notices } from '../common/notice';
import type { PreviewDriver } from '../map/previewDriver';
import { parseFieldText } from '../paramPanel/model';
import {
  autoTangentsAll, breadcrumbs, clampKnotDrag, followNode, formatCoordValue, leafOpts, leafView, lintText, nestCoords, nodeStatsRequest,
  overlayState, pointOnCurve, probeCoords, probeVector, reachMarks, sameStatsTarget, splineLints, splineTree, statsText, type OverlayState,
  type SplineLint, type StatsTarget,
} from './model';
import { createSplinePlot } from './plot';
import { readShapeText, shapeFileName, shapeText } from './shapeFile';
import { createSplineTreeView, nodeKey } from './tree';

export interface DrawerDeps {
  readonly session: WorldSession;
  readonly notices: Notices;
  /** The pool's statistics jobs (spec §5.4). */
  readonly pool: Pick<WorkerPool, 'stats'>;
  /** The preview driver: statistics are requested when it settles (spec §4.3). */
  readonly driver: Pick<PreviewDriver, 'onSettled' | 'status'>;
  /** Runs a session call caused by the input event `e`, so the preview latency counts from `e.timeStamp` (§2.8). */
  edit(e: Event, fn: () => void): void;
  /** Whether the drawer row is shown: a hidden drawer neither renders nor requests statistics. */
  visible(): boolean;
  /** Closes the drawer row (the Close button). */
  close(): void;
}

export interface SplineDrawer {
  /** Shows the leaf: at its root when another leaf was open, else where the drawer was. The caller shows the drawer row first. */
  open(leaf: SplineLeaf): void;
  readonly leaf: SplineLeaf | null;
  /** Stops following the session and the driver (the DOM stays). */
  dispose(): void;
}

interface Current {
  readonly leaf: SplineLeaf;
  readonly spline: NestedSpline;
  readonly node: NestedSpline;
}

type KnotFieldName = 'x' | 'y' | 'd';

interface KnotField {
  readonly row: HTMLElement;
  readonly input: HTMLInputElement;
  /** Shows the draft's text: replaced when it differs from the text shown last, or with `force`; a refusal stays otherwise. */
  show(text: string, force: boolean): void;
  /** Shows the draft's text again and drops a refusal. */
  restore(): void;
}

interface ShownLint extends SplineLint {
  readonly text: string;
}

const splineIssueLines = (issues: readonly SplineIssue[]): string[] => issues.map((i) => `${i.path === '' ? 'spline' : i.path}: ${i.message}`);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const samePath = (a: KnotPath, b: KnotPath): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

export function createSplineDrawer(host: HTMLElement, deps: DrawerDeps): SplineDrawer {
  const { session } = deps;
  let leaf: SplineLeaf | null = null;
  let nodePath: KnotPath = [];
  let selected: number | null = null;
  const probeValues: Partial<Record<SplineCoord, number>> = {};
  let lints: readonly ShownLint[] = [];
  let lintFrame: number | null = null;
  let shown: { readonly target: StatsTarget; readonly summary: SplineStatsSummary } | null = null;
  let pending: StatsTarget | null = null;

  // ---------------------------------------------------------------- DOM
  const root = el('div', 'sd');
  const button = (text: string, tip: string, run: (e: MouseEvent) => void, cls = ''): HTMLButtonElement => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.title = tip;
    b.addEventListener('click', run);
    return b;
  };

  const head = el('div', 'sd-head');
  const title = el('strong', 'sd-title');
  const crumbs = el('nav', 'sd-crumbs');
  crumbs.setAttribute('aria-label', 'Open node');
  const probes = el('div', 'sd-probes');
  const actions = el('div', 'sd-actions');
  const autoNode = button('Auto tangents: node', 'Recompute the tangents of the open node\'s knots with the automatic rule', (e) => {
    const c = current();
    if (c !== null) commitEdit(e, autoTangentsAt(c.spline, nodePath, leafOpts(c.leaf)));
  });
  const autoAll = button('Auto tangents: spline', 'Recompute every tangent of the spline with the automatic rule', (e) => {
    const c = current();
    if (c !== null) commitEdit(e, autoTangentsAll(c.spline, leafOpts(c.leaf)));
  });
  const resetBtn = button('Reset spline', 'Return the spline to the profile\'s', (e) => {
    const c = current();
    if (c === null) return;
    clearMessage();
    deps.edit(e, () => { session.reset(c.leaf); });
  });
  const exportBtn = button('Export shape', 'Download the spline as a .wi10-shape.json file', () => {
    const c = current();
    if (c === null) return;
    downloadText(shapeFileName(c.leaf), shapeText(c.leaf, c.spline));
    setMessage([`exported ${shapeFileName(c.leaf)}`], 'info');
  });
  const fileInput = el('input', 'sd-file');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  const importBtn = button('Import shape', 'Replace the spline with a .wi10-shape.json file (one undo step)', () => fileInput.click());
  const closeBtn = button('Close', 'Close the drawer (Escape)', () => deps.close());
  actions.append(autoNode, autoAll, resetBtn, exportBtn, importBtn, closeBtn, fileInput);
  head.append(title, crumbs, probes, actions);

  const body = el('div', 'sd-body');
  const tree = createSplineTreeView((p) => openNode(p, null));
  const plotHost = el('div', 'sd-plotwrap');
  const side = el('div', 'sd-side');

  const hint = el('div', 'sd-hint', 'Click a knot to select it; drag knots and the selected knot\'s tangent handles; double-click the plot to insert a knot; Delete removes the selected knot; right-click a knot to nest or flatten it.');
  const knotBox = el('div', 'sd-knot');
  const knotHead = el('div', 'sd-knot-head');
  const knotTitle = el('span', 'sd-knot-title');
  const openBtn = button('Open', 'Open the nested spline of this knot', () => { if (selected !== null) openNode([...nodePath, selected], null); });
  const deleteBtn = button('Delete', 'Delete the knot (Delete key)', (e) => deleteSelected(e));
  knotHead.append(knotTitle, openBtn, deleteBtn);
  const knotIssue = el('div', 'sd-issue');
  knotIssue.hidden = true;
  const showKnotIssue = (lines: readonly string[]) => {
    knotIssue.textContent = lines.join('\n');
    knotIssue.hidden = lines.length === 0;
  };
  const knotField = (f: KnotFieldName): KnotField => {
    const row = el('label', 'sd-field-row');
    const input = el('input', 'sd-field');
    input.type = 'text';
    input.id = `sd-knot-${f}`;
    input.inputMode = 'decimal';
    input.spellcheck = false;
    input.autocomplete = 'off';
    row.append(el('span', 'sd-field-name', f), input);
    let text = '';
    const restore = () => {
      input.value = text;
      input.classList.remove('sd-invalid');
      input.removeAttribute('aria-invalid');
    };
    input.addEventListener('change', (e) => commitField(e, f, input));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      restore();
      showKnotIssue([]);
    });
    return {
      row, input,
      show(next, force) {
        if (!force && next === text) return;
        text = next;
        restore();
      },
      restore,
    };
  };
  const fields: Readonly<Record<KnotFieldName, KnotField>> = { x: knotField('x'), y: knotField('y'), d: knotField('d') };
  fields.x.row.title = 'x: the knot\'s position on the node\'s coord (between its neighbours; |x| ≤ 2)';
  fields.y.row.title = 'y: the knot\'s value in the leaf\'s unit (a nested knot holds a spline)';
  fields.d.row.title = 'd: the tangent, in the leaf\'s unit per unit of the coord (|d| ≤ 100000)';
  knotBox.append(knotHead, fields.x.row, fields.y.row, fields.d.row, knotIssue);
  const statsLine = el('div', 'sd-stats');
  statsLine.title = 'Bars: the weighted histogram of the node\'s coord over [−1, 1]. Rows under the axis: the share of land and of the world each segment and hold region covers.';
  const lintBox = el('div', 'sd-lints');
  lintBox.setAttribute('role', 'status');
  const message = el('div', 'sd-message');
  message.setAttribute('role', 'status');
  side.append(hint, knotBox, statsLine, lintBox, message);
  body.append(tree.element, plotHost, side);

  const menu = el('div', 'sd-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  root.append(head, body, menu);
  host.replaceChildren(root);

  const plot = createSplinePlot(plotHost, {
    select(k) {
      closeMenu();
      if (k === selected) return;
      selected = k;
      clearMessage();
      render();
    },
    dragStart() { session.beginGesture(); },
    dragEnd() { session.endGesture(); },
    moveKnot(e, k, x, y) {
      const c = current();
      const p = c?.node.points[k];
      if (c === null || p === undefined) return;
      if (!session.inGesture) session.beginGesture();
      const v = leafView(c.leaf);
      const to = clampKnotDrag(c.node, k, x, y, v.yMin, v.yMax);
      const r = setKnot(c.spline, [...nodePath, k], typeof p.y === 'number' ? { x: to.x, y: to.y } : { x: to.x }, leafOpts(c.leaf));
      if (r.ok) deps.edit(e, () => { session.set(c.leaf, r.value); });
    },
    moveTangent(e, k, d) {
      const c = current();
      if (c === null || c.node.points[k] === undefined) return;
      if (!session.inGesture) session.beginGesture();
      const r = setKnot(c.spline, [...nodePath, k], { d }, leafOpts(c.leaf));
      if (r.ok) deps.edit(e, () => { session.set(c.leaf, r.value); });
    },
    doubleClick(e, k, x) {
      if (k !== null) {
        openNode([...nodePath, k], null);
        return;
      }
      const c = current();
      if (c === null) return;
      const v = leafView(c.leaf);
      const at = pointOnCurve(c.node, probeVector(probeValues), x, v.yMin, v.yMax);
      const r = insertKnot(c.spline, nodePath, at.x, at.y, leafOpts(c.leaf));
      if (!r.ok) {
        setMessage(splineIssueLines(r.issues), 'error');
        return;
      }
      commit(e, r.value, nodeAt(r.value, nodePath).points.findIndex((p) => p.x === at.x));
    },
    menu(e, k) { showMenu(e, k); },
  });

  // ---------------------------------------------------------------- state
  /** The open leaf's spline and node, after following the session (the node path and the selection are clamped). */
  function current(): Current | null {
    if (leaf === null) return null;
    const spline = splineOfLeaf(session.state.params, leaf);
    nodePath = followNode(spline, nodePath);
    const node = nodeAt(spline, nodePath);
    if (selected !== null && selected >= node.points.length) selected = null;
    return { leaf, spline, node };
  }

  const targetOf = (c: Current): StatsTarget => ({ epoch: session.state.epoch, leaf: c.leaf, nodePath, coord: c.node.coord });

  function setMessage(lines: readonly string[], kind: 'info' | 'error'): void {
    message.textContent = lines.join('\n');
    message.dataset['kind'] = kind;
  }
  function clearMessage(): void {
    message.textContent = '';
    delete message.dataset['kind'];
  }

  /**
   * Writes the leaf's new spline (one step, or a gesture move). `select`, when given, is the knot selected
   * with it (restored on a refusal). A refusal is listed in the message line.
   */
  function commit(e: Event | null, value: NestedSpline, select?: number | null): boolean {
    if (leaf === null) return false;
    const into = leaf;
    const before = session.state;
    const was = selected;
    if (select !== undefined) selected = select;
    const out: { r?: SessionResult } = {};
    const run = () => { out.r = session.set(into, value); };
    if (e === null) run();
    else deps.edit(e, run);
    const r = out.r;
    if (r === undefined) throw new Error('edit did not run the session call');
    if (!r.ok) {
      selected = was;
      setMessage(r.issues.map((i) => `${i.path}: ${i.message}`), 'error');
      render();
      return false;
    }
    clearMessage();
    if (session.state === before) render();
    return true;
  }

  function commitEdit(e: Event, r: SplineEdit, select?: number | null): boolean {
    if (!r.ok) {
      setMessage(splineIssueLines(r.issues), 'error');
      return false;
    }
    return commit(e, r.value, select);
  }

  function commitField(e: Event, f: KnotFieldName, input: HTMLInputElement): void {
    const c = current();
    if (c === null || selected === null) return;
    const v = parseFieldText(input.value);
    const n = typeof v === 'number' ? v : Number.NaN;
    const r = setKnot(c.spline, [...nodePath, selected], f === 'x' ? { x: n } : f === 'y' ? { y: n } : { d: n }, leafOpts(c.leaf));
    if (!r.ok) {
      input.classList.add('sd-invalid');
      input.setAttribute('aria-invalid', 'true');
      showKnotIssue(splineIssueLines(r.issues));
      return;
    }
    showKnotIssue([]);
    if (commit(e, r.value)) fields[f].restore();
  }

  function deleteSelected(e: Event): void {
    const c = current();
    if (c === null || selected === null) return;
    commitEdit(e, deleteKnot(c.spline, [...nodePath, selected], leafOpts(c.leaf)), null);
  }

  function openNode(path: KnotPath, select: number | null): void {
    closeMenu();
    nodePath = path;
    selected = select;
    clearMessage();
    render();
    requestStats(deps.driver.status.settled);
  }

  // ---------------------------------------------------------------- statistics
  /** Requests `splineStats` for the open node unless the shown or the pending result already is for this draft and node. */
  function requestStats(settled: boolean): void {
    const c = current();
    if (c === null || !settled || session.inGesture || !deps.visible()) return;
    const target = targetOf(c);
    if (sameStatsTarget(shown?.target ?? null, target) || sameStatsTarget(pending, target)) return;
    const req = nodeStatsRequest(session.state.params, c.leaf, nodePath);
    pending = target;
    renderStats();
    deps.pool.stats('splineStats', req.n, req.args).then((sum) => {
      if (pending !== target) return;
      pending = null;
      shown = { target, summary: summarizeSplineStats(sum, req.knotXs) };
      render();
    }, (err: unknown) => {
      if (pending !== target) return;
      pending = null;
      if (!(err instanceof JobCancelled)) deps.notices.show(`spline statistics failed: ${messageOf(err)}`, { kind: 'warn' });
      renderStats();
    });
  }

  function overlayNow(c: Current): OverlayState {
    return overlayState(shown?.target ?? null, targetOf(c), session.inGesture);
  }

  function renderStats(): void {
    const c = current();
    if (c === null) return;
    const state = overlayNow(c);
    statsLine.dataset['state'] = state;
    if (shown !== null && state !== 'none') {
      statsLine.textContent = `${state === 'stale' ? 'stale until the preview settles · ' : ''}${statsText(shown.summary, nodePath.length > 0)}`;
    } else {
      statsLine.textContent = pending !== null ? 'computing statistics…' : 'statistics follow when the preview settles';
    }
  }

  // ---------------------------------------------------------------- lints
  function computeLints(): void {
    lintFrame = null;
    const c = current();
    if (c === null || !deps.visible()) return;
    lints = splineLints(c.spline, c.leaf, session.state.params, probeVector(probeValues)).map((l) => ({ ...l, text: lintText(c.leaf, c.spline, l) }));
    render();
  }

  /** Lints at most once per frame: after urgent changes, probe moves and opening a leaf. */
  function scheduleLints(): void {
    if (lintFrame === null) lintFrame = requestAnimationFrame(computeLints);
  }

  let lintKey: string | null = null;
  function renderLints(): void {
    const key = lints.map((l) => l.text).join('\n');
    if (key === lintKey) return;
    lintKey = key;
    lintBox.replaceChildren(...lints.map((l) => button(l.text, 'Open the node and select the knot', () => openNode(l.nodePath, l.knot), 'sd-lint-item')));
    lintBox.hidden = lints.length === 0;
  }

  // ---------------------------------------------------------------- probes, knot panel, context menu
  let probeKey: string | null = null;
  function renderProbes(coords: readonly SplineCoord[], nodeCoord: SplineCoord): void {
    const key = `${nodeCoord}|${coords.join(',')}`;
    if (key === probeKey) return;
    probeKey = key;
    const sliders = coords.map((c) => {
      const wrap = el('label', 'sd-probe');
      wrap.title = `The ${c} value at which the curve and the nested knots are drawn (the plot's x axis is ${nodeCoord})`;
      const range = el('input', 'sd-probe-range');
      range.type = 'range';
      range.min = '-1';
      range.max = '1';
      range.step = '0.01';
      range.value = String(probeValues[c] ?? 0);
      range.dataset['coord'] = c;
      range.setAttribute('aria-label', `probe ${c}`);
      const out = el('output', 'sd-probe-value', formatCoordValue(probeValues[c] ?? 0));
      range.addEventListener('input', () => {
        probeValues[c] = Number(range.value);
        out.textContent = formatCoordValue(probeValues[c]);
        render();
        scheduleLints();
      });
      wrap.append(el('span', 'sd-probe-name', c), range, out);
      return wrap;
    });
    probes.replaceChildren(...(sliders.length > 0 ? [el('span', 'sd-probes-label', 'probe'), ...sliders] : []));
  }

  let knotKey = '';
  function renderKnot(c: Current): void {
    const key = `${c.leaf}|${nodeKey(nodePath)}|${selected ?? ''}`;
    const force = key !== knotKey;
    knotKey = key;
    if (force) showKnotIssue([]);
    hint.hidden = selected !== null;
    knotBox.hidden = selected === null;
    if (selected === null) return;
    const p = c.node.points[selected]!;
    knotTitle.textContent = `knot ${selected} of ${c.node.coord} (${c.node.points.length} knots)`;
    fields.x.show(String(p.x), force);
    fields.d.show(String(p.d), force);
    const nested = typeof p.y !== 'number';
    fields.y.input.disabled = nested;
    fields.y.show(typeof p.y === 'number' ? String(p.y) : `${p.y.coord} spline (${p.y.points.length} knots)`, force);
    openBtn.hidden = !nested;
  }

  function closeMenu(): void {
    menu.hidden = true;
    menu.replaceChildren();
  }

  /** The knot menu (spec §4.2): nest by a coord the path does not use, or open and flatten a nested knot; delete. */
  function showMenu(e: MouseEvent, k: number): void {
    const c = current();
    const p = c?.node.points[k];
    if (c === null || p === undefined) return;
    const path = [...nodePath, k];
    const nested = typeof p.y !== 'number';
    /** Runs an edit on the knot at `path` if it is still the kind it was when the menu opened. */
    const onKnot = (ev: MouseEvent, edit: (now: Current) => SplineEdit, select: number | null) => {
      closeMenu();
      const now = current();
      if (now === null) return;
      let still = false;
      try { still = (typeof knotAt(now.spline, path).y !== 'number') === nested; } catch { still = false; }
      if (still) commitEdit(ev, edit(now), select);
    };
    const items: HTMLButtonElement[] = [];
    const item = (label: string, run: (ev: MouseEvent) => void, disabled = false) => {
      const b = button(label, '', run);
      b.title = '';
      b.setAttribute('role', 'menuitem');
      b.disabled = disabled;
      items.push(b);
    };
    if (!nested) {
      const coords = nestCoords(c.leaf, c.spline, path);
      for (const coord of coords) item(`Nest by ${coord}`, (ev) => onKnot(ev, (now) => nestKnot(now.spline, path, coord, leafOpts(now.leaf)), k));
      if (coords.length === 0) item('Nest: every coord of the leaf is used on this path', () => {}, true);
    } else {
      item('Open', () => openNode(path, null));
      item('Flatten at the probe', (ev) => onKnot(ev, (now) => flattenKnot(now.spline, path, probeVector(probeValues), leafOpts(now.leaf)), k));
    }
    item('Delete knot', (ev) => onKnot(ev, (now) => deleteKnot(now.spline, path, leafOpts(now.leaf)), null));
    menu.replaceChildren(...items);
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(e.clientY, innerHeight - r.height - 4))}px`;
    items.find((b) => !b.disabled)?.focus();
  }
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeMenu();
    plot.element.focus();
  });
  const outside = (e: PointerEvent) => { if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu(); };
  addEventListener('pointerdown', outside, true);

  // Delete removes the selected knot unless a text field has the focus.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || selected === null) return;
    if (isTextEntry(e.target instanceof Element ? e.target : null)) return;
    e.preventDefault();
    deleteSelected(e);
  });

  // The input is cleared once the read is over, so that choosing the same file again fires `change`.
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    const into = leaf;
    if (file === undefined || into === null) return;
    void readTextFile(file).then((text) => {
      if (leaf !== into) return;
      const r = readShapeText(text, into, leafOpts(into));
      if (!r.ok) {
        setMessage([`${file.name} was not imported:`, ...r.issues], 'error');
        return;
      }
      if (!commit(null, r.spline)) return;
      setMessage([`imported ${file.name}`], 'info');
      if (r.notice !== null) deps.notices.show(r.notice, { kind: 'info', timeoutMs: 8000 });
    }, (err: unknown) => setMessage([`${file.name} could not be read: ${messageOf(err)}`], 'error')).finally(() => { fileInput.value = ''; });
  });

  // ---------------------------------------------------------------- render
  function render(): void {
    const c = current();
    if (c === null) return;
    const view = leafView(c.leaf);
    title.textContent = `${view.label} (${view.unit})`;
    const cs = breadcrumbs(c.leaf, c.spline, nodePath);
    crumbs.replaceChildren(...cs.flatMap((cr, i) => {
      const b = button(cr.label, i === 0 ? 'The root of the spline' : `Open the node at ${cr.label}`, () => openNode(cr.nodePath, null), 'sd-crumb');
      if (i === cs.length - 1) b.setAttribute('aria-current', 'true');
      return i === 0 ? [b] : [el('span', 'sd-crumb-sep', '›'), b];
    }));
    renderProbes(probeCoords(c.node), c.node.coord);
    resetBtn.disabled = !session.modified(c.leaf);
    tree.render(splineTree(c.leaf, c.spline), nodePath, new Set(lints.map((l) => nodeKey(l.nodePath))));
    const state = overlayNow(c);
    plot.render({
      view, node: c.node, probe: probeVector(probeValues), selected,
      linted: new Set(lints.filter((l) => samePath(l.nodePath, nodePath)).map((l) => l.knot)),
      marks: reachMarks(c.node.coord, session.state.params),
      overlay: shown === null || state === 'none' ? null : { summary: shown.summary, stale: state === 'stale' },
    });
    renderKnot(c);
    renderStats();
    renderLints();
  }

  const offSession = session.subscribe((_s, change) => {
    if (leaf === null || !deps.visible()) return;
    if (change.urgent) scheduleLints();
    render();
  });
  // The driver's status still reads unsettled while it runs its onSettled listeners.
  const offSettled = deps.driver.onSettled(() => requestStats(true));

  return {
    open(next) {
      if (next !== leaf) {
        leaf = next;
        nodePath = [];
        selected = null;
        lints = [];
        clearMessage();
      }
      closeMenu();
      render();
      scheduleLints();
      requestStats(deps.driver.status.settled);
    },
    get leaf() { return leaf; },
    dispose() {
      offSession();
      offSettled();
      removeEventListener('pointerdown', outside, true);
      if (lintFrame !== null) cancelAnimationFrame(lintFrame);
    },
  };
}

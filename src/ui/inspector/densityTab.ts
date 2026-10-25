/**
 * The drawer's Density tab (SP3d spec §3.1-§3.3, §3.5, D18): a grid `220px | 280px | minmax(0, 1fr) | minmax(0, 1.2fr)`
 * of **tree | node form | JSON editor | slice viewer**. Below 1,200 px of drawer width the last two share one column with
 * the sub-tabs "Slice" (shown first) and "JSON"; below 900 px the columns stack (tree, form, then the sub-tabs). The
 * mode follows the tab's own width (`densityLayout`, a ResizeObserver), not the viewport.
 * - Tree (§3.2): the rows of `inspectorTree` for both roots, re-rendered only when its key string changes; a row's
 *   toggle expands it, its button selects it, a tap row carries the mute toggle (a plain edit: the selection stays,
 *   `selectionAfterCommit`); "Expand to selection" opens the selected node's ancestors.
 * - Node form (§3.3): the selected node's op or kind (options that cannot validate disabled), its actions (wrap, delete,
 *   add rule, add def, mute), one control per scalar (`formFields`): a numeric field has the select "literal / <targets>",
 *   the literal's text field (read as the panel's `valueField` reads it: `setTypedNumber`), "negate" outside `const.v`,
 *   and while it is a ref the parameter panel's slider of the target (`createTargetRow`, which sets the target leaf);
 *   slide knots are a two-column table with add and remove. Each
 *   edit is one `commitFormEdit` (one `session.set` of the leaf through the page's `edit` wrapper, one undo step); a
 *   refusal keeps the control red with the issue lines under the form and the selection as it was. The form also shows
 *   the selected node's value at the hovered voxel (fed by the page, `setHoverValue`) and the two tree lints.
 * - JSON editor (§3.5): `jsonEditor.ts` bound to the selected root's `editorModel` (one per leaf, so a root switch never
 *   mixes buffers). A row's selection highlights its node's text and scrolls to it; the caret selects the innermost node
 *   holding it only while the buffer is clean or parses and the path is in the session's tree (`caretTarget`), else it
 *   moves only the editor's highlight.
 * - The slice viewer's cell is `sliceHost`; mounting the viewer and the tab on the page is the page's (`mapPage.ts`).
 * Hidden drawer tabs keep their DOM, so selection, expansion and the buffers survive a switch; the scroll offsets of the
 * tree, the form and the text are saved when the tab is hidden and restored when it is shown (`setShown`). Every
 * selection follows the session (`followNode`) after undo, redo, reset or a renumbering edit. Text only through
 * `textContent`. DOM only: the rules are in model.ts, form.ts, editorModel.ts and jsonText.ts.
 */
import './inspector.css';
import type { SessionState, WorldSession } from '../../engine/session';
import type { Params } from '../../core/params/schema';
import { el } from '../common/dom';
import { createTargetRow } from '../paramPanel/controls';
import { createEditorModel, issueText, TREE_LEAVES, type EditorClock, type EditorIssue, type EditorModel, type EditorState, type TreeLeaf } from './editorModel';
import {
  addDef, addRule, commitFormEdit, currentNumber, deleteNode, formActions, formFields, opOptions, refOptions, renameDef, replaceOp,
  selectionAfterCommit, setField, setKnots, setNumber, setTypedNumber, toggleMute, treeLints, wrapNode, type FormCommit, type FormEdit,
  type FormField, type NumberChoice, type NumberValue,
} from './form';
import { createJsonEditor, type JsonEditorView } from './jsonEditor';
import { pathRange, type TextRange } from './jsonText';
import {
  caretTarget, DEFAULT_SELECTION, DEFAULT_SUB_TAB, DENSITY_SUB_TAB_LABELS, DENSITY_SUB_TABS, densityLayout, expandToSelection, followNode,
  highlightRange, inspectorTree, NO_EXPANSION, shownPanes, toggleExpansion, type DensityLayout, type DensitySubTab, type Expansion,
  type Selection, type TreeRow,
} from './model';

export interface DensityTabDeps {
  readonly session: WorldSession;
  /** Runs a session call caused by the input event `e`, so the preview latency counts from `e.timeStamp`. */
  edit(e: Event, fn: () => void): void;
  /** The JSON editor's debounce clock (default: the window's timers). */
  readonly clock?: EditorClock;
}

export interface DensityTab {
  readonly element: HTMLElement;
  /** The slice viewer's cell (the page mounts `sliceView` here). */
  readonly sliceHost: HTMLElement;
  /** The selected node: its root (tree leaf) and node path. */
  readonly selection: Selection;
  /** Selects a node (the parameter panel's link selects a root), opening its ancestors and scrolling the text to it. */
  select(sel: Selection): void;
  /** Called after every selection change; returns the unsubscribe function. */
  onSelect(fn: (sel: Selection) => void): () => void;
  /** The node form's "value at the hover" line (§3.6), or null to hide it. */
  setHoverValue(text: string | null): void;
  /** The drawer shows or hides the tab: scroll offsets are saved on hide and restored on show; a hidden tab skips renders. */
  setShown(shown: boolean): void;
  dispose(): void;
}

type NumberField = Extract<FormField, { type: 'number' }>;

const sameSelection = (a: Selection, b: Selection): boolean => a.leaf === b.leaf && a.path === b.path;
/** A number as the form writes it (−0 as `-0`, which tier 1 then refuses: §3.5 never normalises it). */
const numberText = (v: number): string => (Object.is(v, -0) ? '-0' : String(v));
/** A key string of form data (−0 kept apart from 0). */
const keyOf = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => (Object.is(x, -0) ? '-0' : x));
const isRefValue = (v: NumberValue): v is Exclude<NumberValue, number> => typeof v !== 'number';

const windowClock: EditorClock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export function createDensityTab(host: HTMLElement, deps: DensityTabDeps): DensityTab {
  const { session } = deps;
  const params = (): Params => session.state.params;
  let selection: Selection = DEFAULT_SELECTION;
  let expansion: Expansion = NO_EXPANSION;
  /** A node path the typed buffer has and the session's tree does not: highlighted, never selected (§3.2). */
  let bufferHighlight: string | null = null;
  let layout: DensityLayout = 'grid';
  let subTab: DensitySubTab = DEFAULT_SUB_TAB;
  let shown = true;
  let stale = false;
  let saved: { tree: number; form: number } | null = null;
  const listeners = new Set<(sel: Selection) => void>();
  /** The ends of the target sliders' open drags, run by dispose (SP4c spec §1.2). */
  const drags = new Set<() => void>();
  const editors = new Map<TreeLeaf, EditorModel>(TREE_LEAVES.map((leaf) => [leaf, createEditorModel(leaf, session, deps.clock ?? windowClock)]));

  // ---------------------------------------------------------------- DOM
  const element = el('div', 'it');
  const treePane = el('nav', 'it-tree');
  treePane.setAttribute('aria-label', 'Tree nodes');
  const formPane = el('div', 'it-form');
  const subBar = el('div', 'it-subtabs');
  subBar.setAttribute('role', 'tablist');
  const jsonPane = el('div', 'it-json');
  const sliceHost = el('div', 'it-slice');
  element.append(treePane, formPane, subBar, jsonPane, sliceHost);
  host.append(element);

  const button = (label: string, tip: string, run: (e: MouseEvent) => void, cls = ''): HTMLButtonElement => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.title = tip;
    b.addEventListener('click', run);
    return b;
  };

  // ---------------------------------------------------------------- layout and sub-tabs
  /** The JSON editor (created below, after the first layout). */
  let jsonView: JsonEditorView | null = null;
  const subButtons = new Map<DensitySubTab, HTMLButtonElement>();
  for (const id of DENSITY_SUB_TABS) {
    const b = button(DENSITY_SUB_TAB_LABELS[id], `Show the ${DENSITY_SUB_TAB_LABELS[id]} pane`, () => { subTab = id; applyLayout(); });
    b.setAttribute('role', 'tab');
    subButtons.set(id, b);
    subBar.append(b);
  }
  const applyLayout = (): void => {
    const panes = shownPanes(layout, subTab);
    // The JSON text keeps its scroll across a sub-tab or layout switch, and gets the scroll owed while it was hidden
    // (a row selected under the Slice sub-tab scrolls the text when JSON is shown: jsonEditor's restoreScroll).
    if (!panes.json && !jsonPane.hidden) jsonView?.saveScroll();
    element.dataset['layout'] = layout;
    subBar.hidden = !panes.subTabs;
    jsonPane.hidden = !panes.json;
    sliceHost.hidden = !panes.slice;
    for (const [id, b] of subButtons) b.setAttribute('aria-selected', String(id === subTab));
    if (panes.json) jsonView?.restoreScroll();
  };
  const resize = new ResizeObserver(() => {
    const next = densityLayout(element.getBoundingClientRect().width, layout);
    if (next !== layout) { layout = next; applyLayout(); }
  });
  resize.observe(element);
  applyLayout();

  // ---------------------------------------------------------------- tree
  const treeHead = el('div', 'it-tree-head');
  treeHead.append(button('Expand to selection', "Open the selected node's ancestors", () => {
    expansion = expandToSelection(params(), expansion, selection);
    renderTree();
  }));
  const treeRows = el('div', 'it-rows');
  treePane.append(treeHead, treeRows);
  let treeKey = '';

  /**
   * A tree row's elements, kept across renders (keyed by leaf and path) and updated in place, so a click whose mousedown
   * commits a field on blur (which changes the rows) still reaches the row it started on, and keyboard focus stays on its
   * control (SP3d final review). The handlers read the row's current data.
   */
  interface RowView {
    data: TreeRow;
    readonly row: HTMLElement;
    readonly toggle: HTMLButtonElement;
    readonly node: HTMLButtonElement;
    readonly tail: HTMLElement;
    readonly summary: HTMLElement;
    mute: HTMLInputElement | null;
  }
  const rowViews = new Map<string, RowView>();
  const groupViews = new Map<string, HTMLElement>();
  const rowId = (r: { readonly leaf: TreeLeaf; readonly path: string }): string => `${r.leaf}|${r.path}`;

  const createRow = (r: TreeRow): RowView => {
    const row = el('div', 'it-row');
    const toggle = el('button', 'it-toggle');
    toggle.type = 'button';
    toggle.tabIndex = -1;
    const node = el('button', 'it-node');
    node.type = 'button';
    const tail = el('span', 'it-tail');
    const summary = el('span', 'it-summary');
    node.append(tail, summary);
    row.append(toggle, node);
    const v: RowView = { data: r, row, toggle, node, tail, summary, mute: null };
    toggle.addEventListener('click', () => {
      const d = v.data;
      if (!d.expandable) return;
      expansion = toggleExpansion(expansion, d.leaf, d.path, d.depth);
      renderTree();
    });
    node.addEventListener('click', () => choose({ leaf: v.data.leaf, path: v.data.path }, true));
    return v;
  };

  const updateRow = (v: RowView, r: TreeRow): void => {
    v.data = r;
    v.row.className = `it-row${r.dimmed ? ' it-dimmed' : ''}${r.muted ? ' it-muted' : ''}`;
    v.row.style.paddingLeft = `${r.indent}px`;
    v.row.title = r.title;
    v.toggle.textContent = r.expandable ? (r.expanded ? '▾' : '▸') : '';
    v.toggle.disabled = !r.expandable;
    if (r.expandable) v.toggle.setAttribute('aria-label', `${r.expanded ? 'Collapse' : 'Expand'} ${r.title}`);
    else v.toggle.removeAttribute('aria-label');
    v.tail.textContent = r.tail;
    v.summary.textContent = r.summary;
    if (r.selected) v.node.setAttribute('aria-current', 'true');
    else v.node.removeAttribute('aria-current');
    if (!r.tap) {
      v.mute?.remove();
      v.mute = null;
      return;
    }
    if (v.mute === null) {
      const mute = el('input', 'it-mute');
      mute.type = 'checkbox';
      mute.addEventListener('change', (e) => {
        const d = v.data;
        const at: Selection = { leaf: d.leaf, path: d.path };
        commit(e, () => toggleMute(params(), at), d.leaf, () => { mute.checked = v.data.muted; }, 'row');
      });
      v.row.append(mute);
      v.mute = mute;
    }
    v.mute.checked = r.muted;
    v.mute.title = r.muted ? 'Unmute this tap' : "Mute this tap: the neutral value of its parent replaces its subtree";
    v.mute.setAttribute('aria-label', `mute ${r.title}`);
  };

  function renderTree(): void {
    const t = inspectorTree(params(), expansion, selection);
    if (t.key === treeKey) return;
    treeKey = t.key;
    const wanted: HTMLElement[] = [];
    const rowsSeen = new Set<string>();
    const groupsSeen = new Set<string>();
    for (const g of t.groups) {
      let ge = groupViews.get(g.label);
      if (ge === undefined) {
        ge = el('div', 'it-group', g.label);
        groupViews.set(g.label, ge);
      }
      groupsSeen.add(g.label);
      wanted.push(ge);
      for (const r of g.rows) {
        const id = rowId(r);
        let v = rowViews.get(id);
        if (v === undefined) {
          v = createRow(r);
          rowViews.set(id, v);
        }
        updateRow(v, r);
        rowsSeen.add(id);
        wanted.push(v.row);
      }
    }
    for (const [id, v] of rowViews) if (!rowsSeen.has(id)) { v.row.remove(); rowViews.delete(id); }
    for (const [label, ge] of groupViews) if (!groupsSeen.has(label)) { ge.remove(); groupViews.delete(label); }
    // Only rows that appear or move are (re)inserted: a row that stays in place is never detached.
    for (let i = 0; i < wanted.length; i++) {
      const at = treeRows.children[i];
      if (at !== wanted[i]) treeRows.insertBefore(wanted[i]!, at ?? null);
    }
  }

  // ---------------------------------------------------------------- node form
  const formHead = el('div', 'it-form-head');
  const formActionsBox = el('div', 'it-actions');
  const formFieldsBox = el('div', 'it-fields');
  const hoverLine = el('div', 'it-hover');
  hoverLine.hidden = true;
  const formIssues = el('div', 'it-issues');
  formIssues.hidden = true;
  const lintBox = el('div', 'it-lints');
  lintBox.hidden = true;
  formPane.append(formHead, formActionsBox, formFieldsBox, hoverLine, formIssues, lintBox);
  let formKey = '';
  /** The keys of the form's head (path and op select) and of its action buttons, each rebuilt only when it changes. */
  let headKey = '';
  let actionsKey = '';
  /** What each control refreshes on a session change that keeps the form's structure (ref labels, target sliders). */
  let syncs: ((s: SessionState) => void)[] = [];
  let lintKey: readonly unknown[] = [];

  const showIssues = (issues: readonly EditorIssue[] | null, leaf: TreeLeaf): void => {
    formIssues.textContent = issues === null ? '' : issues.map((i) => issueText(i, leaf)).join('\n');
    formIssues.hidden = issues === null || issues.length === 0;
  };

  /**
   * One edit committed through the page's `edit` (§3.3); a refusal shows its issues and runs `failed`. A success selects
   * the node the edit returns, except a tree row's mute (`source` 'row'), which keeps the selection (§3.2).
   */
  function commit(e: Event, make: () => FormEdit, leaf: TreeLeaf, failed: () => void = () => {}, source: 'form' | 'row' = 'form'): boolean {
    const out: { r?: FormCommit } = {};
    deps.edit(e, () => { out.r = commitFormEdit(session, make()); });
    const r = out.r;
    if (r === undefined) throw new Error('edit did not run the form commit');
    if (!r.ok) {
      showIssues(r.issues, leaf);
      failed();
      return false;
    }
    showIssues(null, leaf);
    setSelection(selectionAfterCommit(source, selection, r.select), false);
    return true;
  }

  const fieldRow = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const row = el('div', 'it-field');
    row.append(el('span', 'it-name', label), ...controls);
    return row;
  };

  const invalid = (input: HTMLElement, on: boolean): void => {
    input.classList.toggle('it-invalid', on);
    if (on) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  /** A text field that commits on change (Enter or blur) and restores its text on Escape. */
  const textField = (value: string, label: string, write: (text: string) => FormEdit, leaf: TreeLeaf): HTMLInputElement => {
    const input = el('input', 'it-input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = value;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', (e) => { invalid(input, !commit(e, () => write(input.value), leaf)); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      input.value = value;
      invalid(input, false);
    });
    return input;
  };

  /** A numeric field (§3.3 "Param ref"): literal or a target, "negate", and the target's slider while it is a ref. */
  const numberControl = (f: NumberField, label: string): HTMLElement => {
    const sel = selection;
    const ref = isRefValue(f.value) ? f.value : null;
    const choice = el('select', 'it-ref');
    choice.setAttribute('aria-label', `${label}: a literal or a parameter`);
    choice.append(new Option('literal', ''));
    const targets = refOptions(params(), f.int);
    for (const o of targets) choice.append(new Option(o.label, o.path));
    choice.value = ref === null ? '' : ref.param;
    const literal = textField(typeof f.value === 'number' ? numberText(f.value) : '', label,
      (text) => setTypedNumber(params(), sel, f.key, text), sel.leaf);
    literal.hidden = ref !== null;
    const neg = el('input');
    neg.type = 'checkbox';
    neg.checked = ref?.neg === true;
    const negLabel = el('label', 'it-check', ' negate');
    negLabel.prepend(neg);
    negLabel.hidden = ref === null || !f.negatable;
    const pick = (path: string, negated: boolean): NumberChoice =>
      (path === '' ? { kind: 'literal' } : negated && f.negatable ? { kind: 'param', path, neg: true } : { kind: 'param', path });
    choice.addEventListener('change', (e) => commit(e, () => setNumber(params(), sel, f.key, pick(choice.value, neg.checked)), sel.leaf, () => {
      choice.value = ref === null ? '' : ref.param;
    }));
    neg.addEventListener('change', (e) => commit(e, () => setNumber(params(), sel, f.key, pick(choice.value, neg.checked)), sel.leaf, () => {
      neg.checked = !neg.checked;
    }));
    const row = fieldRow(label, choice, literal, negLabel);
    row.classList.add('it-number');
    const target = ref === null ? null : createTargetRow({ session, edit: deps.edit, drags }, ref.param);
    if (target !== null) {
      target.element.classList.add('it-target');
      row.append(target.element);
    }
    syncs.push((s) => {
      refOptions(s.params, f.int).forEach((o, i) => { const opt = choice.options[i + 1]; if (opt !== undefined) opt.text = o.label; });
      target?.sync(s);
    });
    return row;
  };

  const selectControl = (key: string, value: string, options: readonly string[], write: (v: string) => FormEdit, leaf: TreeLeaf): HTMLSelectElement => {
    const s = el('select', 'it-select');
    s.setAttribute('aria-label', key);
    for (const o of options) s.append(new Option(o, o));
    if (!options.includes(value)) s.append(new Option(value, value));
    s.value = value;
    s.addEventListener('change', (e) => commit(e, () => write(s.value), leaf, () => { s.value = value; }));
    return s;
  };

  const knotsControl = (f: Extract<FormField, { type: 'knots' }>): HTMLElement => {
    const sel = selection;
    const box = el('div', 'it-knots');
    box.append(el('span', 'it-name', 'knots'));
    const table = el('div', 'it-knot-table');
    const knotsNow = (): readonly (readonly [NumberValue, NumberValue])[] => {
      const k = formFields(params(), sel).find((x) => x.type === 'knots');
      return k?.type === 'knots' ? k.value : [];
    };
    f.value.forEach((knot, i) => {
      const cell = (j: 0 | 1): HTMLElement => numberControl({
        type: 'number', key: `knots[${String(i)}][${String(j)}]`, value: knot[j], current: currentNumber(params(), knot[j]), int: false, negatable: true,
      }, j === 0 ? `y ${String(i)}` : `v ${String(i)}`);
      const remove = button('×', `Remove knot ${String(i)}`, (e) => commit(e, () => setKnots(params(), sel, knotsNow().filter((_, j) => j !== i)), sel.leaf), 'it-remove');
      const row = el('div', 'it-knot');
      row.append(cell(0), cell(1), remove);
      table.append(row);
    });
    const add = button('Add knot', 'Append a knot one block above the last', (e) => commit(e, () => {
      const k = knotsNow();
      const last = k.at(-1);
      const next: [number, number] = last === undefined ? [0, 0] : [currentNumber(params(), last[0]) + 1, currentNumber(params(), last[1])];
      return setKnots(params(), sel, [...k, next]);
    }, sel.leaf));
    box.append(table, add);
    return box;
  };

  const biomesControl = (f: Extract<FormField, { type: 'biomes' }>): HTMLElement => {
    const sel = selection;
    const s = el('select', 'it-biomes');
    s.multiple = true;
    s.size = Math.min(8, f.options.length);
    s.setAttribute('aria-label', 'biomes');
    for (const o of f.options) {
      const opt = new Option(o, o);
      opt.selected = f.value.includes(o);
      s.append(opt);
    }
    s.addEventListener('change', (e) => commit(e, () => setField(params(), sel, 'biomes', [...s.selectedOptions].map((o) => o.value)), sel.leaf, () => {
      for (const opt of s.options) opt.selected = f.value.includes(opt.value);
    }));
    return fieldRow('biomes', s);
  };

  const controlOf = (f: FormField): HTMLElement => {
    const sel = selection;
    switch (f.type) {
      case 'number': return numberControl(f, f.key);
      case 'select': return fieldRow(f.key, selectControl(f.key, f.value, f.options, (v) => setField(params(), sel, f.key, v), sel.leaf));
      case 'boolean': {
        const c = el('input');
        c.type = 'checkbox';
        c.checked = f.value;
        c.setAttribute('aria-label', f.key);
        c.addEventListener('change', (e) => commit(e, () => setField(params(), sel, f.key, c.checked), sel.leaf, () => { c.checked = f.value; }));
        return fieldRow(f.key, c);
      }
      case 'name': {
        const write = f.key === 'defName'
          ? (text: string) => renameDef(params(), f.value, text)
          : (text: string) => setField(params(), sel, f.key, text);
        return fieldRow(f.key === 'defName' ? 'def name' : f.key, textField(f.value, f.key, write, sel.leaf));
      }
      case 'knots': return knotsControl(f);
      case 'biomes': return biomesControl(f);
    }
  };

  function buildForm(): void {
    const p = params();
    const sel = selection;
    const fields = formFields(p, sel);
    const ops = opOptions(p, sel);
    const actions = formActions(p, sel);
    const key = keyOf([sel, fields.map((f) => (f.type === 'number' ? { ...f, current: 0 } : f)), ops, actions]);
    if (key === formKey) return;
    formKey = key;
    syncs = [];
    const density = sel.leaf === 'density.defs';
    const head = keyOf([sel, ops]);
    if (head !== headKey) {
      headKey = head;
      const path = el('div', 'it-path', `${sel.leaf}.${sel.path}`);
      path.title = `${sel.leaf}.${sel.path}`;
      const op = el('select', 'it-op');
      op.setAttribute('aria-label', density ? 'op' : 'kind');
      for (const o of ops) {
        const opt = new Option(o.op, o.op);
        opt.disabled = o.disabled;
        op.append(opt);
      }
      const current = ops.find((o) => o.current)?.op ?? '';
      op.value = current;
      op.addEventListener('change', (e) => commit(e, () => replaceOp(params(), sel, op.value), sel.leaf, () => { op.value = current; }));
      formHead.replaceChildren(path, fieldRow(density ? 'op' : 'kind', op));
    }
    // The action buttons are rebuilt only when the set changes, and act on the selection at click time: a click whose
    // mousedown commits a field on blur (which rebuilds the fields) still reaches its button (SP3d final review).
    const muted = fields.some((f) => f.key === 'mute');
    const acting = keyOf([density, actions, muted]);
    if (acting !== actionsKey) {
      actionsKey = acting;
      const acts: HTMLElement[] = [];
      if (actions.wrap) acts.push(button('Wrap', density ? 'Wrap the node in a tap with a fresh name' : 'Wrap the rule in a one-child sequence', (e) => commit(e, () => wrapNode(params(), selection), selection.leaf)));
      if (actions.delete) acts.push(button('Delete', 'Delete the node (one-child nodes are unwrapped)', (e) => commit(e, () => deleteNode(params(), selection), selection.leaf)));
      if (actions.addRule) acts.push(button('Add rule', 'Append a block stone rule to this sequence', (e) => commit(e, () => addRule(params(), selection), selection.leaf)));
      if (density) acts.push(button('Add def', 'Add a def (const 0) and select it', (e) => commit(e, () => addDef(params()), 'density.defs')));
      if (actions.mute) {
        const mute = el('input');
        mute.type = 'checkbox';
        mute.checked = muted;
        const label = el('label', 'it-check', ' muted');
        label.prepend(mute);
        label.title = 'A muted tap evaluates to its mute value (the neutral value of its parent at first)';
        mute.addEventListener('change', (e) => commit(e, () => toggleMute(params(), selection), selection.leaf, () => { mute.checked = muted; }));
        acts.push(label);
      }
      formActionsBox.replaceChildren(...acts);
    }
    formFieldsBox.replaceChildren(...fields.map(controlOf));
  }

  function renderForm(s: SessionState): void {
    buildForm();
    for (const sync of syncs) sync(s);
    const k = [s.params.density, s.params.surface];
    if (k[0] !== lintKey[0] || k[1] !== lintKey[1]) {
      lintKey = k;
      const lints = treeLints(s.params);
      lintBox.replaceChildren(...lints.map((t) => el('div', 'it-lint', t)));
      lintBox.hidden = lints.length === 0;
    }
  }

  // ---------------------------------------------------------------- JSON editor
  const refreshHighlight = (scroll: boolean, at: TextRange | null = null): void => {
    const m = view.model;
    if (m === null) return;
    const s = m.state;
    const r = at ?? (bufferHighlight !== null && s.ranges !== null ? s.ranges.byPath.get(bufferHighlight) ?? null : highlightRange(s, selection));
    view.highlight(r, scroll);
  };
  /** The caret (or an issue's position) at `caret` in the editor's buffer: highlight its node, select it when the session has it. */
  const caretAt = (s: EditorState, caret: number, range: TextRange | null): void => {
    const t = caretTarget({ leaf: s.leaf, ranges: s.ranges, caret }, params());
    if (t.select !== null) {
      bufferHighlight = null;
      if (!sameSelection(t.select, selection)) {
        expansion = expandToSelection(params(), expansion, t.select);
        setSelection(t.select, false, false);
      }
    } else {
      bufferHighlight = t.highlight;
    }
    refreshHighlight(range !== null, range);
  };
  const view = createJsonEditor({
    edit: deps.edit,
    onState: () => refreshHighlight(false),
    onCaret: (s) => caretAt(s, s.caret, null),
    onIssue: (s, path) => {
      if (s.ranges === null) return;
      const r = pathRange(s.ranges, path);
      if (r !== undefined) caretAt(s, r.start, r);
    },
  });
  jsonPane.append(view.element);
  jsonView = view;

  // ---------------------------------------------------------------- selection and rendering
  /** Shows `sel` (followed on the session's tree); `scroll` scrolls the text to it; `rebind` binds its root's editor. */
  function setSelection(sel: Selection, scroll: boolean, rebind = true): void {
    const next = followNode(params(), sel);
    const changed = !sameSelection(next, selection);
    selection = next;
    if (rebind) {
      bufferHighlight = null;
      view.bind(editors.get(selection.leaf)!);
    }
    if (shown) {
      renderTree();
      renderForm(session.state);
      if (rebind) refreshHighlight(scroll);
    } else {
      stale = true;
    }
    if (changed) for (const l of listeners) l(selection);
  }

  function choose(sel: Selection, scroll: boolean): void {
    showIssues(null, sel.leaf);
    setSelection(sel, scroll);
  }

  const renderAll = (): void => {
    stale = false;
    renderTree();
    renderForm(session.state);
    refreshHighlight(false);
  };

  const unsubscribe = session.subscribe(() => {
    for (const m of editors.values()) m.sessionChanged();
    const next = followNode(params(), selection);
    if (!sameSelection(next, selection)) {
      setSelection(next, false);
      return;
    }
    if (shown) renderAll();
    else stale = true;
  });

  view.bind(editors.get(selection.leaf)!);
  renderAll();

  return {
    element,
    sliceHost,
    get selection() { return selection; },
    select(sel) {
      expansion = expandToSelection(params(), expansion, followNode(params(), sel));
      choose(sel, true);
    },
    onSelect(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    setHoverValue(text) {
      hoverLine.textContent = text === null ? '' : `value at the hover: ${text}`;
      hoverLine.hidden = text === null;
    },
    setShown(on) {
      if (on === shown) return;
      shown = on;
      if (!on) {
        saved = { tree: treePane.scrollTop, form: formPane.scrollTop };
        view.saveScroll();
        return;
      }
      if (stale) renderAll();
      if (saved !== null) {
        treePane.scrollTop = saved.tree;
        formPane.scrollTop = saved.form;
      }
      view.restoreScroll();
    },
    dispose() {
      unsubscribe();
      // A target slider's drag still open ends (its window listeners, its gesture; SP4c spec §1.2).
      for (const end of [...drags]) end();
      resize.disconnect();
      view.dispose();
      for (const m of editors.values()) m.dispose();
      listeners.clear();
    },
  };
}

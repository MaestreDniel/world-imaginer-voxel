/**
 * The biome table (SP2b spec §5.2, §5.3), mounted in the Biomes tab: one row per box biome with its colour
 * swatch, name, family badge, a modified dot and a row reset, then five `[lo, hi]` fields, each with a bar over
 * [−1, 1] whose ends drag (one gesture per drag), the sign(W) select and the priority field. The header sorts
 * by priority, name or family, filters by family, counts the modified rows and resets the whole table.
 * Every change writes the whole table with `session.set('biomes.table', table)` (the leaf is atomic). A typed
 * value the model or the validator refuses keeps its text with a red border and the issue under its row, and
 * is not applied; Escape, a reset or a change of that cell in the draft restores it. Hovering a row reports its
 * biome to the page, which highlights it on the map's biome layer or shows a notice on the other layers.
 * The table follows the session: it shows the draft after every change.
 */
import './table.css';
import type { BoxBiome } from '../../core/params/biomeDefaults';
import { canonicalJSON } from '../../core/params/canonical';
import { BOX_AXES, type BoxAxis, type BoxRow, type BoxTable, type Interval, type Issue } from '../../core/params/kit';
import { resolveProfile, type ProfileId } from '../../core/params/profiles';
import type { SessionResult, SessionState, WorldSession } from '../../engine/session';
import type { BiomeFamily } from '../../gen/biomes/registry';
import { el } from '../common/dom';
import { modifiedText } from '../paramPanel/model';
import {
  barFraction, barValue, BIOME_TABLE_PATH, dragAxisEnd, hitBarEnd, intervalText, modifiedRows, resetRow, rowChanges, rowIssueText, setAxisText,
  setPriorityText, setWSign, swatchColor, TABLE_FAMILIES, tableRows, type RowCell, type TableEdit, type TableSort,
} from './model';

export interface TableDeps {
  readonly session: WorldSession;
  /** Runs a session call caused by the input event `e`, so the preview latency counts from `e.timeStamp` (§2.8). */
  edit(e: Event, fn: () => void): void;
  /**
   * The biome of the row the pointer enters, or null when it leaves the rows (§5.3). Moving from row to row
   * reports only the new row.
   */
  hover(biome: number | null): void;
}

export interface BiomeTable {
  readonly element: HTMLElement;
  /** Stops following the session and ends the hover (the DOM stays). */
  dispose(): void;
}

const AXIS_TIPS: Readonly<Record<BoxAxis, string>> = {
  C: 'Continentalness', E: 'Erosion', PV: 'Peaks and valleys (folded from weirdness)', T: 'Temperature', H: 'Humidity',
};
const SORTS: readonly TableSort[] = ['priority', 'name', 'family'];
const W_TIP = 'sign(W) filter: −1 keeps the box where W < 0, +1 where W > 0, 0 everywhere';
/** A press this close to a bar end grabs it. */
const BAR_SLACK_PX = 6;
/** A bar drag's gesture begins once the pointer has moved this far (a press alone changes nothing). */
const DRAG_START_PX = 2;

type Table = BoxTable<BoxBiome>;
const tableOf = (s: SessionState): Table => s.params.biomes.table;

/** The profile's table, resolved once per profile. */
const profileTables = new Map<ProfileId, Table>();
function profileTable(id: ProfileId): Table {
  let t = profileTables.get(id);
  if (t === undefined) {
    t = resolveProfile(id).biomes.table;
    profileTables.set(id, t);
  }
  return t;
}

/** A typed cell: shows the draft's text, commits on change (Enter or blur), Escape restores the draft's text. */
interface Cell {
  readonly input: HTMLInputElement;
  /** The draft's text: replaces the shown text (and drops a refusal) when it differs from the text shown last. */
  show(text: string): void;
  restore(): void;
  refuse(): void;
}

function cell(id: string, className: string, label: string, onCommit: (e: Event, text: string) => void, onRestore: () => void): Cell {
  const input = el('input', `bt-field ${className}`);
  input.type = 'text';
  input.id = id;
  input.inputMode = 'decimal';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', label);
  let shown = '';
  const restore = () => {
    input.value = shown;
    input.classList.remove('bt-invalid');
    input.removeAttribute('aria-invalid');
    onRestore();
  };
  input.addEventListener('change', (e) => onCommit(e, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    restore();
  });
  return {
    input,
    show(text) {
      if (text === shown) return;
      shown = text;
      restore();
    },
    restore,
    refuse() {
      input.classList.add('bt-invalid');
      input.setAttribute('aria-invalid', 'true');
    },
  };
}

interface Bar {
  readonly element: HTMLElement;
  show(iv: Interval): void;
}

/** The bar of one interval cell: the box over [−1, 1] and two draggable ends. */
function bar(deps: TableDeps, name: BoxBiome, axis: BoxAxis): Bar {
  const { session } = deps;
  const element = el('div', 'bt-bar');
  element.setAttribute('aria-hidden', 'true');
  element.title = `Drag an end of the ${axis} box`;
  const fill = el('div', 'bt-fill');
  const lo = el('div', 'bt-end bt-end-lo');
  const hi = el('div', 'bt-end bt-end-hi');
  element.append(el('div', 'bt-zero'), fill, lo, hi);

  /** The pointer from the left of the bar's padding box, where the box and its ends are drawn. */
  const local = (e: PointerEvent) => e.clientX - element.getBoundingClientRect().left - element.clientLeft;
  let drag: { readonly pointerId: number; readonly end: 'lo' | 'hi'; readonly x0: number; readonly grab: number; started: boolean } | null = null;
  element.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag !== null) return;
    const px = local(e);
    const iv = tableOf(session.state)[name][axis];
    const end = hitBarEnd(iv, px, element.clientWidth, BAR_SLACK_PX);
    if (end === null) return;
    e.preventDefault();
    // The end keeps its offset to the pointer, so it does not jump to the press.
    drag = { pointerId: e.pointerId, end, x0: e.clientX, grab: barFraction(iv[end === 'lo' ? 0 : 1]) * element.clientWidth - px, started: false };
    element.setPointerCapture(e.pointerId);
  });
  element.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x0) < DRAG_START_PX) return;
      drag.started = true;
    }
    // Something may have ended the gesture mid-drag (Ctrl+Z ends it first, §1.3): the next move begins a new one.
    if (!session.inGesture) session.beginGesture();
    const t = tableOf(session.state);
    const next = dragAxisEnd(t, name, axis, drag.end, barValue(local(e) + drag.grab, element.clientWidth));
    if (next !== t) deps.edit(e, () => { session.set(BIOME_TABLE_PATH, next); });
  });
  const end = (e: PointerEvent) => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const started = drag.started;
    drag = null;
    if (started) session.endGesture();
  };
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  element.addEventListener('lostpointercapture', end);

  let shown = '';
  return {
    element,
    show(iv) {
      const key = intervalText(iv);
      if (key === shown) return;
      shown = key;
      const a = barFraction(iv[0]) * 100;
      const b = barFraction(iv[1]) * 100;
      fill.style.left = `${a}%`;
      fill.style.width = `${b - a}%`;
      lo.style.left = `${a}%`;
      hi.style.left = `${b}%`;
    },
  };
}

interface Row {
  readonly name: BoxBiome;
  readonly family: BiomeFamily;
  readonly element: HTMLElement;
  /** Shows the draft's row against the profile's row. */
  sync(row: BoxRow, from: BoxRow): void;
  /** Shows the draft's value in every cell again and drops every refusal. */
  restore(): void;
}

function createRow(deps: TableDeps, name: BoxBiome, biome: number, family: BiomeFamily): Row {
  const { session } = deps;
  const element = el('div', 'bt-row');
  element.dataset['biome'] = name;

  /** The issue lines under the row, by cell ('reset' for a refused row reset), in the order they were refused. */
  const issues = new Map<string, string>();
  const issueBox = el('div', 'bt-issue');
  issueBox.setAttribute('role', 'status');
  issueBox.hidden = true;
  const renderIssues = () => {
    issueBox.textContent = [...issues.values()].join('\n');
    issueBox.hidden = issues.size === 0;
  };
  const dropIssue = (key: string) => {
    if (issues.delete(key)) renderIssues();
  };
  /** Refusals without a field of their own (the row reset, the sign select): each stays while the draft's row is the one it was refused on. */
  const against = new Map<'reset' | 'wSign', string>();
  const refuseRow = (key: 'reset' | 'wSign', text: string) => {
    against.set(key, canonicalJSON(tableOf(session.state)[name]));
    issues.set(key, text);
    renderIssues();
  };
  const dropRow = (key: 'reset' | 'wSign') => {
    against.delete(key);
    dropIssue(key);
  };

  /** Runs a session call through the page's `edit`, keeping its result. */
  const run = (e: Event, fn: () => SessionResult): SessionResult => {
    const out: { r?: SessionResult } = {};
    deps.edit(e, () => { out.r = fn(); });
    if (out.r === undefined) throw new Error('edit did not run the session call');
    return out.r;
  };
  const refuse = (key: RowCell, issue: Issue) => {
    if (key === 'wSign') {
      syncSign(tableOf(session.state)[name]);
      refuseRow(key, rowIssueText(name, issue));
      return;
    }
    cells[key].refuse();
    issues.set(key, rowIssueText(name, issue));
    renderIssues();
  };
  /** Writes a table the model returned for `key`'s edit; the same table changes nothing. */
  const write = (e: Event, key: RowCell, t: Table, r: TableEdit) => {
    if (!r.ok) {
      refuse(key, r.issue);
      return;
    }
    if (r.table !== t) {
      const res = run(e, () => session.set(BIOME_TABLE_PATH, r.table));
      if (!res.ok) {
        refuse(key, res.issues[0]!);
        return;
      }
    }
    if (key === 'wSign') dropRow(key);
    else cells[key].restore();
  };

  // The head: swatch, name, family, modified dot and reset.
  const head = el('div', 'bt-row-head');
  const who = el('span', 'bt-who');
  const swatch = el('span', 'bt-swatch');
  swatch.style.background = swatchColor(biome);
  const label = el('span', 'bt-name', name);
  label.title = `${name} (biome id ${biome}, ${family})`;
  who.append(swatch, label, el('span', `bt-family bt-family-${family}`, family));
  const sign = el('select', 'bt-wsign');
  sign.id = `bt-${name}-wSign`;
  sign.title = W_TIP;
  for (const [v, text] of [['-1', '−1'], ['0', '0'], ['1', '+1']] as const) sign.append(new Option(text, v));
  const signLabel = el('label', 'bt-axis', 'W');
  signLabel.htmlFor = sign.id;
  signLabel.title = W_TIP;
  const syncSign = (row: BoxRow) => { sign.value = String(row.wSign); };
  sign.addEventListener('change', (e) => {
    const t = tableOf(session.state);
    const v = sign.value === '-1' ? -1 : sign.value === '1' ? 1 : 0;
    write(e, 'wSign', t, { ok: true, table: setWSign(t, name, v) });
  });

  const cells = {} as Record<BoxAxis | 'priority', Cell>;
  cells.priority = cell(`bt-${name}-priority`, 'bt-priority', `${name} priority`, (e, text) => {
    const t = tableOf(session.state);
    write(e, 'priority', t, setPriorityText(t, name, text));
  }, () => dropIssue('priority'));
  cells.priority.input.inputMode = 'numeric';
  cells.priority.input.title = 'Tie-break priority (1-1000, unique): the lower wins where boxes overlap equally';
  const prioLabel = el('label', 'bt-cell-label', 'prio');
  prioLabel.htmlFor = cells.priority.input.id;
  prioLabel.title = cells.priority.input.title;
  const dot = el('span', 'bt-dot', '●');
  dot.title = 'modified: differs from the profile';
  const reset = el('button', 'bt-reset', '↺');
  reset.type = 'button';
  reset.title = `Reset ${name} to the profile's row`;
  reset.setAttribute('aria-label', `Reset ${name}`);
  const controls = el('span', 'bt-controls');
  controls.append(dot, reset);
  head.append(who, controls);

  // The five interval cells (label, field and bar), then the sign(W) select and the priority field.
  const axes = el('div', 'bt-axes');
  const bars = {} as Record<BoxAxis, Bar>;
  for (const axis of BOX_AXES) {
    const tip = `${AXIS_TIPS[axis]} box of ${name}: lo, hi within [−1, 1]`;
    const c = cell(`bt-${name}-${axis}`, 'bt-interval', `${name} ${axis} interval`, (e, text) => {
      const t = tableOf(session.state);
      write(e, axis, t, setAxisText(t, name, axis, text));
    }, () => dropIssue(axis));
    c.input.dataset['axis'] = axis;
    c.input.title = tip;
    const l = el('label', 'bt-axis', axis);
    l.htmlFor = c.input.id;
    l.title = tip;
    cells[axis] = c;
    bars[axis] = bar(deps, name, axis);
    axes.append(l, c.input, bars[axis].element);
  }
  const prio = el('span', 'bt-prio');
  prio.append(prioLabel, cells.priority.input);
  axes.append(signLabel, sign, prio);
  element.append(head, axes, issueBox);

  const restore = () => {
    for (const c of Object.values(cells)) c.restore();
    issues.clear();
    against.clear();
    renderIssues();
  };
  reset.addEventListener('click', (e) => {
    const t = tableOf(session.state);
    const r = resetRow(t, profileTable(session.state.profile), name);
    if (!r.ok) {
      refuseRow('reset', rowIssueText(name, r.issue, true));
      return;
    }
    restore();
    if (r.table === t) return;
    const res = run(e, () => session.set(BIOME_TABLE_PATH, r.table));
    if (!res.ok) refuseRow('reset', rowIssueText(name, res.issues[0]!, true));
  });

  element.addEventListener('pointerenter', () => deps.hover(biome));

  return {
    name,
    family,
    element,
    sync(row, from) {
      const changed = new Set(rowChanges(row, from));
      for (const axis of BOX_AXES) {
        cells[axis].show(intervalText(row[axis]));
        cells[axis].input.classList.toggle('bt-changed', changed.has(axis));
        bars[axis].show(row[axis]);
      }
      cells.priority.show(String(row.priority));
      cells.priority.input.classList.toggle('bt-changed', changed.has('priority'));
      syncSign(row);
      sign.classList.toggle('bt-changed', changed.has('wSign'));
      dot.classList.toggle('on', changed.size > 0);
      reset.disabled = changed.size === 0;
      if (against.size > 0) {
        const now = canonicalJSON(row);
        for (const [key, was] of [...against]) if (was !== now) dropRow(key);
      }
    },
    restore,
  };
}

export function createBiomeTable(host: HTMLElement, deps: TableDeps): BiomeTable {
  const { session } = deps;
  const element = el('div', 'bt');

  // The header: sort, family filter, the modified count and the table reset.
  const head = el('div', 'bt-head');
  const sortSelect = el('select', 'bt-sort');
  sortSelect.id = 'bt-sort';
  for (const s of SORTS) sortSelect.append(new Option(s, s));
  const sortLabel = el('label', '', 'sort');
  sortLabel.htmlFor = sortSelect.id;
  const familySelect = el('select', 'bt-filter');
  familySelect.id = 'bt-filter';
  familySelect.append(new Option('all', ''));
  for (const f of TABLE_FAMILIES) familySelect.append(new Option(f, f));
  const familyLabel = el('label', '', 'family');
  familyLabel.htmlFor = familySelect.id;
  const count = el('span', 'bt-count');
  const resetAll = el('button', 'bt-reset-all', 'Reset table');
  resetAll.type = 'button';
  resetAll.title = "Reset every row to the profile's table";
  head.append(sortLabel, sortSelect, familyLabel, familySelect, count, resetAll);
  const help = el('p', 'bt-help', 'Type lo, hi or drag the ends of a bar. Hover a row to highlight its biome on the biome layer.');
  const list = el('div', 'bt-rows');
  list.addEventListener('pointerleave', () => deps.hover(null));
  element.append(head, help, list);

  const rows = new Map<BoxBiome, Row>();
  for (const v of tableRows(tableOf(session.state), 'priority', null)) rows.set(v.name, createRow(deps, v.name, v.biome, v.family));

  let sort: TableSort = 'priority';
  let family: BiomeFamily | null = null;
  /** Puts the rows in `sort` order and hides those outside the family filter, keeping the focus where it was. */
  const order = (t: Table) => {
    const want = tableRows(t, sort, null).map((v) => rows.get(v.name)!);
    for (const r of want) r.element.hidden = family !== null && r.family !== family;
    const now = list.children;
    if (now.length === want.length && want.every((r, i) => now[i] === r.element)) return;
    const active = document.activeElement;
    list.append(...want.map((r) => r.element));
    if (active instanceof HTMLElement && active !== document.activeElement && list.contains(active)) active.focus();
  };
  sortSelect.addEventListener('change', () => {
    sort = SORTS.find((s) => s === sortSelect.value) ?? 'priority';
    order(tableOf(session.state));
  });
  familySelect.addEventListener('change', () => {
    family = TABLE_FAMILIES.find((f) => f === familySelect.value) ?? null;
    order(tableOf(session.state));
  });
  resetAll.addEventListener('click', (e) => {
    deps.edit(e, () => { session.reset(BIOME_TABLE_PATH); });
    for (const r of rows.values()) r.restore();
  });

  let shown: SessionState | null = null;
  const sync = (s: SessionState) => {
    if (s === shown) return;
    shown = s;
    const t = tableOf(s);
    const from = profileTable(s.profile);
    for (const r of rows.values()) r.sync(t[r.name], from[r.name]);
    count.textContent = modifiedText(modifiedRows(t, from).length);
    resetAll.disabled = !session.modified(BIOME_TABLE_PATH);
    order(t);
  };
  const unsubscribe = session.subscribe((s) => sync(s));
  sync(session.state);
  host.replaceChildren(element);

  return {
    element,
    dispose() {
      unsubscribe();
      deps.hover(null);
    },
  };
}

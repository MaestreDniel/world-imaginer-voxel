/**
 * Parameter panel controls (SP2b spec §3.2): the DOM control of one schema leaf, by kind.
 * - number / int: a slider plus a numeric field;
 * - noise: a sub-block with wavelength (log), octaves, persistence, lacunarity, the amplitudes toggle and its
 *   per-octave list, yScale, clampSigma, double and remap, each written as a partial NoiseDef on the leaf;
 *   fields a rule fixes are disabled with the reason in their tooltip; one modified dot and one reset for the
 *   whole leaf;
 * - spline: an "Edit" button that opens the drawer on the leaf;
 * - boxTable: a link to the Biomes tab.
 * Every control has a scope badge, a modified dot, a reset button and a tooltip (doc, range, unit, path).
 * A slider drag is one gesture (§1.3); a numeric field commits on Enter or blur (urgent) and Escape restores
 * the draft value; a refused value keeps its text with a red border and the issue text under its row, and is
 * not applied.
 */
import type { NoiseDef } from '../../core/noise/types';
import { getPath, type Issue } from '../../core/params/kit';
import type { SessionResult, SessionState, WorldSession } from '../../engine/session';
import { el } from '../common/dom';
import {
  amplitudeItemChange, amplitudesToggle, controlTip, issueLines, NOISE_FIELD_DOCS, NOISE_NUMBER_FIELDS, noiseFieldControl, noiseFieldLock,
  octavesChange, parseFieldText, scopeBadge, sliderPosition, sliderPositions, sliderToValue, type ControlSpec, type NoiseNumberField,
} from './model';

export interface ControlDeps {
  readonly session: WorldSession;
  /** Runs a session call caused by the input event `e`, so the preview latency counts from `e.timeStamp` (§2.8). */
  edit(e: Event, fn: () => void): void;
  /** A spline leaf's "Edit" button: opens the drawer on the leaf. */
  openSpline(path: string): void;
  /** A boxTable leaf's link: shows the Biomes tab. */
  showBiomes(): void;
}

export interface PanelControl {
  readonly path: string;
  readonly element: HTMLElement;
  /**
   * Shows the draft: the values, the modified dot, the reset button and the noise locks. A field that shows a
   * refused value keeps it while its value in the draft is unchanged.
   */
  sync(s: SessionState): void;
  /** Shows the draft value in every field again and drops every refusal. */
  restore(): void;
  /** The cross-field lint text under the control (§3.2), or null. */
  setLint(text: string | null): void;
  /** Focuses the control's first input. */
  focus(): void;
}

/** Runs a session call through the page's `edit`, keeping its result. */
function run(deps: ControlDeps, e: Event, fn: () => SessionResult): SessionResult {
  const out: { r?: SessionResult } = {};
  deps.edit(e, () => { out.r = fn(); });
  if (out.r === undefined) throw new Error('edit did not run the session call');
  return out.r;
}

/** A pointer drag of a range input is one gesture: it begins on pointerdown and ends on `change` or on the pointer's release anywhere. */
function dragGesture(slider: HTMLInputElement, session: WorldSession): void {
  slider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    session.beginGesture();
    const end = () => {
      removeEventListener('pointerup', end, true);
      removeEventListener('pointercancel', end, true);
      session.endGesture();
    };
    addEventListener('pointerup', end, true);
    addEventListener('pointercancel', end, true);
  });
  slider.addEventListener('change', () => session.endGesture());
}

/** The issue text under a row: the lines of the input refused last, cleared when that input is restored. */
interface IssueBox {
  readonly element: HTMLElement;
  show(owner: object, issues: readonly Issue[], at: string, base: string): void;
  /** Clears the box when `owner` (or, without one, anyone) put the text there. */
  clear(owner?: object): void;
}

function issueBox(): IssueBox {
  const element = el('div', 'pp-issue');
  element.hidden = true;
  let owner: object | null = null;
  return {
    element,
    show(o, issues, at, base) {
      owner = o;
      element.textContent = issueLines(issues, at, base).join('\n');
      element.hidden = issues.length === 0;
    },
    clear(o) {
      if (o !== undefined && o !== owner) return;
      owner = null;
      element.textContent = '';
      element.hidden = true;
    },
  };
}

/** A numeric text field that shows a draft value: commits on change (Enter or blur), Escape restores the draft value. */
interface ValueField {
  readonly input: HTMLInputElement;
  /** The draft value: the text is replaced when the value differs from the one shown last, or with `force`. */
  show(v: number, force?: boolean): void;
  /** Shows the draft value again and drops a refusal. */
  restore(): void;
}

function valueField(deps: ControlDeps, id: string, issues: IssueBox, at: string, base: string, write: (value: unknown) => SessionResult): ValueField {
  const input = el('input', 'pp-field');
  input.type = 'text';
  input.id = id;
  input.inputMode = 'decimal';
  input.spellcheck = false;
  input.autocomplete = 'off';
  let shown: number | null = null;
  const restore = () => {
    input.value = shown === null ? '' : String(shown);
    input.classList.remove('pp-invalid');
    input.removeAttribute('aria-invalid');
    issues.clear(input);
  };
  input.addEventListener('change', (e) => {
    const r = run(deps, e, () => write(parseFieldText(input.value)));
    if (r.ok) {
      restore();
      return;
    }
    input.classList.add('pp-invalid');
    input.setAttribute('aria-invalid', 'true');
    issues.show(input, r.issues, at, base);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    restore();
  });
  return {
    input,
    show(v, force = false) {
      if (!force && v === shown) return;
      shown = v;
      restore();
    },
    restore,
  };
}

/** Disables an input with the reason in the tooltips of its row and label, or enables it. */
function lockInput(line: HTMLElement, label: HTMLElement, tip: string, inputs: readonly (HTMLInputElement | HTMLSelectElement)[], reason: string | null): void {
  for (const i of inputs) i.disabled = reason !== null;
  line.setAttribute('aria-disabled', String(reason !== null));
  line.title = reason === null ? '' : `fixed: ${reason}`;
  label.title = reason === null ? tip : `${tip}\nFixed: ${reason}`;
}

/** A slider plus a numeric field (and, inside a noise sub-block, the field's label), with its issue text under it. */
interface NumberRow {
  readonly element: HTMLElement;
  readonly field: ValueField;
  show(v: number): void;
  restore(): void;
  lock(reason: string | null): void;
}

function numberRow(deps: ControlDeps, spec: ControlSpec, base: string, labelled: boolean, write: (value: unknown) => SessionResult): NumberRow {
  const element = el('div', 'pp-field-row');
  const line = el('div', 'pp-row');
  const issues = issueBox();
  const field = valueField(deps, `pp-${spec.path}`, issues, spec.path, base, write);
  const positions = sliderPositions(spec);
  const slider = el('input', 'pp-slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(positions);
  slider.step = '1';
  slider.setAttribute('aria-label', `${spec.label} slider`);
  let value: number | null = null;
  const thumb = () => {
    if (value !== null) slider.value = String(sliderPosition(spec, positions, slider.valueAsNumber, value));
  };
  dragGesture(slider, deps.session);
  slider.addEventListener('input', (e) => {
    const r = run(deps, e, () => write(sliderToValue(spec, slider.valueAsNumber / positions)));
    if (r.ok) {
      issues.clear(slider);
      field.restore();
      return;
    }
    issues.show(slider, r.issues, spec.path, base);
    thumb();
  });
  const tip = controlTip(spec);
  const label = el('label', 'pp-row-label', spec.label);
  label.htmlFor = field.input.id;
  label.title = tip;
  if (labelled) line.append(label);
  line.append(slider, field.input);
  element.append(line, issues.element);
  return {
    element,
    field,
    show(v) {
      value = v;
      thumb();
      field.show(v);
    },
    restore() {
      issues.clear();
      field.restore();
      thumb();
    },
    lock(reason) {
      lockInput(line, label, tip, [slider, field.input], reason);
    },
  };
}

/** The control's frame: the header (label, extra elements, scope badge, modified dot, reset) and the lint text. */
interface Frame {
  readonly element: HTMLElement;
  readonly label: HTMLLabelElement;
  setModified(on: boolean): void;
  setLint(text: string | null): void;
}

function frame(deps: ControlDeps, c: ControlSpec, onReset: () => void, extra: readonly HTMLElement[] = []): Frame {
  const element = el('div', `pp-control pp-kind-${c.kind}`);
  element.dataset['path'] = c.path;
  const head = el('div', 'pp-head');
  const label = el('label', 'pp-label', c.label);
  label.title = controlTip(c);
  const b = scopeBadge(c.scope);
  const badge = el('span', `pp-badge pp-badge-${c.scope}`, b.label);
  badge.title = `${b.label}: ${b.tip}`;
  const dot = el('span', 'pp-dot', '●');
  dot.title = 'modified: differs from the profile';
  const reset = el('button', 'pp-reset', '↺');
  reset.type = 'button';
  reset.title = `Reset ${c.label} to the profile's value`;
  reset.setAttribute('aria-label', `Reset ${c.label}`);
  reset.addEventListener('click', (e) => {
    run(deps, e, () => deps.session.reset(c.path));
    onReset();
  });
  const lint = el('div', 'pp-lint');
  lint.hidden = true;
  head.append(label, ...extra, badge, dot, reset);
  element.append(head, lint);
  return {
    element,
    label,
    setModified(on) {
      dot.classList.toggle('on', on);
      reset.disabled = !on;
    },
    setLint(text) {
      lint.textContent = text ?? '';
      lint.hidden = text === null;
      element.classList.toggle('pp-linted', text !== null);
    },
  };
}

function numberControl(deps: ControlDeps, c: ControlSpec): PanelControl {
  const row = numberRow(deps, c, c.path, false, (v) => deps.session.set(c.path, v));
  const f = frame(deps, c, () => row.restore());
  f.label.htmlFor = row.field.input.id;
  f.element.insertBefore(row.element, f.element.lastChild);
  return {
    path: c.path,
    element: f.element,
    sync(s) {
      row.show(getPath(s.params, c.path) as number);
      f.setModified(deps.session.modified(c.path));
    },
    restore: () => row.restore(),
    setLint: (t) => f.setLint(t),
    focus: () => row.field.input.focus(),
  };
}

/** The amplitudes row: the list toggle, one field per octave while a list is active, and its issue text. */
interface AmplitudesRow {
  readonly element: HTMLElement;
  sync(d: NoiseDef): void;
  restore(): void;
}

function amplitudesRow(deps: ControlDeps, leaf: string, def: () => NoiseDef): AmplitudesRow {
  const at = `${leaf}.amplitudes`;
  const element = el('div', 'pp-field-row');
  const line = el('div', 'pp-row');
  const label = el('span', 'pp-row-label', 'amplitudes');
  label.title = `${NOISE_FIELD_DOCS.amplitudes}\nPath: ${at}`;
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.id = `pp-${at}`;
  const toggleLabel = el('label', 'pp-check', ' per-octave list');
  toggleLabel.prepend(toggle);
  line.append(label, toggleLabel);
  const items = el('div', 'pp-amps');
  items.hidden = true;
  const issues = issueBox();
  element.append(line, items, issues.element);
  const fields: ValueField[] = [];
  toggle.addEventListener('change', (e) => {
    const r = run(deps, e, () => deps.session.set(leaf, amplitudesToggle(def(), toggle.checked)));
    if (r.ok) {
      issues.clear(toggle);
      return;
    }
    issues.show(toggle, r.issues, at, leaf);
    toggle.checked = def().amplitudes !== null;
  });
  return {
    element,
    sync(d) {
      toggle.checked = d.amplitudes !== null;
      const list = d.amplitudes ?? [];
      while (fields.length > list.length) {
        const gone = fields.pop()!;
        issues.clear(gone.input);
        gone.input.remove();
      }
      while (fields.length < list.length) {
        const i = fields.length;
        const f = valueField(deps, `pp-${at}[${i}]`, issues, at, leaf, (v) => deps.session.set(leaf, amplitudeItemChange(def(), i, v)));
        f.input.title = `octave ${i}`;
        f.input.setAttribute('aria-label', `amplitude of octave ${i}`);
        fields.push(f);
        items.append(f.input);
      }
      list.forEach((a, i) => fields[i]!.show(a));
      items.hidden = list.length === 0;
    },
    restore() {
      issues.clear();
      for (const f of fields) f.restore();
    },
  };
}

function noiseControl(deps: ControlDeps, c: ControlSpec): PanelControl {
  const { session } = deps;
  const leaf = c.path;
  const def = (): NoiseDef => getPath(session.state.params, leaf) as NoiseDef;
  const set = (partial: unknown): SessionResult => session.set(leaf, partial);
  const wavelength = numberRow(deps, noiseFieldControl(c, 'wavelength'), leaf, true, (v) => set({ wavelength: v }));
  const rows = {} as Record<NoiseNumberField, NumberRow>;
  for (const field of NOISE_NUMBER_FIELDS) {
    rows[field] = numberRow(deps, noiseFieldControl(c, field), leaf, true, field === 'octaves'
      ? (v) => set(typeof v === 'number' ? octavesChange(def(), v) : { octaves: v })
      : (v) => set({ [field]: v }));
  }
  const amps = amplitudesRow(deps, leaf, def);

  // double and remap: a checkbox and a select; a refusal restores the draft's value.
  const choiceRow = (field: 'double' | 'remap', input: HTMLInputElement | HTMLSelectElement, read: () => unknown) => {
    const element = el('div', 'pp-field-row');
    const line = el('div', 'pp-row');
    const tip = `${NOISE_FIELD_DOCS[field]}\nPath: ${leaf}.${field}`;
    const label = el('label', 'pp-row-label', field);
    input.id = `pp-${leaf}.${field}`;
    label.htmlFor = input.id;
    label.title = tip;
    const issues = issueBox();
    line.append(label, input);
    element.append(line, issues.element);
    input.addEventListener('change', (e) => {
      const r = run(deps, e, () => set({ [field]: read() }));
      if (r.ok) {
        issues.clear();
        return;
      }
      issues.show(input, r.issues, `${leaf}.${field}`, leaf);
      syncChoices(def());
    });
    return { element, lock: (reason: string | null) => lockInput(line, label, tip, [input], reason), clear: () => issues.clear() };
  };
  const dbl = el('input');
  dbl.type = 'checkbox';
  const remap = el('select');
  for (const o of ['none', 'uniform']) remap.append(new Option(o, o));
  const dblRow = choiceRow('double', dbl, () => dbl.checked);
  const remapRow = choiceRow('remap', remap, () => remap.value);
  function syncChoices(d: NoiseDef): void {
    dbl.checked = d.double;
    remap.value = d.remap;
    dblRow.lock(noiseFieldLock(c, d, 'double'));
    remapRow.lock(noiseFieldLock(c, d, 'remap'));
  }

  const restore = () => {
    wavelength.restore();
    for (const field of NOISE_NUMBER_FIELDS) rows[field].restore();
    amps.restore();
    dblRow.clear();
    remapRow.clear();
  };
  const f = frame(deps, c, restore);
  f.label.htmlFor = wavelength.field.input.id;
  const body = el('div', 'pp-noise-body');
  // NOISE_KEYS order: wavelength, octaves, persistence, lacunarity, amplitudes, yScale, double, remap, clampSigma.
  body.append(
    wavelength.element, rows.octaves.element, rows.persistence.element, rows.lacunarity.element, amps.element,
    rows.yScale.element, dblRow.element, remapRow.element, rows.clampSigma.element,
  );
  f.element.insertBefore(body, f.element.lastChild);
  return {
    path: leaf,
    element: f.element,
    sync(s) {
      const d = getPath(s.params, leaf) as NoiseDef;
      wavelength.show(d.wavelength);
      wavelength.lock(noiseFieldLock(c, d, 'wavelength'));
      for (const field of NOISE_NUMBER_FIELDS) {
        rows[field].show(d[field]);
        rows[field].lock(noiseFieldLock(c, d, field));
      }
      amps.sync(d);
      syncChoices(d);
      f.setModified(session.modified(leaf));
    },
    restore,
    setLint: (t) => f.setLint(t),
    focus: () => wavelength.field.input.focus(),
  };
}

function splineControl(deps: ControlDeps, c: ControlSpec): PanelControl {
  const open = el('button', 'pp-edit', 'Edit');
  open.type = 'button';
  open.title = `Open ${c.label} in the spline editor`;
  open.addEventListener('click', () => deps.openSpline(c.path));
  const f = frame(deps, c, () => {}, [open]);
  return {
    path: c.path,
    element: f.element,
    sync() { f.setModified(deps.session.modified(c.path)); },
    restore() {},
    setLint: (t) => f.setLint(t),
    focus: () => open.focus(),
  };
}

function tableControl(deps: ControlDeps, c: ControlSpec): PanelControl {
  const link = el('button', 'pp-link', 'Biomes tab');
  link.type = 'button';
  link.title = `Edit ${c.label} in the Biomes tab`;
  link.addEventListener('click', () => deps.showBiomes());
  const f = frame(deps, c, () => {}, [link]);
  return {
    path: c.path,
    element: f.element,
    sync() { f.setModified(deps.session.modified(c.path)); },
    restore() {},
    setLint: (t) => f.setLint(t),
    focus: () => link.focus(),
  };
}

/** The control of one leaf; throws for a kind the panel has no control for (model.ts PANEL_KINDS). */
export function createControl(c: ControlSpec, deps: ControlDeps): PanelControl {
  switch (c.kind) {
    case 'number':
    case 'int': return numberControl(deps, c);
    case 'noise': return noiseControl(deps, c);
    case 'spline': return splineControl(deps, c);
    case 'boxTable': return tableControl(deps, c);
    default: throw new Error(`no panel control for ${c.path} (${c.kind})`);
  }
}

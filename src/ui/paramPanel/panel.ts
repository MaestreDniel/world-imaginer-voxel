/**
 * The parameter panel (SP2b spec §3.2), mounted in the Parameters tab. Every schema group is a collapsible
 * section (collapsed by default; the open sections are stored with the page layout) whose header shows the
 * label, "n modified" and a section reset; every leaf is a control (controls.ts). The cross-field lints
 * (lints.ts) are warnings: listed at the top of the panel (a click reveals the first leaf they name) and shown
 * under the controls they name. The panel follows the session: it shows the draft after every change. In a saved world
 * whose modification mode is off (SP5b spec D10) its value inputs and resets are disabled (`setEditable`).
 */
import './panel.css';
import type { SessionResult, SessionState } from '../../engine/session';
import { el } from '../common/dom';
import { createControl, type ControlDeps, type PanelControl } from './controls';
import { paramLints, type ParamLint } from './lints';
import { modifiedText, panelTree, type SectionSpec } from './model';

/** Where the open sections are kept (the page layout satisfies it). */
export interface SectionStore {
  sectionOpen(path: string): boolean;
  setSectionOpen(path: string, open: boolean): void;
}

export interface PanelDeps extends ControlDeps {
  readonly sections: SectionStore;
}

export interface ParamPanel {
  /** Opens the sections down to a leaf's control, scrolls it into view and focuses it. */
  reveal(path: string): void;
  /**
   * The world-modification mode (SP5b spec D10): false disables every value input, every control's reset and every
   * section's Reset; true gives each its own state back (a field a rule fixes, a Reset with nothing modified stay
   * disabled). The section toggles and the links to the drawer and the Biomes tab stay.
   */
  setEditable(on: boolean): void;
  /** Stops following the session and ends a slider drag still open (its window listeners, its gesture); the DOM stays. */
  dispose(): void;
}

interface SectionView {
  readonly spec: SectionSpec;
  readonly element: HTMLElement;
  /** The controls of the section and of its sub-sections. */
  readonly controls: readonly PanelControl[];
  setOpen(open: boolean): void;
  sync(): void;
}

export function createParamPanel(host: HTMLElement, panelDeps: PanelDeps): ParamPanel {
  const { session } = panelDeps;
  // The open slider drags' ends: dispose ends a drag still open (its window listeners, its gesture; SP4c spec §1.2).
  const drags = new Set<() => void>();
  const deps: PanelDeps = { ...panelDeps, drags };
  const controls = new Map<string, PanelControl>();
  const sections: SectionView[] = [];
  let editable = true;

  const run = (e: Event, fn: () => SessionResult) => deps.edit(e, () => { fn(); });

  function section(spec: SectionSpec, depth: number): SectionView {
    const element = el('section', `pp-section pp-depth-${depth}`);
    element.dataset['path'] = spec.path;
    const head = el('div', 'pp-section-head');
    const toggle = el('button', 'pp-toggle', spec.label);
    toggle.type = 'button';
    toggle.title = spec.doc;
    const count = el('span', 'pp-count');
    const reset = el('button', 'pp-section-reset', 'Reset');
    reset.type = 'button';
    reset.title = `Reset every parameter of ${spec.label} to the profile's value`;
    const body = el('div', 'pp-section-body');
    body.id = `pp-section-${spec.path}`;
    toggle.setAttribute('aria-controls', body.id);
    head.append(toggle, count, reset);
    element.append(head, body);

    const own: PanelControl[] = [];
    for (const c of spec.controls) {
      const ctl = createControl(c, deps);
      controls.set(c.path, ctl);
      own.push(ctl);
      body.append(ctl.element);
    }
    for (const s of spec.sections) {
      const sub = section(s, depth + 1);
      own.push(...sub.controls);
      body.append(sub.element);
    }

    let isOpen = false;
    const setOpen = (open: boolean) => {
      isOpen = open;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => {
      setOpen(!isOpen);
      deps.sections.setSectionOpen(spec.path, isOpen);
    });
    reset.addEventListener('click', (e) => {
      run(e, () => session.reset(spec.path));
      for (const ctl of own) ctl.restore();
    });
    setOpen(deps.sections.sectionOpen(spec.path));
    const view: SectionView = {
      spec, element, controls: own, setOpen,
      sync() {
        const n = session.modifiedCount(spec.path);
        count.textContent = modifiedText(n);
        reset.disabled = n === 0 || !editable;
      },
    };
    sections.push(view);
    return view;
  }

  const panel = el('div', 'pp');
  const lintBox = el('div', 'pp-lints');
  lintBox.setAttribute('role', 'status');
  lintBox.hidden = true;
  const tree = panelTree();
  panel.append(lintBox);
  for (const c of tree.controls) {
    const ctl = createControl(c, deps);
    controls.set(c.path, ctl);
    panel.append(ctl.element);
  }
  for (const s of tree.sections) panel.append(section(s, 0).element);
  host.replaceChildren(panel);

  function reveal(path: string): void {
    const ctl = controls.get(path);
    if (ctl === undefined) return;
    for (const s of sections) {
      if (s.spec.path !== '' && path.startsWith(`${s.spec.path}.`)) {
        s.setOpen(true);
        deps.sections.setSectionOpen(s.spec.path, true);
      }
    }
    ctl.element.scrollIntoView({ block: 'nearest' });
    ctl.focus();
  }

  let lintKey = '';
  const syncLints = (lints: readonly ParamLint[]) => {
    const key = lints.map((l) => l.message).join('\n');
    if (key === lintKey) return;
    lintKey = key;
    const byPath = new Map<string, string[]>();
    for (const l of lints) for (const p of l.paths) byPath.set(p, [...(byPath.get(p) ?? []), l.message]);
    for (const [p, ctl] of controls) ctl.setLint(byPath.get(p)?.join('\n') ?? null);
    lintBox.replaceChildren(...lints.map((l) => {
      const b = el('button', 'pp-lint-item', l.message);
      b.type = 'button';
      b.title = `Show ${l.paths.join(' and ')}`;
      b.addEventListener('click', () => reveal(l.paths[0]!));
      return b;
    }));
    lintBox.hidden = lints.length === 0;
  };

  let shown: SessionState | null = null;
  const sync = (s: SessionState) => {
    if (s === shown) return;
    shown = s;
    for (const ctl of controls.values()) ctl.sync(s);
    for (const v of sections) v.sync();
    syncLints(paramLints(s.params));
  };
  const unsubscribe = session.subscribe((s) => sync(s));
  sync(session.state);

  return {
    reveal,
    setEditable(on) {
      editable = on;
      for (const ctl of controls.values()) ctl.setEditable(on);
      for (const v of sections) v.sync();
    },
    dispose() {
      unsubscribe();
      for (const end of [...drags]) end();
    },
  };
}

/**
 * The editor toolbar (SP2b spec §3.1): layer select; seed input with "Same seed" and "New seed"; profile
 * select (ready profiles) with the inline confirmation before a switch that clears modified parameters;
 * the biome-size slider (§6.4: a pointer drag is one gesture, a keyboard step one urgent edit); undo and
 * redo; the grid toggle; the cut-line button (§4.5); the preview status (§2.6); "Open in 3D" (SP4a spec §8.2). Every
 * edit goes through the session; sync() shows its draft after each change. Embedded in the world's map (SP4c spec §2.5,
 * D17) it has no "Open in 3D" and ends with the click hint (D26), then the overlay's slot. In a saved world whose
 * modification mode is off (SP5b spec D10) its terrain controls are disabled (`setEditable`).
 */
import { isProfileId, isProfileReady, PROFILE_IDS, type ProfileId } from '../../core/params/profiles';
import type { SessionResult, WorldSession } from '../../engine/session';
import { isLayerId, LAYERS, type LayerId } from '../../gen/map/layers';
import { el } from '../common/dom';
import type { Notices } from '../common/notice';
import { cutButton, CUT_OFF, type CutTool } from '../crossSection/model';
import { BIOME_SIZE_SCALE, biomeSizePosition } from './biomeSize';
import type { DriverStatus } from './previewDriver';

/** "last edit → preview N ms" (input time to the drawn preview), then the pending state and the error. */
export function previewStatusText(s: DriverStatus): string {
  const parts = [s.lastLatencyMs === null ? 'last edit → preview …' : `last edit → preview ${Math.round(s.lastLatencyMs)} ms`];
  if (s.pending) parts.push('pending');
  if (s.error !== null) parts.push(`error: ${s.error}`);
  return parts.join(' · ');
}

/** The inline confirmation before a profile switch that clears `n` (> 0) modified parameters (§3.1). */
export function profileSwitchText(id: ProfileId, n: number): string {
  return `Switching to ${id} clears ${n} modified parameter${n === 1 ? '' : 's'}`;
}

/** The profile select's options: the ready profiles (`isProfileReady` at `CURRENT_SP`) in `PROFILE_IDS` order. */
export function profileOptions(): ProfileId[] {
  return PROFILE_IDS.filter((p) => isProfileReady(p));
}

export interface BiomeSizeView {
  /** The slider position, 1-10. */
  readonly v: number;
  /** "≈" when `scaleMul` is not the table value at `v` (typed in the panel or loaded from a preset). */
  readonly mark: '' | '≈';
  readonly tip: string;
}

/** What the biome-size slider shows for a draft's `climate.scaleMul` (§6.4). */
export function biomeSizeView(scaleMul: number): BiomeSizeView {
  const p = biomeSizePosition(scaleMul);
  return p.exact
    ? { v: p.v, mark: '', tip: `Biome size ${p.v} of 10 (climate.scaleMul ${scaleMul})` }
    : { v: p.v, mark: '≈', tip: `Biome size ≈ ${p.v} of 10: climate.scaleMul is ${scaleMul}; moving the slider writes the table value` };
}

/**
 * "Open in 3D" (SP4a spec §8.2; ruling P51): `/?at=<x>,<z><hash>` at the rounded pin, else the rounded view centre;
 * `hash` carries its leading '#' and is kept unchanged. With `?at` the root skips the start screen.
 */
export function open3dHref(pin: readonly [number, number] | null, centre: readonly [number, number], hash: string): string {
  const [x, z] = pin ?? centre;
  return `/?at=${Math.round(x) + 0},${Math.round(z) + 0}${hash}`;
}

export interface ToolbarDeps {
  readonly session: WorldSession;
  readonly notices: Notices;
  readonly layer: LayerId;
  /** Runs a session call caused by the input event `e`, so the preview latency counts from `e.timeStamp`. */
  edit(e: Event, fn: () => void): void;
  onLayer(id: LayerId): void;
  onGrid(on: boolean): void;
  /** The cut-line button: arms the map's two-click line tool, or cancels it while armed (§4.5). */
  onCut(): void;
  /** "Open in 3D"'s URL, read at click time (`open3dHref` over the map's pin, view and hash). */
  open3dHref(): string;
  /**
   * In the world's map (SP4c spec §2.5): "Open in 3D" is left out, and the toolbar ends with `hint` (D26), then `slot`
   * (the overlay's mode switch, Watch live, Centre on me and Close). Null on the standalone `?map`.
   */
  readonly embedded: { readonly slot: HTMLElement; readonly hint: string } | null;
}

export interface Toolbar {
  /** Shows the draft: seed text, profile, biome-size position and "≈", undo and redo availability. */
  sync(): void;
  setLayer(id: LayerId): void;
  setStatus(s: DriverStatus): void;
  /** Shows the cut-line tool's state on its button. */
  setCut(tool: CutTool): void;
  /**
   * The world-modification mode (SP5b spec D10): false disables the seed, Same seed, New seed, the profile, the biome
   * size, Undo and Redo; the layer, the grid and the cut line stay. Undo and Redo keep their own reason (no step).
   */
  setEditable(on: boolean): void;
  /**
   * Ends a slider drag still open (its window listeners removed, the gesture ended) and ignores a profile confirmation
   * that resolves later (SP4c spec §1.2); its elements go with the layout.
   */
  dispose(): void;
}

const SCALE_PATH = 'climate.scaleMul';

export function createToolbar(host: HTMLElement, deps: ToolbarDeps): Toolbar {
  const { session, notices, edit } = deps;
  let disposed = false;
  /** False while the world-modification mode is off (SP5b spec D10). */
  let editable = true;
  /** The controls only write valid values, but a refusal is shown rather than dropped. */
  const report = (r: SessionResult): boolean => {
    if (!r.ok) notices.show(r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('\n'), { kind: 'error' });
    return r.ok;
  };
  const group = (label: string, ...children: HTMLElement[]): HTMLElement => {
    const g = el('div', 'map-group');
    if (label !== '') g.append(el('span', 'map-label', label));
    g.append(...children);
    return g;
  };
  const button = (text: string, title: string): HTMLButtonElement => {
    const b = el('button', '', text);
    b.type = 'button';
    b.title = title;
    return b;
  };

  const layerSelect = el('select');
  for (const l of LAYERS) layerSelect.append(new Option(l, l));
  layerSelect.value = deps.layer;
  layerSelect.title = 'Map layer';
  const seedInput = el('input');
  seedInput.type = 'text';
  seedInput.placeholder = 'seed (empty = random)';
  seedInput.spellcheck = false;
  seedInput.setAttribute('aria-label', 'Seed');
  const sameSeed = button('Same seed', 'Use the typed seed (as Enter does)');
  const newSeed = button('New seed', 'Draw a random seed');
  const profileSelect = el('select');
  for (const p of profileOptions()) profileSelect.append(new Option(p, p));
  profileSelect.title = 'Profile';
  const slider = el('input', 'map-size');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '10';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Biome size');
  const approx = el('span', 'map-approx');
  const sizeGroup = group('biome size', slider, approx);
  const undoBtn = button('Undo', 'Undo (Ctrl+Z)');
  const redoBtn = button('Redo', 'Redo (Ctrl+Shift+Z or Ctrl+Y)');
  const gridBox = el('input');
  gridBox.type = 'checkbox';
  const gridLabel = el('label', 'map-group', 'grid ');
  gridLabel.append(gridBox);
  const cutBtn = button('', '');
  cutBtn.className = 'map-cut';
  const showCut = (tool: CutTool) => {
    const b = cutButton(tool);
    cutBtn.textContent = b.label;
    cutBtn.title = b.tip;
    cutBtn.setAttribute('aria-pressed', String(b.pressed));
  };
  showCut(CUT_OFF);
  const status = el('span', 'map-status', 'last edit → preview …');
  const open3d = button('Open in 3D', 'Open this world in 3D at the pin, else at the view centre');
  const embedded = deps.embedded;
  host.append(
    el('strong', 'map-title', 'world-imaginer-voxel · map'), layerSelect, group('seed', seedInput, sameSeed, newSeed),
    group('profile', profileSelect), sizeGroup, group('', undoBtn, redoBtn), gridLabel, cutBtn,
  );
  if (embedded === null) host.append(open3d, status);
  else host.append(status, el('span', 'map-hint', embedded.hint), embedded.slot);

  const sync = () => {
    const s = session.state;
    seedInput.value = s.seedText;
    profileSelect.value = s.profile;
    const b = biomeSizeView(s.params.climate.scaleMul);
    slider.value = String(b.v);
    approx.textContent = b.mark;
    sizeGroup.title = b.tip;
    undoBtn.disabled = !editable || !session.canUndo;
    redoBtn.disabled = !editable || !session.canRedo;
  };

  layerSelect.addEventListener('change', () => { if (isLayerId(layerSelect.value)) deps.onLayer(layerSelect.value); });

  // The seed commits on Enter, on blur and with "Same seed"; Escape restores the draft's text.
  const commitSeed = (e: Event) => {
    edit(e, () => session.setSeedText(seedInput.value));
    sync();
  };
  seedInput.addEventListener('change', commitSeed);
  seedInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') seedInput.value = session.state.seedText; });
  sameSeed.addEventListener('click', commitSeed);
  newSeed.addEventListener('click', (e) => edit(e, () => session.newSeed()));

  // The select keeps showing the session's profile until the switch happens; a newer choice replaces a
  // pending confirmation (Task 7). "profile switched" offers Undo while the draft is still the switched one.
  profileSelect.addEventListener('change', (e) => {
    const id = profileSelect.value;
    profileSelect.value = session.state.profile;
    if (!isProfileId(id)) return;
    const n = session.modifiedCount('');
    if (n === 0) {
      edit(e, () => report(session.setProfile(id)));
      return;
    }
    void notices.confirm(profileSwitchText(id, n), 'Switch').then((ok) => {
      // The mode switched off while the confirmation was open (SP5b D10): the session would refuse, so nothing is said.
      if (disposed || !ok || !editable || !session.writable || !report(session.setProfile(id))) return;
      const switched = session.state;
      notices.show('profile switched', { timeoutMs: 5000, actions: [{ label: 'Undo', run: () => { if (session.state === switched) session.undo(); } }] });
    });
  });

  // A pointer drag is one gesture: it begins on pointerdown and ends on change, or on the pointer's release
  // anywhere (a press that leaves the value unchanged fires no change). Keyboard steps are urgent edits.
  /** The ends of the open drags, whose window listeners are still installed. */
  const dragEnds = new Set<() => void>();
  slider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !editable) return;
    session.beginGesture();
    const end = () => {
      removeEventListener('pointerup', end, true);
      removeEventListener('pointercancel', end, true);
      dragEnds.delete(end);
      session.endGesture();
    };
    dragEnds.add(end);
    addEventListener('pointerup', end, true);
    addEventListener('pointercancel', end, true);
  });
  slider.addEventListener('input', (e) => {
    const scaleMul = BIOME_SIZE_SCALE[Number(slider.value) - 1];
    if (scaleMul !== undefined) edit(e, () => report(session.set(SCALE_PATH, scaleMul)));
  });
  slider.addEventListener('change', () => session.endGesture());

  undoBtn.addEventListener('click', (e) => edit(e, () => session.undo()));
  redoBtn.addEventListener('click', (e) => edit(e, () => session.redo()));
  gridBox.addEventListener('change', () => deps.onGrid(gridBox.checked));
  cutBtn.addEventListener('click', () => deps.onCut());
  // The same tab (SP4a spec §8.2).
  open3d.addEventListener('click', () => location.assign(deps.open3dHref()));

  sync();
  return {
    sync,
    setLayer(id) { layerSelect.value = id; },
    setStatus(s) {
      status.textContent = previewStatusText(s);
      status.classList.toggle('map-status-error', s.error !== null);
    },
    setCut: showCut,
    setEditable(on) {
      editable = on;
      for (const c of [seedInput, sameSeed, newSeed, profileSelect, slider]) c.disabled = !on;
      sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const end of [...dragEnds]) end();
    },
  };
}

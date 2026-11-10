/**
 * The Caves tab of the world's map (SP6a spec §7.3, D12), after Presets (`layoutTabs`); `?map` has none (it has no 3D).
 * From the top: "X-ray (X)", a checkbox that mirrors X both ways (a change calls `onXray`; the page's state comes back
 * through `set`); the band's line (`stripText`, as the strip writes it); the "Lowest y" and "Highest y" sliders (−64 …
 * 319, step 1), which keep lowest ≤ highest by moving the other slider (`sliderBand`) and call `onBand` on every move;
 * "All depths" (`XRAY_ALL`); the legend (the nine cave kinds and the surface film in the X-ray's colours); the radius
 * readout; "Cave slice", which opens the Density tab's horizontal `caves` slice at `caveSliceY` (the band's middle y, or
 * the camera's y with the band at all), `CAVE_SLICE_EXTENT` blocks across, centred on the camera (the tool's
 * `openSlice`); and "Cave parameters", which opens Parameters at `CAVE_PARAMETERS_LEAF`, the Caves section's first leaf
 * (the panel's `reveal` takes a leaf path and does nothing for a group's, so it opens the section through its first
 * leaf). Then the Find row (SP6a spec §7.3, D12, D16; the cut line, §15): one button per kind 1-8, "Nearest <kind>"
 * (`FIND_KINDS`; kind 9 has none, the default tree yields none), whose press asks `find(kind)` from the camera; the
 * result line reads "Searching for <kind>…", then `findText`'s "<kind> at x, y, z · d blocks away" (d from the camera
 * at the press, rounded), "No <kind> found within 512 blocks", "No <kind> found in 2 s" or "<kind> search stopped" (the
 * world changed under it); a second press of the button searching, a press of another kind's (which then searches),
 * `cancel()` (the tool's: the tab closed, another tab shown or the map hidden) and `dispose` cancel it (`cancelFind`),
 * "<kind> search cancelled". "Save as place" shows after a hit in a saved world only (`savePlace` non-null) and saves
 * that hit's pose. `set` writes only what changed and calls no dep. Text only through `textContent`; no browser
 * dialog.
 */
import { CAVE_KIND, HEIGHT, MIN_Y } from '../../core/constants';
import { XRAY_COLORS, XRAY_LABELS } from '../../render/xrayPalette';
import { FIND_BUDGET_MS, FIND_RADIUS } from '../../workers/protocol';
import { el } from '../common/dom';
import { bandSet, stripText, XRAY_ALL, type XrayBand } from '../world/xrayStrip';

export interface CavesTabDeps {
  /** The checkbox changed: the X-ray on or off (the page's X). */
  onXray(on: boolean): void;
  /** A slider moved or All depths was pressed: the page's band (its renderer and strip). */
  onBand(b: XrayBand): void;
  /** "Cave slice": the Density tab's horizontal `caves` slice at world y `y`, centred on the camera. */
  openSlice(y: number): void;
  /** "Cave parameters": the Parameters tab at `CAVE_PARAMETERS_LEAF`. */
  revealParameters(): void;
  /**
   * "Nearest <kind>" (SP6a spec §7.3): the search from the camera, which moves the camera into the hit in flight; its
   * hit (null unless `reason` is `found`) and why it ended. Rejected when cancelled (`cancelFind`).
   */
  find(kind: number): Promise<FindOutcome>;
  /** Cancels the search in flight: its `find` promise rejects. */
  cancelFind(): void;
  /** "Save as place": saves a hit's pose as a place (the place dialog); null in an unsaved world, which has no places. */
  readonly savePlace: ((hit: FindHit) => void) | null;
  /** The camera (the page's flight state): its y is the cave slice's with the band at all. */
  camera(): { readonly x: number; readonly y: number; readonly z: number };
}

/** A cave the finder found: its air voxel and a yaw along it (degrees; 0 faces −z). */
export interface FindHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}
/** A search's outcome (the pool's `findCave`). */
export interface FindOutcome {
  readonly hit: FindHit | null;
  readonly reason: 'found' | 'radius' | 'budget' | 'stopped';
}

export interface CavesTab {
  /** The page's X-ray state: on or off, its band and its radius in blocks; writes only what changed. */
  set(on: boolean, band: XrayBand, radius: number): void;
  /** Cancels the search in flight, if any (the tab closed, another tab shown or the map hidden). */
  cancel(): void;
  /** Cancels the search in flight and removes the tab's DOM. */
  dispose(): void;
}

/** The kinds with a Find button, in kind order: the noise kinds 1-5 and the carver kinds 6-8. */
export const FIND_KINDS: readonly number[] = [
  CAVE_KIND.cheese, CAVE_KIND.spaghetti3d, CAVE_KIND.spaghetti2d, CAVE_KIND.noodle, CAVE_KIND.entrance,
  CAVE_KIND.worm, CAVE_KIND.ravine, CAVE_KIND.undergroundWorm,
];

/** A kind's name inside a sentence: its label with a lower-case first letter ("spaghetti 3D", "underground worm"). */
export const kindWord = (kind: number): string => {
  const label = XRAY_LABELS[kind] ?? '';
  return label.charAt(0).toLowerCase() + label.slice(1);
};

/** A Find button's text: "Nearest <kind>". */
export const findButtonText = (kind: number): string => `Nearest ${kindWord(kind)}`;

/**
 * The result line of a search of `kind` from the camera at `from`: "<Kind> at x, y, z · d blocks away" (d the distance
 * from `from` to the hit voxel's centre, rounded), "No <kind> found within 512 blocks", "No <kind> found in 2 s", or
 * "<Kind> search stopped".
 */
export function findText(kind: number, r: FindOutcome, from: { readonly x: number; readonly y: number; readonly z: number }): string {
  const label = XRAY_LABELS[kind] ?? '';
  if (r.hit !== null) {
    const h = r.hit;
    const d = Math.round(Math.hypot(h.x + 0.5 - from.x, h.y + 0.5 - from.y, h.z + 0.5 - from.z));
    return `${label} at ${h.x}, ${h.y}, ${h.z} · ${d} blocks away`;
  }
  if (r.reason === 'radius') return `No ${kindWord(kind)} found within ${FIND_RADIUS} blocks`;
  if (r.reason === 'budget') return `No ${kindWord(kind)} found in ${FIND_BUDGET_MS / 1000} s`;
  return `${label} search stopped`;
}

/** The cave slice's width in blocks (SP6a spec §7.3): a 128² `caves` slice 256 blocks across (`slice.caves128`). */
export const CAVE_SLICE_EXTENT = 256;
/** The leaf "Cave parameters" reveals: the Caves section's first, which opens the section and its Cheese sub-section. */
export const CAVE_PARAMETERS_LEAF = 'caves.cheese.offset';

const WORLD_MIN = MIN_Y;
const WORLD_MAX = MIN_Y + HEIGHT - 1;

/**
 * The band of the sliders after `moved` was set: lowest ≤ highest kept by moving the other slider to the moved one's
 * value (Lowest y 200 with Highest y 100 gives [200, 200]).
 */
export function sliderBand(moved: 'low' | 'high', low: number, high: number): XrayBand {
  return low <= high ? bandSet(low, high) : moved === 'low' ? bandSet(low, low) : bandSet(high, high);
}

/** The cave slice's y: ⌊(yMin + yMax) / 2⌋ of a band; with the band at all, the camera's ⌊y⌋ kept inside −64 … 319. */
export function caveSliceY(b: XrayBand, cameraY: number): number {
  if (!b.all) return Math.floor((b.yMin + b.yMax) / 2);
  return Math.min(WORLD_MAX, Math.max(WORLD_MIN, Math.floor(cameraY)));
}

/** The radius readout: "Radius r blocks". */
export const radiusText = (radius: number): string => `Radius ${radius} blocks`;

/** The legend's kinds, in kind order: the nine cave kinds and the surface film (the kinds with a label). */
const LEGEND_KINDS: readonly number[] = XRAY_LABELS.flatMap((label, kind) => (label === '' ? [] : [kind]));

export function createCavesTab(host: HTMLElement, deps: CavesTabDeps): CavesTab {
  const root = el('div', 'caves-tab');
  const xrayLabel = el('label', 'caves-xray');
  const xrayBox = el('input');
  xrayBox.type = 'checkbox';
  xrayBox.id = 'map-caves-xray';
  xrayBox.checked = false;
  xrayLabel.append(xrayBox, 'X-ray (X)');
  const bandLine = el('div', 'caves-band', stripText(XRAY_ALL));
  bandLine.id = 'map-caves-band';
  const slider = (id: string, label: string, value: number): { row: HTMLLabelElement; input: HTMLInputElement } => {
    const row = el('label', 'caves-slider');
    const input = el('input');
    input.type = 'range';
    input.id = id;
    input.min = String(WORLD_MIN);
    input.max = String(WORLD_MAX);
    input.step = '1';
    input.value = String(value);
    row.append(label, input);
    return { row, input };
  };
  const low = slider('map-caves-low', 'Lowest y', XRAY_ALL.yMin);
  const high = slider('map-caves-high', 'Highest y', XRAY_ALL.yMax);
  const allButton = button('map-caves-all', 'All depths');
  const legend = el('div', 'caves-legend');
  legend.id = 'map-caves-legend';
  for (const kind of LEGEND_KINDS) {
    const key = el('span', 'world-xray-key');
    const swatch = el('span', 'world-xray-swatch');
    swatch.style.background = XRAY_COLORS[kind]!;
    key.append(swatch, el('span', '', XRAY_LABELS[kind]!));
    legend.append(key);
  }
  const radiusOut = el('div', 'caves-radius');
  radiusOut.id = 'map-caves-radius';
  const sliceButton = button('map-caves-slice', 'Cave slice');
  sliceButton.title = `The Density tab's horizontal cave slice at the band's middle y, ${CAVE_SLICE_EXTENT} blocks across, centred on you`;
  const paramsButton = button('map-caves-params', 'Cave parameters');
  paramsButton.title = 'Parameters › Caves';
  // The Find row (SP6a spec §7.3): a button per kind, the result line and "Save as place".
  const findRow = el('div', 'caves-find');
  findRow.id = 'map-caves-find';
  findRow.append(el('div', 'caves-find-title', 'Find'));
  const findButtons = new Map<number, HTMLButtonElement>();
  for (const kind of FIND_KINDS) {
    const b = button(`map-caves-find-${kind}`, findButtonText(kind));
    findButtons.set(kind, b);
    findRow.append(b);
  }
  const resultLine = el('div', 'caves-find-result');
  resultLine.id = 'map-caves-find-result';
  const saveButton = button('map-caves-save-place', 'Save as place');
  saveButton.hidden = true;
  findRow.append(resultLine, saveButton);
  root.append(xrayLabel, bandLine, low.row, high.row, allButton, legend, radiusOut, sliceButton, paramsButton, findRow);
  host.append(root);

  // The state as shown: the checkbox, the band (the sliders and the line) and the radius (NaN: none written yet).
  let on = false;
  let band: XrayBand = XRAY_ALL;
  let radius = Number.NaN;
  // The sliders' values as numbers, as last written or moved to: `set` compares them, so a call with the band unchanged
  // (every X toggle, with the tab mounted from the premount on) reads no input and builds no string (Task 52).
  let lowAt: number = XRAY_ALL.yMin;
  let highAt: number = XRAY_ALL.yMax;
  /** The band's sliders and line; the line only when the band changed. */
  const showBand = (b: XrayBand): void => {
    const changed = b.all !== band.all || b.yMin !== band.yMin || b.yMax !== band.yMax;
    band = b;
    low.input.value = String(b.yMin);
    high.input.value = String(b.yMax);
    lowAt = b.yMin;
    highAt = b.yMax;
    if (changed) bandLine.textContent = stripText(b);
  };

  xrayBox.addEventListener('change', () => deps.onXray(xrayBox.checked));
  const moved = (which: 'low' | 'high') => (): void => {
    const lo = Number(low.input.value);
    const hi = Number(high.input.value);
    lowAt = lo;
    highAt = hi;
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return;
    const b = sliderBand(which, lo, hi);
    showBand(b);
    deps.onBand(b);
  };
  low.input.addEventListener('input', moved('low'));
  high.input.addEventListener('input', moved('high'));
  allButton.addEventListener('click', () => {
    showBand(XRAY_ALL);
    deps.onBand(XRAY_ALL);
  });
  sliceButton.addEventListener('click', () => deps.openSlice(caveSliceY(band, deps.camera().y)));
  paramsButton.addEventListener('click', () => deps.revealParameters());

  // The search in flight: its kind (null: none) and its number, so a cancelled search's late outcome is dropped.
  let searching: number | null = null;
  let search = 0;
  let lastHit: FindHit | null = null;
  const showHit = (hit: FindHit | null): void => {
    lastHit = hit;
    saveButton.hidden = hit === null || deps.savePlace === null;
  };
  /** Cancels the search in flight: the dep, then "<Kind> search cancelled". */
  const cancel = (): void => {
    if (searching === null) return;
    const kind = searching;
    searching = null;
    search++;
    deps.cancelFind();
    resultLine.textContent = `${XRAY_LABELS[kind] ?? ''} search cancelled`;
  };
  const start = (kind: number): void => {
    const c = deps.camera();
    const from = { x: c.x, y: c.y, z: c.z };
    const mine = ++search;
    searching = kind;
    showHit(null);
    resultLine.textContent = `Searching for ${kindWord(kind)}…`;
    deps.find(kind).then((r) => {
      if (mine !== search) return;
      searching = null;
      resultLine.textContent = findText(kind, r, from);
      showHit(r.hit);
    }, () => {
      if (mine !== search) return;
      searching = null;
      resultLine.textContent = `${XRAY_LABELS[kind] ?? ''} search failed`;
    });
  };
  for (const [kind, b] of findButtons) {
    b.addEventListener('click', () => {
      const again = searching === kind;
      cancel();
      if (!again) start(kind);
    });
  }
  saveButton.addEventListener('click', () => {
    if (lastHit !== null && deps.savePlace !== null) deps.savePlace(lastHit);
  });

  return {
    set(nextOn, b, r) {
      if (nextOn !== on) {
        on = nextOn;
        xrayBox.checked = on;
      }
      if (b.all !== band.all || b.yMin !== band.yMin || b.yMax !== band.yMax || lowAt !== b.yMin || highAt !== b.yMax) showBand(b);
      if (r !== radius) {
        radius = r;
        radiusOut.textContent = radiusText(r);
      }
    },
    cancel,
    dispose() {
      cancel();
      root.remove();
    },
  };
}

/** A tab button: `type="button"`, with its id. */
function button(id: string, text: string): HTMLButtonElement {
  const b = el('button', 'caves-button', text);
  b.type = 'button';
  b.id = id;
  return b;
}

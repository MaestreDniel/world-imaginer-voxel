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
 * leaf). The Find row is SP6a Task 44's. `set` writes only what changed and calls no dep. Text only through
 * `textContent`; no browser dialog.
 */
import { HEIGHT, MIN_Y } from '../../core/constants';
import { XRAY_COLORS, XRAY_LABELS } from '../../render/xrayPalette';
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
  /** "Nearest <kind>" (SP6a Task 44's Find row). */
  find(kind: number): void;
  /** Cancels a search in flight (SP6a Task 44's Find row). */
  cancelFind(): void;
  /** The camera (the page's flight state): its y is the cave slice's with the band at all. */
  camera(): { readonly x: number; readonly y: number; readonly z: number };
}

export interface CavesTab {
  /** The page's X-ray state: on or off, its band and its radius in blocks; writes only what changed. */
  set(on: boolean, band: XrayBand, radius: number): void;
  /** Removes the tab's DOM. */
  dispose(): void;
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
  root.append(xrayLabel, bandLine, low.row, high.row, allButton, legend, radiusOut, sliceButton, paramsButton);
  host.append(root);

  // The state as shown: the checkbox, the band (the sliders and the line) and the radius (NaN: none written yet).
  let on = false;
  let band: XrayBand = XRAY_ALL;
  let radius = Number.NaN;
  /** The band's sliders and line; the line only when the band changed. */
  const showBand = (b: XrayBand): void => {
    const changed = b.all !== band.all || b.yMin !== band.yMin || b.yMax !== band.yMax;
    band = b;
    low.input.value = String(b.yMin);
    high.input.value = String(b.yMax);
    if (changed) bandLine.textContent = stripText(b);
  };

  xrayBox.addEventListener('change', () => deps.onXray(xrayBox.checked));
  const moved = (which: 'low' | 'high') => (): void => {
    const lo = Number(low.input.value);
    const hi = Number(high.input.value);
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

  return {
    set(nextOn, b, r) {
      if (nextOn !== on) {
        on = nextOn;
        xrayBox.checked = on;
      }
      if (b.all !== band.all || b.yMin !== band.yMin || b.yMax !== band.yMax || low.input.value !== String(b.yMin) || high.input.value !== String(b.yMax)) showBand(b);
      if (r !== radius) {
        radius = r;
        radiusOut.textContent = radiusText(r);
      }
    },
    dispose() {
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

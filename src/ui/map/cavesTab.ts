/**
 * The Caves tab of the world's map (SP6a spec §7.3, D12), after Presets (`layoutTabs`); `?map` has none (it has no 3D).
 * From the top: "X-ray (X)", a checkbox that mirrors X both ways (a change calls `onXray`; the page's state comes back
 * through `set`); "Colour by", two radios (Cave type, Cave biome) in step with C both ways (SP6b spec §9.3, D11: a
 * choice calls `onColorMode`, and the page's mode comes back through `set`, as the checkbox's state); the band's line
 * (`stripText`, as the strip writes it, in the page's colour mode); the "Lowest y" and "Highest y" sliders (−64 …
 * 319, step 1), which keep lowest ≤ highest by moving the other slider (`sliderBand`) and call `onBand` on every move;
 * "All depths" (`XRAY_ALL`); the legend following the mode, as the strip's: by cave type the nine cave kinds and the
 * surface film, by cave biome Plain cave, Lush, Dripstone, Abyss and the surface film, in the X-ray's colours (the
 * biomes' rows drive the map's cave-biome highlight, `highlightCaveBiome`, ruling P51: a row's biome under the pointer,
 * null when it leaves the legend or the legend hides); the radius readout; "Cave slice", which opens the Density tab's
 * horizontal slice at `caveSliceY` (the band's middle y, or the camera's y with the band at all), `CAVE_SLICE_EXTENT`
 * blocks across, centred on the camera (the tool's `openSlice`), of the `caves` field by cave type and the `biome3d`
 * field by cave biome; "Show cave biomes on the map", the map's caveBiome layer at `caveSliceY` (ruling P53: unrounded);
 * "Cave parameters", which opens Parameters at `CAVE_PARAMETERS_LEAF`, the Caves section's first leaf (the panel's
 * `reveal` takes a leaf path and does nothing for a group's, so it opens the section through its first leaf); and "Cave
 * biome parameters", which opens it at `CAVE_BIOME_PARAMETERS_LEAF`, a leaf of Caves › Cave biomes. Then the Find row
 * (SP6a spec §7.3, D12, D16; the cut line, §15): one button per kind 1-8, "Nearest <kind>" (`FIND_KINDS`; kind 9 has
 * none, the default tree yields none), whose press asks `find(kind)` from the camera; the
 * result line reads "Searching for <kind>…", then `findText`'s "<kind> at x, y, z · d blocks away" (d from the camera
 * at the press, rounded), "No <kind> found within 512 blocks", "No <kind> found in 2 s" or "<kind> search stopped" (the
 * world changed under it); a second press of the button searching, a press of another kind's (which then searches),
 * `cancel()` (the tool's: the tab closed, another tab shown or the map hidden) and `dispose` cancel it (`cancelFind`),
 * "<kind> search cancelled". The biome Find row (SP6b spec §9.3, D11; the cut line, §17) follows: "Nearest lush cave",
 * "Nearest dripstone cave", "Nearest abyss" (`FIND_BIOMES`), whose press asks `find(0, biome)` from the camera, with the
 * same result line ("Lush cave at x, y, z · d blocks away", "No lush cave found within 1024 blocks", "No lush cave found
 * in 2 s", `findBiomeText`), the same cancel rules (one search at a time across both rows) and the same "Save as place".
 * "Save as place" shows after a hit in a saved world only (`savePlace` non-null) and saves that hit's pose. `set` writes
 * only what changed and calls no dep. Text only through `textContent`; no browser dialog.
 */
import { CAVE_BIOME, CAVE_KIND, HEIGHT, MIN_Y } from '../../core/constants';
import { XRAY_BIOME_COLORS, XRAY_BIOME_LABELS, XRAY_COLORS, XRAY_LABELS } from '../../render/xrayPalette';
import { FIND_BIOME_RADIUS, FIND_BUDGET_MS, FIND_RADIUS } from '../../workers/protocol';
import { el } from '../common/dom';
import { bandSet, stripText, XRAY_ALL, type XrayBand } from '../world/xrayStrip';

/** The field "Cave slice" opens (SP6b spec §9.3): `caves` by cave type, `biome3d` by cave biome. */
export type CaveSliceField = 'caves' | 'biome3d';

export interface CavesTabDeps {
  /** The checkbox changed: the X-ray on or off (the page's X). */
  onXray(on: boolean): void;
  /** A "Colour by" radio was chosen: the page's colour mode, 0 by cave type, 1 by cave biome (the page's C). */
  onColorMode(mode: 0 | 1): void;
  /** A slider moved or All depths was pressed: the page's band (its renderer and strip). */
  onBand(b: XrayBand): void;
  /** "Cave slice": the Density tab's horizontal slice of `field` at world y `y`, centred on the camera. */
  openSlice(y: number, field: CaveSliceField): void;
  /** "Show cave biomes on the map": the map's caveBiome layer at world y `y` (SP6b spec §9.3). */
  showCaveBiomes(y: number): void;
  /** "Cave parameters": the Parameters tab at `CAVE_PARAMETERS_LEAF`. */
  revealParameters(): void;
  /** "Cave biome parameters": the Parameters tab at `CAVE_BIOME_PARAMETERS_LEAF` (SP6b spec §9.3). */
  revealBiomeParameters(): void;
  /** The biome legend's row under the pointer: the map's cave-biome highlight (a `CAVE_BIOME` id; null ends it; P51). */
  highlightCaveBiome(id: number | null): void;
  /**
   * "Nearest <kind>" (SP6a spec §7.3), or with `biome` (kind 0) "Nearest lush cave" and the other cave biomes' (SP6b spec
   * §9.3): the search from the camera, which moves the camera into the hit in flight; its hit (null unless `reason` is
   * `found`) and why it ended. Rejected when cancelled (`cancelFind`).
   */
  find(kind: number, biome?: number): Promise<FindOutcome>;
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
  /**
   * The page's X-ray state: on or off, its band, its radius in blocks and its colour mode (0 by cave type, 1 by cave
   * biome); writes only what changed and calls no dep, but for a cave-biome highlight held when the mode goes back to
   * cave type, which it ends (`highlightCaveBiome(null)`: its legend hides, so no pointerleave comes).
   */
  set(on: boolean, band: XrayBand, radius: number, mode: 0 | 1): void;
  /**
   * Cancels the search in flight, if any (the tab closed, another tab shown or the map hidden), and ends a cave-biome
   * highlight held (its legend leaves the screen, so no pointerleave comes).
   */
  cancel(): void;
  /** Cancels the search in flight, ends a held highlight and removes the tab's DOM. */
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

/** A camera position (the search's start). */
type From = { readonly x: number; readonly y: number; readonly z: number };

/**
 * A search's result line, its target named `label` at a sentence's start and `word` inside one: "<Label> at x, y, z ·
 * d blocks away" (d the distance from `from` to the hit voxel's centre, rounded), "No <word> found within <radius>
 * blocks", "No <word> found in 2 s", or "<Label> search stopped".
 */
function outcomeText(label: string, word: string, radius: number, r: FindOutcome, from: From): string {
  if (r.hit !== null) {
    const h = r.hit;
    const d = Math.round(Math.hypot(h.x + 0.5 - from.x, h.y + 0.5 - from.y, h.z + 0.5 - from.z));
    return `${label} at ${h.x}, ${h.y}, ${h.z} · ${d} blocks away`;
  }
  if (r.reason === 'radius') return `No ${word} found within ${radius} blocks`;
  if (r.reason === 'budget') return `No ${word} found in ${FIND_BUDGET_MS / 1000} s`;
  return `${label} search stopped`;
}

/**
 * The result line of a search of `kind` from the camera at `from`: "<Kind> at x, y, z · d blocks away" (d the distance
 * from `from` to the hit voxel's centre, rounded), "No <kind> found within 512 blocks", "No <kind> found in 2 s", or
 * "<Kind> search stopped".
 */
export function findText(kind: number, r: FindOutcome, from: From): string {
  return outcomeText(XRAY_LABELS[kind] ?? '', kindWord(kind), FIND_RADIUS, r, from);
}

/** The cave biomes with a Find button (SP6b spec §9.3, D11), in id order: lush, dripstone, abyss. */
export const FIND_BIOMES: readonly number[] = [CAVE_BIOME.lush, CAVE_BIOME.dripstone, CAVE_BIOME.abyss];
/** A cave biome's name at a sentence's start in the biome Find row, by id ('' for plain, which has no button). */
const FIND_BIOME_LABELS: readonly string[] = ['', 'Lush cave', 'Dripstone cave', 'Abyss'];
/** A cave biome's name inside a sentence: "lush cave", "dripstone cave", "abyss". */
const biomeWord = (biome: number): string => (FIND_BIOME_LABELS[biome] ?? '').toLowerCase();

/** A biome Find button's text: "Nearest lush cave", "Nearest dripstone cave", "Nearest abyss". */
export const findBiomeButtonText = (biome: number): string => `Nearest ${biomeWord(biome)}`;

/**
 * The result line of a search of cave biome `biome` from the camera at `from` (SP6b spec §9.3): "Lush cave at x, y, z ·
 * d blocks away", "No lush cave found within 1024 blocks", "No lush cave found in 2 s", or "Lush cave search stopped".
 */
export function findBiomeText(biome: number, r: FindOutcome, from: From): string {
  return outcomeText(FIND_BIOME_LABELS[biome] ?? '', biomeWord(biome), FIND_BIOME_RADIUS, r, from);
}

/** The cave slice's width in blocks (SP6a spec §7.3): a 128² `caves` slice 256 blocks across (`slice.caves128`). */
export const CAVE_SLICE_EXTENT = 256;
/** The leaf "Cave parameters" reveals: the Caves section's first, which opens the section and its Cheese sub-section. */
export const CAVE_PARAMETERS_LEAF = 'caves.cheese.offset';
/** The leaf "Cave biome parameters" reveals (SP6b spec §9.3): it opens Caves › Cave biomes and its Lush sub-section. */
export const CAVE_BIOME_PARAMETERS_LEAF = 'caves.biomes.lush.hMin';

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

/** A legend's entries in index order: those with a label (the kinds 1-9 and 15; the biomes 0-3 and 15). */
const labelled = (labels: readonly string[]): readonly number[] => labels.flatMap((label, i) => (label === '' ? [] : [i]));
/** The cave biomes a biome legend row highlights on the map: 0-3 (the surface film's row highlights none). */
const HIGHLIGHT_BIOMES: readonly number[] = [CAVE_BIOME.plain, CAVE_BIOME.lush, CAVE_BIOME.dripstone, CAVE_BIOME.abyss];

/** A legend: a swatch and a label per labelled entry, in the X-ray's colours; `row` sees each row and its entry. */
function legendOf(id: string, colors: readonly string[], labels: readonly string[], row?: (key: HTMLElement, i: number) => void): HTMLElement {
  const legend = el('div', 'caves-legend');
  legend.id = id;
  for (const i of labelled(labels)) {
    const key = el('span', 'world-xray-key');
    const swatch = el('span', 'world-xray-swatch');
    swatch.style.background = colors[i]!;
    key.append(swatch, el('span', '', labels[i]!));
    row?.(key, i);
    legend.append(key);
  }
  return legend;
}

export function createCavesTab(host: HTMLElement, deps: CavesTabDeps): CavesTab {
  const root = el('div', 'caves-tab');
  const xrayLabel = el('label', 'caves-xray');
  const xrayBox = el('input');
  xrayBox.type = 'checkbox';
  xrayBox.id = 'map-caves-xray';
  xrayBox.checked = false;
  xrayLabel.append(xrayBox, 'X-ray (X)');
  // Colour by (SP6b spec §9.3): one radio group, Cave type (0) checked at the mount (a page starts by cave type).
  const colour = el('div', 'caves-colour');
  colour.id = 'map-caves-color';
  const radio = (id: string, label: string, mode: 0 | 1): HTMLInputElement => {
    const row = el('label', 'caves-colour-choice');
    const input = el('input');
    input.type = 'radio';
    input.name = 'map-caves-color';
    input.id = id;
    input.value = String(mode);
    input.checked = mode === 0;
    row.append(input, label);
    colour.append(row);
    return input;
  };
  colour.append(el('span', 'caves-colour-title', 'Colour by'));
  const typeRadio = radio('map-caves-color-type', 'Cave type', 0);
  const biomeRadio = radio('map-caves-color-biome', 'Cave biome', 1);
  const bandLine = el('div', 'caves-band', stripText(XRAY_ALL, 0));
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
  const legend = legendOf('map-caves-legend', XRAY_COLORS, XRAY_LABELS);
  // The biomes' legend (hidden by cave type): a row of a cave biome highlights it on the map while under the pointer.
  let highlighted: number | null = null;
  const highlight = (id: number | null): void => {
    highlighted = id;
    deps.highlightCaveBiome(id);
  };
  const unhighlight = (): void => { if (highlighted !== null) highlight(null); };
  const biomeLegend = legendOf('map-caves-biome-legend', XRAY_BIOME_COLORS, XRAY_BIOME_LABELS, (key, i) => {
    // The surface film's row is no cave biome: entering it ends the highlight a biome's row left.
    key.addEventListener('pointerenter', HIGHLIGHT_BIOMES.includes(i) ? () => highlight(i) : unhighlight);
  });
  biomeLegend.hidden = true;
  biomeLegend.addEventListener('pointerleave', unhighlight);
  const radiusOut = el('div', 'caves-radius');
  radiusOut.id = 'map-caves-radius';
  const sliceButton = button('map-caves-slice', 'Cave slice');
  sliceButton.title = `The Density tab's horizontal cave slice, by type or biome, at the band's middle y, ${CAVE_SLICE_EXTENT} blocks across, centred on you`;
  const mapButton = button('map-caves-show-map', 'Show cave biomes on the map');
  mapButton.title = 'The map\'s cave biome layer at the band\'s middle y';
  const paramsButton = button('map-caves-params', 'Cave parameters');
  paramsButton.title = 'Parameters › Caves';
  const biomeParamsButton = button('map-caves-biome-params', 'Cave biome parameters');
  biomeParamsButton.title = 'Parameters › Caves › Cave biomes';
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
  // The biome Find row (SP6b spec §9.3): a button per cave biome, before the shared result line and "Save as place".
  const biomeRow = el('div', 'caves-find-biomes');
  biomeRow.id = 'map-caves-find-biomes';
  const biomeButtons = new Map<number, HTMLButtonElement>();
  for (const biome of FIND_BIOMES) {
    const b = button(`map-caves-find-biome-${biome}`, findBiomeButtonText(biome));
    biomeButtons.set(biome, b);
    biomeRow.append(b);
  }
  findRow.append(biomeRow);
  const resultLine = el('div', 'caves-find-result');
  resultLine.id = 'map-caves-find-result';
  const saveButton = button('map-caves-save-place', 'Save as place');
  saveButton.hidden = true;
  findRow.append(resultLine, saveButton);
  root.append(
    xrayLabel, colour, bandLine, low.row, high.row, allButton, legend, biomeLegend, radiusOut, sliceButton, mapButton, paramsButton,
    biomeParamsButton, findRow,
  );
  host.append(root);

  // The state as shown: the checkbox, the colour mode (the radios, the legends), the band (the sliders and the line) and
  // the radius (NaN: none written yet).
  let on = false;
  let mode: 0 | 1 = 0;
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
    if (changed) bandLine.textContent = stripText(b, mode);
  };

  xrayBox.addEventListener('change', () => deps.onXray(xrayBox.checked));
  typeRadio.addEventListener('change', () => { if (typeRadio.checked) deps.onColorMode(0); });
  biomeRadio.addEventListener('change', () => { if (biomeRadio.checked) deps.onColorMode(1); });
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
  sliceButton.addEventListener('click', () => deps.openSlice(caveSliceY(band, deps.camera().y), mode === 1 ? 'biome3d' : 'caves'));
  mapButton.addEventListener('click', () => deps.showCaveBiomes(caveSliceY(band, deps.camera().y)));
  paramsButton.addEventListener('click', () => deps.revealParameters());
  biomeParamsButton.addEventListener('click', () => deps.revealBiomeParameters());

  // The search in flight: its target (null: none) and its number, so a cancelled search's late outcome is dropped.
  let searching: Target | null = null;
  let search = 0;
  let lastHit: FindHit | null = null;
  const showHit = (hit: FindHit | null): void => {
    lastHit = hit;
    saveButton.hidden = hit === null || deps.savePlace === null;
  };
  /** Cancels the search in flight: the dep, then "<Label> search cancelled". */
  const cancel = (): void => {
    if (searching === null) return;
    const target = searching;
    searching = null;
    search++;
    deps.cancelFind();
    resultLine.textContent = `${target.label} search cancelled`;
  };
  /** The tab closes: the search in flight cancelled and a held highlight ended (P51: the legend drives it only shown). */
  const close = (): void => {
    cancel();
    unhighlight();
  };
  const start = (target: Target): void => {
    const c = deps.camera();
    const from = { x: c.x, y: c.y, z: c.z };
    const mine = ++search;
    searching = target;
    showHit(null);
    resultLine.textContent = `Searching for ${target.word}…`;
    target.find().then((r) => {
      if (mine !== search) return;
      searching = null;
      resultLine.textContent = target.text(r, from);
      showHit(r.hit);
    }, () => {
      if (mine !== search) return;
      searching = null;
      resultLine.textContent = `${target.label} search failed`;
    });
  };
  /** A Find button's press: a second press of the searching target's cancels it; any other cancels and searches its own. */
  const press = (target: Target): void => {
    const again = searching === target;
    cancel();
    if (!again) start(target);
  };
  for (const [kind, b] of findButtons) {
    const target: Target = {
      label: XRAY_LABELS[kind] ?? '', word: kindWord(kind), find: () => deps.find(kind), text: (r, from) => findText(kind, r, from),
    };
    b.addEventListener('click', () => press(target));
  }
  for (const [biome, b] of biomeButtons) {
    const target: Target = {
      label: FIND_BIOME_LABELS[biome] ?? '', word: biomeWord(biome), find: () => deps.find(0, biome), text: (r, from) => findBiomeText(biome, r, from),
    };
    b.addEventListener('click', () => press(target));
  }
  saveButton.addEventListener('click', () => {
    if (lastHit !== null && deps.savePlace !== null) deps.savePlace(lastHit);
  });

  return {
    set(nextOn, b, r, nextMode) {
      if (nextOn !== on) {
        on = nextOn;
        xrayBox.checked = on;
      }
      // The radios are put back too when a choice the page did not take left them apart from its mode.
      if (typeRadio.checked !== (nextMode === 0) || biomeRadio.checked !== (nextMode === 1)) {
        typeRadio.checked = nextMode === 0;
        biomeRadio.checked = nextMode === 1;
      }
      if (nextMode !== mode) {
        mode = nextMode;
        legend.hidden = mode === 1;
        biomeLegend.hidden = mode === 0;
        bandLine.textContent = stripText(band, mode);
        if (mode === 0) unhighlight();
      }
      if (b.all !== band.all || b.yMin !== band.yMin || b.yMax !== band.yMax || lowAt !== b.yMin || highAt !== b.yMax) showBand(b);
      if (r !== radius) {
        radius = r;
        radiusOut.textContent = radiusText(r);
      }
    },
    cancel: close,
    dispose() {
      close();
      root.remove();
    },
  };
}

/** A Find button's target (a kind or a cave biome): its names, its search and its result line. */
interface Target {
  readonly label: string;
  readonly word: string;
  find(): Promise<FindOutcome>;
  text(r: FindOutcome, from: From): string;
}

/** A tab button: `type="button"`, with its id. */
function button(id: string, text: string): HTMLButtonElement {
  const b = el('button', 'caves-button', text);
  b.type = 'button';
  b.id = id;
  return b;
}

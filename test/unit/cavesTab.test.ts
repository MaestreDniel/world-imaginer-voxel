/**
 * The world map's Caves tab (SP6a spec §7.3, D12; Review Focus 3; ruling P24), on the DOM shim: the X-ray checkbox that
 * mirrors X both ways, the Lowest y and Highest y sliders (lowest ≤ highest kept by moving the other), All depths, the
 * legend, the radius readout, "Cave slice" (at the band's middle y, the camera's y at all) and "Cave parameters" (the
 * Caves section's first leaf, `caves.cheese.offset`, since `reveal` takes a leaf path); the Find row (SP6a Task 44, D12,
 * D16): a button per kind 1-8, the result lines, the cancel on a second press and on closing, "Save as place" only in a
 * saved world. SP6b's additions (SP6b spec §9.3, D11; rulings P51, P53): "Colour by" in step with C both ways, the band
 * line and the legend following the mode, "Cave slice" opening `caves` or `biome3d` by the mode, "Show cave biomes on
 * the map" at `caveSliceY`, "Cave biome parameters" (`caves.biomes.lush.hMin`) and the biome legend's rows driving the
 * map's cave-biome highlight; the second Find row (SP6b spec §9.3, D11; Task 48): "Nearest lush cave", "Nearest dripstone
 * cave", "Nearest abyss", with the kinds' result line, cancel rules and "Save as place".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAVE_BIOME, CAVE_FILM_KIND, CAVE_KIND } from '../../src/core/constants';
import { XRAY_BIOME_COLORS, XRAY_BIOME_LABELS, XRAY_COLORS, XRAY_LABELS } from '../../src/render/xrayPalette';
import {
  CAVE_BIOME_PARAMETERS_LEAF, CAVE_PARAMETERS_LEAF, CAVE_SLICE_EXTENT, caveSliceY, createCavesTab, FIND_BIOMES, FIND_KINDS, findBiomeButtonText,
  findBiomeText, findButtonText, findText,
  radiusText, sliderBand, type CaveSliceField, type CavesTabDeps, type FindHit, type FindOutcome,
} from '../../src/ui/map/cavesTab';
import { panelTree, type SectionSpec } from '../../src/ui/paramPanel/model';
import { createPageXray, pageKeyName } from '../../src/ui/world/worldPage';
import { bandSet, createXrayStrip, stripText, XRAY_ALL, type XrayBand } from '../../src/ui/world/xrayStrip';
import { FakeElement, installDom } from './fixtures/domShim';

let dom: ReturnType<typeof installDom>;
beforeEach(() => { dom = installDom(); });
afterEach(() => { vi.unstubAllGlobals(); });

/** A search the test settles: `find`'s promise and its two ends. */
interface Search {
  readonly kind: number;
  resolve(r: FindOutcome): void;
  reject(e: Error): void;
}

/**
 * The tab over recording deps, the camera at `camera`; `$` finds a control by id. Each `find` is a search the test
 * settles (`searches`); `saved` gives the tab a `savePlace` (a saved world), which records its hits.
 */
function mount(camera = { x: 100.5, y: 80.9, z: -40.5 }, saved = false) {
  const calls: string[] = [];
  const bands: XrayBand[] = [];
  const slices: number[] = [];
  const fields: CaveSliceField[] = [];
  const mapYs: number[] = [];
  const highlights: (number | null)[] = [];
  const searches: Search[] = [];
  const savedHits: FindHit[] = [];
  const deps: CavesTabDeps = {
    onXray: (on) => { calls.push(`xray ${on}`); },
    onColorMode: (mode) => { calls.push(`mode ${mode}`); },
    onBand: (b) => { bands.push(b); },
    openSlice: (y, field) => { slices.push(y); fields.push(field); },
    showCaveBiomes: (y) => { mapYs.push(y); },
    revealParameters: () => { calls.push('reveal'); },
    revealBiomeParameters: () => { calls.push('reveal biomes'); },
    highlightCaveBiome: (id) => { highlights.push(id); },
    find: (kind, biome) => {
      calls.push(biome === undefined ? `find ${kind}` : `find ${kind} biome ${biome}`);
      return new Promise<FindOutcome>((resolve, reject) => { searches.push({ kind, resolve, reject }); });
    },
    cancelFind: () => {
      calls.push('cancel');
      // The page's cancel rejects the search's promise.
      searches.at(-1)?.reject(new Error('job cancelled'));
    },
    savePlace: saved ? (hit) => { savedHits.push(hit); } : null,
    camera: () => camera,
  };
  const host = dom.document.createElement('div');
  dom.body.append(host);
  const tab = createCavesTab(host as unknown as HTMLElement, deps);
  const $ = (id: string): FakeElement => dom.el(id);
  return { tab, deps, calls, bands, slices, fields, mapYs, highlights, camera, host, searches, savedHits, $ };
}

/** Lets the tab's promise handlers run. */
const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/** Moves a slider to `v` as the browser does on a drag: its value, then 'input'. */
const slide = (e: FakeElement, v: number): void => {
  e.value = String(v);
  e.dispatchEvent(new Event('input'));
};
const tick = (e: FakeElement, on: boolean): void => {
  (e as unknown as { checked: boolean }).checked = on;
  e.dispatchEvent(new Event('change'));
};
const checked = (e: FakeElement): boolean => (e as unknown as { checked: boolean }).checked;

describe('the band rules (SP6a spec §7.3; Review Focus 3)', () => {
  test('sliderBand keeps lowest ≤ highest by moving the other slider; every band is whole blocks inside −64 … 319', () => {
    expect(sliderBand('low', 200, 100)).toEqual(bandSet(200, 200));
    expect(sliderBand('high', 200, 100)).toEqual(bandSet(100, 100));
    expect(sliderBand('low', 10, 40)).toEqual(bandSet(10, 40));
    expect(sliderBand('high', -64, 319)).toEqual(bandSet(-64, 319));
    expect(sliderBand('low', 319, -64)).toEqual(bandSet(319, 319));
    expect(sliderBand('high', 319, -64)).toEqual(bandSet(-64, -64));
  });

  test('the cave slice\'s y: ⌊(yMin + yMax) / 2⌋ of a band; the camera\'s ⌊y⌋ at all, kept inside −64 … 319', () => {
    expect(caveSliceY(bandSet(100, 315), 0)).toBe(207);
    expect(caveSliceY(bandSet(-64, -33), 0)).toBe(-49);
    expect(caveSliceY(bandSet(7, 7), 0)).toBe(7);
    expect(caveSliceY(XRAY_ALL, 80.9)).toBe(80);
    expect(caveSliceY(XRAY_ALL, -20.5)).toBe(-21);
    expect(caveSliceY(XRAY_ALL, 400)).toBe(319);
    expect(caveSliceY(XRAY_ALL, -100)).toBe(-64);
    expect(CAVE_SLICE_EXTENT).toBe(256);
  });

  test('"Cave parameters" reveals `caves.cheese.offset`, the Caves section\'s first leaf in the Parameters panel (reveal takes a leaf path)', () => {
    expect(CAVE_PARAMETERS_LEAF).toBe('caves.cheese.offset');
    const caves = panelTree().sections.find((s) => s.path === 'caves');
    expect(caves).toBeDefined();
    // The panel lists a section's own controls, then its sub-sections: the first leaf it shows.
    const first = (s: SectionSpec): string | null => s.controls[0]?.path ?? s.sections.map(first).find((p) => p !== null) ?? null;
    expect(first(caves!)).toBe(CAVE_PARAMETERS_LEAF);
  });
});

describe('the Caves tab (SP6a spec §7.3, D12)', () => {
  test('its controls, in order: the X-ray (X) checkbox, Colour by, the band line, Lowest y and Highest y (−64 … 319, step 1), All depths, the two legends, the radius, Cave slice, Show cave biomes on the map, Cave parameters, Cave biome parameters (SP6b spec §9.3)', () => {
    const m = mount();
    const box = m.$('map-caves-xray');
    expect(box.type).toBe('checkbox');
    expect(box.parentElement!.textContent).toBe('X-ray (X)');
    for (const [id, label, v] of [['map-caves-low', 'Lowest y', '-64'], ['map-caves-high', 'Highest y', '319']] as const) {
      const s = m.$(id) as FakeElement & { min: string; max: string; step: string };
      expect([s.type, s.min, s.max, s.step, s.value], id).toEqual(['range', '-64', '319', '1', v]);
      expect(s.parentElement!.textContent, id).toBe(label);
    }
    expect(m.$('map-caves-band').textContent).toBe(stripText(XRAY_ALL, 0));
    expect(m.$('map-caves-all').textContent).toBe('All depths');
    expect(m.$('map-caves-slice').textContent).toBe('Cave slice');
    expect(m.$('map-caves-params').textContent).toBe('Cave parameters');
    expect(m.$('map-caves-show-map').textContent).toBe('Show cave biomes on the map');
    expect(m.$('map-caves-biome-params').textContent).toBe('Cave biome parameters');
    // Colour by: two radios of one group, Cave type checked at the mount (the page starts by cave type).
    const colour = m.$('map-caves-color');
    expect(colour.children[0]!.textContent).toBe('Colour by');
    for (const [id, label, value, on] of [['map-caves-color-type', 'Cave type', '0', true], ['map-caves-color-biome', 'Cave biome', '1', false]] as const) {
      const r = m.$(id) as FakeElement & { name: string };
      expect([r.type, r.name, r.value, checked(r)], id).toEqual(['radio', 'map-caves-color', value, on]);
      expect(r.parentElement!.textContent, id).toBe(label);
      expect(r.parentElement!.parentElement, id).toBe(colour);
    }
    // The legend: the nine cave kinds and the surface film, in the X-ray's colours.
    const legend = m.$('map-caves-legend');
    const kinds = [...Object.values(CAVE_KIND).filter((k) => k !== CAVE_KIND.none).sort((a, b) => a - b), CAVE_FILM_KIND];
    expect(kinds).toHaveLength(10);
    expect(legend.children.map((k) => k.textContent)).toEqual(kinds.map((k) => XRAY_LABELS[k]));
    expect(legend.children.map((k) => k.children[0]!.style['background'])).toEqual(kinds.map((k) => XRAY_COLORS[k]));
    expect(legend.hidden).toBe(false);
    // The biomes' legend, hidden by cave type: Plain cave, Lush, Dripstone, Abyss and the surface film.
    const biomeLegend = m.$('map-caves-biome-legend');
    const biomes = [CAVE_BIOME.plain, CAVE_BIOME.lush, CAVE_BIOME.dripstone, CAVE_BIOME.abyss, CAVE_FILM_KIND];
    expect(biomeLegend.children.map((k) => k.textContent)).toEqual(['Plain cave', 'Lush', 'Dripstone', 'Abyss', 'Surface']);
    expect(biomeLegend.children.map((k) => k.textContent)).toEqual(biomes.map((b) => XRAY_BIOME_LABELS[b]));
    expect(biomeLegend.children.map((k) => k.children[0]!.style['background'])).toEqual(biomes.map((b) => XRAY_BIOME_COLORS[b]));
    expect(biomeLegend.hidden).toBe(true);
    // The ids are in the tab's order.
    const order = [
      'map-caves-xray', 'map-caves-color', 'map-caves-band', 'map-caves-low', 'map-caves-high', 'map-caves-all', 'map-caves-legend',
      'map-caves-biome-legend', 'map-caves-radius', 'map-caves-slice', 'map-caves-show-map', 'map-caves-params', 'map-caves-biome-params',
    ];
    const ids: string[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (order.includes(c.id)) ids.push(c.id);
        walk(c);
      }
    };
    walk(m.host);
    const all = ids;
    expect(all).toEqual(order);
    m.tab.dispose();
    expect(m.host.children).toHaveLength(0);
  });

  test('setting Lowest y to 200 with Highest y 100 sets Highest y to 200; Highest y below Lowest y moves Lowest y; each change calls `onBand` once', () => {
    const m = mount();
    const low = m.$('map-caves-low');
    const high = m.$('map-caves-high');
    slide(high, 100);
    expect(m.bands).toEqual([bandSet(-64, 100)]);
    slide(low, 200);
    expect([low.value, high.value]).toEqual(['200', '200']);
    expect(m.bands.at(-1)).toEqual(bandSet(200, 200));
    slide(high, 150);
    expect([low.value, high.value]).toEqual(['150', '150']);
    expect(m.bands.at(-1)).toEqual(bandSet(150, 150));
    slide(low, -10);
    expect([low.value, high.value]).toEqual(['-10', '150']);
    expect(m.bands).toEqual([bandSet(-64, 100), bandSet(200, 200), bandSet(150, 150), bandSet(-10, 150)]);
    expect(m.$('map-caves-band').textContent).toBe('X-ray · y −10 … 150 · by cave type');
  });

  test('All depths gives `XRAY_ALL`; `set` with every depth puts the sliders at −64 and 319', () => {
    const m = mount();
    slide(m.$('map-caves-low'), 12);
    m.$('map-caves-all').click();
    expect(m.bands.at(-1)).toBe(XRAY_ALL);
    m.tab.set(false, XRAY_ALL, 176, 0);
    expect([m.$('map-caves-low').value, m.$('map-caves-high').value]).toEqual(['-64', '319']);
    expect(m.$('map-caves-band').textContent).toBe(stripText(XRAY_ALL, 0));
  });

  test('the radius readout follows `set`', () => {
    const m = mount();
    m.tab.set(false, XRAY_ALL, 176, 0);
    expect(m.$('map-caves-radius').textContent).toBe(radiusText(176));
    expect(radiusText(176)).toBe('Radius 176 blocks');
    m.tab.set(false, XRAY_ALL, 240, 0);
    expect(m.$('map-caves-radius').textContent).toBe('Radius 240 blocks');
  });

  test('Cave slice opens the Density tab at y = ⌊(yMin + yMax) / 2⌋, at the camera\'s y with the band at all', () => {
    const m = mount({ x: 0, y: 80.9, z: 0 });
    m.$('map-caves-slice').click();
    expect(m.slices).toEqual([80]);
    slide(m.$('map-caves-high'), -33);
    m.$('map-caves-slice').click();
    expect(m.slices).toEqual([80, -49]);
    // A band the page set (PageUp, PageDown) is the tab's too.
    m.tab.set(true, bandSet(100, 315), 176, 0);
    m.$('map-caves-slice').click();
    expect(m.slices).toEqual([80, -49, 207]);
    m.tab.set(true, XRAY_ALL, 176, 0);
    m.camera.y = -20.5;
    m.$('map-caves-slice').click();
    expect(m.slices).toEqual([80, -49, 207, -21]);
  });

  test('Cave parameters calls `revealParameters`', () => {
    const m = mount();
    m.$('map-caves-params').click();
    expect(m.calls).toEqual(['reveal']);
  });

  test('`set` writes only what changed and calls no dep (the page pushes its state; the tab never echoes it back)', () => {
    const m = mount();
    const box = m.$('map-caves-xray');
    const band = m.$('map-caves-band');
    m.tab.set(true, bandSet(10, 41), 176, 0);
    expect([checked(box), m.$('map-caves-low').value, m.$('map-caves-high').value, band.textContent]).toEqual([true, '10', '41', 'X-ray · y 10 … 41 · by cave type']);
    const line = band.childNodes[0];
    m.tab.set(true, bandSet(10, 41), 176, 0);
    expect(band.childNodes[0]).toBe(line);
    // The colour mode too: the radios, the legends and the line follow it, and no dep is called.
    m.tab.set(true, bandSet(10, 41), 176, 1);
    m.tab.set(true, bandSet(10, 41), 176, 1);
    expect(band.textContent).toBe('X-ray · y 10 … 41 · by cave biome');
    expect([m.calls, m.bands, m.slices, m.highlights]).toEqual([[], [], [], []]);
  });
});

describe('Colour by and the links that follow it (SP6b spec §9.3, D11; rulings P51, P53)', () => {
  const legends = (m: ReturnType<typeof mount>): [boolean, boolean] => [m.$('map-caves-legend').hidden, m.$('map-caves-biome-legend').hidden];

  test('the radios, the band line and the legend follow `set`\'s colour mode: by cave biome checks Cave biome, writes "· by cave biome" and shows the biomes\' legend; back by cave type, the kinds\'', () => {
    const m = mount();
    const type = m.$('map-caves-color-type');
    const biome = m.$('map-caves-color-biome');
    m.tab.set(false, bandSet(10, 41), 176, 1);
    expect([checked(type), checked(biome)]).toEqual([false, true]);
    expect(m.$('map-caves-band').textContent).toBe(stripText(bandSet(10, 41), 1));
    expect(legends(m)).toEqual([true, false]);
    // The band line follows a band change in the biome mode too.
    m.tab.set(false, bandSet(-64, -33), 176, 1);
    expect(m.$('map-caves-band').textContent).toBe('X-ray · y −64 … −33 · by cave biome');
    m.tab.set(false, bandSet(-64, -33), 176, 0);
    expect([checked(type), checked(biome)]).toEqual([true, false]);
    expect(m.$('map-caves-band').textContent).toBe('X-ray · y −64 … −33 · by cave type');
    expect(legends(m)).toEqual([false, true]);
    expect(m.calls).toEqual([]);
  });

  test('choosing a radio calls `onColorMode` with its mode; the tab waits for the page\'s `set` (the checkbox\'s rule)', () => {
    const m = mount();
    tick(m.$('map-caves-color-biome'), true);
    expect(m.calls).toEqual(['mode 1']);
    expect(legends(m)).toEqual([false, true]);
    m.tab.set(false, XRAY_ALL, 176, 1);
    expect(legends(m)).toEqual([true, false]);
    tick(m.$('map-caves-color-type'), true);
    expect(m.calls).toEqual(['mode 1', 'mode 0']);
  });

  test('"Cave slice" opens the `caves` field by cave type and the `biome3d` field by cave biome, at `caveSliceY`', () => {
    const m = mount({ x: 0, y: 80.9, z: 0 });
    m.$('map-caves-slice').click();
    m.tab.set(false, XRAY_ALL, 176, 1);
    m.$('map-caves-slice').click();
    m.tab.set(false, bandSet(100, 315), 176, 1);
    m.$('map-caves-slice').click();
    m.tab.set(false, bandSet(100, 315), 176, 0);
    m.$('map-caves-slice').click();
    expect(m.slices).toEqual([80, 80, 207, 207]);
    expect(m.fields).toEqual(['caves', 'biome3d', 'biome3d', 'caves']);
  });

  test('ruling P53: "Show cave biomes on the map" shows the caveBiome layer at `caveSliceY`, unrounded: the band\'s middle y, or the camera\'s y with the band at all', () => {
    const m = mount({ x: 0, y: 80.9, z: 0 });
    m.$('map-caves-show-map').click();
    // A band whose middle y is no multiple of 4: ⌊(10 + 41) / 2⌋ = 25.
    m.tab.set(false, bandSet(10, 41), 176, 0);
    m.$('map-caves-show-map').click();
    m.tab.set(false, XRAY_ALL, 176, 1);
    m.camera.y = -20.5;
    m.$('map-caves-show-map').click();
    expect(m.mapYs).toEqual([80, 25, -21]);
    expect(m.mapYs).toEqual([caveSliceY(XRAY_ALL, 80.9), caveSliceY(bandSet(10, 41), 0), caveSliceY(XRAY_ALL, -20.5)]);
    expect([m.calls, m.slices]).toEqual([[], []]);
  });

  test('"Cave biome parameters" calls `revealBiomeParameters`; its leaf `caves.biomes.lush.hMin` is a control of the panel\'s Caves › Cave biomes section (reveal takes a leaf path)', () => {
    const m = mount();
    m.$('map-caves-biome-params').click();
    expect(m.calls).toEqual(['reveal biomes']);
    expect(CAVE_BIOME_PARAMETERS_LEAF).toBe('caves.biomes.lush.hMin');
    const caves = panelTree().sections.find((s) => s.path === 'caves')!;
    const biomes = caves.sections.find((s) => s.path === 'caves.biomes');
    expect(biomes).toBeDefined();
    const paths = (s: SectionSpec): string[] => [...s.controls.map((c) => c.path), ...s.sections.flatMap(paths)];
    expect(paths(biomes!)).toContain(CAVE_BIOME_PARAMETERS_LEAF);
  });

  test('ruling P51: the biome legend\'s rows drive the map\'s cave-biome highlight (Plain cave, Lush, Dripstone, Abyss: their ids; the surface film\'s row ends it); leaving the legend ends it', () => {
    const m = mount();
    m.tab.set(false, XRAY_ALL, 176, 1);
    const legend = m.$('map-caves-biome-legend');
    for (const r of legend.children) r.dispatchEvent(new Event('pointerenter'));
    expect(m.highlights).toEqual([CAVE_BIOME.plain, CAVE_BIOME.lush, CAVE_BIOME.dripstone, CAVE_BIOME.abyss, null]);
    // Nothing held: leaving the legend calls nothing; held, it ends the highlight.
    legend.dispatchEvent(new Event('pointerleave'));
    expect(m.highlights).toHaveLength(5);
    legend.children[2]!.dispatchEvent(new Event('pointerenter'));
    legend.dispatchEvent(new Event('pointerleave'));
    expect(m.highlights.slice(5)).toEqual([CAVE_BIOME.dripstone, null]);
    // The kinds' legend drives nothing.
    for (const r of m.$('map-caves-legend').children) r.dispatchEvent(new Event('pointerenter'));
    expect(m.highlights).toHaveLength(7);
  });

  test('a highlight held when the mode goes back to cave type ends with the biomes\' legend (its rows are hidden; no pointerleave comes)', () => {
    const m = mount();
    m.tab.set(false, XRAY_ALL, 176, 1);
    m.$('map-caves-biome-legend').children[1]!.dispatchEvent(new Event('pointerenter'));
    m.tab.set(false, XRAY_ALL, 176, 0);
    expect(m.highlights).toEqual([CAVE_BIOME.lush, null]);
    // None held: the switch calls nothing.
    m.tab.set(false, XRAY_ALL, 176, 1);
    m.tab.set(false, XRAY_ALL, 176, 0);
    expect(m.highlights).toEqual([CAVE_BIOME.lush, null]);
  });

  test('a highlight held when the tab closes (`cancel`: another tab shown, the panel or the map hidden) or is disposed ends there; none held, neither calls the dep', () => {
    const m = mount();
    m.tab.set(false, XRAY_ALL, 176, 1);
    m.tab.cancel();
    expect(m.highlights).toEqual([]);
    m.$('map-caves-biome-legend').children[3]!.dispatchEvent(new Event('pointerenter'));
    m.tab.cancel();
    m.tab.cancel();
    expect(m.highlights).toEqual([CAVE_BIOME.abyss, null]);
    m.$('map-caves-biome-legend').children[0]!.dispatchEvent(new Event('pointerenter'));
    m.tab.dispose();
    expect(m.highlights).toEqual([CAVE_BIOME.abyss, null, CAVE_BIOME.plain, null]);
    expect(m.calls).toEqual([]);
  });
});

describe('`set` on an X toggle (SP6a spec §5.3: a toggle allocates nothing; Task 52, minors-11)', () => {
  /** Counts the reads and writes of an input's `value` (the DOM string the tab would compare and build). */
  function spyValue(e: FakeElement): { reads: number; writes: number } {
    const d = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!;
    const n = { reads: 0, writes: 0 };
    Object.defineProperty(e, 'value', {
      configurable: true,
      get() { n.reads++; return d.get!.call(e); },
      set(v: string) { n.writes++; d.set!.call(e, v); },
    });
    return n;
  }

  test('with the band and the radius unchanged, `set` reads and writes no slider value: an X toggle, on or off, compares numbers only', () => {
    const m = mount();
    m.tab.set(false, bandSet(10, 41), 176, 0);
    const low = spyValue(m.$('map-caves-low'));
    const high = spyValue(m.$('map-caves-high'));
    for (const on of [true, false, true, false]) m.tab.set(on, bandSet(10, 41), 176, 0);
    expect([low, high]).toEqual([{ reads: 0, writes: 0 }, { reads: 0, writes: 0 }]);
    expect(checked(m.$('map-caves-xray'))).toBe(false);
    // A changed band writes both sliders.
    m.tab.set(false, bandSet(12, 41), 176, 0);
    expect([low.writes, high.writes, m.$('map-caves-low').value]).toEqual([1, 1, '12']);
  });

  test('a slider left where the band is not (a value the tab does not take) is put back by the next `set`, as before', () => {
    const m = mount();
    m.tab.set(true, bandSet(10, 41), 176, 0);
    slide(m.$('map-caves-low'), 10.5);
    expect(m.bands).toEqual([]);
    m.tab.set(false, bandSet(10, 41), 176, 0);
    expect([m.$('map-caves-low').value, m.$('map-caves-high').value]).toEqual(['10', '41']);
    // Moved by the user, the sliders are the band's: the page's echo of it writes nothing.
    slide(m.$('map-caves-high'), 60);
    expect(m.bands).toEqual([bandSet(10, 60)]);
    const low = spyValue(m.$('map-caves-low'));
    m.tab.set(true, bandSet(10, 60), 176, 0);
    expect(low).toEqual({ reads: 0, writes: 0 });
  });
});

describe('the Caves tab over the page\'s X-ray (SP6a spec §7.3; worldPage.ts wires the same)', () => {
  /**
   * The page's X-ray, its strip and the tab, wired as the page wires them (worldPage.ts): the X-ray's `changed` hook pushes
   * its state into the tab, the tab's `onXray`, `onColorMode` and `onBand` change the X-ray only (Task 52, minors-12: no
   * push by hand, so a page whose hook stopped pushing fails here). The first push stands for the mount, which reads the
   * state itself.
   */
  function wired(cameraY = 80.5) {
    const calls: string[] = [];
    const strip = createXrayStrip(dom.body as unknown as HTMLElement);
    const host = dom.document.createElement('div');
    dom.body.append(host);
    let tab: ReturnType<typeof createCavesTab> | null = null;
    const radius = 176;
    const push = (): void => tab?.set(xray.on, xray.band, radius, xray.mode);
    const xray = createPageXray({
      renderer: {
        setXray: (on) => { calls.push(`setXray ${on}`); }, setXrayBand: (a, b) => { calls.push(`band ${a} ${b}`); }, setXrayColorMode: () => {},
      },
      strip,
      notices: { show: () => {} },
      cameraY: () => cameraY,
      keyName: pageKeyName,
      changed: push,
    });
    tab = createCavesTab(host as unknown as HTMLElement, {
      onXray: (on) => { if (on !== xray.on) xray.action('xray'); },
      onColorMode: (mode) => { if (mode !== xray.mode) xray.action('xrayColor'); },
      onBand: (b) => xray.setBand(b),
      openSlice: () => {},
      showCaveBiomes: () => {},
      revealParameters: () => {},
      revealBiomeParameters: () => {},
      highlightCaveBiome: () => {},
      find: () => new Promise<FindOutcome>(() => {}),
      cancelFind: () => {},
      savePlace: null,
      camera: () => ({ x: 0, y: cameraY, z: 0 }),
    });
    push();
    const key = (a: 'xray' | 'xrayDown' | 'xrayUp' | 'xrayAll' | 'xrayColor'): void => xray.action(a);
    return { xray, calls, key, $: (id: string) => dom.el(id), stripLine: () => dom.el('world-xray-strip').children[0]!.textContent };
  }

  test('a slider change calls `onBand` and the page\'s strip follows; All depths returns the strip to every depth', () => {
    const w = wired();
    w.key('xray');
    slide(w.$('map-caves-high'), 100);
    expect(w.calls.at(-1)).toBe('band -64 100');
    expect(w.stripLine()).toBe('X-ray · y −64 … 100 · by cave type');
    slide(w.$('map-caves-low'), 200);
    expect(w.xray.band).toEqual(bandSet(200, 200));
    expect(w.stripLine()).toBe('X-ray · y 200 … 200 · by cave type');
    w.$('map-caves-all').click();
    expect(w.xray.band).toBe(XRAY_ALL);
    expect(w.stripLine()).toBe(stripText(XRAY_ALL, 0));
  });

  test('the checkbox mirrors X both ways', () => {
    const w = wired();
    const box = w.$('map-caves-xray');
    expect(checked(box)).toBe(false);
    w.key('xray');
    expect([w.xray.on, checked(box)]).toEqual([true, true]);
    tick(box, false);
    expect([w.xray.on, checked(box)]).toEqual([false, false]);
    expect(w.calls).toEqual(['setXray true', 'setXray false']);
    tick(box, true);
    expect([w.xray.on, checked(box)]).toEqual([true, true]);
    w.key('xray');
    expect([w.xray.on, checked(box)]).toEqual([false, false]);
  });

  test('Colour by is in step with C both ways (SP6b spec §9.3): C checks Cave biome and switches the tab\'s line and legend; the Cave type radio sets the page\'s mode back, the strip following', () => {
    const w = wired();
    const type = w.$('map-caves-color-type');
    const biome = w.$('map-caves-color-biome');
    w.key('xray');
    w.key('xrayColor');
    expect([w.xray.mode, checked(type), checked(biome)]).toEqual([1, false, true]);
    expect(w.$('map-caves-band').textContent).toBe('X-ray · y −64 … 319 · by cave biome');
    expect([w.$('map-caves-legend').hidden, w.$('map-caves-biome-legend').hidden]).toEqual([true, false]);
    expect(w.stripLine()).toBe('X-ray · y −64 … 319 · by cave biome');
    tick(type, true);
    expect([w.xray.mode, checked(type), checked(biome)]).toEqual([0, true, false]);
    expect(w.stripLine()).toBe('X-ray · y −64 … 319 · by cave type');
    expect(w.$('map-caves-band').textContent).toBe('X-ray · y −64 … 319 · by cave type');
    // The page's mode already set: choosing it again presses no C.
    tick(type, true);
    expect(w.xray.mode).toBe(0);
    tick(biome, true);
    expect([w.xray.mode, checked(biome), w.$('map-caves-legend').hidden]).toEqual([1, true, true]);
    // C with the X-ray off still switches the tab (C acts with the X-ray off).
    w.key('xray');
    w.key('xrayColor');
    expect([w.xray.on, w.xray.mode, checked(type)]).toEqual([false, 0, true]);
  });

  test('worldPage.ts wires the radios as the checkbox: `onColorMode` presses C only when the mode differs', () => {
    const page = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(page).toContain("          onColorMode: (mode) => { if (mode !== pageXray.mode) pageXray.action('xrayColor'); },");
    expect(page).toContain("          onXray: (on) => { if (on !== pageXray.on) pageXray.action('xray'); },");
  });

  test('ruling P24: the slider band [100, 315] with PageUp gives [104, 319], with PageDown [92, 307]; the sliders follow the keys', () => {
    const w = wired();
    const low = w.$('map-caves-low');
    const high = w.$('map-caves-high');
    slide(low, 100);
    slide(high, 315);
    expect(w.xray.band).toEqual(bandSet(100, 315));
    w.key('xrayUp');
    expect([w.xray.band.yMin, w.xray.band.yMax]).toEqual([104, 319]);
    expect([low.value, high.value]).toEqual(['104', '319']);
    slide(low, 100);
    slide(high, 315);
    w.key('xrayDown');
    expect([w.xray.band.yMin, w.xray.band.yMax]).toEqual([92, 307]);
    expect([low.value, high.value]).toEqual(['92', '307']);
    // Home: every depth, the sliders at the ends.
    w.key('xrayAll');
    expect([low.value, high.value]).toEqual(['-64', '319']);
  });
});

describe('the Find row (SP6a spec §7.3, D12, D16; Task 44)', () => {
  const HIT: FindHit = { x: 120, y: 30, z: -52, yaw: 90 };

  test('one button per kind 1-8, "Nearest <kind>", in kind order; kind 9 has none (the default tree yields none)', () => {
    const t = mount();
    expect(FIND_KINDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(FIND_KINDS.map((k) => t.$(`map-caves-find-${k}`).textContent)).toEqual([
      'Nearest cheese', 'Nearest spaghetti 3D', 'Nearest spaghetti 2D', 'Nearest noodle', 'Nearest entrance', 'Nearest worm',
      'Nearest ravine', 'Nearest underground worm',
    ]);
    expect(FIND_KINDS.map(findButtonText)).toEqual(FIND_KINDS.map((k) => t.$(`map-caves-find-${k}`).textContent));
    expect(() => t.$(`map-caves-find-${CAVE_KIND.other}`)).toThrow();
    expect(t.$('map-caves-find-result').textContent).toBe('');
  });

  test('the three result lines: "<kind> at x, y, z · d blocks away", "No <kind> found within 512 blocks", "No <kind> found in 2 s"', () => {
    const from = { x: 100.5, y: 80.9, z: -40.5 };
    // d = |(120.5, 30.5, −51.5) − (100.5, 80.9, −40.5)| = √(400 + 2,540.16 + 121) = 55.33…
    expect(findText(CAVE_KIND.cheese, { hit: HIT, reason: 'found' }, from)).toBe('Cheese at 120, 30, -52 · 55 blocks away');
    expect(findText(CAVE_KIND.ravine, { hit: null, reason: 'radius' }, from)).toBe('No ravine found within 512 blocks');
    expect(findText(CAVE_KIND.spaghetti3d, { hit: null, reason: 'budget' }, from)).toBe('No spaghetti 3D found in 2 s');
    expect(findText(CAVE_KIND.undergroundWorm, { hit: null, reason: 'stopped' }, from)).toBe('Underground worm search stopped');
  });

  test('a press searches that kind from the camera; the outcome writes the result line', async () => {
    const t = mount();
    t.$('map-caves-find-1').click();
    expect(t.calls).toEqual(['find 1']);
    expect(t.$('map-caves-find-result').textContent).toBe('Searching for cheese…');
    t.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('Cheese at 120, 30, -52 · 55 blocks away');
    t.$('map-caves-find-7').click();
    t.searches[1]!.resolve({ hit: null, reason: 'radius' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('No ravine found within 512 blocks');
    t.$('map-caves-find-4').click();
    t.searches[2]!.resolve({ hit: null, reason: 'budget' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('No noodle found in 2 s');
    expect(t.calls).toEqual(['find 1', 'find 7', 'find 4']);
  });

  test('a second press of the searching button cancels it; its late outcome is dropped', async () => {
    const t = mount();
    t.$('map-caves-find-2').click();
    t.$('map-caves-find-2').click();
    expect(t.calls).toEqual(['find 2', 'cancel']);
    expect(t.$('map-caves-find-result').textContent).toBe('Spaghetti 3D search cancelled');
    await settle();
    t.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('Spaghetti 3D search cancelled');
    // Pressed again, it searches again.
    t.$('map-caves-find-2').click();
    expect(t.calls).toEqual(['find 2', 'cancel', 'find 2']);
  });

  test('another kind\'s button while searching cancels the search and starts that kind\'s', async () => {
    const t = mount();
    t.$('map-caves-find-1').click();
    t.$('map-caves-find-6').click();
    expect(t.calls).toEqual(['find 1', 'cancel', 'find 6']);
    expect(t.$('map-caves-find-result').textContent).toBe('Searching for worm…');
    t.searches[1]!.resolve({ hit: { x: 1, y: 2, z: 3, yaw: 0 }, reason: 'found' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toMatch(/^Worm at 1, 2, 3 · \d+ blocks away$/);
  });

  test('closing the tab (`cancel`, the tool\'s) and `dispose` cancel a search in flight; neither calls the dep with none', async () => {
    const t = mount();
    t.tab.cancel();
    expect(t.calls).toEqual([]);
    t.$('map-caves-find-5').click();
    t.tab.cancel();
    expect(t.calls).toEqual(['find 5', 'cancel']);
    expect(t.$('map-caves-find-result').textContent).toBe('Entrance search cancelled');
    t.tab.cancel();
    expect(t.calls).toEqual(['find 5', 'cancel']);
    t.$('map-caves-find-8').click();
    t.tab.dispose();
    expect(t.calls).toEqual(['find 5', 'cancel', 'find 8', 'cancel']);
    await settle();
  });

  test('a search that fails otherwise says so', async () => {
    const t = mount();
    t.$('map-caves-find-3').click();
    t.searches[0]!.reject(new Error('BAD_ARGS: kind'));
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('Spaghetti 2D search failed');
  });

  test('"Save as place" only in a saved world, after a hit: it saves that hit; a miss hides it again', async () => {
    const unsaved = mount();
    expect(unsaved.$('map-caves-save-place').hidden).toBe(true);
    unsaved.$('map-caves-find-1').click();
    unsaved.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    expect(unsaved.$('map-caves-save-place').hidden).toBe(true);
    unsaved.tab.dispose();

    const saved = mount(undefined, true);
    const save = saved.$('map-caves-save-place');
    expect(save.textContent).toBe('Save as place');
    expect(save.hidden).toBe(true);
    saved.$('map-caves-find-1').click();
    saved.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    expect(save.hidden).toBe(false);
    save.click();
    expect(saved.savedHits).toEqual([HIT]);
    saved.$('map-caves-find-7').click();
    expect(save.hidden).toBe(true);
    saved.searches[1]!.resolve({ hit: null, reason: 'radius' });
    await settle();
    expect(save.hidden).toBe(true);
  });
});

describe('the biome Find row (SP6b spec §9.3, D11; Task 48)', () => {
  const HIT: FindHit = { x: 120, y: 30, z: -52, yaw: 90 };

  test('three buttons, "Nearest lush cave", "Nearest dripstone cave", "Nearest abyss", after the kinds\' and before the shared result line', () => {
    const t = mount();
    expect(FIND_BIOMES).toEqual([CAVE_BIOME.lush, CAVE_BIOME.dripstone, CAVE_BIOME.abyss]);
    expect(FIND_BIOMES.map((b) => t.$(`map-caves-find-biome-${b}`).textContent)).toEqual(['Nearest lush cave', 'Nearest dripstone cave', 'Nearest abyss']);
    expect(FIND_BIOMES.map(findBiomeButtonText)).toEqual(['Nearest lush cave', 'Nearest dripstone cave', 'Nearest abyss']);
    expect(() => t.$(`map-caves-find-biome-${CAVE_BIOME.plain}`)).toThrow();
    const ids = t.$('map-caves-find').children.flatMap((c) => [c.id, ...c.children.map((d) => d.id)]).filter((id) => id !== '');
    expect(ids.indexOf('map-caves-find-8')).toBeLessThan(ids.indexOf('map-caves-find-biome-1'));
    expect(ids.indexOf('map-caves-find-biome-3')).toBeLessThan(ids.indexOf('map-caves-find-result'));
  });

  test('the result lines: "Lush cave at x, y, z · d blocks away", "No lush cave found within 1024 blocks", "No lush cave found in 2 s"', () => {
    const from = { x: 100.5, y: 80.9, z: -40.5 };
    expect(findBiomeText(CAVE_BIOME.lush, { hit: HIT, reason: 'found' }, from)).toBe('Lush cave at 120, 30, -52 · 55 blocks away');
    expect(findBiomeText(CAVE_BIOME.lush, { hit: null, reason: 'radius' }, from)).toBe('No lush cave found within 1024 blocks');
    expect(findBiomeText(CAVE_BIOME.lush, { hit: null, reason: 'budget' }, from)).toBe('No lush cave found in 2 s');
    expect(findBiomeText(CAVE_BIOME.dripstone, { hit: HIT, reason: 'found' }, from)).toBe('Dripstone cave at 120, 30, -52 · 55 blocks away');
    expect(findBiomeText(CAVE_BIOME.abyss, { hit: null, reason: 'radius' }, from)).toBe('No abyss found within 1024 blocks');
    expect(findBiomeText(CAVE_BIOME.abyss, { hit: null, reason: 'budget' }, from)).toBe('No abyss found in 2 s');
    expect(findBiomeText(CAVE_BIOME.dripstone, { hit: null, reason: 'stopped' }, from)).toBe('Dripstone cave search stopped');
  });

  test('a press searches that biome from the camera (`find(0, biome)`); the outcome writes the shared result line', async () => {
    const t = mount();
    t.$('map-caves-find-biome-1').click();
    expect(t.calls).toEqual(['find 0 biome 1']);
    expect(t.$('map-caves-find-result').textContent).toBe('Searching for lush cave…');
    t.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('Lush cave at 120, 30, -52 · 55 blocks away');
    t.$('map-caves-find-biome-3').click();
    t.searches[1]!.resolve({ hit: null, reason: 'radius' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('No abyss found within 1024 blocks');
    t.$('map-caves-find-biome-2').click();
    t.searches[2]!.resolve({ hit: null, reason: 'budget' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('No dripstone cave found in 2 s');
    t.$('map-caves-find-biome-2').click();
    t.searches[3]!.reject(new Error('BAD_ARGS: biome'));
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('Dripstone cave search failed');
  });

  test('the same cancel rules: a second press cancels; a press of a kind\'s button or another biome\'s cancels and starts that search; closing the tab cancels', async () => {
    const t = mount();
    t.$('map-caves-find-biome-1').click();
    t.$('map-caves-find-biome-1').click();
    expect(t.calls).toEqual(['find 0 biome 1', 'cancel']);
    expect(t.$('map-caves-find-result').textContent).toBe('Lush cave search cancelled');
    t.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    expect(t.$('map-caves-find-result').textContent).toBe('Lush cave search cancelled');
    // A biome search, then a kind's button; a kind search, then a biome's button; then another biome's.
    t.$('map-caves-find-biome-3').click();
    t.$('map-caves-find-1').click();
    t.$('map-caves-find-biome-2').click();
    t.$('map-caves-find-biome-3').click();
    expect(t.calls).toEqual(['find 0 biome 1', 'cancel', 'find 0 biome 3', 'cancel', 'find 1', 'cancel', 'find 0 biome 2', 'cancel', 'find 0 biome 3']);
    expect(t.$('map-caves-find-result').textContent).toBe('Searching for abyss…');
    t.tab.cancel();
    expect(t.calls.at(-1)).toBe('cancel');
    expect(t.$('map-caves-find-result').textContent).toBe('Abyss search cancelled');
    await settle();
  });

  test('"Save as place" after a biome hit in a saved world saves that hit', async () => {
    const t = mount(undefined, true);
    t.$('map-caves-find-biome-2').click();
    t.searches[0]!.resolve({ hit: HIT, reason: 'found' });
    await settle();
    const save = t.$('map-caves-save-place');
    expect(save.hidden).toBe(false);
    save.click();
    expect(t.savedHits).toEqual([HIT]);
  });
});

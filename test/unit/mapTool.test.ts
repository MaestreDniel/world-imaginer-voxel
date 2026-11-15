/**
 * The map tool's Caves tab (SP6a spec §7.3, D12): the world's map mounts it with the page's deps (`MapToolDeps.caves`)
 * and the tool's links, "Cave slice" (the Density tab's horizontal `caves` slice, or SP6b's `biome3d` by cave biome, at
 * the tab's y, 256 blocks across, centred on the camera) and "Cave parameters" (Parameters at `caves.cheese.offset`),
 * with SP6b's (SP6b spec §9.3, D11; rulings P51, P53): "Show cave biomes on the map" (the caveBiome layer at the tab's
 * y), "Cave biome parameters" (Parameters at `caves.biomes.lush.hMin`) and the biome legend's highlight (on the
 * caveBiome layer only); `?map` passes none and has no Caves tab. The real tool mounts only in the browser smoke (SP4c
 * spec §9): the links are a pure helper tested here, and the mount's wiring is pinned on the source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { SliceState } from '../../src/ui/inspector/sliceModel';
import { CAVE_BIOME_PARAMETERS_LEAF, CAVE_PARAMETERS_LEAF, CAVE_SLICE_EXTENT } from '../../src/ui/map/cavesTab';
import { layoutTabs } from '../../src/ui/map/layout';
import type { MapView } from '../../src/ui/map/mapState';
import { caveTabDeps, type MapCaves } from '../../src/ui/map/mapTool';
import { XRAY_ALL } from '../../src/ui/world/xrayStrip';

const SRC = (): string => readFileSync(new URL('../../src/ui/map/mapTool.ts', import.meta.url), 'utf8');

/** The page's deps, recording; the tool's parts, logged in call order. */
function setup(camera = { x: 100.5, y: 80.9, z: -40.5 }) {
  const log: string[] = [];
  const caves: MapCaves = {
    onXray: (on) => { log.push(`xray ${on}`); },
    onColorMode: (mode) => { log.push(`mode ${mode}`); },
    onBand: (b) => { log.push(`band ${b.yMin} ${b.yMax}`); },
    find: (kind) => {
      log.push(`find ${kind}`);
      return Promise.resolve({ hit: null, reason: 'radius' as const });
    },
    cancelFind: () => { log.push('cancel'); },
    savePlace: (hit) => { log.push(`save ${hit.x}`); },
    camera: () => camera,
  };
  const opened: SliceState[] = [];
  const views: MapView[] = [];
  const map = { view: { x: 10, z: -20, bpp: 2, layer: 'biome', caveY: -12 } as MapView };
  const deps = caveTabDeps(caves, {
    openSlice: (s) => { opened.push(s); log.push('open'); },
    showSlice: () => { log.push('slice pane'); },
    openDrawer: (t) => { log.push(`drawer ${t}`); },
    revealSlice: () => { log.push('reveal slice'); },
    showTab: (t) => { log.push(`tab ${t}`); },
    reveal: (path) => { log.push(`reveal ${path}`); },
    view: () => map.view,
    setView: (v) => { views.push(v); map.view = v; log.push(`view ${v.layer} ${v.caveY}`); },
    highlightCaveBiome: (id) => { log.push(`highlight ${id}`); },
  });
  return { deps, caves, log, opened, views, map, camera };
}

describe('the Caves tab\'s links in the world\'s map (SP6a spec §7.3)', () => {
  test('"Cave slice" opens the horizontal `caves` slice at y, 256 blocks across, centred on the camera, then shows the drawer on Density with its Slice pane (Task 52, minors-3), and last scrolls the slice cell into view (the user\'s check, R32 c)', () => {
    const s = setup();
    s.deps.openSlice(207, 'caves');
    expect(s.opened).toEqual([{ plane: 'horizontal', field: 'caves', y: 207, cx: 100.5, cz: -40.5, extent: CAVE_SLICE_EXTENT }]);
    // The slice cell's scroll runs after the drawer's own (openDrawer scrolls the drawer into view in the stacked layout).
    expect(s.log).toEqual(['open', 'slice pane', 'drawer density', 'reveal slice']);
    // The camera at the press, not at the mount.
    s.camera.x = -3000;
    s.camera.z = 12;
    s.deps.openSlice(-49, 'caves');
    expect(s.opened.at(-1)).toEqual({ plane: 'horizontal', field: 'caves', y: -49, cx: -3000, cz: 12, extent: 256 });
  });

  test('SP6b spec §9.3: by cave biome, "Cave slice" opens the `biome3d` field the same way (the tab picks the field by its mode)', () => {
    const s = setup();
    s.deps.openSlice(25, 'biome3d');
    expect(s.opened).toEqual([{ plane: 'horizontal', field: 'biome3d', y: 25, cx: 100.5, cz: -40.5, extent: CAVE_SLICE_EXTENT }]);
    expect(s.log).toEqual(['open', 'slice pane', 'drawer density', 'reveal slice']);
  });

  test('ruling P53: "Show cave biomes on the map" sets the map\'s layer to caveBiome at the tab\'s y, keeping the view\'s centre and scale', () => {
    const s = setup();
    s.deps.showCaveBiomes(25);
    expect(s.views).toEqual([{ x: 10, z: -20, bpp: 2, layer: 'caveBiome', caveY: 25 }]);
    s.deps.showCaveBiomes(-21);
    expect(s.views.at(-1)).toEqual({ x: 10, z: -20, bpp: 2, layer: 'caveBiome', caveY: -21 });
    expect(s.log).toEqual(['view caveBiome 25', 'view caveBiome -21']);
  });

  test('"Cave biome parameters" shows the Parameters tab, then reveals `caves.biomes.lush.hMin`', () => {
    const s = setup();
    s.deps.revealBiomeParameters();
    expect(s.log).toEqual(['tab parameters', `reveal ${CAVE_BIOME_PARAMETERS_LEAF}`]);
    expect(CAVE_BIOME_PARAMETERS_LEAF).toBe('caves.biomes.lush.hMin');
  });

  test('ruling P51: the legend\'s highlight reaches the canvas while the map shows the caveBiome layer; on another layer it ends any (null)', () => {
    const s = setup();
    s.deps.highlightCaveBiome(1);
    s.map.view = { ...s.map.view, layer: 'caveBiome' };
    s.deps.highlightCaveBiome(1);
    s.deps.highlightCaveBiome(3);
    s.deps.highlightCaveBiome(null);
    expect(s.log).toEqual(['highlight null', 'highlight 1', 'highlight 3', 'highlight null']);
  });

  test('"Cave parameters" shows the Parameters tab, then reveals `caves.cheese.offset`', () => {
    const s = setup();
    s.deps.revealParameters();
    expect(s.log).toEqual(['tab parameters', `reveal ${CAVE_PARAMETERS_LEAF}`]);
    expect(CAVE_PARAMETERS_LEAF).not.toBe(CAVE_BIOME_PARAMETERS_LEAF);
    expect(CAVE_PARAMETERS_LEAF).toBe('caves.cheese.offset');
  });

  test('every other dep is the page\'s own', () => {
    const s = setup();
    s.deps.onXray(true);
    s.deps.onColorMode(1);
    s.deps.onBand(XRAY_ALL);
    void s.deps.find(3);
    s.deps.cancelFind();
    s.deps.savePlace!({ x: 4, y: 5, z: 6, yaw: 0 });
    expect(s.log).toEqual(['xray true', 'mode 1', 'band -64 319', 'find 3', 'cancel', 'save 4']);
    expect(s.deps.camera()).toBe(s.camera);
  });
});

describe('the tool mounts the Caves tab in the world\'s map only (SP6a spec §7.3, D12; `?map` has no 3D)', () => {
  test('given `caves`, the tool lays out the Caves tab and mounts it with the page\'s deps and its links; disposed with the tool', () => {
    const src = SRC();
    expect(src).toContain('readonly caves?: MapCaves | null;');
    expect(src).toContain('const mapCaves = deps.caves ?? null;');
    expect(src).toContain('layoutTabs(mapPlaces !== null, mapCaves !== null)');
    const mount = src.slice(src.indexOf('  const cavesTab = mapCaves === null ? null : createCavesTab(layout.tabs.caves, caveTabDeps(mapCaves, {'));
    expect(mount.length).toBeLessThan(src.length);
    const block = mount.slice(0, mount.indexOf('\n  }));'));
    expect(block).toContain('openSlice: (s) => slices.open(s),');
    expect(block).toContain('showSlice: () => densityTab.showSlice(),');
    expect(block).toContain('openDrawer: (t) => layout.openDrawer(t),');
    expect(block).toContain('revealSlice: () => densityTab.revealSlice(),');
    expect(block).toContain("showTab: (t) => layout.showTab(t),");
    expect(block).toContain('reveal: (path) => panel.reveal(path),');
    // SP6b spec §9.3 (D11; rulings P51, P53): the map's view and its writer (the tool's own, which reports the view) and
    // the canvas's cave-biome highlight.
    expect(block).toContain('view: () => view,');
    expect(block).toContain('setView: (v) => { setView(v); viewChanged(); },');
    expect(block).toContain('highlightCaveBiome: (id) => canvas.highlightCaveBiome(id),');
    expect(src).toContain('    disposers.add(() => cavesTab.dispose());');
    // The tab is mounted after the panel and the slice view it links to.
    expect(src.indexOf('const cavesTab = ')).toBeGreaterThan(src.indexOf('const panel = createParamPanel('));
    expect(src.indexOf('const cavesTab = ')).toBeGreaterThan(src.indexOf('const slices = createSliceView('));
  });

  test('closing the tab cancels its search (SP6a spec §7.3, Task 44): another tab shown or the panel hidden, and the tool hidden', () => {
    const src = SRC();
    expect(src).toContain([
      '    disposers.add(layout.onPanelChange(() => {',
      "      if (layout.tab !== 'caves' || !layout.panelVisible) cavesTab.cancel();",
      '    }));',
    ].join('\n'));
    const hide = src.slice(src.indexOf('    hide() {'));
    expect(hide.slice(0, hide.indexOf('\n    },'))).toContain('      cavesTab?.cancel();');
  });

  test('`setXray` hands the page\'s X-ray state and colour mode to the tab, and does nothing without one', () => {
    const src = SRC();
    // SP6b §9.3 (Task 47): with the page's colour mode (C's `changed` reaches here), which the tab's Colour by follows;
    // SP6b §9.2 (Task 46): it also refreshes the Cross-section, so a C press repaints a shown Voxels slice by biome.
    expect(src).toMatch(/^ {4}setXray: \(on, band, radius\) => \{\n {6}cavesTab\?\.set\(on, band, radius, xrayColorMode\(\)\);\n(?: {6}\/\/.*\n)* {6}section\.refresh\(\);\n {4}\},$/m);
    expect(src).toContain('  const xrayColorMode = (): 0 | 1 => mapCaves?.xrayColorMode?.() ?? 0;');
  });

  test('`?map` has no Caves tab (SP6b spec §9.3; `layout.ts`): the tab is laid out only with the world\'s caves', () => {
    expect(layoutTabs(false, false)).not.toContain('caves');
    expect(layoutTabs(true, false)).not.toContain('caves');
    expect(layoutTabs(false, true)).toContain('caves');
    expect(layoutTabs(true, true)).toContain('caves');
  });

  test('the standalone `?map` page passes no caves (nor places)', () => {
    const page = readFileSync(new URL('../../src/ui/map/mapPage.ts', import.meta.url), 'utf8');
    const call = page.slice(page.indexOf('createMapTool(root, {'));
    const args = call.slice(0, call.indexOf('\n  });'));
    expect(args.length).toBeGreaterThan(0);
    expect(args).not.toMatch(/\bcaves\b/);
    expect(args).not.toMatch(/\bplaces\b/);
  });
});

describe('the tool mounted hidden (SP6a Task 48e\'s premount; Task 52, runtime-1)', () => {
  test('`deps.hidden` makes the tool hidden from its mount: `shown` false and the canvas created hidden before the replaying sink hands it the driver\'s source; `?map` passes none (shown)', () => {
    const src = SRC();
    expect(src).toContain('readonly hidden?: boolean;');
    expect(src).toContain('  let shown = deps.hidden !== true;');
    const canvas = src.indexOf('  const canvas = createMapCanvas(layout.map, pool, view, {');
    const hidden = src.indexOf('    hidden: !shown,\n  });', canvas);
    const attach = src.indexOf('  deps.relay.attach({');
    expect([canvas > 0, hidden > canvas, attach > hidden]).toEqual([true, true, true]);
    expect(src.indexOf('  let shown = deps.hidden !== true;')).toBeLessThan(canvas);
    const page = readFileSync(new URL('../../src/ui/map/mapPage.ts', import.meta.url), 'utf8');
    const call = page.slice(page.indexOf('createMapTool(root, {'));
    expect(call.slice(0, call.indexOf('\n  });'))).not.toMatch(/\bhidden\b/);
  });
});

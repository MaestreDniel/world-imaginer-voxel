/**
 * The map tool's Caves tab (SP6a spec §7.3, D12): the world's map mounts it with the page's deps (`MapToolDeps.caves`)
 * and the tool's two links, "Cave slice" (the Density tab's horizontal `caves` slice at the tab's y, 256 blocks across,
 * centred on the camera) and "Cave parameters" (Parameters at `caves.cheese.offset`); `?map` passes none and has no Caves
 * tab. The real tool mounts only in the browser smoke (SP4c spec §9): the links are a pure helper tested here, and the
 * mount's wiring is pinned on the source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { SliceState } from '../../src/ui/inspector/sliceModel';
import { CAVE_PARAMETERS_LEAF, CAVE_SLICE_EXTENT } from '../../src/ui/map/cavesTab';
import { caveTabDeps, type MapCaves } from '../../src/ui/map/mapTool';
import { XRAY_ALL } from '../../src/ui/world/xrayStrip';

const SRC = (): string => readFileSync(new URL('../../src/ui/map/mapTool.ts', import.meta.url), 'utf8');

/** The page's deps, recording; the tool's parts, logged in call order. */
function setup(camera = { x: 100.5, y: 80.9, z: -40.5 }) {
  const log: string[] = [];
  const caves: MapCaves = {
    onXray: (on) => { log.push(`xray ${on}`); },
    onBand: (b) => { log.push(`band ${b.yMin} ${b.yMax}`); },
    find: (kind) => { log.push(`find ${kind}`); },
    cancelFind: () => { log.push('cancel'); },
    camera: () => camera,
  };
  const opened: SliceState[] = [];
  const deps = caveTabDeps(caves, {
    openSlice: (s) => { opened.push(s); log.push('open'); },
    openDrawer: (t) => { log.push(`drawer ${t}`); },
    showTab: (t) => { log.push(`tab ${t}`); },
    reveal: (path) => { log.push(`reveal ${path}`); },
  });
  return { deps, caves, log, opened, camera };
}

describe('the Caves tab\'s links in the world\'s map (SP6a spec §7.3)', () => {
  test('"Cave slice" opens the horizontal `caves` slice at y, 256 blocks across, centred on the camera, then shows the drawer on Density', () => {
    const s = setup();
    s.deps.openSlice(207);
    expect(s.opened).toEqual([{ plane: 'horizontal', field: 'caves', y: 207, cx: 100.5, cz: -40.5, extent: CAVE_SLICE_EXTENT }]);
    expect(s.log).toEqual(['open', 'drawer density']);
    // The camera at the press, not at the mount.
    s.camera.x = -3000;
    s.camera.z = 12;
    s.deps.openSlice(-49);
    expect(s.opened.at(-1)).toEqual({ plane: 'horizontal', field: 'caves', y: -49, cx: -3000, cz: 12, extent: 256 });
  });

  test('"Cave parameters" shows the Parameters tab, then reveals `caves.cheese.offset`', () => {
    const s = setup();
    s.deps.revealParameters();
    expect(s.log).toEqual(['tab parameters', `reveal ${CAVE_PARAMETERS_LEAF}`]);
    expect(CAVE_PARAMETERS_LEAF).toBe('caves.cheese.offset');
  });

  test('every other dep is the page\'s own', () => {
    const s = setup();
    s.deps.onXray(true);
    s.deps.onBand(XRAY_ALL);
    s.deps.find(3);
    s.deps.cancelFind();
    expect(s.log).toEqual(['xray true', 'band -64 319', 'find 3', 'cancel']);
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
    expect(block).toContain('openDrawer: (t) => layout.openDrawer(t),');
    expect(block).toContain("showTab: (t) => layout.showTab(t),");
    expect(block).toContain('reveal: (path) => panel.reveal(path),');
    expect(src).toContain('if (cavesTab !== null) disposers.add(() => cavesTab.dispose());');
    // The tab is mounted after the panel and the slice view it links to.
    expect(src.indexOf('const cavesTab = ')).toBeGreaterThan(src.indexOf('const panel = createParamPanel('));
    expect(src.indexOf('const cavesTab = ')).toBeGreaterThan(src.indexOf('const slices = createSliceView('));
  });

  test('`setXray` hands the page\'s X-ray state to the tab, and does nothing without one', () => {
    const src = SRC();
    expect(src).toMatch(/^ {4}setXray: \(on, band, radius\) => cavesTab\?\.set\(on, band, radius\),$/m);
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

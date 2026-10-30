/**
 * The map tool (SP4c spec §1.1, D1): the ?map editor's composition, mounted by the standalone ?map page (`mapPage.ts`,
 * `host: 'page'`) and by the world's M overlay (`host: 'world'`, Task 15). It holds the layout (toolbar, notices, map,
 * side panel tabs, drawer), the map canvas, the World tab's session status, spawn and hover readouts (SP2b spec §3.3),
 * the parameter panel (§3.2) and its spline drawer (§4.2), the biome share preview and table (§5.2-§5.5), the presets
 * tab (§3.4), the cut-line tool and the Cross-section tab (§4.5), and SP3d's Density tab and slice viewer (SP3d spec
 * §3.1-§3.7); while the Density tab is shown, map clicks are routed by `mapClickAction` and the map hover probes the
 * selected node at the y control. It creates no session, pool, driver or window listener of its own beyond its P and
 * Escape shortcuts: the page passes them in, and the tool's own subscribe is the caller of `driver.change` for every
 * session change (ruling R1). Its canvas is attached to the driver's replaying sink (§4.2), so it draws at once from
 * the last configure. Every handle it takes goes into one disposer registry, which `dispose()` runs in reverse order
 * of creation (§1.2); only the session outlives it. In the world (`host: 'world'`, §1.3, §1.5, §2.5, §3.1) a plain map
 * click teleports (`onTeleport`) unless the cut tool is armed and Shift+click runs today's routing; the toolbar ends
 * with the click hint and the overlay's slot instead of "Open in 3D"; `show` and `hide` toggle the canvas's hidden state
 * and whether the driver waits for a preview; `setPlayer` moves the arrow. In a saved world the overlay's modification
 * mode (SP5b spec §3.6, D10) calls `setEditable`, which disables every editor's terrain controls; the session's own gate
 * (`setWritable`, D25) refuses what slips past them.
 */
import './map.css';
import type { WorldSession } from '../../engine/session';
import type { WorkerPool } from '../../engine/workerPool';
import { biomeName } from '../../gen/biomes/registry';
import type { Spawn } from '../../gen/column/spawn';
import { HIGHLIGHT_NOTICE, rowHover } from '../biomeTable/model';
import { createBiomeShares } from '../biomeTable/shares';
import { createBiomeTable } from '../biomeTable/table';
import { createDisposers } from '../common/disposers';
import { el } from '../common/dom';
import { installShortcuts, type ShortcutAction } from '../common/keys';
import { createNotices, type Notices } from '../common/notice';
import { CUT_ARMED, CUT_OFF, cutClick, cutOverlay, segmentDistance, type CutPoint, type CutTool } from '../crossSection/model';
import { createCrossSection } from '../crossSection/section';
import { createRuleReadout } from '../crossSection/voxels';
import { createDensityTab } from '../inspector/densityTab';
import { TREE_LEAVES } from '../inspector/editorModel';
import { createHoverModel, hoverTarget, type HoverVoxel } from '../inspector/hoverModel';
import { createDraftLog, hoverLineText, mapHoverVoxel, sliceSquare } from '../inspector/sliceModel';
import { createSliceView } from '../inspector/sliceView';
import { createParamPanel } from '../paramPanel/panel';
import { createPresetsTab } from '../presets/presetsTab';
import { createSplineDrawer } from '../splineEditor/drawer';
import { isSplineLeaf } from '../splineEditor/model';
import { mapClickAction } from './clickAction';
import { createHoverReadout } from './hoverPanel';
import { createLayout, drawerTabOnScreen, tabOnScreen, type LayoutStorage } from './layout';
import { encodeMapState, type MapView } from './mapState';
import { createMapCanvas, type MapCanvas } from './mapView';
import { draftOf, type DriverCanvas, type PreviewDriver } from './previewDriver';
import { createToolbar, open3dHref } from './toolbar';
import { centredView } from './viewMath';

/** The pool the tool's views run on (tiles, points, stats, slices, probes, spawn): every editor takes the pool's type. */
export type MapPool = WorkerPool;

export interface MapToolDeps {
  /** The page's session; its history survives the tool. */
  readonly session: WorldSession;
  readonly pool: MapPool;
  /** The only configure owner (§4.2); the tool's session subscribe calls its `change`. */
  readonly driver: PreviewDriver;
  /** The driver's replaying canvas (§4.2): the tool attaches its canvas and spawn readout at mount, detaches at dispose. */
  readonly relay: { attach(c: DriverCanvas): void; detach(): void };
  /** Where the layout persists (`wi10.layout.v1`); any Storage works. */
  readonly storage: LayoutStorage | null;
  readonly initialView: MapView;
  /** Click routing (§3.1) and the toolbar (§2.5). */
  readonly host: 'page' | 'world';
  /** The map's hash (without '#') after every session and view change; null in the world, which writes its own URL (§1.6). */
  readonly urlSink: ((hash: string) => void) | null;
  /** Called wherever the tool would call `urlSink` for a view change (pan, zoom, layer); null on the standalone page. */
  readonly onView: ((v: MapView) => void) | null;
  /** A plain click in the world's map (§3.1), at the clicked point; null on the standalone page. */
  readonly onTeleport: ((x: number, z: number) => void) | null;
  /** The overlay's controls, appended to the toolbar after the click hint in the world (§2.5); null on the standalone page. */
  readonly toolbarSlot: HTMLElement | null;
  /** Whether the tool's P (`togglePanel`) and Escape (`closeDrawer`) run now (the world's owner rule, Task 15). */
  readonly shortcutsEnabled: (a: ShortcutAction) => boolean;
  /** Called once, at the end of the mount, with the parts the standalone page's `?perf=edit` hook reads. */
  readonly onMounted?: (parts: { canvas: MapCanvas; host: HTMLElement; view(): MapView; editAt<T>(at: number, fn: () => T): T }) => void;
}

export interface MapTool {
  /**
   * Shows the map (§1.3, §1.5): re-measures, centres the view on `centre` at the current zoom and layer (a reported view
   * change), plans and draws, and tells the driver a preview is wanted (§4.2).
   */
  show(centre?: { readonly x: number; readonly z: number }): void;
  /** Hides the map: no tile requests, its queued tiles cancelled, no preview wanted (§1.3, §4.2). */
  hide(): void;
  /** The player's arrow at (x, z) facing `yawDeg` (§1.5); redrawn only when it moved ≥ 1 px or turned ≥ 2°, ≤ 30/s. */
  setPlayer(x: number, z: number, yawDeg: number): void;
  readonly view: MapView;
  /** The tool's notice row (Task 20 routes the world's transient notices to it while the map covers the 3D). */
  readonly notices: Notices;
  /** Shows `v` (the standalone page's `hashchange`); not a view change the tool reports. */
  setView(v: MapView): void;
  /**
   * The world-modification mode (SP5b spec §3.6, D10): each editor's `setEditable(on)` (the toolbar, the Parameters,
   * Biomes and Presets tabs, the Spline and Density drawers). Off, every terrain control is shown disabled, each keeping
   * its own reasons for when it is on again; looking, layers, the grid, the cut line, the Density tab's tree and slices,
   * Presets export, teleport and the pin work.
   */
  setEditable(on: boolean): void;
  /** Runs every disposer once, in reverse order of creation; later calls do nothing. */
  dispose(): void;
}

/** The world's map header hint (SP4c spec §2.5, D26). */
export const WORLD_CLICK_HINT = 'Click: go here · Shift+click: pin';
/** A click this close to the cut line (screen px) shows its profile instead of pinning the point. */
const LINE_HIT_PX = 6;
const spawnText = (sp: Spawn): string => `${sp.x}, ${sp.z} (y ${sp.y}, ${biomeName(sp.biome)}${sp.fallback ? ', fallback' : ''})`;

export function createMapTool(host: HTMLElement, deps: MapToolDeps): MapTool {
  const { session, pool, driver } = deps;
  const disposers = createDisposers();
  let view: MapView = deps.initialView;

  const layout = createLayout(host, deps.storage);
  disposers.add(() => layout.dispose());
  const notices = createNotices(layout.notices);
  disposers.add(() => notices.dispose());
  /** The map's hash (without '#'): the session's draft and the view, as the URL and "Open in 3D" carry it. */
  const mapHash = (): string => {
    const s = session.state;
    return encodeMapState({ v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view });
  };
  const sessionChanged = () => { deps.urlSink?.(mapHash()); };
  const viewChanged = () => {
    deps.urlSink?.(mapHash());
    deps.onView?.(view);
  };

  // World tab (§3.3): session status, spawn and hover readout.
  const statusOut = el('div', 'map-readout');
  const spawnOut = el('div', 'map-readout', 'spawn …');
  const hoverOut = el('div', 'map-readout', 'hover the map');
  layout.tabs.world.append(el('h3', '', 'Session'), statusOut, el('h3', '', 'Spawn'), spawnOut, el('h3', '', 'Point'), hoverOut);
  const renderStatus = () => {
    const s = session.state;
    const modified = session.modifiedCount('');
    statusOut.textContent = [
      `seed ${s.seedText}`, `profile ${s.profile}${modified === 0 ? '' : `, ${modified} modified`}`,
      `epoch ${s.epoch}  workers ${pool.size}`,
      `view x ${view.x.toFixed(0)} z ${view.z.toFixed(0)}  ${view.bpp.toFixed(2)} blocks/px`,
    ].join('\n');
  };
  const hover = createHoverReadout(pool, (t) => { hoverOut.textContent = t; });
  disposers.add(() => hover.dispose());

  /** The input event's timeStamp while a control's session call runs (§2.8: latency counts from it). */
  let inputAt: number | null = null;
  const editAt = <T>(at: number, fn: () => T): T => {
    inputAt = at;
    try { return fn(); } finally { inputAt = null; }
  };
  const edit = (e: Event, fn: () => void): void => { editAt(e.timeStamp, fn); };

  // The cut-line tool (§4.5): while armed, map clicks set A, then B; otherwise a click on the line shows its
  // profile and any other click pins the point. While the Density tab is shown a finished line keeps it shown, a
  // click on the line does not open Cross-section, and on its horizontal plane a click sets the plane's centre
  // (SP3d spec §3.7).
  let cut: CutTool = CUT_OFF;
  let cutPointer: CutPoint | null = null;
  /** The map's pin (the Density tab's first horizontal centre when set, SP3d spec §3.7). */
  let pin: CutPoint | null = null;
  /**
   * Whether the map is shown: always on the standalone page; in the world, between `show` and `hide`. Hidden, no tab or
   * drawer tab is on screen, so the shares, spline, cross-section and Density views request nothing (final review MAP-2).
   */
  let shown = true;
  const densityShown = (): boolean => drawerTabOnScreen(shown, layout, 'density');
  const canvas = createMapCanvas(layout.map, pool, view, {
    onView: (v) => { view = v; canvas.setView(v); viewChanged(); renderStatus(); },
    onHover: (x, z) => {
      hover.move(x, z);
      // While Density is shown the form probes the selected node at the hovered block and the y control (SP3d spec §3.6).
      if (densityShown() && slices.state !== null) hoverAt(mapHoverVoxel(x, z, slices.state.y));
      if (cut.mode !== 'b') return;
      cutPointer = [x, z];
      drawCut();
    },
    onClick: (x, z, shift) => {
      const action = mapClickAction({
        drawerTab: layout.drawerOpen ? layout.drawerTab : null,
        plane: slices.state?.plane ?? 'vertical',
        nearLine: section.line !== null && segmentDistance(section.line, x, z) <= LINE_HIT_PX * view.bpp,
        cutArmed: cut.mode !== 'off',
        host: deps.host,
        shift,
      });
      switch (action.kind) {
        case 'teleport': deps.onTeleport?.(x, z); break;
        case 'cut': cutAt(x, z, action.openSection); break;
        case 'openSection': layout.openDrawer('section'); break;
        case 'centre': slices.setCentre(x, z); break;
        case 'pin': pin = [x, z]; canvas.setPin([x, z]); break;
      }
    },
    onPreviewProgress: (epoch, drawn, visible) => driver.previewProgress(epoch, drawn, visible),
  });
  disposers.add(() => canvas.destroy());
  // The driver pushes into its replaying sink (SP4c spec §4.2); the canvas and the spawn readout take its last source,
  // interactivity and spawn now, and every later one until the tool is disposed.
  deps.relay.attach({
    setSource: (epoch, seedKey, hashes) => canvas.setSource(epoch, seedKey, hashes),
    setInteractive: (on) => canvas.setInteractive(on),
    setSpawn: (sp) => {
      canvas.setSpawn(sp);
      spawnOut.textContent = sp === null ? 'spawn …' : spawnText(sp);
    },
  });
  disposers.add(() => deps.relay.detach());

  /** The biome of the table row under the pointer (§5.3): highlighted while the map shows the biome layer. */
  let hoveredBiome: number | null = null;
  const hoverBiome = (biome: number | null) => {
    const h = rowHover(view.layer, biome, hoveredBiome);
    hoveredBiome = biome;
    canvas.highlightBiome(h.highlight);
    if (h.notice) notices.show(HIGHLIGHT_NOTICE, { kind: 'info', timeoutMs: 4000 });
  };

  const setView = (v: MapView) => {
    view = v;
    canvas.setView(v);
    toolbar.setLayer(v.layer);
    hoverBiome(hoveredBiome);
    renderStatus();
  };
  const toolbar = createToolbar(layout.toolbar, {
    session, notices, layer: view.layer, edit,
    onLayer: (layer) => { setView({ ...view, layer }); viewChanged(); },
    onGrid: (on) => canvas.setGrid(on),
    onCut: () => setCut(cut.mode === 'off' ? CUT_ARMED : CUT_OFF),
    open3dHref: () => open3dHref(pin, [view.x, view.z], `#${mapHash()}`),
    // In the world the overlay's slot is always given (Task 15); an empty one stands in if it is not.
    embedded: deps.host === 'world' ? { slot: deps.toolbarSlot ?? el('span'), hint: WORLD_CLICK_HINT } : null,
  });
  disposers.add(() => toolbar.dispose());

  // The hover readout shows points of the canvas source's pool epoch only (§2.5).
  let shownEpoch: number | null = null;
  // The Density tab's slices and hover values run on the pool's resolved configure (SP3d spec §4.5): every status
  // change may let them request.
  disposers.add(driver.onStatus((st) => {
    toolbar.setStatus(st);
    if (st.poolEpoch !== shownEpoch) {
      shownEpoch = st.poolEpoch;
      hover.refresh();
    }
    if (densityShown()) {
      slices.update();
      hoverAt(hoverVoxel);
    }
  }));
  /** The params of every draft handed to the driver, so a slice is costed on the draft the workers hold (§4.5). */
  const drafts = createDraftLog();
  disposers.add(session.subscribe((s, change) => {
    drafts.remember(s.epoch, s.params, driver.status.sessionEpoch);
    driver.change(draftOf(s), change, inputAt ?? performance.now());
    toolbar.sync();
    sessionChanged();
    renderStatus();
    slices.update();
  }));

  // Parameters tab (§3.2). It subscribes after the tool, so a change reaches the driver before the panel redraws.
  // A spline's "Edit" opens the spline drawer on the leaf (§4.2), then shows the drawer on its tab, whose change
  // makes the drawer request the leaf's statistics (not those of a leaf it showed before).
  const panel = createParamPanel(layout.tabs.parameters, {
    session, edit, sections: layout,
    openSpline: (path) => {
      if (!isSplineLeaf(path)) return;
      splines.open(path);
      layout.openDrawer('spline');
    },
    showBiomes: () => layout.showTab('biomes'),
    // A tree's "Edit in Density" opens the drawer's Density tab on that leaf's root (SP3d spec §1.1).
    openTree: (path) => {
      layout.openDrawer('density');
      const leaf = TREE_LEAVES.find((l) => l === path);
      if (leaf !== undefined) densityTab.select({ leaf, path: 'root' });
    },
  });
  disposers.add(() => panel.dispose());

  // The drawer's Spline tab (§4.2-4.4): it requests its statistics when the driver settles (§4.3).
  const splines = createSplineDrawer(layout.drawerTabs.spline, {
    session, notices, pool, driver, edit,
    visible: () => drawerTabOnScreen(shown, layout, 'spline'),
    close: () => layout.closeDrawer(),
  });
  disposers.add(() => splines.dispose());

  // The drawer's Cross-section tab (§4.5): the profile along the cut line, requested when the driver settles
  // while the tab is on screen, when it comes on screen and when a line is drawn.
  const section = createCrossSection(layout.drawerTabs.section, {
    session, notices, pool, driver,
    visible: () => drawerTabOnScreen(shown, layout, 'section'),
    arm: () => setCut(CUT_ARMED),
    clear: () => {
      section.setLine(null);
      drawCut();
    },
    close: () => layout.closeDrawer(),
  });
  disposers.add(() => section.dispose());
  function drawCut(): void {
    canvas.setCutLine(cutOverlay(cut, section.line, cutPointer));
  }
  function setCut(next: CutTool): void {
    cut = next;
    cutPointer = null;
    toolbar.setCut(next);
    canvas.setCrosshair(next.mode !== 'off');
    drawCut();
  }
  function cutAt(x: number, z: number, openSection: boolean): void {
    const step = cutClick(cut, x, z);
    if (step.problem !== null) notices.show(step.problem, { kind: 'warn', timeoutMs: 4000 });
    if (step.line !== null) section.setLine(step.line);
    setCut(step.tool);
    if (step.line !== null && openSection) layout.openDrawer('section');
  }

  // The drawer's Density tab (SP3d spec §3.1-§3.7): tree, node form and JSON editor (densityTab.ts) and the slice
  // viewer in its slice cell (sliceView.ts). The vertical plane is the cut line; the first show picks the plane
  // (§3.7); the horizontal plane's square is drawn on the map while the tab is shown.
  const densityTab = createDensityTab(layout.drawerTabs.density, { session, edit });
  disposers.add(() => densityTab.dispose());
  const slices = createSliceView(densityTab.sliceHost, {
    session, pool,
    configured: () => drafts.configured(driver.status),
    line: () => section.line,
    selection: () => densityTab.selection,
    start: () => ({ line: section.line, viewCentre: [view.x, view.z], pin }),
    onState: (s) => canvas.setSquare(densityShown() ? sliceSquare(s) : null),
    onHover: (v) => hoverAt(v),
  });
  disposers.add(() => slices.dispose());
  // The form's "value at the hover" (§3.6): the selected node's value at the hovered voxel (a fieldProbe job), and for a
  // rule node the voxel's rule (a surfaceProbe job), both on the draft the pool's resolved configure holds.
  let hoverVoxel: HoverVoxel | null = null;
  let hoverValue = '';
  let hoverRule = '';
  const showHover = () => densityTab.setHoverValue(hoverLineText(hoverVoxel, hoverValue, hoverRule));
  const probe = createHoverModel(pool, () => driver.status.sessionEpoch, (_, text) => { hoverValue = text; showHover(); });
  disposers.add(() => probe.dispose());
  const ruleProbe = createRuleReadout(pool, () => driver.status.sessionEpoch ?? -1, (_, suffix) => { hoverRule = suffix; showHover(); });
  disposers.add(() => ruleProbe.dispose());
  function hoverAt(v: HoverVoxel | null): void {
    hoverVoxel = densityShown() ? v : null;
    const sel = densityTab.selection;
    hoverValue = probe.hover(hoverVoxel, hoverVoxel === null ? null : hoverTarget(sel));
    const e = driver.status.sessionEpoch;
    hoverRule = ruleProbe.hover(hoverVoxel !== null && e !== null && sel.leaf === 'surface.rules' ? { ...hoverVoxel, epoch: e } : null);
    showHover();
  }
  disposers.add(densityTab.onSelect(() => {
    slices.update();
    hoverAt(hoverVoxel);
  }));
  disposers.add(section.onLineChange(() => slices.update()));
  const densityChanged = () => {
    const on = densityShown();
    densityTab.setShown(on);
    slices.setShown(on);
    canvas.setSquare(on ? sliceSquare(slices.state) : null);
    if (!on) hoverAt(null);
  };
  densityChanged();
  // A tab that comes on screen catches up: the spline drawer renders and requests its statistics, the
  // cross-section requests its profile, the Density tab restores its scroll and requests its slice.
  disposers.add(layout.onDrawerChange(() => {
    if (drawerTabOnScreen(shown, layout, 'spline') && splines.leaf !== null) splines.open(splines.leaf);
    section.shown();
    densityChanged();
  }));

  // Biomes tab: the biome share preview (§5.5), requested when the driver settles while the tab is on screen and
  // when the tab comes on screen; then the table (§5.2), whose hovered row highlights its biome on the biome layer,
  // else shows a notice (§5.3).
  const sharesHost = el('div');
  const tableHost = el('div');
  layout.tabs.biomes.append(sharesHost, tableHost);
  const shares = createBiomeShares(sharesHost, {
    session, notices, pool, driver,
    tabVisible: () => tabOnScreen(shown, layout, 'biomes'),
  });
  disposers.add(() => shares.dispose());
  disposers.add(layout.onPanelChange(() => shares.shown()));
  const table = createBiomeTable(tableHost, { session, edit, hover: hoverBiome });
  disposers.add(() => table.dispose());

  // Presets tab (§3.4): export and import of preset files (an import is one undo step) and the JSON patch box.
  const presets = createPresetsTab(layout.tabs.presets, { session, notices, edit });
  disposers.add(() => presets.dispose());

  // P and Escape (§3.5); undo and redo are the page's (the standalone shell, or the world page).
  disposers.add(installShortcuts((a) => {
    if (a === 'togglePanel') layout.togglePanel();
    else if (a !== 'closeDrawer') return;
    else if (cut.mode !== 'off') setCut(CUT_OFF);
    else layout.closeDrawer();
  }, (a) => (a === 'togglePanel' || a === 'closeDrawer') && deps.shortcutsEnabled(a)));

  // A tool mounted after the driver's first configure (an adopt) seeds its draft log, so the slice view runs on the
  // configure the driver holds (`drafts.configured`, null for a never-remembered epoch).
  drafts.remember(session.state.epoch, session.state.params, driver.status.sessionEpoch);
  toolbar.setStatus(driver.status);
  renderStatus();
  deps.onMounted?.({ canvas, host: layout.map, view: () => view, editAt });

  /** Shown again, every view on screen catches up as when it comes on screen (the drawer's and the panel's changes). */
  const caughtUp = (): void => {
    if (drawerTabOnScreen(shown, layout, 'spline') && splines.leaf !== null) splines.open(splines.leaf);
    section.shown();
    densityChanged();
    shares.shown();
  };

  return {
    show(centre) {
      // Centred on the camera, clamped to the hash's window as pan and zoom clamp (final review MAP-1).
      const next = centre === undefined ? view : centredView(view, centre.x, centre.z);
      if (next.x !== view.x || next.z !== view.z) {
        view = next;
        canvas.setView(view);
        viewChanged();
        renderStatus();
      }
      // Shown again, the canvas re-measures its host (hidden, it was display: none), then plans its tiles and draws.
      canvas.setHidden(false);
      driver.setPreviewWanted(true);
      if (!shown) {
        shown = true;
        caughtUp();
      }
    },
    hide() {
      // Hidden, nothing requests (MAP-2); the slice viewer stops at once. The Density tab keeps its saved scroll: the host
      // is already display: none, so it is not hidden through `densityChanged`.
      shown = false;
      slices.setShown(false);
      hoverAt(null);
      canvas.setHidden(true);
      driver.setPreviewWanted(false);
    },
    setPlayer: (x, z, yawDeg) => canvas.setPlayer(x, z, yawDeg),
    get view() { return view; },
    notices,
    setView,
    setEditable(on) {
      toolbar.setEditable(on);
      panel.setEditable(on);
      splines.setEditable(on);
      densityTab.setEditable(on);
      table.setEditable(on);
      presets.setEditable(on);
    },
    dispose: () => disposers.dispose(),
  };
}

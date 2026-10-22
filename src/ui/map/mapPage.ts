/**
 * The ?map editor page (SP2b spec §3.1): the composition of the layout (toolbar, notices, map, side panel
 * tabs, drawer), the WorldSession that owns the draft, the preview driver that turns its changes into
 * configure cycles (§2.6), the map canvas, the URL (§1.4: written on every change, read on `hashchange`)
 * and the global shortcuts (§3.5). The World tab shows the session status, the spawn and the hover readout
 * (§3.3); the Parameters tab holds the parameter panel (§3.2), whose spline "Edit" opens the spline drawer
 * under the map (§4.2); the Biomes tab holds the biome share preview (§5.5) over the biome table (§5.2), whose
 * hovered row the canvas highlights on the biome layer (§5.3); the Presets tab exports and imports preset files
 * and holds the JSON patch box (§3.4). The toolbar's "Cut line" arms a two-click line tool on the map, whose line
 * the drawer's Cross-section tab profiles (§4.5). The drawer's Density tab (SP3d spec §3.1-§3.7) holds the tree, the
 * node form, the JSON editor and the slice viewer on the same session; its vertical plane follows the same line, its
 * slices and hover values run on the pool's resolved configure, and while it is shown map clicks are routed by
 * `mapClickAction` (a horizontal plane's centre) and the map hover probes the selected node at the y control.
 * `?map&perf=edit` also loads the latency hook (§2.8, `perfHook.ts`), which pins the canvas and the world.
 */
import './map.css';
import type { SessionState } from '../../engine/session';
import { createBrowserPool } from '../../engine/workerPool';
import { biomeName } from '../../gen/biomes/registry';
import type { Spawn } from '../../gen/column/spawn';
import { HIGHLIGHT_NOTICE, rowHover } from '../biomeTable/model';
import { createBiomeShares } from '../biomeTable/shares';
import { createBiomeTable } from '../biomeTable/table';
import { el } from '../common/dom';
import { installShortcuts } from '../common/keys';
import { createNotices } from '../common/notice';
import { createUrlWriter, oversizeNotice } from '../common/urlWriter';
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
import { cryptoSeed } from '../seedBox';
import { createSplineDrawer } from '../splineEditor/drawer';
import { isSplineLeaf } from '../splineEditor/model';
import { mapClickAction } from './clickAction';
import { createHoverReadout } from './hoverPanel';
import { browserStorage, createLayout } from './layout';
import { createMapCanvas } from './mapView';
import { applyMapHash, decodeMapState, encodeMapState, openMapSession, type MapView } from './mapState';
import { createPreviewDriver, type DriverClock, type DriverDraft, type PreviewDriver } from './previewDriver';
import { createToolbar, open3dHref } from './toolbar';

/** A click this close to the cut line (screen px) shows its profile instead of pinning the point. */
const LINE_HIT_PX = 6;
const draftOf = (s: SessionState): DriverDraft => ({ sessionEpoch: s.epoch, seedText: s.seedText, seedKey: `${s.seed[0]}.${s.seed[1]}`, params: s.params });
const spawnText = (sp: Spawn): string => `${sp.x}, ${sp.z} (y ${sp.y}, ${biomeName(sp.biome)}${sp.fallback ? ', fallback' : ''})`;

export async function mountMapPage(root: HTMLElement): Promise<void> {
  // The latency hook is a chunk of its own, loaded only for the §2.8 runner.
  const perf = new URLSearchParams(location.search).get('perf') === 'edit' ? (await import('./perfHook')).createPerfHook() : null;
  const decoded = decodeMapState(location.hash);
  const initial = perf?.initialState(decoded.state) ?? decoded.state;
  // Tier 2 of the trees runs in the session (SP3d spec §1.8): a link with an invalid tree opens the defaults.
  const session = openMapSession(initial, cryptoSeed);
  let view: MapView = initial.view;

  const layout = createLayout(root, browserStorage());
  perf?.pin(layout.map);
  const notices = createNotices(layout.notices);
  const startNotice = decoded.error ?? session.initNotice;
  if (startNotice !== null) notices.show(startNotice, { kind: 'warn' });
  const browserPool = createBrowserPool(undefined, { onFailure: () => notices.show('a worker failed; reload the page', { kind: 'error' }) });
  const pool = perf?.instrument(browserPool) ?? browserPool;
  if (!pool.abortable) notices.show('live preview is slower without cross-origin isolation', { kind: 'info' });
  // A draft whose URL is over the cap is not written; the notice stays until one fits (SP3d spec §1.12).
  const url = createUrlWriter((u) => history.replaceState(null, '', u), undefined, undefined, oversizeNotice(notices));
  addEventListener('pagehide', () => url.flush());
  /** The map's hash (without '#'): the session's draft and the view, as the URL and "Open in 3D" carry it. */
  const mapHash = (): string => {
    const s = session.state;
    return encodeMapState({ v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view });
  };
  const writeUrl = () => {
    url.set(`?map#${mapHash()}`);
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
  const densityShown = (): boolean => layout.drawerOpen && layout.drawerTab === 'density';
  const canvas = createMapCanvas(layout.map, pool, view, {
    onView: (v) => { view = v; canvas.setView(v); writeUrl(); renderStatus(); },
    onHover: (x, z) => {
      hover.move(x, z);
      // While Density is shown the form probes the selected node at the hovered block and the y control (SP3d spec §3.6).
      if (densityShown() && slices.state !== null) hoverAt(mapHoverVoxel(x, z, slices.state.y));
      if (cut.mode !== 'b') return;
      cutPointer = [x, z];
      drawCut();
    },
    onClick: (x, z) => {
      const action = mapClickAction({
        drawerTab: layout.drawerOpen ? layout.drawerTab : null,
        plane: slices.state?.plane ?? 'vertical',
        nearLine: section.line !== null && segmentDistance(section.line, x, z) <= LINE_HIT_PX * view.bpp,
        cutArmed: cut.mode !== 'off',
      });
      switch (action.kind) {
        case 'cut': cutAt(x, z, action.openSection); break;
        case 'openSection': layout.openDrawer('section'); break;
        case 'centre': slices.setCentre(x, z); break;
        case 'pin': pin = [x, z]; canvas.setPin([x, z]); break;
      }
    },
    onPreviewProgress: (epoch, drawn, visible) => {
      perf?.drawn(epoch, drawn, visible);
      driver.previewProgress(epoch, drawn, visible);
    },
  });
  const clock: DriverClock = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
  const driver: PreviewDriver = createPreviewDriver(pool, {
    setSource: (epoch, seedKey, hashes) => canvas.setSource(epoch, seedKey, hashes),
    setInteractive: (on) => canvas.setInteractive(on),
    setSpawn: (sp) => {
      canvas.setSpawn(sp);
      spawnOut.textContent = sp === null ? 'spawn …' : spawnText(sp);
    },
  }, clock);

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
    onLayer: (layer) => { setView({ ...view, layer }); writeUrl(); },
    onGrid: (on) => canvas.setGrid(on),
    onCut: () => setCut(cut.mode === 'off' ? CUT_ARMED : CUT_OFF),
    open3dHref: () => open3dHref(pin, [view.x, view.z], `#${mapHash()}`),
  });

  // The hover readout shows points of the canvas source's pool epoch only (§2.5).
  let shownEpoch: number | null = null;
  // The Density tab's slices and hover values run on the pool's resolved configure (SP3d spec §4.5): every status
  // change may let them request.
  driver.onStatus((st) => {
    toolbar.setStatus(st);
    if (st.poolEpoch !== shownEpoch) {
      shownEpoch = st.poolEpoch;
      hover.refresh();
    }
    if (densityShown()) {
      slices.update();
      hoverAt(hoverVoxel);
    }
  });
  /** The params of every draft handed to the driver, so a slice is costed on the draft the workers hold (§4.5). */
  const drafts = createDraftLog();
  session.subscribe((s, change) => {
    drafts.remember(s.epoch, s.params, driver.status.sessionEpoch);
    driver.change(draftOf(s), change, inputAt ?? performance.now());
    toolbar.sync();
    writeUrl();
    renderStatus();
    slices.update();
  });

  // Parameters tab (§3.2). It subscribes after the page, so a change reaches the driver before the panel redraws.
  // A spline's "Edit" opens the spline drawer on the leaf (§4.2), then shows the drawer on its tab, whose change
  // makes the drawer request the leaf's statistics (not those of a leaf it showed before).
  createParamPanel(layout.tabs.parameters, {
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

  // The drawer's Spline tab (§4.2-4.4): it requests its statistics when the driver settles (§4.3).
  const splines = createSplineDrawer(layout.drawerTabs.spline, {
    session, notices, pool, driver, edit,
    visible: () => layout.drawerOpen && layout.drawerTab === 'spline',
    close: () => layout.closeDrawer(),
  });

  // The drawer's Cross-section tab (§4.5): the profile along the cut line, requested when the driver settles
  // while the tab is on screen, when it comes on screen and when a line is drawn.
  const section = createCrossSection(layout.drawerTabs.section, {
    session, notices, pool, driver,
    visible: () => layout.drawerOpen && layout.drawerTab === 'section',
    arm: () => setCut(CUT_ARMED),
    clear: () => {
      section.setLine(null);
      drawCut();
    },
    close: () => layout.closeDrawer(),
  });
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
  const slices = createSliceView(densityTab.sliceHost, {
    session, pool,
    configured: () => drafts.configured(driver.status),
    line: () => section.line,
    selection: () => densityTab.selection,
    start: () => ({ line: section.line, viewCentre: [view.x, view.z], pin }),
    onState: (s) => canvas.setSquare(densityShown() ? sliceSquare(s) : null),
    onHover: (v) => hoverAt(v),
  });
  // The form's "value at the hover" (§3.6): the selected node's value at the hovered voxel (a fieldProbe job), and for a
  // rule node the voxel's rule (a surfaceProbe job), both on the draft the pool's resolved configure holds.
  let hoverVoxel: HoverVoxel | null = null;
  let hoverValue = '';
  let hoverRule = '';
  const showHover = () => densityTab.setHoverValue(hoverLineText(hoverVoxel, hoverValue, hoverRule));
  const probe = createHoverModel(pool, () => driver.status.sessionEpoch, (_, text) => { hoverValue = text; showHover(); });
  const ruleProbe = createRuleReadout(pool, () => driver.status.sessionEpoch ?? -1, (_, suffix) => { hoverRule = suffix; showHover(); });
  function hoverAt(v: HoverVoxel | null): void {
    hoverVoxel = densityShown() ? v : null;
    const sel = densityTab.selection;
    hoverValue = probe.hover(hoverVoxel, hoverVoxel === null ? null : hoverTarget(sel));
    const e = driver.status.sessionEpoch;
    hoverRule = ruleProbe.hover(hoverVoxel !== null && e !== null && sel.leaf === 'surface.rules' ? { ...hoverVoxel, epoch: e } : null);
    showHover();
  }
  densityTab.onSelect(() => {
    slices.update();
    hoverAt(hoverVoxel);
  });
  section.onLineChange(() => slices.update());
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
  layout.onDrawerChange(() => {
    if (layout.drawerOpen && layout.drawerTab === 'spline' && splines.leaf !== null) splines.open(splines.leaf);
    section.shown();
    densityChanged();
  });

  // Biomes tab: the biome share preview (§5.5), requested when the driver settles while the tab is on screen and
  // when the tab comes on screen; then the table (§5.2), whose hovered row highlights its biome on the biome layer,
  // else shows a notice (§5.3).
  const sharesHost = el('div');
  const tableHost = el('div');
  layout.tabs.biomes.append(sharesHost, tableHost);
  const shares = createBiomeShares(sharesHost, {
    session, notices, pool, driver,
    tabVisible: () => layout.panelVisible && layout.tab === 'biomes',
  });
  layout.onPanelChange(() => shares.shown());
  createBiomeTable(tableHost, { session, edit, hover: hoverBiome });

  // Presets tab (§3.4): export and import of preset files (an import is one undo step) and the JSON patch box.
  createPresetsTab(layout.tabs.presets, { session, notices, edit });

  installShortcuts((a) => {
    if (a === 'undo') session.undo();
    else if (a === 'redo') session.redo();
    else if (a === 'togglePanel') layout.togglePanel();
    else if (cut.mode !== 'off') setCut(CUT_OFF);
    else layout.closeDrawer();
  });
  addEventListener('hashchange', () => {
    const problem = applyMapHash(location.hash, session, setView);
    if (problem !== null) notices.show(problem, { kind: 'warn' });
    writeUrl();
  });

  // The first cycle is an urgent load (Task 10); the URL is rewritten in canonical form.
  drafts.remember(session.state.epoch, session.state.params, driver.status.sessionEpoch);
  driver.change(draftOf(session.state), { kind: 'load', urgent: true, gesture: false }, performance.now());
  toolbar.setStatus(driver.status);
  writeUrl();
  renderStatus();
  perf?.attach({ session, canvas, driver, host: layout.map, view: () => view, editAt });
}

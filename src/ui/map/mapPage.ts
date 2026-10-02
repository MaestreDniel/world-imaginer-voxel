/**
 * The ?map editor page (SP2b spec §3.1): the composition of the layout (toolbar, notices, map, side panel
 * tabs, drawer), the WorldSession that owns the draft, the preview driver that turns its changes into
 * configure cycles (§2.6), the map canvas, the URL (§1.4: written on every change, read on `hashchange`)
 * and the global shortcuts (§3.5). The World tab shows the session status, the spawn and the hover readout
 * (§3.3); the Parameters tab holds the parameter panel (§3.2), whose spline "Edit" opens the spline drawer
 * under the map (§4.2); the Biomes tab holds the biome share preview (§5.5) over the biome table (§5.2), whose
 * hovered row the canvas highlights on the biome layer (§5.3); the Presets tab exports and imports preset files
 * and holds the JSON patch box (§3.4). The toolbar's "Cut line" arms a two-click line tool on the map, whose line
 * the drawer's Cross-section tab profiles (§4.5).
 * `?map&perf=edit` also loads the latency hook (§2.8, `perfHook.ts`), which pins the canvas and the world.
 */
import './map.css';
import { WorldSession, type SessionState } from '../../engine/session';
import { createBrowserPool } from '../../engine/workerPool';
import { biomeName } from '../../gen/biomes/registry';
import type { Spawn } from '../../gen/column/spawn';
import { HIGHLIGHT_NOTICE, rowHover } from '../biomeTable/model';
import { createBiomeShares } from '../biomeTable/shares';
import { createBiomeTable } from '../biomeTable/table';
import { el } from '../common/dom';
import { installShortcuts } from '../common/keys';
import { createNotices } from '../common/notice';
import { createUrlWriter } from '../common/urlWriter';
import { CUT_ARMED, CUT_OFF, cutClick, cutOverlay, segmentDistance, type CutPoint, type CutTool } from '../crossSection/model';
import { createCrossSection } from '../crossSection/section';
import { createParamPanel } from '../paramPanel/panel';
import { createPresetsTab } from '../presets/presetsTab';
import { cryptoSeed } from '../seedBox';
import { createSplineDrawer } from '../splineEditor/drawer';
import { isSplineLeaf } from '../splineEditor/model';
import { createHoverReadout } from './hoverPanel';
import { browserStorage, createLayout } from './layout';
import { createMapCanvas } from './mapView';
import { applyMapHash, decodeMapState, encodeMapState, type MapView } from './mapState';
import { createPreviewDriver, type DriverClock, type DriverDraft, type PreviewDriver } from './previewDriver';
import { createToolbar } from './toolbar';

/** A click this close to the cut line (screen px) shows its profile instead of pinning the point. */
const LINE_HIT_PX = 6;
const draftOf = (s: SessionState): DriverDraft => ({ sessionEpoch: s.epoch, seedText: s.seedText, seedKey: `${s.seed[0]}.${s.seed[1]}`, params: s.params });
const spawnText = (sp: Spawn): string => `${sp.x}, ${sp.z} (y ${sp.y}, ${biomeName(sp.biome)}${sp.fallback ? ', fallback' : ''})`;

export async function mountMapPage(root: HTMLElement): Promise<void> {
  // The latency hook is a chunk of its own, loaded only for the §2.8 runner.
  const perf = new URLSearchParams(location.search).get('perf') === 'edit' ? (await import('./perfHook')).createPerfHook() : null;
  const decoded = decodeMapState(location.hash);
  const initial = perf?.initialState(decoded.state) ?? decoded.state;
  const session = new WorldSession(cryptoSeed, { seedText: initial.seed, profile: initial.profile, patch: initial.patch });
  let view: MapView = initial.view;

  const layout = createLayout(root, browserStorage());
  perf?.pin(layout.map);
  const notices = createNotices(layout.notices);
  const startNotice = decoded.error ?? session.initNotice;
  if (startNotice !== null) notices.show(startNotice, { kind: 'warn' });
  const browserPool = createBrowserPool(undefined, { onFailure: () => notices.show('a worker failed; reload the page', { kind: 'error' }) });
  const pool = perf?.instrument(browserPool) ?? browserPool;
  if (!pool.abortable) notices.show('live preview is slower without cross-origin isolation', { kind: 'info' });
  const url = createUrlWriter((u) => history.replaceState(null, '', u));
  addEventListener('pagehide', () => url.flush());
  const writeUrl = () => {
    const s = session.state;
    url.set(`?map#${encodeMapState({ v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view })}`);
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
  // profile and any other click pins the point.
  let cut: CutTool = CUT_OFF;
  let cutPointer: CutPoint | null = null;
  const canvas = createMapCanvas(layout.map, pool, view, {
    onView: (v) => { view = v; canvas.setView(v); writeUrl(); renderStatus(); },
    onHover: (x, z) => {
      hover.move(x, z);
      if (cut.mode !== 'b') return;
      cutPointer = [x, z];
      drawCut();
    },
    onClick: (x, z) => {
      if (cut.mode !== 'off') cutAt(x, z);
      else if (section.line !== null && segmentDistance(section.line, x, z) <= LINE_HIT_PX * view.bpp) layout.openDrawer('section');
      else canvas.setPin([x, z]);
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
  });

  // The hover readout shows points of the canvas source's pool epoch only (§2.5).
  let shownEpoch: number | null = null;
  driver.onStatus((st) => {
    toolbar.setStatus(st);
    if (st.poolEpoch !== shownEpoch) {
      shownEpoch = st.poolEpoch;
      hover.refresh();
    }
  });
  session.subscribe((s, change) => {
    driver.change(draftOf(s), change, inputAt ?? performance.now());
    toolbar.sync();
    writeUrl();
    renderStatus();
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
  function cutAt(x: number, z: number): void {
    const step = cutClick(cut, x, z);
    if (step.problem !== null) notices.show(step.problem, { kind: 'warn', timeoutMs: 4000 });
    if (step.line !== null) section.setLine(step.line);
    setCut(step.tool);
    if (step.line !== null) layout.openDrawer('section');
  }
  // A tab that comes on screen catches up: the spline drawer renders and requests its statistics, the
  // cross-section requests its profile.
  layout.onDrawerChange(() => {
    if (layout.drawerOpen && layout.drawerTab === 'spline' && splines.leaf !== null) splines.open(splines.leaf);
    section.shown();
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
  driver.change(draftOf(session.state), { kind: 'load', urgent: true, gesture: false }, performance.now());
  toolbar.setStatus(driver.status);
  writeUrl();
  renderStatus();
  perf?.attach({ session, canvas, driver, host: layout.map, view: () => view, editAt });
}

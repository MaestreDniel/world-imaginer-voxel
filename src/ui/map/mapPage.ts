/**
 * The ?map editor page (SP2b spec §3.1): the composition of the layout (toolbar, notices, map, side panel
 * tabs, drawer), the WorldSession that owns the draft, the preview driver that turns its changes into
 * configure cycles (§2.6), the map canvas, the URL (§1.4: written on every change, read on `hashchange`)
 * and the global shortcuts (§3.5). The World tab shows the session status, the spawn and the hover readout
 * (§3.3); the Parameters, Biomes and Presets tabs are the hosts their editors mount into.
 */
import './map.css';
import { WorldSession, type SessionState } from '../../engine/session';
import { createBrowserPool } from '../../engine/workerPool';
import { biomeName } from '../../gen/biomes/registry';
import type { Spawn } from '../../gen/column/spawn';
import { el } from '../common/dom';
import { installShortcuts } from '../common/keys';
import { createNotices } from '../common/notice';
import { createUrlWriter } from '../common/urlWriter';
import { cryptoSeed } from '../seedBox';
import { createHoverReadout } from './hoverPanel';
import { browserStorage, createLayout } from './layout';
import { createMapCanvas } from './mapView';
import { applyMapHash, decodeMapState, encodeMapState, type MapView } from './mapState';
import { createPreviewDriver, type DriverClock, type DriverDraft, type PreviewDriver } from './previewDriver';
import { createToolbar } from './toolbar';

const draftOf = (s: SessionState): DriverDraft => ({ sessionEpoch: s.epoch, seedText: s.seedText, seedKey: `${s.seed[0]}.${s.seed[1]}`, params: s.params });
const spawnText = (sp: Spawn): string => `${sp.x}, ${sp.z} (y ${sp.y}, ${biomeName(sp.biome)}${sp.fallback ? ', fallback' : ''})`;

export function mountMapPage(root: HTMLElement): void {
  const decoded = decodeMapState(location.hash);
  const initial = decoded.state;
  const session = new WorldSession(cryptoSeed, { seedText: initial.seed, profile: initial.profile, patch: initial.patch });
  let view: MapView = initial.view;

  const layout = createLayout(root, browserStorage());
  const notices = createNotices(layout.notices);
  const startNotice = decoded.error ?? session.initNotice;
  if (startNotice !== null) notices.show(startNotice, { kind: 'warn' });
  const pool = createBrowserPool(undefined, { onFailure: () => notices.show('a worker failed; reload the page', { kind: 'error' }) });
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
  const edit = (e: Event, fn: () => void) => {
    inputAt = e.timeStamp;
    try { fn(); } finally { inputAt = null; }
  };

  const canvas = createMapCanvas(layout.map, pool, view, {
    onView: (v) => { view = v; canvas.setView(v); writeUrl(); renderStatus(); },
    onHover: (x, z) => hover.move(x, z),
    onClick: (x, z) => { canvas.setPin([x, z]); },
    onPreviewProgress: (epoch, drawn, visible) => driver.previewProgress(epoch, drawn, visible),
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

  const setView = (v: MapView) => {
    view = v;
    canvas.setView(v);
    toolbar.setLayer(v.layer);
    renderStatus();
  };
  const toolbar = createToolbar(layout.toolbar, {
    session, notices, layer: view.layer, edit,
    onLayer: (layer) => { setView({ ...view, layer }); writeUrl(); },
    onGrid: (on) => canvas.setGrid(on),
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

  installShortcuts((a) => {
    if (a === 'undo') session.undo();
    else if (a === 'redo') session.redo();
    else if (a === 'togglePanel') layout.togglePanel();
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
}

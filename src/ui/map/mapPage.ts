/**
 * The standalone ?map editor page (SP2b spec §3.1; SP4c spec §1.4): the shell around the map tool (`mapTool.ts`, which
 * holds the editor itself). The shell keeps what is the page's: it decodes the hash, opens the WorldSession that owns
 * the draft, its own pool, the preview driver that turns the session's changes into configure cycles (§2.6) over a
 * replaying canvas the tool attaches to (SP4c spec §4.2), the URL (§1.4: written on every change, read on
 * `hashchange`) and the undo and redo shortcuts (§3.5; the tool installs P and Escape); then it mounts the tool
 * (`host: 'page'`) and starts the first cycle. `?map&perf=edit` also loads the latency hook (§2.8, `perfHook.ts`),
 * which pins the canvas and the world.
 */
import { createBrowserPool } from '../../engine/workerPool';
import { installShortcuts } from '../common/keys';
import type { Notices } from '../common/notice';
import { createUrlWriter, oversizeNotice } from '../common/urlWriter';
import { cryptoSeed } from '../seedBox';
import { browserStorage } from './layout';
import { applyMapHash, decodeMapState, encodeMapState, openMapSession } from './mapState';
import { createMapTool } from './mapTool';
import { createPreviewDriver, createReplayingCanvas, draftOf, type DriverClock, type PreviewDriver } from './previewDriver';

export async function mountMapPage(root: HTMLElement): Promise<void> {
  // The latency hook is a chunk of its own, loaded only for the §2.8 runner.
  const perf = new URLSearchParams(location.search).get('perf') === 'edit' ? (await import('./perfHook')).createPerfHook() : null;
  const decoded = decodeMapState(location.hash);
  const initial = perf?.initialState(decoded.state) ?? decoded.state;
  // Tier 2 of the trees runs in the session (SP3d spec §1.8): a link with an invalid tree opens the defaults.
  const session = openMapSession(initial, cryptoSeed);

  /** The tool's notice row, once mounted (a worker can only fail after the first configure, which follows the mount). */
  let notices: Notices | null = null;
  const browserPool = createBrowserPool(undefined, { onFailure: () => notices?.show('a worker failed; reload the page', { kind: 'error' }) });
  const pool = perf?.instrument(browserPool) ?? browserPool;
  const clock: DriverClock = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
  // The driver pushes into a replaying sink (SP4c spec §4.2), which the tool attaches its canvas to.
  const relay = createReplayingCanvas();
  const driver: PreviewDriver = createPreviewDriver(pool, relay, clock);
  // The latency hook hears each canvas progress report before the driver does (§2.8).
  const toolDriver: PreviewDriver = perf === null ? driver : {
    change: (d, c, at) => driver.change(d, c, at),
    previewProgress: (epoch, drawn, visible) => {
      perf.drawn(epoch, drawn, visible);
      driver.previewProgress(epoch, drawn, visible);
    },
    onSettled: (fn) => driver.onSettled(fn),
    onStatus: (fn) => driver.onStatus(fn),
    get status() { return driver.status; },
    adopt: (a) => driver.adopt(a),
    setPreviewWanted: (on) => driver.setPreviewWanted(on),
    onConfigured: (fn) => driver.onConfigured(fn),
    dispose: () => driver.dispose(),
  };

  // A draft whose URL is over the cap is not written; the notice stays until one fits (SP3d spec §1.12).
  const url = createUrlWriter((u) => history.replaceState(null, '', u), undefined, undefined, (oversize) => {
    if (notices !== null) oversizeNotice(notices)(oversize);
  });
  addEventListener('pagehide', () => url.flush());

  const tool = createMapTool(root, {
    session, pool, driver: toolDriver, relay, storage: browserStorage(), initialView: initial.view,
    host: 'page', urlSink: (hash) => url.set(`?map#${hash}`), onView: null, onTeleport: null, toolbarSlot: null,
    shortcutsEnabled: () => true,
    onMounted: perf === null ? undefined : (parts) => {
      perf.pin(parts.host);
      perf.attach({ session, driver, ...parts });
    },
  });
  notices = tool.notices;
  const startNotice = decoded.error ?? session.initNotice;
  if (startNotice !== null) tool.notices.show(startNotice, { kind: 'warn' });
  if (!pool.abortable) tool.notices.show('live preview is slower without cross-origin isolation', { kind: 'info' });

  /** The map's URL: the session's draft and the tool's view. */
  const writeUrl = () => {
    const s = session.state;
    url.set(`?map#${encodeMapState({ v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view: tool.view })}`);
  };
  installShortcuts((a) => {
    if (a === 'undo') session.undo();
    else if (a === 'redo') session.redo();
  }, (a) => a === 'undo' || a === 'redo');
  addEventListener('hashchange', () => {
    const problem = applyMapHash(location.hash, session, (v) => tool.setView(v));
    if (problem !== null) tool.notices.show(problem, { kind: 'warn' });
    writeUrl();
  });

  // The first cycle is an urgent load (Task 10); the URL is rewritten in canonical form.
  driver.change(draftOf(session.state), { kind: 'load', urgent: true, gesture: false }, performance.now());
  writeUrl();
}

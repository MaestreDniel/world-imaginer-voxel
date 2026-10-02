/**
 * The ?map page (SP2a spec §6): WorldSession + worker pool + map canvas, with the seed box, the ready
 * profiles, a JSON patch box, a layer select, the hover readout, the spawn and the first-image timing.
 */
import './map.css';
import { PROFILE_IDS, isProfileReady, type ProfileId } from '../../core/params/profiles';
import { canonicalJSON } from '../../core/params/canonical';
import { biomeName } from '../../gen/biomes/registry';
import { LAYERS, isLayerId } from '../../gen/map/layers';
import { WorldSession } from '../../engine/session';
import { createBrowserPool, JobCancelled } from '../../engine/workerPool';
import { el } from '../common/dom';
import { createNotices } from '../common/notice';
import { createUrlWriter } from '../common/urlWriter';
import { cryptoSeed } from '../seedBox';
import { formatPoint } from './hoverPanel';
import { createMapCanvas } from './mapView';
import { decodeMapState, encodeMapState, type MapState, type MapView } from './mapState';

export function mountMapPage(root: HTMLElement): void {
  const decoded = decodeMapState(location.hash);
  const initial = decoded.state;
  const session = new WorldSession(cryptoSeed, { seedText: initial.seed, profile: initial.profile, patch: initial.patch });
  let view: MapView = initial.view;

  const page = el('div', 'map');
  const header = el('div', 'map-header');
  header.append(el('strong', '', 'world-imaginer-voxel · map'));
  const noticeHost = el('div', 'map-notices');
  header.append(noticeHost);
  const notices = createNotices(noticeHost);
  const startNotice = decoded.error ?? session.initNotice;
  if (startNotice !== null) notices.show(startNotice, { kind: 'warn' });
  const toolbar = el('div', 'map-toolbar');
  const host = el('div', 'map-view');
  const side = el('div', 'map-side');
  page.append(header, toolbar, host, side);
  root.replaceChildren(page);

  const layerSelect = el('select');
  for (const l of LAYERS) layerSelect.append(new Option(l, l));
  const seedInput = el('input');
  seedInput.placeholder = 'seed (empty = random)';
  const profileSelect = el('select');
  for (const p of PROFILE_IDS) if (isProfileReady(p)) profileSelect.append(new Option(p, p));
  const patchBox = el('textarea');
  patchBox.spellcheck = false;
  const applyBtn = el('button', '', 'apply patch');
  const gridBox = el('input');
  gridBox.type = 'checkbox';
  const gridLabel = el('label', '', 'grid ');
  gridLabel.append(gridBox);
  toolbar.append(layerSelect, seedInput, profileSelect, patchBox, applyBtn, gridLabel);

  const issues = el('div', 'map-issues');
  const status = el('div', 'map-readout');
  const hover = el('div', 'map-readout');
  side.append(el('h3', '', 'World'), status, issues, el('h3', '', 'Point'), hover);

  const pool = createBrowserPool(undefined, { onFailure: () => notices.show('a worker failed; reload the page', { kind: 'error' }) });
  if (!pool.abortable) notices.show('live preview is slower without cross-origin isolation', { kind: 'info' });
  const url = createUrlWriter((u) => history.replaceState(null, '', u));
  addEventListener('pagehide', () => url.flush());
  let firstImageMs: number | null = null;
  let spawnText = '';

  const state = (): MapState => {
    const s = session.state;
    return { v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view };
  };
  const writeUrl = () => url.set(`?map#${encodeMapState(state())}`);
  const renderStatus = () => {
    const s = session.state;
    status.textContent = [
      `seed ${s.seedText}`, `profile ${s.profile}`, `epoch ${s.epoch}  workers ${pool.size}`,
      `view x ${view.x.toFixed(0)} z ${view.z.toFixed(0)}  ${view.bpp.toFixed(2)} blocks/px`,
      spawnText, firstImageMs === null ? 'first image …' : `first image ${firstImageMs.toFixed(0)} ms`,
    ].join('\n');
  };

  const canvas = createMapCanvas(host, pool, view, {
    onView: (v) => { view = v; canvas.setView(v); writeUrl(); renderStatus(); },
    onHover: (() => {
      let busy = false;
      let next: [number, number] | null = null;
      const run = (x: number, z: number) => {
        busy = true;
        pool.point(x, z).then((p) => { hover.textContent = formatPoint(p); })
          .catch((e: unknown) => { if (!(e instanceof JobCancelled)) hover.textContent = String(e); })
          .finally(() => { busy = false; if (next !== null) { const [a, b] = next; next = null; run(a, b); } });
      };
      return (x: number, z: number) => { if (busy) next = [x, z]; else run(x, z); };
    })(),
    onClick: (x, z) => { canvas.setPin([x, z]); },
    onFirstImage: (ms) => { if (firstImageMs === null) { firstImageMs = ms; renderStatus(); } },
  });

  const reconfigure = () => {
    const s = session.state;
    seedInput.value = s.seedText;
    profileSelect.value = s.profile;
    patchBox.value = canonicalJSON(s.patch);
    spawnText = 'spawn …';
    renderStatus();
    writeUrl();
    canvas.setSpawn(null);
    canvas.clearSource();
    pool.configure(s.seedText, s.params).then((ready) => {
      canvas.setSource(ready.epoch, `${s.seed[0]}.${s.seed[1]}`, ready.stageHashes as Record<string, string>);
      return pool.spawn();
    }).then((sp) => {
      canvas.setSpawn(sp);
      spawnText = `spawn ${sp.x}, ${sp.z} (y ${sp.y}, ${biomeName(sp.biome)}${sp.fallback ? ', fallback' : ''})`;
      renderStatus();
    }).catch((e: unknown) => { if (!(e instanceof JobCancelled)) issues.textContent = String(e); });
  };

  layerSelect.value = view.layer;
  layerSelect.addEventListener('change', () => {
    if (isLayerId(layerSelect.value)) { view = { ...view, layer: layerSelect.value }; canvas.setView(view); writeUrl(); }
  });
  seedInput.addEventListener('change', () => {
    const before = session.state.epoch;
    session.setSeedText(seedInput.value);
    if (session.state.epoch !== before) reconfigure(); else seedInput.value = session.state.seedText;
  });
  const switchProfile = (id: ProfileId): boolean => {
    const r = session.setProfile(id);
    if (!r.ok) { issues.textContent = r.issues.map((i) => i.message).join('\n'); return false; }
    issues.textContent = '';
    reconfigure();
    return true;
  };
  profileSelect.addEventListener('change', () => {
    const id = profileSelect.value as ProfileId;
    const n = session.modifiedCount('');
    if (n === 0) { switchProfile(id); return; }
    // The select keeps showing the session's profile until Switch; a newer choice replaces the confirmation.
    profileSelect.value = session.state.profile;
    void notices.confirm(`Switching to ${id} clears ${n} modified parameter${n === 1 ? '' : 's'}`, 'Switch').then((ok) => {
      if (ok && switchProfile(id)) notices.show('profile switched', { timeoutMs: 5000 });
    });
  });
  applyBtn.addEventListener('click', () => {
    let patch: unknown;
    try { patch = JSON.parse(patchBox.value.trim() === '' ? '{}' : patchBox.value); } catch (e) {
      issues.textContent = `patch is not JSON: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const before = session.state.epoch;
    const r = session.load({ profile: session.state.profile, patch });
    if (!r.ok) { issues.textContent = r.issues.map((i) => `${i.path}: ${i.code} — ${i.message}`).join('\n'); return; }
    issues.textContent = '';
    if (session.state.epoch !== before) reconfigure(); else writeUrl();
  });
  gridBox.addEventListener('change', () => canvas.setGrid(gridBox.checked));
  reconfigure();
}

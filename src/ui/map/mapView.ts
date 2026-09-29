/**
 * The map canvas (SP2a spec §6.1, §6.3): draws cached tiles (preview level first, then the view's level
 * on top), asks the pool for missing tiles coarse-first, pans by drag, zooms around the cursor, and draws
 * the spawn marker, a grid and the pinned point.
 */
import { MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { Spawn } from '../../gen/column/spawn';
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import { MAP_MAX_BPP, MAP_MIN_BPP, type MapView } from './mapState';
import { createTileCache } from './tileCache';
import { createTileSource } from './tileSource';
import { planTiles, screenToWorld, visibleTiles, worldToScreen } from './viewMath';

export interface MapViewOptions {
  onView(v: MapView): void;
  onHover(x: number, z: number): void;
  onClick(x: number, z: number): void;
  /** Called once when every preview tile of the current view has been drawn after setSource. */
  onFirstImage(ms: number): void;
}

export interface MapCanvas {
  setView(v: MapView): void;
  /** The pool finished configuring `epoch`: the seed words and the stage hashes (hex) by stage id. */
  setSource(epoch: number, seedKey: string, hashes: Readonly<Record<string, string>>): void;
  /** A reconfigure started: stop requesting and drawing until the next setSource. */
  clearSource(): void;
  setSpawn(s: Spawn | null): void;
  setPin(p: [number, number] | null): void;
  setGrid(on: boolean): void;
  destroy(): void;
}

const WINDOW = 524288;
const clampCentre = (v: number) => Math.max(-WINDOW, Math.min(WINDOW, v));

export function createMapCanvas(host: HTMLElement, pool: WorkerPool, initial: MapView, opts: MapViewOptions): MapCanvas {
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  host.append(canvas);
  const ctx2d = canvas.getContext('2d');
  if (ctx2d === null) throw new Error('2D canvas unavailable');
  let view = initial;
  let spawn: Spawn | null = null;
  let pin: [number, number] | null = null;
  let grid = false;
  let raf = 0;
  let firstStart = 0;
  const cache = createTileCache<ImageBitmap>(256, (b) => b.close());
  const pending = new Set<string>();

  const source = createTileSource();
  const keyOf = (layer: MapView['layer'], level: MapLevel, tx: number, tz: number) => source.keyFor(layer, level, tx, tz, pool.epoch);

  const request = () => {
    const w = canvas.width;
    const h = canvas.height;
    const plan = planTiles(view, w, h);
    const wanted = new Set(plan.map((t) => keyOf(view.layer, t.level, t.tx, t.tz)));
    pool.cancelTiles((r) => { const k = keyOf(r.layer, r.level, r.tx, r.tz); return k === null || !wanted.has(k); });
    for (const t of plan) {
      const key = keyOf(view.layer, t.level, t.tx, t.tz);
      if (key === null) return;
      if (pending.has(key) || cache.get(key) !== undefined) continue;
      pending.add(key);
      const layer = view.layer;
      pool.tile({ layer, level: t.level, tx: t.tx, tz: t.tz }, t.priority)
        .then((buf) => createImageBitmap(new ImageData(new Uint8ClampedArray(buf), MAP_TILE_PX, MAP_TILE_PX)))
        .then((bmp) => { cache.set(key, bmp); schedule(); })
        .catch((e: unknown) => { if (!(e instanceof JobCancelled)) console.error(e); })
        .finally(() => pending.delete(key));
    }
  };

  const drawLevel = (level: MapLevel): number => {
    const w = canvas.width;
    const h = canvas.height;
    const span = MAP_TILE_PX * level;
    let missing = 0;
    for (const t of visibleTiles(view, w, h, level)) {
      const key = keyOf(view.layer, level, t.tx, t.tz);
      const bmp = key === null ? undefined : cache.get(key);
      if (bmp === undefined) { missing++; continue; }
      const [sx, sy] = worldToScreen(view, w, h, t.tx * span, t.tz * span);
      const size = span / view.bpp;
      ctx2d.drawImage(bmp, Math.floor(sx), Math.floor(sy), Math.ceil(size) + 1, Math.ceil(size) + 1);
    }
    return missing;
  };

  const drawOverlays = () => {
    const w = canvas.width;
    const h = canvas.height;
    if (grid) {
      let step = 16;
      while (step / view.bpp < 48) step *= 2;
      const [x0, z0] = screenToWorld(view, w, h, 0, 0);
      const [x1, z1] = screenToWorld(view, w, h, w, h);
      ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx2d.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const [sx] = worldToScreen(view, w, h, x, 0); ctx2d.moveTo(sx + 0.5, 0); ctx2d.lineTo(sx + 0.5, h); }
      for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) { const [, sy] = worldToScreen(view, w, h, 0, z); ctx2d.moveTo(0, sy + 0.5); ctx2d.lineTo(w, sy + 0.5); }
      ctx2d.stroke();
    }
    const marker = (x: number, z: number, colour: string) => {
      const [sx, sy] = worldToScreen(view, w, h, x, z);
      ctx2d.strokeStyle = colour;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(sx, sy, 6, 0, 2 * Math.PI);
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
    };
    if (spawn !== null) marker(spawn.x, spawn.z, '#ff3b30');
    if (pin !== null) marker(pin[0], pin[1], '#ffd60a');
  };

  const draw = () => {
    raf = 0;
    ctx2d.fillStyle = '#15171b';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    const missingPreview = drawLevel(256);
    const target = planTiles(view, canvas.width, canvas.height).find((t) => t.level !== 256)?.level;
    if (target !== undefined) drawLevel(target);
    drawOverlays();
    if (firstStart > 0 && missingPreview === 0 && keyOf(view.layer, 256, 0, 0) !== null) {
      opts.onFirstImage(performance.now() - firstStart);
      firstStart = 0;
    }
  };
  const schedule = () => { if (raf === 0) raf = requestAnimationFrame(draw); };

  const resize = () => {
    const w = Math.max(1, Math.floor(host.clientWidth));
    const h = Math.max(1, Math.floor(host.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; request(); schedule(); }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  let drag: { x: number; y: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.offsetX, y: e.offsetY, moved: false }; canvas.setPointerCapture(e.pointerId); });
  const endDrag = (e: PointerEvent) => {
    if (drag !== null && !drag.moved) { const [x, z] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY); opts.onClick(x, z); }
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointermove', (e) => {
    const [x, z] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY);
    opts.onHover(x, z);
    if (drag === null) return;
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) drag.moved = true;
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    opts.onView({ ...view, x: clampCentre(view.x - dx * view.bpp), z: clampCentre(view.z - dy * view.bpp) });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY === 0) return;
    const [ax, az] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY);
    const bpp = Math.max(MAP_MIN_BPP, Math.min(MAP_MAX_BPP, view.bpp * (e.deltaY > 0 ? 1.25 : 0.8)));
    const k = bpp / view.bpp;
    opts.onView({ ...view, x: clampCentre(ax - (ax - view.x) * k), z: clampCentre(az - (az - view.z) * k), bpp });
  }, { passive: false });

  resize();
  return {
    setView(v) { view = v; request(); schedule(); },
    setSource(epoch, seed, h) { source.set(epoch, seed, h); firstStart = performance.now(); request(); schedule(); },
    clearSource() { source.clear(); schedule(); },
    setSpawn(s) { spawn = s; schedule(); },
    setPin(p) { pin = p; schedule(); },
    setGrid(on) { grid = on; schedule(); },
    destroy() { cancelAnimationFrame(raf); observer.disconnect(); cache.clear(); canvas.remove(); },
  };
}

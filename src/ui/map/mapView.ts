/**
 * The map canvas (SP2a spec §6.1, §6.3; SP2b spec §2.5-2.7, §5.3): draws cached tiles (preview level
 * first, then the view's level on top), keeps showing the last drawn tile of each position until the
 * current source's tile lands there (fallback tiles), asks the pool for missing tiles coarse-first (only
 * preview tiles while interactive), reports preview progress to the preview driver, dims all biomes but a
 * highlighted one, pans by drag, zooms around the cursor, and draws the spawn marker, a grid and the pin.
 */
import { MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { Spawn } from '../../gen/column/spawn';
import { levelFor } from '../../gen/map/tile';
import { JobCancelled, WorkerFailed, type WorkerPool } from '../../engine/workerPool';
import { tileCacheCapacity, TILE_CACHE_MIN } from './capacity';
import { createFallbacks, type LevelTiles, type TileDraw } from './fallback';
import { highlightMask } from './highlight';
import { MAP_MAX_BPP, MAP_MIN_BPP, type MapView } from './mapState';
import { createTileCache } from './tileCache';
import { createTileSource } from './tileSource';
import { planTiles, screenToWorld, visibleTiles, worldToScreen } from './viewMath';

export interface MapViewOptions {
  onView(v: MapView): void;
  onHover(x: number, z: number): void;
  onClick(x: number, z: number): void;
  /**
   * Every draw while the source matches the pool's epoch (SP2b spec §2.5-2.6): the length of the longest
   * nearest-first prefix of the visible level-256 positions showing the source's tiles, and their count.
   * The page passes it to the preview driver's `previewProgress`.
   */
  onPreviewProgress(poolEpoch: number, nearestDrawn: number, visible: number): void;
}

export interface MapCanvas {
  setView(v: MapView): void;
  /** The pool finished configuring `epoch`: the seed words and the stage hashes (hex) by stage id. */
  setSource(epoch: number, seedKey: string, hashes: Readonly<Record<string, string>>): void;
  /** The interactive plan (SP2b spec §2.6): while on, only level-256 tiles are requested. */
  setInteractive(on: boolean): void;
  setSpawn(s: Spawn | null): void;
  setPin(p: [number, number] | null): void;
  setGrid(on: boolean): void;
  /** Dims every biome but `id` on the biome layer's tiles (SP2b spec §5.3); null ends the highlight. */
  highlightBiome(id: number | null): void;
  /** Blank draws since the first image (SP2b spec §2.8), for the latency hook. */
  readonly blankDraws: number;
  destroy(): void;
}

/** A cached tile: the bitmap, and for the biome layer the biome id of every pixel (SP2b spec §5.3). */
interface CachedTile { readonly bitmap: ImageBitmap; readonly ids: Uint8Array | null }

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
  let interactive = false;
  let highlight: number | null = null;
  const fallbacks = createFallbacks();
  /** Highlight masks of the highlighted biome only, by tile key. */
  const masks = new Map<string, OffscreenCanvas>();
  const cache = createTileCache<CachedTile>(TILE_CACHE_MIN, (t, key) => {
    t.bitmap.close();
    masks.delete(key);
    fallbacks.evicted(key);
  });
  const pending = new Set<string>();

  const source = createTileSource();
  const keyOf = (layer: MapView['layer'], level: MapLevel, tx: number, tz: number) => source.keyFor(layer, level, tx, tz, pool.epoch);
  const fitCache = () => cache.setCapacity(tileCacheCapacity(view, canvas.width, canvas.height));

  const request = () => {
    const w = canvas.width;
    const h = canvas.height;
    const plan = planTiles(view, w, h, interactive);
    const wanted = new Set(plan.map((t) => keyOf(view.layer, t.level, t.tx, t.tz)));
    pool.cancelTiles((r) => { const k = keyOf(r.layer, r.level, r.tx, r.tz); return k === null || !wanted.has(k); });
    for (const t of plan) {
      const key = keyOf(view.layer, t.level, t.tx, t.tz);
      if (key === null) return;
      if (pending.has(key) || cache.get(key) !== undefined) continue;
      pending.add(key);
      const layer = view.layer;
      pool.tile({ layer, level: t.level, tx: t.tx, tz: t.tz }, t.priority)
        .then(async (r) => {
          const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba), MAP_TILE_PX, MAP_TILE_PX));
          cache.set(key, { bitmap, ids: r.ids === null ? null : new Uint8Array(r.ids) });
          schedule();
        })
        // A failed worker is reported once by the page's notice (SP2b spec §2.3), not per tile.
        .catch((e: unknown) => { if (!(e instanceof JobCancelled) && !(e instanceof WorkerFailed)) console.error(e); })
        .finally(() => pending.delete(key));
    }
  };

  /** The mask of a biome tile for the highlighted biome, built once per tile key (≈ 0.2 ms). */
  const maskFor = (key: string, ids: Uint8Array, biome: number): OffscreenCanvas | null => {
    const had = masks.get(key);
    if (had !== undefined) return had;
    const mask = new OffscreenCanvas(MAP_TILE_PX, MAP_TILE_PX);
    const g = mask.getContext('2d');
    if (g === null) return null;
    g.putImageData(new ImageData(highlightMask(ids, biome), MAP_TILE_PX, MAP_TILE_PX), 0, 0);
    masks.set(key, mask);
    return mask;
  };

  const drawTile = (d: TileDraw<CachedTile>) => {
    const w = canvas.width;
    const h = canvas.height;
    const span = MAP_TILE_PX * d.level;
    const [sx, sy] = worldToScreen(view, w, h, d.tx * span, d.tz * span);
    const x = Math.floor(sx);
    const y = Math.floor(sy);
    const size = Math.ceil(span / view.bpp) + 1;
    ctx2d.drawImage(d.tile.bitmap, x, y, size, size);
    if (highlight === null || d.tile.ids === null) return;
    const mask = maskFor(d.key, d.tile.ids, highlight);
    if (mask !== null) ctx2d.drawImage(mask, x, y, size, size);
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
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.fillStyle = '#15171b';
    ctx2d.fillRect(0, 0, w, h);
    const preview = visibleTiles(view, w, h, 256);
    const target = levelFor(view.bpp);
    const levels: LevelTiles[] = [{ level: 256, tiles: preview }];
    if (target !== 256) levels.push({ level: target, tiles: visibleTiles(view, w, h, target) });
    const frame = fallbacks.frame(view.layer, levels, (level, tx, tz) => keyOf(view.layer, level, tx, tz), (k) => cache.get(k));
    for (const d of frame.draws) drawTile(d);
    drawOverlays();
    const epoch = source.epoch;
    if (epoch !== null && epoch === pool.epoch) opts.onPreviewProgress(epoch, frame.nearestCurrent, preview.length);
  };
  const schedule = () => { if (raf === 0) raf = requestAnimationFrame(draw); };

  const resize = () => {
    const w = Math.max(1, Math.floor(host.clientWidth));
    const h = Math.max(1, Math.floor(host.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; fitCache(); request(); schedule(); }
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
    setView(v) { view = v; fitCache(); request(); schedule(); },
    setSource(epoch, seed, h) { source.set(epoch, seed, h); masks.clear(); request(); schedule(); },
    setInteractive(on) {
      if (on === interactive) return;
      interactive = on;
      request();
    },
    setSpawn(s) { spawn = s; schedule(); },
    setPin(p) { pin = p; schedule(); },
    setGrid(on) { grid = on; schedule(); },
    highlightBiome(id) {
      if (id === highlight) return;
      highlight = id;
      masks.clear();
      schedule();
    },
    get blankDraws() { return fallbacks.blankDraws; },
    destroy() { cancelAnimationFrame(raf); observer.disconnect(); cache.clear(); masks.clear(); canvas.remove(); },
  };
}

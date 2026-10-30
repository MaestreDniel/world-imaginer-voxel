/**
 * The map canvas (SP2a spec §6.1, §6.3; SP2b spec §2.5-2.7, §5.3): draws cached tiles (preview level
 * first, then the view's level on top), keeps showing the last drawn tile of each position until the
 * current source's tile lands there (fallback tiles), asks the pool for missing tiles coarse-first (only
 * preview tiles while interactive), reports preview progress to the preview driver, dims all biomes but a
 * highlighted one, pans by drag, zooms around the cursor, and draws the spawn marker, a grid, the pin, the
 * cross-section's cut line (SP2b spec §4.5) and the Density tab's horizontal-plane square (SP3d spec §3.7). In the
 * world (SP4c spec §1.3, §1.5) it draws the player's arrow on top, and while hidden it plans and draws nothing; in a
 * saved world, the places as coloured dots under the spawn, the pin and the arrow (SP5b spec §3.7, D13).
 */
import { MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { Spawn } from '../../gen/column/spawn';
import { levelFor } from '../../gen/map/tile';
import type { CutOverlay } from '../crossSection/model';
import { JobCancelled, WorkerFailed, type TileRequest, type WorkerPool } from '../../engine/workerPool';
import { tileCacheCapacity, TILE_CACHE_MIN } from './capacity';
import { createFallbacks, type LevelTiles, type TileDraw } from './fallback';
import { highlightMask } from './highlight';
import { MAP_MAX_BPP, MAP_MIN_BPP, type MapView } from './mapState';
import { createTileCache } from './tileCache';
import { createTileSource } from './tileSource';
import { arrowGeometry, arrowRedrawWanted, clampCentre, drawPlaceDots, planTiles, screenToWorld, visibleTiles, worldToScreen } from './viewMath';

export interface MapViewOptions {
  onView(v: MapView): void;
  onHover(x: number, z: number): void;
  /** A pointerup without movement since pointerdown; `shift` is the event's `shiftKey` (SP4c spec §3.1). */
  onClick(x: number, z: number, shift: boolean): void;
  /**
   * Every draw while the source matches the pool's epoch (SP2b spec §2.5-2.6): the length of the longest
   * nearest-first prefix of the visible level-256 positions showing the source's tiles, and their count.
   * The page passes it to the preview driver's `previewProgress`.
   */
  onPreviewProgress(poolEpoch: number, nearestDrawn: number, visible: number): void;
}

/** The horizontal slice plane's square (SP3d spec §4.2): the blocks [cx − E/2, cx + E/2) × [cz − E/2, cz + E/2). */
export interface MapSquare {
  readonly cx: number;
  readonly cz: number;
  /** The side E in blocks. */
  readonly extent: number;
}

export interface MapCanvas {
  setView(v: MapView): void;
  /** The pool finished configuring `epoch`: the seed words and the stage hashes (hex) by stage id. */
  setSource(epoch: number, seedKey: string, hashes: Readonly<Record<string, string>>): void;
  /** The interactive plan (SP2b spec §2.6): while on, only level-256 tiles are requested. */
  setInteractive(on: boolean): void;
  setSpawn(s: Spawn | null): void;
  setPin(p: [number, number] | null): void;
  /**
   * The saved places, each a dot in `colours[colour]` with a white rim (SP5b spec §3.7, D13; `drawPlaceDots`), drawn on
   * the next scheduled draw and on every draw after it; an empty list draws none.
   */
  setPlaces(list: readonly { x: number; z: number; colour: number }[], colours: readonly string[]): void;
  setGrid(on: boolean): void;
  /** Dims every biome but `id` on the biome layer's tiles (SP2b spec §5.3); null ends the highlight. */
  highlightBiome(id: number | null): void;
  /** The cut line A → B (SP2b spec §4.5), dashed while pending; null removes it. */
  setCutLine(line: CutOverlay | null): void;
  /** The horizontal slice plane's square with a centre mark (SP3d spec §3.7); null removes it. */
  setSquare(square: MapSquare | null): void;
  /** A crosshair cursor while the cut-line tool waits for a click. */
  setCrosshair(on: boolean): void;
  /**
   * The player's arrow (SP4c spec §1.5): white with a 1.5 px `#111` outline, above the tiles and the overlays. Redraws
   * only when the arrow moved ≥ 1 px or turned ≥ 2° since it was last drawn (`arrowMoved`) and ≥ 33 ms after its last
   * redraw (`arrowDue`); allocates nothing.
   */
  setPlayer(x: number, z: number, yawDeg: number): void;
  /**
   * Hidden (SP4c spec §1.3): no tile requests and no draws, the tiles it queued on the pool cancelled. Shown again, it
   * re-measures its host, plans its tiles and draws.
   */
  setHidden(on: boolean): void;
  /** Blank draws since the first image (SP2b spec §2.8), for the latency hook. */
  readonly blankDraws: number;
  /**
   * Removes the canvas, cancels the tiles it queued on the pool and ignores the ones that resolve later (SP4c spec §1.2);
   * every later call does nothing.
   */
  destroy(): void;
}

/** A cached tile: the bitmap, and for the biome layer the biome id of every pixel (SP2b spec §5.3). */
interface CachedTile { readonly bitmap: ImageBitmap; readonly ids: Uint8Array | null }

/** The arrow's redraw clock (`arrowRedrawWanted` reads it only when the arrow moved). */
const now = (): number => performance.now();

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
  let cutLine: CutOverlay | null = null;
  let square: MapSquare | null = null;
  let places: readonly { x: number; z: number; colour: number }[] = [];
  let placeColours: readonly string[] = [];
  const fallbacks = createFallbacks();
  /** Highlight masks of the highlighted biome only, by tile key. */
  const masks = new Map<string, OffscreenCanvas>();
  const cache = createTileCache<CachedTile>(TILE_CACHE_MIN, (t, key) => {
    t.bitmap.close();
    masks.delete(key);
    fallbacks.evicted(key);
  });
  const pending = new Set<string>();
  /** The tile requests this canvas has on the pool (the pool keeps each request object as its job's `tile`). */
  const asked = new Set<TileRequest>();
  let destroyed = false;
  let hidden = false;
  /** The player (the last `setPlayer`), and the arrow as last drawn: position, yaw and time (ms). */
  let player = false;
  let playerX = 0;
  let playerZ = 0;
  let playerYaw = 0;
  let drawnX = 0;
  let drawnZ = 0;
  let drawnYaw = 0;
  let drawnAt = -Infinity;
  let arrowDrawn = false;
  const arrow = new Float64Array(6);

  const source = createTileSource();
  const keyOf = (layer: MapView['layer'], level: MapLevel, tx: number, tz: number) => source.keyFor(layer, level, tx, tz, pool.epoch);
  const fitCache = () => cache.setCapacity(tileCacheCapacity(view, canvas.width, canvas.height));

  const request = () => {
    if (destroyed || hidden) return;
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
      const req: TileRequest = { layer: view.layer, level: t.level, tx: t.tx, tz: t.tz };
      asked.add(req);
      pool.tile(req, t.priority)
        .then(async (r) => {
          if (destroyed) return;
          const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba), MAP_TILE_PX, MAP_TILE_PX));
          if (destroyed) { bitmap.close(); return; }
          cache.set(key, { bitmap, ids: r.ids === null ? null : new Uint8Array(r.ids) });
          schedule();
        })
        // A failed worker is reported once by the page's notice (SP2b spec §2.3), not per tile.
        .catch((e: unknown) => { if (!destroyed && !(e instanceof JobCancelled) && !(e instanceof WorkerFailed)) console.error(e); })
        .finally(() => { pending.delete(key); asked.delete(req); });
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
    if (square !== null) {
      const half = square.extent / 2;
      const [x0, y0] = worldToScreen(view, w, h, square.cx - half, square.cz - half);
      const [x1, y1] = worldToScreen(view, w, h, square.cx + half, square.cz + half);
      const [mx, my] = worldToScreen(view, w, h, square.cx, square.cz);
      ctx2d.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx2d.lineWidth = 4;
      ctx2d.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx2d.strokeStyle = '#7fd3ec';
      ctx2d.lineWidth = 2;
      ctx2d.setLineDash([6, 4]);
      ctx2d.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx2d.setLineDash([]);
      ctx2d.beginPath();
      ctx2d.moveTo(mx - 5, my);
      ctx2d.lineTo(mx + 5, my);
      ctx2d.moveTo(mx, my - 5);
      ctx2d.lineTo(mx, my + 5);
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
    }
    // Under the markers, so a pin set on a place still shows its ring.
    drawPlaceDots(ctx2d, view, w, h, places, placeColours);
    if (spawn !== null) marker(spawn.x, spawn.z, '#ff3b30');
    if (pin !== null) marker(pin[0], pin[1], '#ffd60a');
    if (cutLine !== null) {
      const [ax, ay] = worldToScreen(view, w, h, cutLine.a[0], cutLine.a[1]);
      const [bx, by] = worldToScreen(view, w, h, cutLine.b[0], cutLine.b[1]);
      ctx2d.lineCap = 'round';
      ctx2d.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx2d.lineWidth = 4;
      ctx2d.beginPath();
      ctx2d.moveTo(ax, ay);
      ctx2d.lineTo(bx, by);
      ctx2d.stroke();
      ctx2d.strokeStyle = '#ffffff';
      ctx2d.lineWidth = 2;
      ctx2d.setLineDash(cutLine.pending ? [6, 4] : []);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      ctx2d.font = 'bold 12px system-ui, sans-serif';
      ctx2d.lineWidth = 3;
      const ends: ReadonlyArray<readonly [number, number, string]> = cutLine.pending ? [[ax, ay, 'A']] : [[ax, ay, 'A'], [bx, by, 'B']];
      for (const [x, y, label] of ends) {
        ctx2d.fillStyle = '#ffffff';
        ctx2d.beginPath();
        ctx2d.arc(x, y, 3.5, 0, 2 * Math.PI);
        ctx2d.fill();
        ctx2d.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx2d.strokeText(label, x + 6, y - 6);
        ctx2d.fillText(label, x + 6, y - 6);
      }
      ctx2d.lineWidth = 1;
      ctx2d.lineCap = 'butt';
    }
  };

  /** The arrow at the player, when its centre is inside the view; records what was drawn and when. */
  const drawArrow = () => {
    if (!player) return;
    drawnX = playerX;
    drawnZ = playerZ;
    drawnYaw = playerYaw;
    drawnAt = performance.now();
    arrowDrawn = true;
    if (!arrowGeometry(playerX, playerZ, playerYaw, view, canvas.width, canvas.height, arrow)) return;
    ctx2d.beginPath();
    ctx2d.moveTo(arrow[0]!, arrow[1]!);
    ctx2d.lineTo(arrow[2]!, arrow[3]!);
    ctx2d.lineTo(arrow[4]!, arrow[5]!);
    ctx2d.closePath();
    ctx2d.fillStyle = '#ffffff';
    ctx2d.fill();
    ctx2d.strokeStyle = '#111';
    ctx2d.lineWidth = 1.5;
    ctx2d.lineJoin = 'round';
    ctx2d.stroke();
    ctx2d.lineWidth = 1;
    ctx2d.lineJoin = 'miter';
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
    drawArrow();
    const epoch = source.epoch;
    if (epoch !== null && epoch === pool.epoch) opts.onPreviewProgress(epoch, frame.nearestCurrent, preview.length);
  };
  const schedule = () => { if (raf === 0 && !destroyed && !hidden) raf = requestAnimationFrame(draw); };

  /** Re-measures the host; true when the canvas changed size (then its tiles are planned and it is redrawn). */
  const resize = (): boolean => {
    const w = Math.max(1, Math.floor(host.clientWidth));
    const h = Math.max(1, Math.floor(host.clientHeight));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    fitCache();
    request();
    schedule();
    return true;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  let drag: { x: number; y: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.offsetX, y: e.offsetY, moved: false }; canvas.setPointerCapture(e.pointerId); });
  const endDrag = (e: PointerEvent) => {
    if (drag !== null && !drag.moved) { const [x, z] = screenToWorld(view, canvas.width, canvas.height, e.offsetX, e.offsetY); opts.onClick(x, z, e.shiftKey); }
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
    setPlaces(list, colours) { places = list; placeColours = colours; schedule(); },
    setGrid(on) { grid = on; schedule(); },
    highlightBiome(id) {
      if (id === highlight) return;
      highlight = id;
      masks.clear();
      schedule();
    },
    setCutLine(line) { cutLine = line; schedule(); },
    setSquare(sq) { square = sq; schedule(); },
    setCrosshair(on) { canvas.classList.toggle('map-canvas-cut', on); },
    setPlayer(x, z, yawDeg) {
      player = true;
      playerX = x;
      playerZ = z;
      playerYaw = yawDeg;
      if (arrowRedrawWanted(arrowDrawn, drawnX, drawnZ, drawnYaw, x, z, yawDeg, view.bpp, drawnAt, now)) schedule();
    },
    setHidden(on) {
      if (destroyed) return;
      if (on) {
        if (hidden) return;
        hidden = true;
        cancelAnimationFrame(raf);
        raf = 0;
        pool.cancelTiles((r) => asked.has(r));
        return;
      }
      hidden = false;
      if (!resize()) { request(); schedule(); }
    },
    get blankDraws() { return fallbacks.blankDraws; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      observer.disconnect();
      pool.cancelTiles((r) => asked.has(r));
      asked.clear();
      cache.clear();
      masks.clear();
      canvas.remove();
    },
  };
}

/** Screen ↔ world math and tile planning for the map view (SP2a spec §6.1). */
import { MAP_TILE_PX, type MapLevel } from '../../core/constants';
import { levelFor } from '../../gen/map/tile';
import { tileInWindow } from '../../workers/protocol';
import type { MapView } from './mapState';

export interface PlannedTile { readonly level: MapLevel; readonly tx: number; readonly tz: number; readonly priority: number }

export const screenToWorld = (v: MapView, w: number, h: number, sx: number, sy: number): [number, number] =>
  [v.x + (sx - w / 2) * v.bpp, v.z + (sy - h / 2) * v.bpp];

export const worldToScreen = (v: MapView, w: number, h: number, x: number, z: number): [number, number] =>
  [(x - v.x) / v.bpp + w / 2, (z - v.z) / v.bpp + h / 2];

/** Tiles of `level` covering the w × h view inside the half-open colKey window (the protocol's bound), nearest to the centre first. */
export function visibleTiles(v: MapView, w: number, h: number, level: MapLevel): Array<{ tx: number; tz: number; dist: number }> {
  const span = MAP_TILE_PX * level;
  const [x0, z0] = screenToWorld(v, w, h, 0, 0);
  const [x1, z1] = screenToWorld(v, w, h, w, h);
  const out: Array<{ tx: number; tz: number; dist: number }> = [];
  for (let tz = Math.floor(z0 / span); tz <= Math.floor((z1 - 1e-9) / span); tz++) {
    for (let tx = Math.floor(x0 / span); tx <= Math.floor((x1 - 1e-9) / span); tx++) {
      const cx = (tx + 0.5) * span;
      const cz = (tz + 0.5) * span;
      if (tileInWindow(tx, level) && tileInWindow(tz, level)) out.push({ tx, tz, dist: Math.hypot(cx - v.x, cz - v.z) / span });
    }
  }
  return out.sort((a, b) => a.dist - b.dist || a.tz - b.tz || a.tx - b.tx);
}

/**
 * The preview level first (priority < 1000), then the view's own level; nearer tiles first within each.
 * The interactive plan (`previewOnly`, SP2b spec §2.6) stops after the preview level.
 */
export function planTiles(v: MapView, w: number, h: number, previewOnly = false): PlannedTile[] {
  const target = levelFor(v.bpp);
  const plan: PlannedTile[] = visibleTiles(v, w, h, 256).map((t) => ({ level: 256 as MapLevel, tx: t.tx, tz: t.tz, priority: t.dist }));
  if (target !== 256 && !previewOnly) for (const t of visibleTiles(v, w, h, target)) plan.push({ level: target, tx: t.tx, tz: t.tz, priority: 1000 + t.dist });
  return plan;
}

/** The player arrow's length and base width, screen px (SP4c spec §1.5). */
const ARROW_LENGTH_PX = 14;
const ARROW_WIDTH_PX = 10;
const DEG = Math.PI / 180;

/**
 * The player arrow (SP4c spec §1.5, D19): an isosceles triangle 14 px long and 10 px wide centred on the player's screen
 * position, pointing along the screen vector (sin yaw, −cos yaw) (fly yaw 0 faces −z, up on the map). Writes the tip,
 * then the two base corners, into `out` (6 values: x, y each) without allocating; false (and `out` untouched) when the
 * centre is outside the w × h view.
 */
export function arrowGeometry(x: number, z: number, yawDeg: number, v: MapView, w: number, h: number, out: Float64Array): boolean {
  const cx = (x - v.x) / v.bpp + w / 2;
  const cy = (z - v.z) / v.bpp + h / 2;
  if (!(cx >= 0 && cx <= w && cy >= 0 && cy <= h)) return false;
  const dx = Math.sin(yawDeg * DEG);
  const dy = -Math.cos(yawDeg * DEG);
  const half = ARROW_LENGTH_PX / 2;
  const side = ARROW_WIDTH_PX / 2;
  const bx = cx - dx * half;
  const by = cy - dy * half;
  out[0] = cx + dx * half;
  out[1] = cy + dy * half;
  // The base's direction is the axis turned a quarter: (−dy, dx).
  out[2] = bx - dy * side;
  out[3] = by + dx * side;
  out[4] = bx + dy * side;
  out[5] = by - dx * side;
  return true;
}

/** Whether the arrow moved ≥ 1 px (at `bpp` blocks/px) or turned ≥ 2° from (px, pz, pyaw) (SP4c spec §1.5). */
export function arrowMoved(px: number, pz: number, pyaw: number, x: number, z: number, yaw: number, bpp: number): boolean {
  const dx = x - px;
  const dz = z - pz;
  if (dx * dx + dz * dz >= bpp * bpp) return true;
  const turn = Math.abs((((yaw - pyaw) % 360) + 540) % 360 - 180);
  return turn >= 2;
}

/** The arrow redraws at most 30 times a second (SP4c spec §1.5): at least this long after its last redraw, ms. */
export const ARROW_MIN_MS = 33;

/** Whether ≥ `ARROW_MIN_MS` passed since the arrow's last redraw at `lastDrawMs` (−Infinity before the first). */
export const arrowDue = (lastDrawMs: number, nowMs: number): boolean => nowMs - lastDrawMs >= ARROW_MIN_MS;

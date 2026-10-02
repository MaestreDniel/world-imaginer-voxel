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

/** The preview level first (priority < 1000), then the view's own level; nearer tiles first within each. */
export function planTiles(v: MapView, w: number, h: number): PlannedTile[] {
  const target = levelFor(v.bpp);
  const plan: PlannedTile[] = visibleTiles(v, w, h, 256).map((t) => ({ level: 256 as MapLevel, tx: t.tx, tz: t.tz, priority: t.dist }));
  if (target !== 256) for (const t of visibleTiles(v, w, h, target)) plan.push({ level: target, tx: t.tx, tz: t.tz, priority: 1000 + t.dist });
  return plan;
}

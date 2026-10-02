/**
 * Spawn search (SP2a spec §2.9): square rings of quart points 64 blocks apart around (0, 0), out to
 * 4096 blocks, each ring ordered by (distance², z, x). The first dry, non-coastal, gentle land point
 * wins; otherwise the least-bad point by (wet, steep).
 */
import { biomeFamily } from '../biomes/registry';
import type { GenContext } from '../context';
import { columnPoint } from './columnPoint';

const FAMILY = biomeFamily;
const POINT = columnPoint;

export interface Spawn { readonly x: number; readonly z: number; readonly y: number; readonly biome: number; readonly fallback: boolean }

const STEP = 64;
const RINGS = 64;
const POLL = 32;
const NEVER = (): boolean => false;

/** Ring offsets (in steps) of ring r, in (dx² + dz², dz, dx) order. */
export function ringOffsets(r: number): Array<[number, number]> {
  if (r === 0) return [[0, 0]];
  const out: Array<[number, number]> = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) out.push([dx, dz]);
  return out.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
}

/**
 * findSpawn with a `stop` callback (SP2b spec §2.2), polled at the start of each ring and every 32
 * candidates within it; null as soon as it returns true.
 */
export function findSpawnAbortable(ctx: GenContext, stop: () => boolean): Spawn | null {
  let best: { x: number; z: number; wet: number; steep: number; y: number; biome: number } | null = null;
  for (let r = 0; r <= RINGS; r++) {
    const ring = ringOffsets(r);
    for (let k = 0; k < ring.length; k++) {
      if (k % POLL === 0 && stop()) return null;
      const [dx, dz] = ring[k]!;
      const x = dx * STEP;
      const z = dz * STEP;
      const p = POINT(ctx, x, z);
      const fam = FAMILY(p.biome);
      const dry = p.surfaceWaterLevel === -Infinity;
      const y = Math.floor(p.surfaceEst) + 1;
      if (dry && p.offset >= 64 && p.steep <= 1 && fam !== 'ocean' && fam !== 'river' && fam !== 'coast') {
        return { x, z, y, biome: p.biome, fallback: false };
      }
      const wet = dry ? 0 : 1;
      if (best === null || wet < best.wet || (wet === best.wet && p.steep < best.steep)) best = { x, z, wet, steep: p.steep, y, biome: p.biome };
    }
  }
  return { x: best!.x, z: best!.z, y: best!.y, biome: best!.biome, fallback: true };
}

export function findSpawn(ctx: GenContext): Spawn {
  return findSpawnAbortable(ctx, NEVER)!;
}

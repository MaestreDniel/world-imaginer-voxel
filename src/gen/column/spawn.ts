/**
 * Spawn search (SP2a spec §2.9): square rings of quart points 64 blocks apart around (0, 0), out to
 * 4096 blocks, each ring ordered by (distance², z, x). The first dry, non-coastal, gentle land point
 * wins; otherwise the least-bad point by (wet, steep). The search reads the 2D column (`columnPoint`); the spawn's y is
 * ⌊surfaceEst⌋ + 1 under the default density tree and surfaceEst3 + 1 under any other (SP3e spec §1.2), so a tree that
 * moves the surface (amplified) does not report a y inside its ground.
 */
import { canonicalJSON } from '../../core/params/canonical';
import { DEFAULT_DENSITY_TREE } from '../../core/params/defaultTrees';
import { biomeFamily } from '../biomes/registry';
import type { GenContext } from '../context';
import { createDensityContext } from '../density/context';
import { findTap } from '../density/reference';
import { columnPoint } from './columnPoint';
import { surfaceEst3 } from './surfaceEstimate';

const FAMILY = biomeFamily;
const POINT = columnPoint;
const CANONICAL = canonicalJSON;
const DEFAULT_TREE = DEFAULT_DENSITY_TREE;
const CREATE_DC = createDensityContext;
const FIND_TAP = findTap;
const SURFACE_EST3 = surfaceEst3;

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
 * The spawn's y at (x, z), given the 2D estimate y2d = ⌊surfaceEst⌋ + 1: y2d under the default density tree (compared
 * canonically, since a worker's params are a copy), else surfaceEst3 + 1 (the `terrain` tap's surface), or y2d when
 * the tree has no reachable `terrain` tap.
 */
function spawnY(ctx: GenContext, x: number, z: number, y2d: number): number {
  const defs = ctx.params.density.defs;
  if (defs === DEFAULT_TREE || CANONICAL(defs) === CANONICAL(DEFAULT_TREE)) return y2d;
  const dc = CREATE_DC(ctx);
  return FIND_TAP(dc.expr, 'terrain') === undefined ? y2d : SURFACE_EST3(dc, x, z) + 1;
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
        return { x, z, y: spawnY(ctx, x, z, y), biome: p.biome, fallback: false };
      }
      const wet = dry ? 0 : 1;
      if (best === null || wet < best.wet || (wet === best.wet && p.steep < best.steep)) best = { x, z, wet, steep: p.steep, y, biome: p.biome };
    }
  }
  return { x: best!.x, z: best!.z, y: spawnY(ctx, best!.x, best!.z, best!.y), biome: best!.biome, fallback: true };
}

export function findSpawn(ctx: GenContext): Spawn {
  return findSpawnAbortable(ctx, NEVER)!;
}

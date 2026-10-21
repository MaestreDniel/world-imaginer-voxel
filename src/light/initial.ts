/**
 * The exact initial light of a column (SP4a spec §4.1, §4.2; master §2.2, §4.8), computed over the 46 × 384 × 46
 * light region that `copyLightRegion` fills (`world/store/padded.ts`):
 * 1. sky 15 at and above each position's `LIGHT_BLOCKING` (the straight fall);
 * 2. only the boundary of that sky is enqueued: a 15 voxel with a non-15 neighbour light can enter;
 * 3. the sky BFS, then the block BFS from every voxel with `effEmit > 0`, both with one step rule: light crosses from
 *    u to its neighbour v through face f unless `FULL_FACES[u]` has f or `FULL_FACES[v]` has the opposite face, and
 *    the level entering v is `level(u) − max(1, effOpacity(v))`, never below 0.
 * Outside the region's x and z, and below y −64, nothing is entered (opaque); above y 319 is air with sky 15. The
 * 15-voxel padding is light's maximum reach, so the centre column equals a global BFS over the same voxels (L1).
 */
import { AIR } from '../world/blocks/index';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../world/blocks/kinds';
import { DEFAULT_LIGHT_TABLES, effEmit, effOpacity, type LightTables } from '../world/blocks/light';
import { createLightRegion, LIGHT_H, LIGHT_W, lightIndex, type LightRegion } from '../world/store/padded';
import { createLightQueue, type LightQueue } from './queue';

export { DEFAULT_LIGHT_TABLES };
export type { LightTables };

/** Region strides (`lightIndex`): +1 per x, +46 per z, +46² per y. */
const W = LIGHT_W;
const H = LIGHT_H;
const SZ = W;
const SY = W * W;
const VOXELS = SY * H;
/** The smallest power of two that holds every region voxel (2²⁰ ≥ 812,544). */
const QUEUE_CAPACITY = 1 << 20;
const Y_MIN = -64;
const SECTIONS = 24;
const SKY_15 = 0xF0;

const N_BIT = 1 << FACE_NORTH; // −z
const E_BIT = 1 << FACE_EAST; // +x
const S_BIT = 1 << FACE_SOUTH; // +z
const W_BIT = 1 << FACE_WEST; // −x
const U_BIT = 1 << FACE_UP; // +y
const D_BIT = 1 << FACE_DOWN; // −y

/** The light job's worker-local scratch (SP4a spec §4.2), allocated once per worker by `createLightScratch`. */
export interface LightScratch {
  readonly region: LightRegion;
  readonly queue: LightQueue;
  /** 4096 bytes: the section `centreSection` returns, voxel `ly<<8 | lz<<4 | lx`. */
  readonly out: Uint8Array;
}

/**
 * The region (≈ 1.6 MB blocks, 0.8 MB fluid, 0.8 MB light), a 2²⁰-entry queue (4 MB) and the section output. With
 * the real world's steps (1 through air and water, ≥ 15 into rock) each BFS is monotone from its 15 seeds, so a voxel
 * is enqueued at most once per BFS and the queue never holds more than the region.
 */
export function createLightScratch(): LightScratch {
  return { region: createLightRegion(), queue: createLightQueue(QUEUE_CAPACITY), out: new Uint8Array(4096) };
}

/**
 * Runs one BFS over the nibble at `shift` (4 sky, 0 block) of `r.light` from the queued voxels, until the queue is
 * empty (SP4a spec §4.1's step rule; bounds are checked explicitly per face).
 */
function propagate(r: LightRegion, q: LightQueue, t: LightTables, shift: number): void {
  const { blocks, fluid, light } = r;
  const full = t.fullFaces;
  const keep = ~(15 << shift) & 0xFF;
  /** Light of level `lu` entering v across the face whose bit on v's side is `opp`. */
  const enter = (v: number, lu: number, opp: number): void => {
    const bv = blocks[v]!;
    if ((full[bv]! & opp) !== 0) return;
    const op = effOpacity(bv, fluid[v]!, t);
    const nl = lu - (op > 1 ? op : 1);
    if (nl <= ((light[v]! >> shift) & 15)) return;
    light[v] = (light[v]! & keep) | (nl << shift);
    q.push(v);
  };
  while (q.length > 0) {
    const u = q.pop();
    const lu = (light[u]! >> shift) & 15;
    if (lu <= 1) continue;
    const fu = full[blocks[u]!]!;
    const row = (u / W) | 0;
    const x = u - row * W;
    const y = (row / W) | 0;
    const z = row - y * W;
    if (z > 0 && (fu & N_BIT) === 0) enter(u - SZ, lu, S_BIT);
    if (x < W - 1 && (fu & E_BIT) === 0) enter(u + 1, lu, W_BIT);
    if (z < W - 1 && (fu & S_BIT) === 0) enter(u + SZ, lu, N_BIT);
    if (x > 0 && (fu & W_BIT) === 0) enter(u - 1, lu, E_BIT);
    if (y < H - 1 && (fu & U_BIT) === 0) enter(u + SY, lu, D_BIT);
    if (y > 0 && (fu & D_BIT) === 0) enter(u - SY, lu, U_BIT);
  }
}

/**
 * True when sky light from the 15 voxel `u` (at region x, y, z) can enter a neighbour that is not 15: the crossing
 * is open and the neighbour's effective opacity is below 15 (§4.2 step 2's boundary seed).
 */
function boundary(r: LightRegion, t: LightTables, u: number, x: number, y: number, z: number): boolean {
  const { blocks, fluid, light } = r;
  const full = t.fullFaces;
  const fu = full[blocks[u]!]!;
  const opens = (v: number, opp: number): boolean => {
    if (light[v] === SKY_15) return false;
    const bv = blocks[v]!;
    return (full[bv]! & opp) === 0 && effOpacity(bv, fluid[v]!, t) < 15;
  };
  return (z > 0 && (fu & N_BIT) === 0 && opens(u - SZ, S_BIT))
    || (x < W - 1 && (fu & E_BIT) === 0 && opens(u + 1, W_BIT))
    || (z < W - 1 && (fu & S_BIT) === 0 && opens(u + SZ, N_BIT))
    || (x > 0 && (fu & W_BIT) === 0 && opens(u - 1, E_BIT))
    || (y < H - 1 && (fu & U_BIT) === 0 && opens(u + SY, D_BIT))
    || (y > 0 && (fu & D_BIT) === 0 && opens(u - SY, U_BIT));
}

/** Region row (y − −64) of a `lightBlocking` value, clamped to [0, 384]. */
const rowOf = (lb: number): number => {
  const yy = lb - Y_MIN;
  return yy < 0 ? 0 : yy > H ? H : yy;
};

/**
 * Writes `s.region.light` (sky << 4 | block) from the region's blocks, fluid and `lightBlocking` (SP4a spec §4.2
 * steps 2-3): the sky fall and its boundary seeds, the sky BFS, then the block BFS from every `effEmit > 0` voxel.
 */
export function lightRegion(s: LightScratch, t: LightTables = DEFAULT_LIGHT_TABLES): void {
  const r = s.region;
  const { blocks, fluid, light, lightBlocking } = r;
  const q = s.queue;
  const full = t.fullFaces;
  light.fill(0);
  q.clear();

  // The straight fall: sky 15 at and above LIGHT_BLOCKING.
  for (let p = 0; p < SY; p++) {
    for (let i = rowOf(lightBlocking[p]!) * SY + p; i < VOXELS; i += SY) light[i] = SKY_15;
  }

  // Boundary seeds: at position p only rows [lb, max(lb, lateral lb − 1)] can touch a non-15 voxel (the lateral
  // neighbours are 15 from their own lb up, the voxel below p's lb is the only non-15 one under it).
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const p = z * W + x;
      const y0 = rowOf(lightBlocking[p]!);
      if (y0 >= H) continue;
      let top = y0;
      if (z > 0) top = Math.max(top, rowOf(lightBlocking[p - SZ]!) - 1);
      if (x < W - 1) top = Math.max(top, rowOf(lightBlocking[p + 1]!) - 1);
      if (z < W - 1) top = Math.max(top, rowOf(lightBlocking[p + SZ]!) - 1);
      if (x > 0) top = Math.max(top, rowOf(lightBlocking[p - 1]!) - 1);
      if (top > H - 1) top = H - 1;
      for (let y = y0; y <= top; y++) {
        const u = y * SY + p;
        if (boundary(r, t, u, x, y, z)) q.push(u);
      }
    }
  }

  // Above y 319 is air with sky 15: a top voxel the fall does not enter still takes light from above when the
  // crossing is open (queued after the 15 seeds, so the BFS stays monotone).
  const top = (H - 1) * SY;
  if ((full[AIR]! & D_BIT) === 0) {
    for (let p = 0; p < SY; p++) {
      if (rowOf(lightBlocking[p]!) < H) continue;
      const u = top + p;
      const bu = blocks[u]!;
      if ((full[bu]! & U_BIT) !== 0) continue;
      const op = effOpacity(bu, fluid[u]!, t);
      const nl = 15 - (op > 1 ? op : 1);
      if (nl <= 0) continue;
      light[u] = nl << 4;
      q.push(u);
    }
  }
  propagate(r, q, t, 4);

  // Block light: every emitter is a source at its effective emission.
  for (let i = 0; i < VOXELS; i++) {
    const e = effEmit(blocks[i]!, fluid[i]!, t);
    if (e === 0) continue;
    light[i] = (light[i]! & 0xF0) | e;
    q.push(i);
  }
  propagate(r, q, t, 0);
}

/** Copies section `sy` (0 … 23) of the centre column (x, z in [0, 16)) of `s.region.light` into `s.out`. */
export function centreSection(s: LightScratch, sy: number): Uint8Array {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`centreSection: section ${sy} outside 0 … ${SECTIONS - 1}`);
  const { light } = s.region;
  const out = s.out;
  const y0 = Y_MIN + 16 * sy;
  for (let ly = 0; ly < 16; ly++) {
    for (let lz = 0; lz < 16; lz++) {
      const from = lightIndex(0, y0 + ly, lz);
      out.set(light.subarray(from, from + 16), (ly << 8) | (lz << 4));
    }
  }
  return out;
}

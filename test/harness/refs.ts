/**
 * Brute-force references for SP4a's light and meshing (SP4a spec §9.1, §9.2). `referenceLight` is the global light
 * reference of L1 (SP4a spec §4.1, §4.2): it shares no code with `light/initial.ts` beyond the rule's block side
 * (`fallBlocked`, `effOpacity`, `effEmit`) and works on a whole box with no heightmaps and no padding. Task 17 adds
 * the face counts.
 */
import { AIR } from '../../src/world/blocks/index';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../src/world/blocks/kinds';
import { DEFAULT_LIGHT_TABLES, effEmit, effOpacity, fallBlocked, type LightTables } from '../../src/world/blocks/light';

/** The six faces as [face, dx, dy, dz, the opposite face]. */
const FACES: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [FACE_NORTH, 0, 0, -1, FACE_SOUTH],
  [FACE_EAST, 1, 0, 0, FACE_WEST],
  [FACE_SOUTH, 0, 0, 1, FACE_NORTH],
  [FACE_WEST, -1, 0, 0, FACE_EAST],
  [FACE_UP, 0, 1, 0, FACE_DOWN],
  [FACE_DOWN, 0, -1, 0, FACE_UP],
];

/**
 * The light bytes (sky << 4 | block) of every voxel of the box x ∈ [x0, x0 + w), z ∈ [z0, z0 + h), y ∈ [−64, 320),
 * indexed `((y + 64)·h + (z − z0))·w + (x − x0)`, by the rule of SP4a spec §4.1 run globally over the box:
 * - the fall from y 319 per position: sky 15 down to the first voxel `fallBlocked` refuses (the voxel above y 319 is
 *   air);
 * - a plain FIFO BFS from every sky-15 voxel, then one from every voxel with `effEmit > 0`, crossing from u to v
 *   through face f unless `FULL_FACES[u]` has f or `FULL_FACES[v]` has the opposite face, entering v at
 *   `level(u) − max(1, effOpacity(v))` when that is above v's level.
 * Outside the box's x and z, and below y −64, is opaque. Above y 319 is air with sky 15, held as an extra layer at
 * y 320 that takes part in the BFS and is not returned.
 */
export function referenceLight(
  box: { x0: number; z0: number; w: number; h: number },
  blockAt: (x: number, y: number, z: number) => number,
  fluidAt: (x: number, y: number, z: number) => number,
  t: LightTables = DEFAULT_LIGHT_TABLES,
): Uint8Array {
  const { x0, z0, w, h } = box;
  const H = 385;
  const n = w * h * H;
  const at = (x: number, y: number, z: number) => (y * h + z) * w + x;
  const blocks = new Uint16Array(n);
  const fluid = new Uint8Array(n);
  const sky = new Uint8Array(n);
  const blk = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = at(x, y, z);
        blocks[i] = y === 384 ? AIR : blockAt(x0 + x, y - 64, z0 + z);
        fluid[i] = y === 384 ? 0 : fluidAt(x0 + x, y - 64, z0 + z);
      }
    }
  }
  // The fall.
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      sky[at(x, 384, z)] = 15;
      for (let y = 383; y >= 0; y--) {
        const i = at(x, y, z);
        if (fallBlocked(blocks[i]!, fluid[i]!, blocks[at(x, y + 1, z)]!, t)) break;
        sky[i] = 15;
      }
    }
  }
  const bfs = (level: Uint8Array): void => {
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (level[i]! > 0) queue.push(i);
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      const x = u % w;
      const z = Math.floor(u / w) % h;
      const y = Math.floor(u / (w * h));
      for (const [f, dx, dy, dz, opp] of FACES) {
        const vx = x + dx;
        const vy = y + dy;
        const vz = z + dz;
        if (vx < 0 || vx >= w || vz < 0 || vz >= h || vy < 0 || vy >= H) continue;
        const v = at(vx, vy, vz);
        if ((t.fullFaces[blocks[u]!]! >> f) & 1 || (t.fullFaces[blocks[v]!]! >> opp) & 1) continue;
        const nl = level[u]! - Math.max(1, effOpacity(blocks[v]!, fluid[v]!, t));
        if (nl > level[v]!) {
          level[v] = nl;
          queue.push(v);
        }
      }
    }
  };
  bfs(sky);
  for (let i = 0; i < n; i++) blk[i] = effEmit(blocks[i]!, fluid[i]!, t);
  bfs(blk);
  const out = new Uint8Array(w * h * 384);
  for (let i = 0; i < out.length; i++) out[i] = (sky[i]! << 4) | blk[i]!;
  return out;
}

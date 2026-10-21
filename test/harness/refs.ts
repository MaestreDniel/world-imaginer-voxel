/**
 * Brute-force references for SP4a's light and meshing (SP4a spec §9.1, §9.2). `referenceLight` is the global light
 * reference of L1 (SP4a spec §4.1, §4.2): it shares no code with `light/initial.ts` beyond the rule's block side
 * (`fallBlocked`, `effOpacity`, `effEmit`) and works on a whole box with no heightmaps and no padding. `bruteFaces`
 * and `meshFaceCounts` are R1's two sides (ruling P32): every visible unit face by §5.2's rules, read voxel by voxel
 * through a `RegionView`, against the unit faces a column's mesh payload covers, decoded from its quads' corners. They
 * share no code with `mesh/` beyond the block tables.
 */
import { DEFAULT_MESH_TABLES, type MeshTables } from '../../src/mesh/greedy';
import { PACK_LAYOUT } from '../../src/mesh/packing';
import type { ColumnMeshPayload } from '../../src/mesh/column';
import { FLUID_WATER, fluidType } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK } from '../../src/world/blocks/index';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST, PASS_CUTOUT, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import { DEFAULT_LIGHT_TABLES, effEmit, effOpacity, fallBlocked, type LightTables } from '../../src/world/blocks/light';
import type { RegionView } from './region';

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

/** A face's unit key (ruling P32): `((y + 64)·256 + lz·16 + lx)·6 + face`, (lx, y, lz) the voxel that owns the face. */
const faceKey = (lx: number, y: number, lz: number, face: number): number => ((y + 64) * 256 + lz * 16 + lx) * 6 + face;

/**
 * Every visible unit face of column (cx, cz) of `view` by SP4a spec §5.2's rules, one sorted, unique key per face
 * (`faceKey`), in two categories (ruling P32):
 * - `opaque`: the faces of PASS opaque and cutout states (passes 0 and 1) against a neighbour that does not occlude
 *   them (PASS opaque with the facing bit in `fullFaces`), a cutout face also not against the same block unless
 *   `leaves` marks it (SP4a's world has no cutout state);
 * - `water`: the faces of water voxels (fluid type water) against a neighbour that does not occlude them and is not
 *   water (§5.6).
 * Below y −64 is bedrock (opaque) and above y 319 air without fluid, as in the padded view (§5.1). PASS translucent
 * states are not counted (SP4a's world has none; SP8a meshes them). The column's four side neighbours must be in the
 * view (RangeError otherwise).
 */
export function bruteFaces(view: RegionView, cx: number, cz: number, t: MeshTables = DEFAULT_MESH_TABLES): { opaque: Uint32Array; water: Uint32Array } {
  if (cx - 1 < view.cx0 || cx + 1 >= view.cx0 + view.w || cz - 1 < view.cz0 || cz + 1 >= view.cz0 + view.h) {
    throw new RangeError(`bruteFaces: column (${cx}, ${cz}) needs its four side neighbours inside the view`);
  }
  const { pass, fullFaces, leaves } = t;
  const blockAt = (x: number, y: number, z: number): number => (y < -64 ? BEDROCK : y > 319 ? AIR : view.block(x, y, z));
  const waterAt = (x: number, y: number, z: number): boolean => y >= -64 && y <= 319 && fluidType(view.fluid(x, y, z)) === FLUID_WATER;
  const opaque: number[] = [];
  const water: number[] = [];
  for (let y = -64; y < 320; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = 16 * cx + lx;
        const z = 16 * cz + lz;
        const s = view.block(x, y, z);
        const ps = pass[s];
        const solid = ps === PASS_OPAQUE || ps === PASS_CUTOUT;
        const wet = fluidType(view.fluid(x, y, z)) === FLUID_WATER;
        if (!solid && !wet) continue;
        // FACES is in face order (north, east, south, west, up, down), so the keys come out sorted.
        for (const [f, dx, dy, dz, opp] of FACES) {
          const ns = blockAt(x + dx, y + dy, z + dz);
          if (pass[ns] === PASS_OPAQUE && ((fullFaces[ns]! >> opp) & 1) !== 0) continue;
          if (solid && !(ps === PASS_CUTOUT && ns === s && (leaves === undefined || leaves[s] === 0))) opaque.push(faceKey(lx, y, lz, f));
          if (wet && !waterAt(x + dx, y + dy, z + dz)) water.push(faceKey(lx, y, lz, f));
        }
      }
    }
  }
  return { opaque: Uint32Array.from(opaque), water: Uint32Array.from(water) };
}

/**
 * The unit faces the quads of a column mesh payload cover (ruling P32), as sorted `faceKey`s with duplicates kept (a
 * face two quads cover counts twice), in `bruteFaces`' categories: rows of passes 0 and 1 are `opaque`, pass 2
 * `water`; and the quads per category. Each quad is the row's next four vertices; its face is its first vertex's
 * `face` field, its plane the corners' common coordinate P on the face's axis (in blocks), and it covers every unit
 * cell between its corners in the plane, owned by the voxel at P − 1 for a + face (east, south, up) and at P for a −
 * face. Water tops sit at the voxel's full height (ruling P25), so they need no special case. Throws on a quad that is
 * not an axis-aligned rectangle on whole blocks, or whose owner lies outside its section.
 */
export function meshFaceCounts(p: ColumnMeshPayload): { opaque: Uint32Array; water: Uint32Array; quadsOpaque: number; quadsWater: number } {
  const opaque: number[] = [];
  const water: number[] = [];
  let quadsOpaque = 0;
  let quadsWater = 0;
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const at = [0, 0, 0];
  for (let r = 0; r < p.rows.length / 6; r++) {
    const [sy, pass, vertexStart, vertexCount] = [p.rows[6 * r]!, p.rows[6 * r + 1]!, p.rows[6 * r + 2]!, p.rows[6 * r + 3]!];
    if (vertexCount % 4 !== 0) throw new Error(`meshFaceCounts: row ${r} has ${vertexCount} vertices, not whole quads`);
    const out = pass === 2 ? water : opaque;
    const faceField = pass === 2 ? PACK_LAYOUT.fluid.face : PACK_LAYOUT.solid.face;
    for (let v = vertexStart; v < vertexStart + vertexCount; v += 4) {
      if (pass === 2) quadsWater++;
      else quadsOpaque++;
      const face = (p.data[v]! >>> faceField.offset) & ((1 << faceField.bits) - 1);
      const dir = FACES[face];
      if (dir === undefined) throw new Error(`meshFaceCounts: row ${r} vertex ${v}: face ${face}`);
      const [, dx, dy, dz] = dir;
      const axis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
      const plus = dx + dy + dz > 0;
      for (let a = 0; a < 3; a++) {
        lo[a] = Infinity;
        hi[a] = -Infinity;
      }
      for (let k = 0; k < 4; k++) {
        for (let a = 0; a < 3; a++) {
          const c = p.position[4 * (v + k) + a]!;
          if (c % 8 !== 0) throw new Error(`meshFaceCounts: row ${r} vertex ${v + k}: position ${c} is not on a whole block`);
          lo[a] = Math.min(lo[a]!, c / 8);
          hi[a] = Math.max(hi[a]!, c / 8);
        }
      }
      if (lo[axis] !== hi[axis]) throw new Error(`meshFaceCounts: row ${r} vertex ${v}: the quad is not in a plane of its face ${face}`);
      const u = axis === 0 ? 1 : 0;
      const w = axis === 2 ? 1 : 2;
      at[axis] = plus ? lo[axis]! - 1 : lo[axis]!;
      for (at[u] = lo[u]!; at[u]! < hi[u]!; at[u]!++) {
        for (at[w] = lo[w]!; at[w]! < hi[w]!; at[w]!++) {
          const [lx, ly, lz] = at as [number, number, number];
          if (lx < 0 || lx > 15 || ly < 0 || ly > 15 || lz < 0 || lz > 15) {
            throw new Error(`meshFaceCounts: row ${r} vertex ${v}: owner (${lx}, ${ly}, ${lz}) outside section ${sy}`);
          }
          out.push(faceKey(lx, sy * 16 - 64 + ly, lz, face));
        }
      }
    }
  }
  return { opaque: Uint32Array.from(opaque).sort(), water: Uint32Array.from(water).sort(), quadsOpaque, quadsWater };
}

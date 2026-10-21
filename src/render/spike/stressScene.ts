import { MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS, type ColumnMeshPayload } from '../../mesh/column';
import { packFluid, packSolid } from '../../mesh/packing';
import { REGISTRY } from '../../world/blocks/index';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../../world/blocks/kinds';

/**
 * The spike's stress scene (SP4a spec §1.1, ruling P21): Medium scale as master risk 2 states it, synthetic but shaped
 * like real payloads. It covers the RD12 mesh disc around (0, 0), the 489 columns with dx² + dz² ≤ 12.5², in order of
 * distance then angle. Each column, seeded on its own:
 * - has 6-8 non-trivial sections at distinct sy in 3-10, one opaque row (pass 0) each, about 3.4k rows in all;
 * - draws 1,100-1,900 quads (median 1,500, about 0.73 M in all, master §2.6's median), split between its sections;
 * - on 30 % of the columns, has one water row (pass 2) inside one of its non-trivial sections.
 * Quads are greedy-like: axis-aligned faces of 1-16 by 1-16 blocks, wound to face outward, with every packed field
 * of both `data` variants exercised (layers are real non-air states) and water tops at the voxel top (ruling P25).
 * Each row's sphere contains its vertices. The payloads own exact, separate buffers, as `meshColumnPayload`'s do.
 */

/** The disc's radius in columns: RD12. */
const RD = 12;
const QUAD = [0, 1, 2, 0, 2, 3] as const;
/** The column quad count is uniform in [QUADS_MIN, QUADS_MIN + QUADS_SPAN]: median 1,500. */
const QUADS_MIN = 1100;
const QUADS_SPAN = 800;
const WATER_SHARE = 0.3;

/** mulberry32: a small seeded generator in [0, 1). */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const columnSeed = (seed: number, cx: number, cz: number): number =>
  (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(cx + 4096, 0x27d4eb2d) ^ Math.imul(cz + 8192, 0x165667b1)) >>> 0;

/** The RD12 disc around (0, 0), nearest first, then by angle. */
function disc(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const r2 = (RD + 0.5) ** 2;
  for (let dz = -RD; dz <= RD; dz++) for (let dx = -RD; dx <= RD; dx++) if (dx * dx + dz * dz <= r2) out.push([dx, dz]);
  return out.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
}

/** Every non-air state id: the solid quads' layers (layer = state until SP8a, spec §6.3). */
const SOLID_LAYERS: readonly number[] = Array.from({ length: REGISTRY.stateCount }, (_, s) => s)
  .filter((s) => REGISTRY.typeName(REGISTRY.STATE_TYPE[s]!) !== 'air');

/** Face normals by `kinds.ts` face id. */
const NORMAL: Readonly<Record<number, readonly [number, number, number]>> = {
  [FACE_NORTH]: [0, 0, -1],
  [FACE_EAST]: [1, 0, 0],
  [FACE_SOUTH]: [0, 0, 1],
  [FACE_WEST]: [-1, 0, 0],
  [FACE_UP]: [0, 1, 0],
  [FACE_DOWN]: [0, -1, 0],
};

/** A solid face, weighted like terrain: tops 35 %, the four sides 50 %, bottoms 15 %. */
function solidFace(r: () => number): number {
  const u = r();
  if (u < 0.35) return FACE_UP;
  if (u < 0.85) return [FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST][Math.min(3, Math.floor((u - 0.35) * 8))]!;
  return FACE_DOWN;
}

/** A greedy-like extent in blocks, 1-16, small ones the most common. */
const extent = (r: () => number): number => 1 + Math.floor(r() * r() * 16);

/**
 * Writes the 4 corners of one quad (in 1/8 blocks) at vertex `v`: face `face` on its block plane, `w` × `h` blocks from
 * (u0, v0) in the plane's two axes, wound counter-clockwise seen from the face's side. Returns the y of each corner in
 * blocks, for the water's cornerDrop.
 */
function writeQuad(pos: Uint8Array, v: number, face: number, plane: number, u0: number, v0: number, w: number, h: number): number[] {
  const corners: Array<[number, number, number]> = [];
  const uv: Array<[number, number]> = [[u0, v0], [u0 + w, v0], [u0 + w, v0 + h], [u0, v0 + h]];
  for (const [u, vv] of uv) {
    if (face === FACE_UP || face === FACE_DOWN) corners.push([u, plane, vv]);
    else if (face === FACE_EAST || face === FACE_WEST) corners.push([plane, vv, u]);
    else corners.push([u, vv, plane]);
  }
  // (b − a) × (c − a) must point along the face's normal; otherwise wind the other way.
  const [a, b, c] = corners as [[number, number, number], [number, number, number], [number, number, number]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
  const want = NORMAL[face]!;
  if (n[0]! * want[0] + n[1]! * want[1] + n[2]! * want[2] < 0) [corners[1], corners[3]] = [corners[3]!, corners[1]!];
  corners.forEach(([x, y, z], k) => pos.set([8 * x, 8 * y, 8 * z, 0], 4 * (v + k)));
  return corners.map((p) => p[1]);
}

/** A quad's block plane and its extents, inside the section. */
function placeQuad(r: () => number, face: number): { plane: number; u0: number; v0: number; w: number; h: number } {
  const w = extent(r);
  const h = extent(r);
  const layer = Math.floor(r() * 16);
  const outward = face === FACE_UP || face === FACE_EAST || face === FACE_SOUTH;
  return { plane: outward ? layer + 1 : layer, u0: Math.floor(r() * (17 - w)), v0: Math.floor(r() * (17 - h)), w, h };
}

/** Writes the sphere x, y, z, r (section-local blocks) around vertices [from, to). */
function sphereOf(pos: Uint8Array, from: number, to: number, out: Float32Array, at: number): void {
  const lo = [255, 255, 255];
  const hi = [0, 0, 0];
  for (let v = from; v < to; v++) {
    for (let c = 0; c < 3; c++) {
      const x = pos[4 * v + c]!;
      if (x < lo[c]!) lo[c] = x;
      if (x > hi[c]!) hi[c] = x;
    }
  }
  const half = [0, 1, 2].map((c) => (hi[c]! - lo[c]!) / 16);
  // Centres are multiples of 1/16, exact in a float; the radius is rounded up past float32's rounding.
  out.set([(lo[0]! + hi[0]!) / 16, (lo[1]! + hi[1]!) / 16, (lo[2]! + hi[2]!) / 16, Math.hypot(half[0]!, half[1]!, half[2]!) + 1e-4], at);
}

interface RowPlan {
  readonly sy: number;
  readonly pass: number;
  readonly quads: number;
}

/** One column's rows: 6-8 opaque sections at distinct sy in 3-10, one water row on 30 % of the columns. */
function planColumn(r: () => number): RowPlan[] {
  const k = 6 + Math.floor(r() * 3);
  const sys = [3, 4, 5, 6, 7, 8, 9, 10];
  for (let i = sys.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [sys[i], sys[j]] = [sys[j]!, sys[i]!];
  }
  const chosen = sys.slice(0, k).sort((a, b) => a - b);
  const total = QUADS_MIN + Math.floor(r() * (QUADS_SPAN + 1));
  const waterSy = r() < WATER_SHARE ? chosen[Math.floor(r() * k)]! : -1;
  const waterQuads = waterSy < 0 ? 0 : 40 + Math.floor(r() * 81);
  const weights = chosen.map(() => 0.5 + r());
  const sum = weights.reduce((a, b) => a + b, 0);
  const opaque = total - waterQuads;
  const counts = weights.map((w) => Math.max(1, Math.floor((opaque * w) / sum)));
  counts[k - 1] = opaque - counts.slice(0, k - 1).reduce((a, b) => a + b, 0);
  const rows: RowPlan[] = [];
  chosen.forEach((sy, i) => {
    rows.push({ sy, pass: MESH_PASS_OPAQUE, quads: counts[i]! });
    if (sy === waterSy) rows.push({ sy, pass: MESH_PASS_TRANSLUCENT, quads: waterQuads });
  });
  return rows;
}

function column(seed: number, cx: number, cz: number): ColumnMeshPayload {
  const r = generator(columnSeed(seed, cx, cz));
  const plan = planColumn(r);
  const quads = plan.reduce((n, p) => n + p.quads, 0);
  const position = new Uint8Array(16 * quads);
  const data = new Uint32Array(4 * quads);
  const index = new Uint32Array(6 * quads);
  const rows = new Int32Array(ROW_INTS * plan.length);
  const spheres = new Float32Array(4 * plan.length);
  const connectivity = new Uint16Array(24);
  let v = 0;
  let i = 0;
  plan.forEach((p, row) => {
    rows.set([p.sy, p.pass, v, 4 * p.quads, i, 6 * p.quads], ROW_INTS * row);
    connectivity[p.sy] = Math.floor(r() * 0x8000);
    const palette = [0, 1, 2].map(() => SOLID_LAYERS[Math.floor(r() * SOLID_LAYERS.length)]!);
    const sky = Math.floor(r() * 16);
    for (let q = 0; q < p.quads; q++) {
      const vq = v + 4 * q;
      for (let k = 0; k < 6; k++) index[i + 6 * q + k] = 4 * q + QUAD[k]!;
      if (p.pass === MESH_PASS_TRANSLUCENT) {
        // Tops 70 %, sides 25 %, and a few bottoms (water over a cave).
        const u = r();
        const top = u < 0.7;
        const face = top ? FACE_UP : u < 0.95 ? [FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST][Math.floor((u - 0.7) * 16)]! : FACE_DOWN;
        const at = placeQuad(r, face);
        // A water top sits on the voxel top (ruling P25): an up face is on plane ly + 1.
        const ys = writeQuad(position, vq, face, at.plane, at.u0, at.v0, at.w, at.h);
        const maxY = Math.max(...ys);
        const depth = Math.floor(r() * 16);
        const tint = Math.floor(r() * 8);
        for (let k = 0; k < 4; k++) {
          data[vq + k] = packFluid({
            layer: 0, face, sky: Math.floor(r() * 16), block: Math.floor(r() * 16), depth, tint,
            cornerDrop: top || (face !== FACE_DOWN && ys[k] === maxY) ? 1 : 0,
          });
        }
      } else {
        const face = solidFace(r);
        const at = placeQuad(r, face);
        writeQuad(position, vq, face, at.plane, at.u0, at.v0, at.w, at.h);
        const layer = palette[Math.floor(r() * 3)]!;
        const tint = Math.floor(r() * 8);
        const flags = Math.floor(r() * 16);
        for (let k = 0; k < 4; k++) {
          data[vq + k] = packSolid({
            layer, face, ao: Math.floor(r() * 4), sky: Math.min(15, Math.max(0, sky + Math.floor(r() * 5) - 2)),
            block: Math.floor(r() * 16), tint, flags,
          });
        }
      }
    }
    sphereOf(position, v, v + 4 * p.quads, spheres, 4 * row);
    v += 4 * p.quads;
    i += 6 * p.quads;
  });
  return { cx, cz, versions: new Int32Array(18).fill(1), connectivity, position, data, index, rows, spheres };
}

/** The stress scene's 489 column payloads; deterministic for a seed. */
export function stressPayloads(seed = 1): ColumnMeshPayload[] {
  return disc().map(([cx, cz]) => column(seed, cx, cz));
}

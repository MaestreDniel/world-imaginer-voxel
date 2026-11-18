/**
 * The water and still-lava mesher (SP4a spec §5.2, §5.5, §5.6; master §4.4; rulings P24, P25; SP5a spec §1.3; SP7a
 * spec §6.1-§6.2, D26), over one section's 18³ padded view, water into the translucent pass (2):
 * - **visibility:** a water voxel (fluid type water) draws a face against a neighbour that does not occlude it (PASS
 *   opaque with the facing bit in `fullFaces`) and is not water, so also against glass, ice and the box states, whose
 *   own faces toward the water are the ones culled (`greedy.ts`, `boxes.ts`; SP5a spec §1.3); against lava only its up
 *   face, since lava's opaque full-height face covers every plane the two share;
 * - **height** (SP7a spec §6.1): positions stay at the voxel's full height, `8·(ly + 1)` at the top (positions are
 *   whole 1/8 units); the water shader lowers each corner by its `cornerDrop` ninths. A surface voxel (no water above,
 *   not falling) takes on each top corner, of its top face and of its side faces, `cornerDrop(cornerHeight(…))` of the
 *   4 voxels around that corner at its y, always read in one world order (−x−z, +x−z, +x+z, −x+z around the corner),
 *   so neighbouring voxels, and the sections either side of a border through their pads, compute the same double and
 *   share every corner exactly: a water voxel with water above is `CORNER_FULL`, any other water voxel its
 *   `surfaceHeight`, a passable fluid-free voxel `CORNER_DRY` and anything else (solid, lava) `CORNER_SOLID`. A voxel
 *   with water above and a falling voxel are full height (drop 0 on every corner); bottom corners are 0;
 * - **depth:** every face of voxel i carries `depth[i]` (`fluidDepths`: the column's vertical water run, clamped to
 *   15) in its data word and its key;
 * - **light:** §5.3's smooth light per vertex, AO off;
 * - **merge:** per axis and slice, the greedy keys `(face, depth, cornerDrop×4)`, `(sky×4, block×4)` and
 *   `(layer, tint)` (spec §5.6; the third key is constant in SP4a's world, where a water voxel's state is air, and
 *   keeps a merged quad's words exact if a waterlogged state ever meshes here). A flat top (four equal drops) merges
 *   greedily; a sloped top is one quad per voxel, split along the diagonal joining the two corners of lower summed
 *   height (`splitV0V2` over the drawn heights in ninths, ties v0-v2; SP7a spec §6.2); every other quad splits along
 *   v0-v2.
 *
 * Still lava (SP5a spec §1.3): a lava voxel draws a face against a neighbour that does not occlude it and is not lava
 * (so also against glass, ice and the box states, whose faces toward it are culled), into the opaque pass (0) with the
 * solid word: `LAVA_LAYER`, water's smooth light, and AO, tint, flags and frame 0, at the voxel's full height. Its
 * block light 15 makes it bright through the lightmap. The face tables, the corner light, the merge loop and the
 * corner positions are `mesh/faces.ts`'s, shared with `mesh/greedy.ts`. Side strips between levels of one fluid and
 * flowing lava are SP7a's Tasks 10 and 11.
 */
import { CORNER_DRY, CORNER_FULL, CORNER_SOLID } from '../core/constants';
import { FLUID_LAVA, FLUID_NONE, FLUID_WATER, fluidFalling, fluidType, hasFluid } from '../world/blocks/fluid';
import { cornerDrop, cornerHeight, isPassable, splitV0V2, surfaceHeight } from '../world/blocks/fluidRules';
import { ALL_FACES, PASS_OPAQUE } from '../world/blocks/kinds';
import type { NeighborhoodReader } from '../world/store/api';
import { PAD, type PaddedSection } from '../world/store/padded';
import type { MeshBuilder } from './builder';
import { AXIS_N, AXIS_U, AXIS_V, OPPOSITE, ORIGIN, SIGN, STRIDE, cornerLight, mergeSlice, quadCorners, type QuadSink } from './faces';
import { DEFAULT_MESH_TABLES, LAVA_LAYER, type MeshOptions, type MeshTables } from './greedy';
import { PACK_LAYOUT } from './packing';

// Imported values are read through top-level aliases: vitest's bench mode turns every read of an import binding into
// a tracked getter, which the per-face loops below would pay thousands of times per section (SP4a Task P1).
const WATER = FLUID_WATER;
const LAVA = FLUID_LAVA;
const NONE = FLUID_NONE;
const typeOf = fluidType;
const isFluid = hasFluid;
const isFalling = fluidFalling;
const C_DRY = CORNER_DRY;
const C_FULL = CORNER_FULL;
const C_SOLID = CORNER_SOLID;
const CORNER_HEIGHT = cornerHeight;
const CORNER_DROP = cornerDrop;
const PASSABLE = isPassable;
const SPLIT_V0V2 = splitV0V2;
const SURFACE_HEIGHT = surfaceHeight;
const OPAQUE = PASS_OPAQUE;
const FULL = ALL_FACES;
const SIDE = PAD;
const AX_N = AXIS_N;
const AX_U = AXIS_U;
const AX_V = AXIS_V;
const OPP = OPPOSITE;
const ORIGIN_AT = ORIGIN;
const SIGNS = SIGN;
const STRIDES = STRIDE;
const CORNER_LIGHT = cornerLight;
const MERGE_SLICE = mergeSlice;
const QUAD_CORNERS = quadCorners;
const TABLES = DEFAULT_MESH_TABLES;
const LAYOUT = PACK_LAYOUT;

const FLUID = LAYOUT.fluid;
const FACE_SHIFT = FLUID.face.offset;
const SKY_SHIFT = FLUID.sky.offset;
const BLOCK_SHIFT = FLUID.block.offset;
const DEPTH_SHIFT = FLUID.depth.offset;
const TINT_SHIFT = FLUID.tint.offset;
const DROP_SHIFT = FLUID.cornerDrop.offset;

/** Still lava's words (the solid layout, SP5a spec §1.3): the lava layer, the face and the light. */
const SOLID = LAYOUT.solid;
const LAVA_BASE = LAVA_LAYER;
const S_FACE_SHIFT = SOLID.face.offset;
const S_SKY_SHIFT = SOLID.sky.offset;
const S_BLOCK_SHIFT = SOLID.block.offset;

/** Water's light per vertex: §5.3's smooth light, AO off. */
const SMOOTH: MeshOptions = Object.freeze({ ao: false, smoothLight: true });

/** The translucent pass (`MESH_PASS_TRANSLUCENT`) and the opaque one (`MESH_PASS_OPAQUE`), lava's. */
const PASS_WATER = 2;
const PASS_LAVA = 0;

/** The section-local (`depth`) strides per axis (0 x, 1 y, 2 z), and the padded stride of +y. */
const LOCAL = [1, 256, 16] as const;
const UP = SIDE * SIDE;

/** The face index of up (`mesh/faces.ts`'s face order). */
const FACE_UP = 4;

/**
 * Key A's bits: face 0-2, depth 3-6, cornerDrop of v0 … v3 7-22 (four bits each), bit 23 "a lava face" (depth and
 * cornerDrop 0), and bit 31 "a face here".
 */
const KA_DEPTH = 3;
const KA_DROP = 7;
const KA_LAVA = 1 << 23;
const KA_PRESENT = 0x80000000;

/** The slice masks (index v·16 + u), reused by every call (the mesher runs one section at a time). */
const MASK_A = new Uint32Array(256);
const MASK_B = new Uint32Array(256);
const MASK_C = new Uint32Array(256);
const VERTS = new Uint16Array(4);
const CORNERS = new Uint8Array(12);
const WORDS = new Uint32Array(4);

/**
 * Per section-local voxel (`y·256 + z·16 + x`), a water voxel's four top-corner drops, 4 bits each by xz corner: bits
 * 0-3 (x, z), 4-7 (x + 1, z), 8-11 (x + 1, z + 1), 12-15 (x, z + 1); 0 for a voxel with water above or falling.
 * Written for every water voxel of the section before the faces are read.
 */
const DROPS = new Uint16Array(4096);

/**
 * Per face and vertex (`f·4 + k`), the shift of that vertex's drop in its voxel's `DROPS` entry: 4 × its xz corner
 * when the vertex lies on the voxel's top, else 16 (which reads 0 from the 16-bit entry).
 */
const DROP_SHIFT_OF = new Uint8Array(24);
for (let f = 0; f < 6; f++) {
  for (let k = 0; k < 4; k++) {
    const at = [0, 0, 0];
    at[AX_N[f]!] = SIGNS[f]! > 0 ? 1 : 0;
    at[AX_U[f]!] = k === 1 || k === 2 ? 1 : 0;
    at[AX_V[f]!] = k >= 2 ? 1 : 0;
    const corner = at[2] === 0 ? at[0]! : 3 - at[0]!;
    DROP_SHIFT_OF[f * 4 + k] = at[1] === 1 ? 4 * corner : 16;
  }
}

/**
 * A voxel's value in `cornerHeight` for water (SP7a spec §6.1): `CORNER_FULL` for water with water above, the
 * `surfaceHeight` of any other water voxel, `CORNER_DRY` for a passable voxel without fluid, else `CORNER_SOLID`.
 */
function heightCode(blocks: Uint16Array, fluid: Uint8Array, q: number): number {
  const b = fluid[q]!;
  const t = typeOf(b);
  if (t === WATER) return typeOf(fluid[q + UP]!) === WATER ? C_FULL : SURFACE_HEIGHT(b, false);
  return t === NONE && PASSABLE(blocks[q]!) ? C_DRY : C_SOLID;
}

/**
 * The drop of the top corner at the −x−z corner of padded voxel `q`, from the 4 voxels around it read in one world
 * order (−x−z, +x−z, +x+z, −x+z of the corner), so every voxel sharing the corner computes the same double.
 */
function cornerDropAt(blocks: Uint16Array, fluid: Uint8Array, q: number): number {
  return CORNER_DROP(CORNER_HEIGHT(
    heightCode(blocks, fluid, q - 1 - SIDE), heightCode(blocks, fluid, q - SIDE), heightCode(blocks, fluid, q),
    heightCode(blocks, fluid, q - 1),
  ));
}

/** Fills `DROPS` for every water voxel of the padded section (SP7a spec §6.1). */
function topCornerDrops(blocks: Uint16Array, fluid: Uint8Array): void {
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const q = ORIGIN_AT + y * UP + z * SIDE + x;
        const b = fluid[q]!;
        if (typeOf(b) !== WATER) continue;
        const li = (y << 8) | (z << 4) | x;
        if (isFalling(b) || typeOf(fluid[q + UP]!) === WATER) {
          DROPS[li] = 0;
          continue;
        }
        DROPS[li] = cornerDropAt(blocks, fluid, q) | cornerDropAt(blocks, fluid, q + 1) << 4
          | cornerDropAt(blocks, fluid, q + 1 + SIDE) << 8 | cornerDropAt(blocks, fluid, q + SIDE) << 12;
      }
    }
  }
}

/**
 * Meshes the water of the padded section `p` into `b`'s translucent pass (pass 2) and its still lava into the opaque
 * pass (pass 0), adding to what `b` holds (SP4a spec §5.6; SP5a spec §1.3; SP7a spec §6.1-§6.2). `depth` holds 4096
 * values, section-local `y·256 + z·16 + x` (`fluidDepths`; water's only); the padded view is used for face
 * visibility, light and the top corners' heights.
 */
export function meshFluid(p: PaddedSection, depth: Uint8Array, b: MeshBuilder, t: MeshTables = TABLES): void {
  const { blocks, light, fluid } = p;
  const pass = t.pass;
  const full = t.fullFaces;
  const tint = t.tint;
  /** 1 when the state is opaque for smooth light (PASS opaque, `fullFaces` 63), else 0. */
  const solid = (s: number): number => (pass[s] === OPAQUE && full[s] === FULL ? 1 : 0);
  const sink: QuadSink = (f, d, i, j, w, h, ka, kb, kc) => emit(f, d, i, j, w, h, ka, kb, kc, b);
  topCornerDrops(blocks, fluid);
  for (let f = 0; f < 6; f++) {
    const an = AX_N[f]!;
    const au = AX_U[f]!;
    const av = AX_V[f]!;
    const sa = STRIDES[an];
    const su = STRIDES[au];
    const sv = STRIDES[av];
    const la = LOCAL[an];
    const lu = LOCAL[au];
    const lv = LOCAL[av];
    const normal = SIGNS[f]! * sa;
    const oppBit = 1 << OPP[f]!;
    // Where each vertex's drop sits in its voxel's DROPS entry (16, a 0, for a vertex below the voxel's top).
    const sh0 = DROP_SHIFT_OF[f * 4]!;
    const sh1 = DROP_SHIFT_OF[f * 4 + 1]!;
    const sh2 = DROP_SHIFT_OF[f * 4 + 2]!;
    const sh3 = DROP_SHIFT_OF[f * 4 + 3]!;
    for (let d = 0; d < 16; d++) {
      let any = false;
      for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) {
          const m = j * 16 + i;
          MASK_A[m] = 0;
          const v = ORIGIN_AT + d * sa + i * su + j * sv;
          const ft = typeOf(fluid[v]!);
          if (ft !== WATER && ft !== LAVA) continue;
          const q = v + normal;
          const ns = blocks[q]!;
          if (pass[ns] === OPAQUE && (full[ns]! & oppBit) !== 0) continue;
          const nt = typeOf(fluid[q]!);
          if (nt === ft) continue;
          if (ft === LAVA) {
            MASK_A[m] = (KA_PRESENT | KA_LAVA | f) >>> 0;
            MASK_B[m] = CORNER_LIGHT(light, blocks, solid, SMOOTH, q, su, sv, VERTS);
            MASK_C[m] = 0;
            any = true;
            continue;
          }
          // Lava's opaque full-height face covers the plane the two share; water's surface under lava sits below it,
          // on no shared plane, and stays. Its top face is drawn only when no water is above (the skip above).
          if (nt === LAVA && f !== FACE_UP) continue;
          const li = d * la + i * lu + j * lv;
          const dep = depth[li]!;
          const drops = DROPS[li]!;
          const d0 = drops >>> sh0 & 15;
          const d1 = drops >>> sh1 & 15;
          const d2 = drops >>> sh2 & 15;
          const d3 = drops >>> sh3 & 15;
          const ka = (KA_PRESENT | f | dep << KA_DEPTH
            | d0 << KA_DROP | d1 << (KA_DROP + 4) | d2 << (KA_DROP + 8) | d3 << (KA_DROP + 12)) >>> 0;
          const kb = CORNER_LIGHT(light, blocks, solid, SMOOTH, q, su, sv, VERTS);
          const s = blocks[v]!;
          const kc = s | tint[s]! << 10;
          // A sloped top is one quad per voxel (SP7a spec §6.2): emitted here, never merged.
          if (f === FACE_UP && (d0 !== d1 || d1 !== d2 || d2 !== d3)) {
            emit(f, d, i, j, 1, 1, ka, kb, kc, b);
            continue;
          }
          MASK_A[m] = ka;
          MASK_B[m] = kb;
          MASK_C[m] = kc;
          any = true;
        }
      }
      if (any) MERGE_SLICE(f, d, MASK_A, MASK_B, MASK_C, sink);
    }
  }
}

/**
 * Writes one merged quad at full height (corners in 1/8 units): a water quad's four fluid data words from the keys,
 * an up face split along the diagonal of lower summed drawn height (`splitV0V2` over 9 − drop; a flat top ties to
 * v0-v2), or a lava quad's four solid words (`LAVA_LAYER`, the face, the light) into the opaque pass.
 */
function emit(f: number, d: number, i: number, j: number, w: number, h: number, ka: number, kb: number, kc: number, b: MeshBuilder): void {
  QUAD_CORNERS(f, d, i, j, w, h, CORNERS);
  if ((ka & KA_LAVA) !== 0) {
    const lava = LAVA_BASE | f << S_FACE_SHIFT;
    for (let k = 0; k < 4; k++) WORDS[k] = lava | (kb >>> (4 * k) & 15) << S_SKY_SHIFT | (kb >>> (16 + 4 * k) & 15) << S_BLOCK_SHIFT;
    b.quad(PASS_LAVA, CORNERS, WORDS, false);
    return;
  }
  const base = (kc & 0x3FF) | f << FACE_SHIFT | (ka >>> KA_DEPTH & 15) << DEPTH_SHIFT | (kc >>> 10 & 7) << TINT_SHIFT;
  for (let k = 0; k < 4; k++) {
    const sky = kb >>> (4 * k) & 15;
    const blk = kb >>> (16 + 4 * k) & 15;
    const drop = ka >>> (KA_DROP + 4 * k) & 15;
    WORDS[k] = (base | sky << SKY_SHIFT | blk << BLOCK_SHIFT | drop << DROP_SHIFT) >>> 0;
  }
  const flip = f === FACE_UP && !SPLIT_V0V2(
    9 - (ka >>> KA_DROP & 15), 9 - (ka >>> (KA_DROP + 4) & 15), 9 - (ka >>> (KA_DROP + 8) & 15), 9 - (ka >>> (KA_DROP + 12) & 15),
  );
  b.quad(PASS_WATER, CORNERS, WORDS, flip);
}

/** Sections per column and the clamp of `depth`. */
const SECTIONS = 24;
const DEPTH_MAX = 15;
/** The window `fluidDepths` reads per (x, z): 15 voxels below the section, its 16, and 15 above. */
const REACH = 15;
const WINDOW = REACH + 16 + REACH;
const COLUMN = new Uint8Array(WINDOW);

/**
 * Writes into `out` (4096, section-local `y·256 + z·16 + x`) the water depth of every voxel of section `sy` of the
 * centre column (SP4a spec §5.5; ruling P24): the length of the vertical water run that holds the voxel, from the
 * run's surface down to the first voxel without water, clamped to 15; 0 for a voxel without water. Only water counts
 * (fluid type water): lava above or below ends a water run, and a lava voxel's depth is 0, which its opaque face does
 * not read. It reads the centre column's final fluid; below y −64 and above y 319 count as dry. Per (x, z) one pass
 * over the 46 voxels from 15 below the section to 15 above it: a run reaching the window's edge from inside the
 * section is at least 16 long, so the clamp makes it exact. A section whose own fluid is uniform 0 fills zeros and
 * reads nothing else.
 *
 * Returns whether any voxel of the section holds fluid, water or lava (SP4b spec §3.13, D27): false on the uniform-dry
 * return and when no voxel of the section holds fluid, so the mesh job skips `meshFluid` for a dry section and still
 * meshes a section that holds only lava.
 */
export function fluidDepths(nb: NeighborhoodReader, sy: number, out: Uint8Array): boolean {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`fluidDepths: section ${sy} outside 0 … ${SECTIONS - 1}`);
  const v = nb.final(0, 0);
  if (v === null) throw new Error(`fluidDepths: column (${nb.cx}, ${nb.cz}) has no final set`);
  const own = v.sectionFluid(sy);
  if (typeof own === 'number' && !isFluid(own)) {
    out.fill(0);
    return false;
  }
  let wet = false;
  const below = sy > 0 ? v.sectionFluid(sy - 1) : 0;
  const above = sy < SECTIONS - 1 ? v.sectionFluid(sy + 1) : 0;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const col = (z << 4) | x;
      // The window, bottom first: local y 1 … 15 of sy − 1, 0 … 15 of sy, 0 … 14 of sy + 1.
      for (let k = 0; k < WINDOW; k++) {
        const ly = k - REACH;
        const src = ly < 0 ? below : ly < 16 ? own : above;
        const byte = typeof src === 'number' ? src : src[((ly & 15) << 8) | col]!;
        COLUMN[k] = typeOf(byte) === WATER ? 1 : 0;
        if (ly >= 0 && ly < 16 && isFluid(byte)) wet = true;
      }
      // Each run [a, e) of fluid voxels gets min(e − a, 15); only the section's voxels are written.
      for (let k = REACH; k < REACH + 16;) {
        const o = ((k - REACH) << 8) | col;
        if (COLUMN[k] === 0) {
          out[o] = 0;
          k++;
          continue;
        }
        let a = k;
        while (a > 0 && COLUMN[a - 1] === 1) a--;
        let e = k + 1;
        while (e < WINDOW && COLUMN[e] === 1) e++;
        const len = Math.min(e - a, DEPTH_MAX);
        const end = Math.min(e, REACH + 16);
        for (; k < end; k++) out[((k - REACH) << 8) | col] = len;
      }
    }
  }
  return wet;
}

/**
 * The still-water mesher (SP4a spec §5.2, §5.5, §5.6; master §4.4; rulings P24, P25), over one section's 18³ padded
 * view, into the translucent pass (2):
 * - **visibility:** a water voxel (fluid type water; in SP4a always air plus a still source) draws a face against a
 *   neighbour that does not occlude it (PASS opaque with the facing bit in `fullFaces`) and is not water;
 * - **height:** positions stay at the voxel's full height, `8·(ly + 1)` at the top (positions are whole 1/8 units);
 *   the water shader lowers each corner by its `cornerDrop` ninths. A surface voxel (no water above) has
 *   `cornerDrop` 1 on its top face's four corners and on its side faces' two top corners; every other corner has 0;
 * - **depth:** every face of voxel i carries `depth[i]` (`fluidDepths`: the column's vertical run, clamped to 15) in
 *   its data word and its key;
 * - **light:** §5.3's smooth light per vertex, AO off;
 * - **merge:** per axis and slice, the greedy keys `(face, depth, cornerDrop×4)`, `(sky×4, block×4)` and
 *   `(layer, tint)` (spec §5.6; the third key is constant in SP4a's world, where a water voxel's state is air, and
 *   keeps a merged quad's words exact if a waterlogged state ever meshes here). Water quads split along v0-v2.
 *
 * The face tables, the corner light, the merge loop and the corner positions are `mesh/faces.ts`'s, shared with
 * `mesh/greedy.ts`. Flowing levels, falling water and lava are SP7's: lava is not meshed here.
 */
import { FLUID_WATER, fluidType, hasFluid } from '../world/blocks/fluid';
import { ALL_FACES, PASS_OPAQUE } from '../world/blocks/kinds';
import type { NeighborhoodReader } from '../world/store/api';
import { PAD, type PaddedSection } from '../world/store/padded';
import type { MeshBuilder } from './builder';
import { AXIS_N, AXIS_U, AXIS_V, OPPOSITE, ORIGIN, SIGN, STRIDE, cornerLight, mergeSlice, quadCorners, type QuadSink } from './faces';
import { DEFAULT_MESH_TABLES, type MeshOptions, type MeshTables } from './greedy';
import { PACK_LAYOUT } from './packing';

const WATER = FLUID_WATER;
const typeOf = fluidType;
const isFluid = hasFluid;
const OPAQUE = PASS_OPAQUE;
const FULL = ALL_FACES;

const FLUID = PACK_LAYOUT.fluid;
const FACE_SHIFT = FLUID.face.offset;
const SKY_SHIFT = FLUID.sky.offset;
const BLOCK_SHIFT = FLUID.block.offset;
const DEPTH_SHIFT = FLUID.depth.offset;
const TINT_SHIFT = FLUID.tint.offset;
const DROP_SHIFT = FLUID.cornerDrop.offset;

/** Water's light per vertex: §5.3's smooth light, AO off. */
const SMOOTH: MeshOptions = Object.freeze({ ao: false, smoothLight: true });

/** The translucent pass (`MESH_PASS_TRANSLUCENT`). */
const PASS_WATER = 2;

/** The section-local (`depth`) strides per axis (0 x, 1 y, 2 z), and the padded stride of +y. */
const LOCAL = [1, 256, 16] as const;
const UP = PAD * PAD;

/** The face index of up and down (`mesh/faces.ts`'s face order). */
const FACE_UP = 4;
const FACE_DOWN = 5;

/** Key A's bits: face 0-2, depth 3-6, cornerDrop of v0 … v3 7-22 (four bits each), and bit 31 "a face here". */
const KA_DEPTH = 3;
const KA_DROP = 7;
const KA_PRESENT = 0x80000000;

/** The slice masks (index v·16 + u), reused by every call (the mesher runs one section at a time). */
const MASK_A = new Uint32Array(256);
const MASK_B = new Uint32Array(256);
const MASK_C = new Uint32Array(256);
const VERTS = new Uint16Array(4);
const CORNERS = new Uint8Array(12);
const WORDS = new Uint32Array(4);

/**
 * Meshes the still water of the padded section `p` into `b`'s translucent pass (pass 2), adding to what `b` holds
 * (SP4a spec §5.6). `depth` holds 4096 values, section-local `y·256 + z·16 + x` (`fluidDepths`); the padded view is
 * used for face visibility and light only.
 */
export function meshFluid(p: PaddedSection, depth: Uint8Array, b: MeshBuilder, t: MeshTables = DEFAULT_MESH_TABLES): void {
  const { blocks, light, fluid } = p;
  const pass = t.pass;
  const full = t.fullFaces;
  const tint = t.tint;
  /** 1 when the state is opaque for smooth light (PASS opaque, `fullFaces` 63), else 0. */
  const solid = (s: number): number => (pass[s] === OPAQUE && full[s] === FULL ? 1 : 0);
  const sink: QuadSink = (f, d, i, j, w, h, ka, kb, kc) => emit(f, d, i, j, w, h, ka, kb, kc, b);
  for (let f = 0; f < 6; f++) {
    const an = AXIS_N[f]!;
    const au = AXIS_U[f]!;
    const av = AXIS_V[f]!;
    const sa = STRIDE[an];
    const su = STRIDE[au];
    const sv = STRIDE[av];
    const la = LOCAL[an];
    const lu = LOCAL[au];
    const lv = LOCAL[av];
    const normal = SIGN[f]! * sa;
    const oppBit = 1 << OPPOSITE[f]!;
    // Which corners of a face of a surface voxel are its top corners: all four up, none down, and on a side the
    // two at +y (v1, v2 when u is y; v2, v3 when v is y).
    const topMask = f === FACE_UP ? 0b1111 : f === FACE_DOWN ? 0 : au === 1 ? 0b0110 : 0b1100;
    for (let d = 0; d < 16; d++) {
      let any = false;
      for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) {
          const m = j * 16 + i;
          MASK_A[m] = 0;
          const v = ORIGIN + d * sa + i * su + j * sv;
          if (typeOf(fluid[v]!) !== WATER) continue;
          const q = v + normal;
          const ns = blocks[q]!;
          if (pass[ns] === OPAQUE && (full[ns]! & oppBit) !== 0) continue;
          if (typeOf(fluid[q]!) === WATER) continue;
          const dep = depth[d * la + i * lu + j * lv]!;
          const top = typeOf(fluid[v + UP]!) === WATER ? 0 : topMask;
          // cornerDrop is 1 on the top corners of a surface voxel (spec §5.5: a still source sits at 8/9).
          MASK_A[m] = (KA_PRESENT | f | dep << KA_DEPTH
            | (top & 1) << KA_DROP | (top >> 1 & 1) << (KA_DROP + 4) | (top >> 2 & 1) << (KA_DROP + 8)
            | (top >> 3 & 1) << (KA_DROP + 12)) >>> 0;
          MASK_B[m] = cornerLight(light, blocks, solid, SMOOTH, q, su, sv, VERTS);
          const s = blocks[v]!;
          MASK_C[m] = s | tint[s]! << 10;
          any = true;
        }
      }
      if (any) mergeSlice(f, d, MASK_A, MASK_B, MASK_C, sink);
    }
  }
}

/** Writes one merged water quad: full-height corners in 1/8 units and the four fluid data words from the keys. */
function emit(f: number, d: number, i: number, j: number, w: number, h: number, ka: number, kb: number, kc: number, b: MeshBuilder): void {
  quadCorners(f, d, i, j, w, h, CORNERS);
  const base = (kc & 0x3FF) | f << FACE_SHIFT | (ka >>> KA_DEPTH & 15) << DEPTH_SHIFT | (kc >>> 10 & 7) << TINT_SHIFT;
  for (let k = 0; k < 4; k++) {
    const sky = kb >>> (4 * k) & 15;
    const blk = kb >>> (16 + 4 * k) & 15;
    const drop = ka >>> (KA_DROP + 4 * k) & 15;
    WORDS[k] = (base | sky << SKY_SHIFT | blk << BLOCK_SHIFT | drop << DROP_SHIFT) >>> 0;
  }
  b.quad(PASS_WATER, CORNERS, WORDS, false);
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
 * centre column (SP4a spec §5.5; ruling P24): the length of the vertical fluid run that holds the voxel, from the
 * run's surface down to the first non-fluid voxel, clamped to 15; 0 for a voxel without fluid. It reads the centre
 * column's final fluid; below y −64 and above y 319 count as non-fluid. Per (x, z) one pass over the 46 voxels from 15
 * below the section to 15 above it: a run reaching the window's edge from inside the section is at least 16 long, so
 * the clamp makes it exact. A section whose own fluid is uniform 0 fills zeros and reads nothing else.
 */
export function fluidDepths(nb: NeighborhoodReader, sy: number, out: Uint8Array): void {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`fluidDepths: section ${sy} outside 0 … ${SECTIONS - 1}`);
  const v = nb.final(0, 0);
  if (v === null) throw new Error(`fluidDepths: column (${nb.cx}, ${nb.cz}) has no final set`);
  const own = v.sectionFluid(sy);
  if (typeof own === 'number' && !isFluid(own)) {
    out.fill(0);
    return;
  }
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
        COLUMN[k] = isFluid(byte) ? 1 : 0;
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
}

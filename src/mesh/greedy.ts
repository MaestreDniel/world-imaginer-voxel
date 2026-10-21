/**
 * The padded greedy mesher of opaque and cutout cubes (SP4a spec §5.2-§5.5; master §4.4), over one section's 18³
 * padded view (`world/store/padded.ts`):
 * - **visibility:** a neighbour occludes a face when it is PASS opaque with the facing bit in `fullFaces`; an opaque
 *   face is drawn against a non-occluder, a cutout face against a non-occluder that is a different block, except that
 *   leaves also draw their faces against the same leaves (master §4.4). Opaque faces go to pass 0, cutout to pass 1;
 *   PASS none and translucent states are not meshed here (water is `mesh/fluid.ts`'s, and SP4a has no translucent
 *   state);
 * - **AO** per vertex from the two edge voxels s1, s2 and the corner c on the face's air side, "opaque" meaning PASS
 *   opaque with `fullFaces` 63: `ao2 = (s1 ∧ s2) ? 3 : s1 + s2 + c`, its factor `AO_FACTORS[ao2]`;
 * - **smooth light** per vertex and channel: `⌊(2·sum + n) / (2n)⌋` over the face voxel F and the non-opaque edge
 *   and corner voxels, the corner skipped when both edges are opaque (round half up, integers only);
 * - **merge:** per axis and slice, a 16 × 16 mask of two u32 keys, `(layer, tint, flags, face, ao×4)` and
 *   `(sky×4, block×4)`; faces merge only when both keys are equal, so a merged quad's interpolated values are exact;
 * - **diagonal** (plan, project 09's rule, `09-density-terrain/src/mesher.ts:330-332`): a quad splits along v1-v3 when
 *   `AO_FACTORS[ao2 v1] + AO_FACTORS[ao2 v3] > AO_FACTORS[ao2 v0] + AO_FACTORS[ao2 v2]`, else along v0-v2.
 *
 * With `ao` off every `ao2` is 0; with `smoothLight` off every vertex carries F's light. `layer` is the state id,
 * `tint` is `TINT[state]` and `flags` 0 (SP4a spec §5.5).
 */
import { FULL_FACES, PASS, TINT } from '../world/blocks/index';
import { ALL_FACES, PASS_CUTOUT, PASS_OPAQUE } from '../world/blocks/kinds';
import { PAD, padIndex, type PaddedSection } from '../world/store/padded';
import type { MeshBuilder, MeshPass } from './builder';
import { PACK_LAYOUT } from './packing';

/** The per-state tables the mesher reads (the registry's `PASS`, `FULL_FACES` and `TINT`, or injected ones). */
export interface MeshTables {
  readonly pass: Uint8Array;
  readonly fullFaces: Uint8Array;
  readonly tint: Uint8Array;
  /**
   * Per state, non-zero for a leaves state, whose cutout faces are drawn against the same state (master §4.4: "cutout
   * leaves also render faces against leaves"). Absent: no leaves (SP4a's world has none; SP8a supplies the table).
   */
  readonly leaves?: Uint8Array;
}

/** The registry's own tables (never written). */
export const DEFAULT_MESH_TABLES: MeshTables = { pass: PASS, fullFaces: FULL_FACES, tint: TINT };

export interface MeshOptions {
  readonly ao: boolean;
  readonly smoothLight: boolean;
}

/** The brightness factor of each `ao2` (09's table, SP4a spec §5.3); the shaders apply it. */
export const AO_FACTORS: readonly number[] = Object.freeze([1, 0.8, 0.6, 0.45]);
/** `AO_FACTORS` in hundredths, so the diagonal rule compares exact integers (a tie such as 1 + 0.6 = 0.8 + 0.8 stays a tie). */
const AO_WEIGHT: readonly number[] = [100, 80, 60, 45];

/**
 * True when a quad whose corners have these `ao2` splits along v1-v3 (the builder's `flip`), false for v0-v2:
 * `AO_FACTORS[a1] + AO_FACTORS[a3] > AO_FACTORS[a0] + AO_FACTORS[a2]` (plan; project 09's rule).
 */
export function flipDiagonal(a0: number, a1: number, a2: number, a3: number): boolean {
  return AO_WEIGHT[a1]! + AO_WEIGHT[a3]! > AO_WEIGHT[a0]! + AO_WEIGHT[a2]!;
}

const SOLID = PACK_LAYOUT.solid;
const FACE_SHIFT = SOLID.face.offset;
const AO_SHIFT = SOLID.ao.offset;
const SKY_SHIFT = SOLID.sky.offset;
const BLOCK_SHIFT = SOLID.block.offset;
const TINT_SHIFT = SOLID.tint.offset;
const FULL = ALL_FACES;
const OPAQUE = PASS_OPAQUE;
const CUTOUT = PASS_CUTOUT;

/** Padded-view strides per axis (0 x, 1 y, 2 z): `padIndex` adds 1 per x, 18 per z and 324 per y. */
const STRIDE = [1, PAD * PAD, PAD] as const;
/** The padded index of section-local (0, 0, 0). */
const ORIGIN = padIndex(0, 0, 0);

/**
 * Per face (north −z, east +x, south +z, west −x, up +y, down −y; `world/blocks/kinds.ts`): the normal axis and sign,
 * and the in-plane axes u and v of the mask, chosen so that u × v is the outward normal. A quad's corners
 * v0 = (u0, v0), v1 = (u1, v0), v2 = (u1, v1), v3 = (u0, v1) are then counter-clockwise seen from outside.
 */
const AXIS_N = [2, 0, 2, 0, 1, 1] as const;
const SIGN = [-1, 1, 1, -1, 1, -1] as const;
const AXIS_U = [1, 1, 0, 2, 2, 0] as const;
const AXIS_V = [0, 2, 1, 1, 0, 2] as const;
/** The face of the neighbour that faces back: its bit in the neighbour's `fullFaces` decides occlusion. */
const OPPOSITE = [2, 3, 0, 1, 5, 4] as const;

/** Key A's bits: layer 0-9, tint 10-12, flags 13-16, face 17-19, ao2 of v0 … v3 20-27, and bit 31 "a face here". */
const KA_TINT = 10;
const KA_FACE = 17;
const KA_AO = 20;
const KA_PRESENT = 0x80000000;
const LAYER_MASK = 0x3FF;

/** The two key masks of one slice (index v·16 + u), reused by every call (the mesher runs one section at a time). */
const MASK_A = new Uint32Array(256);
const MASK_B = new Uint32Array(256);
const CORNERS = new Uint8Array(12);
const WORDS = new Uint32Array(4);

/**
 * One vertex's AO and smooth light (SP4a spec §5.3), packed as `ao2 | sky << 2 | block << 6`. `lf` is F's light
 * byte; e1, e2 are the two edge voxels and c the corner, with their opacity flags o1, o2, oc. `mesh/fluid.ts` reuses
 * it for water's smooth light (with `ao` off).
 */
export function vertexOf(
  light: Uint8Array, o: MeshOptions, lf: number, e1: number, o1: number, e2: number, o2: number, c: number, oc: number,
): number {
  const ao = o.ao ? (o1 & o2 ? 3 : o1 + o2 + oc) : 0;
  if (!o.smoothLight) return ao | (lf >> 4) << 2 | (lf & 15) << 6;
  let sky = lf >> 4;
  let blk = lf & 15;
  let n = 1;
  if (!o1) {
    const l = light[e1]!;
    sky += l >> 4;
    blk += l & 15;
    n++;
  }
  if (!o2) {
    const l = light[e2]!;
    sky += l >> 4;
    blk += l & 15;
    n++;
  }
  if (!oc && !(o1 & o2)) {
    const l = light[c]!;
    sky += l >> 4;
    blk += l & 15;
    n++;
  }
  // ⌊(2·sum + n) / (2n)⌋, the mean rounded half up: sums ≤ 60 and n ≤ 4, so the floor of the quotient is exact.
  const s = Math.floor((2 * sky + n) / (2 * n));
  const b = Math.floor((2 * blk + n) / (2 * n));
  return ao | s << 2 | b << 6;
}

/**
 * Meshes the opaque and cutout faces of the padded section `p` into `b` (passes 0 and 1), adding to what `b` holds
 * (SP4a spec §5.2-§5.5).
 */
export function meshSolid(p: PaddedSection, o: MeshOptions, b: MeshBuilder, t: MeshTables = DEFAULT_MESH_TABLES): void {
  const { blocks, light } = p;
  const pass = t.pass;
  const full = t.fullFaces;
  const tint = t.tint;
  const leaves = t.leaves;
  /** 1 when the state is opaque for AO, smooth light and connectivity (PASS opaque, `fullFaces` 63), else 0. */
  const solid = (s: number): number => (pass[s] === OPAQUE && full[s] === FULL ? 1 : 0);
  for (let f = 0; f < 6; f++) {
    const sa = STRIDE[AXIS_N[f]!];
    const su = STRIDE[AXIS_U[f]!];
    const sv = STRIDE[AXIS_V[f]!];
    const normal = SIGN[f]! * sa;
    const oppBit = 1 << OPPOSITE[f]!;
    const faceBits = f << KA_FACE;
    for (let d = 0; d < 16; d++) {
      let any = false;
      for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) {
          const m = j * 16 + i;
          MASK_A[m] = 0;
          const v = ORIGIN + d * sa + i * su + j * sv;
          const s = blocks[v]!;
          const ps = pass[s];
          if (ps !== OPAQUE && ps !== CUTOUT) continue;
          const q = v + normal;
          const ns = blocks[q]!;
          if (pass[ns] === OPAQUE && (full[ns]! & oppBit) !== 0) continue;
          if (ps === CUTOUT && ns === s && (leaves === undefined || leaves[s] === 0)) continue;
          // The eight voxels around F in the face plane: the edges at −u, +u, −v, +v and the four corners.
          const uM = q - su;
          const uP = q + su;
          const vM = q - sv;
          const vP = q + sv;
          const oUM = solid(blocks[uM]!);
          const oUP = solid(blocks[uP]!);
          const oVM = solid(blocks[vM]!);
          const oVP = solid(blocks[vP]!);
          const lf = light[q]!;
          // v0 (−u, −v), v1 (+u, −v), v2 (+u, +v), v3 (−u, +v).
          const c0 = vertexOf(light, o, lf, uM, oUM, vM, oVM, uM - sv, solid(blocks[uM - sv]!));
          const c1 = vertexOf(light, o, lf, uP, oUP, vM, oVM, uP - sv, solid(blocks[uP - sv]!));
          const c2 = vertexOf(light, o, lf, uP, oUP, vP, oVP, uP + sv, solid(blocks[uP + sv]!));
          const c3 = vertexOf(light, o, lf, uM, oUM, vP, oVP, uM + sv, solid(blocks[uM + sv]!));
          MASK_A[m] = (KA_PRESENT | s | tint[s]! << KA_TINT | faceBits
            | (c0 & 3) << KA_AO | (c1 & 3) << (KA_AO + 2) | (c2 & 3) << (KA_AO + 4) | (c3 & 3) << (KA_AO + 6)) >>> 0;
          MASK_B[m] = ((c0 >> 2 & 15) | (c1 >> 2 & 15) << 4 | (c2 >> 2 & 15) << 8 | (c3 >> 2 & 15) << 12
            | (c0 >> 6) << 16 | (c1 >> 6) << 20 | (c2 >> 6) << 24 | (c3 >> 6) << 28) >>> 0;
          any = true;
        }
      }
      if (any) mergeSlice(f, d, b, pass);
    }
  }
}

/** Greedy-merges the slice's mask into quads (rows of equal keys along u, then extended along v) and emits them. */
function mergeSlice(f: number, d: number, b: MeshBuilder, pass: Uint8Array): void {
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16;) {
      const m = j * 16 + i;
      const ka = MASK_A[m]!;
      if (ka === 0) {
        i++;
        continue;
      }
      const kb = MASK_B[m]!;
      let w = 1;
      while (i + w < 16 && MASK_A[m + w] === ka && MASK_B[m + w] === kb) w++;
      let h = 1;
      grow: while (j + h < 16) {
        const row = m + 16 * h;
        for (let k = 0; k < w; k++) if (MASK_A[row + k] !== ka || MASK_B[row + k] !== kb) break grow;
        h++;
      }
      for (let y = 0; y < h; y++) MASK_A.fill(0, m + 16 * y, m + 16 * y + w);
      emit(f, d, i, j, w, h, ka, kb, b, pass);
      i += w;
    }
  }
}

/** Writes one merged quad: corners in 1/8 units, the four data words from the keys, and its diagonal. */
function emit(f: number, d: number, i: number, j: number, w: number, h: number, ka: number, kb: number, b: MeshBuilder, pass: Uint8Array): void {
  const an = AXIS_N[f]!;
  const au = AXIS_U[f]!;
  const av = AXIS_V[f]!;
  const plane = 8 * (SIGN[f]! > 0 ? d + 1 : d);
  const u0 = 8 * i;
  const u1 = 8 * (i + w);
  const v0 = 8 * j;
  const v1 = 8 * (j + h);
  CORNERS[an] = plane;
  CORNERS[3 + an] = plane;
  CORNERS[6 + an] = plane;
  CORNERS[9 + an] = plane;
  CORNERS[au] = u0;
  CORNERS[av] = v0;
  CORNERS[3 + au] = u1;
  CORNERS[3 + av] = v0;
  CORNERS[6 + au] = u1;
  CORNERS[6 + av] = v1;
  CORNERS[9 + au] = u0;
  CORNERS[9 + av] = v1;
  const layer = ka & LAYER_MASK;
  const base = layer | f << FACE_SHIFT | (ka >>> KA_TINT & 7) << TINT_SHIFT;
  const a0 = ka >>> KA_AO & 3;
  const a1 = ka >>> (KA_AO + 2) & 3;
  const a2 = ka >>> (KA_AO + 4) & 3;
  const a3 = ka >>> (KA_AO + 6) & 3;
  WORDS[0] = base | a0 << AO_SHIFT | (kb & 15) << SKY_SHIFT | (kb >>> 16 & 15) << BLOCK_SHIFT;
  WORDS[1] = base | a1 << AO_SHIFT | (kb >>> 4 & 15) << SKY_SHIFT | (kb >>> 20 & 15) << BLOCK_SHIFT;
  WORDS[2] = base | a2 << AO_SHIFT | (kb >>> 8 & 15) << SKY_SHIFT | (kb >>> 24 & 15) << BLOCK_SHIFT;
  WORDS[3] = base | a3 << AO_SHIFT | (kb >>> 12 & 15) << SKY_SHIFT | (kb >>> 28 & 15) << BLOCK_SHIFT;
  const mp: MeshPass = pass[layer] === CUTOUT ? 1 : 0;
  b.quad(mp, CORNERS, WORDS, flipDiagonal(a0, a1, a2, a3));
}

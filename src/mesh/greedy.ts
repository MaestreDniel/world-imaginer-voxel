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
 * `tint` is `TINT[state]` and `flags` 0 (SP4a spec §5.5). The face tables, the corner light, the merge loop and the
 * corner positions are `mesh/faces.ts`'s, shared with `mesh/fluid.ts`.
 */
import { FULL_FACES, PASS, TINT } from '../world/blocks/index';
import { ALL_FACES, PASS_CUTOUT, PASS_OPAQUE } from '../world/blocks/kinds';
import type { PaddedSection } from '../world/store/padded';
import type { MeshBuilder, MeshPass } from './builder';
import { AXIS_N, AXIS_U, AXIS_V, OPPOSITE, ORIGIN, SIGN, STRIDE, cornerLight, mergeSlice, quadCorners, type QuadSink } from './faces';
import { PACK_LAYOUT } from './packing';

// Imported values are read through top-level aliases: vitest's bench mode turns every read of an import binding into
// a tracked getter, which the per-face loops below would pay thousands of times per section (SP4a Task P1).
const PASS_OF = PASS;
const FULL_FACES_OF = FULL_FACES;
const TINT_OF = TINT;
const ALL = ALL_FACES;
const OPAQUE = PASS_OPAQUE;
const CUTOUT = PASS_CUTOUT;
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
const LAYOUT = PACK_LAYOUT;

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
export const DEFAULT_MESH_TABLES: MeshTables = { pass: PASS_OF, fullFaces: FULL_FACES_OF, tint: TINT_OF };

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

const SOLID = LAYOUT.solid;
const FACE_SHIFT = SOLID.face.offset;
const AO_SHIFT = SOLID.ao.offset;
const SKY_SHIFT = SOLID.sky.offset;
const BLOCK_SHIFT = SOLID.block.offset;
const TINT_SHIFT = SOLID.tint.offset;
const FULL = ALL;

/** Key A's bits: layer 0-9, tint 10-12, flags 13-16, face 17-19, ao2 of v0 … v3 20-27, and bit 31 "a face here". */
const KA_TINT = 10;
const KA_FACE = 17;
const KA_AO = 20;
const KA_PRESENT = 0x80000000;
const LAYER_MASK = 0x3FF;

/**
 * The key masks of one slice (index v·16 + u), reused by every call (the mesher runs one section at a time). Opaque and
 * cutout faces have two keys, so the third mask `mergeSlice` compares stays all zero.
 */
const MASK_A = new Uint32Array(256);
const MASK_B = new Uint32Array(256);
const NO_KEY = new Uint32Array(256);
const VERTS = new Uint16Array(4);
const CORNERS = new Uint8Array(12);
const WORDS = new Uint32Array(4);

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
  const sink: QuadSink = (f, d, i, j, w, h, ka, kb) => emit(f, d, i, j, w, h, ka, kb, b, pass);
  for (let f = 0; f < 6; f++) {
    const sa = STRIDES[AX_N[f]!];
    const su = STRIDES[AX_U[f]!];
    const sv = STRIDES[AX_V[f]!];
    const normal = SIGNS[f]! * sa;
    const oppBit = 1 << OPP[f]!;
    const faceBits = f << KA_FACE;
    for (let d = 0; d < 16; d++) {
      let any = false;
      for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) {
          const m = j * 16 + i;
          MASK_A[m] = 0;
          const v = ORIGIN_AT + d * sa + i * su + j * sv;
          const s = blocks[v]!;
          const ps = pass[s];
          if (ps !== OPAQUE && ps !== CUTOUT) continue;
          const q = v + normal;
          const ns = blocks[q]!;
          if (pass[ns] === OPAQUE && (full[ns]! & oppBit) !== 0) continue;
          if (ps === CUTOUT && ns === s && (leaves === undefined || leaves[s] === 0)) continue;
          MASK_B[m] = CORNER_LIGHT(light, blocks, solid, o, q, su, sv, VERTS);
          MASK_A[m] = (KA_PRESENT | s | tint[s]! << KA_TINT | faceBits | (VERTS[0]! & 3) << KA_AO
            | (VERTS[1]! & 3) << (KA_AO + 2) | (VERTS[2]! & 3) << (KA_AO + 4) | (VERTS[3]! & 3) << (KA_AO + 6)) >>> 0;
          any = true;
        }
      }
      if (any) MERGE_SLICE(f, d, MASK_A, MASK_B, NO_KEY, sink);
    }
  }
}

/** Writes one merged quad: corners in 1/8 units, the four data words from the keys, and its diagonal. */
function emit(f: number, d: number, i: number, j: number, w: number, h: number, ka: number, kb: number, b: MeshBuilder, pass: Uint8Array): void {
  QUAD_CORNERS(f, d, i, j, w, h, CORNERS);
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

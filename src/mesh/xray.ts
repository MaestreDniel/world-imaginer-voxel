/**
 * The X-ray pass (SP6a spec §5.1, D10, D23): the cave walls and the surface film of one padded section
 * (`world/store/padded.ts`, its `cave` channel the final set's tags), emitted into the builder's pass 3.
 * - **hollow:** a voxel whose tag's low 4 bits (the cave kind, `CAVE_KIND`) are not 0 and whose block is not an opaque
 *   full cube (PASS opaque with `fullFaces` 63, the predicate `meshSolid` uses for AO); a placed block keeps its
 *   section's tag but is no longer hollow, and a dug voxel has tag 0, so it never is (Review Focus 2);
 * - **wall:** each face of a hollow voxel whose neighbour shows an opaque full face (PASS opaque with the facing bit in
 *   `fullFaces`, `meshSolid`'s occlusion test), kind = the hollow's kind; nothing toward a cutout block, water or air;
 * - **film:** each up face of an opaque full cube or a fluid voxel whose up neighbour is air without fluid at sky light
 *   15, kind `CAVE_FILM_KIND` (15); an overhang or a canopy leaves a gap in it (D10). A cell's up face is a wall or a
 *   film, never both (a wall needs an opaque neighbour above, the film air);
 * - **merge:** greedy on (kind, face) only, through `mesh/faces.ts`' `mergeSlice` (no light, no AO, so no diagonal
 *   rule: every quad splits along v0-v2). Each vertex's word is `PACK_LAYOUT.xray`: `face`, `kind`, `biome` 0
 *   (reserved for SP6b).
 * Only the section's own voxels emit; the border is read as their neighbours. A section with no tagged voxel meshes
 * only its up faces (the film).
 */
import { CAVE_FILM_KIND } from '../core/constants';
import { AIR, FULL_FACES, PASS } from '../world/blocks/index';
import { hasFluid } from '../world/blocks/fluid';
import { ALL_FACES, FACE_UP, PASS_OPAQUE } from '../world/blocks/kinds';
import { padIndex, type PaddedSection } from '../world/store/padded';
import type { MeshBuilder, MeshPass } from './builder';
import { AXIS_N, AXIS_U, AXIS_V, OPPOSITE, ORIGIN, SIGN, STRIDE, mergeSlice, quadCorners, type QuadSink } from './faces';
import { PACK_LAYOUT } from './packing';

// Imported values are read through top-level aliases (vitest's bench mode turns import reads into getters; SP4a Task P1).
const FILM = CAVE_FILM_KIND;
const AIR_STATE = AIR;
const PASS_OF = PASS;
const FULL_FACES_OF = FULL_FACES;
const OPAQUE = PASS_OPAQUE;
const FULL = ALL_FACES;
const UP = FACE_UP;
const HAS_FLUID = hasFluid;
const PAD_INDEX = padIndex;
const AX_N = AXIS_N;
const AX_U = AXIS_U;
const AX_V = AXIS_V;
const OPP = OPPOSITE;
const ORIGIN_AT = ORIGIN;
const SIGNS = SIGN;
const STRIDES = STRIDE;
const MERGE_SLICE = mergeSlice;
const QUAD_CORNERS = quadCorners;
const LAYOUT = PACK_LAYOUT;
const XRAY = LAYOUT.xray;
const FACE_SHIFT = XRAY.face.offset;
const KIND_SHIFT = XRAY.kind.offset;
const KIND_MASK = 2 ** XRAY.kind.bits - 1;

/** The builder pass of the X-ray (`MESH_PASS_XRAY`, SP6a spec D23). */
const XRAY_PASS: MeshPass = 3;
/** The padded stride along y, from a voxel to the one above it. */
const UP_STRIDE = STRIDES[1];

/**
 * The slice's key mask (index v·16 + u; the cell's kind, 0 for no face) and the two all-zero masks `mergeSlice` also
 * compares, reused by every call (the mesher runs one section at a time); the corner and word scratch of `SINK`.
 */
const MASK = new Uint32Array(256);
const NO_KEY = new Uint32Array(256);
const CORNERS = new Uint8Array(12);
const WORDS = new Uint32Array(4);
/** The builder of the call in progress, read by `SINK` (one module-level sink, so a call allocates nothing). */
let target: MeshBuilder | null = null;

/** Writes one merged quad: its corners in 1/8 units and four equal words (face, kind, biome 0), no flip. */
const SINK: QuadSink = (f, d, i, j, w, h, ka) => {
  QUAD_CORNERS(f, d, i, j, w, h, CORNERS);
  const word = (f << FACE_SHIFT | (ka & KIND_MASK) << KIND_SHIFT) >>> 0;
  WORDS[0] = word;
  WORDS[1] = word;
  WORDS[2] = word;
  WORDS[3] = word;
  target!.quad(XRAY_PASS, CORNERS, WORDS, false);
};

/** True when the section's own 16³ voxels hold a tag with a kind (low 4 bits ≠ 0). */
function anyKind(cave: Uint8Array): boolean {
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      const row = PAD_INDEX(0, y, z);
      for (let x = 0; x < 16; x++) if ((cave[row + x]! & 15) !== 0) return true;
    }
  }
  return false;
}

/**
 * Meshes the X-ray's cave walls and surface film of the padded section `padded` into `builder`'s pass 3, adding to what
 * it holds (SP6a spec §5.1; the spec's `meshXray(padded, cave, builder)`, the cave array read from `padded.cave`).
 */
export function meshXray(padded: PaddedSection, builder: MeshBuilder): void {
  const { blocks, light, fluid, cave } = padded;
  const walls = anyKind(cave);
  target = builder;
  try {
    for (let f = 0; f < 6; f++) {
      if (!walls && f !== UP) continue;
      const sa = STRIDES[AX_N[f]!];
      const su = STRIDES[AX_U[f]!];
      const sv = STRIDES[AX_V[f]!];
      const normal = SIGNS[f]! * sa;
      const oppBit = 1 << OPP[f]!;
      const up = f === UP;
      for (let d = 0; d < 16; d++) {
        let any = false;
        for (let j = 0; j < 16; j++) {
          for (let i = 0; i < 16; i++) {
            const m = j * 16 + i;
            const v = ORIGIN_AT + d * sa + i * su + j * sv;
            const s = blocks[v]!;
            const opaqueFull = PASS_OF[s] === OPAQUE && FULL_FACES_OF[s] === FULL;
            let key = 0;
            const kind = cave[v]! & 15;
            if (kind !== 0 && !opaqueFull) {
              const ns = blocks[v + normal]!;
              if (PASS_OF[ns] === OPAQUE && (FULL_FACES_OF[ns]! & oppBit) !== 0) key = kind;
            }
            if (key === 0 && up && (opaqueFull || HAS_FLUID(fluid[v]!))) {
              const q = v + UP_STRIDE;
              if (blocks[q] === AIR_STATE && !HAS_FLUID(fluid[q]!) && light[q]! >> 4 === 15) key = FILM;
            }
            MASK[m] = key;
            if (key !== 0) any = true;
          }
        }
        if (any) MERGE_SLICE(f, d, MASK, NO_KEY, NO_KEY, SINK);
      }
    }
  } finally {
    target = null;
  }
}

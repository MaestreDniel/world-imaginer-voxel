/**
 * The provisional box mesher (SP5a spec §1.3, D12), until SP8a's `SHAPE_BOXES` replaces this file: every `SHAPE` box
 * state (torch, wall torch, ladder) of one section's 18³ padded view gets the six faces of its box
 * (`world/blocks/provisionalBoxes.ts`, shared with the raycast) in the cutout pass (1), positions in whole 1/8 units.
 * A face on the voxel's boundary is culled when the neighbour across it is a `SHAPE` cube state (opaque or cutout, so a
 * ladder on glass leaves no coplanar face) or holds water or lava (whose own faces are drawn there); a face inside the
 * voxel is always drawn. Every vertex carries AO 1 (`ao2` 0) and the box voxel's own light, whatever the options, and
 * the solid word's `layer` (the state), `face`, `tint` and `flags` 0, as `meshSolid` writes them. Quads split along
 * v0-v2 and never merge; the corner order and winding are `mesh/faces.ts`'s.
 */
import { SHAPE } from '../world/blocks/index';
import { FLUID_LAVA, FLUID_WATER, fluidType } from '../world/blocks/fluid';
import { SHAPE_BOX, SHAPE_CUBE } from '../world/blocks/kinds';
import { boxOf } from '../world/blocks/provisionalBoxes';
import type { PaddedSection } from '../world/store/padded';
import type { MeshBuilder } from './builder';
import { AXIS_N, AXIS_U, AXIS_V, ORIGIN, SIGN, STRIDE } from './faces';
import { DEFAULT_MESH_TABLES, type MeshOptions, type MeshTables } from './greedy';
import { PACK_LAYOUT } from './packing';

// Imported values are read through top-level aliases (vitest's bench mode turns import reads into getters; SP4a Task P1).
const SHAPE_OF = SHAPE;
const BOX = SHAPE_BOX;
const CUBE = SHAPE_CUBE;
const WATER = FLUID_WATER;
const LAVA = FLUID_LAVA;
const typeOf = fluidType;
const BOX_OF = boxOf;
const AX_N = AXIS_N;
const AX_U = AXIS_U;
const AX_V = AXIS_V;
const ORIGIN_AT = ORIGIN;
const SIGNS = SIGN;
const STRIDES = STRIDE;
const TABLES = DEFAULT_MESH_TABLES;
const LAYOUT = PACK_LAYOUT;

const SOLID = LAYOUT.solid;
const FACE_SHIFT = SOLID.face.offset;
const SKY_SHIFT = SOLID.sky.offset;
const BLOCK_SHIFT = SOLID.block.offset;
const TINT_SHIFT = SOLID.tint.offset;

/** The cutout pass (`MESH_PASS_CUTOUT`). */
const PASS_BOX = 1;
/** Eighths per block: a box coordinate on the voxel's boundary is 0 or 8. */
const EIGHTHS = 8;

/** Scratch reused by every call (the mesher runs one section at a time): the box, its voxel's corner, a quad. */
const BOXV = new Uint8Array(6);
const AT = new Uint8Array(3);
const CORNERS = new Uint8Array(12);
const WORDS = new Uint32Array(4);

/**
 * Meshes the box states of the padded section `p` into `b`'s cutout pass (pass 1), adding to what `b` holds (SP5a spec
 * §1.3). `o` keeps the meshers' common signature; `t` supplies `tint`.
 */
export function meshBoxes(p: PaddedSection, o: MeshOptions, b: MeshBuilder, t: MeshTables = TABLES): void {
  void o; // A box's faces take AO 1 and the voxel's own light under any options (spec §1.3).
  const { blocks, light, fluid } = p;
  const tint = t.tint;
  const sy = STRIDES[1];
  const sz = STRIDES[2];
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const v = ORIGIN_AT + y * sy + z * sz + x;
        const s = blocks[v]!;
        if (SHAPE_OF[s] !== BOX || !BOX_OF(s, BOXV)) continue;
        const lf = light[v]!;
        const base = s | tint[s]! << TINT_SHIFT | (lf >> 4) << SKY_SHIFT | (lf & 15) << BLOCK_SHIFT;
        AT[0] = EIGHTHS * x;
        AT[1] = EIGHTHS * y;
        AT[2] = EIGHTHS * z;
        for (let f = 0; f < 6; f++) {
          const an = AX_N[f]!;
          const sign = SIGNS[f]!;
          const plane = sign > 0 ? BOXV[an + 3]! : BOXV[an]!;
          if (plane === (sign > 0 ? EIGHTHS : 0)) {
            const q = v + sign * STRIDES[an];
            if (SHAPE_OF[blocks[q]!] === CUBE) continue;
            const ft = typeOf(fluid[q]!);
            if (ft === WATER || ft === LAVA) continue;
          }
          const au = AX_U[f]!;
          const av = AX_V[f]!;
          const n = AT[an]! + plane;
          const u0 = AT[au]! + BOXV[au]!;
          const u1 = AT[au]! + BOXV[au + 3]!;
          const v0 = AT[av]! + BOXV[av]!;
          const v1 = AT[av]! + BOXV[av + 3]!;
          // v0 = (u0, v0), v1 = (u1, v0), v2 = (u1, v1), v3 = (u0, v1): counter-clockwise seen from outside.
          CORNERS[an] = n;
          CORNERS[3 + an] = n;
          CORNERS[6 + an] = n;
          CORNERS[9 + an] = n;
          CORNERS[au] = u0;
          CORNERS[av] = v0;
          CORNERS[3 + au] = u1;
          CORNERS[3 + av] = v0;
          CORNERS[6 + au] = u1;
          CORNERS[6 + av] = v1;
          CORNERS[9 + au] = u0;
          CORNERS[9 + av] = v1;
          const word = (base | f << FACE_SHIFT) >>> 0;
          WORDS[0] = word;
          WORDS[1] = word;
          WORDS[2] = word;
          WORDS[3] = word;
          b.quad(PASS_BOX, CORNERS, WORDS, false);
        }
      }
    }
  }
}

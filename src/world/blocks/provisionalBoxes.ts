/**
 * The provisional boxes of SP5a's box-model states until SP8a's `SHAPE_BOXES` (SP5a spec §1.3, D12): one box per
 * `SHAPE` box state, in eighths of a block on the voxel's grid (0 … 8 per axis), shared by the mesher
 * (`mesh/boxes.ts`) and the raycast (`player/raycast.ts`), which may not import `mesh/`. `BOXES` holds each type's box
 * facing north (−z); the other facings are `REGISTRY.rotateState`'s clockwise quarter turns seen from +y, each of
 * which maps (x, z) to (8 − z, x), so north → east → south → west. The per-state table is built once and never written
 * after.
 */
import { REGISTRY } from './index';
import { SHAPE_BOX } from './kinds';
import { MAX_STATES } from './registry';

const REG = REGISTRY;
const BOX = SHAPE_BOX;
const STATES = MAX_STATES;

/** A box as x0, y0, z0, x1, y1, z1 in eighths of a block (x0 < x1, y0 < y1, z0 < z1). */
export type Box = readonly [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number];

/** Each box type's box facing north (SP5a spec §1.3): a thin upright stick, a stick against its wall, a thin plate. */
export const BOXES: Readonly<Record<'torch' | 'wall_torch' | 'ladder', Box>> = Object.freeze({
  torch: Object.freeze([3, 0, 3, 5, 5, 5] as const),
  wall_torch: Object.freeze([3, 2, 6, 5, 7, 8] as const),
  ladder: Object.freeze([0, 0, 7, 8, 8, 8] as const),
});

/** `box` turned by one clockwise quarter seen from +y: (x, z) → (8 − z, x). */
function turn(box: Box): Box {
  const [x0, y0, z0, x1, y1, z1] = box;
  return [8 - z1, y0, x0, 8 - z0, y1, x1];
}

/** Per state: 1 when it has a box; `TABLE[6·state …]` holds it. */
const HAS = new Uint8Array(STATES);
const TABLE = new Uint8Array(6 * STATES);

for (const [name, north] of Object.entries(BOXES)) {
  const type = REG.typeId(name);
  const first = REG.DEFAULT_STATE[type]!;
  let box: Box = north;
  for (let q = 0; q < 4; q++) {
    const s = REG.rotateState(first, q);
    if (HAS[s] === 0) {
      HAS[s] = 1;
      TABLE.set(box, 6 * s);
    }
    box = turn(box);
  }
}

for (let s = 0; s < REG.stateCount; s++) {
  if ((REG.SHAPE[s] === BOX) !== (HAS[s] === 1)) {
    const what = HAS[s] === 1 ? 'not SHAPE box but has' : 'SHAPE box without';
    throw new Error(`provisionalBoxes: ${REG.stateKey(s)} is ${what} a box`);
  }
}

/**
 * Writes the box of `state` into `out` (x0, y0, z0, x1, y1, z1 in eighths) and returns true, or returns false and
 * leaves `out` alone when the state has no box (every state that is not `SHAPE` box). Allocates nothing.
 */
export function boxOf(state: number, out: Uint8Array): boolean {
  if (HAS[state] !== 1) return false;
  const o = 6 * state;
  out[0] = TABLE[o]!;
  out[1] = TABLE[o + 1]!;
  out[2] = TABLE[o + 2]!;
  out[3] = TABLE[o + 3]!;
  out[4] = TABLE[o + 4]!;
  out[5] = TABLE[o + 5]!;
  return true;
}

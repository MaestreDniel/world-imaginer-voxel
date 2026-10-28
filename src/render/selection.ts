import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three';
import { SHAPE } from '../world/blocks/index';
import { SHAPE_BOX } from '../world/blocks/kinds';
import { boxOf } from '../world/blocks/provisionalBoxes';

/**
 * The block outline (SP5a spec §3.5, D8): a black `LineSegments` box around the aimed block, enlarged by
 * `OUTLINE_GROW` on every side, depth-tested, with an opaque (not transparent) material at `renderOrder`
 * `OUTLINE_ORDER`, so it draws in the opaque list after the cutout pass (`CUTOUT_ORDER` 2, `renderer.ts`) and before
 * the water: a submerged target's outline is seen through the water's tint and never fails the depth test against it.
 * The geometry is a unit cube made once; `set` moves and scales the object, so an update allocates nothing and three's
 * bounding sphere stays right.
 */

/** Blocks the outline is enlarged by on every side, so it is not coplanar with the faces it surrounds. */
export const OUTLINE_GROW = 0.002;
/** The outline's `renderOrder` in the opaque list: after the cutout pass (2), before the water. */
export const OUTLINE_ORDER = 3;

/** The twelve edges of the unit cube, as 24 endpoints. */
const EDGES = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0,
  0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0,
  0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1,
]);

export interface Selection {
  /** The outline in the scene, hidden until `set`. */
  readonly object: LineSegments;
  /** Shows the outline around x0 … x1, y0 … y1, z0 … z1 (scene coordinates), enlarged by `OUTLINE_GROW`. */
  set(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void;
  hide(): void;
  dispose(): void;
}

export function createSelection(): Selection {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(EDGES.slice(), 3));
  const material = new LineBasicMaterial({ color: 0x000000 });
  material.name = 'outline';
  const object = new LineSegments(geometry, material);
  object.renderOrder = OUTLINE_ORDER;
  object.visible = false;
  return {
    object,
    set(x0, y0, z0, x1, y1, z1) {
      const g = OUTLINE_GROW;
      object.position.set(x0 - g, y0 - g, z0 - g);
      object.scale.set(x1 - x0 + 2 * g, y1 - y0 + 2 * g, z1 - z0 + 2 * g);
      object.visible = true;
    },
    hide() {
      object.visible = false;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

const SHAPE_ = SHAPE;
const BOX_ = SHAPE_BOX;
const BOX_OF = boxOf;
/** The current box state's box, in eighths. */
const box = new Uint8Array(6);

/**
 * The outline's bounds for the aimed voxel (x, y, z) holding `state`, in world blocks, written into `out` (x0, y0, z0,
 * x1, y1, z1): a `SHAPE` box state's provisional box (the stick of a torch, the plate of a ladder, D8), the whole cell
 * otherwise. Allocates nothing.
 */
export function outlineBounds(state: number, x: number, y: number, z: number, out: Float64Array): void {
  if (SHAPE_[state] === BOX_ && BOX_OF(state, box)) {
    out[0] = x + box[0]! / 8;
    out[1] = y + box[1]! / 8;
    out[2] = z + box[2]! / 8;
    out[3] = x + box[3]! / 8;
    out[4] = y + box[4]! / 8;
    out[5] = z + box[5]! / 8;
    return;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = x + 1;
  out[4] = y + 1;
  out[5] = z + 1;
}

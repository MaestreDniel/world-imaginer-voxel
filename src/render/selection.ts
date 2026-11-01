import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments } from 'three';
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
 *
 * The volume box (SP5c spec §6.1, D3): the selection tool's box around a selection or a ghost, the same unit cube drawn
 * twice under one `Group`. The first line is depth-tested and opaque at `OUTLINE_ORDER`, as the outline; the second has
 * `depthTest` false, is transparent at `DIM_OPACITY` and draws at `VOLUME_DIM_ORDER`, after the water, so the edges
 * terrain hides show dimmed through it. `set` moves and scales both (enlarged by `OUTLINE_GROW`) and writes both colours
 * in place: the selection yellow, the ghost cyan, the refused red. Two instances live in the renderer: the selection's
 * and the ghost's.
 */

/** Blocks the outline is enlarged by on every side, so it is not coplanar with the faces it surrounds. */
export const OUTLINE_GROW = 0.002;
/** The outline's `renderOrder` in the opaque list: after the cutout pass (2), before the water. */
export const OUTLINE_ORDER = 3;

/** The selection's box (SP5c D3). */
export const SELECTION_YELLOW = 0xffd400;
/** The ghost's box (SP5c D11). */
export const GHOST_CYAN = 0x3fd0ff;
/** A refused selection or ghost: a side over 64, out of bounds, not loaded (SP5c D3, D13). */
export const REFUSED_RED = 0xff4040;
/** The opacity of the volume box's lines seen through terrain. */
export const DIM_OPACITY = 0.35;
/**
 * A `renderOrder` after every translucent region: RegionMesh numbers its translucent regions 0 … N − 1 every frame
 * (`regionMesh.ts`'s `sortTranslucent`), and N passes 10 at RD 12, so a small order would sort between water regions.
 */
export const AFTER_WATER_ORDER = 1 << 20;
/** The ghost's `renderOrder` (depth-tested, after the water; SP5c spec §6.2). */
export const GHOST_ORDER = AFTER_WATER_ORDER;
/** The volume box's through-terrain lines, after the ghost; the replaced-cell overlay shares it (SP5c spec §6.3). */
export const VOLUME_DIM_ORDER = AFTER_WATER_ORDER + 1;

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

export interface VolumeBox {
  /** The two lines (depth-tested, then dimmed through terrain) under one group, hidden until `set`. */
  readonly object: Group;
  /**
   * Shows both lines around x0 … x1, y0 … y1, z0 … z1 (scene coordinates), enlarged by `OUTLINE_GROW`, in `colour`
   * (`SELECTION_YELLOW`, `GHOST_CYAN`, `REFUSED_RED`). Allocates nothing.
   */
  set(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number): void;
  hide(): void;
  dispose(): void;
}

/** A volume box (SP5c spec §6.1), first in `colour` (each `set` gives its own). */
export function createVolumeBox(colour = SELECTION_YELLOW): VolumeBox {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(EDGES.slice(), 3));
  const solidMaterial = new LineBasicMaterial({ color: colour });
  solidMaterial.name = 'volumeBox';
  // Drawn last and over everything, it writes no depth, so nothing drawn after it is hidden by its lines.
  const dimMaterial = new LineBasicMaterial({
    color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: DIM_OPACITY,
  });
  dimMaterial.name = 'volumeBoxDim';
  const solid = new LineSegments(geometry, solidMaterial);
  solid.renderOrder = OUTLINE_ORDER;
  const dim = new LineSegments(geometry, dimMaterial);
  dim.renderOrder = VOLUME_DIM_ORDER;
  const object = new Group();
  object.add(solid, dim);
  object.visible = false;
  return {
    object,
    set(x0, y0, z0, x1, y1, z1, c) {
      const g = OUTLINE_GROW;
      solid.position.set(x0 - g, y0 - g, z0 - g);
      solid.scale.set(x1 - x0 + 2 * g, y1 - y0 + 2 * g, z1 - z0 + 2 * g);
      dim.position.copy(solid.position);
      dim.scale.copy(solid.scale);
      solidMaterial.color.setHex(c);
      dimMaterial.color.setHex(c);
      object.visible = true;
    },
    hide() {
      object.visible = false;
    },
    dispose() {
      geometry.dispose();
      solidMaterial.dispose();
      dimMaterial.dispose();
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

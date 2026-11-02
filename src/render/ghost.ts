import {
  Box3, BoxGeometry, BufferAttribute, BufferGeometry, InstancedMesh, Mesh, MeshBasicMaterial, Sphere, Vector3,
} from 'three';
import { createMeshBuilder, type MeshPass } from '../mesh/builder';
import { meshBoxes } from '../mesh/boxes';
import { meshSolid, type MeshOptions } from '../mesh/greedy';
import { AIR, STONE } from '../world/blocks/index';
import { PAD, createPaddedSection, padIndex } from '../world/store/padded';
import type { MaterialSystem } from './materials/index';
import { GHOST_ORDER, REFUSED_RED, VOLUME_DIM_ORDER } from './selection';

/**
 * The selection tool's ghost (SP5c spec §6.2, §6.4, D11, D25): the clipboard's blocks meshed on the main thread, sliced
 * over frames, into one geometry drawn with the ghost material in one draw call, placed and turned by its matrix.
 *
 * - **The build:** the clipboard (unturned) is cut into 16³ cells, taken y, then z, then x (x fastest, as the
 *   clipboard's own index). Each cell is copied into a `PaddedSection` with its one-voxel border from the neighbouring
 *   cells and air outside the clipboard; every voxel's light is `0xF0` (sky 15, block 0, as above the world,
 *   `world/store/padded.ts`) and its fluid byte 0: fluids are not meshed, so no face is culled against a fluid that is
 *   not drawn. `meshSolid` and `meshBoxes` (AO on) write the cell's opaque and cutout quads; both passes are appended
 *   into one growable geometry, positions widened to Uint16 in 1/8-block units (the cell's offset added, as RegionMesh's
 *   region-local positions, `regionMesh.ts`), `data` copied and the indices rebased. A cell whose 16³ holds only air is
 *   skipped (its faces would all be its own voxels'). Over `GHOST_MAX_QUADS` the build stops at `'tooMany'` with no
 *   geometry: the page then shows the ghost's box only.
 * - **The slice:** `step(now)` meshes cells until the one that crosses `GHOST_SLICE_MS` (a cell is the unit of work),
 *   reading the injected clock once at the slice's start and once after each cell; the geometry is built once, when
 *   the last cell is done, in that slice, and the clock is read once more after it, so `lastSliceMs` (the slice's
 *   time, L12's `ghostSliceMaxMs`) covers the meshing and the geometry's construction. The geometry is uploaded to the
 *   GPU on the first frame the ghost is drawn (three uploads it lazily inside that frame's render), so the upload is
 *   counted in that frame's figures, not in `lastSliceMs`.
 * - **The placement:** the mesh's position is the box's minimum corner (scene coordinates) plus the turn's translation
 *   (q 1: (D, 0, 0); q 2: (W, 0, D); q 3: (0, 0, W), W and D the unturned sizes), its rotation about y −q · 90° and its
 *   scale 1/8, which maps cell (x, y, z) as §2.6 does ((D − 1 − z, y, x) for one turn); the material's `ghostTurns`
 *   follows q, so the face shading and glass's frame follow the turn and a turn re-meshes nothing. `place` writes the
 *   transform and the uniform only and allocates nothing (SP4b D25).
 * - **Shown:** hidden until placed; shown while placed with a built geometry (`'ready'`), so a ghost placed during its
 *   build appears with the slice that finishes it. `hide` and a new clipboard hide it until the next `place`.
 *
 * The replaced cells (SP5c spec §6.3, D11; `createReplacedOverlay`): the blocks a paste would replace, as red
 * translucent cubes seen through terrain. One `InstancedMesh` of a unit cube grown by `REPLACED_GROW` on every side, a
 * `MeshBasicMaterial` in the refused red at `REPLACED_OPACITY` with `depthTest` off, drawn at `VOLUME_DIM_ORDER` (after
 * every translucent region and the ghost), its `REPLACED_MAX` instance matrices allocated once (256 KB). `set` writes
 * the first matrices' translations in place (their scale is written once) and sets `count` to the number drawn,
 * uploading only those matrices. Frustum culling is off: the instances move with every fill, and three would otherwise keep the bounding
 * sphere of the first fill it saw.
 */

/** A frame's build stops after the cell that crosses this (SP5c spec §6.2, D25). */
export const GHOST_SLICE_MS = 1;
/** Over this many quads the ghost shows its box only (SP5c D11). */
export const GHOST_MAX_QUADS = 131_072;

/** The most replaced cells drawn (SP5c spec §6.3): the overlay's instance capacity. */
export const REPLACED_MAX = 4096;
/** The replaced cells' opacity (SP5c spec §6.3). */
export const REPLACED_OPACITY = 0.3;
/** Blocks each replaced cell's cube is grown by on every side, so it is not coplanar with the block it marks. */
export const REPLACED_GROW = 0.01;

/** The build's state: nothing set, cells left to mesh, built, or stopped over `GHOST_MAX_QUADS`. */
export type GhostBuild = 'empty' | 'building' | 'ready' | 'tooMany';

export interface Ghost {
  /** The ghost's mesh, at `GHOST_ORDER`, hidden until placed with a built geometry. */
  readonly object: Mesh;
  readonly build: GhostBuild;
  /** The last slice's time in ms on its clock (0 before the first slice of a build). */
  readonly lastSliceMs: number;
  /** Starts a new build of the W × H × D clipboard (`state << 8 | fluid`, index `(y · d + z) · w + x`); hides the ghost. */
  setClipboard(w: number, h: number, d: number, values: Uint32Array): void;
  /** One slice of the build (nothing when not building): cells until the one that crosses `GHOST_SLICE_MS`. */
  step(now: () => number): void;
  /** Places the ghost with its box's minimum corner at (x0, y0, z0) in scene coordinates, turned q quarter turns. */
  place(x0: number, y0: number, z0: number, q: number): void;
  hide(): void;
  /** Frees the geometry; the material is the material system's. */
  dispose(): void;
}

/** A cell's side: the unit of the build's work, one section of the mesher. */
const CELL = 16;
/** Eighths per block: positions are in 1/8-block units, and a cell's offset is 128 per cell. */
const EIGHTHS = 8;
/** The ghost's mesh options: AO on; smooth light changes nothing under a uniform light, so it is off. */
const OPTIONS: MeshOptions = Object.freeze({ ao: true, smoothLight: false });
/** The light byte of every voxel: sky 15, block 0 (as above the world). */
const OPEN_SKY = 0xF0;
/** Quads the growable arrays hold before their first growth. */
const INITIAL_QUADS = 4096;
const PASSES: readonly MeshPass[] = [0, 1];
const HALF_TURN = Math.PI / 2;

/** The geometry's growable arrays: positions (Uint16 × 4 per vertex), data words and indices. */
interface Arrays {
  position: Uint16Array;
  data: Uint32Array;
  index: Uint32Array;
  vertices: number;
  indices: number;
}

function createArrays(quads: number): Arrays {
  return {
    position: new Uint16Array(16 * quads),
    data: new Uint32Array(4 * quads),
    index: new Uint32Array(6 * quads),
    vertices: 0,
    indices: 0,
  };
}

/** Grows `a` (doubling) until it holds `quads` more quads, keeping its contents. */
function reserve(a: Arrays, quads: number): void {
  const need = a.vertices + 4 * quads;
  if (need <= a.data.length) return;
  let cap = a.data.length;
  while (cap < need) cap *= 2;
  const position = new Uint16Array(4 * cap);
  const data = new Uint32Array(cap);
  const index = new Uint32Array((3 * cap) / 2);
  position.set(a.position.subarray(0, 4 * a.vertices));
  data.set(a.data.subarray(0, a.vertices));
  index.set(a.index.subarray(0, a.indices));
  a.position = position;
  a.data = data;
  a.index = index;
}

/** A geometry of the arrays' contents in 1/8-block units, its bounds those of a W × H × D box. */
function geometryOf(a: Arrays, w: number, h: number, d: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(a.position.subarray(0, 4 * a.vertices), 4));
  g.setAttribute('data', new BufferAttribute(a.data.subarray(0, a.vertices), 1));
  g.setIndex(new BufferAttribute(a.index.subarray(0, a.indices), 1));
  // The box's bounds, set here: three would otherwise scan every vertex on the first frame drawn.
  g.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(EIGHTHS * w, EIGHTHS * h, EIGHTHS * d));
  g.boundingSphere = new Sphere(new Vector3((EIGHTHS / 2) * w, (EIGHTHS / 2) * h, (EIGHTHS / 2) * d), (EIGHTHS / 2) * Math.hypot(w, h, d));
  return g;
}

/** The ghost's sliced mesh over `m.ghost` (SP5c spec §6.2). */
export function createGhost(m: MaterialSystem): Ghost {
  const padded = createPaddedSection();
  padded.light.fill(OPEN_SKY);
  const builder = createMeshBuilder();
  const arrays = createArrays(INITIAL_QUADS);
  const object = new Mesh(new BufferGeometry(), m.ghost);
  object.renderOrder = GHOST_ORDER;
  object.visible = false;
  object.scale.setScalar(1 / EIGHTHS);

  let build: GhostBuild = 'empty';
  let lastSliceMs = 0;
  let placed = false;
  let w = 0;
  let h = 0;
  let d = 0;
  let values: Uint32Array = new Uint32Array(0);
  let cellsX = 0;
  let cellsZ = 0;
  let cells = 0;
  let next = 0;
  let quads = 0;

  const setGeometry = (g: BufferGeometry): void => {
    object.geometry.dispose();
    object.geometry = g;
  };

  /** Copies cell (cx, cy, cz) with its border into `padded.blocks`; false when its 16³ holds only air. */
  const fill = (cx: number, cy: number, cz: number): boolean => {
    const blocks = padded.blocks;
    const x0 = CELL * cx;
    // The padded row's x range inside the clipboard: lx from lo to hi − 1 (−1 … 16).
    const lo = Math.max(-1, -x0);
    const hi = Math.min(CELL + 1, w - x0);
    let any = false;
    for (let ly = -1; ly <= CELL; ly++) {
      const y = CELL * cy + ly;
      for (let lz = -1; lz <= CELL; lz++) {
        const z = CELL * cz + lz;
        const row = padIndex(-1, ly, lz);
        if (y < 0 || y >= h || z < 0 || z >= d) {
          blocks.fill(AIR, row, row + PAD);
          continue;
        }
        const inside = ly >= 0 && ly < CELL && lz >= 0 && lz < CELL;
        const src = (y * d + z) * w + x0;
        // padIndex(lx, …) = row + lx + 1.
        if (lo > -1) blocks.fill(AIR, row, row + lo + 1);
        for (let lx = lo; lx < hi; lx++) {
          const s = values[src + lx]! >>> 8;
          blocks[row + lx + 1] = s;
          if (inside && lx >= 0 && lx < CELL && s !== AIR) any = true;
        }
        if (hi < CELL + 1) blocks.fill(AIR, row + hi + 1, row + PAD);
      }
    }
    return any;
  };

  /** Meshes cell `c` and appends its quads; over `GHOST_MAX_QUADS` the build ends `'tooMany'`. */
  const meshCell = (c: number): void => {
    const cx = c % cellsX;
    const cz = Math.floor(c / cellsX) % cellsZ;
    const cy = Math.floor(c / (cellsX * cellsZ));
    if (!fill(cx, cy, cz)) return;
    builder.reset();
    meshSolid(padded, OPTIONS, builder);
    meshBoxes(padded, OPTIONS, builder);
    let cellQuads = 0;
    for (const p of PASSES) cellQuads += builder.view(p).vertices / 4;
    if (cellQuads === 0) return;
    if (quads + cellQuads > GHOST_MAX_QUADS) {
      build = 'tooMany';
      quads = 0;
      arrays.vertices = 0;
      arrays.indices = 0;
      return;
    }
    const a = arrays;
    reserve(a, cellQuads);
    const ox = EIGHTHS * CELL * cx;
    const oy = EIGHTHS * CELL * cy;
    const oz = EIGHTHS * CELL * cz;
    for (const p of PASSES) {
      const v = builder.view(p);
      const base = a.vertices;
      for (let k = 0, o = 4 * base; k < v.vertices; k++, o += 4) {
        a.position[o] = v.position[4 * k]! + ox;
        a.position[o + 1] = v.position[4 * k + 1]! + oy;
        a.position[o + 2] = v.position[4 * k + 2]! + oz;
        a.position[o + 3] = 0;
        a.data[base + k] = v.data[k]!;
      }
      for (let k = 0; k < v.indices; k++) a.index[a.indices + k] = v.index[k]! + base;
      a.vertices = base + v.vertices;
      a.indices += v.indices;
    }
    quads += cellQuads;
  };

  return {
    object,
    get build() { return build; },
    get lastSliceMs() { return lastSliceMs; },
    setClipboard(cw, ch, cd, v) {
      for (const side of [cw, ch, cd]) {
        if (!Number.isInteger(side) || side < 1 || side > 64) throw new RangeError(`ghost: a side of ${side} is outside 1 … 64`);
      }
      if (v.length !== cw * ch * cd) throw new RangeError(`ghost: ${v.length} values for ${cw} × ${ch} × ${cd}`);
      w = cw;
      h = ch;
      d = cd;
      values = v;
      cellsX = Math.ceil(w / CELL);
      cellsZ = Math.ceil(d / CELL);
      cells = cellsX * Math.ceil(h / CELL) * cellsZ;
      next = 0;
      quads = 0;
      // The arrays are reused: the previous build's geometry, which viewed them, is disposed and replaced here.
      arrays.vertices = 0;
      arrays.indices = 0;
      setGeometry(new BufferGeometry());
      build = 'building';
      lastSliceMs = 0;
      placed = false;
      object.visible = false;
    },
    step(now) {
      if (build !== 'building') return;
      const t0 = now();
      let t = t0;
      do {
        meshCell(next++);
        t = now();
      } while (next < cells && build === 'building' && t - t0 < GHOST_SLICE_MS);
      if (next === cells && build === 'building') {
        setGeometry(geometryOf(arrays, w, h, d));
        build = 'ready';
        object.visible = placed;
        t = now();
      }
      lastSliceMs = t - t0;
    },
    place(x0, y0, z0, q) {
      const turns = q & 3;
      const tx = turns === 1 ? d : turns === 2 ? w : 0;
      const tz = turns === 2 ? d : turns === 3 ? w : 0;
      object.position.set(x0 + tx, y0, z0 + tz);
      object.rotation.y = -turns * HALF_TURN;
      m.setGhostTurns(turns);
      placed = true;
      object.visible = build === 'ready';
    },
    hide() {
      placed = false;
      object.visible = false;
    },
    dispose() {
      object.geometry.dispose();
      object.visible = false;
      values = new Uint32Array(0);
      build = 'empty';
    },
  };
}

/**
 * A hidden one-cell placeholder of the ghost (a 1 × 1 × 1 stone clipboard, built at once) for the load's compile walk
 * (SP5c spec §6.2, §6.3): the ghost's program links behind the loading screen, not on the first Ctrl+V.
 */
export function createGhostPlaceholder(m: MaterialSystem): Mesh {
  const g = createGhost(m);
  g.setClipboard(1, 1, 1, new Uint32Array([STONE << 8]));
  g.step(() => 0);
  return g.object;
}

/** The replaced-cell overlay (SP5c spec §6.3, D11). */
export interface ReplacedOverlay {
  /** The instanced cubes, at `VOLUME_DIM_ORDER`, hidden until `set`. */
  readonly object: InstancedMesh;
  /**
   * Shows the first `min(count, REPLACED_MAX)` cells of `cells` (x, y, z offset triples from (x0, y0, z0), scene
   * coordinates), each a unit cube grown by `REPLACED_GROW`; `count` 0 hides the overlay. Allocates only three's one
   * update range.
   */
  set(x0: number, y0: number, z0: number, cells: Int32Array, count: number): void;
  hide(): void;
  dispose(): void;
}

/** The replaced-cell overlay (SP5c spec §6.3): one `InstancedMesh` of `REPLACED_MAX` cubes. */
export function createReplacedOverlay(): ReplacedOverlay {
  // The unit cube from (0, 0, 0) to (1, 1, 1): an instance's matrix scales it to 1 + 2 · grow and moves its min corner.
  const geometry = new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  const material = new MeshBasicMaterial({
    color: REFUSED_RED, transparent: true, opacity: REPLACED_OPACITY, depthTest: false, depthWrite: false,
  });
  material.name = 'replaced';
  const object = new InstancedMesh(geometry, material, REPLACED_MAX);
  object.renderOrder = VOLUME_DIM_ORDER;
  object.frustumCulled = false;
  object.count = 0;
  object.visible = false;
  const matrices = object.instanceMatrix.array as Float32Array;
  const side = 1 + 2 * REPLACED_GROW;
  // Each matrix's scale is written once; a fill writes the translations only (column-major, elements 12-14).
  for (let i = 0; i < REPLACED_MAX; i++) {
    const o = 16 * i;
    matrices[o] = side;
    matrices[o + 5] = side;
    matrices[o + 10] = side;
    matrices[o + 15] = 1;
  }
  return {
    object,
    set(x0, y0, z0, cells, count) {
      const n = Math.min(count, REPLACED_MAX, Math.floor(cells.length / 3));
      const g = REPLACED_GROW;
      for (let i = 0; i < n; i++) {
        const o = 16 * i + 12;
        matrices[o] = x0 + cells[3 * i]! - g;
        matrices[o + 1] = y0 + cells[3 * i + 1]! - g;
        matrices[o + 2] = z0 + cells[3 * i + 2]! - g;
      }
      object.count = n;
      if (n > 0) {
        // Only the matrices drawn are uploaded (three clears the ranges after the upload).
        const a = object.instanceMatrix;
        a.clearUpdateRanges();
        a.addUpdateRange(0, 16 * n);
        a.needsUpdate = true;
      }
      object.visible = n > 0;
    },
    hide() {
      object.visible = false;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      object.dispose();
    },
  };
}

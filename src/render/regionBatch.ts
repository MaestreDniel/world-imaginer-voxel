import { BatchedMesh, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, Sphere, Vector3 } from 'three';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, MESH_PASS_XRAY, ROW_INTS, type ColumnMeshPayload } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import {
  createStreamingRenderer, GROWTH, RESERVATION, rowBounds, rowIsEmpty, SECTION_UNITS, UNITS, type RegionBackend,
  type StagedColumn, type StagingRegion,
} from './regionGrid';
import type { SectionRenderer, StructuralKind } from './sectionRenderer';
import { XRAY_ORDER } from './selection';

/**
 * RegionBatch (SP4a spec §6.2, D13; SP4b spec §4.2, D14): per region and pass a `BatchedMesh` created at the region's
 * first row of that pass (a structural operation), with the Medium reservations, `perObjectFrustumCulled` and
 * `sortObjects` on, and its `position` the region origin `(rx·128, −64, rz·128)` minus the floating origin. Each row
 * is one geometry and one instance, added hidden; its instance matrix `T((cx & 7)·16, sy·16, (cz & 7)·16) · S(1/8)`
 * is set once (exact in float32), so a rebase moves about 20 objects and instance ids may be reused. Each row's
 * `BufferGeometry` wraps the payload's subarrays, with its bounding sphere and box set before `addGeometry`; the batch's
 * own sphere and box are the region's, set once (three never recomputes them).
 *
 * A removed column's rows are hidden at once and released in `pump` (`deleteGeometry`, which deletes the instance),
 * each against the row cap. A shown column's replacement (SP4c spec §5.2) is added hidden beside it under the same
 * rules; its swap sets the old instances invisible and the new visible in one pass, and the old rows are then released
 * like a removal's (`optimize` keeps geometry and instance ids, so it may run mid-swap).
 *
 * The buffer policy (SP6a spec §5.1, Task 48; three's `addGeometry` only appends, so a released or swapped-out row
 * leaves a hole until `optimize`). A row that does not fit waits for the frame's structural operation: `optimize()` when
 * the batch's deleted space is ≥ `OPTIMIZE_AT` (10 %) of its buffers or would make the waiting rows fit, else
 * `setGeometrySize` × `BATCH_GROWTH` (1.25); a full instance table `setInstanceCount` × 1.5 (`GROWTH`). A batch above
 * its reservation that no upload, structural operation or release has written for `SHRINK_IDLE_PUMPS` pumps and whose
 * slack is ≥ `SHRINK_MIN_SLACK` of it is compacted and shrunk to its use × `SHRINK_HEADROOM` (never below the
 * reservation), one batch per pump in the frame's structural slot when no staged column needs it ('shrink').
 *
 * SP6a (spec §5.1, §5.2): a fourth batch per region, the X-ray's pass 3 over `materials.xray`, at `renderOrder`
 * `XRAY_ORDER` with `sortObjects` off (additive, no depth test: its order does not matter), staged, uploaded, revealed
 * and swapped with the column's other passes. While the X-ray is off (`setXray`, Task 48 lever 4c) these batches draw
 * nothing: their `onBeforeRender` leaves three's multi-draw count at 0 instead of culling and listing every instance
 * (0.19-0.26 ms of main thread a frame at RD 12, 48i), and they stay in the scene, so three keeps uploading their rows
 * and the first toggle uploads nothing.
 */

/** Instances a batch starts with: a mountain region holds up to 64 columns × 24 opaque rows. */
const INSTANCES = 1536;
/** A section's extent in blocks: the instance matrix's offsets. */
const SECTION_BLOCKS = SECTION_UNITS / UNITS;
/** A batch whose deleted space reaches this share of its buffers is optimised instead of grown (SP6a, Task 48). */
export const OPTIMIZE_AT = 0.1;
/** A batch's vertex and index buffers grow × 1.25 (SP6a, Task 48); the instance table keeps `GROWTH`. */
export const BATCH_GROWTH = 1.25;
/** Pumps with no write after which a batch above its reservation may be shrunk (SP6a, Task 48). */
export const SHRINK_IDLE_PUMPS = 240;
/** The share of a batch's vertices that must be slack for it to be shrunk. */
export const SHRINK_MIN_SLACK = 0.2;
/** A shrunk batch keeps its use × 1.1 (vertices and indices). */
export const SHRINK_HEADROOM = 1.1;
/** A region's extent in blocks: 128 across, 384 high. */
const REGION_XZ = 128;
const REGION_Y = 384;

const PASSES = [MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT, MESH_PASS_XRAY] as const;

interface BatchPass {
  readonly mesh: BatchedMesh;
  readonly rx: number;
  readonly rz: number;
  /** The vertices and indices of the rows it holds. */
  liveVertices: number;
  liveIndices: number;
  /** In the unculled list: written since its attributes last held no pending update range. */
  unculled: boolean;
  /** The pump of its last write (an upload, a structural operation, a release) or of its last shrink check. */
  lastWrite: number;
}

interface BatchRegion {
  /** By pass; null until the region's first row of that pass. */
  readonly passes: Array<BatchPass | null>;
}

/** An empty geometry of the batch's attribute layout: `addGeometry` of it allocates a new batch's buffers at once. */
const LAYOUT = new BufferGeometry();
LAYOUT.setAttribute('position', new BufferAttribute(new Uint8Array(0), 4));
LAYOUT.setAttribute('data', new BufferAttribute(new Uint32Array(0), 1));
LAYOUT.setIndex(new BufferAttribute(new Uint32Array(0), 1));

/** One hidden triangle of the batch's attribute layout: the stand-in's geometry (`standIn`, rulings R11). */
const TRIANGLE = new BufferGeometry();
TRIANGLE.setAttribute('position', new BufferAttribute(new Uint8Array(12), 4));
TRIANGLE.setAttribute('data', new BufferAttribute(new Uint32Array(3), 1));
TRIANGLE.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));

/** The batch's position, data and index buffers in bytes. */
function bytesOf(mesh: BatchedMesh): number {
  const g = mesh.geometry;
  const index = g.getIndex();
  return (g.getAttribute('position')?.array.byteLength ?? 0) + (g.getAttribute('data')?.array.byteLength ?? 0) + (index?.array.byteLength ?? 0);
}

/** Whether any attribute of `g` holds an update range three has not uploaded yet. */
function pendingRanges(g: BufferGeometry): boolean {
  const index = g.getIndex();
  return (index !== null && index.updateRanges.length > 0)
    || (g.getAttribute('position') as BufferAttribute).updateRanges.length > 0
    || (g.getAttribute('data') as BufferAttribute).updateRanges.length > 0;
}

/**
 * Three's first upload of an attribute sends its whole array (`bufferData`) and leaves the update ranges written
 * before it, which the next partial upload would send again: they are cleared when that first upload happens.
 */
function clearRangesOnFirstUpload(g: BufferGeometry): void {
  const index = g.getIndex();
  for (const a of [g.getAttribute('position'), g.getAttribute('data'), index]) {
    if (a === null || !(a instanceof BufferAttribute)) continue;
    a.clearUpdateRanges();
    a.onUpload(() => a.clearUpdateRanges());
  }
}

const scratchSphere = new Sphere();
const scratchBox = new Box3();

/**
 * The geometry of payload row `r` at offset `o` in `p.rows`: subarrays of the payload's buffers, bounds from its sphere
 * (× 8, in 1/8 blocks, section-local: `rowBounds` at offset 0; `addGeometry` clones them).
 */
function sectionGeometry(p: ColumnMeshPayload, o: number, r: number): BufferGeometry {
  const vertexStart = p.rows[o + 2]!;
  const vertexCount = p.rows[o + 3]!;
  const indexStart = p.rows[o + 4]!;
  const indexCount = p.rows[o + 5]!;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p.position.subarray(4 * vertexStart, 4 * (vertexStart + vertexCount)), 4));
  g.setAttribute('data', new BufferAttribute(p.data.subarray(vertexStart, vertexStart + vertexCount), 1));
  g.setIndex(new BufferAttribute(p.index.subarray(indexStart, indexStart + indexCount), 1));
  rowBounds(p, r, 0, 0, 0, scratchSphere, scratchBox);
  g.boundingSphere = scratchSphere;
  g.boundingBox = scratchBox;
  return g;
}

export function createRegionBatch(materials: MaterialSystem): SectionRenderer {
  if (materials.variant !== 'batch') throw new Error(`RegionBatch needs the 'batch' material variant, got '${materials.variant}'`);
  const materialOf: Record<number, MaterialSystem['terrainOpaque']> = {
    [MESH_PASS_OPAQUE]: materials.terrainOpaque,
    [MESH_PASS_CUTOUT]: materials.terrainCutout,
    [MESH_PASS_TRANSLUCENT]: materials.water,
    [MESH_PASS_XRAY]: materials.xray,
  };
  const root = new Group();
  root.name = 'regionBatch';
  const objects: BatchPass[] = [];
  const unculled: BatchPass[] = [];
  const origin = [0, 0, 0];
  const matrix = new Matrix4();
  // The rows a column's remaining rows add per pass (columnNeed), and the pass the last need was found in.
  const needRows = new Int32Array(PASSES.length);
  const needVertices = new Float64Array(PASSES.length);
  const needIndices = new Float64Array(PASSES.length);
  let needPass = 0;
  // The pumps so far (`settle` counts them) and the batch the last `shrinkDue` chose.
  let pumpNo = 0;
  let shrinkNext: BatchPass | null = null;
  // The X-ray's state (`setXray`): off, the X-ray batches draw nothing.
  let xrayShown = false;
  /** An X-ray batch's `onBeforeRender`: three's own (cull, list) while the X-ray is on, else a zero multi-draw count. */
  const xrayBeforeRender: BatchedMesh['onBeforeRender'] = function (this: BatchedMesh, renderer, scene, camera, geometry, material, group) {
    if (!xrayShown) {
      // three's `renderBufferDirect` draws `_multiDrawCount` ranges, and none at 0 (`renderMultiDraw` returns at once).
      (this as unknown as { _multiDrawCount: number })._multiDrawCount = 0;
      return;
    }
    BatchedMesh.prototype.onBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
  };

  const place = (bp: BatchPass): void => {
    bp.mesh.position.set(bp.rx * REGION_XZ - origin[0]!, -64 - origin[1]!, bp.rz * REGION_XZ - origin[2]!);
  };
  /** Written in this pump: drawn unculled until three has uploaded its ranges (SP4b spec §3.9). */
  const touch = (bp: BatchPass): void => {
    bp.mesh.frustumCulled = false;
    bp.lastWrite = pumpNo;
    if (!bp.unculled) {
      bp.unculled = true;
      unculled.push(bp);
    }
  };
  /**
   * For `vertices` and `indices` more that do not fit: `optimize` when the deleted space is ≥ `OPTIMIZE_AT` of the
   * buffers or would make them fit, else grow.
   */
  const fitKind = (bp: BatchPass, vertices: number, indices: number): StructuralKind => {
    const mesh = bp.mesh;
    const max = mesh.geometry.getAttribute('position').count;
    const deleted = max - mesh.unusedVertexCount - bp.liveVertices;
    const deletedIndices = mesh.geometry.getIndex()!.count - mesh.unusedIndexCount - bp.liveIndices;
    const fits = mesh.unusedVertexCount + deleted >= vertices && mesh.unusedIndexCount + deletedIndices >= indices;
    return deleted >= OPTIMIZE_AT * max || (deleted > 0 && fits) ? 'optimize' : 'grow';
  };
  /** The operation `rows` more rows of `vertices` and `indices` need in the pass's batch, or null. */
  const passNeed = (bp: BatchPass, rows: number, vertices: number, indices: number): StructuralKind | null => {
    if (bp.mesh.instanceCount + rows > bp.mesh.maxInstanceCount) return 'instances';
    if (vertices > bp.mesh.unusedVertexCount || indices > bp.mesh.unusedIndexCount) return fitKind(bp, vertices, indices);
    return null;
  };
  const passOf = (c: StagedColumn<BatchRegion>, r: number): number => c.p.rows[r * ROW_INTS + 1]!;
  /** Every held row's instance of `c` shown or hidden. */
  const setVisible = (c: StagedColumn<BatchRegion>, on: boolean): void => {
    const passes = c.region.data.passes;
    for (let r = c.released; r < c.uploaded; r++) {
      const instance = c.ids[2 * r + 1]!;
      if (instance >= 0) passes[passOf(c, r)]!.mesh.setVisibleAt(instance, on);
    }
  };

  const backend: RegionBackend<BatchRegion> = {
    newRegion: () => ({ passes: [null, null, null, null] }),
    columnNeed(c) {
      needRows.fill(0);
      needVertices.fill(0);
      needIndices.fill(0);
      const passes = c.region.data.passes;
      for (let r = c.uploaded; r < c.rows; r++) {
        if (rowIsEmpty(c.p, r)) continue;
        const pass = passOf(c, r);
        if (passes[pass] === null) {
          needPass = pass;
          return 'create';
        }
        needRows[pass] = needRows[pass]! + 1;
        needVertices[pass] = needVertices[pass]! + c.p.rows[r * ROW_INTS + 3]!;
        needIndices[pass] = needIndices[pass]! + c.p.rows[r * ROW_INTS + 5]!;
      }
      for (const pass of PASSES) {
        if (needRows[pass] === 0) continue;
        const k = passNeed(passes[pass]!, needRows[pass]!, needVertices[pass]!, needIndices[pass]!);
        if (k !== null) {
          needPass = pass;
          return k;
        }
      }
      return null;
    },
    rowNeed(c, r) {
      needPass = passOf(c, r);
      const bp = c.region.data.passes[needPass] ?? null;
      if (bp === null) return 'create';
      return passNeed(bp, 1, c.p.rows[r * ROW_INTS + 3]!, c.p.rows[r * ROW_INTS + 5]!);
    },
    structural(c, kind) {
      const region = c.region;
      const pass = needPass;
      let bp = region.data.passes[pass] ?? null;
      if (kind !== 'create' && bp === null) throw new Error(`no pass ${pass} batch in region (${region.rx}, ${region.rz}) for '${kind}'`);
      switch (kind) {
        case 'create': {
          const [vertices, indices] = RESERVATION[pass]!;
          const mesh = new BatchedMesh(INSTANCES, vertices, indices, materialOf[pass]);
          // Allocates the reserved buffers now, so gpuBytes() and the bench count them from the creating frame.
          mesh.deleteGeometry(mesh.addGeometry(LAYOUT));
          clearRangesOnFirstUpload(mesh.geometry);
          mesh.name = `region ${region.rx},${region.rz} pass ${pass}`;
          mesh.userData['rx'] = region.rx;
          mesh.userData['rz'] = region.rz;
          mesh.userData['pass'] = pass;
          mesh.perObjectFrustumCulled = true;
          // The X-ray's additive, depth-test-free blend needs no order (SP6a spec §5.2); every other batch sorts.
          mesh.sortObjects = pass !== MESH_PASS_XRAY;
          if (pass === MESH_PASS_XRAY) {
            mesh.renderOrder = XRAY_ORDER;
            mesh.onBeforeRender = xrayBeforeRender;
          }
          mesh.boundingSphere = new Sphere(new Vector3(REGION_XZ / 2, REGION_Y / 2, REGION_XZ / 2), Math.hypot(REGION_XZ / 2, REGION_Y / 2, REGION_XZ / 2));
          mesh.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(REGION_XZ, REGION_Y, REGION_XZ));
          bp = { mesh, rx: region.rx, rz: region.rz, liveVertices: 0, liveIndices: 0, unculled: false, lastWrite: pumpNo };
          region.data.passes[pass] = bp;
          objects.push(bp);
          place(bp);
          root.add(mesh);
          break;
        }
        case 'instances':
          bp!.mesh.setInstanceCount(Math.ceil(bp!.mesh.maxInstanceCount * GROWTH));
          break;
        case 'grow': {
          const mesh = bp!.mesh;
          const g = mesh.geometry;
          mesh.setGeometrySize(Math.ceil(g.getAttribute('position').count * BATCH_GROWTH), Math.ceil(g.getIndex()!.count * BATCH_GROWTH));
          clearRangesOnFirstUpload(mesh.geometry);
          break;
        }
        case 'optimize':
          bp!.mesh.optimize();
          break;
        case 'compact':
          throw new Error('RegionBatch has no compaction (RegionMesh\'s arena does)');
        case 'shrink':
          throw new Error('RegionBatch shrinks through `shrink`, which no column asks for');
      }
      touch(bp!);
      return bytesOf(bp!.mesh);
    },
    upload(c, r) {
      const o = r * ROW_INTS;
      const bp = c.region.data.passes[c.p.rows[o + 1]!]!;
      const mesh = bp.mesh;
      const geometryId = mesh.addGeometry(sectionGeometry(c.p, o, r));
      const instance = mesh.addInstance(geometryId);
      matrix.makeScale(1 / UNITS, 1 / UNITS, 1 / UNITS);
      matrix.setPosition((c.cx & 7) * SECTION_BLOCKS, c.p.rows[o]! * SECTION_BLOCKS, (c.cz & 7) * SECTION_BLOCKS);
      mesh.setMatrixAt(instance, matrix);
      mesh.setVisibleAt(instance, false);
      c.ids[2 * r] = geometryId;
      c.ids[2 * r + 1] = instance;
      bp.liveVertices += c.p.rows[o + 3]!;
      bp.liveIndices += c.p.rows[o + 5]!;
      touch(bp);
    },
    reveal(c) {
      setVisible(c, true);
    },
    hide(c) {
      setVisible(c, false);
    },
    swap(prev, next) {
      // One pass of setVisibleAt over both (SP4c spec §5.2): the same region's batches, no structural step between.
      setVisible(prev, false);
      setVisible(next, true);
    },
    release(c, r) {
      const geometryId = c.ids[2 * r]!;
      if (geometryId < 0) return;
      const o = r * ROW_INTS;
      const bp = c.region.data.passes[c.p.rows[o + 1]!]!;
      bp.mesh.deleteGeometry(geometryId);
      bp.liveVertices -= c.p.rows[o + 3]!;
      bp.liveIndices -= c.p.rows[o + 5]!;
      bp.lastWrite = pumpNo;
      c.ids[2 * r] = -1;
      c.ids[2 * r + 1] = -1;
    },
    rowVisible(c, r) {
      const instance = c.ids[2 * r + 1]!;
      if (instance < 0) return false;
      const bp = c.region.data.passes[passOf(c, r)];
      return bp !== null && bp !== undefined && root.visible && bp.mesh.visible && bp.mesh.parent === root
        && bp.mesh.getVisibleAt(instance);
    },
    settle() {
      pumpNo++;
      for (let i = unculled.length - 1; i >= 0; i--) {
        const bp = unculled[i]!;
        if (pendingRanges(bp.mesh.geometry)) continue;
        bp.mesh.frustumCulled = true;
        bp.unculled = false;
        const last = unculled.pop()!;
        if (i < unculled.length) unculled[i] = last;
      }
    },
    shrinkDue() {
      // An indexed loop over the batches, allocation-free: every pump asks while nothing needs the structural slot.
      for (let i = 0; i < objects.length; i++) {
        const bp = objects[i]!;
        if (bp.unculled || pumpNo - bp.lastWrite < SHRINK_IDLE_PUMPS) continue;
        const max = bp.mesh.geometry.getAttribute('position').count;
        if (max <= RESERVATION[bp.mesh.userData['pass'] as number]![0] || max - bp.liveVertices < SHRINK_MIN_SLACK * max) {
          // Nothing to give back: checked again after another idle period.
          bp.lastWrite = pumpNo;
          continue;
        }
        shrinkNext = bp;
        return true;
      }
      return false;
    },
    shrink() {
      const bp = shrinkNext!;
      shrinkNext = null;
      const mesh = bp.mesh;
      const g = mesh.geometry;
      const maxIndices = g.getIndex()!.count;
      const [reservedV, reservedI] = RESERVATION[mesh.userData['pass'] as number]!;
      // Compacted first, so the rows start at 0 and the use is the live rows' (geometry and instance ids are kept).
      if (g.getAttribute('position').count - mesh.unusedVertexCount > bp.liveVertices || maxIndices - mesh.unusedIndexCount > bp.liveIndices) {
        mesh.optimize();
      }
      mesh.setGeometrySize(
        Math.max(reservedV, Math.ceil(bp.liveVertices * SHRINK_HEADROOM)),
        Math.min(maxIndices, Math.max(reservedI, Math.ceil(bp.liveIndices * SHRINK_HEADROOM))),
      );
      clearRangesOnFirstUpload(mesh.geometry);
      touch(bp);
      return bytesOf(mesh);
    },
    disposeRegion(g: StagingRegion<BatchRegion>) {
      for (const bp of g.data.passes) {
        if (bp === null) continue;
        root.remove(bp.mesh);
        bp.mesh.dispose();
        objects.splice(objects.indexOf(bp), 1);
        if (bp.unculled) unculled.splice(unculled.indexOf(bp), 1);
        if (shrinkNext === bp) shrinkNext = null;
      }
      g.data.passes.fill(null);
    },
    hasPass(pass) {
      for (let i = 0; i < objects.length; i++) if (objects[i]!.mesh.userData['pass'] === pass) return true;
      return false;
    },
    standIn(pass) {
      // A BatchedMesh like a region's (three's batching program variant), over the pass's material.
      const mesh = new BatchedMesh(1, 3, 3, materialOf[pass]);
      mesh.addInstance(mesh.addGeometry(TRIANGLE));
      mesh.name = `stand-in pass ${pass}`;
      mesh.visible = false;
      return { object: mesh, dispose: () => mesh.dispose() };
    },
    setOrigin(x, y, z) {
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
      for (const bp of objects) place(bp);
    },
    setXray(on) {
      xrayShown = on;
    },
    sortTranslucent() {
      // BatchedMesh sorts its translucent instances itself (sortObjects).
    },
    gpuBytes() {
      // An indexed loop: the bench reads this every frame (SP4b spec §3.10).
      let n = 0;
      for (let i = 0; i < objects.length; i++) n += bytesOf(objects[i]!.mesh);
      return n;
    },
  };
  return createStreamingRenderer<BatchRegion>('batch', root, backend);
}

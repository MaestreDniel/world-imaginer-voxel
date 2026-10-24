import { BatchedMesh, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, Sphere } from 'three';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, type ColumnMeshPayload } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import { createRegionStaging, rowBounds, rowsOfPass, sectionOrigin, type PayloadRow, type StagedRegion } from './regionGrid';
import type { SectionRenderer } from './sectionRenderer';

/**
 * RegionBatch (SP4a spec §6.2, D13): per region one `BatchedMesh` per pass that has geometry, sized exactly from the
 * region's payloads (instances = rows, vertices and indices = their sums). One instance per section and pass, whose
 * matrix is `T(sectionOrigin − floatingOrigin) · S(1/8)`; each section's `BufferGeometry` wraps the payload's
 * subarrays, with its bounding sphere (the payload's × 8) and box set before `addGeometry`. `BatchedMesh` culls and
 * sorts its instances itself (`perObjectFrustumCulled`, `sortObjects`).
 */

/** Geometry units per block: positions are in 1/8 blocks (spec §5.5). */
const UNITS = 8;

interface Batch {
  readonly mesh: BatchedMesh;
  /** The section origin (blocks) of each instance, three per instance id. */
  readonly origins: Float64Array;
}

const PASSES = [MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT] as const;

/**
 * The geometry of payload row `r` at offset `o` in `p.rows`: subarrays of the payload's buffers, bounds from its sphere
 * (× 8, in 1/8 blocks, section-local: `rowBounds` at offset 0).
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
  const sphere = new Sphere();
  const box = new Box3();
  rowBounds(p, r, 0, 0, 0, sphere, box);
  g.boundingSphere = sphere;
  g.boundingBox = box;
  return g;
}

export function createRegionBatch(materials: MaterialSystem): SectionRenderer {
  if (materials.variant !== 'batch') throw new Error(`RegionBatch needs the 'batch' material variant, got '${materials.variant}'`);
  const materialOf: Record<number, MaterialSystem['terrainOpaque']> = {
    [MESH_PASS_OPAQUE]: materials.terrainOpaque,
    [MESH_PASS_CUTOUT]: materials.terrainCutout,
    [MESH_PASS_TRANSLUCENT]: materials.water,
  };
  const root = new Group();
  root.name = 'regionBatch';
  root.visible = false;
  const staging = createRegionStaging();
  const batches: Batch[] = [];
  const origin = [0, 0, 0];
  const matrix = new Matrix4();
  let revealed = false;
  let sections = 0;
  let vertices = 0;
  let indices = 0;

  const place = (b: Batch, instance: number): void => {
    const o = 3 * instance;
    matrix.makeScale(1 / UNITS, 1 / UNITS, 1 / UNITS);
    matrix.setPosition(b.origins[o]! - origin[0]!, b.origins[o + 1]! - origin[1]!, b.origins[o + 2]! - origin[2]!);
    b.mesh.setMatrixAt(instance, matrix);
  };

  const buildRegion = (region: StagedRegion): number => {
    let added = 0;
    for (const pass of PASSES) {
      const rows: PayloadRow[] = [];
      const { vertices: vertexSum, indices: indexSum } = rowsOfPass(region.payloads, pass, rows);
      if (rows.length === 0 || indexSum === 0) continue;
      const mesh = new BatchedMesh(rows.length, vertexSum, indexSum, materialOf[pass]);
      mesh.name = `region ${region.rx},${region.rz} pass ${pass}`;
      mesh.userData['rx'] = region.rx;
      mesh.userData['rz'] = region.rz;
      mesh.userData['pass'] = pass;
      mesh.perObjectFrustumCulled = true;
      mesh.sortObjects = true;
      mesh.visible = revealed;
      const b: Batch = { mesh, origins: new Float64Array(3 * rows.length) };
      for (const { p, o, r } of rows) {
        const g = sectionGeometry(p, o, r);
        const instance = mesh.addInstance(mesh.addGeometry(g));
        b.origins.set(sectionOrigin(p.cx, p.cz, p.rows[o]!), 3 * instance);
        place(b, instance);
      }
      batches.push(b);
      root.add(mesh);
      added += rows.length;
      vertices += vertexSum;
      indices += indexSum;
    }
    sections += added;
    return added;
  };

  return {
    kind: 'batch',
    root,
    expect(columns) {
      staging.expect(columns);
    },
    stage(p) {
      staging.stage(p);
    },
    buildNext(exhausted) {
      return staging.buildReady(exhausted, buildRegion);
    },
    revealAll() {
      revealed = true;
      for (const b of batches) b.mesh.visible = true;
      root.visible = true;
    },
    setOrigin(x, y, z) {
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
      for (const b of batches) {
        for (let i = 0; i < b.mesh.instanceCount; i++) place(b, i);
        // A BatchedMesh caches its object bounds on the first frustum or sort test; setMatrixAt never clears them
        // (ruling P16).
        b.mesh.computeBoundingSphere();
        b.mesh.computeBoundingBox();
      }
    },
    sortTranslucent() {
      // BatchedMesh sorts its translucent instances itself (sortObjects).
    },
    counts() {
      return {
        expectedColumns: staging.expectedColumns,
        stagedColumns: staging.stagedColumns,
        regions: staging.regions,
        builtRegions: staging.builtRegions,
        sections,
        vertices,
        indices,
        mergeMs: 0,
      };
    },
    dispose() {
      for (const b of batches) {
        root.remove(b.mesh);
        b.mesh.dispose();
      }
      batches.length = 0;
      staging.clear();
      sections = vertices = indices = 0;
    },
  };
}

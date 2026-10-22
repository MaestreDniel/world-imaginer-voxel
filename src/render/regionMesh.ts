import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3 } from 'three';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS, type ColumnMeshPayload } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import { createRegionStaging, regionOrigin, type StagedRegion } from './regionGrid';
import type { SectionRenderer } from './sectionRenderer';

/**
 * RegionMesh (SP4a spec §6.2, D2, D13): the section renderer where `WEBGL_multi_draw` is missing (Firefox). Per region
 * one `Mesh` per pass that has geometry, over one merged `BufferGeometry` sized exactly from the region's payloads: the
 * sections' vertices concatenated, `position` rewritten to Uint16 × 4 region-local 1/8-block units (`x + lx·128`,
 * `y + sy·128`, `z + lz·128`, `w` 0), `data` copied unchanged, the indices rebased by each section's first vertex.
 * The mesh matrix is `T(regionOrigin − floatingOrigin) · S(1/8)`; three culls the region on the union of its section
 * spheres (`frustumCulled`); translucent regions are drawn back to front by region centre (`sortTranslucent`). In SP4a
 * a region's buffers are written once; master §4.5's sub-allocated ranges and `addUpdateRange` are SP4b's.
 */

/** Geometry units per block: positions are in 1/8 blocks (spec §5.5). */
const UNITS = 8;
/** One column's or section's extent in geometry units. */
const SECTION_UNITS = 16 * UNITS;
/** A region's half extent in blocks: 8 columns across, 24 sections (384 blocks) high. */
const REGION_HALF_XZ = 64;
const REGION_HALF_Y = 192;

const PASSES = [MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT] as const;

interface RegionPassMesh {
  readonly mesh: Mesh;
  /** The region origin in blocks: `(rx·128, −64, rz·128)`. */
  readonly origin: readonly [number, number, number];
  /** Squared distance from the camera to the region centre, written by `sortTranslucent` (translucent meshes only). */
  d2: number;
}

interface Row {
  readonly p: ColumnMeshPayload;
  /** The row's offset in `p.rows`. */
  readonly o: number;
  /** The row number (its sphere is at `4·r`). */
  readonly r: number;
}

/**
 * The merged geometry of `rows` (spec §6.2): exact Uint16 × 4 positions, Uint32 data and Uint32 indices, with its
 * bounding sphere the union of the section spheres (× 8, shifted to the section) and its box the union of their cubes,
 * each clipped to its section.
 */
function mergeRows(rows: readonly Row[], vertexSum: number, indexSum: number): BufferGeometry {
  const position = new Uint16Array(4 * vertexSum);
  const data = new Uint32Array(vertexSum);
  const index = new Uint32Array(indexSum);
  const sphere = new Sphere();
  const box = new Box3();
  const s = new Sphere();
  const sectionBox = new Box3();
  const sectionBounds = new Box3();
  const size = new Vector3();
  let v = 0;
  let i = 0;
  for (const { p, o, r } of rows) {
    const sy = p.rows[o]!;
    const vertexStart = p.rows[o + 2]!;
    const vertexCount = p.rows[o + 3]!;
    const indexStart = p.rows[o + 4]!;
    const indexCount = p.rows[o + 5]!;
    // The column's place in its region: cx − rx·8, the same as cx & 7 for negative cx too.
    const ox = (p.cx & 7) * SECTION_UNITS;
    const oy = sy * SECTION_UNITS;
    const oz = (p.cz & 7) * SECTION_UNITS;
    for (let k = 0, src = 4 * vertexStart, dst = 4 * v; k < vertexCount; k++, src += 4, dst += 4) {
      position[dst] = p.position[src]! + ox;
      position[dst + 1] = p.position[src + 1]! + oy;
      position[dst + 2] = p.position[src + 2]! + oz;
      // position[dst + 3] stays 0.
    }
    data.set(p.data.subarray(vertexStart, vertexStart + vertexCount), v);
    for (let k = 0; k < indexCount; k++) index[i + k] = p.index[indexStart + k]! + v;
    v += vertexCount;
    i += indexCount;

    const q = 4 * r;
    s.center.set(p.spheres[q]! * UNITS + ox, p.spheres[q + 1]! * UNITS + oy, p.spheres[q + 2]! * UNITS + oz);
    s.radius = p.spheres[q + 3]! * UNITS;
    // `union` copies into the empty sphere (radius −1) the first time.
    sphere.union(s);
    // The sphere's cube, clipped to the section (every position of the section lies in its 128-unit cube).
    sectionBox.setFromCenterAndSize(s.center, size.setScalar(2 * s.radius));
    sectionBounds.min.set(ox, oy, oz);
    sectionBounds.max.set(ox + SECTION_UNITS, oy + SECTION_UNITS, oz + SECTION_UNITS);
    sectionBox.intersect(sectionBounds);
    if (sectionBox.isEmpty()) sectionBox.setFromCenterAndSize(s.center, size.setScalar(0));
    box.union(sectionBox);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 4));
  g.setAttribute('data', new BufferAttribute(data, 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.boundingSphere = sphere;
  g.boundingBox = box;
  return g;
}

export function createRegionMesh(materials: MaterialSystem): SectionRenderer {
  if (materials.variant !== 'mesh') throw new Error(`RegionMesh needs the 'mesh' material variant, got '${materials.variant}'`);
  const materialOf: Record<number, MaterialSystem['terrainOpaque']> = {
    [MESH_PASS_OPAQUE]: materials.terrainOpaque,
    [MESH_PASS_CUTOUT]: materials.terrainCutout,
    [MESH_PASS_TRANSLUCENT]: materials.water,
  };
  const root = new Group();
  root.name = 'regionMesh';
  root.visible = false;
  const staging = createRegionStaging();
  const built: RegionPassMesh[] = [];
  const translucent: RegionPassMesh[] = [];
  const origin = [0, 0, 0];
  let revealed = false;
  let sections = 0;
  let vertices = 0;
  let indices = 0;
  let mergeMs = 0;

  const place = (m: RegionPassMesh): void => {
    m.mesh.position.set(m.origin[0] - origin[0]!, m.origin[1] - origin[1]!, m.origin[2] - origin[2]!);
  };

  const buildRegion = (region: StagedRegion): number => {
    const t0 = performance.now();
    const o = regionOrigin(region.rx, region.rz);
    let added = 0;
    for (const pass of PASSES) {
      const rows: Row[] = [];
      let vertexSum = 0;
      let indexSum = 0;
      for (const p of region.payloads) {
        for (let r = 0, ro = 0; ro < p.rows.length; r++, ro += ROW_INTS) {
          if (p.rows[ro + 1] !== pass) continue;
          rows.push({ p, o: ro, r });
          vertexSum += p.rows[ro + 3]!;
          indexSum += p.rows[ro + 5]!;
        }
      }
      if (rows.length === 0 || indexSum === 0) continue;
      const mesh = new Mesh(mergeRows(rows, vertexSum, indexSum), materialOf[pass]);
      mesh.name = `region ${region.rx},${region.rz} pass ${pass}`;
      mesh.userData['rx'] = region.rx;
      mesh.userData['rz'] = region.rz;
      mesh.userData['pass'] = pass;
      mesh.scale.setScalar(1 / UNITS);
      mesh.frustumCulled = true;
      mesh.visible = revealed;
      const m: RegionPassMesh = { mesh, origin: o, d2: 0 };
      place(m);
      built.push(m);
      if (pass === MESH_PASS_TRANSLUCENT) translucent.push(m);
      root.add(mesh);
      added += rows.length;
      vertices += vertexSum;
      indices += indexSum;
    }
    sections += added;
    mergeMs += performance.now() - t0;
    return added;
  };

  /** Farthest first; equal distances keep a stable order by region. */
  const fartherFirst = (a: RegionPassMesh, b: RegionPassMesh): number =>
    b.d2 - a.d2 || a.origin[2] - b.origin[2] || a.origin[0] - b.origin[0];

  return {
    kind: 'mesh',
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
      for (const m of built) m.mesh.visible = true;
      root.visible = true;
    },
    setOrigin(x, y, z) {
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
      // The geometry's bounds are region-local, so the mesh matrix is all that moves.
      for (const m of built) place(m);
    },
    sortTranslucent(camX, camY, camZ) {
      // Region centres in the camera's frame: regionOrigin + (64, 192, 64) − floatingOrigin (ruling P17).
      for (const m of translucent) {
        const dx = m.origin[0] + REGION_HALF_XZ - origin[0]! - camX;
        const dy = m.origin[1] + REGION_HALF_Y - origin[1]! - camY;
        const dz = m.origin[2] + REGION_HALF_XZ - origin[2]! - camZ;
        m.d2 = dx * dx + dy * dy + dz * dz;
      }
      translucent.sort(fartherFirst);
      // three draws the transparent list by ascending renderOrder before depth: the farthest region gets 0.
      for (let k = 0; k < translucent.length; k++) translucent[k]!.mesh.renderOrder = k;
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
        mergeMs,
      };
    },
    dispose() {
      for (const m of built) {
        root.remove(m.mesh);
        m.mesh.geometry.dispose();
      }
      built.length = 0;
      translucent.length = 0;
      staging.clear();
      sections = vertices = indices = 0;
      mergeMs = 0;
    },
  };
}

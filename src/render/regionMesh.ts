import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Sphere } from 'three';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import { createStreamingRenderer, regionOrigin, rowBounds, rowIsEmpty, type RegionBackend, type StagedColumn, type StagingRegion } from './regionGrid';
import type { SectionRenderer } from './sectionRenderer';

/**
 * RegionMesh (SP4a spec §6.2, D2, D13): the section renderer where `WEBGL_multi_draw` is missing (Firefox). Per region
 * one `Mesh` per pass, over one merged `BufferGeometry` of the region's revealed columns: the rows' vertices
 * concatenated, `position` rewritten to Uint16 × 4 region-local 1/8-block units (`x + lx·128`, `y + sy·128`,
 * `z + lz·128`, `w` 0), `data` copied unchanged, the indices rebased by each row's first vertex. The mesh matrix is
 * `T(regionOrigin − floatingOrigin) · S(1/8)`; three culls the region on the union of its row spheres; translucent
 * regions are drawn back to front by region centre (`sortTranslucent`).
 *
 * On the streaming staging (SP4b spec §4.1) it keeps SP4a's merge until SP4b Task 17's arena: an upload writes
 * nothing, and the region is merged again in the pump that reveals one of its columns, and at once when a revealed
 * column is removed (an emptied pass keeps its mesh, empty, until the region is disposed). The merges are not gated
 * structural operations: their time goes to `structuralMs` only.
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
  unculled: boolean;
}

interface MeshRegion {
  readonly passes: Array<RegionPassMesh | null>;
  /** A column was revealed in this pump: merged again at its end. */
  dirty: boolean;
}

type Column = StagedColumn<MeshRegion>;

/**
 * The merged geometry of the revealed `columns`' rows of `pass` (spec §6.2): exact Uint16 × 4 positions, Uint32 data
 * and Uint32 indices, its bounding sphere the union of the row spheres (× 8, shifted to the section) and its box the
 * union of their cubes, each clipped to its section. Each merged row's index range goes to the column's `ids`.
 */
function mergeRows(columns: readonly Column[], pass: number): BufferGeometry {
  let vertexSum = 0;
  let indexSum = 0;
  for (const c of columns) {
    if (!c.revealed) continue;
    for (let r = 0, o = 0; r < c.rows; r++, o += ROW_INTS) {
      if (c.p.rows[o + 1] !== pass || rowIsEmpty(c.p, r)) continue;
      vertexSum += c.p.rows[o + 3]!;
      indexSum += c.p.rows[o + 5]!;
    }
  }
  const position = new Uint16Array(4 * vertexSum);
  const data = new Uint32Array(vertexSum);
  const index = new Uint32Array(indexSum);
  const sphere = new Sphere();
  const box = new Box3();
  const s = new Sphere();
  const sectionBox = new Box3();
  let v = 0;
  let i = 0;
  for (const c of columns) {
    if (!c.revealed) continue;
    const p = c.p;
    // The column's place in its region: cx − rx·8, the same as cx & 7 for negative cx too.
    const ox = (p.cx & 7) * SECTION_UNITS;
    const oz = (p.cz & 7) * SECTION_UNITS;
    for (let r = 0, o = 0; r < c.rows; r++, o += ROW_INTS) {
      if (p.rows[o + 1] !== pass || rowIsEmpty(p, r)) continue;
      const oy = p.rows[o]! * SECTION_UNITS;
      const vertexStart = p.rows[o + 2]!;
      const vertexCount = p.rows[o + 3]!;
      const indexStart = p.rows[o + 4]!;
      const indexCount = p.rows[o + 5]!;
      for (let k = 0, src = 4 * vertexStart, dst = 4 * v; k < vertexCount; k++, src += 4, dst += 4) {
        position[dst] = p.position[src]! + ox;
        position[dst + 1] = p.position[src + 1]! + oy;
        position[dst + 2] = p.position[src + 2]! + oz;
        // position[dst + 3] stays 0.
      }
      data.set(p.data.subarray(vertexStart, vertexStart + vertexCount), v);
      for (let k = 0; k < indexCount; k++) index[i + k] = p.index[indexStart + k]! + v;
      c.ids[2 * r] = i;
      c.ids[2 * r + 1] = indexCount;
      v += vertexCount;
      i += indexCount;
      // The section's sphere and its cube clipped to the section, at the section's place in the region; `union`
      // copies into the empty sphere (radius −1) the first time.
      rowBounds(p, r, ox, oy, oz, s, sectionBox);
      sphere.union(s);
      box.union(sectionBox);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 4));
  g.setAttribute('data', new BufferAttribute(data, 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.boundingSphere = sphere;
  g.boundingBox = box;
  return g;
}

/** The geometry's position, data and index buffers in bytes. */
function bytesOf(g: BufferGeometry): number {
  return g.getAttribute('position').array.byteLength + g.getAttribute('data').array.byteLength + g.getIndex()!.array.byteLength;
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
  return createStreamingRenderer<MeshRegion>('mesh', root, (addStructuralMs) => {
    const built: RegionPassMesh[] = [];
    const translucent: RegionPassMesh[] = [];
    const unculled: RegionPassMesh[] = [];
    const dirty: Array<StagingRegion<MeshRegion>> = [];
    const origin = [0, 0, 0];

    const place = (m: RegionPassMesh): void => {
      m.mesh.position.set(m.origin[0] - origin[0]!, m.origin[1] - origin[1]!, m.origin[2] - origin[2]!);
    };
    const touch = (m: RegionPassMesh): void => {
      m.mesh.frustumCulled = false;
      if (!m.unculled) {
        m.unculled = true;
        unculled.push(m);
      }
    };

    /** Merges the region's revealed live columns again, pass by pass. */
    const merge = (g: StagingRegion<MeshRegion>): void => {
      const t0 = performance.now();
      for (const pass of PASSES) {
        const m = g.data.passes[pass] ?? null;
        let any = false;
        for (const c of g.columns) {
          if (!c.revealed) continue;
          for (let r = 0; r < c.rows && !any; r++) any = c.p.rows[r * ROW_INTS + 1] === pass && !rowIsEmpty(c.p, r);
          if (any) break;
        }
        if (m === null && !any) continue;
        const geometry = mergeRows(g.columns, pass);
        if (m !== null) {
          const prev = m.mesh.geometry;
          m.mesh.geometry = geometry;
          prev.dispose();
          touch(m);
          continue;
        }
        const mesh = new Mesh(geometry, materialOf[pass]);
        mesh.name = `region ${g.rx},${g.rz} pass ${pass}`;
        mesh.userData['rx'] = g.rx;
        mesh.userData['rz'] = g.rz;
        mesh.userData['pass'] = pass;
        mesh.scale.setScalar(1 / UNITS);
        const made: RegionPassMesh = { mesh, origin: regionOrigin(g.rx, g.rz), d2: 0, unculled: false };
        place(made);
        g.data.passes[pass] = made;
        built.push(made);
        if (pass === MESH_PASS_TRANSLUCENT) translucent.push(made);
        root.add(mesh);
        touch(made);
      }
      addStructuralMs(performance.now() - t0);
    };

    const backend: RegionBackend<MeshRegion> = {
      newRegion: () => ({ passes: [null, null, null], dirty: false }),
      columnNeed: () => null,
      rowNeed: () => null,
      structural(_c, kind) {
        throw new Error(`RegionMesh merges its regions (SP4b Task 17 brings the arena and '${kind}')`);
      },
      upload() {
        // The rows stay in the payload until the region's merge.
      },
      reveal(c) {
        const g = c.region;
        if (!g.data.dirty) {
          g.data.dirty = true;
          dirty.push(g);
        }
      },
      hide(c) {
        const wasMerged = c.revealed;
        c.ids.fill(-1);
        if (wasMerged) merge(c.region);
      },
      release() {
        // Merged out by `hide` already.
      },
      rowVisible(c, r) {
        const start = c.ids[2 * r]!;
        if (start < 0) return false;
        const m = c.region.data.passes[c.p.rows[r * ROW_INTS + 1]!] ?? null;
        if (m === null || !root.visible || !m.mesh.visible || m.mesh.parent !== root) return false;
        const index = m.mesh.geometry.getIndex()!.array;
        const end = Math.min(start + c.ids[2 * r + 1]!, index.length);
        for (let k = start; k + 2 < end; k += 3) if (index[k] !== index[k + 1] || index[k + 1] !== index[k + 2]) return true;
        return false;
      },
      settle() {
        // A merged geometry is uploaded whole (no update range): its first frame drew it unculled.
        for (const m of unculled) {
          m.mesh.frustumCulled = true;
          m.unculled = false;
        }
        unculled.length = 0;
      },
      flush() {
        for (const g of dirty) {
          g.data.dirty = false;
          merge(g);
        }
        dirty.length = 0;
      },
      disposeRegion(g) {
        for (const m of g.data.passes) {
          if (m === null) continue;
          root.remove(m.mesh);
          m.mesh.geometry.dispose();
          built.splice(built.indexOf(m), 1);
          const t = translucent.indexOf(m);
          if (t >= 0) translucent.splice(t, 1);
          const u = unculled.indexOf(m);
          if (u >= 0) unculled.splice(u, 1);
        }
        g.data.passes.fill(null);
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
      gpuBytes() {
        let n = 0;
        for (const m of built) n += bytesOf(m.mesh.geometry);
        return n;
      },
    };
    return backend;
  });
}

/** Farthest first; equal distances keep a stable order by region. */
const fartherFirst = (a: RegionPassMesh, b: RegionPassMesh): number =>
  b.d2 - a.d2 || a.origin[2] - b.origin[2] || a.origin[0] - b.origin[0];

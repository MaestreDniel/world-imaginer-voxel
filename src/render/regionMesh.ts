import { Box3, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Mesh, Sphere } from 'three';
import { MESH_PASS_CUTOUT, MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, ROW_INTS } from '../mesh/column';
import type { MaterialSystem } from './materials/index';
import {
  createStreamingRenderer, GROWTH, regionOrigin, RESERVATION, rowBounds, rowIsEmpty, SECTION_UNITS, UNITS,
  type RegionBackend, type StagedColumn,
} from './regionGrid';
import type { SectionRenderer, StructuralKind } from './sectionRenderer';

/**
 * RegionMesh (SP4a spec §6.2, D2; SP4b spec §4.3, D15): the section renderer where `WEBGL_multi_draw` is missing
 * (Firefox). Per region and pass one `Mesh` over one `BufferGeometry`, the arena: `position` Uint16 × 4 region-local
 * 1/8-block units (`x + lx·128`, `y + sy·128`, `z + lz·128`, `w` 0), `data` Uint32 copied unchanged and a Uint32 index,
 * of RegionBatch's reservations (opaque 131,072 vertices and 196,608 indices: 2,359,296 bytes), created at the
 * region's first row of that pass (a structural operation) and drawn over `(0, the index high-water mark)`. The mesh
 * matrix is `T(regionOrigin − floatingOrigin) · S(1/8)`; three culls the region on the union of its shown columns'
 * spheres; translucent regions are drawn back to front by region centre (`sortTranslucent`).
 *
 * Each column's rows of a pass take one vertex range and one index range (a span), first-fit from free lists sorted by
 * start and coalesced on release, taken whole at the column's first row of the pass. Uploading a row writes its
 * vertices (positions rewritten region-local, `data` copied) into the span; the span's indices stay zero (degenerate
 * triangles draw nothing) until the reveal frame writes them rebased. `remove` zeroes a shown span's indices at once
 * (the hiding: O(the column's indices), no merge), and `pump` releases its rows under the gate, freeing both ranges
 * with the last. Every range write is `addUpdateRange(start, count)` plus `needsUpdate = true`. A span that fits
 * nowhere waits for the frame's structural operation: compaction in place when the arena's free space is ≥ 40 % and
 * would hold it, else growth × 1.5 into a new geometry (three cannot resize an attribute), the old one disposed in
 * the same call. No path re-merges a region.
 */

/** A region's half extent in blocks: 8 columns across, 24 sections (384 blocks) high. */
const REGION_HALF_XZ = 64;
const REGION_HALF_Y = 192;
/** An arena whose free space reaches this share of its capacity is compacted instead of grown. */
const COMPACT_AT = 0.4;

const PASSES = [MESH_PASS_OPAQUE, MESH_PASS_CUTOUT, MESH_PASS_TRANSLUCENT] as const;

/**
 * A first-fit free list (SP4b spec §4.3): the free ranges `[starts[k], starts[k] + sizes[k])`, sorted by start, never
 * empty and never adjacent (a release merges with its neighbours); `free` is the sum of the sizes.
 */
export interface FreeList {
  readonly starts: number[];
  readonly sizes: number[];
  free: number;
}

/** A free list over `[0, capacity)`, all of it free. */
export function createFreeList(capacity: number): FreeList {
  return capacity > 0 ? { starts: [0], sizes: [capacity], free: capacity } : { starts: [], sizes: [], free: 0 };
}

/** The start of the first free range that holds `n`, or −1. */
export function firstFit(f: FreeList, n: number): number {
  for (let k = 0; k < f.starts.length; k++) if (f.sizes[k]! >= n) return f.starts[k]!;
  return -1;
}

/** Takes `n` from the start of the first free range that holds it: its start, or −1 (nothing taken). */
export function takeFirstFit(f: FreeList, n: number): number {
  for (let k = 0; k < f.starts.length; k++) {
    const size = f.sizes[k]!;
    if (size < n) continue;
    const start = f.starts[k]!;
    if (size === n) {
      f.starts.splice(k, 1);
      f.sizes.splice(k, 1);
    } else {
      f.starts[k] = start + n;
      f.sizes[k] = size - n;
    }
    f.free -= n;
    return start;
  }
  return -1;
}

/** Frees `[start, start + n)`, merged with the free ranges it touches; a range already free (in part) throws. */
export function giveRange(f: FreeList, start: number, n: number): void {
  if (n <= 0) return;
  let k = 0;
  while (k < f.starts.length && f.starts[k]! < start) k++;
  const prevEnd = k > 0 ? f.starts[k - 1]! + f.sizes[k - 1]! : Number.NEGATIVE_INFINITY;
  const next = k < f.starts.length ? f.starts[k]! : Number.POSITIVE_INFINITY;
  if (prevEnd > start || start + n > next) throw new Error(`range [${start}, ${start + n}) is already free in part`);
  const withPrev = prevEnd === start;
  const withNext = start + n === next;
  if (withPrev && withNext) {
    f.sizes[k - 1] = f.sizes[k - 1]! + n + f.sizes[k]!;
    f.starts.splice(k, 1);
    f.sizes.splice(k, 1);
  } else if (withPrev) {
    f.sizes[k - 1] = f.sizes[k - 1]! + n;
  } else if (withNext) {
    f.starts[k] = start;
    f.sizes[k] = f.sizes[k]! + n;
  } else {
    f.starts.splice(k, 0, start);
    f.sizes.splice(k, 0, n);
  }
  f.free += n;
}

/** After a compaction: `[used, capacity)` is the one free range. */
function resetFreeList(f: FreeList, used: number, capacity: number): void {
  f.starts.length = 0;
  f.sizes.length = 0;
  if (capacity > used) {
    f.starts.push(used);
    f.sizes.push(capacity - used);
  }
  f.free = capacity - used;
}

type Column = StagedColumn<MeshRegion>;

/** One column's rows of one pass in an arena: a vertex range and an index range, taken whole at its first row. */
interface Span {
  readonly column: Column;
  readonly pass: number;
  v0: number;
  readonly vn: number;
  i0: number;
  readonly iN: number;
  /** The vertices and indices of the rows written so far (the next row goes at `v0 + vUsed`, `i0 + iUsed`). */
  vUsed: number;
  iUsed: number;
  /** Rows written and not released: the ranges are freed with the last. */
  held: number;
  /** The indices are written (revealed and not removed); otherwise the index range holds zeros. */
  shown: boolean;
  /** The written rows' bounds in the region (1/8 blocks). */
  readonly sphere: Sphere;
  readonly box: Box3;
  /** The vertex move of the compaction in progress. */
  dv: number;
}

interface Arena {
  readonly mesh: Mesh;
  /** The region origin in blocks: `(rx·128, −64, rz·128)`. */
  readonly origin: readonly [number, number, number];
  position: BufferAttribute;
  data: BufferAttribute;
  index: BufferAttribute;
  readonly vertices: FreeList;
  readonly indices: FreeList;
  /** Spans holding ranges (live columns, and removed ones with rows held). */
  readonly spans: Span[];
  /** The end of the highest index range taken: the draw range's count. */
  highWater: number;
  /**
   * Per attribute (position, data, index): its next upload must send the whole array (after a compaction), so a write
   * adds no range until three's upload callback clears the flag.
   */
  readonly whole: [boolean, boolean, boolean];
  /** The geometry's culling sphere and box: the union of the shown spans'. */
  readonly sphere: Sphere;
  readonly box: Box3;
  /** Squared distance from the camera to the region centre, written by `sortTranslucent` (translucent arenas only). */
  d2: number;
  /** In the unculled list: written since three last uploaded all of it. */
  unculled: boolean;
}

interface MeshRegion {
  /** By pass; null until the region's first row of that pass. */
  readonly passes: Array<Arena | null>;
}

/** The geometry's position, data and index buffers in bytes. */
function bytesOf(g: BufferGeometry): number {
  return g.getAttribute('position').array.byteLength + g.getAttribute('data').array.byteLength + g.getIndex()!.array.byteLength;
}

/** An empty arena geometry of `vertices` and `indices` (the index zero: every triangle degenerate). */
function arenaGeometry(vertices: number, indices: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Uint16Array(4 * vertices), 4).setUsage(DynamicDrawUsage));
  g.setAttribute('data', new BufferAttribute(new Uint32Array(vertices), 1).setUsage(DynamicDrawUsage));
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1).setUsage(DynamicDrawUsage));
  g.setDrawRange(0, 0);
  return g;
}

const scratchSphere = new Sphere();
const scratchBox = new Box3();

export function createRegionMesh(materials: MaterialSystem): SectionRenderer {
  if (materials.variant !== 'mesh') throw new Error(`RegionMesh needs the 'mesh' material variant, got '${materials.variant}'`);
  const materialOf: Record<number, MaterialSystem['terrainOpaque']> = {
    [MESH_PASS_OPAQUE]: materials.terrainOpaque,
    [MESH_PASS_CUTOUT]: materials.terrainCutout,
    [MESH_PASS_TRANSLUCENT]: materials.water,
  };
  const root = new Group();
  root.name = 'regionMesh';
  const built: Arena[] = [];
  const translucent: Arena[] = [];
  const unculled: Arena[] = [];
  const origin = [0, 0, 0];
  // The pass, vertices and indices of the last need found (columnNeed, rowNeed), for `structural`.
  let needPass = 0;
  let needVertices = 0;
  let needIndices = 0;

  const passOf = (c: Column, r: number): number => c.p.rows[r * ROW_INTS + 1]!;

  const place = (a: Arena): void => {
    a.mesh.position.set(a.origin[0] - origin[0]!, a.origin[1] - origin[1]!, a.origin[2] - origin[2]!);
  };
  /** Written in this call: drawn unculled until three has uploaded it (SP4b spec §3.9). */
  const touch = (a: Arena): void => {
    a.mesh.frustumCulled = false;
    if (!a.unculled) {
      a.unculled = true;
      unculled.push(a);
    }
  };
  /** Marks `[start, start + count)` of attribute `k` (0 position, 1 data, 2 index) for three's next upload. */
  const mark = (a: Arena, k: 0 | 1 | 2, start: number, count: number): void => {
    const attribute = k === 0 ? a.position : k === 1 ? a.data : a.index;
    if (!a.whole[k]) attribute.addUpdateRange(start, count);
    attribute.needsUpdate = true;
  };
  /**
   * Three's upload of an attribute sends its ranges, or the whole array (its first upload, or no range after a
   * compaction), and then calls back: no range is left pending either way (r186's first upload keeps them).
   */
  const watchUploads = (a: Arena): void => {
    [a.position, a.data, a.index].forEach((attribute, k) => {
      attribute.onUpload(() => {
        attribute.clearUpdateRanges();
        a.whole[k] = false;
      });
    });
  };
  const pending = (a: Arena): boolean =>
    a.whole[0] || a.whole[1] || a.whole[2]
    || a.position.updateRanges.length > 0 || a.data.updateRanges.length > 0 || a.index.updateRanges.length > 0;

  const spanOf = (a: Arena, c: Column): Span | null => {
    for (let k = 0; k < a.spans.length; k++) if (a.spans[k]!.column === c) return a.spans[k]!;
    return null;
  };
  /** The vertices and indices of the column's non-empty rows of `pass` (its span's size), into needVertices/Indices. */
  const sizeOf = (c: Column, pass: number): void => {
    needVertices = 0;
    needIndices = 0;
    for (let r = 0, o = 0; r < c.rows; r++, o += ROW_INTS) {
      if (c.p.rows[o + 1] !== pass || rowIsEmpty(c.p, r)) continue;
      needVertices += c.p.rows[o + 3]!;
      needIndices += c.p.rows[o + 5]!;
    }
  };
  /**
   * The operation a span of needVertices and needIndices needs in `a`, or null when one fits: compaction when the free
   * space is ≥ 40 % of the arena (vertices and indices) and would hold the span (so it is fragmented), else growth.
   */
  const fitNeed = (a: Arena): StructuralKind | null => {
    if (firstFit(a.vertices, needVertices) >= 0 && firstFit(a.indices, needIndices) >= 0) return null;
    const v = a.vertices.free;
    const i = a.indices.free;
    const compact = v >= COMPACT_AT * a.data.count && i >= COMPACT_AT * a.index.count && v >= needVertices && i >= needIndices;
    return compact ? 'compact' : 'grow';
  };
  /** The operation the column's span of `pass` needs, or null (it has one, or one fits). */
  const passNeed = (c: Column, pass: number): StructuralKind | null => {
    const a = c.region.data.passes[pass] ?? null;
    needPass = pass;
    if (a === null) return 'create';
    if (spanOf(a, c) !== null) return null;
    sizeOf(c, pass);
    return fitNeed(a);
  };

  /** The arena's culling bounds: the union of its shown spans' (≤ 64 columns), recomputed on a reveal or a hide. */
  const bound = (a: Arena): void => {
    a.sphere.makeEmpty();
    a.box.makeEmpty();
    for (const s of a.spans) {
      if (!s.shown) continue;
      a.sphere.union(s.sphere);
      a.box.union(s.box);
    }
  };
  const setHighWater = (a: Arena): void => {
    let hw = 0;
    for (const s of a.spans) hw = Math.max(hw, s.i0 + s.iN);
    a.highWater = hw;
    a.mesh.geometry.setDrawRange(0, hw);
  };

  /** A new arena of the pass's reservation in the column's region (structural). */
  const create = (c: Column, pass: number): Arena => {
    const g = c.region;
    const [vertices, indices] = RESERVATION[pass]!;
    const geometry = arenaGeometry(vertices, indices);
    const sphere = new Sphere().makeEmpty();
    const box = new Box3();
    geometry.boundingSphere = sphere;
    geometry.boundingBox = box;
    const mesh = new Mesh(geometry, materialOf[pass]);
    mesh.name = `region ${g.rx},${g.rz} pass ${pass}`;
    mesh.userData['rx'] = g.rx;
    mesh.userData['rz'] = g.rz;
    mesh.userData['pass'] = pass;
    mesh.scale.setScalar(1 / UNITS);
    const a: Arena = {
      mesh, origin: regionOrigin(g.rx, g.rz),
      position: geometry.getAttribute('position') as BufferAttribute,
      data: geometry.getAttribute('data') as BufferAttribute,
      index: geometry.getIndex()!,
      vertices: createFreeList(vertices), indices: createFreeList(indices), spans: [], highWater: 0,
      whole: [false, false, false], sphere, box, d2: 0, unculled: false,
    };
    watchUploads(a);
    place(a);
    g.data.passes[pass] = a;
    built.push(a);
    if (pass === MESH_PASS_TRANSLUCENT) translucent.push(a);
    root.add(mesh);
    touch(a);
    return a;
  };

  /**
   * Compaction in place (structural): the spans move down in vertex order and in index order (`copyWithin`; a shown
   * span's index values are rebased by its vertex move), the stale index tail is zeroed, and every attribute is
   * uploaded whole (`clearUpdateRanges()`, then `needsUpdate`); no array is reallocated.
   */
  const compact = (a: Arena): void => {
    const position = a.position.array as Uint16Array;
    const data = a.data.array as Uint32Array;
    const index = a.index.array as Uint32Array;
    a.spans.sort((x, y) => x.v0 - y.v0);
    let v = 0;
    for (const s of a.spans) {
      s.dv = v - s.v0;
      if (s.dv !== 0) {
        position.copyWithin(4 * v, 4 * s.v0, 4 * (s.v0 + s.vn));
        data.copyWithin(v, s.v0, s.v0 + s.vn);
        s.v0 = v;
      }
      v += s.vn;
    }
    a.spans.sort((x, y) => x.i0 - y.i0);
    let i = 0;
    for (const s of a.spans) {
      const di = i - s.i0;
      if (di !== 0) index.copyWithin(i, s.i0, s.i0 + s.iN);
      if (s.shown && s.dv !== 0) for (let k = i; k < i + s.iN; k++) index[k] = index[k]! + s.dv;
      if (di !== 0) {
        // The column's rows of the pass keep their index ranges (`ids`) in step.
        const c = s.column;
        for (let r = c.released; r < c.uploaded; r++) if (c.ids[2 * r]! >= 0 && passOf(c, r) === s.pass) c.ids[2 * r] = c.ids[2 * r]! + di;
        s.i0 = i;
      }
      i += s.iN;
    }
    // Free index space holds zeros, so a span taken there is hidden until its reveal.
    index.fill(0, i, a.highWater);
    resetFreeList(a.vertices, v, a.data.count);
    resetFreeList(a.indices, i, a.index.count);
    setHighWater(a);
    [a.position, a.data, a.index].forEach((attribute, k) => {
      attribute.clearUpdateRanges();
      attribute.needsUpdate = true;
      a.whole[k] = true;
    });
    touch(a);
  };

  /**
   * Growth × 1.5 (structural): a new geometry with new attributes, the spans copied in at the same places (the whole
   * old arrays: free index space is zero), `mesh.geometry = next` and the old geometry disposed in the same call.
   */
  const grow = (a: Arena): void => {
    const prev = a.mesh.geometry;
    const vertices = a.data.count;
    const indices = a.index.count;
    const next = arenaGeometry(Math.ceil(vertices * GROWTH), Math.ceil(indices * GROWTH));
    (next.getAttribute('position').array as Uint16Array).set(a.position.array as Uint16Array);
    (next.getAttribute('data').array as Uint32Array).set(a.data.array as Uint32Array);
    (next.getIndex()!.array as Uint32Array).set(a.index.array as Uint32Array);
    next.boundingSphere = a.sphere;
    next.boundingBox = a.box;
    a.position = next.getAttribute('position') as BufferAttribute;
    a.data = next.getAttribute('data') as BufferAttribute;
    a.index = next.getIndex()!;
    a.whole.fill(false);
    watchUploads(a);
    giveRange(a.vertices, vertices, a.data.count - vertices);
    giveRange(a.indices, indices, a.index.count - indices);
    a.mesh.geometry = next;
    prev.dispose();
    setHighWater(a);
    touch(a);
  };

  const backend: RegionBackend<MeshRegion> = {
    newRegion: () => ({ passes: [null, null, null] }),
    columnNeed(c) {
      for (const pass of PASSES) {
        let any = false;
        for (let r = c.uploaded; r < c.rows && !any; r++) any = passOf(c, r) === pass && !rowIsEmpty(c.p, r);
        if (!any) continue;
        const k = passNeed(c, pass);
        if (k !== null) return k;
      }
      return null;
    },
    rowNeed(c, r) {
      return passNeed(c, passOf(c, r));
    },
    structural(c, kind) {
      const pass = needPass;
      if (kind === 'create') return bytesOf(create(c, pass).mesh.geometry);
      const a = c.region.data.passes[pass] ?? null;
      if (a === null) throw new Error(`no pass ${pass} arena in region (${c.region.rx}, ${c.region.rz}) for '${kind}'`);
      if (kind === 'compact') compact(a);
      else if (kind === 'grow') grow(a);
      else throw new Error(`RegionMesh has no '${kind}' (RegionBatch's)`);
      return bytesOf(a.mesh.geometry);
    },
    upload(c, r) {
      const o = r * ROW_INTS;
      const p = c.p;
      const pass = p.rows[o + 1]!;
      const a = c.region.data.passes[pass]!;
      let s = spanOf(a, c);
      if (s === null) {
        // The column's first row of the pass takes the whole span (rowNeed found that it fits).
        sizeOf(c, pass);
        const v0 = takeFirstFit(a.vertices, needVertices);
        const i0 = takeFirstFit(a.indices, needIndices);
        if (v0 < 0 || i0 < 0) throw new Error(`column (${c.cx}, ${c.cz}) found no pass ${pass} range`);
        s = {
          column: c, pass, v0, vn: needVertices, i0, iN: needIndices, vUsed: 0, iUsed: 0, held: 0, shown: false,
          sphere: new Sphere().makeEmpty(), box: new Box3(), dv: 0,
        };
        a.spans.push(s);
        if (i0 + needIndices > a.highWater) {
          a.highWater = i0 + needIndices;
          a.mesh.geometry.setDrawRange(0, a.highWater);
        }
      }
      const vertexStart = p.rows[o + 2]!;
      const vertexCount = p.rows[o + 3]!;
      const indexCount = p.rows[o + 5]!;
      // The section's place in its region: cx − rx·8, the same as cx & 7 for negative cx too.
      const ox = (c.cx & 7) * SECTION_UNITS;
      const oy = p.rows[o]! * SECTION_UNITS;
      const oz = (c.cz & 7) * SECTION_UNITS;
      const position = a.position.array as Uint16Array;
      const v = s.v0 + s.vUsed;
      for (let k = 0, src = 4 * vertexStart, dst = 4 * v; k < vertexCount; k++, src += 4, dst += 4) {
        position[dst] = p.position[src]! + ox;
        position[dst + 1] = p.position[src + 1]! + oy;
        position[dst + 2] = p.position[src + 2]! + oz;
        position[dst + 3] = 0;
      }
      (a.data.array as Uint32Array).set(p.data.subarray(vertexStart, vertexStart + vertexCount), v);
      mark(a, 0, 4 * v, 4 * vertexCount);
      mark(a, 1, v, vertexCount);
      c.ids[2 * r] = s.i0 + s.iUsed;
      c.ids[2 * r + 1] = indexCount;
      s.vUsed += vertexCount;
      s.iUsed += indexCount;
      s.held++;
      // The section's sphere and its cube clipped to the section, at the section's place in the region; `union`
      // copies into the empty sphere (radius −1) the first time.
      rowBounds(p, r, ox, oy, oz, scratchSphere, scratchBox);
      s.sphere.union(scratchSphere);
      s.box.union(scratchBox);
      touch(a);
    },
    reveal(c) {
      for (const pass of PASSES) {
        const a = c.region.data.passes[pass] ?? null;
        const s = a === null ? null : spanOf(a, c);
        if (a === null || s === null) continue;
        // The pass's rows lie in payload order from v0: each row's indices rebased by its first vertex.
        const index = a.index.array as Uint32Array;
        let v = s.v0;
        for (let r = c.released, o = r * ROW_INTS; r < c.uploaded; r++, o += ROW_INTS) {
          if (c.p.rows[o + 1] !== pass || c.ids[2 * r]! < 0) continue;
          const indexStart = c.p.rows[o + 4]!;
          const indexCount = c.p.rows[o + 5]!;
          for (let k = 0, dst = c.ids[2 * r]!; k < indexCount; k++, dst++) index[dst] = c.p.index[indexStart + k]! + v;
          v += c.p.rows[o + 3]!;
        }
        mark(a, 2, s.i0, s.iN);
        s.shown = true;
        bound(a);
        touch(a);
      }
    },
    hide(c) {
      for (const pass of PASSES) {
        const a = c.region.data.passes[pass] ?? null;
        const s = a === null ? null : spanOf(a, c);
        if (a === null || s === null || !s.shown) continue;
        (a.index.array as Uint32Array).fill(0, s.i0, s.i0 + s.iN);
        mark(a, 2, s.i0, s.iN);
        s.shown = false;
        bound(a);
        touch(a);
      }
    },
    release(c, r) {
      if (c.ids[2 * r]! < 0) return;
      const a = c.region.data.passes[passOf(c, r)]!;
      const s = spanOf(a, c)!;
      c.ids[2 * r] = -1;
      c.ids[2 * r + 1] = -1;
      if (--s.held > 0) return;
      // The last row: both ranges back to the free lists (the index range holds zeros: never shown, or hidden).
      giveRange(a.vertices, s.v0, s.vn);
      giveRange(a.indices, s.i0, s.iN);
      a.spans.splice(a.spans.indexOf(s), 1);
      setHighWater(a);
    },
    rowVisible(c, r) {
      const start = c.ids[2 * r]!;
      if (start < 0) return false;
      const a = c.region.data.passes[passOf(c, r)] ?? null;
      if (a === null || !root.visible || !a.mesh.visible || a.mesh.parent !== root) return false;
      const index = a.index.array;
      const end = Math.min(start + c.ids[2 * r + 1]!, a.highWater);
      for (let k = start; k + 2 < end; k += 3) if (index[k] !== index[k + 1] || index[k + 1] !== index[k + 2]) return true;
      return false;
    },
    settle() {
      for (let i = unculled.length - 1; i >= 0; i--) {
        const a = unculled[i]!;
        if (pending(a)) continue;
        a.mesh.frustumCulled = true;
        a.unculled = false;
        const last = unculled.pop()!;
        if (i < unculled.length) unculled[i] = last;
      }
    },
    disposeRegion(g) {
      for (const a of g.data.passes) {
        if (a === null) continue;
        root.remove(a.mesh);
        a.mesh.geometry.dispose();
        built.splice(built.indexOf(a), 1);
        const t = translucent.indexOf(a);
        if (t >= 0) translucent.splice(t, 1);
        if (a.unculled) unculled.splice(unculled.indexOf(a), 1);
      }
      g.data.passes.fill(null);
    },
    setOrigin(x, y, z) {
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
      // The geometry's bounds are region-local, so the mesh matrix is all that moves.
      for (const a of built) place(a);
    },
    sortTranslucent(camX, camY, camZ) {
      // Region centres in the camera's frame: regionOrigin + (64, 192, 64) − floatingOrigin (ruling P17).
      for (const a of translucent) {
        const dx = a.origin[0] + REGION_HALF_XZ - origin[0]! - camX;
        const dy = a.origin[1] + REGION_HALF_Y - origin[1]! - camY;
        const dz = a.origin[2] + REGION_HALF_XZ - origin[2]! - camZ;
        a.d2 = dx * dx + dy * dy + dz * dz;
      }
      translucent.sort(fartherFirst);
      // three draws the transparent list by ascending renderOrder before depth: the farthest region gets 0.
      for (let k = 0; k < translucent.length; k++) translucent[k]!.mesh.renderOrder = k;
    },
    gpuBytes() {
      let n = 0;
      for (const a of built) n += bytesOf(a.mesh.geometry);
      return n;
    },
  };
  return createStreamingRenderer<MeshRegion>('mesh', root, backend);
}

/** Farthest first; equal distances keep a stable order by region. */
const fartherFirst = (a: Arena, b: Arena): number =>
  b.d2 - a.d2 || a.origin[2] - b.origin[2] || a.origin[0] - b.origin[0];

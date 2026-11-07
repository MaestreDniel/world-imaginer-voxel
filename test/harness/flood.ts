/** Cell adjacency of `components`: 4 = edge neighbours only, 8 = edge and corner neighbours. */
export type Connectivity = 4 | 8;

export interface Components {
  readonly label: Int32Array;
  readonly count: number;
  /** Cells per component (index = label). */
  readonly size: Int32Array;
  /** Bounding box per component: minI, minJ, maxI, maxJ (index = 4·label). */
  readonly bbox: Int32Array;
}

/** Already-visited neighbours of a cell in the row-major scan (west, north-west, north, north-east). */
const BACK_8 = [[-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
const BACK_4 = [[-1, 0], [0, -1]] as const;

/**
 * Component labelling of a row-major n × n mask (union-find), 8-connected by default (B2, B5) or 4-connected (Z2,
 * SP3e spec §5.3: islands across a one-cell diagonal strait stay apart). Labels 0 = background, 1..count, in scan
 * order of each component's first cell.
 */
export function components(mask: Uint8Array, n: number, connectivity: Connectivity = 8): Components {
  if (connectivity !== 4 && connectivity !== 8) throw new Error(`components: connectivity ${String(connectivity)} is not 4 or 8`);
  const back = connectivity === 8 ? BACK_8 : BACK_4;
  const parent = new Int32Array(n * n).fill(-1);
  const find = (a: number): number => {
    while (parent[a]! !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    if (mask[k] === 0) continue;
    parent[k] = k;
    for (const [di, dj] of back) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n) continue;
      const kk = jj * n + ii;
      if (mask[kk] !== 0) union(k, kk);
    }
  }
  const label = new Int32Array(n * n);
  const ids = new Map<number, number>();
  for (let k = 0; k < n * n; k++) {
    if (mask[k] === 0) continue;
    const r = find(k);
    let id = ids.get(r);
    if (id === undefined) { id = ids.size + 1; ids.set(r, id); }
    label[k] = id;
  }
  const count = ids.size;
  const size = new Int32Array(count + 1);
  const bbox = new Int32Array(4 * (count + 1));
  for (let c = 1; c <= count; c++) { bbox[4 * c] = n; bbox[4 * c + 1] = n; bbox[4 * c + 2] = -1; bbox[4 * c + 3] = -1; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = label[j * n + i]!;
    if (c === 0) continue;
    size[c]!++;
    bbox[4 * c] = Math.min(bbox[4 * c]!, i);
    bbox[4 * c + 1] = Math.min(bbox[4 * c + 1]!, j);
    bbox[4 * c + 2] = Math.max(bbox[4 * c + 2]!, i);
    bbox[4 * c + 3] = Math.max(bbox[4 * c + 3]!, j);
  }
  return { label, count, size, bbox };
}

/** The 3D components of `components3d` (SP6a spec §10.1, Spec correction 19). */
export interface Components3d {
  /**
   * One entry per voxel of the box, index `((y − yMin)·d + z)·w + x`: the voxel's component, 1 … count, numbered in
   * index order of each component's first voxel, where `cave` holds; 0 elsewhere.
   */
  readonly label: Int32Array;
  /** Voxels per component (label → count). */
  readonly size: Map<number, number>;
  /** The sky-connected components' labels. */
  readonly sky: Set<number>;
}

/** The slab height of `components3d`'s labelling. */
const SLAB = 16;

/**
 * 6-connected components of the voxels where `cave` holds (SP6a spec §10.1, Spec correction 19: the region's tagged
 * air), over the box x ∈ [0, w), z ∈ [0, d), y ∈ [yMin, yMax] in the predicates' own coordinates (`cave` is called
 * once per voxel, `open` once per voxel where `cave` does not hold, so `cave` wins where both would). The box is labelled per 16-block slab from yMin, by a flood
 * inside the slab, and the slabs are joined by a union-find across their shared planes. The open air (`open`: in the
 * metric, air or fluid that is not tagged) is labelled the same way, and the sky flood is its components that hold a
 * voxel at y = yMax (a flood from the top over open air, inside the box). A cave component is sky-connected when one
 * of its voxels is face-adjacent to a voxel that flood reaches: the atmosphere is never part of a component, so two
 * entrances under one sky stay two components.
 */
export function components3d(
  cave: (x: number, y: number, z: number) => boolean,
  open: (x: number, y: number, z: number) => boolean,
  w: number, d: number, yMin: number, yMax: number,
): Components3d {
  for (const [name, v] of [['w', w], ['d', d]] as const) {
    if (!Number.isInteger(v) || v < 1) throw new RangeError(`components3d: ${name} = ${v} is not an integer ≥ 1`);
  }
  if (!Number.isInteger(yMin) || !Number.isInteger(yMax) || yMax < yMin) throw new RangeError(`components3d: y range ${yMin} … ${yMax}`);
  const plane = w * d;
  const n = plane * (yMax - yMin + 1);
  // Provisional labels: +id for cave, −id for open air, 0 for neither; ids from 1 share one union-find.
  const label = new Int32Array(n);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a: number): number => {
    while (parent[a]! !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const cls = new Uint8Array(plane * SLAB);
  const queue = new Int32Array(plane * SLAB);
  for (let y0 = yMin; y0 <= yMax; y0 += SLAB) {
    const h = Math.min(SLAB, yMax - y0 + 1);
    const size = plane * h;
    const base = (y0 - yMin) * plane;
    for (let ly = 0; ly < h; ly++) {
      for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
          const y = y0 + ly;
          cls[(ly * d + z) * w + x] = cave(x, y, z) ? 1 : open(x, y, z) ? 2 : 0;
        }
      }
    }
    // A flood per provisional component inside the slab.
    for (let s = 0; s < size; s++) {
      const c = cls[s]!;
      if (c === 0 || label[base + s] !== 0) continue;
      if (next === parent.length) {
        const grown = new Int32Array(2 * parent.length);
        grown.set(parent);
        parent = grown;
      }
      const id = next++;
      parent[id] = id;
      const v = c === 1 ? id : -id;
      label[base + s] = v;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        const q = queue[head++]!;
        const x = q % w;
        const z = ((q - x) / w) % d;
        const ly = (q - x - z * w) / plane;
        const visit = (t: number): void => {
          if (cls[t] === c && label[base + t] === 0) {
            label[base + t] = v;
            queue[tail++] = t;
          }
        };
        if (x > 0) visit(q - 1);
        if (x < w - 1) visit(q + 1);
        if (z > 0) visit(q - w);
        if (z < d - 1) visit(q + w);
        if (ly > 0) visit(q - plane);
        if (ly < h - 1) visit(q + plane);
      }
    }
    // Join the slab's bottom plane to the top plane of the slab below.
    if (y0 > yMin) {
      for (let p = 0; p < plane; p++) {
        const a = label[base + p]!;
        const b = label[base - plane + p]!;
        if (a !== 0 && (a > 0) === (b > 0) && b !== 0) union(Math.abs(a), Math.abs(b));
      }
    }
  }
  const root = new Int32Array(next);
  for (let id = 1; id < next; id++) root[id] = find(id);
  // The sky flood: the open components holding a voxel of the top plane.
  const skyOpen = new Uint8Array(next);
  for (let p = n - plane; p < n; p++) {
    const a = label[p]!;
    if (a < 0) skyOpen[root[-a]!] = 1;
  }
  // Cave components face-adjacent to the sky flood.
  const skyCave = new Uint8Array(next);
  const opensToSky = (t: number): boolean => {
    const b = label[t]!;
    return b < 0 && skyOpen[root[-b]!] === 1;
  };
  for (let i = 0; i < n; i++) {
    const a = label[i]!;
    if (a <= 0) continue;
    const r = root[a]!;
    if (skyCave[r] === 1) continue;
    const x = i % w;
    const z = ((i - x) / w) % d;
    const yy = (i - x - z * w) / plane;
    if ((x > 0 && opensToSky(i - 1)) || (x < w - 1 && opensToSky(i + 1)) || (z > 0 && opensToSky(i - w)) ||
      (z < d - 1 && opensToSky(i + w)) || (yy > 0 && opensToSky(i - plane)) || (i + plane < n && opensToSky(i + plane))) {
      skyCave[r] = 1;
    }
  }
  // Final labels in index order of each component's first voxel.
  const finalOf = new Int32Array(next);
  const counts: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = label[i]!;
    if (a <= 0) { label[i] = 0; continue; }
    const r = root[a]!;
    let f = finalOf[r]!;
    if (f === 0) { f = counts.length; finalOf[r] = f; counts.push(0); }
    label[i] = f;
    counts[f]!++;
  }
  const size = new Map<number, number>();
  const sky = new Set<number>();
  for (let f = 1; f < counts.length; f++) size.set(f, counts[f]!);
  for (let r = 1; r < next; r++) if (finalOf[r]! !== 0 && skyCave[r] === 1) sky.add(finalOf[r]!);
  return { label, size, sky };
}

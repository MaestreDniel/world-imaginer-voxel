/** 8-connected component labelling of a row-major n × n mask (union-find). Labels 0 = background, 1..count. */
export interface Components {
  readonly label: Int32Array;
  readonly count: number;
  /** Cells per component (index = label). */
  readonly size: Int32Array;
  /** Bounding box per component: minI, minJ, maxI, maxJ (index = 4·label). */
  readonly bbox: Int32Array;
}

export function components(mask: Uint8Array, n: number): Components {
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
    for (const [di, dj] of [[-1, 0], [-1, -1], [0, -1], [1, -1]] as const) {
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

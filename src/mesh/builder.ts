/**
 * The mesher's output (SP4a spec §5.5, §5.8): per mesh pass (0 opaque, 1 cutout, 2 translucent) one growable
 * `position` (Uint8 × 4 per vertex: x, y, z in 1/8-block units, then 0), `data` (one `PACK_LAYOUT` word per vertex)
 * and `index` (Uint32, six per quad, relative to the pass's first vertex) array. A builder lives in the mesh job's
 * worker-local scratch and is `reset` per section; `quad` allocates nothing except when a pass outgrows its arrays,
 * which then double.
 */

/** A mesh pass: 0 opaque, 1 cutout, 2 translucent (`MESH_PASS_*` in `mesh/column.ts`). */
export type MeshPass = 0 | 1 | 2;

/** One pass's vertices and indices so far: views of exactly `4·vertices`, `vertices` and `indices` entries. */
export interface MeshView {
  readonly position: Uint8Array;
  readonly data: Uint32Array;
  readonly index: Uint32Array;
  readonly vertices: number;
  readonly indices: number;
}

export interface MeshBuilder {
  /** Empties every pass, keeping the arrays. */
  reset(): void;
  /**
   * Appends one quad to `pass`: `corners` holds the x, y, z of v0 … v3 in 1/8-block units (0 … 128),
   * counter-clockwise seen from the face's outside, and `data` their four words. It writes the triangles (0, 1, 2)
   * and (0, 2, 3), or with `flip` (1, 2, 3) and (1, 3, 0), so the split runs along v1-v3.
   */
  quad(pass: MeshPass, corners: ArrayLike<number>, data: ArrayLike<number>, flip: boolean): void;
  /** The pass's buffers so far (subarray views; valid until the next `quad` or `reset`). */
  view(pass: MeshPass): MeshView;
}

/** Quads a pass holds before its first growth. */
const INITIAL_QUADS = 512;

interface PassBuffers {
  position: Uint8Array;
  data: Uint32Array;
  index: Uint32Array;
  vertices: number;
  indices: number;
}

function createPass(quads: number): PassBuffers {
  return {
    position: new Uint8Array(16 * quads),
    data: new Uint32Array(4 * quads),
    index: new Uint32Array(6 * quads),
    vertices: 0,
    indices: 0,
  };
}

/** Doubles a pass's capacity, keeping its contents. */
function grow(p: PassBuffers): void {
  const quads = 2 * (p.data.length / 4);
  const position = new Uint8Array(16 * quads);
  const data = new Uint32Array(4 * quads);
  const index = new Uint32Array(6 * quads);
  position.set(p.position.subarray(0, 4 * p.vertices));
  data.set(p.data.subarray(0, p.vertices));
  index.set(p.index.subarray(0, p.indices));
  p.position = position;
  p.data = data;
  p.index = index;
}

export function createMeshBuilder(): MeshBuilder {
  const passes: readonly PassBuffers[] = [createPass(INITIAL_QUADS), createPass(INITIAL_QUADS), createPass(INITIAL_QUADS)];
  return {
    reset(): void {
      for (const p of passes) {
        p.vertices = 0;
        p.indices = 0;
      }
    },
    quad(pass: MeshPass, corners: ArrayLike<number>, data: ArrayLike<number>, flip: boolean): void {
      const p = passes[pass]!;
      if (p.vertices + 4 > p.data.length) grow(p);
      const v = p.vertices;
      const pos = p.position;
      const words = p.data;
      for (let k = 0, o = 4 * v; k < 4; k++, o += 4) {
        pos[o] = corners[3 * k]!;
        pos[o + 1] = corners[3 * k + 1]!;
        pos[o + 2] = corners[3 * k + 2]!;
        pos[o + 3] = 0;
        words[v + k] = data[k]!;
      }
      const ix = p.index;
      const i = p.indices;
      if (flip) {
        ix[i] = v + 1;
        ix[i + 1] = v + 2;
        ix[i + 2] = v + 3;
        ix[i + 3] = v + 1;
        ix[i + 4] = v + 3;
        ix[i + 5] = v;
      } else {
        ix[i] = v;
        ix[i + 1] = v + 1;
        ix[i + 2] = v + 2;
        ix[i + 3] = v;
        ix[i + 4] = v + 2;
        ix[i + 5] = v + 3;
      }
      p.vertices = v + 4;
      p.indices = i + 6;
    },
    view(pass: MeshPass): MeshView {
      const p = passes[pass]!;
      return {
        position: p.position.subarray(0, 4 * p.vertices),
        data: p.data.subarray(0, p.vertices),
        index: p.index.subarray(0, p.indices),
        vertices: p.vertices,
        indices: p.indices,
      };
    },
  };
}

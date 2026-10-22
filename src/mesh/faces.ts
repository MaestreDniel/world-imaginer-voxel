/**
 * The face geometry, per-vertex light and greedy merge shared by the opaque and cutout mesher (`mesh/greedy.ts`) and the
 * still-water mesher (`mesh/fluid.ts`) (SP4a spec §5.2-§5.6), so that both use one corner order, one winding and one
 * light-sample neighbourhood:
 * - the per-face tables over the 18³ padded view (`world/store/padded.ts`);
 * - `vertexOf` and `cornerLight`: §5.3's AO and smooth light of a face's four corners;
 * - `mergeSlice`: the greedy merge of one slice's three key masks;
 * - `quadCorners`: a merged quad's four corner positions in 1/8 units.
 * Each mesher keeps only its own keys and data-word packing.
 */
import { PAD, padIndex } from '../world/store/padded';
import type { MeshOptions } from './greedy';

// Imported values are read through top-level aliases (vitest's bench mode turns import reads into getters; SP4a Task P1).
const SIDE = PAD;
const PAD_INDEX = padIndex;

/** Padded-view strides per axis (0 x, 1 y, 2 z): `padIndex` adds 1 per x, 18 per z and 324 per y. */
export const STRIDE = [1, SIDE * SIDE, SIDE] as const;
/** The padded index of section-local (0, 0, 0). */
export const ORIGIN = PAD_INDEX(0, 0, 0);

/**
 * Per face (north −z, east +x, south +z, west −x, up +y, down −y; `world/blocks/kinds.ts`): the normal axis and sign,
 * and the in-plane axes u and v of the mask, chosen so that u × v is the outward normal. A quad's corners
 * v0 = (u0, v0), v1 = (u1, v0), v2 = (u1, v1), v3 = (u0, v1) are then counter-clockwise seen from outside.
 */
export const AXIS_N = [2, 0, 2, 0, 1, 1] as const;
export const SIGN = [-1, 1, 1, -1, 1, -1] as const;
export const AXIS_U = [1, 1, 0, 2, 2, 0] as const;
export const AXIS_V = [0, 2, 1, 1, 0, 2] as const;
/** The face of the neighbour that faces back: its bit in the neighbour's `fullFaces` decides occlusion. */
export const OPPOSITE = [2, 3, 0, 1, 5, 4] as const;

/**
 * One vertex's AO and smooth light (SP4a spec §5.3), packed as `ao2 | sky << 2 | block << 6`. `lf` is F's light
 * byte; e1, e2 are the two edge voxels and c the corner, with their opacity flags o1, o2, oc.
 */
export function vertexOf(
  light: Uint8Array, o: MeshOptions, lf: number, e1: number, o1: number, e2: number, o2: number, c: number, oc: number,
): number {
  const ao = o.ao ? (o1 & o2 ? 3 : o1 + o2 + oc) : 0;
  if (!o.smoothLight) return ao | (lf >> 4) << 2 | (lf & 15) << 6;
  let sky = lf >> 4;
  let blk = lf & 15;
  let n = 1;
  if (!o1) {
    const l = light[e1]!;
    sky += l >> 4;
    blk += l & 15;
    n++;
  }
  if (!o2) {
    const l = light[e2]!;
    sky += l >> 4;
    blk += l & 15;
    n++;
  }
  if (!oc && !(o1 & o2)) {
    const l = light[c]!;
    sky += l >> 4;
    blk += l & 15;
    n++;
  }
  // ⌊(2·sum + n) / (2n)⌋, the mean rounded half up: sums ≤ 60 and n ≤ 4, so the floor of the quotient is exact.
  const s = Math.floor((2 * sky + n) / (2 * n));
  const b = Math.floor((2 * blk + n) / (2 * n));
  return ao | s << 2 | b << 6;
}

/**
 * The four corners' `vertexOf` of the face whose air-side voxel F is the padded index `q`, in-plane strides `su`, `sv`
 * (SP4a spec §5.3): the eight voxels around F in the face plane (edges at −u, +u, −v, +v and the four corners) are
 * sampled once. Writes v0 (−u, −v), v1 (+u, −v), v2 (+u, +v), v3 (−u, +v) into `out` and returns the light key
 * `(sky×4, block×4)`: v0 … v3's sky in bits 0-15 and their block light in bits 16-31, four bits each. `solid` is 1 for
 * a state that is opaque for AO and smooth light (PASS opaque, `fullFaces` 63), else 0.
 */
export function cornerLight(
  light: Uint8Array, blocks: Uint16Array, solid: (s: number) => number, o: MeshOptions, q: number, su: number, sv: number,
  out: Uint16Array,
): number {
  const uM = q - su;
  const uP = q + su;
  const vM = q - sv;
  const vP = q + sv;
  const oUM = solid(blocks[uM]!);
  const oUP = solid(blocks[uP]!);
  const oVM = solid(blocks[vM]!);
  const oVP = solid(blocks[vP]!);
  const lf = light[q]!;
  const c0 = vertexOf(light, o, lf, uM, oUM, vM, oVM, uM - sv, solid(blocks[uM - sv]!));
  const c1 = vertexOf(light, o, lf, uP, oUP, vM, oVM, uP - sv, solid(blocks[uP - sv]!));
  const c2 = vertexOf(light, o, lf, uP, oUP, vP, oVP, uP + sv, solid(blocks[uP + sv]!));
  const c3 = vertexOf(light, o, lf, uM, oUM, vP, oVP, uM + sv, solid(blocks[uM + sv]!));
  out[0] = c0;
  out[1] = c1;
  out[2] = c2;
  out[3] = c3;
  return ((c0 >> 2 & 15) | (c1 >> 2 & 15) << 4 | (c2 >> 2 & 15) << 8 | (c3 >> 2 & 15) << 12
    | (c0 >> 6) << 16 | (c1 >> 6) << 20 | (c2 >> 6) << 24 | (c3 >> 6) << 28) >>> 0;
}

/** Receives one merged quad of face `f`, slice `d`: mask origin (i, j), size w × h along (u, v), and its three keys. */
export type QuadSink = (f: number, d: number, i: number, j: number, w: number, h: number, ka: number, kb: number, kc: number) => void;

/**
 * Greedy-merges one slice's masks (index v·16 + u) into quads, rows of equal keys along u then extended along v, and
 * hands each to `emit`. A cell holds a face when its key A is non-zero; faces merge only when all three keys are equal
 * (a mesher with two keys passes an all-zero `c`). Key A is cleared as the cells are taken; B and C are left as they are.
 */
export function mergeSlice(f: number, d: number, a: Uint32Array, b: Uint32Array, c: Uint32Array, emit: QuadSink): void {
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16;) {
      const m = j * 16 + i;
      const ka = a[m]!;
      if (ka === 0) {
        i++;
        continue;
      }
      const kb = b[m]!;
      const kc = c[m]!;
      let w = 1;
      while (i + w < 16 && a[m + w] === ka && b[m + w] === kb && c[m + w] === kc) w++;
      let h = 1;
      grow: while (j + h < 16) {
        const row = m + 16 * h;
        for (let k = 0; k < w; k++) if (a[row + k] !== ka || b[row + k] !== kb || c[row + k] !== kc) break grow;
        h++;
      }
      for (let y = 0; y < h; y++) a.fill(0, m + 16 * y, m + 16 * y + w);
      emit(f, d, i, j, w, h, ka, kb, kc);
      i += w;
    }
  }
}

/**
 * Writes into `out` (12 values, x y z per corner) the corners v0 … v3 of the quad of face `f` in slice `d` spanning
 * mask cells (i … i + w − 1, j … j + h − 1), in 1/8 units: the plane sits on the voxel's far side for a + face and its
 * near side for a − face.
 */
export function quadCorners(f: number, d: number, i: number, j: number, w: number, h: number, out: Uint8Array): void {
  const an = AXIS_N[f]!;
  const au = AXIS_U[f]!;
  const av = AXIS_V[f]!;
  const plane = 8 * (SIGN[f]! > 0 ? d + 1 : d);
  const u0 = 8 * i;
  const u1 = 8 * (i + w);
  const v0 = 8 * j;
  const v1 = 8 * (j + h);
  out[an] = plane;
  out[3 + an] = plane;
  out[6 + an] = plane;
  out[9 + an] = plane;
  out[au] = u0;
  out[av] = v0;
  out[3 + au] = u1;
  out[3 + av] = v0;
  out[6 + au] = u1;
  out[6 + av] = v1;
  out[9 + au] = u0;
  out[9 + av] = v1;
}

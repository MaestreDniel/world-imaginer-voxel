/**
 * The needed sets of the one-shot load (SP4a spec §2.1, master §4.3, ruling P34). MESH is the integer disc
 * `dx² + dz² ≤ (rd + 0.5)²` around the centre column; L, D and T are each the previous set grown by the 3 × 3 (every
 * column plus its 8 neighbours), so every job's prerequisites lie in the previous stage's set. At rd 12 they hold
 * MESH 489, L 593, D 705 and T 825 columns. Offsets are precomputed once per radius, in spiral order (by d², then by
 * angle). While streaming (SP4b spec §3.2) the retained sets add the hysteresis of master §4.2: meshes are kept within
 * the disc of radius rd + 1 and voxels within rd + 5; `membershipTable(rd)` holds every flag per offset.
 */
import { TORUS_SIZE, colKey } from '../core/coords';

/** The four column jobs of the load, in pipeline order (SP4a spec §2.2). */
export type Stage = 'T' | 'D' | 'L' | 'MESH';

/** How many columns past rd each stage's set reaches along an axis (the 3 × 3 growth; master §4.3's RD+3/+2/+1/+0). */
export const RING_EXTRA: Readonly<Record<Stage, number>> = { T: 3, D: 2, L: 1, MESH: 0 };

type Offsets = ReadonlyArray<readonly [number, number]>;

const discCache = new Map<number, Offsets>();
const stageCache = new Map<number, Readonly<Record<Stage, Offsets>>>();

/** Angle of an offset in [0, 2π), counter-clockwise from +x; the centre is 0. */
function angleOf(dx: number, dz: number): number {
  const a = Math.atan2(dz, dx);
  return a < 0 ? a + 2 * Math.PI : a;
}

/** Spiral order: by d², then by angle. */
function spiral(offs: Array<readonly [number, number]>): Offsets {
  return offs.sort((a, b) => {
    const d = a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]);
    return d !== 0 ? d : angleOf(a[0], a[1]) - angleOf(b[0], b[1]);
  });
}

/** The integer disc `dx² + dz² ≤ (r + 0.5)²` in spiral order (by d², then angle), cached per r. */
export function discOffsets(r: number): Offsets {
  const hit = discCache.get(r);
  if (hit !== undefined) return hit;
  const lim = (r + 0.5) * (r + 0.5);
  const offs: Array<readonly [number, number]> = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= lim) offs.push([dx, dz]);
  }
  const out = spiral(offs);
  discCache.set(r, out);
  return out;
}

/** `offs` grown by the 3 × 3, in spiral order. */
function grow(offs: Offsets): Offsets {
  const seen = new Set<number>();
  const out: Array<readonly [number, number]> = [];
  for (const [ox, oz] of offs) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = colKey(ox + dx, oz + dz);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([ox + dx, oz + dz]);
      }
    }
  }
  return spiral(out);
}

/** Each stage's offsets around the centre at rd (ruling P34), in spiral order, cached per rd. */
export function stageOffsets(rd: number): Readonly<Record<Stage, Offsets>> {
  const hit = stageCache.get(rd);
  if (hit !== undefined) return hit;
  const MESH = discOffsets(rd);
  const L = grow(MESH);
  const D = grow(L);
  const T = grow(D);
  const out = { T, D, L, MESH };
  stageCache.set(rd, out);
  return out;
}

/** The needed sets around (cx, cz) at rd, as colKeys. */
export function neededSets(cx: number, cz: number, rd: number): Record<Stage, ReadonlySet<number>> {
  const offs = stageOffsets(rd);
  const keys = (o: Offsets): ReadonlySet<number> => new Set(o.map(([dx, dz]) => colKey(cx + dx, cz + dz)));
  return { T: keys(offs.T), D: keys(offs.D), L: keys(offs.L), MESH: keys(offs.MESH) };
}

/** Membership flags, one byte per offset (SP4b spec §3.2): the four needed sets, then the retained ones. */
export const M_MESH = 1;
export const M_L = 2;
export const M_D = 4;
export const M_T = 8;
/** Meshes are kept within the disc of radius rd + 1 (`dx² + dz² ≤ (rd + 1.5)²`). */
export const M_KEEP_MESH = 16;
/** Voxels are kept within the disc of radius rd + 5 (`≤ (rd + 5.5)²`, which contains the T set). */
export const M_KEEP_VOXELS = 32;
/** The proto ring: the T set minus the L set (rd + 2 … rd + 3). */
export const M_PROTO_RING = 64;
/** How many columns past rd the retained discs reach (master §4.2's hysteresis). */
export const KEEP_MESH_EXTRA = 1;
export const KEEP_VOXELS_EXTRA = 5;

const tableCache = new Map<number, Uint8Array>();

/**
 * The membership table at rd (SP4b spec §3.2), cached per rd: one byte of `M_*` flags per offset in
 * [−(rd + 5), rd + 5]², at index `(dz + R)·side + (dx + R)` with `R = rd + 5` and `side = 2·R + 1` (43 × 43 at rd 16).
 * Every flag lies inside it: the T set reaches rd + 3 and keepVoxels rd + 5.
 */
export function membershipTable(rd: number): Uint8Array {
  const hit = tableCache.get(rd);
  if (hit !== undefined) return hit;
  const R = rd + KEEP_VOXELS_EXTRA;
  const side = 2 * R + 1;
  const t = new Uint8Array(side * side);
  const offs = stageOffsets(rd);
  const flags: ReadonlyArray<readonly [Stage, number]> = [['MESH', M_MESH], ['L', M_L], ['D', M_D], ['T', M_T]];
  for (const [st, f] of flags) for (const [dx, dz] of offs[st]) t[(dz + R) * side + (dx + R)]! |= f;
  for (const [dx, dz] of discOffsets(rd + KEEP_MESH_EXTRA)) t[(dz + R) * side + (dx + R)]! |= M_KEEP_MESH;
  for (const [dx, dz] of discOffsets(rd + KEEP_VOXELS_EXTRA)) t[(dz + R) * side + (dx + R)]! |= M_KEEP_VOXELS;
  for (let i = 0; i < t.length; i++) if ((t[i]! & (M_T | M_L)) === M_T) t[i]! |= M_PROTO_RING;
  tableCache.set(rd, t);
  return t;
}

/**
 * Throws unless the membership table at rd fits the store's torus without two columns sharing a record (SP4b spec
 * §3.2, generalising SP4a spec §2.1, D3): its side 2·(rd + 5) + 1 must be at most `TORUS_SIZE` (64), true for every
 * rd ≤ 26 (43 at rd 16).
 */
export function assertTorusSafe(rd: number): void {
  const side = 2 * (rd + KEEP_VOXELS_EXTRA) + 1;
  if (side > TORUS_SIZE) {
    throw new RangeError(`render distance ${rd}: the retained set is ${side} columns across, more than the torus's ${TORUS_SIZE}`);
  }
}

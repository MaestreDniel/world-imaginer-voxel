/**
 * The needed sets of the one-shot load (SP4a spec §2.1, master §4.3, ruling P34). MESH is the integer disc
 * `dx² + dz² ≤ (rd + 0.5)²` around the centre column; L, D and T are each the previous set grown by the 3 × 3 (every
 * column plus its 8 neighbours), so every job's prerequisites lie in the previous stage's set. At rd 12 they hold
 * MESH 489, L 593, D 705 and T 825 columns. Offsets are precomputed once per radius, in spiral order (by d², then by
 * angle).
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

/**
 * Throws unless the T set at rd fits the store's torus without two columns sharing a record (SP4a spec §2.1, D3):
 * its side 2·(rd + 3) + 1 must be at most `TORUS_SIZE` (64), true for every rd ≤ 28.
 */
export function assertTorusSafe(rd: number): void {
  const side = 2 * (rd + RING_EXTRA.T) + 1;
  if (side > TORUS_SIZE) {
    throw new RangeError(`render distance ${rd}: the T set is ${side} columns across, more than the torus's ${TORUS_SIZE}`);
  }
}

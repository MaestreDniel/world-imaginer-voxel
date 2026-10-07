/**
 * Lakes at elevation (master §3.5, SP2a spec §2.5): warped Voronoi cells, one possible lake per cell.
 * cellEligible and lakeTerms are the pure formulas; lakeCell evaluates (and memoises) a cell centre with
 * a lake-free column evaluation; sampleLakes applies the F1 cell to a column.
 *
 * Allocation (SP2a minor 5, SP3b spec §4): sampleLakes, the column stage's per-point call, allocates no object; it
 * goes through module scratch (`warpInto`, `nearestInto`) where the exported `lakeSpace` and `nearestCell` return a
 * fresh tuple and record. A lakeCell miss allocates its memoised LakeCell (bounded by CELL_CACHE_MAX per context), so
 * a warm cache costs nothing. What remains is V8's short-lived boxing of doubles returned by non-inlined calls (the
 * noises, here and in climate, shape and rivers), which scavenges collect: measured on the T stage's hot path, about
 * 1.5 MB of such garbage per column (≈ 190 scavenges per 1000 columns) and no retained growth (test/unit/terrainHeap).
 */
import { hash2, hash4 } from '../../core/hash';
import type { LakeParams } from '../../core/params/schema';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import { noiseFor, type GenContext } from '../context';
import { newClimate, sampleClimate } from './climate';
import { newRiver, sampleRivers } from './rivers';
import { newShape, sampleShape } from './shape';

const H2 = hash2;
const H4 = hash4;
const NOISE = noiseFor;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;

const TO_UNIT = 1 / 4294967296;
const RING_X = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
const RING_Z = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];

export interface LakeCell {
  readonly i: number; readonly j: number;
  /** Centre in warped lake space (also used as the world point where the cell is evaluated). */
  readonly cx: number; readonly cz: number;
  readonly enabled: boolean;
  /** Water level and depth (−Infinity / 0 when disabled). */
  readonly Lw: number; readonly depth: number;
}

export interface LakeOut {
  /** 1 inside the basin, (0, 1) on the rim band, 0 outside. */
  lakeMask: number; lakeLevel: number; lakeFloor: number;
  offset: number; sigma: number; jag: number;
}

export const newLake = (): LakeOut => ({ lakeMask: 0, lakeLevel: -Infinity, lakeFloor: -Infinity, offset: 0, sigma: 0, jag: 0 });

export interface CellProbe { C: number; offset0: number; riverDist: number; valleyWidth: number; wet: boolean; roll: number }

/** Master §3.5 enabling rule: hash roll < p, C > minC, offset0 in [offsetMin, offsetMax], outside any river valley. */
export function cellEligible(c: CellProbe, p: LakeParams): boolean {
  return c.roll < p.p && c.C > p.minC && c.offset0 >= p.offsetMin && c.offset0 <= p.offsetMax && !c.wet && c.riverDist > c.valleyWidth;
}

/**
 * Applies one lake to a column whose distance to the cell centre is `q` radii (rim noise included).
 * Inside (q ≤ 1): offset ≤ Lw − depth·(1 − q²), σ × sigmaMul, jag 0. Rim band (1 < q < 1 + rimWidth):
 * offset raised toward max(offset, Lw + rimRise + 3·rimSigma) by m, σ ≤ rimSigma and jag → 0 by m.
 */
export function lakeTerms(q: number, Lw: number, depth: number, offset: number, sigma: number, jag: number, p: LakeParams, out: LakeOut): LakeOut {
  if (q <= 1) {
    const r = Math.max(0, q);
    out.lakeMask = 1;
    out.lakeLevel = Lw;
    out.lakeFloor = Lw - depth;
    out.offset = Math.min(offset, Lw - depth * (1 - r * r));
    out.sigma = sigma * p.sigmaMul;
    out.jag = 0;
    return out;
  }
  const m = q < 1 + p.rimWidth ? 1 - (q - 1) / p.rimWidth : 0;
  out.lakeMask = m;
  out.lakeLevel = -Infinity;
  out.lakeFloor = -Infinity;
  if (m === 0) {
    out.offset = offset;
    out.sigma = sigma;
    out.jag = jag;
    return out;
  }
  const raised = Math.max(offset, Lw + p.rimRise + 3 * p.rimSigma);
  out.offset = offset + (raised - offset) * m;
  out.sigma = sigma + (Math.min(sigma, p.rimSigma) - sigma) * m;
  out.jag = jag - jag * m;
  return out;
}

const CELLS = new WeakMap<GenContext, Map<number, LakeCell>>();
const CELL_CACHE_MAX = 65536;

/** The lake cell (i, j): jittered centre, eligibility, level and depth. Memoised per GenContext. */
export function lakeCell(ctx: GenContext, i: number, j: number): LakeCell {
  let cache = CELLS.get(ctx);
  if (cache === undefined) { cache = new Map(); CELLS.set(ctx, cache); }
  // Cells span |i|, |j| < 2^15 over the colKey window for any legal cell size (≥ 64 blocks).
  const key = (i + 32768) * 65536 + (j + 32768);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const p = ctx.params.lakes;
  const s = ctx.lakeSeed;
  const cx = (i + 0.5 + p.jitter * (H2(s, i, j) * TO_UNIT - 0.5)) * p.cell;
  const cz = (j + 0.5 + p.jitter * (H4(s, 1, i, j) * TO_UNIT - 0.5)) * p.cell;
  const coords = new Float64Array(6);
  const c = CLIMATE(ctx, cx, cz, NEW_CLIMATE());
  const sh = SHAPE(ctx, c, coords, NEW_SHAPE());
  const rv = RIVERS(ctx, c, sh, NEW_RIVER());
  const rp = ctx.params.rivers;
  const probe: CellProbe = {
    C: c.C, offset0: sh.offset0, riverDist: rv.riverDist, valleyWidth: rp.valleyBase + rp.valleyPerE * (1 + c.E), wet: rv.wet,
    roll: H4(s, 2, i, j) * TO_UNIT,
  };
  let cell: LakeCell;
  if (!cellEligible(probe, p)) {
    cell = { i, j, cx, cz, enabled: false, Lw: -Infinity, depth: 0 };
  } else {
    const rr = p.ringFrac * p.radius;
    let lo = Infinity;
    for (let k = 0; k < 8; k++) {
      const ck = CLIMATE(ctx, cx + rr * RING_X[k]!, cz + rr * RING_Z[k]!, NEW_CLIMATE());
      const o = SHAPE(ctx, ck, coords, NEW_SHAPE()).offset0;
      if (o < lo) lo = o;
    }
    cell = { i, j, cx, cz, enabled: true, Lw: Math.floor(lo) - 1, depth: p.depthMin + p.depthVar * H4(s, 3, i, j) * TO_UNIT };
  }
  if (cache.size >= CELL_CACHE_MAX) cache.clear();
  cache.set(key, cell);
  return cell;
}

interface LakeNoises { readonly wx: NormalNoiseT; readonly wz: NormalNoiseT; readonly rim: NormalNoiseT }
const PREP = new WeakMap<GenContext, LakeNoises>();

function noises(ctx: GenContext): LakeNoises {
  let n = PREP.get(ctx);
  if (n === undefined) {
    n = { wx: NOISE(ctx, 'lakes.warpNoise.x'), wz: NOISE(ctx, 'lakes.warpNoise.z'), rim: NOISE(ctx, 'lakes.rimNoise') };
    PREP.set(ctx, n);
  }
  return n;
}

/** warpInto's output: the warped (xl, zl). */
const WARPED = new Float64Array(2);
/** nearestInto's output: the squared distance to the returned cell's centre. */
const NEAREST_D2 = new Float64Array(1);

/** Writes the warped lake-space position of world (x, z) into WARPED. */
function warpInto(ctx: GenContext, x: number, z: number): void {
  const a = ctx.params.lakes.warpAmp;
  const n = noises(ctx);
  WARPED[0] = x + a * n.wx.z2(x, z);
  WARPED[1] = z + a * n.wz.z2(x, z);
}

/** Warped lake-space position of world (x, z). */
export function lakeSpace(ctx: GenContext, x: number, z: number): [number, number] {
  warpInto(ctx, x, z);
  return [WARPED[0]!, WARPED[1]!];
}

/** The F1 (nearest-centre) cell of warped point (xl, zl); ties go to the lower (j, i). */
export function nearestCell(ctx: GenContext, xl: number, zl: number): { cell: LakeCell; dist: number } {
  const cell = nearestInto(ctx, xl, zl);
  return { cell, dist: Math.sqrt(NEAREST_D2[0]!) };
}

/** nearestCell without the record: returns the cell and writes the squared distance into NEAREST_D2. */
function nearestInto(ctx: GenContext, xl: number, zl: number): LakeCell {
  const cellSize = ctx.params.lakes.cell;
  const ci = Math.floor(xl / cellSize);
  const cj = Math.floor(zl / cellSize);
  let best: LakeCell | null = null;
  let bestD2 = Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const cell = lakeCell(ctx, ci + di, cj + dj);
      const dx = xl - cell.cx;
      const dz = zl - cell.cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = cell; }
    }
  }
  NEAREST_D2[0] = bestD2;
  return best!;
}

/** Lakes at world (x, z) over a column already adjusted by rivers. */
export function sampleLakes(ctx: GenContext, x: number, z: number, offset: number, sigma: number, jag: number, out: LakeOut): LakeOut {
  const p = ctx.params.lakes;
  warpInto(ctx, x, z);
  const cell = nearestInto(ctx, WARPED[0]!, WARPED[1]!);
  if (!cell.enabled) {
    out.lakeMask = 0; out.lakeLevel = -Infinity; out.lakeFloor = -Infinity;
    out.offset = offset; out.sigma = sigma; out.jag = jag;
    return out;
  }
  const rim = noises(ctx).rim;
  const dist = Math.sqrt(NEAREST_D2[0]!);
  const q = dist / p.radius - p.roughness * (rim.z2(x, z) / rim.clamp);
  return lakeTerms(q, cell.Lw, cell.depth, offset, sigma, jag, p, out);
}

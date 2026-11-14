import { CAVE_BIOME_NAMES } from '../../src/core/constants';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { caveBiomeInputsAt, caveBiomePoint, cavePickerOf, caveY0 } from '../../src/gen/biomes/cavePicker';
import { newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import { logSd } from './caveMetrics';

/**
 * B3's regular-grid check (SP6b spec §12.2, D26; Task 28): the cave-biome zones read from the picker alone, no T, so a
 * zone layout that repeats on a grid (a lattice of patches, a period in the climate's or the border noises' sampling)
 * shows without generating a region. Pure over (seed, params); `caves.metric.ts` runs it in the `caves-biomes` job and
 * writes `.out/B3.zoneGrid.json`; the instruments take a plain indicator grid, so a unit test feeds them fixtures.
 *
 * The definitions as built:
 * - The grid (`caveZoneGrid`): `ZONE_CELLS`² points of a `ZONE_STEP`-block lattice, (x0 + 64i, z0 + 64j), over 64 × 64 km
 *   centred on the origin (1,048,576 points). At each: `samplePoint`'s C, E, H and surfaceEst (the climate the map layer
 *   reads, Spec correction 13), the normalised border and depth noises (`caveBiomeInputsAt`), Y0 = surfaceEst + dW·Nd
 *   (`caveY0`), and per depth of `ZONE_DEPTHS` (0.3, 0.6, 1.1) §1.3's choice at y = Y0 − D·depth (`caveBiomePoint`,
 *   the picker's operation order; no jitter: the per-block speckle is finer than the lattice).
 * - The indicators: per biome (lush, dripstone, abyss) and depth, m = 1 where the point's biome is it; an indicator
 *   that holds no point (lush and dripstone at 1.1, the abyss at 0.3 and 0.6 at the defaults) gives NaN everywhere and
 *   is left out of the parts.
 * - The ratio at lag L along an axis (`zoneLagRatios`): C8.aperiodicity's (`caveMetrics.ts`' `aperiodicCounts`),
 *   Σ |m(p) − m(p + L·e)| over the pairs inside the grid over pairs · 2f(1 − f), f the indicator's share of the grid:
 *   1 minus the indicator's correlation at L, so ≈ 1 for independent points, below 1 where the zones are still
 *   correlated (zones following the climate's 1,600-2,400-block fields read about 0.2-0.4 at 256 by design, Spec
 *   correction 19) and near 0 at a period. Lags `ZONE_LAGS`: 256, 512 … 16,384 blocks, on both axes.
 * - `zoneAperiodicity` (§12.2 as written): the smallest ratio over the indicators, axes and lags.
 * - `zonePeriodicDip` (Spec correction 19): per indicator and axis, the smallest over L ≥ `ZONE_DIP_FROM` (1,024) of
 *   ratio(L) / max(ratio at the lags < L); the part the smallest over the series. A periodic field dips well below 1 at
 *   its period; a smooth random one rises and saturates near 1, so its dips stay near or above 1.
 * - The patches (`zonePatches`): the 4-connected components of an indicator's points, those of ≥ `ZONE_PATCH_MIN` (4)
 *   points kept (a patch cut by the grid's edge is read as cut); `zoneClarkEvans` (`clarkEvans`): the patches' mean
 *   nearest-neighbour distance between centroids over 0.5/√ρ, ρ the patches per grid area (no edge correction): a
 *   square lattice 2.0, a hexagonal one 2.15 (Spec correction 18), random ≈ 1, clustered < 1; the part the indicator's
 *   value farthest from 1 (|ln|). `zoneSizeSpread`: the sample sd of ln(patch area) (`logSd`), the part the smallest.
 */

/** The grid's side in points, its lattice step in blocks and its origin (64 × 64 km centred on (0, 0)). */
export const ZONE_CELLS = 1024;
export const ZONE_STEP = 64;
export const ZONE_ORIGIN = -(ZONE_CELLS * ZONE_STEP) / 2;
/** The depths (§1.2's depth, Y0 − y over D) the zones are read at: lush and dripstone's range, then the abyss's. */
export const ZONE_DEPTHS: readonly number[] = [0.3, 0.6, 1.1];
/** The ratios' lags, in blocks. */
export const ZONE_LAGS: readonly number[] = [256, 512, 1024, 2048, 4096, 8192, 16_384];
/** `zonePeriodicDip`'s first lag. */
export const ZONE_DIP_FROM = 1024;
/** The least patch kept, in points. */
export const ZONE_PATCH_MIN = 4;
/** The biomes read (`CAVE_BIOME`'s ids; plain is the background). */
export const ZONE_BIOMES: readonly number[] = [1, 2, 3];

/** The picker's biome per point and depth: `biomes[k][j·n + i]` at (x0 + step·i, z0 + step·j), depth `depths[k]`. */
export interface ZoneGrid {
  readonly n: number;
  readonly step: number;
  readonly x0: number;
  readonly z0: number;
  readonly depths: readonly number[];
  readonly biomes: readonly Uint8Array[];
}

export interface ZoneGridOptions {
  readonly n?: number;
  readonly step?: number;
  readonly x0?: number;
  readonly z0?: number;
  readonly depths?: readonly number[];
}

/** The picker over the lattice (the header's grid) for `seed` and `params`. */
export function caveZoneGrid(seed: string, params: Params, o: ZoneGridOptions = {}): ZoneGrid {
  const n = o.n ?? ZONE_CELLS;
  const step = o.step ?? ZONE_STEP;
  const x0 = o.x0 ?? ZONE_ORIGIN;
  const z0 = o.z0 ?? ZONE_ORIGIN;
  const depths = o.depths ?? ZONE_DEPTHS;
  const ctx = createGenContext(seedFromInput(seed), params);
  const inp = cavePickerOf(ctx);
  const b = inp.settings;
  const rec = newPointRecord();
  const noise = new Float64Array(4);
  const nb: [number, number, number] = [0, 0, 0];
  const biomes = depths.map(() => new Uint8Array(n * n));
  for (let j = 0; j < n; j++) {
    const z = z0 + step * j;
    for (let i = 0; i < n; i++) {
      const x = x0 + step * i;
      const p = samplePoint(ctx, x, z, false, rec);
      caveBiomeInputsAt(inp, x, z, noise);
      nb[0] = noise[0]!;
      nb[1] = noise[1]!;
      nb[2] = noise[2]!;
      const y0 = caveY0(b, p.surfaceEst, noise[3]!);
      for (let k = 0; k < depths.length; k++) {
        biomes[k]![j * n + i] = caveBiomePoint(b, p.C, p.E, p.H, p.surfaceEst, nb, noise[3]!, y0 - b.depthScale * depths[k]!).biome;
      }
    }
  }
  return { n, step, x0, z0, depths, biomes };
}

/** One (axis, lag) ratio of an indicator (the header's). */
export interface ZoneLagRatio {
  readonly axis: 'x' | 'z';
  readonly lag: number;
  readonly ratio: number;
}

/**
 * The ratios of the indicator `m` (`n`², 0 or 1, index j·n + i; a lattice of `step` blocks) at `lags` (blocks, each a
 * whole number of steps below the grid's side) on x, then on z; NaN when the indicator is all 0 or all 1.
 */
export function zoneLagRatios(m: Uint8Array, n: number, step: number, lags: readonly number[] = ZONE_LAGS): ZoneLagRatio[] {
  if (m.length !== n * n) throw new RangeError(`zoneLagRatios: ${m.length} points is not ${n}²`);
  let ones = 0;
  for (let p = 0; p < m.length; p++) ones += m[p]!;
  const f = ones / m.length;
  const cells = lags.map((lag) => {
    const c = lag / step;
    if (!Number.isInteger(c) || c < 1 || c >= n) throw new RangeError(`zoneLagRatios: lag ${lag} is not a whole number of ${step}-block steps in 1 … ${n - 1}`);
    return c;
  });
  const out: ZoneLagRatio[] = [];
  for (const axis of ['x', 'z'] as const) {
    for (const [k, c] of cells.entries()) {
      let diff = 0;
      if (axis === 'x') {
        for (let j = 0; j < n; j++) for (let i = 0, r = j * n; i + c < n; i++) diff += m[r + i]! ^ m[r + i + c]!;
      } else {
        for (let p = 0, end = (n - c) * n; p < end; p++) diff += m[p]! ^ m[p + c * n]!;
      }
      const expected = (n - c) * n * 2 * f * (1 - f);
      out.push({ axis, lag: lags[k]!, ratio: expected === 0 ? Number.NaN : diff / expected });
    }
  }
  return out;
}

/** `zoneAperiodicity` over ratios: the smallest defined one; NaN when none is. */
export function zoneAperiodicity(ratios: readonly ZoneLagRatio[]): number {
  let min = Number.NaN;
  for (const r of ratios) if (!Number.isNaN(r.ratio) && !(r.ratio >= min)) min = r.ratio;
  return min;
}

/**
 * `zonePeriodicDip` over ratios (one or more series, a series per axis in lag order): per axis, the smallest over the
 * lags L ≥ `from` of ratio(L) / max(the defined ratios at lags < L); NaN when none is defined.
 */
export function zonePeriodicDip(ratios: readonly ZoneLagRatio[], from = ZONE_DIP_FROM): number {
  let min = Number.NaN;
  for (const axis of ['x', 'z'] as const) {
    const series = ratios.filter((r) => r.axis === axis && !Number.isNaN(r.ratio)).sort((a, b) => a.lag - b.lag);
    let before = Number.NaN;
    for (const r of series) {
      if (r.lag >= from && before > 0) {
        const dip = r.ratio / before;
        if (!(dip >= min)) min = dip;
      }
      if (!(r.ratio <= before)) before = r.ratio;
    }
  }
  return min;
}

/** An indicator's patches (the header's): each patch's points and its centroid, in grid steps (point (i, j) at (i, j)). */
export interface ZonePatches {
  readonly areas: number[];
  readonly cx: number[];
  readonly cz: number[];
}

/** The 4-connected components of `m`'s points (`n`², index j·n + i) of ≥ `minPoints` points. */
export function zonePatches(m: Uint8Array, n: number, minPoints = ZONE_PATCH_MIN): ZonePatches {
  const seen = new Uint8Array(m.length);
  const queue = new Int32Array(m.length);
  const out: ZonePatches = { areas: [], cx: [], cz: [] };
  for (let s = 0; s < m.length; s++) {
    if (m[s] !== 1 || seen[s] === 1) continue;
    seen[s] = 1;
    queue[0] = s;
    let tail = 1;
    let sx = 0;
    let sz = 0;
    for (let head = 0; head < tail; head++) {
      const p = queue[head]!;
      const i = p % n;
      const j = (p - i) / n;
      sx += i;
      sz += j;
      const visit = (q: number): void => {
        if (m[q] === 1 && seen[q] === 0) {
          seen[q] = 1;
          queue[tail++] = q;
        }
      };
      if (i > 0) visit(p - 1);
      if (i < n - 1) visit(p + 1);
      if (j > 0) visit(p - n);
      if (j < n - 1) visit(p + n);
    }
    if (tail < minPoints) continue;
    out.areas.push(tail);
    out.cx.push(sx / tail);
    out.cz.push(sz / tail);
  }
  return out;
}

/**
 * The Clark-Evans ratio of the points (xs, zs) over an area `area` (same units): the mean distance from each point to
 * its nearest other point over 0.5/√ρ, ρ = points / area (no edge correction); NaN below 2 points.
 */
export function clarkEvans(xs: readonly number[], zs: readonly number[], area: number): number {
  const count = xs.length;
  if (count < 2) return Number.NaN;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < count; k++) {
    minX = Math.min(minX, xs[k]!);
    maxX = Math.max(maxX, xs[k]!);
    minZ = Math.min(minZ, zs[k]!);
    maxZ = Math.max(maxZ, zs[k]!);
  }
  // Buckets of about one point each; a point's nearest neighbour is searched ring by ring until the next ring lies
  // farther than the best distance found.
  const s = Math.max(Math.sqrt(((maxX - minX) * (maxZ - minZ)) / count), 1e-9);
  const bx = Math.floor((maxX - minX) / s) + 1;
  const bz = Math.floor((maxZ - minZ) / s) + 1;
  const start = new Int32Array(bx * bz + 1);
  const cellOf = (k: number): number => Math.floor((zs[k]! - minZ) / s) * bx + Math.floor((xs[k]! - minX) / s);
  for (let k = 0; k < count; k++) start[cellOf(k) + 1]!++;
  for (let c = 0; c < bx * bz; c++) start[c + 1]! += start[c]!;
  const fill = start.slice(0, bx * bz);
  const items = new Int32Array(count);
  for (let k = 0; k < count; k++) items[fill[cellOf(k)]!++] = k;
  let sum = 0;
  for (let k = 0; k < count; k++) {
    const ci = Math.floor((xs[k]! - minX) / s);
    const cj = Math.floor((zs[k]! - minZ) / s);
    let best = Infinity;
    for (let r = 0; r < Math.max(bx, bz); r++) {
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= bz) continue;
        const ring = Math.abs(dj) === r;
        for (let di = -r; di <= r; di += ring ? 1 : 2 * r) {
          const i = ci + di;
          if (i >= 0 && i < bx) {
            for (let e = start[j * bx + i]!; e < start[j * bx + i + 1]!; e++) {
              const q = items[e]!;
              if (q === k) continue;
              const d2 = (xs[q]! - xs[k]!) ** 2 + (zs[q]! - zs[k]!) ** 2;
              if (d2 < best) best = d2;
            }
          }
          if (r === 0) break;
        }
      }
      if (best <= (r * s) ** 2) break;
    }
    sum += Math.sqrt(best);
  }
  return sum / count / (0.5 / Math.sqrt(count / area));
}

/** One indicator's values (a biome at a depth). */
export interface ZoneIndicator {
  readonly biome: string;
  readonly depth: number;
  /** The indicator's share of the grid's points. */
  readonly share: number;
  readonly ratios: ZoneLagRatio[];
  readonly aperiodicity: number;
  readonly periodicDip: number;
  readonly patches: number;
  readonly clarkEvans: number;
  readonly sizeSpread: number;
}

/** B3's zone parts (the header's), with every indicator's values. */
export interface ZoneParts {
  readonly zoneAperiodicity: number;
  readonly zonePeriodicDip: number;
  readonly zoneClarkEvans: number;
  readonly zoneSizeSpread: number;
  readonly indicators: ZoneIndicator[];
}

/** The value farthest from 1 (|ln| largest); NaN values left out, NaN when all are. */
function farthestFromOne(values: readonly number[]): number {
  let out = Number.NaN;
  let worst = -1;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    const dev = v <= 0 ? Infinity : Math.abs(Math.log(v));
    if (dev > worst) {
      worst = dev;
      out = v;
    }
  }
  return out;
}

/** The smallest of the defined values; NaN when none is. */
function minDefined(values: readonly number[]): number {
  let min = Number.NaN;
  for (const v of values) if (!Number.isNaN(v) && !(v >= min)) min = v;
  return min;
}

/** B3's zone parts over a grid: per biome of `ZONE_BIOMES` and depth the indicator's values, and the four parts. */
export function caveZoneParts(g: ZoneGrid): ZoneParts {
  const { n, step } = g;
  const m = new Uint8Array(n * n);
  const indicators: ZoneIndicator[] = [];
  for (const [k, depth] of g.depths.entries()) {
    const biomes = g.biomes[k]!;
    for (const b of ZONE_BIOMES) {
      let ones = 0;
      for (let p = 0; p < m.length; p++) {
        m[p] = biomes[p] === b ? 1 : 0;
        ones += m[p]!;
      }
      const ratios = zoneLagRatios(m, n, step);
      const patches = zonePatches(m, n);
      indicators.push({
        biome: CAVE_BIOME_NAMES[b]!, depth, share: ones / m.length, ratios, aperiodicity: zoneAperiodicity(ratios),
        periodicDip: zonePeriodicDip(ratios), patches: patches.areas.length, clarkEvans: clarkEvans(patches.cx, patches.cz, n * n),
        sizeSpread: logSd(patches.areas),
      });
    }
  }
  return {
    zoneAperiodicity: minDefined(indicators.map((i) => i.aperiodicity)),
    zonePeriodicDip: minDefined(indicators.map((i) => i.periodicDip)),
    zoneClarkEvans: farthestFromOne(indicators.map((i) => i.clarkEvans)),
    zoneSizeSpread: minDefined(indicators.map((i) => i.sizeSpread)),
    indicators,
  };
}

/**
 * Surface-biome shares (SP2b spec §5.4, §5.5): the counting and summarising of metric B1, shared by
 * test/metrics/biomes.metric.ts and the pool's `biomeShares` stats job. Follows the core determinism
 * rules (arch-tested).
 *
 * A sum is a Float64Array of biomeSharesLength() raw counts: one per surface-biome id (SURFACE_BIOMES
 * order), then ties, outside and the total. Ties and outside count only non-river points (B1: a river
 * point takes the river flag, not a box). Sums of disjoint point ranges add element-wise.
 */
import type { GenContext } from '../gen/context';
import { newPick, pickBiome, pickBox } from '../gen/biomes/picker';
import { biomeFamily, SURFACE_BIOMES, type SurfaceBiome } from '../gen/biomes/registry';
import { newClimate, sampleClimate } from '../gen/column/climate';
import { newRiver, sampleRivers } from '../gen/column/rivers';
import { newShape, sampleShape } from '../gen/column/shape';
import { samplePoints, type Points } from './noiseStats';

const BIOMES = SURFACE_BIOMES;
const FAMILY = biomeFamily;
const NEW_PICK = newPick;
const PICK_BOX = pickBox;
const PICK_BIOME = pickBiome;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const SHAPE = sampleShape;
const NEW_SHAPE = newShape;
const RIVERS = sampleRivers;
const NEW_RIVER = newRiver;
const SAMPLE_POINTS = samplePoints;

const NB = BIOMES.length;
const TIES = NB;
const OUTSIDE = NB + 1;
const TOTAL = NB + 2;
const LEN = NB + 3;
/** Points between two calls of `stop` (spec §2.2). */
const STOP_EVERY = 256;

/** B1's rare biomes, gated by minRareShare instead of minShare. */
const RARE: ReadonlySet<SurfaceBiome> = new Set<SurfaceBiome>(['jagged_peaks', 'frozen_peaks', 'badlands', 'volcano']);
const IS_RARE = Uint8Array.from(BIOMES, (name) => (RARE.has(name) ? 1 : 0));
/** Per biome id: 0 ocean family, 1 river family, 2 land (every other family, B1's largestLand). */
const KIND = Uint8Array.from(BIOMES, (_, id) => (FAMILY(id) === 'ocean' ? 0 : FAMILY(id) === 'river' ? 1 : 2));

const C_ = NEW_CLIMATE();
const S_ = NEW_SHAPE();
const R_ = NEW_RIVER();
const COORDS = new Float64Array(6);
const PICK = NEW_PICK();

/** Length of a biome-shares sum: SURFACE_BIOMES.length counts, then ties, outside and the total. */
export function biomeSharesLength(): number {
  return LEN;
}

/** Points in the preview's stream: the `n` of the pool's biomeShares request. */
export const BIOME_SHARES_POINTS = 100000;

/** The preview's fixed point stream (spec §5.5). */
export function biomeSharePoints(): Points {
  return SAMPLE_POINTS('sp2b.biomeShares', BIOME_SHARES_POINTS);
}

/**
 * Adds the counts of points [from, to) of `pts` to `out`. Each point's biome is columnPoint's: samplePoint
 * picks it from the climate, offset0 and the river flag only, so the lakes and steep stages (≈ 90 % of a
 * random point's cost) are skipped; the unit test compares with columnPoint. Calls `stop` before every
 * 256 points and returns false as soon as it returns true, leaving a partial sum in `out`; returns true
 * when the range is done.
 */
export function biomeSharesInto(ctx: GenContext, pts: Points, from: number, to: number, out: Float64Array, stop?: () => boolean): boolean {
  if (out.length !== LEN) throw new RangeError(`biome shares: output length ${out.length}, expected ${LEN}`);
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= pts.n)) {
    throw new RangeError(`biome shares: bad point range [${from}, ${to}) of ${pts.n}`);
  }
  const p = PICK;
  for (let i = from; i < to; i++) {
    if (stop !== undefined && (i - from) % STOP_EVERY === 0 && stop()) return false;
    const c = CLIMATE(ctx, pts.x[i]!, pts.z[i]!, C_);
    const s = SHAPE(ctx, c, COORDS, S_);
    const r = RIVERS(ctx, c, s, R_);
    out[TOTAL]!++;
    if (r.wet) {
      out[PICK_BIOME(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, s.offset0, true)]!++;
      continue;
    }
    PICK_BOX(ctx, c.C, c.E, c.PV, c.T, c.H, c.W, s.offset0, p);
    out[p.biome]!++;
    if (p.runnerUp === p.fitness) out[TIES]!++;
    if (p.fitness > 0) out[OUTSIDE]!++;
  }
  return true;
}

export interface BiomeShareSummary {
  /** Share of the total per biome id. */
  readonly shares: Float64Array;
  /** Tied and outside-every-box points as shares of the total (B1's ties and outside). */
  readonly ties: number;
  readonly outside: number;
  /** Number of points. */
  readonly total: number;
  /** Smallest share of a non-rare biome and of a rare biome. */
  readonly minShare: number;
  readonly minRareShare: number;
  /** Largest share of a biome outside the ocean and river families. */
  readonly largestLand: number;
  /** Summed shares of the ocean family. */
  readonly oceanFamily: number;
}

/** Shares and B1's summary values of a sum; an empty sum gives zeros. */
export function summarizeBiomeShares(sum: Float64Array): BiomeShareSummary {
  if (sum.length !== LEN) throw new RangeError(`biome shares: sum length ${sum.length}, expected ${LEN}`);
  const total = sum[TOTAL]!;
  const d = total > 0 ? total : 1;
  const shares = new Float64Array(NB);
  let minShare = 1;
  let minRareShare = 1;
  let largestLand = 0;
  let oceanFamily = 0;
  for (let id = 0; id < NB; id++) {
    const share = sum[id]! / d;
    shares[id] = share;
    if (IS_RARE[id] === 1) minRareShare = Math.min(minRareShare, share);
    else minShare = Math.min(minShare, share);
    const kind = KIND[id];
    if (kind === 0) oceanFamily += share;
    else if (kind === 2) largestLand = Math.max(largestLand, share);
  }
  return { shares, ties: sum[TIES]! / d, outside: sum[OUTSIDE]! / d, total, minShare, minRareShare, largestLand, oceanFamily };
}

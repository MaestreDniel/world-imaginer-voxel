/**
 * The badlands band table (SP3c spec §3.3): what the `bandlands` rule yields at a voxel (x, y, z).
 * - Table: 192 entries built once per GenContext from `r = Xoshiro128(deriveSeed(seed, 'surface.bands'))`. From
 *   i = 0 while i < 192, one run draws, in this order, `len = 1 + r.nextInt(4)` then `colour = r.nextInt(7)`, an index
 *   into [terracotta, white, orange, yellow, brown, red, light_gray terracotta] (repeats allowed), writes that colour to
 *   the entries [i, min(192, i + len)) and sets i += len. No other draw is made from `r`.
 * - Lookup: `table[((y + o) mod 192 + 192) mod 192]` with `o = Math.round(4·z / clampSigma)` ∈ [−4, 4], z the z2 of
 *   `surface.noises.bandOffset` at (x, z) and clampSigma that leaf's.
 * Deterministic and column-local. The table holds state ids; it is data of a SurfaceContext, never a module export.
 * Follows the gen determinism rules.
 */
import { deriveSeed, type Seed64 } from '../../core/hash';
import { Xoshiro128 } from '../../core/rng';
import {
  BROWN_TERRACOTTA, LIGHT_GRAY_TERRACOTTA, ORANGE_TERRACOTTA, RED_TERRACOTTA, TERRACOTTA, WHITE_TERRACOTTA, YELLOW_TERRACOTTA,
} from '../../world/blocks/index';

const DERIVE = deriveSeed;
const RNG = Xoshiro128;
const T_PLAIN = TERRACOTTA;
const T_WHITE = WHITE_TERRACOTTA;
const T_ORANGE = ORANGE_TERRACOTTA;
const T_YELLOW = YELLOW_TERRACOTTA;
const T_BROWN = BROWN_TERRACOTTA;
const T_RED = RED_TERRACOTTA;
const T_LIGHT_GRAY = LIGHT_GRAY_TERRACOTTA;
/** The band colours in §3.3's order (a colour draw indexes this list). */
const COLOURS: readonly number[] = [T_PLAIN, T_WHITE, T_ORANGE, T_YELLOW, T_BROWN, T_RED, T_LIGHT_GRAY];
/** Entries of the table: the y period of the bands. */
const PERIOD = 192;
/** Longest run (a run's length is 1 + nextInt(MAX_RUN)). */
const MAX_RUN = 4;
/** Largest |offset|: o = round(OFFSET_SPAN · z / clampSigma). */
const OFFSET_SPAN = 4;

/** The schema path of the band offset noise (`bandlands` needs it; validateRules rejects the kind without it). */
export const BAND_OFFSET_NOISE = 'surface.noises.bandOffset';

/** The band table of the world seed `seed` (§3.3): 192 state ids, each one of the seven terracottas. */
export function bandlandsTable(seed: Seed64): Uint16Array {
  const r = new RNG(DERIVE(seed, 'surface.bands'));
  const t = new Uint16Array(PERIOD);
  let i = 0;
  while (i < PERIOD) {
    const len = 1 + r.nextInt(MAX_RUN);
    const colour = r.nextInt(COLOURS.length);
    t.fill(COLOURS[colour]!, i, Math.min(PERIOD, i + len));
    i += len;
  }
  return t;
}

/** True when `t` has the band table's size (what the evaluators accept in place of a table they build). */
export function isBandlandsTable(t: Uint16Array): boolean {
  return t.length === PERIOD;
}

/** The band offset o = Math.round(4·z / clampSigma) of a band offset noise value z2 = z (+0 for a zero). */
export function bandlandsOffset(z: number, clampSigma: number): number {
  return Math.round((OFFSET_SPAN * z) / clampSigma) | 0;
}

/** The band block at height y with offset o: table[((y + o) mod 192 + 192) mod 192]. */
export function bandlandsState(table: Uint16Array, y: number, o: number): number {
  return table[(((y + o) % PERIOD) + PERIOD) % PERIOD]!;
}

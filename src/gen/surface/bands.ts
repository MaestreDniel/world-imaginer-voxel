/**
 * The badlands band table (SP3c spec §3.3): what the `bandlands` rule yields at a voxel (x, y, z).
 * - Table: 192 entries built once per GenContext from `r = Xoshiro128(deriveSeed(seed, 'surface.bands'))`. From
 *   i = 0 while i < 192, one run draws, in this order, `len = 1 + r.nextInt(4)` then `colour = r.nextInt(7)`, an index
 *   into [terracotta, white, orange, yellow, brown, red, light_gray terracotta] (repeats allowed), writes that colour to
 *   the entries [i, min(192, i + len)) and sets i += len. No other draw is made from `r`.
 * - Lookup: `table[((y + o) mod 192 + 192) mod 192]` with `o = Math.round(4·z / clampSigma)` ∈ [−4, 4], z the z2 of
 *   `surface.noises.bandOffset` at (x, z) and clampSigma that leaf's.
 * The `strata` table (SP6b spec §3.3, D19), the generalisation: 192 entries built once per compiled tree and node from
 * `r = Xoshiro128(deriveSeed(seed, 'surface.strata.' + k))`, k the node's index among the tree's `strata` nodes in
 * depth-first order. From i = 0 while i < 192, one run draws a layer by weight (one `nextFloat` over the cumulative
 * weights: of every layer for the first run; with two or more layers, of every layer but the previous run's after it,
 * so each maximal run is one draw), then `len = minLen + r.nextInt(min(maxLen, layer.maxLen) −
 * minLen + 1)` (no draw when the layer's maxLen is below minLen: len = layer.maxLen), writes the layer's state to the
 * entries [i, min(192, i + len)) and sets i += len. No other draw is made from `r`. Lookup as the badlands bands', with
 * `o = Math.round(amp·z / clampSigma)`, z the z2 of the node's `noise` at (x, z).
 * Deterministic and column-local. The tables hold state ids; they are data of a compiled tree, never module exports.
 * Follows the gen determinism rules.
 */
import { deriveSeed, type Seed64 } from '../../core/hash';
import { Xoshiro128 } from '../../core/rng';
import type { StrataRule } from './rules';
import {
  BROWN_TERRACOTTA, LIGHT_GRAY_TERRACOTTA, ORANGE_TERRACOTTA, RED_TERRACOTTA, REGISTRY, TERRACOTTA, WHITE_TERRACOTTA,
  YELLOW_TERRACOTTA,
} from '../../world/blocks/index';

const DERIVE = deriveSeed;
const RNG = Xoshiro128;
const BLOCKS = REGISTRY;
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

/** The run's draw of a strata layer: the index of the layer whose cumulative weight first exceeds f (never `skip`). */
function strataLayer(weights: readonly number[], skip: number, f: number): number {
  let acc = 0;
  let last = -1;
  for (let j = 0; j < weights.length; j++) {
    if (j === skip) continue;
    acc += weights[j]!;
    last = j;
    if (f < acc) return j;
  }
  return last;
}

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

/**
 * The strata table of the world seed `seed` for the tree's `strata` node number k (depth-first) with fields `r`
 * (SP6b spec §3.3): 192 state ids, runs of the layers' states drawn by weight, no two consecutive runs of one layer
 * (with two or more layers). `r` must be valid (validateRules).
 */
export function strataTable(seed: Seed64, k: number, r: StrataRule): Uint16Array {
  const rng = new RNG(DERIVE(seed, `surface.strata.${k}`));
  const layers = r.layers;
  const states = layers.map((l) => BLOCKS.parseStateKey(l.state));
  const weights = layers.map((l) => l.weight);
  const t = new Uint16Array(PERIOD);
  let prev = -1;
  let i = 0;
  while (i < PERIOD) {
    const skip = layers.length >= 2 ? prev : -1;
    let total = 0;
    for (let j = 0; j < weights.length; j++) if (j !== skip) total += weights[j]!;
    const j = strataLayer(weights, skip, rng.nextFloat() * total);
    const layerMax = layers[j]!.maxLen;
    const len = layerMax < r.minLen ? layerMax : r.minLen + rng.nextInt(Math.min(r.maxLen, layerMax) - r.minLen + 1);
    t.fill(states[j]!, i, Math.min(PERIOD, i + len));
    i += len;
    prev = j;
  }
  return t;
}

/** The strata offset o = Math.round(amp·z / clampSigma) of a noise value z2 = z (+0 for a zero). */
export function strataOffset(z: number, amp: number, clampSigma: number): number {
  return Math.round((amp * z) / clampSigma) | 0;
}

/** The strata block at height y with offset o: table[((y + o) mod 192 + 192) mod 192] (the band lookup). */
export function strataState(table: Uint16Array, y: number, o: number): number {
  return table[(((y + o) % PERIOD) + PERIOD) % PERIOD]!;
}

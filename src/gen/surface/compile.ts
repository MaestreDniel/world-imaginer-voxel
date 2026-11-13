/**
 * The surface-rule compiler and its fast path (SP3c spec §3.4).
 *
 * Compile: `requireValidRules`, then one closure per rule and condition node over a cursor (the scan context: the
 * voxel's position readouts, its run and its y), preallocated per compiled tree, so an evaluation allocates nothing.
 * Evaluation order is the tree's (a `sequence` yields its first child that yields, a `condition` evaluates `if` then
 * `then`); every condition is decided by its helper in conditions.ts on the same readouts the reference evaluator
 * uses (floorDepth = runTop − y, ceilDepth = y − runBottom, yTop = runTop, `waterAbove` / `waterTop` of the run, the
 * run is sky-open when it is the scan's `skyRun` of its position, T_eff(y) from the position's T and the settings' lapse,
 * `caveBiome`'s floor and ceiling biome of the run and the picker's biome at the voxel, SP6b), so the
 * compiled tree equals the reference on every voxel. Nothing yielded leaves the voxel stone.
 *
 * Fast path (`surfaceFastPath`, compile time, general and conservative). Every leaf (`block`, `bandlands` or `strata`)
 * is classed by the `if`s on its path (sequences ignored), a gate counting only when not under a `not`:
 * - floor-bounded: a path `if` is `stoneDepth{side floor}`; its bound is the smallest, over those gates, of offset +
 *   (addSurfaceDepth ? SD_MAX : 0); it is in the sky class when a path `if` is `skyOpen`, else in the other floor class;
 * - ceiling-bounded (SP6b §3.5, Spec correction 6): no floor gate and a path `if` is `stoneDepth{side ceiling}`; its
 *   bound is the same smallest over its ceiling gates, counted from the run's bottom (a leaf with a floor gate is
 *   floor-bounded only: its floor gate already excludes every voxel beyond it, whatever its ceiling gates say);
 * - Y-only: every path `if` is a `verticalGradient`, a `yAbove{runTop false}` or a `not` of these;
 * - here-gated (SP6b §3.5 item 4): no depth gate, every path `if` Y-only or here-only (a `caveBiome{side here}` or a
 *   `not` of one), at least one here-only.
 * With any other leaf there is no fast path (any condition on a depth-bounded path is harmless, a `caveBiome` too, as
 * `rulesCost` decides). Otherwise each class's bound is the largest over its leaves (−1 when it has none: a depth ≥ 0
 * exceeds it everywhere); maxSurfaceDepth is the larger floor bound; the tree is sky-gated when every floor- or
 * ceiling-bounded path also holds a `skyOpen` `if`. The biome-gated skip (SP6b §3.5 item 3): when every leaf of the
 * other floor class holds a `caveBiome{side floor}` `if`, `floorBiomes` is the set of cave biomes they name (each leaf's
 * gates intersected), and a run whose floor biome is none or outside it has no such leaf that can hold (its floor
 * bound in that class is −1); `ceilBiomes` the same for the ceiling class with `caveBiome{side ceiling}`. The y range
 * −63 … 319 is cut only by the Y-only and here-gated leaves' Y-only conditions: at each such `yAbove{runTop false}`'s
 * minY and at each such gradient's ends; a gradient's dither interval [trueAtAndBelow + 1, falseAtAndAbove − 1] is
 * always evaluated; every other interval is a constant band whose result is the tree evaluated at compile time
 * without its depth-bounded leaves, for each cave biome at the voxel (none, plain, lush, dripstone, abyss: the
 * here-only `if`s' values): the first Y-only or here-gated leaf that holds, stone when none does; a Y-only `bandlands`
 * or `strata` leaf (SP6b) has no constant state (the band block varies with x, y, z) and is always evaluated, like a
 * dither interval, and a here-gated one is looked up without evaluating the tree. A band's `state` is its result when
 * that is one state for every cave biome, else −1. `fillColumn` gives a solid voxel of a band its result without
 * evaluating when it lies beyond every class's bound: floorDepth > the run's floor bound (the sky-open run's: the
 * larger of the two floor classes'; any other run's: the non-sky class's, so in a sky-gated tree every depth of such a
 * run) and ceilDepth > the ceiling bound (each −1 for a run the biome-gated skip excludes), and, in a tree with
 * here-gated leaves, the position's classification (`classifyCaveBiomes`, SP6b §3.5 item 4) leaves one result over
 * the cave biomes the picker can return at that y (one biome, or several with one result); else the voxel is evaluated,
 * a `caveBiome{here}` there taking the classification's answer when it is sure (true when every possible biome is in
 * its set, false when none is) and the picker's otherwise. Non-solid voxels are never written. Follows the gen
 * determinism rules.
 */
import type { Seed64 } from '../../core/hash';
import { REGISTRY, STONE } from '../../world/blocks/index';
import type { CaveColumnPass, CavePickerInputs } from '../biomes/cavePicker';
import {
  BAND_OFFSET_NOISE, bandlandsOffset, bandlandsState, bandlandsTable, isBandlandsTable, strataOffset, strataState, strataTable,
} from './bands';
import {
  biomeHolds, biomeMask, caveBiomeHere, caveBiomeHolds, caveBiomeMask, gradientSeed, lakeHolds, noiseThresholdHolds, skyOpenHolds,
  steepHolds, stoneDepthHolds, temperatureBelowHolds, verticalGradientHolds, waterHolds, yAboveHolds,
} from './conditions';
import {
  requireValidRules, ruleLeaves, type Condition, type Rule, type RuleLeaf, type StrataRule, type SurfaceNoiseSource,
} from './rules';
import { classifyCaveBiomes, runAt, tEff, type SurfaceScan, type SurfaceScanSettings } from './scan';

const BLOCKS = REGISTRY;
const STONE_STATE = STONE;
const VALID = requireValidRules;
const LEAVES = ruleLeaves;
const RUN_AT = runAt;
const T_EFF = tEff;
const MASK = biomeMask;
const G_SEED = gradientSeed;
const BIOME_OK = biomeHolds;
const DEPTH_OK = stoneDepthHolds;
const WATER_OK = waterHolds;
const Y_OK = yAboveHolds;
const GRADIENT_OK = verticalGradientHolds;
const STEEP_OK = steepHolds;
const NOISE_OK = noiseThresholdHolds;
const TEMP_OK = temperatureBelowHolds;
const SKY_OK = skyOpenHolds;
const LAKE_OK = lakeHolds;
const CAVE_MASK = caveBiomeMask;
const CAVE_OK = caveBiomeHolds;
const CAVE_HERE = caveBiomeHere;
const BAND_NOISE = BAND_OFFSET_NOISE;
const BAND_TABLE = bandlandsTable;
const IS_BAND_TABLE = isBandlandsTable;
const BAND_OFFSET = bandlandsOffset;
const BAND_STATE = bandlandsState;
const STRATA_TABLE = strataTable;
const STRATA_OFFSET = strataOffset;
const STRATA_STATE = strataState;
const CLASSIFY = classifyCaveBiomes;

/** Voxels per column, index `256·(y + 64) + p` (the T stage's order). */
const COLUMN_VOXELS = 98304;
const Y_MIN = -63;
const Y_MAX = 319;
/** The classification masks' cave biomes: plain, lush, dripstone, abyss (bit b = cave biome b). */
const PICKED_BIOMES = 4;
/** A band result that is a here-gated `bandlands` or `strata` leaf, looked up directly: −2 − its index. */
const DIRECT = -2;

/** One interval of the fast path's cut of y −63 … 319. */
export interface SurfaceBand {
  readonly yMin: number;
  readonly yMax: number;
  /** A dither interval of a Y-only gradient: always evaluated. */
  readonly dither: boolean;
  /**
   * The constant band's state (the tree without its depth-bounded leaves), when it is one for every cave biome at the
   * voxel; −1 for a dither interval, for a band whose result is a `bandlands` or `strata` leaf (both always evaluated,
   * or looked up when here-gated) and for one whose result depends on the cave biome.
   */
  readonly state: number;
}

/** The fast-path analysis of a tree (§3.4; SP6b §3.5's per-class bounds). */
export interface SurfaceFastPath {
  /** The largest bound of the floor-bounded leaves (both classes), at the settings' SD_MAX; −1 when there is none. */
  readonly maxSurfaceDepth: number;
  /**
   * Every floor- or ceiling-bounded leaf's path holds a `skyOpen` (not under a `not`); true when there is none (then
   * floorBound is −1).
   */
  readonly skyGated: boolean;
  /** The largest floor bound of the floor-bounded leaves whose path holds a `skyOpen`; −1 when there is none. */
  readonly skyFloorBound: number;
  /** The largest floor bound of the other floor-bounded leaves; −1 when there is none. */
  readonly floorBound: number;
  /** The largest ceiling bound (from the run's bottom) of the ceiling-bounded leaves; −1 when there is none. */
  readonly ceilBound: number;
  /**
   * The biome-gated skip of the other floor class (SP6b §3.5 item 3): the cave biomes (bit b = biome b) its leaves'
   * `caveBiome{floor}` gates name when every one of them holds one; −1 when one does not or the class is empty.
   */
  readonly floorBiomes: number;
  /** The same for the ceiling class and `caveBiome{ceiling}`. */
  readonly ceilBiomes: number;
  /** Some leaf is here-gated (SP6b §3.5 item 4): the band results depend on the cave biome at the voxel. */
  readonly here: boolean;
  /** The cut of y −63 … 319, bottom-up, contiguous: constant bands and dither intervals. */
  readonly bands: readonly SurfaceBand[];
}

/** A compiled tree, bound to one world seed, noise source and scan settings. */
export interface CompiledSurfaceRules {
  /** The validated tree. */
  readonly rules: Rule;
  /** The settings it was compiled for (SD_MAX for the fast path, lapse and lapseBase for T_eff). */
  readonly settings: SurfaceScanSettings;
  /** The fast-path analysis, or null when some leaf is neither floor-bounded, ceiling-bounded nor Y-only. */
  readonly fastPath: SurfaceFastPath | null;
  /**
   * The final state at the solid voxel (p, y) of the column last scanned into `scan` (with these settings), every
   * rule evaluated (never the fast path): p = lz·16 + lx in 0 … 255, y in −63 … 319, both integers; a RangeError
   * outside, or when the voxel is not solid.
   */
  state(scan: SurfaceScan, p: number, y: number): number;
  /**
   * Writes the final state of every solid voxel at y −63 … 319 of the column last scanned into `scan` to `out`
   * (98,304 entries, index `256·(y + 64) + p`; a RangeError on another size), taking the fast path when `fast` and
   * the tree has one; every other entry (non-solid voxels, y −64) is left untouched. Returns the number of voxels
   * whose rules were evaluated (the rest took their band's state).
   */
  fillColumn(scan: SurfaceScan, out: Uint16Array, fast: boolean): number;
}

/** A Y-only condition: a `verticalGradient`, a `yAbove{runTop false}`, or a `not` of one. */
function isYOnly(c: Condition): boolean {
  return c.kind === 'verticalGradient' || (c.kind === 'yAbove' && !c.runTop) || (c.kind === 'not' && isYOnly(c.if));
}

/** A here-only condition (SP6b §3.5 item 4): a `caveBiome{side here}`, or a `not` of one. */
function isHereOnly(c: Condition): boolean {
  return (c.kind === 'caveBiome' && c.side === 'here') || (c.kind === 'not' && isHereOnly(c.if));
}

/** A here-only condition's value when the picker's cave biome at the voxel is k (−1: none, the scan has no picker). */
function hereHoldsFor(c: Condition, k: number): boolean {
  if (c.kind === 'not') return !hereHoldsFor(c.if, k);
  if (c.kind !== 'caveBiome') throw new Error(`surfaceFastPath: ${c.kind} is not a here-only condition`);
  return CAVE_OK(CAVE_MASK(c.biomes), k);
}

/** A cave-biome list as a bit set (bit b = cave biome b). */
function caveBits(biomes: readonly string[]): number {
  const m = CAVE_MASK(biomes);
  let bits = 0;
  for (let b = 0; b < m.length; b++) if (m[b] === 1) bits |= 1 << b;
  return bits;
}

/** A Y-only condition at y outside every dither interval (constant over its band). */
function yOnlyHoldsAt(c: Condition, y: number): boolean {
  switch (c.kind) {
    case 'verticalGradient':
      // Outside the dither interval the helper never hashes: the seed and (x, z) do not matter.
      return GRADIENT_OK(0, 0, y, 0, c.trueAtAndBelow, c.falseAtAndAbove);
    case 'yAbove': return Y_OK(y, y, c.minY, false);
    case 'not': return !yOnlyHoldsAt(c.if, y);
    default: throw new Error(`surfaceFastPath: ${c.kind} is not a Y-only condition`);
  }
}

/** Records a Y-only condition's cuts: `starts[y + 64]` = 1 where a band starts, `dither[y + 64]` = 1 in its interval. */
function cutAt(c: Condition, starts: Uint8Array, dither: Uint8Array): void {
  const start = (y: number): void => {
    if (y > Y_MIN && y <= Y_MAX) starts[y + 64] = 1;
  };
  switch (c.kind) {
    case 'verticalGradient': {
      for (let y = Math.max(Y_MIN, c.trueAtAndBelow + 1); y <= Math.min(Y_MAX, c.falseAtAndAbove - 1); y++) dither[y + 64] = 1;
      start(c.trueAtAndBelow + 1);
      start(c.falseAtAndAbove);
      break;
    }
    case 'yAbove': start(c.minY); break;
    case 'not': cutAt(c.if, starts, dither); break;
    default: break;
  }
}

/** A Y-only or here-gated leaf of the band analysis. */
interface BandLeaf {
  readonly rule: RuleLeaf['rule'];
  /** Its Y-only path conditions. */
  readonly y: readonly Condition[];
  /** Its here-only path conditions (none for a Y-only leaf). */
  readonly here: readonly Condition[];
}

/**
 * The band analysis: per band, its result for each cave biome key k = −1 (none) … 3 at `results[5·i + k + 1]`: a
 * state, −1 (evaluate: a dither interval, a Y-only `bandlands` or `strata` leaf) or DIRECT − n for the here-gated
 * `bandlands` or `strata` leaf `direct[n]`.
 */
interface BandAnalysis {
  readonly fastPath: SurfaceFastPath;
  readonly results: Int32Array;
  readonly direct: readonly RuleLeaf['rule'][];
}

function analyse(root: Rule, sdMax: number): BandAnalysis | null {
  const leaves = LEAVES(root);
  let skyFloorBound = -1;
  let floorBound = -1;
  let ceilBound = -1;
  let skyGated = true;
  // The biome-gated skip: the union of the leaves' gate sets, −1 once a leaf of the class lacks a gate.
  let floorBiomes = 0;
  let ceilBiomes = 0;
  let floorLeaves = 0;
  let ceilLeaves = 0;
  let here = false;
  const bandLeaves: BandLeaf[] = [];
  const direct: RuleLeaf['rule'][] = [];
  for (const leaf of leaves) {
    let floor = Infinity;
    let ceil = Infinity;
    let sky = false;
    let floorGate = -1;
    let ceilGate = -1;
    for (const c of leaf.conditions) {
      if (c.kind === 'stoneDepth') {
        const b = c.offset + (c.addSurfaceDepth ? sdMax : 0);
        if (c.side === 'floor') floor = Math.min(floor, b);
        else ceil = Math.min(ceil, b);
      } else if (c.kind === 'skyOpen') {
        sky = true;
      } else if (c.kind === 'caveBiome' && c.side === 'floor') {
        floorGate = (floorGate < 0 ? ~0 : floorGate) & caveBits(c.biomes);
      } else if (c.kind === 'caveBiome' && c.side === 'ceiling') {
        ceilGate = (ceilGate < 0 ? ~0 : ceilGate) & caveBits(c.biomes);
      }
    }
    if (floor !== Infinity) {
      // Floor-bounded, whatever its ceiling gates (Spec correction 6).
      if (sky) {
        skyFloorBound = Math.max(skyFloorBound, floor);
      } else {
        floorBound = Math.max(floorBound, floor);
        skyGated = false;
        floorLeaves++;
        floorBiomes = floorBiomes < 0 || floorGate < 0 ? -1 : floorBiomes | floorGate;
      }
    } else if (ceil !== Infinity) {
      ceilBound = Math.max(ceilBound, ceil);
      if (!sky) skyGated = false;
      ceilLeaves++;
      ceilBiomes = ceilBiomes < 0 || ceilGate < 0 ? -1 : ceilBiomes | ceilGate;
    } else if (leaf.conditions.every(isYOnly)) {
      bandLeaves.push({ rule: leaf.rule, y: leaf.conditions, here: [] });
    } else if (leaf.conditions.every((c) => isYOnly(c) || isHereOnly(c))) {
      here = true;
      bandLeaves.push({ rule: leaf.rule, y: leaf.conditions.filter(isYOnly), here: leaf.conditions.filter(isHereOnly) });
    } else {
      return null;
    }
  }
  const starts = new Uint8Array(384);
  const dither = new Uint8Array(384);
  for (const l of bandLeaves) for (const c of l.y) cutAt(c, starts, dither);
  const bands: SurfaceBand[] = [];
  const results: number[] = [];
  let y = Y_MIN;
  while (y <= Y_MAX) {
    const d = dither[y + 64] === 1;
    let end = y;
    // A dither interval runs while dithered; a constant band until the next start or dither interval.
    while (end < Y_MAX && (dither[end + 65] === 1) === d && (d || starts[end + 65] === 0)) end++;
    let state = -1;
    for (let k = -1; k < PICKED_BIOMES; k++) {
      let res = -1;
      if (!d) {
        res = STONE_STATE;
        for (const l of bandLeaves) {
          if (!l.y.every((c) => yOnlyHoldsAt(c, y)) || !l.here.every((c) => hereHoldsFor(c, k))) continue;
          if (l.rule.kind === 'block') {
            res = BLOCKS.parseStateKey(l.rule.state);
          } else if (l.here.length > 0) {
            // A here-gated bandlands or strata leaf: looked up without evaluating the tree.
            let n = direct.indexOf(l.rule);
            if (n < 0) n = direct.push(l.rule) - 1;
            res = DIRECT - n;
          } else {
            // A Y-only bandlands or strata leaf: the band is evaluated.
            res = -1;
          }
          break;
        }
      }
      results.push(res);
      if (k === -1) state = res;
      else if (res !== state) state = -1;
    }
    bands.push({ yMin: y, yMax: end, dither: d, state: state < -1 ? -1 : state });
    y = end + 1;
  }
  const fastPath: SurfaceFastPath = {
    maxSurfaceDepth: Math.max(skyFloorBound, floorBound), skyGated, skyFloorBound, floorBound, ceilBound,
    floorBiomes: floorLeaves === 0 ? -1 : floorBiomes, ceilBiomes: ceilLeaves === 0 ? -1 : ceilBiomes, here, bands,
  };
  return { fastPath, results: Int32Array.from(results), direct };
}

/**
 * The fast-path analysis of the valid tree `root` with SD_MAX `sdMax` (§3.4, SP6b §3.5): null when some leaf is
 * neither floor-bounded, ceiling-bounded, Y-only nor here-gated. Block states are resolved with the registry (`root`
 * must be valid).
 */
export function surfaceFastPath(root: Rule, sdMax: number): SurfaceFastPath | null {
  return analyse(root, sdMax)?.fastPath ?? null;
}

/** The scan context the closures read: the position's readouts, the voxel's run and y. */
interface Cursor {
  /** Changes with every position set (the noise caches' key). */
  stamp: number;
  x: number;
  z: number;
  biome: number;
  steep: number;
  T: number;
  lake: number;
  sd: number;
  top: number;
  bottom: number;
  sky: boolean;
  waterAbove: boolean;
  waterTop: number;
  /** The run's floor and ceiling cave biomes (−1 none). */
  floorBiome: number;
  ceilBiome: number;
  /** The scan's cave picker and pass (`caveBiome{here}`), null when it has none. */
  picker: CavePickerInputs | null;
  pass: CaveColumnPass | null;
  /**
   * The cave biomes the picker can return at the voxel (bit b = biome b; the position's classification at y, SP6b
   * §3.5 item 4), set only while a fast fill evaluates a classified position; 0 otherwise (`caveBiome{here}` then asks
   * the picker).
   */
  hereMask: number;
  /** The picker's biome at the voxel (stamp, y) last asked, so the tree's `caveBiome{here}`s pick once per voxel. */
  hereStamp: number;
  hereY: number;
  hereBiome: number;
  y: number;
}

type CondFn = () => boolean;
type RuleFn = () => number;

/**
 * Validates `rules` (`requireValidRules` against `noises`: a RuleValidationError lists every issue) and compiles it for
 * the world seed `seed` (the gradient seeds, the band table), the surface noises `noises` and the scan settings `set`
 * (SD_MAX for the fast path; lapse and lapseBase for T_eff). Scans evaluated with it must be made with the same
 * settings. `bands` is the band table of `seed` when the caller already holds it (the SurfaceContext's); by default it
 * is built when the tree has a `bandlands` leaf. Each `strata` node's table is built here, numbered by its first
 * occurrence in depth-first order (SP6b spec §3.3).
 */
export function compileSurfaceRules(
  seed: Seed64, rules: unknown, noises: SurfaceNoiseSource, set: SurfaceScanSettings, bands?: Uint16Array,
): CompiledSurfaceRules {
  const tree = VALID(rules, noises);
  if (bands !== undefined && !IS_BAND_TABLE(bands)) throw new RangeError(`compileSurfaceRules: the band table has ${bands.length} entries`);
  let table: Uint16Array | null = null;
  const strataTables = new Map<StrataRule, Uint16Array>();
  const lapse = set.lapse;
  const lapseBase = set.lapseBase;
  const cur: Cursor = {
    stamp: 0, x: 0, z: 0, biome: 0, steep: 0, T: 0, lake: 0, sd: 0, top: 0, bottom: 0, sky: false, waterAbove: false, waterTop: 0,
    floorBiome: -1, ceilBiome: -1, picker: null, pass: null, hereMask: 0, hereStamp: -1, hereY: 0, hereBiome: -1, y: 0,
  };
  /** The picker's cave biome at the cursor's voxel (−1 without a picker), picked once per voxel. */
  const hereBiome = (): number => {
    if (cur.hereStamp !== cur.stamp || cur.hereY !== cur.y) {
      cur.hereBiome = CAVE_HERE(cur.picker, cur.pass, cur.x, cur.y, cur.z);
      cur.hereStamp = cur.stamp;
      cur.hereY = cur.y;
    }
    return cur.hereBiome;
  };
  let hasHere = false;

  const cond = (c: Condition): CondFn => {
    switch (c.kind) {
      case 'biome': {
        const m = MASK(c.biomes);
        return () => BIOME_OK(m, cur.biome);
      }
      case 'stoneDepth': {
        const { side, offset, addSurfaceDepth } = c;
        return () => DEPTH_OK(side, cur.top - cur.y, cur.y - cur.bottom, offset, addSurfaceDepth, cur.sd);
      }
      case 'water': {
        const { offset, runTop } = c;
        return () => WATER_OK(cur.waterAbove, cur.waterTop, cur.y, cur.top, offset, runTop);
      }
      case 'yAbove': {
        const { minY, runTop } = c;
        return () => Y_OK(cur.y, cur.top, minY, runTop);
      }
      case 'verticalGradient': {
        const { trueAtAndBelow, falseAtAndAbove } = c;
        const g = G_SEED(seed, trueAtAndBelow, falseAtAndAbove);
        return () => GRADIENT_OK(g, cur.x, cur.y, cur.z, trueAtAndBelow, falseAtAndAbove);
      }
      case 'steep': {
        const min = c.min;
        return () => STEEP_OK(cur.steep, min);
      }
      case 'noiseThreshold': {
        const n = noises(c.noise)!;
        const { min, max } = c;
        // The noise depends on (x, z) only: sampled once per position.
        let stamp = -1;
        let v = 0;
        return () => {
          if (stamp !== cur.stamp) {
            v = n.z2(cur.x, cur.z);
            stamp = cur.stamp;
          }
          return NOISE_OK(v, min, max);
        };
      }
      case 'temperatureBelow': {
        const t = c.t;
        return () => TEMP_OK(T_EFF(cur.T, cur.y, lapse, lapseBase), t);
      }
      case 'skyOpen': return () => SKY_OK(cur.sky);
      case 'lake': return () => LAKE_OK(cur.lake);
      case 'not': {
        const inner = cond(c.if);
        return () => !inner();
      }
      case 'caveBiome': {
        const m = CAVE_MASK(c.biomes);
        switch (c.side) {
          case 'floor': return () => CAVE_OK(m, cur.floorBiome);
          case 'ceiling': return () => CAVE_OK(m, cur.ceilBiome);
          case 'here': {
            hasHere = true;
            const bits = caveBits(c.biomes);
            // A sure classification answers without the picker: every possible biome in the set, or none of them.
            return () => {
              const hm = cur.hereMask;
              if (hm !== 0) {
                const inSet = hm & bits;
                if (inSet === hm) return true;
                if (inSet === 0) return false;
              }
              return CAVE_OK(m, hereBiome());
            };
          }
        }
      }
    }
  };

  const rule = (r: Rule): RuleFn => {
    switch (r.kind) {
      case 'sequence': {
        const fs = r.rules.map(rule);
        const n = fs.length;
        return () => {
          for (let k = 0; k < n; k++) {
            const s = fs[k]!();
            if (s >= 0) return s;
          }
          return -1;
        };
      }
      case 'condition': {
        const test = cond(r.if);
        const then = rule(r.then);
        return () => (test() ? then() : -1);
      }
      case 'block': {
        const s = BLOCKS.parseStateKey(r.state);
        return () => s;
      }
      case 'bandlands': {
        table ??= bands ?? BAND_TABLE(seed);
        const t = table;
        const n = noises(BAND_NOISE)!;
        const cs = n.clampSigma;
        // The offset depends on (x, z) only: sampled once per position.
        let stamp = -1;
        let o = 0;
        return () => {
          if (stamp !== cur.stamp) {
            o = BAND_OFFSET(n.z2(cur.x, cur.z), cs);
            stamp = cur.stamp;
          }
          return BAND_STATE(t, cur.y, o);
        };
      }
      case 'strata': {
        let t = strataTables.get(r);
        if (t === undefined) {
          t = STRATA_TABLE(seed, strataTables.size, r);
          strataTables.set(r, t);
        }
        const tt = t;
        const n = noises(r.noise)!;
        const { amp } = r;
        const cs = n.clampSigma;
        // amp 0 ignores the noise; otherwise the offset depends on (x, z) only: sampled once per position.
        if (amp === 0) return () => STRATA_STATE(tt, cur.y, 0);
        let stamp = -1;
        let o = 0;
        return () => {
          if (stamp !== cur.stamp) {
            o = STRATA_OFFSET(n.z2(cur.x, cur.z), amp, cs);
            stamp = cur.stamp;
          }
          return STRATA_STATE(tt, cur.y, o);
        };
      }
    }
  };

  const root = rule(tree);
  const analysis = analyse(tree, set.sdMax);
  const fastPath = analysis === null ? null : analysis.fastPath;
  /** Per y + 64: the constant band's state, or −1 (dither interval, y −64, or no fast path). */
  const bandState = new Int32Array(384).fill(-1);
  /**
   * With here-gated leaves (SP6b §3.5 item 4), per classification mask m (0: the scan has no picker) and y + 64 at
   * 384·m + y + 64: the band result common to the mask's cave biomes (a state, or DIRECT − n for `direct[n]`), or −1
   * (evaluate: they differ, a dither interval, an always-evaluated leaf).
   */
  const hereBand = new Int32Array(analysis !== null && analysis.fastPath.here ? 16 * 384 : 0).fill(-1);
  /** The here-gated `bandlands` and `strata` leaves the bands look up, compiled on their own. */
  const direct = analysis === null ? [] : analysis.direct.map(rule);
  if (analysis !== null) {
    const { results } = analysis;
    analysis.fastPath.bands.forEach((b, i) => {
      for (let y = b.yMin; y <= b.yMax; y++) bandState[y + 64] = b.state;
      if (hereBand.length === 0) return;
      for (let m = 0; m < 16; m++) {
        // m 0: no picker (key −1); else the result when every biome of m gives the same one.
        let res = results[5 * i]!;
        if (m !== 0) {
          res = 0;
          let first = true;
          for (let k = 0; k < PICKED_BIOMES; k++) {
            if (((m >> k) & 1) === 0) continue;
            const r = results[5 * i + k + 1]!;
            if (first) { res = r; first = false; } else if (r !== res) res = -1;
          }
        }
        for (let y = b.yMin; y <= b.yMax; y++) hereBand[384 * m + y + 64] = res;
      }
    });
  }

  const setPosition = (scan: SurfaceScan, p: number, classify: boolean): number => {
    cur.stamp++;
    cur.x = 16 * scan.cx + (p & 15);
    cur.z = 16 * scan.cz + (p >> 4);
    cur.biome = scan.biome[p]!;
    cur.steep = scan.steep[p]!;
    cur.T = scan.T[p]!;
    cur.lake = scan.lakeLevel[p]!;
    cur.sd = scan.surfaceDepth[p]!;
    cur.picker = scan.cavePicker;
    cur.pass = scan.cavePass;
    cur.hereMask = 0;
    // The position's cave-biome classification (SP6b §3.5 item 4), once per position: its ranges, or 0.
    return classify ? CLASSIFY(scan, p) : 0;
  };
  const setRun = (scan: SurfaceScan, r: number, sky: boolean): void => {
    cur.top = scan.runTop[r]!;
    cur.bottom = scan.runBottom[r]!;
    cur.sky = sky;
    cur.waterAbove = scan.runWaterAbove[r] === 1;
    cur.waterTop = scan.runWaterTop[r]!;
    cur.floorBiome = scan.runFloorBiome[r]!;
    cur.ceilBiome = scan.runCeilBiome[r]!;
  };

  return {
    rules: tree,
    settings: set,
    fastPath,
    state(scan, p, y) {
      if (!Number.isInteger(p) || p < 0 || p > 255) throw new RangeError(`compiled surface rules: position ${p} is outside 0 … 255`);
      if (!Number.isInteger(y) || y < Y_MIN || y > Y_MAX) throw new RangeError(`compiled surface rules: y ${y} is outside −63 … 319`);
      const r = RUN_AT(scan, p, y);
      if (r < 0) throw new RangeError(`compiled surface rules: voxel (p ${p}, y ${y}) is not solid`);
      setPosition(scan, p, false);
      setRun(scan, r, r === scan.skyRun[p]);
      cur.y = y;
      const s = root();
      return s < 0 ? STONE_STATE : s;
    },
    fillColumn(scan, out, fast) {
      if (out.length !== COLUMN_VOXELS) throw new RangeError(`fillColumn: out has ${out.length} entries, expected ${COLUMN_VOXELS}`);
      const useFast = fast && fastPath !== null;
      // The floor bounds of the sky-open run (both floor classes) and of every other run (the non-sky class only), and
      // the ceiling bound, each with its biome-gated skip (SP6b §3.5 items 1-3).
      const skyFloor = fastPath === null ? 0 : fastPath.skyFloorBound;
      const otherFloor = fastPath === null ? 0 : fastPath.floorBound;
      const ceilAll = fastPath === null ? 0 : fastPath.ceilBound;
      const floorSet = fastPath === null ? -1 : fastPath.floorBiomes;
      const ceilSet = fastPath === null ? -1 : fastPath.ceilBiomes;
      // Item 4: the bands by classification mask with here-gated leaves; the classification wherever caveBiome{here}
      // is compiled and the scan has a picker.
      const byMask = useFast && hereBand.length > 0;
      const classify = useFast && hasHere && scan.cavePicker !== null && scan.cavePass !== null;
      const { runFirst, skyRun, runTop, runBottom, runFloorBiome, runCeilBiome, caveRangeLow, caveRangeMask } = scan;
      let evaluated = 0;
      for (let p = 0; p < 256; p++) {
        const ranges = setPosition(scan, p, classify);
        let ri = 0;
        const first = runFirst[p]!;
        const end = runFirst[p + 1]!;
        const sky = skyRun[p]!;
        for (let r = first; r < end; r++) {
          setRun(scan, r, r === sky);
          const top = runTop[r]!;
          const bottom = runBottom[r]!;
          const fb = runFloorBiome[r]!;
          const cb = runCeilBiome[r]!;
          const floor = floorSet >= 0 && (fb < 0 || ((floorSet >> fb) & 1) === 0) ? -1 : otherFloor;
          const ceil = ceilSet >= 0 && (cb < 0 || ((ceilSet >> cb) & 1) === 0) ? -1 : ceilAll;
          // Voxels at shallow ≤ y ≤ deep may take their band's result: floorDepth beyond the run's floor bound and
          // ceilDepth beyond its ceiling bound (a bound −1 holds the whole run).
          const deep = !useFast ? Y_MIN - 2 : top - (r === sky ? Math.max(skyFloor, floor) : floor) - 1;
          const shallow = bottom + ceil + 1;
          for (let y = top; y >= bottom; y--) {
            const i = ((y + 64) << 8) | p;
            // The classification's mask at y: the runs and their voxels are top-down, so the range only moves down.
            let m = 0;
            if (ranges > 0) {
              while (y < caveRangeLow[ri]!) ri++;
              m = caveRangeMask[ri]!;
            }
            if (y <= deep && y >= shallow) {
              const b = byMask ? hereBand[384 * m + y + 64]! : bandState[y + 64]!;
              if (b >= 0) {
                out[i] = b;
                continue;
              }
              if (b < -1) {
                // A here-gated bandlands or strata leaf: its block, without evaluating the tree.
                cur.y = y;
                out[i] = direct[DIRECT - b]!();
                continue;
              }
            }
            cur.y = y;
            cur.hereMask = m;
            const s = root();
            out[i] = s < 0 ? STONE_STATE : s;
            evaluated++;
          }
        }
      }
      return evaluated;
    },
  };
}

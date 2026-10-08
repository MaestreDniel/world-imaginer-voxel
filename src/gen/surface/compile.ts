/**
 * The surface-rule compiler and its fast path (SP3c spec §3.4).
 *
 * Compile: `requireValidRules`, then one closure per rule and condition node over a cursor (the scan context: the
 * voxel's position readouts, its run and its y), preallocated per compiled tree, so an evaluation allocates nothing.
 * Evaluation order is the tree's (a `sequence` yields its first child that yields, a `condition` evaluates `if` then
 * `then`); every condition is decided by its helper in conditions.ts on the same readouts the reference evaluator
 * uses (floorDepth = runTop − y, ceilDepth = y − runBottom, yTop = runTop, `waterAbove` / `waterTop` of the run, the
 * run is sky-open when it is its position's first, T_eff(y) from the position's T and the settings' lapse), so the
 * compiled tree equals the reference on every voxel. Nothing yielded leaves the voxel stone.
 *
 * Fast path (`surfaceFastPath`, compile time, general and conservative). Every leaf is classed by the `if`s on its
 * path (sequences ignored):
 * - depth-bounded: a path `if` is `stoneDepth{side floor}` (not under a `not`); its bound is the smallest, over those
 *   gates, of offset + (addSurfaceDepth ? SD_MAX : 0);
 * - Y-only: every path `if` is a `verticalGradient`, a `yAbove{runTop false}` or a `not` of these.
 * With any other leaf there is no fast path. Otherwise maxSurfaceDepth is the largest bound (−1 when there is no
 * depth-bounded leaf: floorDepth ≥ 0 exceeds it everywhere); the tree is sky-gated when every depth-bounded path also
 * holds a `skyOpen` `if`. The y range −63 … 319 is cut only by the Y-only leaves' conditions: at each such
 * `yAbove{runTop false}`'s minY and at each such gradient's ends; a gradient's dither interval
 * [trueAtAndBelow + 1, falseAtAndAbove − 1] is always evaluated; every other interval is a constant band whose state is
 * the tree evaluated at compile time without its depth-bounded leaves (stone when nothing matches). `fillColumn` gives
 * a solid voxel of a constant band its band's state without evaluating when floorDepth > maxSurfaceDepth or, in a
 * sky-gated tree, when its run is not sky-open; non-solid voxels are never written. Follows the gen determinism rules.
 */
import type { Seed64 } from '../../core/hash';
import { REGISTRY, STONE } from '../../world/blocks/index';
import {
  biomeHolds, biomeMask, gradientSeed, lakeHolds, noiseThresholdHolds, skyOpenHolds, steepHolds, stoneDepthHolds,
  temperatureBelowHolds, verticalGradientHolds, waterHolds, yAboveHolds,
} from './conditions';
import { requireValidRules, ruleLeaves, type Condition, type Rule, type SurfaceNoiseSource } from './rules';
import { runAt, tEff, type SurfaceScan, type SurfaceScanSettings } from './scan';

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

/** Voxels per column, index `256·(y + 64) + p` (the T stage's order). */
const COLUMN_VOXELS = 98304;
const Y_MIN = -63;
const Y_MAX = 319;

/** One interval of the fast path's cut of y −63 … 319. */
export interface SurfaceBand {
  readonly yMin: number;
  readonly yMax: number;
  /** A dither interval of a Y-only gradient: always evaluated. */
  readonly dither: boolean;
  /** The constant band's state (the tree without its depth-bounded leaves); −1 for a dither interval. */
  readonly state: number;
}

/** The fast-path analysis of a tree (§3.4). */
export interface SurfaceFastPath {
  /** The largest bound of the depth-bounded leaves, at the settings' SD_MAX; −1 when there is none. */
  readonly maxSurfaceDepth: number;
  /** Every depth-bounded leaf's path holds a `skyOpen` (not under a `not`); true when there is none. */
  readonly skyGated: boolean;
  /** The cut of y −63 … 319, bottom-up, contiguous: constant bands and dither intervals. */
  readonly bands: readonly SurfaceBand[];
}

/** A compiled tree, bound to one world seed, noise source and scan settings. */
export interface CompiledSurfaceRules {
  /** The validated tree. */
  readonly rules: Rule;
  /** The settings it was compiled for (SD_MAX for the fast path, lapse and lapseBase for T_eff). */
  readonly settings: SurfaceScanSettings;
  /** The fast-path analysis, or null when some leaf is neither depth-bounded nor Y-only. */
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

/**
 * The fast-path analysis of the valid tree `root` with SD_MAX `sdMax` (§3.4): null when some leaf is neither
 * depth-bounded nor Y-only. Block states are resolved with the registry (`root` must be valid).
 */
export function surfaceFastPath(root: Rule, sdMax: number): SurfaceFastPath | null {
  const leaves = LEAVES(root);
  let maxSurfaceDepth = -1;
  let skyGated = true;
  const yLeaves: { readonly state: number; readonly conditions: readonly Condition[] }[] = [];
  for (const leaf of leaves) {
    let bound = Infinity;
    let sky = false;
    for (const c of leaf.conditions) {
      if (c.kind === 'stoneDepth' && c.side === 'floor') bound = Math.min(bound, c.offset + (c.addSurfaceDepth ? sdMax : 0));
      else if (c.kind === 'skyOpen') sky = true;
    }
    if (bound !== Infinity) {
      maxSurfaceDepth = Math.max(maxSurfaceDepth, bound);
      if (!sky) skyGated = false;
    } else if (leaf.conditions.every(isYOnly)) {
      yLeaves.push({ state: BLOCKS.parseStateKey(leaf.rule.state), conditions: leaf.conditions });
    } else {
      return null;
    }
  }
  const starts = new Uint8Array(384);
  const dither = new Uint8Array(384);
  for (const l of yLeaves) for (const c of l.conditions) cutAt(c, starts, dither);
  const bands: SurfaceBand[] = [];
  let y = Y_MIN;
  while (y <= Y_MAX) {
    const d = dither[y + 64] === 1;
    let end = y;
    // A dither interval runs while dithered; a constant band until the next start or dither interval.
    while (end < Y_MAX && (dither[end + 65] === 1) === d && (d || starts[end + 65] === 0)) end++;
    let state = -1;
    if (!d) {
      state = STONE_STATE;
      for (const l of yLeaves) {
        if (l.conditions.every((c) => yOnlyHoldsAt(c, y))) { state = l.state; break; }
      }
    }
    bands.push({ yMin: y, yMax: end, dither: d, state });
    y = end + 1;
  }
  return { maxSurfaceDepth, skyGated, bands };
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
  y: number;
}

type CondFn = () => boolean;
type RuleFn = () => number;

/**
 * Validates `rules` (`requireValidRules` against `noises`: a RuleValidationError lists every issue) and compiles it for
 * the world seed `seed` (the gradient seeds), the surface noises `noises` and the scan settings `set` (SD_MAX for the
 * fast path; lapse and lapseBase for T_eff). Scans evaluated with it must be made with the same settings.
 */
export function compileSurfaceRules(seed: Seed64, rules: unknown, noises: SurfaceNoiseSource, set: SurfaceScanSettings): CompiledSurfaceRules {
  const tree = VALID(rules, noises);
  const lapse = set.lapse;
  const lapseBase = set.lapseBase;
  const cur: Cursor = {
    stamp: 0, x: 0, z: 0, biome: 0, steep: 0, T: 0, lake: 0, sd: 0, top: 0, bottom: 0, sky: false, waterAbove: false, waterTop: 0, y: 0,
  };

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
    }
  };

  const root = rule(tree);
  const fastPath = surfaceFastPath(tree, set.sdMax);
  /** Per y + 64: the constant band's state, or −1 (dither interval, y −64, or no fast path). */
  const bandState = new Int32Array(384).fill(-1);
  if (fastPath !== null) {
    for (const b of fastPath.bands) for (let y = b.yMin; y <= b.yMax; y++) bandState[y + 64] = b.state;
  }

  const setPosition = (scan: SurfaceScan, p: number): void => {
    cur.stamp++;
    cur.x = 16 * scan.cx + (p & 15);
    cur.z = 16 * scan.cz + (p >> 4);
    cur.biome = scan.biome[p]!;
    cur.steep = scan.steep[p]!;
    cur.T = scan.T[p]!;
    cur.lake = scan.lakeLevel[p]!;
    cur.sd = scan.surfaceDepth[p]!;
  };
  const setRun = (scan: SurfaceScan, r: number, sky: boolean): void => {
    cur.top = scan.runTop[r]!;
    cur.bottom = scan.runBottom[r]!;
    cur.sky = sky;
    cur.waterAbove = scan.runWaterAbove[r] === 1;
    cur.waterTop = scan.runWaterTop[r]!;
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
      setPosition(scan, p);
      setRun(scan, r, r === scan.runFirst[p]);
      cur.y = y;
      const s = root();
      return s < 0 ? STONE_STATE : s;
    },
    fillColumn(scan, out, fast) {
      if (out.length !== COLUMN_VOXELS) throw new RangeError(`fillColumn: out has ${out.length} entries, expected ${COLUMN_VOXELS}`);
      const useFast = fast && fastPath !== null;
      const maxSd = fastPath === null ? 0 : fastPath.maxSurfaceDepth;
      const skyGated = fastPath !== null && fastPath.skyGated;
      const { runFirst, runTop, runBottom } = scan;
      let evaluated = 0;
      for (let p = 0; p < 256; p++) {
        setPosition(scan, p);
        const first = runFirst[p]!;
        const end = runFirst[p + 1]!;
        for (let r = first; r < end; r++) {
          setRun(scan, r, r === first);
          const top = runTop[r]!;
          const bottom = runBottom[r]!;
          // Voxels at y ≤ deep may take their band's state: floorDepth > maxSurfaceDepth, or the whole run when the
          // tree is sky-gated and the run has no sky.
          const deep = !useFast ? Y_MIN - 2 : skyGated && r !== first ? top : top - maxSd - 1;
          for (let y = top; y >= bottom; y--) {
            const i = ((y + 64) << 8) | p;
            if (y <= deep) {
              const b = bandState[y + 64]!;
              if (b >= 0) {
                out[i] = b;
                continue;
              }
            }
            cur.y = y;
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

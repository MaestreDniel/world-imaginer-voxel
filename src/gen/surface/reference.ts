/**
 * The reference evaluator of the surface rules (SP3c spec §3.4): a plain tree walk over a validated rule tree with
 * §3.1's semantics (a `sequence` yields its first child that yields a block, a `condition` evaluates `if` then `then`,
 * a `block` yields its state; nothing yielded leaves the voxel stone), evaluated at one solid voxel of a scanned
 * column, recording the rule path. It never takes the fast path. It is the oracle of the compiled closures (DT2's
 * `surfaceReference`, the compile fuzz) and the evaluator of `surfaceProbe` (§3.6) and U2's acceptance check (§3.5).
 *
 * Every condition is decided by its helper in conditions.ts on the scan's readouts (§3.2): floorDepth = runTop − y and
 * ceilDepth = y − runBottom of the voxel's run (`runAt`), yTop = runTop, `waterAbove` / `waterTop` of the run, the
 * run is sky-open when it is its position's first run, and T_eff(y) from the position's T and the settings' lapse.
 * Noises sample unscaled world block coordinates (x, z) = (16·cx + lx, 16·cz + lz). The per-node preparation (a
 * biome mask, a gradient's derived seed, a block's state id, a noise) is done once at creation. Follows the gen
 * determinism rules.
 */
import type { Seed64 } from '../../core/hash';
import { REGISTRY, STONE } from '../../world/blocks/index';
import {
  biomeHolds, biomeMask, gradientSeed, lakeHolds, noiseThresholdHolds, skyOpenHolds, steepHolds, stoneDepthHolds,
  temperatureBelowHolds, verticalGradientHolds, waterHolds, yAboveHolds,
} from './conditions';
import {
  conditionThenId, requireValidRules, ROOT_RULE_ID, sequenceChildId, type BlockRule, type Condition, type Rule,
  type SurfaceNoise, type SurfaceNoiseSource,
} from './rules';
import { runAt, tEff, type SurfaceScan, type SurfaceScanSettings } from './scan';

const BLOCKS = REGISTRY;
const STONE_STATE = STONE;
const VALID = requireValidRules;
const ROOT = ROOT_RULE_ID;
const CHILD_ID = sequenceChildId;
const THEN_ID = conditionThenId;
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

/** The surface rules' answer at one voxel. */
export interface SurfaceRuleResult {
  /** The final state: the yielding leaf's state, or stone when no rule yields. */
  readonly state: number;
  /** The rule ids from `root` to the leaf that yielded (each the parent of the next); [] when no rule yields. */
  readonly path: readonly string[];
}

export interface SurfaceReference {
  /** The validated tree. */
  readonly rules: Rule;
  /**
   * The state and rule path at the solid voxel (p, y) of the column last scanned into `scan` (with `set`): p = lz·16 + lx
   * in 0 … 255, y in −63 … 319, both integers. Throws a RangeError outside, or when the voxel is not solid (y −64 is
   * the stage's bedrock and is never evaluated).
   */
  evaluate(scan: SurfaceScan, set: SurfaceScanSettings, p: number, y: number): SurfaceRuleResult;
  /** `evaluate(…).state` without recording the path. */
  state(scan: SurfaceScan, set: SurfaceScanSettings, p: number, y: number): number;
}

/** Per-voxel readouts of one evaluation. */
interface Voxel {
  scan: SurfaceScan;
  set: SurfaceScanSettings;
  p: number;
  y: number;
  r: number;
  x: number;
  z: number;
}

/**
 * Validates `rules` (`requireValidRules` against `noises`: throws a RuleValidationError listing every issue) and returns
 * its reference evaluator for the world seed `seed` (the `verticalGradient` seeds) and the surface noises `noises`
 * (`noiseThreshold`, sampled through the same source).
 */
export function createSurfaceReference(seed: Seed64, rules: unknown, noises: SurfaceNoiseSource): SurfaceReference {
  const tree = VALID(rules, noises);
  const masks = new Map<Condition, Uint8Array>();
  const seeds = new Map<Condition, number>();
  const noiseOf = new Map<Condition, SurfaceNoise>();
  const states = new Map<BlockRule, number>();

  const prepCondition = (c: Condition): void => {
    switch (c.kind) {
      case 'biome': masks.set(c, MASK(c.biomes)); break;
      case 'verticalGradient': seeds.set(c, G_SEED(seed, c.trueAtAndBelow, c.falseAtAndAbove)); break;
      case 'noiseThreshold': noiseOf.set(c, noises(c.noise)!); break;
      case 'not': prepCondition(c.if); break;
      default: break;
    }
  };
  const prepRule = (r: Rule): void => {
    switch (r.kind) {
      case 'sequence': for (const c of r.rules) prepRule(c); break;
      case 'condition': prepCondition(r.if); prepRule(r.then); break;
      case 'block': states.set(r, BLOCKS.parseStateKey(r.state)); break;
    }
  };
  prepRule(tree);

  const holds = (c: Condition, v: Voxel): boolean => {
    const { scan, p, y, r } = v;
    switch (c.kind) {
      case 'biome': return BIOME_OK(masks.get(c)!, scan.biome[p]!);
      case 'stoneDepth': {
        const top = scan.runTop[r]!;
        return DEPTH_OK(c.side, top - y, y - scan.runBottom[r]!, c.offset, c.addSurfaceDepth, scan.surfaceDepth[p]!);
      }
      case 'water': return WATER_OK(scan.runWaterAbove[r] === 1, scan.runWaterTop[r]!, y, scan.runTop[r]!, c.offset, c.runTop);
      case 'yAbove': return Y_OK(y, scan.runTop[r]!, c.minY, c.runTop);
      case 'verticalGradient': return GRADIENT_OK(seeds.get(c)!, v.x, y, v.z, c.trueAtAndBelow, c.falseAtAndAbove);
      case 'steep': return STEEP_OK(scan.steep[p]!, c.min);
      case 'noiseThreshold': return NOISE_OK(noiseOf.get(c)!.z2(v.x, v.z), c.min, c.max);
      case 'temperatureBelow': return TEMP_OK(T_EFF(scan.T[p]!, y, v.set.lapse, v.set.lapseBase), c.t);
      case 'skyOpen': return SKY_OK(r === scan.runFirst[p]);
      case 'lake': return LAKE_OK(scan.lakeLevel[p]!);
      case 'not': return !holds(c.if, v);
    }
  };

  /** The state `r` yields at `v`, or −1; on a yield, appends the ids from the leaf up to `r` to `trail` (when given). */
  const walk = (r: Rule, id: string, v: Voxel, trail: string[] | null): number => {
    let s = -1;
    switch (r.kind) {
      case 'sequence':
        for (let k = 0; k < r.rules.length && s < 0; k++) s = walk(r.rules[k]!, CHILD_ID(id, k), v, trail);
        break;
      case 'condition':
        if (holds(r.if, v)) s = walk(r.then, THEN_ID(id), v, trail);
        break;
      case 'block':
        s = states.get(r)!;
        break;
    }
    if (s >= 0 && trail !== null) trail.push(id);
    return s;
  };

  const voxel = (scan: SurfaceScan, set: SurfaceScanSettings, p: number, y: number): Voxel => {
    if (!Number.isInteger(p) || p < 0 || p > 255) throw new RangeError(`surface reference: position ${p} is outside 0 … 255`);
    if (!Number.isInteger(y) || y < -63 || y > 319) throw new RangeError(`surface reference: y ${y} is outside −63 … 319`);
    const r = RUN_AT(scan, p, y);
    if (r < 0) throw new RangeError(`surface reference: voxel (p ${p}, y ${y}) is not solid`);
    return { scan, set, p, y, r, x: 16 * scan.cx + (p & 15), z: 16 * scan.cz + (p >> 4) };
  };

  return {
    rules: tree,
    evaluate(scan, set, p, y) {
      const trail: string[] = [];
      const s = walk(tree, ROOT, voxel(scan, set, p, y), trail);
      return s < 0 ? { state: STONE_STATE, path: [] } : { state: s, path: trail.reverse() };
    },
    state(scan, set, p, y) {
      const s = walk(tree, ROOT, voxel(scan, set, p, y), null);
      return s < 0 ? STONE_STATE : s;
    },
  };
}

/**
 * Per-condition semantics (SP3c spec §3.1, §3.2): one helper per condition kind, on plain scan readouts, so the
 * compiled closures and the reference evaluator decide every condition with the same code. `not` is the evaluators'
 * negation of its inner condition and has no helper. Compile-time preparation (a biome set as a mask, a gradient's
 * derived seed) is here as well, so both evaluators prepare alike.
 */
import { deriveSeed, hash3, type Seed64 } from '../../core/hash';
import { SURFACE_BIOMES } from '../biomes/registry';

const DERIVE = deriveSeed;
const HASH3 = hash3;
const BIOMES = SURFACE_BIOMES;
const BIOME_INDEX = new Map<string, number>(BIOMES.map((n, i) => [n, i]));
/** 2^−32: a u32 hash times this lies in [0, 1). */
const INV_U32 = 1 / 4294967296;

/** A biome set as a mask over surface biome ids (1 = in the set). Throws on an unknown biome name. */
export function biomeMask(biomes: readonly string[]): Uint8Array {
  const m = new Uint8Array(BIOMES.length);
  for (const b of biomes) {
    const id = BIOME_INDEX.get(b);
    if (id === undefined) throw new Error(`biomeMask: unknown surface biome ${JSON.stringify(b)}`);
    m[id] = 1;
  }
  return m;
}

/** `biome`: the position's per-block surface biome id is in the set. */
export function biomeHolds(mask: Uint8Array, biome: number): boolean {
  return mask[biome] === 1;
}

/** `stoneDepth`: floorDepth (side floor) or ceilDepth (side ceiling) ≤ offset (+ surfaceDepth when addSurfaceDepth). */
export function stoneDepthHolds(
  side: 'floor' | 'ceiling', floorDepth: number, ceilDepth: number, offset: number, addSurfaceDepth: boolean, surfaceDepth: number,
): boolean {
  return (side === 'floor' ? floorDepth : ceilDepth) <= (addSurfaceDepth ? offset + surfaceDepth : offset);
}

/** `water`: the run has no water directly above its top, or (runTop ? yTop : y) ≥ waterTop + offset. */
export function waterHolds(waterAbove: boolean, waterTop: number, y: number, yTop: number, offset: number, runTop: boolean): boolean {
  return !waterAbove || (runTop ? yTop : y) >= waterTop + offset;
}

/** `yAbove`: (runTop ? yTop : y) ≥ minY. */
export function yAboveHolds(y: number, yTop: number, minY: number, runTop: boolean): boolean {
  return (runTop ? yTop : y) >= minY;
}

/** The seed of a `verticalGradient` (derived once at compile time): deriveSeed(seed, 'surface.gradient.<lo>.<hi>'). */
export function gradientSeed(seed: Seed64, trueAtAndBelow: number, falseAtAndAbove: number): number {
  return DERIVE(seed, `surface.gradient.${trueAtAndBelow}.${falseAtAndAbove}`);
}

/**
 * `verticalGradient` at (x, y, z) with its `gradientSeed`: true at y ≤ trueAtAndBelow, false at y ≥ falseAtAndAbove,
 * otherwise true when hash3(seed, x, y, z)·2^−32 < (falseAtAndAbove − y) / (falseAtAndAbove − trueAtAndBelow).
 */
export function verticalGradientHolds(
  seed: number, x: number, y: number, z: number, trueAtAndBelow: number, falseAtAndAbove: number,
): boolean {
  if (y <= trueAtAndBelow) return true;
  if (y >= falseAtAndAbove) return false;
  return HASH3(seed, x, y, z) * INV_U32 < (falseAtAndAbove - y) / (falseAtAndAbove - trueAtAndBelow);
}

/** `steep`: the position's steep ≥ min. */
export function steepHolds(steep: number, min: number): boolean {
  return steep >= min;
}

/** `noiseThreshold`: min ≤ z ≤ max (closed at both ends), z the named noise's z2 at (x, z). */
export function noiseThresholdHolds(z: number, min: number, max: number): boolean {
  return min <= z && z <= max;
}

/** `temperatureBelow`: T_eff(y) < t. */
export function temperatureBelowHolds(tEff: number, t: number): boolean {
  return tEff < t;
}

/** `skyOpen`: the voxel's run is the topmost solid run of its position. */
export function skyOpenHolds(runIsSkyOpen: boolean): boolean {
  return runIsSkyOpen;
}

/** `lake`: the lakeLevel at the position's nearest quart corner (`readLevel`'s rounding) is finite. */
export function lakeHolds(lakeLevel: number): boolean {
  return Number.isFinite(lakeLevel);
}

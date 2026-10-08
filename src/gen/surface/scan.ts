/**
 * The whole-column scan of the surface pass (SP3c spec §3.2). Over one column's solidity and water (the T stage's
 * density and water v0, or a hand-built column), for each of the 256 positions top-down from y 319 to y −63 (y −64 is
 * the stage's bedrock and is not scanned):
 * - runs: maximal vertical runs of solid voxels, stored top-down per position; the first is the sky-open run;
 * - per run: yTop (`runTop`), its bottom voxel (`runBottom`), `waterAbove` (the voxel above yTop holds water) and
 *   `waterTop` (the highest voxel of the contiguous water directly above yTop);
 * - per solid voxel at y of run r: floorDepth = runTop[r] − y (0 at the run's top voxel), ceilDepth = y − runBottom[r];
 * - per position: `steep` and `T` (bilinear `readField`, as SP3b's `col`), the per-block surface biome (the stage's
 *   256-entry buffer, `fillSurfaceBiomes`), `lakeLevel` at the nearest quart corner (`readLevel`'s corner) and
 *   surfaceDepth = max(0, ⌊3 + 2.75·depthMul·Ns + 0.25·hash01⌋) ∈ [0, SD_MAX];
 * - per voxel: T_eff(y) = T − lapse·max(0, y − lapseBase) (`tEff`).
 * The scan reads nothing outside its column. `SurfaceScanSettings` carries what it needs from the seed and the
 * parameters (the depth noise through a SurfaceNoiseSource, `depthMul`, `lapse`, `lapseBase`), so it runs on
 * hand-built columns and noises as well as on the schema's. Follows the gen determinism rules.
 */
import { MIN_Y } from '../../core/constants';
import { deriveSeed, hash2, type Seed64 } from '../../core/hash';
import { nearestCornerIndex, readBiome, readField, type ColumnSample } from '../column/columnStage';
import type { GenContext } from '../context';
import type { SurfaceNoise, SurfaceNoiseSource } from './rules';

const Y0 = MIN_Y;
const DERIVE = deriveSeed;
const HASH2 = hash2;
const READ_FIELD = readField;
const CORNER = nearestCornerIndex;
const BIOME = readBiome;

/** 2^−32: a u32 hash times this lies in [0, 1). */
const INV_U32 = 1 / 4294967296;
/** Voxels per column (384 · 256), in the stage's order `256·(y + 64) + p`, p = lz·16 + lx. */
const COLUMN_VOXELS = 98304;
/** Most runs a position can hold: y −63 … 319 is 383 voxels, so at most 192 runs (alternating solid and not). */
const MAX_RUNS = 256 * 192;
/** waterTop of a run without water directly above it (never read: `water` holds there whatever waterTop is). */
const NO_WATER = Y0 - 1;

/** The schema path of the depth noise `Ns`. */
export const SURFACE_DEPTH_NOISE = 'surface.noises.depth';

/** The `surface` parameters the scan reads (a subset of `params.surface`). */
export interface SurfaceScanParams {
  readonly depthMul: number;
  readonly lapse: number;
  readonly lapseBase: number;
}

/** What one GenContext's scans share: the depth noise, the depth hash's seed and the parameters (with SD_MAX). */
export interface SurfaceScanSettings extends SurfaceScanParams {
  readonly depthNoise: SurfaceNoise;
  /** deriveSeed(seed, 'surface.depthHash'). */
  readonly depthHashSeed: number;
  /** ⌊3.25 + 2.75·depthMul·clampSigma⌋ of the depth noise: the largest surfaceDepth. */
  readonly sdMax: number;
}

/** One column's scan; preallocated by `newSurfaceScan`, overwritten by every `scanColumn`. */
export interface SurfaceScan {
  cx: number;
  cz: number;
  /** Position p's runs are runFirst[p] … runFirst[p + 1] − 1, top-down (the first is the sky-open run); 257 entries. */
  readonly runFirst: Int32Array;
  /** Per run: yTop, the y of its top voxel. */
  readonly runTop: Int16Array;
  /** Per run: the y of its bottom voxel (−63 for a run resting on the bedrock). */
  readonly runBottom: Int16Array;
  /** Per run: 1 when the voxel above its top holds water. */
  readonly runWaterAbove: Uint8Array;
  /** Per run: the y of the highest voxel of the contiguous water directly above its top (when runWaterAbove). */
  readonly runWaterTop: Int16Array;
  /** Per position: bilinear steep and T, the surface biome id, lakeLevel at the nearest quart corner, surfaceDepth. */
  readonly steep: Float64Array;
  readonly T: Float64Array;
  readonly biome: Uint8Array;
  readonly lakeLevel: Float64Array;
  readonly surfaceDepth: Int32Array;
}

export function newSurfaceScan(): SurfaceScan {
  return {
    cx: 0, cz: 0,
    runFirst: new Int32Array(257), runTop: new Int16Array(MAX_RUNS), runBottom: new Int16Array(MAX_RUNS),
    runWaterAbove: new Uint8Array(MAX_RUNS), runWaterTop: new Int16Array(MAX_RUNS),
    steep: new Float64Array(256), T: new Float64Array(256), biome: new Uint8Array(256), lakeLevel: new Float64Array(256),
    surfaceDepth: new Int32Array(256),
  };
}

/** The seed of hash01: deriveSeed(seed, 'surface.depthHash'). */
export function depthHashSeed(seed: Seed64): number {
  return DERIVE(seed, 'surface.depthHash');
}

/** hash01(x, z) = hash2(depthHashSeed, x, z)·2^−32 ∈ [0, 1). */
export function depthHash01(hashSeed: number, x: number, z: number): number {
  return HASH2(hashSeed, x, z) * INV_U32;
}

/** surfaceDepth = max(0, ⌊3 + 2.75·depthMul·Ns + 0.25·hash01⌋). */
export function surfaceDepthOf(ns: number, hash01: number, depthMul: number): number {
  return Math.max(0, Math.floor(3 + 2.75 * depthMul * ns + 0.25 * hash01));
}

/** SD_MAX = ⌊3.25 + 2.75·depthMul·clampSigma⌋, the largest surfaceDepth for a depth noise clamped to ±clampSigma. */
export function surfaceDepthMax(depthMul: number, clampSigma: number): number {
  return Math.floor(3.25 + 2.75 * depthMul * clampSigma);
}

/** T_eff(y) = T − lapse·max(0, y − lapseBase) (master §3.10). */
export function tEff(t: number, y: number, lapse: number, lapseBase: number): number {
  return t - lapse * Math.max(0, y - lapseBase);
}

/** The scan settings of a seed and parameters; `noises` must hold a dims-2 `surface.noises.depth` (else throws). */
export function surfaceScanSettings(seed: Seed64, params: SurfaceScanParams, noises: SurfaceNoiseSource): SurfaceScanSettings {
  const n = noises(SURFACE_DEPTH_NOISE);
  if (n === undefined) throw new Error(`surface scan: no noise ${SURFACE_DEPTH_NOISE}`);
  if (n.dims !== 2) throw new Error(`surface scan: ${SURFACE_DEPTH_NOISE} must be a 2D noise, not ${n.dims}D`);
  return {
    depthMul: params.depthMul, lapse: params.lapse, lapseBase: params.lapseBase,
    depthNoise: n, depthHashSeed: depthHashSeed(seed), sdMax: surfaceDepthMax(params.depthMul, n.clampSigma),
  };
}

/** Fills `out` (256 entries, index lz·16 + lx) with the per-block surface biome of the sample's column (`readBiome`). */
export function fillSurfaceBiomes(s: ColumnSample, ctx: GenContext, out: Uint8Array): Uint8Array {
  if (out.length !== 256) throw new RangeError(`fillSurfaceBiomes: out has ${out.length} entries, expected 256`);
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  for (let p = 0; p < 256; p++) out[p] = BIOME(s, ctx, x0 + (p & 15), z0 + (p >> 4));
  return out;
}

/**
 * Scans column (s.cx, s.cz) into `scan`. `solid` and `water` (98,304 entries each, index `256·(y + 64) + p`): a voxel
 * is solid when `solid` ≠ 0, and water when it is not solid and `water` ≠ 0; the y −64 entries are ignored.
 * `biomes` is the column's 256-entry surface biome buffer. Throws a RangeError on other sizes.
 */
export function scanColumn(
  scan: SurfaceScan, set: SurfaceScanSettings, s: ColumnSample, solid: Uint8Array, water: Uint8Array, biomes: Uint8Array,
): SurfaceScan {
  if (solid.length !== COLUMN_VOXELS || water.length !== COLUMN_VOXELS || biomes.length !== 256) {
    throw new RangeError(`scanColumn: solid ${solid.length}, water ${water.length}, biomes ${biomes.length} entries; expected ${COLUMN_VOXELS}, ${COLUMN_VOXELS}, 256`);
  }
  const { runFirst, runTop, runBottom, runWaterAbove, runWaterTop } = scan;
  scan.cx = s.cx;
  scan.cz = s.cz;
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  const noise = set.depthNoise;
  const depthMul = set.depthMul;
  const hashSeed = set.depthHashSeed;
  const lakeLevel = s.f.lakeLevel;
  let r = 0;
  for (let p = 0; p < 256; p++) {
    runFirst[p] = r;
    let inRun = false;
    let prevWater = false;
    let waterSegTop = NO_WATER;
    // yi = y + 64, from y 319 (383) down to y −63 (1).
    for (let yi = 383; yi >= 1; yi--) {
      const i = (yi << 8) | p;
      if (solid[i] !== 0) {
        if (!inRun) {
          runTop[r] = yi + Y0;
          runWaterAbove[r] = prevWater ? 1 : 0;
          runWaterTop[r] = prevWater ? waterSegTop : NO_WATER;
          inRun = true;
        }
        prevWater = false;
      } else {
        if (inRun) {
          runBottom[r] = yi + 1 + Y0;
          r++;
          inRun = false;
        }
        if (water[i] !== 0) {
          if (!prevWater) waterSegTop = yi + Y0;
          prevWater = true;
        } else {
          prevWater = false;
        }
      }
    }
    if (inRun) {
      runBottom[r] = Y0 + 1;
      r++;
    }
    const x = x0 + (p & 15);
    const z = z0 + (p >> 4);
    scan.steep[p] = READ_FIELD(s, 'steep', x, z);
    scan.T[p] = READ_FIELD(s, 'T', x, z);
    scan.biome[p] = biomes[p]!;
    scan.lakeLevel[p] = lakeLevel[CORNER(s, x, z)]!;
    scan.surfaceDepth[p] = surfaceDepthOf(noise.z2(x, z), depthHash01(hashSeed, x, z), depthMul);
  }
  runFirst[256] = r;
  return scan;
}

/** The index of the run of position p holding the solid voxel at y, or −1 (not solid, or y −64). */
export function runAt(scan: SurfaceScan, p: number, y: number): number {
  const end = scan.runFirst[p + 1]!;
  for (let r = scan.runFirst[p]!; r < end; r++) {
    if (y > scan.runTop[r]!) return -1;
    if (y >= scan.runBottom[r]!) return r;
  }
  return -1;
}

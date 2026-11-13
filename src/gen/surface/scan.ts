/**
 * The whole-column scan of the surface pass (SP3c spec §3.2). Over one column's solidity and water (the T stage's
 * density and water v0, or a hand-built column), for each of the 256 positions top-down from y 319 to y −63 (y −64 is
 * the stage's bedrock and is not scanned):
 * - runs: maximal vertical runs of solid voxels, stored top-down per position;
 * - per position: the sky-open run (`skyRun`): the first run, or, when the settings' `islandRuns` is set (the
 *   `islands.enabled` flag, SP3e spec §4.5, D21 (b)), the highest run whose bottom voxel is below
 *   `ISLAND_RUN_MIN_BOTTOM`, so the ground under a floating island keeps its palette; none (−1) when no run qualifies;
 * - per run: yTop (`runTop`), its bottom voxel (`runBottom`), `waterAbove` (the voxel above yTop holds water) and
 *   `waterTop` (the highest voxel of the contiguous water directly above yTop);
 * - per run, from the column's cave tags when given (SP6b spec §3.1, D18): `floorBiome`, the cave biome (bits 4-7) of
 *   the voxel above yTop when it is tagged (kind ≠ 0), and `ceilBiome`, the same for the voxel below the bottom voxel;
 *   −1 otherwise, so a run resting on the bedrock never has a ceiling biome;
 * - per solid voxel at y of run r: floorDepth = runTop[r] − y (0 at the run's top voxel), ceilDepth = y − runBottom[r];
 * - per position: `steep` and `T` (bilinear `readField`, as SP3b's `col`), the per-block surface biome (the stage's
 *   256-entry buffer, `fillSurfaceBiomes`), `lakeLevel` at the nearest quart corner (`readLevel`'s corner) and
 *   surfaceDepth = max(0, ⌊3 + 2.75·depthMul·Ns + 0.25·hash01⌋) ∈ [0, SD_MAX], Ns clamped to ±the depth noise's
 *   clampSigma (SP3d spec §1.10: a schema noise already is; the clamp keeps the fast-path contract for any noise);
 * - per voxel: T_eff(y) = T − lapse·max(0, y − lapseBase) (`tEff`);
 * - per position, on demand (`classifyCaveBiomes`, SP6b spec §3.5 item 4, D20): the cave biomes the picker can return
 *   at each y, from the column pass over the position's (2J + 1)² neighbourhood, as top-down y ranges.
 * The scan reads nothing outside its column. `SurfaceScanSettings` carries what it needs from the seed and the
 * parameters (the depth noise through a SurfaceNoiseSource, `depthMul`, `lapse`, `lapseBase`, `islandRuns`), so it runs on
 * hand-built columns and noises as well as on the schema's. Follows the gen determinism rules.
 */
import { caveBiomeOf, caveKindOf, ISLAND_RUN_MIN_BOTTOM, MIN_Y } from '../../core/constants';
import { deriveSeed, hash2, type Seed64 } from '../../core/hash';
import type { CaveColumnPass, CavePickerInputs } from '../biomes/cavePicker';
import { nearestCornerIndex, readBiome, readField, type ColumnSample } from '../column/columnStage';
import type { GenContext } from '../context';
import type { SurfaceNoise, SurfaceNoiseSource } from './rules';

const Y0 = MIN_Y;
const ISLAND_MIN_BOTTOM = ISLAND_RUN_MIN_BOTTOM;
const DERIVE = deriveSeed;
const HASH2 = hash2;
const READ_FIELD = readField;
const CORNER = nearestCornerIndex;
const BIOME = readBiome;
const KIND_OF = caveKindOf;
const CAVE_BIOME_OF = caveBiomeOf;

/** 2^−32: a u32 hash times this lies in [0, 1). */
const INV_U32 = 1 / 4294967296;
/** Voxels per column (384 · 256), in the stage's order `256·(y + 64) + p`, p = lz·16 + lx. */
const COLUMN_VOXELS = 98304;
/** Most runs a position can hold: y −63 … 319 is 383 voxels, so at most 192 runs (alternating solid and not). */
const MAX_RUNS = 256 * 192;
/** waterTop of a run without water directly above it (never read: `water` holds there whatever waterTop is). */
const NO_WATER = Y0 - 1;
/** A run's floor or ceiling cave biome when the voxel there is not tagged cave air (or there is no such voxel). */
const NO_CAVE_BIOME = -1;
/** Most y ranges of one position's cave-biome classification: three boxes, four range ends each, plus one. */
const MAX_CAVE_RANGES = 16;
/** The jittered heights the classification's depth thresholds are searched in: y −63 … 319 ± 4 lies inside. */
const DEPTH_LO = -68;
const DEPTH_HI = 324;
/** The classification's bit for plain (cave biome 0) and for each box's biome (1 lush, 2 dripstone, 3 abyss). */
const PLAIN_BIT = 1;
const LUSH_BIT = 2;
const DRIPSTONE_BIT = 4;
const ABYSS_BIT = 8;
/** The classification's scratch: the boxes' interval ends (sure lo, sure hi, possible lo, possible hi per box) and the cuts. */
const ENDS = new Int32Array(12);
const CUTS = new Int32Array(MAX_CAVE_RANGES);

/** The cave biome of a tag byte when its kind is not 0, else NO_CAVE_BIOME. */
function tagBiome(byte: number): number {
  return KIND_OF(byte) !== 0 ? CAVE_BIOME_OF(byte) : NO_CAVE_BIOME;
}

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
  /**
   * `islands.enabled` (SP3e spec §4.5): the sky-open run is the highest run whose bottom voxel is below
   * ISLAND_RUN_MIN_BOTTOM instead of the first.
   */
  readonly islandRuns: boolean;
}

/** One column's scan; preallocated by `newSurfaceScan`, overwritten by every `scanColumn`. */
export interface SurfaceScan {
  cx: number;
  cz: number;
  /** Position p's runs are runFirst[p] … runFirst[p + 1] − 1, top-down; 257 entries. */
  readonly runFirst: Int32Array;
  /**
   * Per position: the index of its sky-open run (the first run; with `islandRuns`, the highest whose bottom voxel is
   * below ISLAND_RUN_MIN_BOTTOM), or −1 when it has none.
   */
  readonly skyRun: Int32Array;
  /** Per run: yTop, the y of its top voxel. */
  readonly runTop: Int16Array;
  /** Per run: the y of its bottom voxel (−63 for a run resting on the bedrock). */
  readonly runBottom: Int16Array;
  /** Per run: 1 when the voxel above its top holds water. */
  readonly runWaterAbove: Uint8Array;
  /** Per run: the y of the highest voxel of the contiguous water directly above its top (when runWaterAbove). */
  readonly runWaterTop: Int16Array;
  /** Per run: the cave biome of the tagged voxel above its top, or −1 (untagged, above y 319, or no tags given). */
  readonly runFloorBiome: Int8Array;
  /** Per run: the cave biome of the tagged voxel below its bottom, or −1 (untagged, a run on the bedrock, no tags). */
  readonly runCeilBiome: Int8Array;
  /** The column's cave picker and its filled pass, for `caveBiome{here}` (SP6b spec §3.2); null when not given. */
  cavePicker: CavePickerInputs | null;
  cavePass: CaveColumnPass | null;
  /**
   * The cave-biome classification of the position `classifyCaveBiomes` last classified (SP6b spec §3.5 item 4): range i
   * holds y from `caveRangeLow[i]` up to `caveRangeLow[i − 1] − 1` (range 0 up to y 319), top-down, the last one down
   * to y −63; `caveRangeMask[i]` has bit b set for each cave biome b the picker can return at a voxel of that range.
   */
  readonly caveRangeLow: Int16Array;
  readonly caveRangeMask: Uint8Array;
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
    runFirst: new Int32Array(257), skyRun: new Int32Array(256), runTop: new Int16Array(MAX_RUNS), runBottom: new Int16Array(MAX_RUNS),
    runWaterAbove: new Uint8Array(MAX_RUNS), runWaterTop: new Int16Array(MAX_RUNS),
    runFloorBiome: new Int8Array(MAX_RUNS), runCeilBiome: new Int8Array(MAX_RUNS), cavePicker: null, cavePass: null,
    caveRangeLow: new Int16Array(MAX_CAVE_RANGES), caveRangeMask: new Uint8Array(MAX_CAVE_RANGES),
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

/**
 * The scan settings of a seed and parameters; `noises` must hold a dims-2 `surface.noises.depth` (else throws), and
 * `depthMul` must be finite and ≥ 0 (else a RangeError: SD_MAX bounds surfaceDepth only then, SP3d spec §1.10).
 * `islandRuns` is `islands.enabled` (the sky-open run under islands, SP3e spec §4.5); false by default.
 */
export function surfaceScanSettings(seed: Seed64, params: SurfaceScanParams, noises: SurfaceNoiseSource, islandRuns = false): SurfaceScanSettings {
  if (!(params.depthMul >= 0) || !Number.isFinite(params.depthMul)) {
    throw new RangeError(`surface scan: depthMul ${params.depthMul} must be finite and ≥ 0`);
  }
  const n = noises(SURFACE_DEPTH_NOISE);
  if (n === undefined) throw new Error(`surface scan: no noise ${SURFACE_DEPTH_NOISE}`);
  if (n.dims !== 2) throw new Error(`surface scan: ${SURFACE_DEPTH_NOISE} must be a 2D noise, not ${n.dims}D`);
  return {
    depthMul: params.depthMul, lapse: params.lapse, lapseBase: params.lapseBase,
    depthNoise: n, depthHashSeed: depthHashSeed(seed), sdMax: surfaceDepthMax(params.depthMul, n.clampSigma),
    islandRuns,
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
 * `biomes` is the column's 256-entry surface biome buffer. `tags` (optional, 98,304 entries in the same order) is the
 * column's `cave` bytes, from which each run's floor and ceiling cave biome are read (all −1 when null); `cave`
 * (optional) is the column's cave picker and its pass, already filled for this column, kept on the scan for
 * `caveBiome{here}`. Throws a RangeError on other sizes.
 */
export function scanColumn(
  scan: SurfaceScan, set: SurfaceScanSettings, s: ColumnSample, solid: Uint8Array, water: Uint8Array, biomes: Uint8Array,
  tags: Uint8Array | null = null, cave: { readonly inputs: CavePickerInputs; readonly pass: CaveColumnPass } | null = null,
): SurfaceScan {
  if (solid.length !== COLUMN_VOXELS || water.length !== COLUMN_VOXELS || biomes.length !== 256) {
    throw new RangeError(`scanColumn: solid ${solid.length}, water ${water.length}, biomes ${biomes.length} entries; expected ${COLUMN_VOXELS}, ${COLUMN_VOXELS}, 256`);
  }
  if (tags !== null && tags.length !== COLUMN_VOXELS) {
    throw new RangeError(`scanColumn: tags ${tags.length} entries; expected ${COLUMN_VOXELS}`);
  }
  const { runFirst, skyRun, runTop, runBottom, runWaterAbove, runWaterTop, runFloorBiome, runCeilBiome } = scan;
  const islandRuns = set.islandRuns;
  scan.cx = s.cx;
  scan.cz = s.cz;
  scan.cavePicker = cave === null ? null : cave.inputs;
  scan.cavePass = cave === null ? null : cave.pass;
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  const noise = set.depthNoise;
  const clamp = noise.clampSigma;
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
          // The voxel above yTop (none above y 319).
          runFloorBiome[r] = tags === null || yi === 383 ? NO_CAVE_BIOME : tagBiome(tags[i + 256]!);
          inRun = true;
        }
        prevWater = false;
      } else {
        if (inRun) {
          runBottom[r] = yi + 1 + Y0;
          // The voxel below the run's bottom voxel.
          runCeilBiome[r] = tags === null ? NO_CAVE_BIOME : tagBiome(tags[i]!);
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
      runCeilBiome[r] = NO_CAVE_BIOME;
      r++;
    }
    const first = runFirst[p]!;
    if (!islandRuns) {
      skyRun[p] = first < r ? first : -1;
    } else {
      // The highest run reaching below ISLAND_RUN_MIN_BOTTOM: the runs are top-down.
      let k = first;
      while (k < r && runBottom[k]! >= ISLAND_MIN_BOTTOM) k++;
      skyRun[p] = k < r ? k : -1;
    }
    const x = x0 + (p & 15);
    const z = z0 + (p >> 4);
    scan.steep[p] = READ_FIELD(s, 'steep', x, z);
    scan.T[p] = READ_FIELD(s, 'T', x, z);
    scan.biome[p] = biomes[p]!;
    scan.lakeLevel[p] = lakeLevel[CORNER(s, x, z)]!;
    const ns = noise.z2(x, z);
    scan.surfaceDepth[p] = surfaceDepthOf(ns < -clamp ? -clamp : ns > clamp ? clamp : ns, depthHash01(hashSeed, x, z), depthMul);
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

/** The largest integer y′ in DEPTH_LO … DEPTH_HI with (y0 − y′) / d ≥ depth (the picker's expression), DEPTH_LO − 1 if none. */
function lastAtLeast(y0: number, d: number, depth: number): number {
  let t = Math.floor(y0 - d * depth);
  if (!(t >= DEPTH_LO)) t = DEPTH_LO;
  else if (t > DEPTH_HI) t = DEPTH_HI;
  // (y0 − y′) / d is non-increasing in y′ in floating point too (rounding is monotone): step to the last y′ that holds.
  while (t < DEPTH_HI && (y0 - (t + 1)) / d >= depth) t++;
  while (t >= DEPTH_LO && !((y0 - t) / d >= depth)) t--;
  return t;
}

/** The smallest integer y′ in DEPTH_LO … DEPTH_HI with (y0 − y′) / d ≤ depth, DEPTH_HI + 1 if none. */
function firstAtMost(y0: number, d: number, depth: number): number {
  let t = Math.ceil(y0 - d * depth);
  if (!(t <= DEPTH_HI)) t = DEPTH_HI;
  else if (t < DEPTH_LO) t = DEPTH_LO;
  while (t > DEPTH_LO && (y0 - (t - 1)) / d <= depth) t--;
  while (t <= DEPTH_HI && !((y0 - t) / d <= depth)) t++;
  return t;
}

/** The classification's cave biomes at y from the boxes' interval ends in ENDS (box k at 4k: sure lo, hi; possible lo, hi). */
function caveMaskAt(y: number): number {
  const sure = (y >= ENDS[0]! && y <= ENDS[1]!) || (y >= ENDS[4]! && y <= ENDS[5]!) || (y >= ENDS[8]! && y <= ENDS[9]!);
  return (sure ? 0 : PLAIN_BIT)
    | (y >= ENDS[2]! && y <= ENDS[3]! ? LUSH_BIT : 0)
    | (y >= ENDS[6]! && y <= ENDS[7]! ? DRIPSTONE_BIT : 0)
    | (y >= ENDS[10]! && y <= ENDS[11]! ? ABYSS_BIT : 0);
}

/** Inserts the cut y (a range starts at y) into CUTS[0 … n − 1], top-down without repeats, when inside −62 … 319. */
function addCut(n: number, y: number): number {
  if (y <= Y0 + 1 || y > 319) return n;
  let i = 0;
  while (i < n && CUTS[i]! > y) i++;
  if (i < n && CUTS[i] === y) return n;
  for (let k = n; k > i; k--) CUTS[k] = CUTS[k - 1]!;
  CUTS[i] = y;
  return n + 1;
}

/**
 * The cave-biome classification of position p of the column last scanned into `scan` (SP6b spec §3.5 item 4, D20), from
 * its picker and pass (0 ranges when the scan has none), into `caveRangeLow` / `caveRangeMask`; returns the number of
 * ranges. Over the pass's (2J + 1)² positions around p (J the pass's `j`), each box's climate test (§1.3: H′ ≥ hMin;
 * C′ ≥ cMin; E′ ≤ eMax and C′ > cMin) is surely true (at all of them), surely false (at none) or mixed, and its depth
 * tests hold surely for the voxels y whose every jittered height y + jy, jy in −J … J, passes them at every Y0 of the
 * neighbourhood, possibly for those where one may: the thresholds are found with the picker's own expression
 * (Y0 − y′) / D at the extreme Y0s, monotone in y′ and Y0. A box is surely true at y when its climate test and its depth
 * tests are, possibly true when neither is surely false. The mask at y holds each box's biome that is possibly true,
 * and plain unless a box is surely true: the picker's choice at every voxel of the range is one of them (one bit: the
 * range is surely that biome; the margin rule decides only between the bits). Allocates nothing.
 */
export function classifyCaveBiomes(scan: SurfaceScan, p: number): number {
  const inp = scan.cavePicker;
  const pass = scan.cavePass;
  if (inp === null || pass === null) return 0;
  const st = inp.settings;
  const j = pass.j;
  const lush = st.lush;
  const drip = st.dripstone;
  const abyss = st.abyss;
  const hMin = lush.hMin;
  const cMin = drip.cMin;
  const eMax = abyss.eMax;
  const aMin = abyss.cMin;
  let lushAll = true, lushAny = false, dripAll = true, dripAny = false, abyssAll = true, abyssAny = false;
  let y0Min = Infinity, y0Max = -Infinity;
  const pc = pass.c, pe = pass.e, ph = pass.h, py = pass.y0;
  const lx = p & 15;
  const lz = p >> 4;
  for (let dz = -j; dz <= j; dz++) {
    const row = (lz + 4 + dz) * 24 + lx + 4;
    for (let dx = -j; dx <= j; dx++) {
      const k = row + dx;
      const c = pc[k]!;
      // §1.3's climate tests, as pickCaveBiome writes them.
      const l = ph[k]! >= hMin;
      const dr = c >= cMin;
      const a = pe[k]! <= eMax && c > aMin;
      lushAll = lushAll && l;
      lushAny = lushAny || l;
      dripAll = dripAll && dr;
      dripAny = dripAny || dr;
      abyssAll = abyssAll && a;
      abyssAny = abyssAny || a;
      const y0 = py[k]!;
      if (y0 < y0Min) y0Min = y0;
      if (y0 > y0Max) y0Max = y0;
    }
  }
  const d = st.depthScale;
  // Box k's ends at 4k: surely true from ENDS[4k] to ENDS[4k + 1], possibly true from ENDS[4k + 2] to ENDS[4k + 3]
  // (empty when lo > hi). depth ≥ min holds at y′ ≤ lastAtLeast, depth ≤ max at y′ ≥ firstAtMost; both thresholds rise
  // with Y0, so the neighbourhood's extreme Y0s bound them; ±J covers the jittered height.
  ENDS[0] = lushAll ? firstAtMost(y0Max, d, lush.depthMax) + j : 1;
  ENDS[1] = lushAll ? lastAtLeast(y0Min, d, lush.depthMin) - j : 0;
  ENDS[2] = lushAny ? firstAtMost(y0Min, d, lush.depthMax) - j : 1;
  ENDS[3] = lushAny ? lastAtLeast(y0Max, d, lush.depthMin) + j : 0;
  ENDS[4] = dripAll ? firstAtMost(y0Max, d, drip.depthMax) + j : 1;
  ENDS[5] = dripAll ? lastAtLeast(y0Min, d, drip.depthMin) - j : 0;
  ENDS[6] = dripAny ? firstAtMost(y0Min, d, drip.depthMax) - j : 1;
  ENDS[7] = dripAny ? lastAtLeast(y0Max, d, drip.depthMin) + j : 0;
  ENDS[8] = abyssAll ? DEPTH_LO - j : 1;
  ENDS[9] = abyssAll ? lastAtLeast(y0Min, d, abyss.depthMin) - j : 0;
  ENDS[10] = abyssAny ? DEPTH_LO - j : 1;
  ENDS[11] = abyssAny ? lastAtLeast(y0Max, d, abyss.depthMin) + j : 0;
  // The cuts: where a non-empty interval starts and one past where it ends.
  let n = 0;
  for (let o = 0; o < 12; o += 2) {
    if (ENDS[o]! > ENDS[o + 1]!) continue;
    n = addCut(n, ENDS[o]!);
    n = addCut(n, ENDS[o + 1]! + 1);
  }
  const low = scan.caveRangeLow;
  const mask = scan.caveRangeMask;
  let r = 0;
  for (let i = 0; i <= n; i++) {
    const lo = i < n ? CUTS[i]! : Y0 + 1;
    const m = caveMaskAt(lo);
    // Adjacent ranges with one mask are one range.
    if (r > 0 && mask[r - 1] === m) {
      low[r - 1] = lo;
    } else {
      low[r] = lo;
      mask[r] = m;
      r++;
    }
  }
  return r;
}

/**
 * The aquifer (SP7a spec §1.1-§1.8, D18-D20; master §3.9): the cell grid, the jittered centres and each cell's status,
 * a level and a fluid type; the voxel rule and the column step T runs; the point functions.
 * - **Cells.** 16 × 12 × 16 blocks on a grid offset by (5, 1, 5): a voxel's cell is (i, j, k) = (⌊(x − 5)/16⌋,
 *   ⌊(y + 1)/12⌋, ⌊(z − 5)/16⌋), and its 12 candidates are i … i + 1, j − 1 … j + 1, k … k + 1, enumerated i outer, j,
 *   k inner (`cellCandidates`); a tie between equal squared distances goes to the lower index in that order. A cell's
 *   centre is its corner (16i, 12j, 16k) jittered by (h mod 10, (h >>> 8) mod 9, (h >>> 16) mod 10), h =
 *   `hash3(deriveSeed(seed, 'aquifer.cell'), i, j, k) >>> 0` (Spec correction 3).
 * - **Statuses** (`statusOf`, packed `type << 16 | (level + 32768)`, `AQUIFER_EMPTY` for level −∞). Near the surface
 *   (centre.y ≥ offset − `surfaceBand`, the 2D `offset` and `surfaceWaterLevel` at the cell's un-jittered grid column
 *   (16i, 16k), D18) the cell takes ⌊`surfaceWaterLevel`⌋ water (63 under sea or river, Lw under a lake, empty on
 *   land). Otherwise, with the ocean factor t = clamp((63 − offset)/8, 0, 1): fully flooded (63, water) when Nf >
 *   lerp(fullInland, fullOcean, t); partially flooded when Nf > lerp(partialInland, partialOcean, t), at level
 *   ⌊centre.y/40⌋·40 + 20 + 3·round(Nspread·10/3), lava when that level ≤ `lavaMaxLevel` and |Nlava| > `lavaThreshold`;
 *   else empty. Nf, Nspread and Nlava are clamped to [−1, 1]; Nf is read at (cx, 0.67·cy, cz), Nspread at (cx,
 *   0.714·cy, cz), Nlava at the corner of the centre's 64 × 40 × 64 block (**MC (memory)**).
 * - **The voxel rule** (`voxelRule`, §1.4-§1.6). A tagged non-solid voxel reads its two nearest centres among the 12
 *   candidates (squared distances d1 ≤ d2, statuses s1, s2). Inside the abyss (its own nibble 3) a water status reads
 *   as empty. When s1 ≠ s2 and d2 − d1 < `barrierBand`, the voxel is a barrier (rock) when similarity·2·(Nb + p) > 0,
 *   similarity = 1 − (d2 − d1)/`barrierBand`, p = `pressure(y, s1, s2)`, Nb the barrier noise at (x, 0.5·y, z) read only
 *   while −2 ≤ p ≤ 2 (**MC (memory)**). Otherwise s1's fluid fills at y ≤ its level (Spec correction 7: a level is the
 *   highest fluid y), water becoming barrier rock in the abyss's margin (`inAbyssMargin`); an empty voxel below
 *   `lavaLevel` is a lava source.
 * - **The column step** (`aquiferColumn`, §1.7-§1.8, D19): untagged air takes water at y ≤ ⌊`surfaceWaterLevel`⌋ at the
 *   nearest quart corner; tagged air the voxel rule, over a per-job status cache of 3 × 35 × 3 cells (Spec correction 14).
 *   Its fast path skips a voxel more than 4 blocks above every level of its 12 candidates (beyond the pressure's reach,
 *   so no barrier and no fluid) when none of them is lava and the voxel is not below `lavaLevel`.
 * - **The point functions** (`fluidAt`, `barrierAt`; D19, D20): the column step's decision at one voxel, from the
 *   density probe's solidity, `caveTagAt` and `caveBiomeAt` in place of T's arrays and the column sample through the
 *   DensityContext's cache; neither rule reads the column's `top`, so they equal T at every voxel (DT2). They keep one
 *   status cache and one cave-biome pass, for the column last asked (`terrainSolidAt`, `solidAt.ts`, builds on them).
 * Follows the gen determinism rules: every value in world coordinates, one fixed operation order.
 */
import {
  AQUIFER_BARRIER, AQUIFER_CELL_XZ, AQUIFER_CELL_Y, AQUIFER_EMPTY, AQUIFER_EMPTY_LEVEL, AQUIFER_JITTER_XZ, AQUIFER_JITTER_Y,
  AQUIFER_LAVA_BLOCK_XZ, AQUIFER_LAVA_BLOCK_Y, AQUIFER_OFFSET_XZ, AQUIFER_OFFSET_Y, CAVE_BIOME, MIN_Y, SEA_LEVEL,
} from '../../core/constants';
import { deriveSeed, hash3 } from '../../core/hash';
import { NormalNoise } from '../../core/noise/normal';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import type { NoiseDef } from '../../core/noise/types';
import { FLUID_LAVA, FLUID_WATER, LAVA_SOURCE, WATER_SOURCE } from '../../world/blocks/fluid';
import {
  caveBiomeAt, cavePickerOf, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs,
} from '../biomes/cavePicker';
import { caveTagAt } from '../caves/tags';
import { newPointRecord, samplePoint } from '../column/columnPoint';
import { readLevel, type ColumnSample } from '../column/columnStage';
import type { GenContext } from '../context';
import type { DensityContext } from '../density/context';
import { solidAt } from '../density/probe';

const CELL_XZ = AQUIFER_CELL_XZ;
const CELL_Y = AQUIFER_CELL_Y;
const OFFSET_XZ = AQUIFER_OFFSET_XZ;
const OFFSET_Y = AQUIFER_OFFSET_Y;
const JITTER_XZ = AQUIFER_JITTER_XZ;
const JITTER_Y = AQUIFER_JITTER_Y;
const LAVA_XZ = AQUIFER_LAVA_BLOCK_XZ;
const LAVA_Y = AQUIFER_LAVA_BLOCK_Y;
const EMPTY = AQUIFER_EMPTY;
const SEA = SEA_LEVEL;
const WATER = FLUID_WATER;
const LAVA = FLUID_LAVA;
const HASH3 = hash3;
const DERIVE = deriveSeed;
const Normal = NormalNoise;
const NEW_RECORD = newPointRecord;
const SAMPLE = samplePoint;
const FLOOR = Math.floor;
const ROUND = Math.round;
const ABS = Math.abs;
const BARRIER = AQUIFER_BARRIER;
const EMPTY_LEVEL = AQUIFER_EMPTY_LEVEL;
const BIOME = CAVE_BIOME;
const ABYSS = BIOME.abyss;
const Y0 = MIN_Y;
const WATER_SRC = WATER_SOURCE;
const LAVA_SRC = LAVA_SOURCE;
const LEVEL = readLevel;
const SOLID_AT = solidAt;
const TAG_AT = caveTagAt;
const BIOME_AT = caveBiomeAt;
const PICKER_OF = cavePickerOf;
const FILL_PASS = fillCaveColumnPass;
const NEW_PASS = newCaveColumnPass;

/** The ocean factor's span: t = clamp((63 − offset)/8, 0, 1). */
const OCEAN_SPAN = 8;
/** A partial level's band (40 blocks) and its middle (+20). */
const BAND = 40;
const BAND_MID = 20;
/** The vertical scales of the floodedness and spread reads (**MC (memory)**). */
const FLOOD_Y = 0.67;
const SPREAD_Y = 0.714;
/** The packed status's level bias: level + 32768 fills the low 16 bits. */
const LEVEL_BIAS = 32768;

/** The aquifer's leaves but the noises (§1.9); Task 13 reads them from `ctx.params.aquifer`. */
export interface AquiferSettings {
  enabled: boolean;
  surfaceBand: number;
  thresholds: { fullInland: number; fullOcean: number; partialInland: number; partialOcean: number };
  lavaMaxLevel: number;
  lavaThreshold: number;
  lavaLevel: number;
  barrierBand: number;
  abyssMargin: number;
}

/** What the aquifer reads, prepared once per (seed, params): the settings, the cell seed and the four noises. */
export interface AquiferInputs {
  readonly ctx: GenContext;
  readonly settings: AquiferSettings;
  readonly cellSeed: number;
  readonly floodedness: NormalNoiseT;
  readonly spread: NormalNoiseT;
  readonly lava: NormalNoiseT;
  readonly barrier: NormalNoiseT;
}

/**
 * The aquifer's inputs for a context (no memo; Task 13's `aquiferOf(ctx)` memoises it). The noises are seeded by their
 * schema paths `aquifer.noises.<name>`, which Task 13's schema instances use, so the switch changes no value (rulings P4).
 */
export function aquiferInputs(
  ctx: GenContext, settings: AquiferSettings, noises: { floodedness: NoiseDef; spread: NoiseDef; lava: NoiseDef; barrier: NoiseDef },
): AquiferInputs {
  return {
    ctx,
    settings,
    cellSeed: DERIVE(ctx.seed, 'aquifer.cell'),
    floodedness: new Normal(ctx.seed, 'aquifer.noises.floodedness', noises.floodedness),
    spread: new Normal(ctx.seed, 'aquifer.noises.spread', noises.spread),
    lava: new Normal(ctx.seed, 'aquifer.noises.lava', noises.lava),
    barrier: new Normal(ctx.seed, 'aquifer.noises.barrier', noises.barrier),
  };
}

/** The cell (i, j, k) holding voxel (x, y, z): i = ⌊(x − 5)/16⌋, j = ⌊(y + 1)/12⌋, k = ⌊(z − 5)/16⌋. */
export function cellOf(x: number, y: number, z: number, out: Int32Array): void {
  out[0] = FLOOR((x - OFFSET_XZ) / CELL_XZ);
  out[1] = FLOOR((y + OFFSET_Y) / CELL_Y);
  out[2] = FLOOR((z - OFFSET_XZ) / CELL_XZ);
}

const CELL = new Int32Array(3);

/**
 * The 12 candidate cells of voxel (x, y, z) as (i, j, k) triples in `out` (36 ints): i … i + 1, j − 1 … j + 1,
 * k … k + 1 around `cellOf`'s cell, enumerated i outer, j, k inner; the index a tie between equal distances goes to.
 */
export function cellCandidates(x: number, y: number, z: number, out: Int32Array): void {
  cellOf(x, y, z, CELL);
  const i0 = CELL[0]!;
  const j0 = CELL[1]!;
  const k0 = CELL[2]!;
  let n = 0;
  for (let di = 0; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let dk = 0; dk <= 1; dk++) {
        out[n] = i0 + di;
        out[n + 1] = j0 + dj;
        out[n + 2] = k0 + dk;
        n += 3;
      }
    }
  }
}

/** The jittered centre of cell (i, j, k) into `out` = [cx, cy, cz] (Spec correction 3's `hash3`). */
export function cellCentre(inp: AquiferInputs, i: number, j: number, k: number, out: Int32Array): void {
  const h = HASH3(inp.cellSeed, i, j, k) >>> 0;
  out[0] = i * CELL_XZ + (h % JITTER_XZ);
  out[1] = j * CELL_Y + ((h >>> 8) % JITTER_Y);
  out[2] = k * CELL_XZ + ((h >>> 16) % JITTER_XZ);
}

const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const pack = (type: number, level: number): number => (type << 16) | (level + LEVEL_BIAS);
/** §1.2's test: the cell's centre lies within `surfaceBand` blocks below its grid column's `offset`, or above it. */
const nearSurface = (st: AquiferSettings, centreY: number, offset: number): boolean => centreY >= offset - st.surfaceBand;

function oceanFactor(offset: number): number {
  const t = (SEA - offset) / OCEAN_SPAN;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** The pure status decision of §1.2-§1.4 on a cell's sampled values (see the header). */
export function statusOf(
  st: AquiferSettings, centreY: number, offset: number, surfaceWaterLevel: number, nf: number, ns: number, nlava: number,
): number {
  if (nearSurface(st, centreY, offset)) return surfaceWaterLevel === -Infinity ? EMPTY : pack(WATER, FLOOR(surfaceWaterLevel));
  const th = st.thresholds;
  const t = oceanFactor(offset);
  const f = clamp1(nf);
  if (f > lerp(th.fullInland, th.fullOcean, t)) return pack(WATER, SEA);
  if (!(f > lerp(th.partialInland, th.partialOcean, t))) return EMPTY;
  const level = FLOOR(centreY / BAND) * BAND + BAND_MID + 3 * ROUND((clamp1(ns) * 10) / 3);
  return pack(level <= st.lavaMaxLevel && ABS(clamp1(nlava)) > st.lavaThreshold ? LAVA : WATER, level);
}

/**
 * Which branch of `statusOf` decides, by the same tests: 0 empty, 1 near-surface (whatever its level, −∞ included),
 * 2 fully flooded, 3 partially flooded (water or lava). A packed status alone cannot tell them apart. `surfaceWaterLevel`
 * is not read (no branch's kind depends on it); it keeps the signature `statusOf`'s.
 */
export function cellKindOf(st: AquiferSettings, centreY: number, offset: number, surfaceWaterLevel: number, nf: number): number {
  if (nearSurface(st, centreY, offset)) return 1;
  const th = st.thresholds;
  const t = oceanFactor(offset);
  const f = clamp1(nf);
  if (f > lerp(th.fullInland, th.fullOcean, t)) return 2;
  return f > lerp(th.partialInland, th.partialOcean, t) ? 3 : 0;
}

const REC = NEW_RECORD();
const CENTRE = new Int32Array(3);

/**
 * The status of cell (i, j, k): `samplePoint` at its grid column (16i, 16k), its jittered centre, then, unless the cell
 * is near the surface (which reads no noise), Nf, Nspread and Nlava (see the header), then `statusOf`. `kindOut[0]`,
 * when given, receives `cellKindOf` on the same sampled values.
 */
export function cellStatus(inp: AquiferInputs, i: number, j: number, k: number, kindOut?: Int32Array): number {
  const p = SAMPLE(inp.ctx, i * CELL_XZ, k * CELL_XZ, false, REC);
  return statusAtPoint(inp, i, j, k, p.offset, p.surfaceWaterLevel, kindOut);
}

/** `cellStatus` on its grid column's sampled `offset` and `surfaceWaterLevel` (the column step samples each once). */
function statusAtPoint(inp: AquiferInputs, i: number, j: number, k: number, offset: number, level: number, kindOut?: Int32Array): number {
  const st = inp.settings;
  cellCentre(inp, i, j, k, CENTRE);
  const cx = CENTRE[0]!;
  const cy = CENTRE[1]!;
  const cz = CENTRE[2]!;
  let nf = 0;
  let ns = 0;
  let nlava = 0;
  if (!nearSurface(st, cy, offset)) {
    nf = inp.floodedness.z3(cx, FLOOD_Y * cy, cz);
    ns = inp.spread.z3(cx, SPREAD_Y * cy, cz);
    nlava = inp.lava.z3(FLOOR(cx / LAVA_XZ) * LAVA_XZ, FLOOR(cy / LAVA_Y) * LAVA_Y, FLOOR(cz / LAVA_XZ) * LAVA_XZ);
  }
  if (kindOut !== undefined) kindOut[0] = cellKindOf(st, cy, offset, level, nf);
  return statusOf(st, cy, offset, level, nf, ns, nlava);
}

/** The barrier noise's vertical scale: Nb is read at (x, 0.5·y, z) (**MC (memory)**). */
const BARRIER_Y = 0.5;
/** The abyss margin's depth part (§1.6, master :760): depth > `depthMin` − 0.1. */
const ABYSS_DEPTH_MARGIN = 0.1;
/** The fast path's reach above a neighbourhood's highest level: the pressure is below −2 from level + 4.5 up. */
const FAST_REACH = 4;

const typeOfStatus = (s: number): number => s >>> 16;
/** A status's level, an empty status counting as `AQUIFER_EMPTY_LEVEL` (the pressure's finite −∞). */
const levelOfStatus = (s: number): number => (s === EMPTY ? EMPTY_LEVEL : (s & 0xffff) - LEVEL_BIAS);
/** Whether one status is water and the other lava with both holding fluid at y (fluid at y ≤ level). */
const fluidContact = (y: number, s1: number, s2: number): boolean => {
  const t1 = typeOfStatus(s1);
  const t2 = typeOfStatus(s2);
  return t1 !== 0 && t2 !== 0 && t1 !== t2 && y <= levelOfStatus(s1) && y <= levelOfStatus(s2);
};

/**
 * The barrier pressure at height y between statuses s1 and s2 (**MC (memory)**): 2 when one is water and the other lava
 * and both hold fluid at y; else, with L1, L2 their levels (`AQUIFER_EMPTY_LEVEL` for an empty status), dl = |L1 − L2|
 * (0 when equal), e = y + 0.5 − (L1 + L2)/2 and o = dl/2 − |e|: for e > 0, o/1.5 when o > 0, else o/2.5; for e ≤ 0,
 * with q = 3 + o, q/3 when q > 0, else q/10.
 */
export function pressure(y: number, s1: number, s2: number): number {
  if (fluidContact(y, s1, s2)) return 2;
  const l1 = levelOfStatus(s1);
  const l2 = levelOfStatus(s2);
  const dl = ABS(l1 - l2);
  if (dl === 0) return 0;
  const e = y + 0.5 - (l1 + l2) / 2;
  const o = dl / 2 - ABS(e);
  if (e > 0) return o > 0 ? o / 1.5 : o / 2.5;
  const q = 3 + o;
  return q > 0 ? q / 3 : q / 10;
}

/**
 * The rule's body (see `voxelRule`), reading the barrier noise from `noise` at (x, 0.5·y, z) when given, else taking
 * `nb`; either is read only where it decides (s1 ≠ s2, d2 − d1 < `barrierBand`, no fluid contact, −2 ≤ p ≤ 2).
 */
function ruleOf(
  st: AquiferSettings, y: number, d1: number, s1: number, d2: number, s2: number, nb: number, abyss: boolean, margin: boolean,
  noise: NormalNoiseT | null, x: number, z: number,
): number {
  if (abyss) {
    if (typeOfStatus(s1) === WATER) s1 = EMPTY;
    if (typeOfStatus(s2) === WATER) s2 = EMPTY;
  }
  const band = st.barrierBand;
  if (s1 !== s2 && d2 - d1 < band) {
    const similarity = 1 - (d2 - d1) / band;
    const p = pressure(y, s1, s2);
    let n = 0;
    if (p >= -2 && p <= 2 && !fluidContact(y, s1, s2)) n = noise === null ? nb : noise.z3(x, BARRIER_Y * y, z);
    if (similarity * 2 * (n + p) > 0) return BARRIER;
  }
  const t = typeOfStatus(s1);
  if (t !== 0 && y <= levelOfStatus(s1)) return t === WATER ? (margin ? BARRIER : WATER_SRC) : LAVA_SRC;
  return y < st.lavaLevel ? LAVA_SRC : 0;
}

/**
 * The aquifer's decision at a tagged non-solid voxel at height y (§1.4-§1.6, D20), from its two nearest centres
 * (squared distances d1 ≤ d2, statuses s1, s2), the barrier noise nb there, whether its own nibble is the abyss and
 * whether it lies in the abyss's margin: a water status reads as empty where `abyss`; when s1 ≠ s2 and d2 − d1 <
 * `barrierBand`, `AQUIFER_BARRIER` when similarity·2·(nb + p) > 0 (similarity = 1 − (d2 − d1)/`barrierBand`, p =
 * `pressure(y, s1, s2)`, nb counted only while −2 ≤ p ≤ 2 and the statuses are not water and lava both fluid at y);
 * otherwise s1's fluid source at y ≤ its level (Spec correction 7), water becoming `AQUIFER_BARRIER` where `margin`;
 * else a lava source below `lavaLevel`, 0 above. Returns a fluid byte, 0 or `AQUIFER_BARRIER`.
 */
export function voxelRule(
  st: AquiferSettings, y: number, d1: number, s1: number, d2: number, s2: number, nb: number, abyss: boolean, margin: boolean,
): number {
  return ruleOf(st, y, d1, s1, d2, s2, nb, abyss, margin, null, 0, 0);
}

/**
 * Whether voxel (x, y, z) of the pass's column lies in the abyss box widened on every side (§1.6), from the pass's
 * unjittered C′, E′ and Y0 at (x, z): E′ ≤ `eMax` + m, C′ > `cMin` − m and depth = (Y0 − y)/`depthScale` > `depthMin` −
 * 0.1, m = `abyssMargin`. The caller tests the voxel's own nibble first (the margin is for voxels outside the abyss).
 */
export function inAbyssMargin(inp: AquiferInputs, pick: CavePickerInputs, pass: CaveColumnPass, x: number, y: number, z: number): boolean {
  const b = pick.settings;
  const a = b.abyss;
  const m = inp.settings.abyssMargin;
  const k = (z - 16 * pass.cz + 4) * 24 + (x - 16 * pass.cx + 4);
  const depth = (pass.y0[k]! - y) / b.depthScale;
  return pass.e[k]! <= a.eMax + m && pass.c[k]! > a.cMin - m && depth > a.depthMin - ABYSS_DEPTH_MARGIN;
}

/** The status cache's rows: j −7 … 27 (Spec correction 14), and its neighbourhoods' rows j −6 … 26. */
const ROWS = 35;
const J_MIN = -7;
const HOOD_ROWS = 33;
const HOOD_J_MIN = -6;
const CACHE_CELLS = 3 * ROWS * 3;
const HOODS = 2 * HOOD_ROWS * 2;

/**
 * The status cache of one T job (§1.8, Spec correction 14): the 3 × 35 × 3 cells i cx − 1 … cx + 1, j −7 … 27,
 * k cz − 1 … cz + 1 that a column's candidates reach (entry ((i − cx + 1)·35 + j + 7)·3 + k − cz + 1), each status and
 * centre filled on first use; and each neighbourhood's (the 12 candidates of a base cell i0 cx − 1 … cx, j0 −6 … 26,
 * k0 cz − 1 … cz; entry ((i0 − cx + 1)·33 + j0 + 6)·2 + k0 − cz + 1) highest level and whether one of its cells is lava;
 * and the 9 grid columns' (16i, 16k) `offset` and `surfaceWaterLevel` (entry (i − cx + 1)·3 + k − cz + 1, D18's 9
 * `samplePoint` calls per T column). `aquiferColumn` resets it for its column.
 */
export interface AquiferScratch {
  cx: number;
  cz: number;
  readonly filled: Uint8Array;
  readonly status: Int32Array;
  readonly centre: Int32Array;
  readonly hoodFilled: Uint8Array;
  readonly hoodMax: Int32Array;
  readonly hoodLava: Uint8Array;
  readonly pointFilled: Uint8Array;
  readonly pointOffset: Float64Array;
  readonly pointLevel: Float64Array;
}

export function createAquiferScratch(): AquiferScratch {
  return {
    cx: 0, cz: 0,
    filled: new Uint8Array(CACHE_CELLS), status: new Int32Array(CACHE_CELLS), centre: new Int32Array(3 * CACHE_CELLS),
    hoodFilled: new Uint8Array(HOODS), hoodMax: new Int32Array(HOODS), hoodLava: new Uint8Array(HOODS),
    pointFilled: new Uint8Array(9), pointOffset: new Float64Array(9), pointLevel: new Float64Array(9),
  };
}

const CACHE_CENTRE = new Int32Array(3);

/** The cache entry of cell (i, j, k), its status and centre filled on first use. */
function cachedCell(inp: AquiferInputs, sc: AquiferScratch, i: number, j: number, k: number): number {
  const e = ((i - sc.cx + 1) * ROWS + j - J_MIN) * 3 + k - sc.cz + 1;
  if (sc.filled[e] === 0) {
    const g = (i - sc.cx + 1) * 3 + k - sc.cz + 1;
    if (sc.pointFilled[g] === 0) {
      const p = SAMPLE(inp.ctx, i * CELL_XZ, k * CELL_XZ, false, REC);
      sc.pointOffset[g] = p.offset;
      sc.pointLevel[g] = p.surfaceWaterLevel;
      sc.pointFilled[g] = 1;
    }
    sc.status[e] = statusAtPoint(inp, i, j, k, sc.pointOffset[g]!, sc.pointLevel[g]!);
    cellCentre(inp, i, j, k, CACHE_CENTRE);
    sc.centre[3 * e] = CACHE_CENTRE[0]!;
    sc.centre[3 * e + 1] = CACHE_CENTRE[1]!;
    sc.centre[3 * e + 2] = CACHE_CENTRE[2]!;
    sc.filled[e] = 1;
  }
  return e;
}

/** The neighbourhood entry of base cell (i0, j0, k0), its highest level and lava flag filled on first use. */
function cachedHood(inp: AquiferInputs, sc: AquiferScratch, i0: number, j0: number, k0: number): number {
  const h = ((i0 - sc.cx + 1) * HOOD_ROWS + j0 - HOOD_J_MIN) * 2 + k0 - sc.cz + 1;
  if (sc.hoodFilled[h] === 0) {
    let max = EMPTY_LEVEL;
    let lava = 0;
    for (let di = 0; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = 0; dk <= 1; dk++) {
          const s = sc.status[cachedCell(inp, sc, i0 + di, j0 + dj, k0 + dk)]!;
          const l = levelOfStatus(s);
          if (l > max) max = l;
          if (typeOfStatus(s) === LAVA) lava = 1;
        }
      }
    }
    sc.hoodMax[h] = max;
    sc.hoodLava[h] = lava;
    sc.hoodFilled[h] = 1;
  }
  return h;
}

/** `sc` emptied for column (cx, cz). */
function resetScratch(sc: AquiferScratch, cx: number, cz: number): void {
  sc.cx = cx;
  sc.cz = cz;
  sc.filled.fill(0);
  sc.hoodFilled.fill(0);
  sc.pointFilled.fill(0);
}

/** `nearestTwo`'s result: the two nearest squared distances d1 ≤ d2 and their statuses s1, s2. */
let N_D1 = 0;
let N_D2 = 0;
let N_S1 = EMPTY;
let N_S2 = EMPTY;

/**
 * The two nearest centres of voxel (x, y, z) of `sc`'s column among its 12 candidates (base cell (i0, j0, k0) =
 * `cellOf`'s), into `N_D1`, `N_S1`, `N_D2`, `N_S2`; a tie goes to the lower candidate index (`cellCandidates`' order).
 * The one selection of the column step and the point functions.
 */
function nearestTwo(inp: AquiferInputs, sc: AquiferScratch, x: number, y: number, z: number, i0: number, j0: number, k0: number): void {
  const centre = sc.centre;
  const status = sc.status;
  let d1 = Infinity;
  let d2 = Infinity;
  let s1 = EMPTY;
  let s2 = EMPTY;
  for (let di = 0; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let dk = 0; dk <= 1; dk++) {
        const e = cachedCell(inp, sc, i0 + di, j0 + dj, k0 + dk);
        const dx = x - centre[3 * e]!;
        const dy = y - centre[3 * e + 1]!;
        const dz = z - centre[3 * e + 2]!;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < d1) {
          d2 = d1;
          s2 = s1;
          d1 = d;
          s1 = status[e]!;
        } else if (d < d2) {
          d2 = d;
          s2 = status[e]!;
        }
      }
    }
  }
  N_D1 = d1;
  N_D2 = d2;
  N_S1 = s1;
  N_S2 = s2;
}

/** Whether the abyss margin can decide at height y: outside the abyss, where s1's water would fill (y ≤ its level). */
const marginDecides = (y: number, s1: number, abyss: boolean): boolean => !abyss && typeOfStatus(s1) === WATER && y <= levelOfStatus(s1);

/** Each position's ⌊`surfaceWaterLevel`⌋ at its nearest quart corner (−∞ on land), per column index `lz·16 + lx`. */
const SKY_LEVEL = new Float64Array(256);

/** `aquiferColumn`'s body; `fast` turns on §1.8's fast path. */
function columnStep(
  inp: AquiferInputs, s: ColumnSample, pick: CavePickerInputs, pass: CaveColumnPass, solid: Uint8Array, tags: Uint8Array,
  waterV: Uint8Array, fluid: Uint8Array, topFluid: Int32Array, sc: AquiferScratch, fast: boolean,
): void {
  if (solid.length !== 98304 || tags.length !== 98304 || waterV.length !== 98304 || fluid.length !== 98304 || topFluid.length !== 256) {
    throw new RangeError('aquiferColumn: solid, tags, waterV and fluid need 98,304 entries, topFluid 256');
  }
  const st = inp.settings;
  const enabled = st.enabled;
  const lavaLevel = st.lavaLevel;
  const noise = inp.barrier;
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  resetScratch(sc, s.cx, s.cz);
  for (let p = 0; p < 256; p++) {
    SKY_LEVEL[p] = FLOOR(LEVEL(s, 'surfaceWaterLevel', x0 + (p & 15), z0 + (p >> 4)));
    topFluid[p] = Y0 - 1;
  }
  waterV.fill(0, 0, 256);
  fluid.fill(0, 0, 256);
  for (let v = 256; v < 98304; v++) {
    let f = 0;
    if (solid[v] === 0) {
      const p = v & 255;
      const y = (v >> 8) + Y0;
      const tag = tags[v]!;
      if ((tag & 15) === 0) {
        if (y <= SKY_LEVEL[p]!) f = WATER_SRC;
      } else if (enabled) {
        const x = x0 + (p & 15);
        const z = z0 + (p >> 4);
        const i0 = FLOOR((x - OFFSET_XZ) / CELL_XZ);
        const j0 = FLOOR((y + OFFSET_Y) / CELL_Y);
        const k0 = FLOOR((z - OFFSET_XZ) / CELL_XZ);
        let skip = false;
        if (fast && y >= lavaLevel) {
          const h = cachedHood(inp, sc, i0, j0, k0);
          skip = sc.hoodLava[h] === 0 && y > sc.hoodMax[h]! + FAST_REACH;
        }
        if (!skip) {
          nearestTwo(inp, sc, x, y, z, i0, j0, k0);
          const abyss = tag >> 4 === ABYSS;
          const margin = marginDecides(y, N_S1, abyss) && inAbyssMargin(inp, pick, pass, x, y, z);
          const r = ruleOf(st, y, N_D1, N_S1, N_D2, N_S2, 0, abyss, margin, noise, x, z);
          if (r === BARRIER) {
            solid[v] = 1;
            tags[v] = 0;
          } else {
            f = r;
          }
        }
      }
    }
    fluid[v] = f;
    waterV[v] = f === WATER_SRC ? 1 : 0;
    if (f !== 0) topFluid[v & 255] = (v >> 8) + Y0;
  }
}

/**
 * The aquifer step of column (s.cx, s.cz) (§1.7-§1.8, D19, D20) over its voxels (98,304 entries each, index
 * `256·(y + 64) + p`, p = lz·16 + lx; the y −64 entries are bedrock and get no fluid), `pass` the column's cave-biome
 * pass (filled by the cave-biome step): an untagged non-solid voxel takes `WATER_SOURCE` iff y ≤ ⌊`surfaceWaterLevel`⌋
 * at its nearest quart corner (`readLevel`); a tagged one (kind ≠ 0 in `tags`' bits 0-3) `voxelRule` over its two
 * nearest centres, with `abyss` its nibble (bits 4-7) and the margin from `inAbyssMargin`; a barrier sets `solid` to 1
 * and `tags` to 0. Writes `fluid` (the byte, 0 for none), `waterV` (1 at water, the surface pass's scratch) and
 * `topFluid[p]` (the highest fluid y, Y0 − 1 when none). With `enabled` false every tagged voxel is dry. The fast path
 * (§1.8): a tagged voxel more than 4 above its 12 candidates' highest level, with no lava cell among them and not below
 * `lavaLevel`, is air without a distance. `sc` is reset for the column.
 */
export function aquiferColumn(
  inp: AquiferInputs, s: ColumnSample, pick: CavePickerInputs, pass: CaveColumnPass, solid: Uint8Array, tags: Uint8Array,
  waterV: Uint8Array, fluid: Uint8Array, topFluid: Int32Array, sc: AquiferScratch,
): void {
  columnStep(inp, s, pick, pass, solid, tags, waterV, fluid, topFluid, sc, true);
}

/** `aquiferColumn` without the fast path: every tagged voxel reads its distances (the test oracle). */
export function aquiferColumnSlow(
  inp: AquiferInputs, s: ColumnSample, pick: CavePickerInputs, pass: CaveColumnPass, solid: Uint8Array, tags: Uint8Array,
  waterV: Uint8Array, fluid: Uint8Array, topFluid: Int32Array, sc: AquiferScratch,
): void {
  columnStep(inp, s, pick, pass, solid, tags, waterV, fluid, topFluid, sc, false);
}

/** The point functions' status cache, for column (`POINT_SC.cx`, `POINT_SC.cz`) and inputs `POINT_INP` (null: empty). */
const POINT_SC = createAquiferScratch();
let POINT_INP: AquiferInputs | null = null;
/** Their cave-biome pass (for the margin), for column (`POINT_PASS.cx`, `POINT_PASS.cz`) and `POINT_PICK` (null: empty). */
const POINT_PASS = NEW_PASS();
let POINT_PICK: CavePickerInputs | null = null;

/**
 * The column step's decision at world voxel (x, y, z): 0 where the density probe's solidity holds (`solidAt`) and at
 * y −64 (T's bedrock); at an untagged voxel (`caveTagAt` 0) `WATER_SOURCE` iff y ≤ ⌊`surfaceWaterLevel`⌋ at its nearest
 * quart corner (the column sample from `dc.columns`); at a tagged one, 0 when the aquifer is off, else `ruleOf` over
 * its two nearest centres (`nearestTwo` on the point cache), its nibble from `caveBiomeAt`, its margin from the pass of
 * its column (filled only where the margin decides): a fluid byte, 0 or `AQUIFER_BARRIER`.
 */
function pointRule(inp: AquiferInputs, dc: DensityContext, x: number, y: number, z: number): number {
  if (SOLID_AT(dc, x, y, z) || y === Y0) return 0;
  const cx = x >> 4;
  const cz = z >> 4;
  if (TAG_AT(dc, x, y, z) === 0) return y <= FLOOR(LEVEL(dc.columns.get(cx, cz), 'surfaceWaterLevel', x, z)) ? WATER_SRC : 0;
  const st = inp.settings;
  if (!st.enabled) return 0;
  const sc = POINT_SC;
  if (POINT_INP !== inp || sc.cx !== cx || sc.cz !== cz) {
    POINT_INP = null;
    resetScratch(sc, cx, cz);
    POINT_INP = inp;
  }
  nearestTwo(inp, sc, x, y, z, FLOOR((x - OFFSET_XZ) / CELL_XZ), FLOOR((y + OFFSET_Y) / CELL_Y), FLOOR((z - OFFSET_XZ) / CELL_XZ));
  const abyss = BIOME_AT(dc, x, y, z) === ABYSS;
  let margin = false;
  if (marginDecides(y, N_S1, abyss)) {
    const pick = PICKER_OF(dc.ctx);
    if (POINT_PICK !== pick || POINT_PASS.cx !== cx || POINT_PASS.cz !== cz) {
      POINT_PICK = null;
      FILL_PASS(pick, dc.columns.get(cx, cz), POINT_PASS);
      POINT_PICK = pick;
    }
    margin = inAbyssMargin(inp, pick, POINT_PASS, x, y, z);
  }
  return ruleOf(st, y, N_D1, N_S1, N_D2, N_S2, 0, abyss, margin, inp.barrier, x, z);
}

/**
 * The proto fluid byte T writes at world voxel (x, y, z) when no spring is there (D19, D20): 0 at a solid voxel (the
 * density probe's, y −64 included) or a barrier; at an untagged non-solid voxel D19's rule, `WATER_SOURCE` iff y ≤
 * ⌊`surfaceWaterLevel`⌋ at its nearest quart corner (no `top` read); at a tagged one `voxelRule`'s byte, with its nibble
 * from `caveBiomeAt` and its margin from its column's pass. `dc` is a DensityContext of `inp.ctx`. Integers only, y in
 * −64 … 319, (x, z) in the world window (a RangeError otherwise, as `probe`).
 */
export function fluidAt(inp: AquiferInputs, dc: DensityContext, x: number, y: number, z: number): number {
  const r = pointRule(inp, dc, x, y, z);
  return r === BARRIER ? 0 : r;
}

/**
 * Whether world voxel (x, y, z) is a barrier (D20): a tagged non-solid voxel that `voxelRule` makes rock, where T sets
 * the solidity and clears the tag. Arguments as `fluidAt`.
 */
export function barrierAt(inp: AquiferInputs, dc: DensityContext, x: number, y: number, z: number): boolean {
  return pointRule(inp, dc, x, y, z) === BARRIER;
}

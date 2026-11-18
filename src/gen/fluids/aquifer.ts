/**
 * The aquifer's cells and statuses (SP7a spec §1.1-§1.4, D18; master §3.9): the cell grid, the jittered centres and
 * each cell's status, a level and a fluid type. Task 6 adds the voxel rule over a column, Task 7 the point functions.
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
 * Follows the gen determinism rules: every value in world coordinates, one fixed operation order.
 */
import {
  AQUIFER_CELL_XZ, AQUIFER_CELL_Y, AQUIFER_EMPTY, AQUIFER_JITTER_XZ, AQUIFER_JITTER_Y, AQUIFER_LAVA_BLOCK_XZ,
  AQUIFER_LAVA_BLOCK_Y, AQUIFER_OFFSET_XZ, AQUIFER_OFFSET_Y, SEA_LEVEL,
} from '../../core/constants';
import { deriveSeed, hash3 } from '../../core/hash';
import { NormalNoise } from '../../core/noise/normal';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import type { NoiseDef } from '../../core/noise/types';
import { FLUID_LAVA, FLUID_WATER } from '../../world/blocks/fluid';
import { newPointRecord, samplePoint } from '../column/columnPoint';
import type { GenContext } from '../context';

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
  const st = inp.settings;
  cellCentre(inp, i, j, k, CENTRE);
  const cx = CENTRE[0]!;
  const cy = CENTRE[1]!;
  const cz = CENTRE[2]!;
  const p = SAMPLE(inp.ctx, i * CELL_XZ, k * CELL_XZ, false, REC);
  const offset = p.offset;
  const level = p.surfaceWaterLevel;
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

/**
 * Springs (SP7a spec §3, D1-D4, D21): a source voxel T places in a solid voxel of its proto, after the surface pass and
 * before the seed sections (D17), so springs reach D's settle as proto sources (master :921).
 * - The tries (§3.1): per chunk (cx, cz) and kind k, `Xoshiro128(hash2(deriveSeed(seed, 'springs.' + k), cx, cz))`
 *   draws `springs.k.tries` tries in a fixed order, five values each (`springTries`): x, z (0 … 15 in the chunk), the
 *   direction (N, E, S, W in face order: −z, +x, +z, −x), u and u2 (u2 read by the island kind only), so a rejection
 *   never shifts a later try.
 * - The common rule (§3.1): a try is accepted when its spring voxel is solid, its state in the kind's valid set, not
 *   tagged and not a spring already; the voxels above and below it and its two lateral and its back neighbours are
 *   solid; the outlet (the neighbour in its direction) and the `minFall` voxels below the outlet are non-solid with no
 *   fluid. Every read inside the column is from T's arrays as they stand before any spring is written; every read
 *   outside it from the point probes (`SpringProbes`: `terrainSolidAt`, `fluidAt`, `caveTagAt`, `caveBiomeAt` on a
 *   DensityContext of this module's own, never T's), equal to bulk (DT2) and blind to springs too, so a try is decided
 *   the same whichever column reads it and no border ring is excluded (D21).
 * - Water (§3.2, D1): yLo = ⌈`offset` at the outlet⌉ + `minFall` (`readFieldHalo`), yHi = `top` − 2 (with
 *   `islands.enabled`, `groundTop` − 2: the top of the highest solid run whose bottom lies below 181, SP3e's rule, so
 *   island faces are left to their own kind); y = yLo + ⌊u·(yHi − yLo + 1)⌋, rejected when yHi < yLo (no
 *   y floor: Task 19's Spec correction, ruling R17); the valid set every `CARVABLE` terrain state but sand, red_sand
 *   and gravel.
 * The kinds run in a fixed order (water, island, lava; the list's kind byte 0, 1, 2); a voxel already accepted is not
 * accepted twice. Follows the gen determinism rules.
 */
import { ISLAND_RUN_MIN_BOTTOM, MIN_Y } from '../../core/constants';
import { deriveSeed, hash2, type Seed64 } from '../../core/hash';
import { Xoshiro128 } from '../../core/rng';
import { CARVABLE, GRAVEL, RED_SAND, SAND } from '../../world/blocks/index';
import { caveBiomeAt, type CaveColumnPass } from '../biomes/cavePicker';
import { caveTagAt } from '../caves/tags';
import { readFieldHalo, type ColumnSample } from '../column/columnStage';
import type { GenContext } from '../context';
import { createDensityContext } from '../density/context';
import { aquiferOf, barrierAt, fluidAt } from './aquifer';
import { terrainSolidAt } from './solidAt';

const Y0 = MIN_Y;
const ISLAND_BOTTOM = ISLAND_RUN_MIN_BOTTOM;
const CARVE_OK = CARVABLE;
const SAND_ = SAND;
const RED_SAND_ = RED_SAND;
const GRAVEL_ = GRAVEL;
const DERIVE = deriveSeed;
const HASH2 = hash2;
const Rng = Xoshiro128;
const HALO = readFieldHalo;
const TAG_AT = caveTagAt;
const BIOME_AT = caveBiomeAt;
const SOLID_AT = terrainSolidAt;
const FLUID_AT = fluidAt;
const BARRIER_AT = barrierAt;
const AQUIFER_OF = aquiferOf;
const CREATE_DC = createDensityContext;

/** A spring kind; its byte in a `SpringList` is its index in the fixed order water, island, lava. */
export type SpringKind = 'water' | 'island' | 'lava';

/** The values `springTries` draws per try: x, z, the direction, u, u2. */
const PER_TRY = 5;
/** The directions in face order (N −z, E +x, S +z, W −x): x and z steps. */
const DX = new Int8Array([0, 1, 0, -1]);
const DZ = new Int8Array([-1, 0, 1, 0]);
/** The most tries a column takes over every kind (the leaves' maxima: water 32, island 32, lava 64). */
const MAX_TRIES = 128;

/**
 * The tries of chunk (cx, cz) for kind `kind` (§3.1): `Xoshiro128(hash2(deriveSeed(seed, 'springs.' + kind), cx, cz))`,
 * then per try exactly five draws in this order into `out[5t …]`: x = `nextInt(16)`, z = `nextInt(16)`, the direction
 * `nextInt(4)` (N, E, S, W in face order), u = `nextFloat()`, u2 = `nextFloat()`. Throws a RangeError when `out` holds
 * fewer than 5·`tries` values or `tries` is not an integer ≥ 0.
 */
export function springTries(seed: Seed64, kind: SpringKind, cx: number, cz: number, tries: number, out: Float64Array): void {
  if (!Number.isInteger(tries) || tries < 0 || out.length < PER_TRY * tries) {
    throw new RangeError(`springTries: ${tries} tries need ${PER_TRY * tries} values, out holds ${out.length}`);
  }
  const r = new Rng(HASH2(DERIVE(seed, `springs.${kind}`), cx, cz));
  for (let t = 0; t < tries; t++) {
    const o = PER_TRY * t;
    out[o] = r.nextInt(16);
    out[o + 1] = r.nextInt(16);
    out[o + 2] = r.nextInt(4);
    out[o + 3] = r.nextFloat();
    out[o + 4] = r.nextFloat();
  }
}

/**
 * The point functions a try reads outside its column (D21), at world voxels: T's solidity (`terrainSolidAt`), the proto
 * fluid byte T writes where no spring is (`fluidAt`), the stored cave tag's kind (`caveTagAt`, 0 where `barrierAt`
 * makes the voxel rock) and the stored cave-biome nibble (`caveBiomeAt` at a tagged voxel, 0 elsewhere).
 */
export interface SpringProbes {
  solid(x: number, y: number, z: number): boolean;
  fluid(x: number, y: number, z: number): number;
  tag(x: number, y: number, z: number): number;
  nibble(x: number, y: number, z: number): number;
}

const PROBES = new WeakMap<GenContext, SpringProbes>();

/**
 * The spring probes of a GenContext, memoised per context: the point functions bound to a DensityContext of this
 * module's own (`createDensityContext(ctx)`), so T's own context is never switched to a neighbour column mid-job, and
 * to `aquiferOf(ctx)`.
 */
export function springProbesOf(ctx: GenContext): SpringProbes {
  let p = PROBES.get(ctx);
  if (p === undefined) {
    const dc = CREATE_DC(ctx);
    const aq = AQUIFER_OF(ctx);
    const tag = (x: number, y: number, z: number): number => {
      const t = TAG_AT(dc, x, y, z);
      return t !== 0 && BARRIER_AT(aq, dc, x, y, z) ? 0 : t;
    };
    p = {
      solid: (x, y, z) => SOLID_AT(aq, dc, x, y, z),
      fluid: (x, y, z) => FLUID_AT(aq, dc, x, y, z),
      tag,
      nibble: (x, y, z) => (tag(x, y, z) !== 0 ? BIOME_AT(dc, x, y, z) : 0),
    };
    PROBES.set(ctx, p);
  }
  return p;
}

/**
 * A column's accepted springs, in decision order: `pos[i]` the voxel's column index `((y + 64)·16 + lz)·16 + lx` (T's
 * array index), `kind[i]` its kind byte (0 water, 1 island, 2 lava), `dir[i]` its outlet's direction (0 … 3, N, E, S, W).
 */
export interface SpringList { n: number; readonly pos: Int32Array; readonly kind: Uint8Array; readonly dir: Uint8Array }

/** An empty spring list with room for every try of a column (128: the leaves' maxima). */
export function newSpringList(): SpringList {
  return { n: 0, pos: new Int32Array(MAX_TRIES), kind: new Uint8Array(MAX_TRIES), dir: new Uint8Array(MAX_TRIES) };
}

const TRIES = new Float64Array(PER_TRY * MAX_TRIES);

/** Whether `state` lies in the water springs' valid set (§3.2): `CARVABLE`, but not sand, red_sand or gravel. */
const waterRock = (state: number): boolean => CARVE_OK[state] !== 0 && state !== SAND_ && state !== RED_SAND_ && state !== GRAVEL_;

/**
 * The top of position p's highest solid run whose bottom lies below `ISLAND_RUN_MIN_BOTTOM` (Y0 when none; SP3e's
 * rule, SP7a §1.7's `groundTop`): the highest solid voxel at y ≤ 180, followed upward through its run.
 */
function groundTop(solid: Uint8Array, p: number): number {
  let i = 256 * (ISLAND_BOTTOM - 1 - Y0) + p;
  while (i >= 256 && solid[i] === 0) i -= 256;
  if (i < 256) return Y0;
  while (i + 256 < 98304 && solid[i + 256] !== 0) i += 256;
  return (i >> 8) + Y0;
}

/** The column `springsColumn` decides (its arrays, origin and probes), read by the helpers below; cleared after. */
const COL = {
  solid: null as Uint8Array | null,
  state: null as Uint16Array | null,
  tags: null as Uint8Array | null,
  fluid: null as Uint8Array | null,
  probes: null as SpringProbes | null,
  out: null as SpringList | null,
  x0: 0,
  z0: 0,
};

/** Whether column-relative voxel (lx, y, lz) is solid: T's arrays inside the column (y −64 is bedrock), the probe outside. */
function solidAt(lx: number, y: number, lz: number): boolean {
  if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) return y === Y0 || COL.solid![(((y - Y0) << 4) | lz) << 4 | lx] !== 0;
  return COL.probes!.solid(COL.x0 + lx, y, COL.z0 + lz);
}

/** Whether column-relative voxel (lx, y, lz) is non-solid with no fluid: T's arrays inside the column, the probes outside. */
function openAt(lx: number, y: number, lz: number): boolean {
  if (y <= Y0) return false;
  if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) {
    const j = (((y - Y0) << 4) | lz) << 4 | lx;
    return COL.solid![j] === 0 && COL.fluid![j] === 0;
  }
  const x = COL.x0 + lx, z = COL.z0 + lz;
  return !COL.probes!.solid(x, y, z) && COL.probes!.fluid(x, y, z) === 0;
}

/**
 * §3.1's common rule for a spring at column voxel (lx, y, lz) (inside the column) facing `d`, with `fall` open voxels
 * below the outlet and the valid set `valid`: the in-column reads first, then the outlet, its fall and the three other
 * neighbours (the only ones that may lie outside the column).
 */
function accepts(lx: number, y: number, lz: number, d: number, fall: number, valid: (st: number) => boolean): boolean {
  if (y <= Y0 || y >= 319 || y - fall <= Y0) return false;
  const solid = COL.solid!;
  const j = (((y - Y0) << 4) | lz) << 4 | lx;
  if (solid[j] === 0 || !valid(COL.state![j]!) || (COL.tags![j]! & 15) !== 0) return false;
  const out = COL.out!;
  for (let k = 0; k < out.n; k++) if (out.pos[k] === j) return false;
  if (solid[j + 256] === 0 || !solidAt(lx, y - 1, lz)) return false;
  const ox = lx + DX[d]!, oz = lz + DZ[d]!;
  if (!openAt(ox, y, oz)) return false;
  for (let k = 1; k <= fall; k++) if (!openAt(ox, y - k, oz)) return false;
  for (let e = 1; e < 4; e++) {
    const f = (d + e) & 3;
    if (!solidAt(lx + DX[f]!, y, lz + DZ[f]!)) return false;
  }
  return true;
}

/** Appends an accepted spring to `COL.out`. */
function accept(lx: number, y: number, lz: number, kind: number, d: number): void {
  const out = COL.out!;
  const k = out.n++;
  out.pos[k] = (((y - Y0) << 4) | lz) << 4 | lx;
  out.kind[k] = kind;
  out.dir[k] = d;
}

/**
 * The springs of s's column (§3.1-§3.2) into `out` (cleared first), from T's arrays before any spring: `solid` (1
 * solid), `state` (the surface pass's states at solid voxels), `tags` (the cave bytes), `fluid` (the aquifer's fluid
 * bytes) and `top` (per position `lz·16 + lx`, the highest solid y), each indexed as T's (98,304 entries, `top` 256);
 * `pass` is the column's cave-biome pass (its Y0 bounds the lava kind's range, Task 21); `probes` reads the voxels
 * outside the column (`springProbesOf(ctx)` in T; the call is not reentrant, so a probe must not run T). The kinds'
 * tries run in the fixed order (water, island, lava), each decided by the common rule; a voxel already accepted is not
 * accepted twice. Writes nothing into the arrays: T writes the accepted springs after the call.
 */
export function springsColumn(
  ctx: GenContext, s: ColumnSample, pass: CaveColumnPass, solid: Uint8Array, state: Uint16Array, tags: Uint8Array,
  fluid: Uint8Array, top: Int32Array, probes: SpringProbes, out: SpringList,
): void {
  out.n = 0;
  const cx = s.cx, cz = s.cz;
  const x0 = 16 * cx, z0 = 16 * cz;
  COL.solid = solid;
  COL.state = state;
  COL.tags = tags;
  COL.fluid = fluid;
  COL.probes = probes;
  COL.out = out;
  COL.x0 = x0;
  COL.z0 = z0;
  try {
    const w = ctx.params.springs.water;
    const islands = ctx.params.islands.enabled;
    if (w.tries > 0) {
      springTries(ctx.seed, 'water', cx, cz, w.tries, TRIES);
      for (let t = 0; t < w.tries; t++) {
        const o = PER_TRY * t;
        const lx = TRIES[o]!, lz = TRIES[o + 1]!, d = TRIES[o + 2]!, u = TRIES[o + 3]!;
        const p = lz * 16 + lx;
        const yLo = Math.ceil(HALO(s, 'offset', x0 + lx + DX[d]!, z0 + lz + DZ[d]!)) + w.minFall;
        const yHi = (islands ? groundTop(solid, p) : top[p]!) - 2;
        if (yHi < yLo) continue;
        const y = yLo + Math.floor(u * (yHi - yLo + 1));
        if (!accepts(lx, y, lz, d, w.minFall, waterRock)) continue;
        accept(lx, y, lz, 0, d);
      }
    }
  } finally {
    COL.solid = null;
    COL.state = null;
    COL.tags = null;
    COL.fluid = null;
    COL.probes = null;
    COL.out = null;
  }
}

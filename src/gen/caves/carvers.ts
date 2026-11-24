/**
 * The carvers' sources and paths (SP6a spec §2.1-§2.3, D5, D21, D35): a pure function of the world seed, the kind and
 * the source chunk (sx, sz), never of the column that asks for it, so two columns see the same path.
 * - Source (§2.1): `rng = Xoshiro128(hash2(deriveSeed(seed, 'caves.' + kind), sx, sz))` (the derived seed memoised per
 *   kind, `carverSourceSeed`; SP6b D32); its first `nextFloat()`
 *   against the kind's chance, else no path (null). A source reaches only the chunks within `CARVER_WINDOW_R` of its
 *   own (`core/constants.ts`; `reachOverflow` pins it on `box`).
 * - Worm and underground worm (§2.2), in this draw order (frozen by the golden `sp6a.carver.paths`):
 *   1. the start x `16·sx + 16·u`, z `16·sz + 16·u`, y `startYMin + (startYMax − startYMin)·u`; yaw `2π·u`; pitch
 *      `(u − 0.5)/4`;
 *   2. n `max(1, length − ⌊lengthVar·u⌋)`; t `2·u + u`; hMul in [radiusMin, radiusMax]; vMul in [vRatioMin,
 *      vRatioMax]; floor in [floorMin, floorMax], each `min + (max − min)·u`;
 *   3. the room roll `u < roomChance` (D35); a room draws its radius `(1 + 6·u)·hMul` and yScale in [roomYScaleMin,
 *      roomYScaleMax], and is the path's first ellipsoid, at the start (rv = rh·yScale, the worm's floor);
 *   4. the branch roll `u < branchChance`, which acts only when t > 1;
 *   5. per step i < n the ellipsoid (x, y, z, rh, rv, floor), rh = (1.5 + detSin(π·i/n)·t)·hMul and rv likewise with
 *      vMul, so both ends taper; then the move (cos p·cos yaw, sin p, cos p·sin yaw) and Minecraft's drift with the
 *      `caves.worms.shape` constants: p ·= pitchKeep; yaw += yawStep·yd; p += pitchStep·pd;
 *      yd = yawDriftKeep·yd + (u − u)·u·yawDriftMul; pd = pitchDriftKeep·pd + (u − u)·u·pitchDriftMul (yd, pd from 0);
 *   6. a branching worm's trunk stops at step ⌊n/2⌋: it emits that ellipsoid and neither moves nor draws. Two branches
 *      start at its centre, yaw + π/2 first, then yaw − π/2, each drawing its thickness `0.5 + 0.5·u` and running
 *      i = ⌊n/2⌋ … n − 1 by rule 5 from the trunk's pitch, yd and pd at the fork; the first branch's draws precede the
 *      second's, and their ellipsoids follow the trunk's in `ell`.
 *   Underground worms take every worm leaf but their chance and their start range (`undergroundWorms.*`); their shrink
 *   below `maxY` is the carve's (§2.4).
 * - Ravine (§2.3), in this draw order after the roll (frozen by the same golden):
 *   1. the start x, z as worms, y `startYMin + (startYMax − startYMin)·u`; yaw `2π·u`; pitch `(u − 0.5)·2·vRotation`;
 *   2. t from the trapezoid on [0, thicknessMax] with plateau `plateau`: `t = u·(thicknessMax − g) + u·g`,
 *      g = (thicknessMax − min(plateau, thicknessMax))/2 (Minecraft's: at the defaults 0 … 6, flat over 2 … 4);
 *   3. n `lengthMin + ⌊(max(lengthMin, lengthMax) − lengthMin + 1)·u⌋`;
 *   4. the 384 width factors from y −64 up, one draw pair per `widthSmoothness` rows: `f = 1 + u·u`, stored as f² on
 *      each of those rows (`widthSq`; the carve multiplies the horizontal term by it, so it only narrows the ravine);
 *   5. per step i < n the ellipsoid with rh = 1.5 + detSin(π·i/n)·t, rv = rh·yScale and floor −1 (none), then the
 *      move and the drift of rule 5 with the `caves.worms.shape` leaves (ravines start as worms; no room, no branch).
 * - `box` is the path's voxel reach: the union of its ellipsoids' boxes, each centre widened by its rh horizontally and
 *   its rv vertically. A voxel whose centre lies outside it is never carved by the path (the carve test `d < 1 − σ`
 *   with σ ≥ 0, §2.4).
 * The carvers' numbers live here as module constants or come from `CarverParams`; the module exports functions and
 * types only (gen exports no numeric data). Follows the gen determinism rules: every sine and cosine is `detSin` or
 * `detCos`, every draw from the source's `Xoshiro128`.
 */
import { detCos, detSin } from '../../core/detMath';
import { HEIGHT } from '../../core/constants';
import { deriveSeed, hash2 } from '../../core/hash';
import { Xoshiro128 } from '../../core/rng';
import type { Params } from '../../core/params/schema';
import type { GenContext } from '../context';

const DERIVE = deriveSeed;
const HASH2 = hash2;
const RNG = Xoshiro128;
const SIN = detSin;
const COS = detCos;
/** The world's rows, y −64 … 319: a ravine's `widthSq` holds one f² per row. */
const ROWS = HEIGHT;
/** A source's stream (the `Xoshiro128` class through its alias). */
type Rng = InstanceType<typeof RNG>;

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
/** A source's start lies in its 16 × 16 chunk. */
const CHUNK = 16;
/** Doubles per ellipsoid in `CarverPath.ell`: x, y, z, rh, rv, floor. */
const ELL = 6;
/** Minecraft's cap: every step's radius is (CAP + detSin(π·i/n)·thickness)·mul. */
const CAP = 1.5;
/** A ravine's floor: −1, below every voxel an ellipsoid holds, so none (the carve's floor test always passes). */
const NO_FLOOR = -1;

export type CarverKind = 'worm' | 'ravine' | 'undergroundWorm';

/** Minecraft's drift constants (spec §2.2; the `caves.worms.shape` leaves, §4). */
export interface WormShape {
  readonly pitchKeep: number;
  readonly yawStep: number;
  readonly pitchStep: number;
  readonly yawDriftKeep: number;
  readonly yawDriftMul: number;
  readonly pitchDriftKeep: number;
  readonly pitchDriftMul: number;
}

/** `caves.worms.*` (spec §4). */
export interface WormParams {
  readonly chance: number;
  readonly length: number;
  readonly lengthVar: number;
  readonly radiusMin: number;
  readonly radiusMax: number;
  readonly vRatioMin: number;
  readonly vRatioMax: number;
  readonly floorMin: number;
  readonly floorMax: number;
  readonly branchChance: number;
  readonly roomChance: number;
  readonly roomYScaleMin: number;
  readonly roomYScaleMax: number;
  readonly startYMin: number;
  readonly startYMax: number;
  readonly shape: WormShape;
}

/** `caves.undergroundWorms.*` (spec §4): every other leaf is the worms'. */
export interface UndergroundWormParams {
  readonly chance: number;
  readonly startYMin: number;
  readonly startYMax: number;
  readonly maxY: number;
}

/** `caves.ravines.*` (spec §4). */
export interface RavineParams {
  readonly chance: number;
  readonly lengthMin: number;
  readonly lengthMax: number;
  readonly thicknessMax: number;
  readonly plateau: number;
  readonly yScale: number;
  readonly widthSmoothness: number;
  readonly vRotation: number;
  readonly startYMin: number;
  readonly startYMax: number;
}

/** The `caves.limits.*` leaves the carve's shrinks read (spec §2.4, §4). */
export interface CarverLimits {
  readonly waterDepth: number;
  readonly bandSpan: number;
  readonly capTop: number;
}

/** The `caves.floor.*` leaves the carve's σ_b reads (SP6b spec §5.2, D6): floorY = y + amp·|Nf|, the shrink's span. */
export interface CarverFloor {
  readonly y: number;
  readonly amp: number;
  readonly span: number;
}

/** The carver leaves (spec §4), as the carvers read them. */
export interface CarverParams {
  readonly worms: WormParams;
  readonly undergroundWorms: UndergroundWormParams;
  readonly ravines: RavineParams;
  readonly limits: CarverLimits;
  /** The rock floor's leaves (SP6b spec §5.2): the carvers shrink to nothing at y ≤ floorY + 8. */
  readonly floor: CarverFloor;
}

/** One source's path (spec §2.2-§2.3). */
export interface CarverPath {
  readonly kind: CarverKind;
  readonly sx: number;
  readonly sz: number;
  /** Ellipsoids in `ell`. */
  readonly count: number;
  /** 6 per ellipsoid: x, y, z, rh, rv, floor. */
  readonly ell: Float64Array;
  /** minX, minY, minZ, maxX, maxY, maxZ: the voxel reach, each centre widened by its own rh and rv. */
  readonly box: Float64Array;
  /** Ravines: f² per world y, 384 values; null for worms. */
  readonly widthSq: Float64Array | null;
}

/**
 * Runs steps i = from … n − 1 of a worm (rule 5) from the walk state `st` (x, y, z, yaw, pitch, yd, pd), writing each
 * ellipsoid to `ell` from `at`; at step `stopAt` it emits the ellipsoid and returns before moving or drawing (the
 * trunk's fork). Returns the index after the last ellipsoid written.
 */
function walk(
  rng: Rng, sh: WormShape, st: Float64Array, ell: Float64Array, at: number, from: number, n: number, stopAt: number,
  thickness: number, hMul: number, vMul: number, floor: number,
): number {
  let x = st[0]!;
  let y = st[1]!;
  let z = st[2]!;
  let yaw = st[3]!;
  let p = st[4]!;
  let yd = st[5]!;
  let pd = st[6]!;
  for (let i = from; i < n; i++) {
    const g = CAP + SIN(PI * i / n) * thickness;
    ell[at] = x;
    ell[at + 1] = y;
    ell[at + 2] = z;
    ell[at + 3] = g * hMul;
    ell[at + 4] = g * vMul;
    ell[at + 5] = floor;
    at += ELL;
    if (i === stopAt) break;
    const cp = COS(p);
    x += cp * COS(yaw);
    y += SIN(p);
    z += cp * SIN(yaw);
    p *= sh.pitchKeep;
    yaw += sh.yawStep * yd;
    p += sh.pitchStep * pd;
    const a1 = rng.nextFloat();
    const a2 = rng.nextFloat();
    const a3 = rng.nextFloat();
    yd = sh.yawDriftKeep * yd + (a1 - a2) * a3 * sh.yawDriftMul;
    const b1 = rng.nextFloat();
    const b2 = rng.nextFloat();
    const b3 = rng.nextFloat();
    pd = sh.pitchDriftKeep * pd + (b1 - b2) * b3 * sh.pitchDriftMul;
  }
  st[0] = x;
  st[1] = y;
  st[2] = z;
  st[3] = yaw;
  st[4] = p;
  st[5] = yd;
  st[6] = pd;
  return at;
}

/** The union of the ellipsoids' boxes (minX, minY, minZ, maxX, maxY, maxZ). */
function reachOf(ell: Float64Array, count: number): Float64Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < count; k++) {
    const o = k * ELL;
    const x = ell[o]!;
    const y = ell[o + 1]!;
    const z = ell[o + 2]!;
    const rh = ell[o + 3]!;
    const rv = ell[o + 4]!;
    minX = Math.min(minX, x - rh);
    minY = Math.min(minY, y - rv);
    minZ = Math.min(minZ, z - rh);
    maxX = Math.max(maxX, x + rh);
    maxY = Math.max(maxY, y + rv);
    maxZ = Math.max(maxZ, z + rh);
  }
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ);
}

/** The worm or underground-worm path after a passed roll (§2.2, rules 1-6 above). */
function wormPath(rng: Rng, kind: CarverKind, sx: number, sz: number, p: CarverParams): CarverPath {
  const w = p.worms;
  const under = kind === 'undergroundWorm';
  const yMin = under ? p.undergroundWorms.startYMin : w.startYMin;
  const yMax = under ? p.undergroundWorms.startYMax : w.startYMax;
  // 1. The start.
  const x0 = CHUNK * sx + CHUNK * rng.nextFloat();
  const z0 = CHUNK * sz + CHUNK * rng.nextFloat();
  const y0 = yMin + (yMax - yMin) * rng.nextFloat();
  const yaw0 = TWO_PI * rng.nextFloat();
  const pitch0 = (rng.nextFloat() - 0.5) / 4;
  // 2. The size.
  const n = Math.max(1, w.length - Math.floor(w.lengthVar * rng.nextFloat()));
  const t = 2 * rng.nextFloat() + rng.nextFloat();
  const hMul = w.radiusMin + (w.radiusMax - w.radiusMin) * rng.nextFloat();
  const vMul = w.vRatioMin + (w.vRatioMax - w.vRatioMin) * rng.nextFloat();
  const floor = w.floorMin + (w.floorMax - w.floorMin) * rng.nextFloat();
  // 3. The room.
  const room = rng.nextFloat() < w.roomChance;
  let roomRh = 0;
  let roomYScale = 0;
  if (room) {
    roomRh = (1 + 6 * rng.nextFloat()) * hMul;
    roomYScale = w.roomYScaleMin + (w.roomYScaleMax - w.roomYScaleMin) * rng.nextFloat();
  }
  // 4. The branch.
  const branched = rng.nextFloat() < w.branchChance && t > 1;
  const half = Math.floor(n / 2);
  const count = (room ? 1 : 0) + (branched ? half + 1 + 2 * (n - half) : n);
  const ell = new Float64Array(count * ELL);
  let at = 0;
  if (room) {
    ell[0] = x0;
    ell[1] = y0;
    ell[2] = z0;
    ell[3] = roomRh;
    ell[4] = roomRh * roomYScale;
    ell[5] = floor;
    at = ELL;
  }
  // 5-6. The trunk, then the branches from its fork.
  const st = Float64Array.of(x0, y0, z0, yaw0, pitch0, 0, 0);
  at = walk(rng, w.shape, st, ell, at, 0, n, branched ? half : -1, t, hMul, vMul, floor);
  if (branched) {
    const fork = st.slice();
    for (let b = 0; b < 2; b++) {
      const tb = 0.5 + 0.5 * rng.nextFloat();
      st.set(fork);
      st[3] = fork[3]! + (b === 0 ? HALF_PI : -HALF_PI);
      at = walk(rng, w.shape, st, ell, at, half, n, -1, tb, hMul, vMul, floor);
    }
  }
  return { kind, sx, sz, count, ell, box: reachOf(ell, count), widthSq: null };
}

/** The ravine path after a passed roll (§2.3, ravine rules 1-5 above). */
function ravinePath(rng: Rng, sx: number, sz: number, p: CarverParams): CarverPath {
  const r = p.ravines;
  // 1. The start.
  const x0 = CHUNK * sx + CHUNK * rng.nextFloat();
  const z0 = CHUNK * sz + CHUNK * rng.nextFloat();
  const y0 = r.startYMin + (r.startYMax - r.startYMin) * rng.nextFloat();
  const yaw0 = TWO_PI * rng.nextFloat();
  const pitch0 = (rng.nextFloat() - 0.5) * 2 * r.vRotation;
  // 2. The thickness: the sum of two uniform draws on [0, thicknessMax − g) and [0, g), a trapezoid flat over its middle.
  const g = (r.thicknessMax - Math.min(r.plateau, r.thicknessMax)) / 2;
  const t = rng.nextFloat() * (r.thicknessMax - g) + rng.nextFloat() * g;
  // 3. The steps.
  const n = r.lengthMin + Math.floor((Math.max(r.lengthMin, r.lengthMax) - r.lengthMin + 1) * rng.nextFloat());
  // 4. The width factors, one pair per run of `widthSmoothness` rows from y −64 (the last run cut at the world's top).
  //    The leaf is an int in 1 … 16; the floor and the max only keep a malformed value from stalling the loop.
  const widthSq = new Float64Array(ROWS);
  const run = Math.max(1, Math.floor(r.widthSmoothness));
  for (let j = 0; j < ROWS; j += run) {
    const f = 1 + rng.nextFloat() * rng.nextFloat();
    widthSq.fill(f * f, j, Math.min(j + run, ROWS));
  }
  // 5. The steps' ellipsoids: `walk` writes c·1 and c·yScale with c = 1.5 + detSin(π·i/n)·t, so rh = c, rv = rh·yScale.
  const ell = new Float64Array(n * ELL);
  const st = Float64Array.of(x0, y0, z0, yaw0, pitch0, 0, 0);
  walk(rng, p.worms.shape, st, ell, 0, 0, n, -1, t, 1, r.yScale, NO_FLOOR);
  return { kind: 'ravine', sx, sz, count: n, ell, box: reachOf(ell, n), widthSq };
}

/** The world seed whose three derived seeds the memo holds (`carverSourceSeed`), NaN before the first call. */
let memoLo = NaN;
let memoHi = NaN;
let memoWorm = 0;
let memoRavine = 0;
let memoUnderground = 0;

/**
 * `deriveSeed(seed, 'caves.' + kind)`, the kind's source seed (§2.1), memoised per kind for the last world seed asked
 * (SP6b D32, Task 25f): a failed roll is not cached by the path cache, so a carve or a slice asks it for every source of
 * its window; a seed with other values recomputes the three. The same number as deriveSeed's, so no path changes.
 */
export function carverSourceSeed(seed: GenContext['seed'], kind: CarverKind): number {
  if (seed[0] !== memoLo || seed[1] !== memoHi) {
    memoWorm = DERIVE(seed, 'caves.worm');
    memoRavine = DERIVE(seed, 'caves.ravine');
    memoUnderground = DERIVE(seed, 'caves.undergroundWorm');
    memoLo = seed[0];
    memoHi = seed[1];
  }
  return kind === 'ravine' ? memoRavine : kind === 'undergroundWorm' ? memoUnderground : memoWorm;
}

/**
 * The path of the carver source (kind, sx, sz) of the world `seed` (§2.1): null when its roll fails. Worms and
 * underground worms (§2.2), ravines (§2.3).
 */
export function carverPath(seed: GenContext['seed'], kind: CarverKind, sx: number, sz: number, p: CarverParams): CarverPath | null {
  const rng = new RNG(HASH2(carverSourceSeed(seed, kind), sx, sz));
  const chance = kind === 'ravine' ? p.ravines.chance : kind === 'undergroundWorm' ? p.undergroundWorms.chance : p.worms.chance;
  if (!(rng.nextFloat() < chance)) return null;
  return kind === 'ravine' ? ravinePath(rng, sx, sz, p) : wormPath(rng, kind, sx, sz, p);
}

/**
 * Whether the path of source (kind, sx, sz) of the world `seed` can have an ellipsoid whose voxel range, its centre ±
 * (rh + 2) per axis (the carve's `columnPaths`), meets the rectangle [xa, xb] × [za, zb] (Task 31p, output-keeping):
 * false when its roll fails, or when its start (x, z), drawn as `carverPath` draws it, lies farther from the rectangle
 * than the path can reach. Each step moves its centre by at most 1 horizontally (|cos p|·|(cos yaw, sin yaw)|), a path
 * makes at most `length` (worms; `max(lengthMin, lengthMax)` ravines) − 1 moves from its start, the trunk's fork
 * included, and every rh is at most `max(1.5 + 3, 7)·max(radiusMin, radiusMax)` (a step's taper, a room; ravines 1.5 +
 * thicknessMax); a centre farther than √2·(rh + 2) from the rectangle is outside it by more than rh + 2 on one axis.
 * The bound is widened by 2 blocks for rounding. Draws only the roll and the start (no path is built).
 */
export function carverMayReach(
  seed: GenContext['seed'], kind: CarverKind, sx: number, sz: number, p: CarverParams, xa: number, xb: number, za: number, zb: number,
): boolean {
  const rng = new RNG(HASH2(carverSourceSeed(seed, kind), sx, sz));
  const chance = kind === 'ravine' ? p.ravines.chance : kind === 'undergroundWorm' ? p.undergroundWorms.chance : p.worms.chance;
  if (!(rng.nextFloat() < chance)) return false;
  const x0 = CHUNK * sx + CHUNK * rng.nextFloat();
  const z0 = CHUNK * sz + CHUNK * rng.nextFloat();
  let moves: number, rh: number;
  if (kind === 'ravine') {
    const r = p.ravines;
    moves = Math.max(1, r.lengthMin, r.lengthMax);
    rh = CAP + Math.abs(r.thicknessMax);
  } else {
    const w = p.worms;
    moves = Math.max(1, w.length);
    rh = Math.max(CAP + 3, 7) * Math.max(Math.abs(w.radiusMin), Math.abs(w.radiusMax));
  }
  const reach = moves + Math.SQRT2 * (rh + 2) + 2;
  const dx = x0 < xa ? xa - x0 : x0 > xb ? x0 - xb : 0;
  const dz = z0 < za ? za - z0 : z0 > zb ? z0 - zb : 0;
  return dx * dx + dz * dz <= reach * reach;
}

/**
 * The carver leaves of `p` as the carvers read them (spec §4): `caves.worms.*` with `caves.worms.shape.*`,
 * `caves.undergroundWorms.*`, `caves.ravines.*`, the `caves.limits.*` leaves of the carve's shrinks (§2.4) and the
 * `caves.floor.*` leaves of its σ_b (SP6b spec §5.2). A fresh object of plain numbers, so its fields read no `Params`
 * getter in the carve's loops.
 */
export function carverParamsOf(p: Params): CarverParams {
  const c = p.caves;
  const w = c.worms, sh = w.shape, u = c.undergroundWorms, r = c.ravines, l = c.limits, f = c.floor;
  return {
    worms: {
      chance: w.chance, length: w.length, lengthVar: w.lengthVar, radiusMin: w.radiusMin, radiusMax: w.radiusMax,
      vRatioMin: w.vRatioMin, vRatioMax: w.vRatioMax, floorMin: w.floorMin, floorMax: w.floorMax,
      branchChance: w.branchChance, roomChance: w.roomChance, roomYScaleMin: w.roomYScaleMin, roomYScaleMax: w.roomYScaleMax,
      startYMin: w.startYMin, startYMax: w.startYMax,
      shape: {
        pitchKeep: sh.pitchKeep, yawStep: sh.yawStep, pitchStep: sh.pitchStep, yawDriftKeep: sh.yawDriftKeep,
        yawDriftMul: sh.yawDriftMul, pitchDriftKeep: sh.pitchDriftKeep, pitchDriftMul: sh.pitchDriftMul,
      },
    },
    undergroundWorms: { chance: u.chance, startYMin: u.startYMin, startYMax: u.startYMax, maxY: u.maxY },
    ravines: {
      chance: r.chance, lengthMin: r.lengthMin, lengthMax: r.lengthMax, thicknessMax: r.thicknessMax, plateau: r.plateau,
      yScale: r.yScale, widthSmoothness: r.widthSmoothness, vRotation: r.vRotation, startYMin: r.startYMin,
      startYMax: r.startYMax,
    },
    limits: { waterDepth: l.waterDepth, bandSpan: l.bandSpan, capTop: l.capTop },
    floor: { y: f.y, amp: f.amp, span: f.span },
  };
}

/**
 * The gen-time settle's kernel (SP7a spec §4.1, §4.2, D22): water and lava as two independent least fixed points of
 * §4.1's rules over a proto window, merged per voxel. D's step 2 (Task 16), the global reference and A2's fronts run
 * it; the rules themselves are `fluidRules.ts`' `ruleOffers`, applied once per pop, never restated here.
 * - **Reads.** Every fluid-deciding read is the proto's, through `SettleSource` (blocks, proto fluid, cave bytes) at
 *   world voxels inside the window x0 ≤ x < x1, z0 ≤ z < z1, y −64 … 319; outside it a voxel is `block`, and its
 *   proto fluid and nibble read NO_FLUID and 0 (rulings R7). Passability is `isPassable` over `modes` (`FLUID_MODE`).
 * - **State.** Per visited voxel and per type, one least horizontal distance per value code (`FLUID_VALUE_SOURCE` 0
 *   < falling 1 < flowing level k as 1 + k; 255 where no derivation gives that code), only ever lowered (rulings
 *   R9): the voxel's value is its best code below `FLUID_VALUE_DRY` 9 and its distance that code's, so its level and
 *   distance come from one derivation; plus the type's `unsettled` flag from the voxel's last pop. A voxel first
 *   touched holding the type's proto fluid starts as (source, 0) (every proto fluid voxel is a source, §4.2), any
 *   other as dry. Held in open-addressing tables keyed by the packed position and sized by the visits (no
 *   full-height window copy, §4.2).
 * - **The fixed point.** Water first, then lava: the worklist starts from the seeds holding the type's proto fluid
 *   (seeds farther than the type's cap 12 / 14 from the box, by Manhattan distance, are skipped: a derivation's
 *   distance grows by one per sideways step, so no level travels farther from its source), pops a voxel, applies
 *   `ruleOffers` once per code whose distance is below every better code's (each offers along its own derivation),
 *   and accepts an offer (v, d) when d is below the target's least distance over the codes ≤ v, pushing it; a pop
 *   records the cap flag (`unsettled`) from the voxel's value. The rules are monotone, so the result is their least
 *   fixed point whatever the pop order (`popOrder`, a test hook, draws it).
 * - **The merge.** Per voxel of the box: a voxel both types reached takes lava's byte with `unsettled` set (a contact,
 *   SP7b's reactions); else its type's `packFluid(type, level, falling, unsettled)`; every voxel whose byte differs
 *   from its proto byte goes to the sink, in packed-position order, after convergence. A stop writes nothing.
 * `stop()` is polled before the first pop and once per 1,024 pops; `settleWindow` returns the pops (−1 on a stop).
 * - **Seeds** (§1.7, rulings P17): one per-voxel predicate, `isInColumnSeed` (a fluid voxel whose voxel below, or a
 *   horizontal neighbour inside the column, is passable with no fluid, `isSeedTarget`), read by T's `seedSectionsOf`
 *   (aux B's `seedSections`) and by D's rescan of those sections; D's cross-column scan asks `isSeedTarget` across a
 *   boundary. The cap skip of far seeds is `settleWindow`'s alone.
 * Follows the gen determinism rules.
 */
import { caveBiomeOf, HEIGHT, MIN_Y } from '../../core/constants';
import { Xoshiro128 } from '../../core/rng';
import { FLUID_LAVA, FLUID_WATER, NO_FLUID, fluidType, packFluid } from '../../world/blocks/fluid';
import { FLUID_VALUE_DRY, FLUID_VALUE_FALLING, FLUID_VALUE_SOURCE, capOf, isPassable, ruleOffers } from '../../world/blocks/fluidRules';
import type { FluidRuleReader } from '../../world/blocks/fluidRules';
import { FLUID_MODE } from '../../world/blocks/index';

const NIBBLE_OF = caveBiomeOf;
const Y_MIN = MIN_Y;
const Y_SPAN = HEIGHT;
const Y_END = Y_MIN + Y_SPAN;
const RNG = Xoshiro128;
const LAVA = FLUID_LAVA;
const WATER = FLUID_WATER;
const DRY_BYTE = NO_FLUID;
const typeOf = fluidType;
const pack = packFluid;
const VALUE_DRY = FLUID_VALUE_DRY;
const VALUE_FALLING = FLUID_VALUE_FALLING;
const VALUE_SOURCE = FLUID_VALUE_SOURCE;
const CAP_OF = capOf;
const PASSABLE = isPassable;
const OFFERS = ruleOffers;
const MODES = FLUID_MODE;

/**
 * One column's voxels as §1.7's seed test reads them (lx, lz 0 … 15, y −64 … 319): whether a voxel is passable
 * (`isPassable` over its state) and its proto fluid byte.
 */
export interface SeedColumn {
  passable(lx: number, y: number, lz: number): boolean;
  fluid(lx: number, y: number, lz: number): number;
}

/** Whether (lx, y, lz) of `c` is a seed's target: passable with no fluid (§1.7). */
export function isSeedTarget(c: SeedColumn, lx: number, y: number, lz: number): boolean {
  return c.passable(lx, y, lz) && c.fluid(lx, y, lz) === DRY_BYTE;
}

/**
 * §1.7's in-column seed (rulings P17): a fluid voxel of `c` whose voxel below, or a horizontal neighbour inside the
 * column, is a seed target (`isSeedTarget`). The voxel above is not read (fluid never rises); y −64 has no voxel below.
 */
export function isInColumnSeed(c: SeedColumn, lx: number, y: number, lz: number): boolean {
  if (c.fluid(lx, y, lz) === DRY_BYTE) return false;
  return (y > Y_MIN && isSeedTarget(c, lx, y - 1, lz))
    || (lx > 0 && isSeedTarget(c, lx - 1, y, lz)) || (lx < 15 && isSeedTarget(c, lx + 1, y, lz))
    || (lz > 0 && isSeedTarget(c, lx, y, lz - 1)) || (lz < 15 && isSeedTarget(c, lx, y, lz + 1));
}

/**
 * T's column arrays as a `SeedColumn`, read as T writes its proto: a non-solid voxel above the bedrock row is AIR
 * (passable) with its fluid byte; a solid voxel and the bedrock row hold no fluid.
 */
const T_COLUMN = {
  solid: null as Uint8Array | null,
  fluids: null as Uint8Array | null,
  passable(lx: number, y: number, lz: number): boolean {
    return y > Y_MIN && this.solid![(((y - Y_MIN) << 4) | lz) << 4 | lx] === 0;
  },
  fluid(lx: number, y: number, lz: number): number {
    return this.passable(lx, y, lz) ? this.fluids![(((y - Y_MIN) << 4) | lz) << 4 | lx]! : DRY_BYTE;
  },
};

/**
 * Aux B's `seedSections` of a T column (SP7a spec §1.7): the 24-bit mask whose bit sy is set when section sy holds an
 * in-column seed (`isInColumnSeed`), over T's column-wide `solid` (1 solid) and `fluid` (proto fluid bytes) arrays,
 * index `((y + 64)·16 + lz)·16 + lx` (98,304 entries each; the bedrock row y −64 is solid whatever `solid` says).
 * Throws a RangeError on other sizes.
 */
export function seedSectionsOf(solid: Uint8Array, fluid: Uint8Array): number {
  if (solid.length !== 98304 || fluid.length !== 98304) throw new RangeError('seedSectionsOf: solid and fluid need 98,304 entries');
  T_COLUMN.solid = solid;
  T_COLUMN.fluids = fluid;
  let mask = 0;
  try {
    for (let sy = 0; sy < 24; sy++) {
      const end = (sy + 1) << 12;
      for (let j = sy << 12; j < end; j++) {
        if (fluid[j] === DRY_BYTE) continue;
        if (isInColumnSeed(T_COLUMN, j & 15, Y_MIN + (j >> 8), (j >> 4) & 15)) {
          mask |= 1 << sy;
          break;
        }
      }
    }
  } finally {
    T_COLUMN.solid = null;
    T_COLUMN.fluids = null;
  }
  return mask >>> 0;
}

/** The distance of a voxel the type has not reached. */
const DIST_DRY = 255;
/** The value codes below dry (source, falling, flowing 1 … 7): each voxel keeps one least distance per code. */
const CODES = VALUE_DRY;
/** `flags` bits: water's and lava's `unsettled`, and "in the worklist" (one type runs at a time). */
const FLAG_WATER_UNSETTLED = 1;
const FLAG_LAVA_UNSETTLED = 2;
const FLAG_QUEUED = 4;
/** `ruleOffers`' cap bit in its return value (u's `unsettled`); the low 4 bits count the offers. */
const OFFERS_CAP = 16;
const OFFERS_COUNT = 15;
/** The packed keys' bound: 384·W² keys must fit an Int32 (W ≤ 2,364). */
const MAX_KEYS = 0x7fffffff;
/** `stop()` is polled when the pop count is a multiple of 1,024 (§4.2). */
const POLL_MASK = 1023;

/**
 * The proto window the settle reads (blocks, proto fluid bytes, cave bytes) at world voxels, x0 ≤ x < x1,
 * z0 ≤ z < z1, y −64 … 319; the settle never reads outside it (a voxel outside reads as `block`).
 */
export interface SettleSource {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  block(x: number, y: number, z: number): number;
  fluid(x: number, y: number, z: number): number;
  cave(x: number, y: number, z: number): number;
}

/** Receives every voxel of the box whose settled byte differs from its proto byte, after convergence. */
export interface SettleSink { set(x: number, y: number, z: number, byte: number): void }

/** The settle's reusable state: tables grown by doubling, kept between calls (one per worker or caller). */
export interface SettleScratch {
  /** Test hook: 0 pops first in, first out; any other value draws each pop from the worklist with that seed. */
  popOrder: number;
  /** Test-only: the settled distance of the last call's voxel (lava's at a contact), −1 where no front reached. */
  distAt(x: number, y: number, z: number): number;
}

/**
 * The scratch behind `SettleScratch`: an open-addressing table (linear probing, load ≤ 1/2) from the packed position
 * to an entry index, and the entries' fields in arrays indexed by entry (stable across a table growth, so the
 * worklist holds entry indices).
 */
class Scratch implements SettleScratch, FluidRuleReader {
  popOrder = 0;
  // The table.
  keys: Int32Array;
  ids: Int32Array;
  mask: number;
  /** 32 − log2(table size): the hash keeps the product's high bits. */
  shift: number;
  // The entries.
  n = 0;
  ekey: Int32Array;
  eslot: Int32Array;
  vW: Uint8Array;
  /** Per entry e and value code k, at e·CODES + k: the least distance of a derivation with value exactly k. */
  dW: Uint8Array;
  vL: Uint8Array;
  dL: Uint8Array;
  flags: Uint8Array;
  // The worklist: a ring of entry indices.
  queue: Int32Array;
  qHead = 0;
  qLen = 0;
  /** `ruleOffers`' output: at most 9 tuples of 5 ints (rulings P2). */
  readonly offers = new Int32Array(45);
  /** The changed bytes of the box as key·256 + byte, sorted before the sink sees them. */
  changed: Float64Array;
  // The window of the current (or last) call.
  src: SettleSource | null = null;
  modes: ArrayLike<number> = MODES;
  x0 = 0;
  z0 = 0;
  x1 = 0;
  z1 = 0;
  width = 0;

  constructor(capacity: number) {
    let size = 16;
    while (size < capacity) size *= 2;
    this.keys = new Int32Array(size).fill(-1);
    this.ids = new Int32Array(size);
    this.mask = size - 1;
    this.shift = Math.clz32(size) + 1;
    const entries = size >> 1;
    this.ekey = new Int32Array(entries);
    this.eslot = new Int32Array(entries);
    this.vW = new Uint8Array(entries);
    this.dW = new Uint8Array(entries * CODES);
    this.vL = new Uint8Array(entries);
    this.dL = new Uint8Array(entries * CODES);
    this.flags = new Uint8Array(entries);
    this.queue = new Int32Array(entries);
    this.changed = new Float64Array(entries);
  }

  // FluidRuleReader over the window (rulings R7: fluid and nibble read nothing where `passable` is false).
  passable(x: number, y: number, z: number): boolean {
    if (x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1 || y < Y_MIN || y >= Y_END) return false;
    return PASSABLE(this.src!.block(x, y, z), this.modes);
  }
  protoFluid(x: number, y: number, z: number): number { return this.passable(x, y, z) ? this.src!.fluid(x, y, z) : DRY_BYTE; }
  nibble(x: number, y: number, z: number): number { return this.passable(x, y, z) ? NIBBLE_OF(this.src!.cave(x, y, z)) : 0; }

  keyOf(x: number, y: number, z: number): number { return ((y - Y_MIN) * this.width + (z - this.z0)) * this.width + (x - this.x0); }

  /** Empties the table and the entries (only the slots in use). */
  clear(): void {
    for (let i = 0; i < this.n; i++) this.keys[this.eslot[i]!] = -1;
    this.n = 0;
    this.qHead = 0;
    this.qLen = 0;
  }

  /** The home slot of `key`: multiplicative hashing, the product's high bits. */
  slotOf(key: number): number { return Math.imul(key, 0x9e3779b1) >>> this.shift; }

  /** The entry of `key`, or −1. */
  find(key: number): number {
    let slot = this.slotOf(key);
    for (;;) {
      const k = this.keys[slot]!;
      if (k === key) return this.ids[slot]!;
      if (k === -1) return -1;
      slot = (slot + 1) & this.mask;
    }
  }

  /** The entry of `key` at (x, y, z), created with its proto start values when new. */
  entry(key: number, x: number, y: number, z: number): number {
    let slot = this.slotOf(key);
    for (;;) {
      const k = this.keys[slot]!;
      if (k === key) return this.ids[slot]!;
      if (k === -1) break;
      slot = (slot + 1) & this.mask;
    }
    if (this.n >= this.ekey.length) {
      this.grow();
      return this.entry(key, x, y, z);
    }
    const e = this.n++;
    this.keys[slot] = key;
    this.ids[slot] = e;
    this.ekey[e] = key;
    this.eslot[e] = slot;
    const type = typeOf(this.protoFluid(x, y, z));
    this.vW[e] = type === WATER ? VALUE_SOURCE : VALUE_DRY;
    this.dW.fill(DIST_DRY, e * CODES, e * CODES + CODES);
    if (type === WATER) this.dW[e * CODES] = 0;
    this.vL[e] = type === LAVA ? VALUE_SOURCE : VALUE_DRY;
    this.dL.fill(DIST_DRY, e * CODES, e * CODES + CODES);
    if (type === LAVA) this.dL[e * CODES] = 0;
    this.flags[e] = 0;
    return e;
  }

  /** Doubles the table and the entry arrays, rehashing the entries in their order. */
  grow(): void {
    const size = this.keys.length * 2;
    this.keys = new Int32Array(size).fill(-1);
    this.ids = new Int32Array(size);
    this.mask = size - 1;
    this.shift = Math.clz32(size) + 1;
    for (let e = 0; e < this.n; e++) {
      let slot = this.slotOf(this.ekey[e]!);
      while (this.keys[slot] !== -1) slot = (slot + 1) & this.mask;
      this.keys[slot] = this.ekey[e]!;
      this.ids[slot] = e;
      this.eslot[e] = slot;
    }
    const entries = size >> 1;
    this.ekey = widen(this.ekey, entries);
    this.eslot = widen(this.eslot, entries);
    this.vW = widen8(this.vW, entries);
    this.dW = widen8(this.dW, entries * CODES);
    this.vL = widen8(this.vL, entries);
    this.dL = widen8(this.dL, entries * CODES);
    this.flags = widen8(this.flags, entries);
    // The ring keeps its order, unwrapped to the front.
    const q = new Int32Array(entries);
    const qMask = this.queue.length - 1;
    for (let i = 0; i < this.qLen; i++) q[i] = this.queue[(this.qHead + i) & qMask]!;
    this.queue = q;
    this.qHead = 0;
    this.changed = new Float64Array(entries);
  }

  push(e: number): void {
    // The ring holds at most every entry once (FLAG_QUEUED), and its length equals the entry capacity.
    this.queue[(this.qHead + this.qLen) & (this.queue.length - 1)] = e;
    this.qLen++;
    this.flags[e] = this.flags[e]! | FLAG_QUEUED;
  }

  distAt(x: number, y: number, z: number): number {
    if (this.src === null || x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1 || y < Y_MIN || y >= Y_END) return -1;
    const e = this.find(this.keyOf(x, y, z));
    if (e < 0) return -1;
    if (this.vL[e]! < VALUE_DRY) return this.dL[e * CODES + this.vL[e]!]!;
    return this.vW[e]! < VALUE_DRY ? this.dW[e * CODES + this.vW[e]!]! : -1;
  }
}

function widen(a: Int32Array, length: number): Int32Array { const b = new Int32Array(length); b.set(a); return b; }
function widen8(a: Uint8Array, length: number): Uint8Array { const b = new Uint8Array(length); b.set(a); return b; }

/** A settle scratch whose table starts at `capacity` slots (a power of two at least 16; grown by doubling). */
export function createSettleScratch(capacity = 1 << 16): SettleScratch {
  return new Scratch(capacity);
}

/** The byte of a type's settled (value, unsettled), `value` < dry. */
function byteOf(type: number, value: number, unsettled: boolean): number {
  return value === VALUE_FALLING ? pack(type, 0, true, unsettled) : pack(type, value === VALUE_SOURCE ? 0 : value - 1, false, unsettled);
}

/**
 * One type's least fixed point (§4.1) into the scratch's fields of `type`; returns the pop count after `visits`, or
 * −1 when `stop()` returned true. The field arrays are read through the scratch after every `entry`, which may grow
 * them.
 */
function fixedPoint(type: number, s: Scratch, seeds: Int32Array, nSeeds: number, box: Int32Array, stop: () => boolean, visits: number): number {
  const water = type === WATER;
  const unsettled = water ? FLAG_WATER_UNSETTLED : FLAG_LAVA_UNSETTLED;
  const cap = CAP_OF(type);
  const w = s.width;
  const bx0 = box[0]!;
  const bz0 = box[1]!;
  const bx1 = box[2]! - 1;
  const bz1 = box[3]! - 1;
  for (let i = 0; i < nSeeds; i++) {
    const key = seeds[i]!;
    const x = s.x0 + (key % w);
    const z = s.z0 + (((key / w) | 0) % w);
    const y = Y_MIN + ((key / (w * w)) | 0);
    if (typeOf(s.protoFluid(x, y, z)) !== type) continue;
    const gx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0;
    const gz = z < bz0 ? bz0 - z : z > bz1 ? z - bz1 : 0;
    if (gx + gz > cap) continue;
    const e = s.entry(key, x, y, z);
    if ((s.flags[e]! & FLAG_QUEUED) === 0) s.push(e);
  }
  const rng = s.popOrder === 0 ? null : new RNG(s.popOrder);
  const out = s.offers;
  while (s.qLen > 0) {
    if ((visits & POLL_MASK) === 0 && stop()) return -1;
    visits++;
    const qMask = s.queue.length - 1;
    if (rng !== null) {
      const at = (s.qHead + rng.nextInt(s.qLen)) & qMask;
      const t = s.queue[at]!;
      s.queue[at] = s.queue[s.qHead]!;
      s.queue[s.qHead] = t;
    }
    const e = s.queue[s.qHead]!;
    s.qHead = (s.qHead + 1) & qMask;
    s.qLen--;
    const key = s.ekey[e]!;
    const x = s.x0 + (key % w);
    const z = s.z0 + (((key / w) | 0) % w);
    const y = Y_MIN + ((key / (w * w)) | 0);
    // Every Pareto pair (value k, least distance at k below every lower value's) offers along its own derivation;
    // the voxel's value is its lowest pair, whose distance is the largest, so only that pair can be at the cap.
    let best = DIST_DRY;
    let first = true;
    for (let k = 0; k < CODES; k++) {
      const dk = (water ? s.dW : s.dL)[e * CODES + k]!;
      if (dk >= best) continue;
      best = dk;
      const ret = OFFERS(type, s, x, y, z, k, dk, out);
      if (first) {
        const flags = s.flags[e]! & ~FLAG_QUEUED;
        s.flags[e] = (ret & OFFERS_CAP) !== 0 ? flags | unsettled : flags & ~unsettled;
        first = false;
      }
      const count = ret & OFFERS_COUNT;
      for (let o = 0; o < count * 5; o += 5) {
        const tx = x + out[o]!;
        const ty = y + out[o + 1]!;
        const tz = z + out[o + 2]!;
        const t = s.entry(s.keyOf(tx, ty, tz), tx, ty, tz);
        const vs = water ? s.vW : s.vL;
        const ds = water ? s.dW : s.dL;
        const v = out[o + 3]!;
        const d = out[o + 4]!;
        let least = DIST_DRY;
        for (let j = 0; j <= v; j++) if (ds[t * CODES + j]! < least) least = ds[t * CODES + j]!;
        if (d >= least) continue;
        ds[t * CODES + v] = d;
        if (v < vs[t]!) vs[t] = v;
        if ((s.flags[t]! & FLAG_QUEUED) === 0) s.push(t);
      }
    }
    if (first) s.flags[e] = s.flags[e]! & ~FLAG_QUEUED;
  }
  return visits;
}

/**
 * Settles water and lava over the window `src` from `seeds` (world voxels packed `((y + 64)·W + (z − z0))·W +
 * (x − x0)`, W = x1 − x0; the window must be square with W ≤ 2,364, so a packed key fits an Int32, or it throws) and
 * writes to `out` every voxel of `box` (`[bx0, bz0, bx1, bz1]`, bx0 ≤ x < bx1, bz0 ≤ z < bz1, every y) whose merged
 * byte differs from its proto byte (SP7a spec §4.1, D22). Returns the pops (each applies `ruleOffers` once per
 * spreading value, rulings R9), or −1 when `stop()` returned true (polled before the first pop and once per 1,024
 * pops), in which case `out` receives nothing.
 */
export function settleWindow(
  src: SettleSource, seeds: Int32Array, nSeeds: number, box: Int32Array, out: SettleSink, s: SettleScratch, stop: () => boolean,
  modes: ArrayLike<number> = MODES,
): number {
  const width = src.x1 - src.x0;
  if (src.z1 - src.z0 !== width || Y_SPAN * width * width > MAX_KEYS) {
    throw new Error(`settleWindow: the window must be square with W ≤ 2,364, got ${width} × ${src.z1 - src.z0}`);
  }
  const sc = s as Scratch;
  sc.clear();
  sc.src = src;
  sc.modes = modes;
  sc.x0 = src.x0;
  sc.z0 = src.z0;
  sc.x1 = src.x1;
  sc.z1 = src.z1;
  sc.width = width;
  let visits = fixedPoint(WATER, sc, seeds, nSeeds, box, stop, 0);
  if (visits < 0) return -1;
  visits = fixedPoint(LAVA, sc, seeds, nSeeds, box, stop, visits);
  if (visits < 0) return -1;
  // The merge, over the entries inside the box; unvisited voxels keep their proto byte.
  const bx0 = box[0]!;
  const bz0 = box[1]!;
  const bx1 = box[2]!;
  const bz1 = box[3]!;
  const w = sc.width;
  let nChanged = 0;
  for (let e = 0; e < sc.n; e++) {
    const key = sc.ekey[e]!;
    const x = sc.x0 + (key % w);
    const z = sc.z0 + (((key / w) | 0) % w);
    if (x < bx0 || x >= bx1 || z < bz0 || z >= bz1) continue;
    const vw = sc.vW[e]!;
    const vl = sc.vL[e]!;
    const flags = sc.flags[e]!;
    let byte: number;
    if (vl < VALUE_DRY) byte = byteOf(LAVA, vl, vw < VALUE_DRY || (flags & FLAG_LAVA_UNSETTLED) !== 0);
    else if (vw < VALUE_DRY) byte = byteOf(WATER, vw, (flags & FLAG_WATER_UNSETTLED) !== 0);
    else continue;
    const y = Y_MIN + ((key / (w * w)) | 0);
    if (byte === src.fluid(x, y, z)) continue;
    sc.changed[nChanged++] = key * 256 + byte;
  }
  const changed = sc.changed.subarray(0, nChanged).sort();
  for (let i = 0; i < nChanged; i++) {
    const c = changed[i]!;
    const key = Math.floor(c / 256);
    out.set(sc.x0 + (key % w), Y_MIN + ((key / (w * w)) | 0), sc.z0 + (((key / w) | 0) % w), c - key * 256);
  }
  return visits;
}

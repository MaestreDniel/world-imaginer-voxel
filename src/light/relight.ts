/**
 * Incremental relight after one voxel edit (SP5a spec §2.3, D19; master §4.8), over an injected accessor of the
 * edited column's 3 × 3 (local x, z 0 … 47, rows y + 64 in 0 … 383). Per channel (block, then sky):
 * 1. sky only: where the edit moved the column's `LIGHT_BLOCKING`, the straight fall is re-seeded: a closing removes
 *    the rows it no longer enters (15 each), an opening sets the rows it now enters to 15;
 * 2. the edited voxel is removed when its old light can no longer hold (higher effective opacity, a full face added,
 *    or, for block light, a lower emission);
 * 3. the removal BFS: a neighbour lit below the level it was removed from is zeroed in turn, one lit at or above it
 *    is the re-add frontier (the classic two-ring relight);
 * 4. the re-add BFS from that frontier and from the new sources (an emitter, an opened voxel's neighbours, the top
 *    row's seed from above y 319), with `propagate`'s step rule (`initial.ts`): never across a full face of either
 *    voxel, cost max(1, effective opacity), strict increase only.
 * The result equals a full `lightRegion` of each column of the 3 × 3: a change reaches at most 14 voxels from the
 * edited voxel or its light column, so an edit in the centre column never reaches the 3 × 3's sides.
 */
import { AIR } from '../world/blocks/index';
import { FACE_DOWN, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_UP, FACE_WEST } from '../world/blocks/kinds';
import { DEFAULT_LIGHT_TABLES as REGISTRY_TABLES, effEmit, effOpacity, type LightTables } from '../world/blocks/light';

// Imported values are read through top-level aliases (the hot-import rule; `initial.ts`).
const AIR_STATE = AIR;
const NORTH = FACE_NORTH;
const EAST = FACE_EAST;
const SOUTH = FACE_SOUTH;
const WEST = FACE_WEST;
const UP = FACE_UP;
const DOWN = FACE_DOWN;
const TABLES = REGISTRY_TABLES;
const EFF_OPACITY = effOpacity;
const EFF_EMIT = effEmit;

/** The 3 × 3's local grid: +1 per x, +48 per z, +48² per row. */
const W = 48;
const H = 384;
const SZ = W;
const SY = W * W;
const VOXELS = SY * H;
/** Ring entries (2²⁰ ≥ the 3 × 3's 884,736 voxels). */
const RING = 1 << 20;
const RING_MASK = RING - 1;

const N_BIT = 1 << NORTH; // −z
const E_BIT = 1 << EAST; // +x
const S_BIT = 1 << SOUTH; // +z
const W_BIT = 1 << WEST; // −x
const U_BIT = 1 << UP; // +y
const D_BIT = 1 << DOWN; // −y

/** `RelightReport.edges` bits. */
export const EDGE_W = 1;
export const EDGE_E = 2;
export const EDGE_N = 4;
export const EDGE_S = 8;
export const EDGE_NW = 16;
export const EDGE_NE = 32;
export const EDGE_SW = 64;
export const EDGE_SE = 128;

/**
 * The edited column's 3 × 3, voxel `i = (row·48 + z)·48 + x` (x, z 0 … 47, row = y + 64 in 0 … 383), after the edit.
 * `lightBlocking` is the row of the column's `LIGHT_BLOCKING` (0 … 384, `rowOf` in `initial.ts`); `setLight` writes
 * the light byte (sky << 4 | block) and marks its column's section dirty.
 */
export interface RelightAccess {
  block(i: number): number;
  fluid(i: number): number;
  light(i: number): number;
  setLight(i: number, v: number): void;
  lightBlocking(x: number, z: number): number;
}

/**
 * Per column of the 3 × 3 (index dz·3 + dx), where a voxel's final light differs from its light before the edit:
 * `sections` bit sy, and `edges` the borders and corners that voxel lies on (`EDGE_*`; the remesh set, §2.6).
 */
export interface RelightReport {
  readonly sections: Uint32Array;
  readonly edges: Uint8Array;
}

/** The relight's reusable state (one per sim worker). */
export interface RelightScratch {
  /** The removal ring, `index << 4 | old level`: each voxel at most once per channel, read again for the report. */
  readonly removal: Int32Array;
  /** The re-add ring, `index << 4 | level`: a source's level, or 0 for a frontier voxel that keeps its current one. */
  readonly readd: Int32Array;
  /** One bit per voxel removed by the current channel (cleared before the next). */
  readonly removed: Uint8Array;
  /** The report `relight` returns, rewritten by each call. */
  readonly report: RelightReport;
}

/** Two 4 MB rings, a 128 KB removal bitset and the 9-column report. */
export function createRelightScratch(): RelightScratch {
  return {
    removal: new Int32Array(RING),
    readd: new Int32Array(RING),
    removed: new Uint8Array(RING >> 3),
    report: { sections: new Uint32Array(9), edges: new Uint8Array(9) },
  };
}

/** The voxel's state and fluid before the edit, and its column's `LIGHT_BLOCKING` row before the edit. */
export interface RelightBefore {
  readonly state: number;
  readonly fluid: number;
  readonly lightBlocking: number;
}

// One channel's run state: a relight runs to completion on one thread, so the ring cursors live here.
let acc: RelightAccess;
let scr: RelightScratch;
let tab: LightTables;
let shift = 0;
let keep = 0;
/** The edited voxel, whose crossings are open when open before or after the edit. */
let edited = -1;
/** Its `FULL_FACES` before and after, intersected (a face closed in both worlds). */
let editedFull = 0;
let rLen = 0;
let aHead = 0;
let aLen = 0;

const levelOf = (v: number): number => (acc.light(v) >> shift) & 15;

function setLevel(v: number, l: number): void {
  acc.setLight(v, (acc.light(v) & keep) | (l << shift));
}

function pushA(e: number): void {
  if (aLen === RING) throw new Error(`relight queue overflow (capacity ${RING})`);
  scr.readd[(aHead + aLen) & RING_MASK] = e;
  aLen++;
}

/** The light a top-row voxel takes from the air above y 319 (`initial.ts`'s seed), 0 when the crossing is closed. */
function topSeed(v: number): number {
  const full = tab.fullFaces;
  const b = acc.block(v);
  if ((full[AIR_STATE]! & D_BIT) !== 0 || (full[b]! & U_BIT) !== 0) return 0;
  const op = EFF_OPACITY(b, acc.fluid(v), tab);
  const nl = 15 - (op > 1 ? op : 1);
  return nl > 0 ? nl : 0;
}

/** Records voxel `v` as changed in the report. */
function mark(v: number): void {
  const row = (v / W) | 0;
  const x = v - row * W;
  const y = (row / W) | 0;
  const z = row - y * W;
  const c = (z >> 4) * 3 + (x >> 4);
  const lx = x & 15;
  const lz = z & 15;
  const rep = scr.report;
  rep.sections[c] = rep.sections[c]! | (1 << (y >> 4));
  let e = lx === 0 ? EDGE_W : lx === 15 ? EDGE_E : 0;
  if (lz === 0) e |= EDGE_N | (lx === 0 ? EDGE_NW : lx === 15 ? EDGE_NE : 0);
  else if (lz === 15) e |= EDGE_S | (lx === 0 ? EDGE_SW : lx === 15 ? EDGE_SE : 0);
  rep.edges[c] = rep.edges[c]! | e;
}

/**
 * Zeroes `v` (lit `lv` > 0), queues it on the removal ring and re-queues its own sources: a block-light emitter's
 * emission, a top-row voxel's seed from above.
 */
function remove(v: number, lv: number): void {
  setLevel(v, 0);
  scr.removed[v >> 3] = scr.removed[v >> 3]! | (1 << (v & 7));
  scr.removal[rLen++] = (v << 4) | lv;
  if (shift === 0) {
    const e = EFF_EMIT(acc.block(v), acc.fluid(v), tab);
    if (e > 0) pushA((v << 4) | e);
  } else if (v >= (H - 1) * SY) {
    const s = topSeed(v);
    if (s > 0) pushA((v << 4) | s);
  }
}

/** A removal step from u (removed at `lu`) into its neighbour n across the face whose bit on n's side is `opp`. */
function removeInto(n: number, lu: number, opp: number): void {
  if ((tab.fullFaces[acc.block(n)]! & opp) !== 0) return;
  const ln = levelOf(n);
  if (ln === 0) return;
  // A fall voxel reads 15, never below lu: the straight fall is never removed.
  if (ln < lu) remove(n, ln);
  else pushA(n << 4);
}

function removeAround(u: number, lu: number): void {
  const fu = u === edited ? editedFull : tab.fullFaces[acc.block(u)]!;
  const row = (u / W) | 0;
  const x = u - row * W;
  const y = (row / W) | 0;
  const z = row - y * W;
  if (z > 0 && (fu & N_BIT) === 0) removeInto(u - SZ, lu, S_BIT);
  if (x < W - 1 && (fu & E_BIT) === 0) removeInto(u + 1, lu, W_BIT);
  if (z < W - 1 && (fu & S_BIT) === 0) removeInto(u + SZ, lu, N_BIT);
  if (x > 0 && (fu & W_BIT) === 0) removeInto(u - 1, lu, E_BIT);
  if (y < H - 1 && (fu & U_BIT) === 0) removeInto(u + SY, lu, D_BIT);
  if (y > 0 && (fu & D_BIT) === 0) removeInto(u - SY, lu, U_BIT);
}

/** A re-add step: light of level `lu` entering n across the face whose bit on n's side is `opp`. */
function enter(n: number, lu: number, opp: number): void {
  const bn = acc.block(n);
  if ((tab.fullFaces[bn]! & opp) !== 0) return;
  const op = EFF_OPACITY(bn, acc.fluid(n), tab);
  const nl = lu - (op > 1 ? op : 1);
  if (nl <= levelOf(n)) return;
  setLevel(n, nl);
  if ((scr.removed[n >> 3]! & (1 << (n & 7))) === 0) mark(n);
  pushA((n << 4) | nl);
}

function propagate(): void {
  const full = tab.fullFaces;
  const ring = scr.readd;
  while (aLen > 0) {
    const e = ring[aHead]!;
    aHead = (aHead + 1) & RING_MASK;
    aLen--;
    const v = e >> 4;
    let lv = levelOf(v);
    const assign = e & 15;
    if (assign > lv) {
      setLevel(v, assign);
      if ((scr.removed[v >> 3]! & (1 << (v & 7))) === 0) mark(v);
      lv = assign;
    }
    if (lv <= 1) continue;
    const fv = full[acc.block(v)]!;
    const row = (v / W) | 0;
    const x = v - row * W;
    const y = (row / W) | 0;
    const z = row - y * W;
    if (z > 0 && (fv & N_BIT) === 0) enter(v - SZ, lv, S_BIT);
    if (x < W - 1 && (fv & E_BIT) === 0) enter(v + 1, lv, W_BIT);
    if (z < W - 1 && (fv & S_BIT) === 0) enter(v + SZ, lv, N_BIT);
    if (x > 0 && (fv & W_BIT) === 0) enter(v - 1, lv, E_BIT);
    if (y < H - 1 && (fv & U_BIT) === 0) enter(v + SY, lv, D_BIT);
    if (y > 0 && (fv & D_BIT) === 0) enter(v - SY, lv, U_BIT);
  }
}

/** Queues the six neighbours of `v` as re-add frontier voxels. */
function frontierAround(v: number): void {
  const row = (v / W) | 0;
  const x = v - row * W;
  const y = (row / W) | 0;
  const z = row - y * W;
  if (z > 0) pushA((v - SZ) << 4);
  if (x < W - 1) pushA((v + 1) << 4);
  if (z < W - 1) pushA((v + SZ) << 4);
  if (x > 0) pushA((v - 1) << 4);
  if (y < H - 1) pushA((v + SY) << 4);
  if (y > 0) pushA((v - SY) << 4);
}

/** One channel (`sh` 0 block, 4 sky) of `relight`; `oldLevel` is the edited voxel's level before the edit. */
function channel(i: number, before: RelightBefore, sh: number, oldLevel: number): void {
  shift = sh;
  keep = ~(15 << sh) & 0xFF;
  rLen = 0;
  aHead = 0;
  aLen = 0;
  const sky = sh === 4;
  const full = tab.fullFaces;
  const state = acc.block(i);
  const fl = acc.fluid(i);
  const oldOp = EFF_OPACITY(before.state, before.fluid, tab);
  const newOp = EFF_OPACITY(state, fl, tab);
  const oldFull = full[before.state]!;
  const newFull = full[state]!;
  const newEmit = sky ? 0 : EFF_EMIT(state, fl, tab);
  const weaker = newOp > oldOp || (newFull & ~oldFull) !== 0 || (!sky && newEmit < EFF_EMIT(before.state, before.fluid, tab));
  const opened = newOp < oldOp || (oldFull & ~newFull) !== 0;
  edited = i;
  editedFull = oldFull & newFull;

  const row = (i / W) | 0;
  const x = i - row * W;
  const y = (row / W) | 0;
  const z = row - y * W;
  let fall = false;
  if (sky) {
    // The straight fall's re-seed between the old and the new LIGHT_BLOCKING of the edited light column.
    const from = before.lightBlocking;
    const to = acc.lightBlocking(x, z);
    const p = z * W + x;
    for (let r = from; r < to; r++) {
      const v = r * SY + p;
      const lv = levelOf(v);
      if (lv > 0) remove(v, lv);
    }
    for (let r = to; r < from; r++) {
      const v = r * SY + p;
      if (levelOf(v) !== 15) {
        setLevel(v, 15);
        mark(v);
      }
      pushA((v << 4) | 15);
    }
    fall = y >= to;
  }
  if (weaker) {
    if (fall) {
      // The edited voxel stays 15 in the fall; what it lit across a face it now closes is removed all the same.
      removeAround(i, oldLevel);
    } else {
      const cur = levelOf(i);
      if (cur > 0) remove(i, cur);
    }
  }
  if (opened) {
    // An opened voxel takes light from its neighbours and passes its own on through the faces it opened.
    frontierAround(i);
    pushA(i << 4);
  }
  if (newEmit > 0) pushA((i << 4) | newEmit);
  if (sky && y === H - 1 && !fall) {
    const s = topSeed(i);
    if (s > 0) pushA((i << 4) | s);
  }

  // The removal BFS: the ring is read in order while it grows, never wrapping (each voxel is zeroed once).
  for (let k = 0; k < rLen; k++) {
    const e = scr.removal[k]!;
    removeAround(e >> 4, e & 15);
  }
  propagate();

  // A removed voxel changed when its final level differs from the one it was removed at.
  const bits = scr.removed;
  for (let k = 0; k < rLen; k++) {
    const e = scr.removal[k]!;
    const v = e >> 4;
    bits[v >> 3] = 0;
    if (levelOf(v) !== (e & 15)) mark(v);
  }
}

/**
 * Relights the 3 × 3 after the voxel at `i` was written (its new state and fluid read through `a`, the column's new
 * `LIGHT_BLOCKING` through `a.lightBlocking`); `before` holds the voxel's state and fluid and the column's
 * `LIGHT_BLOCKING` row before the edit. Returns `s.report`.
 */
export function relight(a: RelightAccess, s: RelightScratch, i: number, before: RelightBefore, t: LightTables = TABLES): RelightReport {
  if ((i | 0) !== i || i < 0 || i >= VOXELS) throw new RangeError(`relight: voxel ${i} outside the 3 × 3 (0 … ${VOXELS - 1})`);
  if ((before.lightBlocking | 0) !== before.lightBlocking || before.lightBlocking < 0 || before.lightBlocking > H) {
    throw new RangeError(`relight: lightBlocking row ${before.lightBlocking} outside 0 … ${H}`);
  }
  acc = a;
  scr = s;
  tab = t;
  s.report.sections.fill(0);
  s.report.edges.fill(0);
  const old = a.light(i);
  channel(i, before, 0, old & 15);
  channel(i, before, 4, (old >> 4) & 15);
  return s.report;
}

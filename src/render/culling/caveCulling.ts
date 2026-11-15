/**
 * Cave culling's walk (SP6b spec §8.1-§8.2, D22): a pure module (no three import, so Node's R3 runs the same code)
 * over a 64² column torus of 24 sections each, slot `torusSlot(cx, cz)·24 + sy`. Each slot's column holds its sections'
 * `connectivity15` values (`src/mesh/connectivity.ts`), copied on a reveal or a swap and dropped on a retire.
 *
 * The walk starts from the seed box, the 3 × 3 × 3 sections around S0, each seeded with every face an exit (even an
 * opaque one: the eye may sit inside a voxel in flight). Popping section t, it exits through every face g that
 * `conn[t]` joins to a face it was entered through (at most 5 bit tests per entered face), under the monotone rule
 * relative to the box: +x only if sx ≥ S0x − 1, −x only if sx ≤ S0x + 1, likewise y and z. Every section a straight
 * ray from any eye in the box reaches is then reached (§8.2). Each section keeps the set of faces it was entered
 * through; a section already popped is pushed again when a face it lacks arrives (a later entry face may have other
 * exits), so a section outside the box is popped at most 3 + (the axes on which it lies in S0's plane) ≤ 5 times and a
 * seed-box section once (the plan's Spec correction 22). A column within range that is not revealed, or whose slot
 * holds no connectivity, reads fully open (0x7FFF): it draws nothing and the player sees through it. A column out of
 * range stops the walk; nothing above section 23 or below 0 is stepped into. Each reached section is stamped with the
 * walk's id. The queue is a ring over `queue` holding a section at most once while it waits; `entry` holds its entered
 * faces (bits 0-5) and its waiting flag (bit 6), valid only where `entryWalk` equals the walk's id, so nothing is
 * cleared per walk and nothing is allocated after `newCaveWalk`.
 */
import { connectivityBit } from '../../mesh/connectivity';

/** Sections per column, columns per torus side (a power of two) and the arrays' lengths. */
const SECTIONS = 24;
const SIDE = 64;
const SLOTS = SIDE * SIDE;
const CELLS = SLOTS * SECTIONS;
/** Every face (north −z, east +x, south +z, west −x, up +y, down −y; bit = face index). */
const ALL_FACES = 0x3F;
/** Every pair joined: an unrevealed or unknown section. */
const OPEN = 0x7FFF;
/** `entry`'s flag: the section waits in the queue. */
const WAITING = 0x40;
/** Torus offsets from S0 stay within ±(half the side − 1), so a slot decodes to one column. */
const REACH = SIDE / 2 - 1;

/** Per face: the step out through it and the face the neighbour is entered by. */
const STEP_X = Int8Array.of(0, 1, 0, -1, 0, 0);
const STEP_Y = Int8Array.of(0, 0, 0, 0, 1, -1);
const STEP_Z = Int8Array.of(-1, 0, 1, 0, 0, 0);
const ENTERS = Uint8Array.of(4, 8, 1, 2, 32, 16);
/** `PAIR[f·6 + g]`: the `connectivity15` bit joining faces f and g (0 when f = g). */
const PAIR = new Uint16Array(36);
for (let f = 0; f < 6; f++) for (let g = 0; g < 6; g++) if (f !== g) PAIR[f * 6 + g] = 1 << connectivityBit(f, g);

/** The torus slot of column (cx, cz): its low 6 bits on each axis. */
export const torusSlot = (cx: number, cz: number): number => ((cz & 63) << 6) | (cx & 63);

export interface CaveWalk {
  /** `connectivity15` per section, slot·24 + sy (98,304). */
  readonly conn: Uint16Array;
  /** The `columnKey` owning each slot, NaN when empty (4,096). */
  readonly slotKey: Float64Array;
  /** Per section: the faces entered (bits 0-5) and the waiting flag (bit 6), valid where `entryWalk` is the walk's id. */
  readonly entry: Uint8Array;
  readonly entryWalk: Uint32Array;
  /** The ring of waiting sections, from `qHead`, `qSize` long. */
  readonly queue: Int32Array;
  /** The id of the walk that last reached each section. */
  readonly stamp: Uint32Array;
  /** The walk in progress or last run (0 before the first). */
  walkId: number;
  running: boolean;
  /** S0, the seed box's centre section, written by `startWalk` and read by the monotone rule. */
  s0x: number;
  s0y: number;
  s0z: number;
  qHead: number;
  qSize: number;
}

export function newCaveWalk(): CaveWalk {
  return {
    conn: new Uint16Array(CELLS).fill(OPEN), slotKey: new Float64Array(SLOTS).fill(Number.NaN), entry: new Uint8Array(CELLS),
    entryWalk: new Uint32Array(CELLS), queue: new Int32Array(CELLS), stamp: new Uint32Array(CELLS),
    walkId: 0, running: false, s0x: 0, s0y: 0, s0z: 0, qHead: 0, qSize: 0,
  };
}

/**
 * Copies column (cx, cz)'s 24 `connectivity15` values into its slot, owned by `key` from now on. True when some section
 * gains a bit it lacked; a column the slot did not hold read open before, so its first copy gains nothing.
 */
export function setColumnConn(w: CaveWalk, key: number, cx: number, cz: number, conn: Uint16Array): boolean {
  if (conn.length < SECTIONS) throw new RangeError(`setColumnConn: ${conn.length} sections, expected ${SECTIONS}`);
  const slot = torusSlot(cx, cz);
  const base = slot * SECTIONS;
  const held = w.slotKey[slot] === key;
  let gained = false;
  for (let sy = 0; sy < SECTIONS; sy++) {
    const v = conn[sy]!;
    if (held && (v & ~w.conn[base + sy]!) !== 0) gained = true;
    w.conn[base + sy] = v;
  }
  w.slotKey[slot] = key;
  return gained;
}

/** Drops column (cx, cz) from its slot if `key` still owns it; its sections read open again. */
export function clearColumn(w: CaveWalk, key: number, cx: number, cz: number): void {
  const slot = torusSlot(cx, cz);
  if (w.slotKey[slot] !== key) return;
  w.slotKey[slot] = Number.NaN;
  w.conn.fill(OPEN, slot * SECTIONS, slot * SECTIONS + SECTIONS);
}

/** Merges entry face bit `bit` into section `c`, stamping it on its first entry and queueing it unless it waits. */
function enter(w: CaveWalk, c: number, bit: number): void {
  const id = w.walkId;
  if (w.entryWalk[c] !== id) {
    w.entryWalk[c] = id;
    w.stamp[c] = id;
    w.entry[c] = bit | WAITING;
  } else {
    const e = w.entry[c]!;
    if ((e & bit) !== 0) return;
    w.entry[c] = e | bit | WAITING;
    if ((e & WAITING) !== 0) return;
  }
  let t = w.qHead + w.qSize;
  if (t >= CELLS) t -= CELLS;
  w.queue[t] = c;
  w.qSize++;
}

/**
 * Starts a walk seeded with the 3 × 3 × 3 sections around (sx, sy, sz) that lie in range and within sections 0-23,
 * each entered by every face. A walk in progress is abandoned.
 */
export function startWalk(w: CaveWalk, sx: number, sy: number, sz: number, inRange: (cx: number, cz: number) => boolean): void {
  w.walkId = (w.walkId + 1) >>> 0 || 1;
  w.s0x = sx;
  w.s0y = sy;
  w.s0z = sz;
  w.qHead = 0;
  w.qSize = 0;
  w.running = true;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!inRange(sx + dx, sz + dz)) continue;
      const base = torusSlot(sx + dx, sz + dz) * SECTIONS;
      for (let y = sy - 1; y <= sy + 1; y++) if (y >= 0 && y < SECTIONS) enter(w, base + y, ALL_FACES);
    }
  }
}

/**
 * Pops up to `maxPops` sections of the walk in progress; true when the walk has completed (its queue is empty), and
 * then `running` is false. A walk not running reads completed.
 */
export function stepWalk(
  w: CaveWalk, maxPops: number, inRange: (cx: number, cz: number) => boolean, isRevealed: (cx: number, cz: number) => boolean,
): boolean {
  if (!w.running) return true;
  const conn = w.conn;
  const slotKey = w.slotKey;
  const entry = w.entry;
  const queue = w.queue;
  const s0x = w.s0x;
  const s0y = w.s0y;
  const s0z = w.s0z;
  const tx0 = s0x & 63;
  const tz0 = s0z & 63;
  for (let pops = 0; pops < maxPops && w.qSize > 0; pops++) {
    const c = queue[w.qHead]!;
    w.qHead = w.qHead + 1 === CELLS ? 0 : w.qHead + 1;
    w.qSize--;
    const entered = entry[c]! & ALL_FACES;
    entry[c] = entered;
    const slot = (c / SECTIONS) | 0;
    const sy = c - slot * SECTIONS;
    // Offsets from S0, decoded from the torus (the walk never strays REACH or more from S0 on x or z).
    const dx = (((slot & 63) - tx0 + 32) & 63) - 32;
    const dz = (((slot >> 6) - tz0 + 32) & 63) - 32;
    const dy = sy - s0y;
    const cx = s0x + dx;
    const cz = s0z + dz;
    let exits = ALL_FACES;
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || dz < -1 || dz > 1) {
      const known = slotKey[slot] === slotKey[slot] && isRevealed(cx, cz);
      const k = known ? conn[c]! : OPEN;
      exits = 0;
      for (let f = 0; f < 6; f++) {
        if ((entered & (1 << f)) === 0) continue;
        const row = f * 6;
        for (let g = 0; g < 6; g++) if ((k & PAIR[row + g]!) !== 0) exits |= 1 << g;
      }
    }
    // The monotone rule relative to the box, the section range and the torus reach.
    if (dx < -1) exits &= ~2;
    if (dx > 1) exits &= ~8;
    if (dz < -1) exits &= ~4;
    if (dz > 1) exits &= ~1;
    if (dy < -1 || sy === SECTIONS - 1) exits &= ~16;
    if (dy > 1 || sy === 0) exits &= ~32;
    if (dx >= REACH) exits &= ~2;
    if (dx <= -REACH) exits &= ~8;
    if (dz >= REACH) exits &= ~4;
    if (dz <= -REACH) exits &= ~1;
    for (let g = 0; g < 6; g++) {
      if ((exits & (1 << g)) === 0) continue;
      const gx = STEP_X[g]!;
      const gz = STEP_Z[g]!;
      if ((gx !== 0 || gz !== 0) && !inRange(cx + gx, cz + gz)) continue;
      const n = gx === 0 && gz === 0 ? c + STEP_Y[g]! : torusSlot(cx + gx, cz + gz) * SECTIONS + sy;
      enter(w, n, ENTERS[g]!);
    }
  }
  if (w.qSize > 0) return false;
  w.running = false;
  return true;
}

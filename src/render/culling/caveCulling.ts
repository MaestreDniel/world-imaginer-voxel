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
 *
 * The culler (`createCaveCuller`, §8.2) drives the walk from the renderer's events and frames. A section is drawn when
 * `drawAll` is set or its stamp is at least `shown`, the last completed walk's id, so a half-done walk never hides what
 * the previous one showed and a revealed or swapped column (stamped with the current walk's id) draws until a walk that
 * saw it completes. Triggers: (1) the camera's section differs from the last walk's S0: a walk after the one in
 * progress; `drawAll` when the camera leaves the last completed walk's box; (2) a swap adding a bit: `drawAll` and a
 * walk (a swap only removing bits owes a walk, never `drawAll`); (3) reveals: a walk when none runs, at most every
 * 250 ms while they arrive and once a frame passes with none (drained). No walk, and `drawAll`, while the eye is outside
 * y −64 … 319, the X-ray is on, the hold is on (warmUp and held reveals, ruling P45), culling is disabled or no camera
 * is known; leaving any of these owes a walk. `drawAll` clears when a walk completes whose box holds the camera's
 * section and that started after the last trigger that set it. A column within RD (`dx² + dz² ≤ (rd + 0.5)²` from S0,
 * the MESH disc of `src/engine/rings.ts`) or held in its slot is in range.
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

/** The eye's y range in blocks: sections 0-23 span −64 … 319. */
const Y_MIN = -64;
const Y_END = Y_MIN + SECTIONS * 16;
/** The range before `setRadius`: `RD_MAX` (`src/engine/renderDistance.ts:10`, which render cannot import). */
const RD_DEFAULT = 16;
/** Reveals start a walk at most this often while they arrive (§8.2's trigger 3). */
const REVEAL_WALK_MS = 250;
/** The slice polls its clock every this many pops (§8.2's budget). */
const POLL_POPS = 256;

export interface CaveCuller {
  readonly walk: CaveWalk;
  /** Everything draws: the last completed walk does not cover the eye, a path opened, or culling is off. */
  drawAll: boolean;
  /** The id of the last completed walk. */
  shown: number;
  /** The bench's switch (`setCulling`); false draws everything and walks nothing. */
  enabled: boolean;
  /** The camera's world position (floating origin plus `camera.position`). */
  setCamera(x: number, y: number, z: number): void;
  setRadius(rd: number): void;
  setXray(on: boolean): void;
  /** Ruling P45: while held (warmUp, held reveals) everything draws and no walk starts. */
  setHold(on: boolean): void;
  onReveal(key: number, cx: number, cz: number, conn: Uint16Array): void;
  onSwap(key: number, cx: number, cz: number, conn: Uint16Array): void;
  onRetire(key: number, cx: number, cz: number): void;
  /**
   * Starts a walk if one is owed and none runs, then steps it: polling `clock` every 256 pops and stopping once
   * `budgetMs` has passed, or, with `clock` null, for `maxPops` pops. A completion starts the next owed walk.
   */
  frame(nowMs: number, maxPops: number, clock: (() => number) | null, budgetMs: number): void;
  /** Section `torusSlot(cx, cz)·24 + sy` is drawn. */
  drawnAt(section: number): boolean;
  drawn(cx: number, sy: number, cz: number): boolean;
}

export function createCaveCuller(): CaveCuller {
  const walk = newCaveWalk();
  const stamp = walk.stamp;
  const slotKey = walk.slotKey;
  /** The column each held slot belongs to (a slot's key alone does not name it). */
  const ownerX = new Int32Array(SLOTS);
  const ownerZ = new Int32Array(SLOTS);
  let rangeLim = (RD_DEFAULT + 0.5) * (RD_DEFAULT + 0.5);
  let rd = RD_DEFAULT;
  /** The camera's section, once `setCamera` has run. */
  let camKnown = false;
  let camX = 0;
  let camY = 0;
  let camZ = 0;
  let eyeOut = false;
  let xray = false;
  let held = false;
  let on = true;
  let blocked = true;
  /** A walk is owed (a camera section change, a swap, a radius change, a block lifted). */
  let owed = false;
  let revealPending = false;
  let revealSinceFrame = false;
  let lastRevealWalkMs = Number.NEGATIVE_INFINITY;
  /** The first walk id whose completion may clear `drawAll`. */
  let clearFrom = 1;
  /** The last completed walk's S0. */
  let shownValid = false;
  let shownX = 0;
  let shownY = 0;
  let shownZ = 0;

  /** The slot holds column (cx, cz): it is revealed. */
  const slotHolds = (cx: number, cz: number): boolean => {
    const slot = torusSlot(cx, cz);
    const k = slotKey[slot]!;
    return k === k && ownerX[slot] === cx && ownerZ[slot] === cz;
  };
  const inRange = (cx: number, cz: number): boolean => {
    const dx = cx - walk.s0x;
    const dz = cz - walk.s0z;
    return dx * dx + dz * dz <= rangeLim || slotHolds(cx, cz);
  };
  const camInBox = (x: number, y: number, z: number): boolean =>
    camX - x <= 1 && x - camX <= 1 && camY - y <= 1 && y - camY <= 1 && camZ - z <= 1 && z - camZ <= 1;

  function markDrawAll(): void {
    c.drawAll = true;
    clearFrom = walk.walkId + 1;
  }

  /** Re-derives the block; entering it drops the walk in progress, leaving it owes a walk and keeps `drawAll`. */
  function refreshBlock(): void {
    const b = !on || xray || held || !camKnown || eyeOut;
    if (b === blocked) return;
    blocked = b;
    if (b) {
      c.drawAll = true;
      walk.running = false;
    } else {
      markDrawAll();
      owed = true;
    }
  }

  /** Copies a revealed or swapped column, stamping its sections with the current walk's id; true on a gained bit. */
  function take(key: number, cx: number, cz: number, conn: Uint16Array): boolean {
    const gained = setColumnConn(walk, key, cx, cz, conn);
    const slot = torusSlot(cx, cz);
    ownerX[slot] = cx;
    ownerZ[slot] = cz;
    stamp.fill(walk.walkId, slot * SECTIONS, slot * SECTIONS + SECTIONS);
    return gained;
  }

  function tryStart(nowMs: number): boolean {
    const revealDue = revealPending && (nowMs - lastRevealWalkMs >= REVEAL_WALK_MS || !revealSinceFrame);
    if (!owed && !revealDue) return false;
    if (revealPending) lastRevealWalkMs = nowMs;
    owed = false;
    revealPending = false;
    startWalk(walk, camX, camY, camZ, inRange);
    return true;
  }

  function complete(): void {
    c.shown = walk.walkId;
    shownValid = true;
    shownX = walk.s0x;
    shownY = walk.s0y;
    shownZ = walk.s0z;
    if (!camInBox(shownX, shownY, shownZ)) {
      markDrawAll();
      owed = true;
    } else if (walk.walkId >= clearFrom) {
      c.drawAll = false;
    }
  }

  const c: CaveCuller = {
    walk,
    drawAll: true,
    shown: 0,
    get enabled(): boolean {
      return on;
    },
    set enabled(v: boolean) {
      on = v;
      refreshBlock();
    },
    setCamera(x, y, z) {
      const sx = Math.floor(x / 16);
      const sy = Math.floor((y - Y_MIN) / 16);
      const sz = Math.floor(z / 16);
      const changed = !camKnown || sx !== camX || sy !== camY || sz !== camZ;
      camKnown = true;
      camX = sx;
      camY = sy;
      camZ = sz;
      eyeOut = !(y >= Y_MIN && y < Y_END);
      refreshBlock();
      if (!changed || blocked) return;
      if (!shownValid || !camInBox(shownX, shownY, shownZ)) markDrawAll();
      if (walk.walkId === 0 || sx !== walk.s0x || sy !== walk.s0y || sz !== walk.s0z) owed = true;
    },
    setRadius(r) {
      if (r === rd) return;
      rd = r;
      rangeLim = (r + 0.5) * (r + 0.5);
      owed = true;
    },
    setXray(v) {
      xray = v;
      refreshBlock();
    },
    setHold(v) {
      held = v;
      refreshBlock();
    },
    onReveal(key, cx, cz, conn) {
      // A newly revealed column read open before, so it only closes paths; a re-reveal that gains a bit opens one.
      if (take(key, cx, cz, conn)) {
        markDrawAll();
        owed = true;
      }
      revealPending = true;
      revealSinceFrame = true;
    },
    onSwap(key, cx, cz, conn) {
      if (take(key, cx, cz, conn)) markDrawAll();
      owed = true;
    },
    onRetire(key, cx, cz) {
      clearColumn(walk, key, cx, cz);
    },
    frame(nowMs, maxPops, clock, budgetMs) {
      if (!blocked && (walk.running || tryStart(nowMs))) {
        const t0 = clock === null ? 0 : clock();
        let pops = 0;
        let done = false;
        while (pops < maxPops) {
          const n = clock === null ? maxPops - pops : Math.min(POLL_POPS, maxPops - pops);
          done = stepWalk(walk, n, inRange, slotHolds);
          pops += n;
          if (done || (clock !== null && clock() - t0 >= budgetMs)) break;
        }
        if (done) {
          complete();
          tryStart(nowMs);
        }
      }
      revealSinceFrame = false;
    },
    drawnAt(section) {
      return c.drawAll || stamp[section]! >= c.shown;
    },
    drawn(cx, sy, cz) {
      return c.drawnAt(torusSlot(cx, cz) * SECTIONS + sy);
    },
  };
  return c;
}

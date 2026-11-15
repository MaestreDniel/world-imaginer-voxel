/**
 * Cave culling's walk (SP6b spec §8.1-§8.2, D22; §12.4's unit tests carrying the "0 wrongly culled" proof). Section
 * grids are synthetic `connectivity15` values, or computed from voxel worlds (air boxes in stone) through
 * `connectivity15` and checked against 3D DDA rays: every section a ray enters, the one where it stops included, must
 * be stamped by the walk.
 */
import { describe, expect, test } from 'vitest';
import { connectivity15, connectivityBit } from '../../src/mesh/connectivity';
import {
  clearColumn, newCaveWalk, setColumnConn, startWalk, stepWalk, torusSlot, type CaveWalk,
} from '../../src/render/culling/caveCulling';
import { AIR, STONE } from '../../src/world/blocks/index';
import { createPaddedSection, padIndex } from '../../src/world/store/padded';

/** Faces in master order. */
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;
const WEST = 3;
const UP = 4;
const DOWN = 5;
/** Per face: the step out through it. */
const STEP: ReadonlyArray<readonly [number, number, number]> = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
const OPEN = 0x7FFF;
const SECTIONS = 24;

const keyOf = (cx: number, cz: number): number => (cx + 1_048_576) * 2_097_152 + (cz + 1_048_576);
const id = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const always = (): boolean => true;
const rect = (x0: number, x1: number, z0: number, z1: number) => (cx: number, cz: number): boolean =>
  cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1;

/** The pair bits joining every two of `faces`. */
function joining(faces: readonly number[]): number {
  let bits = 0;
  for (const a of faces) for (const b of faces) if (a < b) bits |= 1 << connectivityBit(a, b);
  return bits;
}

type ConnAt = (cx: number, sy: number, cz: number) => number;

/** Loads every column of [x0, x1] × [z0, z1] with `connAt`. */
function load(w: CaveWalk, x0: number, x1: number, z0: number, z1: number, connAt: ConnAt): void {
  const col = new Uint16Array(SECTIONS);
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (let sy = 0; sy < SECTIONS; sy++) col[sy] = connAt(cx, sy, cz);
      setColumnConn(w, keyOf(cx, cz), cx, cz, col);
    }
  }
}

/** The sections the last walk stamped, in absolute section coordinates. */
function stamped(w: CaveWalk): Set<string> {
  const out = new Set<string>();
  for (let c = 0; c < w.stamp.length; c++) {
    if (w.stamp[c] !== w.walkId) continue;
    const slot = Math.floor(c / SECTIONS);
    const dx = (((slot & 63) - (w.s0x & 63) + 32) & 63) - 32;
    const dz = (((slot >> 6) - (w.s0z & 63) + 32) & 63) - 32;
    out.add(id(w.s0x + dx, c - slot * SECTIONS, w.s0z + dz));
  }
  return out;
}

/** Runs a whole walk from section `s`, in slices of 4,096 pops; the stamped sections. */
function walk(
  w: CaveWalk, s: readonly [number, number, number], inRange: (cx: number, cz: number) => boolean,
  isRevealed: (cx: number, cz: number) => boolean = always,
): Set<string> {
  startWalk(w, s[0], s[1], s[2], inRange);
  for (let slices = 0; !stepWalk(w, 4096, inRange, isRevealed); slices++) if (slices > 1000) throw new Error('walk does not complete');
  expect(w.running).toBe(false);
  return stamped(w);
}

/** The seed box around `s` and the sections one face beyond it (what every seeded face enters). */
function boxAndShell(s: readonly [number, number, number]): Set<string> {
  const out = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        out.add(id(s[0] + dx, s[1] + dy, s[2] + dz));
        for (const [x, y, z] of STEP) out.add(id(s[0] + dx + x, s[1] + dy + y, s[2] + dz + z));
      }
    }
  }
  return out;
}

// --- Voxel worlds: stone with air boxes; voxel Y = y + 64, so section sy = Y >> 4. ---

/** A half-open voxel box [x0, x1) × [y0, y1) × [z0, z1). */
type Box = readonly [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number];

const isAir = (air: readonly Box[], x: number, y: number, z: number): boolean => {
  for (const b of air) if (x >= b[0] && x < b[3] && y >= b[1] && y < b[4] && z >= b[2] && z < b[5]) return true;
  return false;
};

/** `connectivity15` of section (cx, sy, cz) of the world (the padding is never read, so it stays air). */
function sectionConn(air: readonly Box[], cx: number, sy: number, cz: number): number {
  const x0 = cx * 16;
  const y0 = sy * 16;
  const z0 = cz * 16;
  const meets = air.filter((b) => b[0] < x0 + 16 && b[3] > x0 && b[1] < y0 + 16 && b[4] > y0 && b[2] < z0 + 16 && b[5] > z0);
  if (meets.length === 0) return 0;
  if (meets.some((b) => b[0] <= x0 && b[3] >= x0 + 16 && b[1] <= y0 && b[4] >= y0 + 16 && b[2] <= z0 && b[5] >= z0 + 16)) return OPEN;
  const p = createPaddedSection();
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) p.blocks[padIndex(x, y, z)] = isAir(meets, x0 + x, y0 + y, z0 + z) ? AIR : STONE;
    }
  }
  return connectivity15(p);
}

/**
 * A 3D DDA ray from (ox, oy, oz) along (dx, dy, dz) through the world's voxels: adds every section it enters to `seen`
 * and stops at the first stone voxel (its section included) or after `maxSteps`.
 */
function castRay(air: readonly Box[], o: readonly number[], d: readonly number[], seen: Set<string>, maxSteps = 4000): void {
  const pos = [Math.floor(o[0]!), Math.floor(o[1]!), Math.floor(o[2]!)];
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    const v = d[a]!;
    if (v > 0) { step[a] = 1; tMax[a] = (pos[a]! + 1 - o[a]!) / v; tDelta[a] = 1 / v; }
    if (v < 0) { step[a] = -1; tMax[a] = (o[a]! - pos[a]!) / -v; tDelta[a] = -1 / v; }
  }
  for (let i = 0; i < maxSteps; i++) {
    if (pos[1]! < 0 || pos[1]! >= SECTIONS * 16) return;
    seen.add(id(Math.floor(pos[0]! / 16), pos[1]! >> 4, Math.floor(pos[2]! / 16)));
    if (!isAir(air, pos[0]!, pos[1]!, pos[2]!)) return;
    const a = tMax[0]! <= tMax[1]! ? (tMax[0]! <= tMax[2]! ? 0 : 2) : (tMax[1]! <= tMax[2]! ? 1 : 2);
    pos[a] = pos[a]! + step[a]!;
    tMax[a] = tMax[a]! + tDelta[a]!;
  }
}

/** Rays from `eye` toward 4³ points inside each hole voxel. */
function raysThroughHoles(air: readonly Box[], eye: readonly number[], holes: ReadonlyArray<readonly number[]>, seen: Set<string>): void {
  for (const h of holes) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          const t = [h[0]! + (i + 0.5) / 4, h[1]! + (j + 0.5) / 4, h[2]! + (k + 0.5) / 4];
          castRay(air, eye, [t[0]! - eye[0]!, t[1]! - eye[1]!, t[2]! - eye[2]!], seen);
        }
      }
    }
  }
}

/** Rays from `eye` along the six axes and `n`² cube-map directions per face. */
function raysAround(air: readonly Box[], eye: readonly number[], n: number, seen: Set<string>): void {
  for (const [x, y, z] of STEP) castRay(air, eye, [x, y, z], seen);
  for (let f = 0; f < 6; f++) {
    const [x, y, z] = STEP[f]!;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const u = ((i + 0.5) / n) * 2 - 1;
        const v = ((j + 0.5) / n) * 2 - 1;
        castRay(air, eye, x !== 0 ? [x, u, v] : y !== 0 ? [u, y, v] : [u, v, z], seen);
      }
    }
  }
}

/** The sections of `seen` the walk did not stamp. */
const missed = (seen: ReadonlySet<string>, got: ReadonlySet<string>): string[] => [...seen].filter((s) => !got.has(s));

describe('cave culling\'s walk (SP6b spec §8.1-§8.2, D22)', () => {
  test('torusSlot: the low 6 bits of cx and cz', () => {
    expect(torusSlot(0, 0)).toBe(0);
    expect(torusSlot(63, 0)).toBe(63);
    expect(torusSlot(0, 1)).toBe(64);
    expect(torusSlot(64, 64)).toBe(0);
    expect(torusSlot(-1, -1)).toBe(4095);
  });

  test('setColumnConn reports a gained bit; clearColumn drops only its own key', () => {
    const w = newCaveWalk();
    const col = new Uint16Array(SECTIONS).fill(joining([NORTH, SOUTH]));
    // A first copy gains nothing: the column read open before.
    expect(setColumnConn(w, keyOf(5, 7), 5, 7, col)).toBe(false);
    expect(w.conn[torusSlot(5, 7) * SECTIONS + 3]).toBe(joining([NORTH, SOUTH]));
    col[3] = joining([NORTH, SOUTH, UP]);
    expect(setColumnConn(w, keyOf(5, 7), 5, 7, col)).toBe(true);
    col[3] = joining([NORTH, UP]);
    expect(setColumnConn(w, keyOf(5, 7), 5, 7, col), 'a swap that only removes bits').toBe(false);
    // Another column on the same slot (64 columns away) takes it without a gain; the first's retire leaves it.
    expect(setColumnConn(w, keyOf(69, 7), 69, 7, new Uint16Array(SECTIONS).fill(OPEN))).toBe(false);
    clearColumn(w, keyOf(5, 7), 5, 7);
    expect(w.slotKey[torusSlot(5, 7)]).toBe(keyOf(69, 7));
    clearColumn(w, keyOf(69, 7), 69, 7);
    expect(Number.isNaN(w.slotKey[torusSlot(5, 7)])).toBe(true);
  });

  test('a sealed room culls everything outside', () => {
    // A room of 5 × 5 × 5 sections around the eye whose shell joins only its inner faces; outside it, open air. (A
    // smaller room cannot hold the 3 × 3 × 3 seed box, whose sections are seeded with every face an exit.)
    const s0 = [40, 12, -20] as const;
    const inRoom = (cx: number, sy: number, cz: number): boolean =>
      Math.abs(cx - s0[0]) <= 2 && Math.abs(sy - s0[1]) <= 2 && Math.abs(cz - s0[2]) <= 2;
    const w = newCaveWalk();
    load(w, s0[0] - 8, s0[0] + 8, s0[2] - 8, s0[2] + 8, (cx, sy, cz) => {
      if (!inRoom(cx, sy, cz)) return OPEN;
      const inner = [0, 1, 2, 3, 4, 5].filter((f) => inRoom(cx + STEP[f]![0], sy + STEP[f]![1], cz + STEP[f]![2]));
      return joining(inner);
    });
    const got = walk(w, s0, rect(s0[0] - 8, s0[0] + 8, s0[2] - 8, s0[2] + 8));
    expect(got.size).toBe(125);
    for (const s of got) {
      const [x, y, z] = s.split(',').map(Number) as [number, number, number];
      expect(inRoom(x, y, z), `${s} is outside the room`).toBe(true);
    }
  });

  test('an L tunnel', () => {
    // Stone everywhere but a tunnel from the seed box's east face: +x for five sections, a turn, +z for five, a wall.
    const s0 = [-3, 8, 5] as const;
    const tunnel = new Map<string, number>();
    for (let dx = 2; dx <= 6; dx++) tunnel.set(id(s0[0] + dx, s0[1], s0[2]), joining([WEST, EAST]));
    tunnel.set(id(s0[0] + 7, s0[1], s0[2]), joining([WEST, SOUTH]));
    for (let dz = 1; dz <= 5; dz++) tunnel.set(id(s0[0] + 7, s0[1], s0[2] + dz), joining([NORTH, SOUTH]));
    const w = newCaveWalk();
    const range = rect(s0[0] - 12, s0[0] + 12, s0[2] - 12, s0[2] + 12);
    load(w, s0[0] - 12, s0[0] + 12, s0[2] - 12, s0[2] + 12, (cx, sy, cz) => tunnel.get(id(cx, sy, cz)) ?? 0);
    const expected = boxAndShell(s0);
    for (const s of tunnel.keys()) expected.add(s);
    expected.add(id(s0[0] + 7, s0[1], s0[2] + 6)); // the wall at its end is entered, so seen
    const got = walk(w, s0, range);
    expect([...got].sort()).toEqual([...expected].sort());
  });

  describe('1-voxel apertures', () => {
    // The eye's room spans x −24 … the wall, the wall is the east voxel layer of section d (x = 16d + 15), and an open
    // region lies beyond it; the hole sits on the section's east face (mid-face), on an edge (also on a z boundary) or
    // on a corner (also on a y boundary). Rays from eyes across the seed box toward points inside the hole voxel.
    const S0 = [0, 12, 0] as const;
    const KINDS = { face: [200, 24], edge: [200, 31], corner: [208, 32] } as const;
    for (const d of [1, 4, 10]) {
      for (const kind of ['face', 'edge', 'corner'] as const) {
        test(`a hole at a section ${kind}, ${d} section${d > 1 ? 's' : ''} away: every section a ray through it enters is stamped`, () => {
          const xw = 16 * d + 15;
          const hole = [xw, KINDS[kind][0], KINDS[kind][1]] as const;
          const air: Box[] = [
            [-24, 160, -40, xw, 240, 56],
            [xw + 1, 120, -80, xw + 65, 280, 96],
            [hole[0], hole[1], hole[2], hole[0] + 1, hole[1] + 1, hole[2] + 1],
          ];
          const x0 = -6;
          const x1 = d + 8;
          const w = newCaveWalk();
          load(w, x0, x1, -7, 8, (cx, sy, cz) => sectionConn(air, cx, sy, cz));
          const got = walk(w, S0, rect(x0, x1, -7, 8));
          // Eyes: S0's centre, its corners and the seed box's corners, where they are air.
          const eyes: number[][] = [[8.5, 200.5, 8.5]];
          for (const [lo, hi] of [[0.01, 15.99], [-15.99, 31.99]] as const) {
            for (const x of [lo, hi]) for (const y of [lo, hi]) for (const z of [lo, hi]) eyes.push([x, 192 + y, z]);
          }
          const seen = new Set<string>();
          for (const e of eyes.filter((e) => isAir(air, Math.floor(e[0]!), Math.floor(e[1]!), Math.floor(e[2]!)) && e[0]! < xw)) {
            raysThroughHoles(air, e, [hole], seen);
            raysAround(air, e, 8, seen);
          }
          const beyond = [...seen].filter((s) => Number(s.split(',')[0]) > d);
          expect(beyond.length, 'no ray went through the hole').toBeGreaterThan(0);
          expect(missed(seen, got)).toEqual([]);
        });
      }
    }
  });

  test('unmeshed sections and unrevealed columns count as open', () => {
    const s0 = [0, 12, 0] as const;
    const range = rect(-6, 6, -6, 6);
    // Stone everywhere: the walk stamps the seed box and what its faces enter.
    const solid = newCaveWalk();
    load(solid, -6, 6, -6, 6, () => 0);
    const base = walk(solid, s0, range);
    expect([...base].sort()).toEqual([...boxAndShell(s0)].sort());
    // Column (2, 0) read open: the walk crosses it, every section of it, and enters what lies one face beyond.
    const expected = new Set(base);
    for (let sy = 0; sy < SECTIONS; sy++) for (const s of [[2, 0], [3, 0], [2, 1], [2, -1]]) expected.add(id(s[0]!, sy, s[1]!));
    const sorted = [...expected].sort();
    // (a) Not revealed: its slot's stone is not read.
    expect([...walk(solid, s0, range, (cx, cz) => cx !== 2 || cz !== 0)].sort()).toEqual(sorted);
    // (b) Revealed, its slot cleared (no connectivity held).
    const cleared = newCaveWalk();
    load(cleared, -6, 6, -6, 6, () => 0);
    clearColumn(cleared, keyOf(2, 0), 2, 0);
    expect([...walk(cleared, s0, range)].sort()).toEqual(sorted);
    // (c) Revealed with sections that hold no mesh (all air): connectivity15 reads 0x7FFF.
    const empty = connectivity15(createPaddedSection());
    expect(empty).toBe(OPEN);
    const unmeshed = newCaveWalk();
    load(unmeshed, -6, 6, -6, 6, (cx, _sy, cz) => (cx === 2 && cz === 0 ? empty : 0));
    expect([...walk(unmeshed, s0, range)].sort()).toEqual(sorted);
  });

  test('a column beyond range stops the walk', () => {
    // Everything unrevealed (open); range |cx|, |cz| ≤ 2: all 5 × 5 columns, every section, and nothing past them.
    const w = newCaveWalk();
    const got = walk(w, [0, 12, 0], rect(-2, 2, -2, 2), () => false);
    expect(got.size).toBe(5 * 5 * SECTIONS);
    for (const s of got) {
      const [x, y, z] = s.split(',').map(Number) as [number, number, number];
      expect(Math.abs(x) <= 2 && Math.abs(z) <= 2 && y >= 0 && y < SECTIONS, s).toBe(true);
    }
    // Seeded at the top section, the box's upper layer lies above section 23 and is not seeded.
    const top = walk(w, [0, 23, 0], rect(-2, 2, -2, 2), () => false);
    expect(top.size).toBe(5 * 5 * SECTIONS);
  });

  test('monotone ties at section planes: an eye on a section corner is covered by each box that holds it', () => {
    // A room of air around the eye (16, 208, 16), where 8 sections meet, walled on six sides; each wall has a 1-voxel
    // hole into an open region beyond. Each of the 8 sections the eye lies on may be S0: every walk stamps what rays
    // from the eye, and from eyes 0.01 off it into each of the 8 sections, reach along the axes, through the holes and
    // in cube-map directions.
    const corner = [16, 208, 16];
    const holes = [[40, 210, 18], [-9, 195, 3], [30, 220, 40], [5, 189, -9], [20, 232, 33], [-2, 183, 12]];
    const air: Box[] = [
      [-8, 184, -8, 40, 232, 40],
      [41, 150, -40, 81, 270, 80], [-49, 150, -40, -9, 270, 80],
      [-40, 150, 41, 80, 270, 81], [-40, 150, -49, 80, 270, -9],
      [-40, 233, -40, 80, 273, 80], [-40, 143, -40, 80, 183, 80],
      ...holes.map((h): Box => [h[0]!, h[1]!, h[2]!, h[0]! + 1, h[1]! + 1, h[2]! + 1]),
    ];
    const seen = new Set<string>();
    const eyes = [corner];
    for (const x of [-0.01, 0.01]) for (const y of [-0.01, 0.01]) for (const z of [-0.01, 0.01]) eyes.push([16 + x, 208 + y, 16 + z]);
    for (const eye of eyes) {
      raysThroughHoles(air, eye, holes, seen);
      raysAround(air, eye, 24, seen);
    }
    const outside = [...seen].filter((s) => {
      const [x, , z] = s.split(',').map(Number) as [number, number, number];
      return x < -1 || x > 2 || z < -1 || z > 2;
    });
    expect(outside.length, 'no ray left the room').toBeGreaterThan(0);
    const w = newCaveWalk();
    load(w, -5, 7, -5, 7, (cx, sy, cz) => sectionConn(air, cx, sy, cz));
    for (const sx of [0, 1]) {
      for (const sy of [12, 13]) {
        for (const sz of [0, 1]) {
          const got = walk(w, [sx, sy, sz], rect(-5, 7, -5, 7));
          expect(missed(seen, got), `S0 (${sx}, ${sy}, ${sz})`).toEqual([]);
        }
      }
    }
  });

  /** Runs a walk one pop at a time; the pops per section index. */
  function countPops(
    w: CaveWalk, s: readonly [number, number, number], inRange: (cx: number, cz: number) => boolean,
    isRevealed: (cx: number, cz: number) => boolean = always,
  ): Map<number, number> {
    const pops = new Map<number, number>();
    startWalk(w, s[0], s[1], s[2], inRange);
    for (;;) {
      if (w.qSize > 0) {
        const c = w.queue[w.qHead]!;
        pops.set(c, (pops.get(c) ?? 0) + 1);
      }
      if (stepWalk(w, 1, inRange, isRevealed)) return pops;
    }
  }

  test('the re-push of a popped section on a new entry bit', () => {
    // T = S0 + (−3, +3, 0) joins only its down and north faces. A short path enters it by −x (its east face, which
    // joins nothing), so it is popped with no exits; a longer one, zigzagging on z within the box's slack, enters it
    // by +y later: it is pushed again and exits north into U.
    const s0 = [0, 12, 0] as const;
    const at = (dx: number, dy: number, dz: number): string => id(s0[0] + dx, s0[1] + dy, s0[2] + dz);
    const conn = new Map<string, number>([
      // The short path, from the box's top: up, up, west, west.
      [at(-1, 2, 0), joining([DOWN, UP])], [at(-1, 3, 0), joining([DOWN, WEST])], [at(-2, 3, 0), joining([EAST, WEST])],
      // The long path, from the box's west face.
      [at(-2, 0, 0), joining([EAST, WEST])], [at(-3, 0, 0), joining([EAST, SOUTH])], [at(-3, 0, 1), joining([NORTH, UP])],
      [at(-3, 1, 1), joining([DOWN, NORTH])], [at(-3, 1, 0), joining([SOUTH, NORTH])], [at(-3, 1, -1), joining([SOUTH, UP])],
      [at(-3, 2, -1), joining([DOWN, SOUTH])], [at(-3, 2, 0), joining([NORTH, UP])],
      [at(-3, 3, 0), joining([DOWN, NORTH])], // T
    ]);
    const range = rect(-8, 8, -8, 8);
    const w = newCaveWalk();
    load(w, -8, 8, -8, 8, (cx, sy, cz) => conn.get(id(cx, sy, cz)) ?? 0);
    const pops = countPops(w, s0, range);
    const got = stamped(w);
    expect(got.has(at(-3, 3, -1)), 'U, north of T: exited through the +y entry\'s faces').toBe(true);
    expect(pops.get(torusSlot(-3, 0) * SECTIONS + 15)).toBe(2);
    // Without the long path, T is reached by −x only and U is never entered.
    const short = newCaveWalk();
    conn.delete(at(-2, 0, 0));
    load(short, -8, 8, -8, 8, (cx, sy, cz) => conn.get(id(cx, sy, cz)) ?? 0);
    expect(walk(short, s0, range).has(at(-3, 3, -1))).toBe(false);
  });

  test('each section outside the seed box is popped at most 3 + (the axes it shares with S0) ≤ 5 times, a seed-box section once', () => {
    // Spec correction 22: a section in S0's x plane can be entered via +x and via −x. Random grids (a fixed LCG) and an
    // open one; S0 near a torus wrap.
    const s0 = [62, 11, -1] as const;
    const range = rect(s0[0] - 6, s0[0] + 6, s0[2] - 6, s0[2] + 6);
    let seed = 12345;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let most = 0;
    for (let run = 0; run < 6; run++) {
      const w = newCaveWalk();
      const p = run === 0 ? 1 : 0.3 + run * 0.1;
      load(w, s0[0] - 6, s0[0] + 6, s0[2] - 6, s0[2] + 6, () => {
        let bits = 0;
        for (let b = 0; b < 15; b++) if (rnd() < p) bits |= 1 << b;
        return bits;
      });
      const pops = countPops(w, s0, range);
      for (const [c, n] of pops) {
        const slot = Math.floor(c / SECTIONS);
        const dx = (((slot & 63) - (s0[0] & 63) + 32) & 63) - 32;
        const dz = (((slot >> 6) - (s0[2] & 63) + 32) & 63) - 32;
        const dy = c - slot * SECTIONS - s0[1];
        const inBox = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1;
        const bound = inBox ? 1 : 3 + (dx === 0 ? 1 : 0) + (dy === 0 ? 1 : 0) + (dz === 0 ? 1 : 0);
        expect(n, `section (${dx}, ${dy}, ${dz}) from S0`).toBeLessThanOrEqual(bound);
        if (!inBox) most = Math.max(most, n);
      }
    }
    expect(most).toBeLessThanOrEqual(5);
  });
});

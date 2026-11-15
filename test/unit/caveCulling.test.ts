/**
 * Cave culling's walk (SP6b spec §8.1-§8.2, D22; §12.4's unit tests carrying the "0 wrongly culled" proof). Section
 * grids are synthetic `connectivity15` values, or computed from voxel worlds (air boxes in stone) through
 * `connectivity15` and checked against 3D DDA rays: every section a ray enters, the one where it stops included, must
 * be stamped by the walk. Then the culler (§8.2's triggers, `drawAll` and the time slices) over synthetic grids.
 */
import { describe, expect, test } from 'vitest';
import { connectivity15, connectivityBit } from '../../src/mesh/connectivity';
import {
  clearColumn, createCaveCuller, newCaveWalk, setColumnConn, startWalk, stepWalk, torusSlot, type CaveCuller, type CaveWalk,
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

// --- The culler (§8.2's triggers, `drawAll`, the slices; ruling P45's hold). ---

/** World coordinates of section (sx, sy, sz)'s centre (voxel Y = y + 64). */
const centre = (sx: number, sy: number, sz: number): [number, number, number] => [sx * 16 + 8, sy * 16 - 64 + 8, sz * 16 + 8];
const camAt = (c: CaveCuller, sx: number, sy: number, sz: number): void => c.setCamera(...centre(sx, sy, sz));

/** Reveals every column of [x0, x1] × [z0, z1] with `connAt`. */
function reveal(c: CaveCuller, x0: number, x1: number, z0: number, z1: number, connAt: ConnAt): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const col = new Uint16Array(SECTIONS);
      for (let sy = 0; sy < SECTIONS; sy++) col[sy] = connAt(cx, sy, cz);
      c.onReveal(keyOf(cx, cz), cx, cz, col);
    }
  }
}

/** Every section of [x0, x1] × [z0, z1] the culler draws. */
function drawnSet(c: CaveCuller, x0: number, x1: number, z0: number, z1: number): Set<string> {
  const out = new Set<string>();
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) for (let sy = 0; sy < SECTIONS; sy++) if (c.drawn(cx, sy, cz)) out.add(id(cx, sy, cz));
  return out;
}

/** A frame with no time limit: the walk in progress runs to completion. */
const settle = (c: CaveCuller, nowMs: number): void => c.frame(nowMs, Infinity, null, 0);
const stone = (): number => 0;

/** A culler at RD 4 over stone columns in [−8, 8]², the camera at section (0, 12, 0), its first walk completed. */
function settled(): CaveCuller {
  const c = createCaveCuller();
  c.setRadius(4);
  reveal(c, -8, 8, -8, 8, stone);
  camAt(c, 0, 12, 0);
  settle(c, 0);
  return c;
}

describe('the culler\'s triggers, drawAll and slices (SP6b spec §8.2)', () => {
  test('before a camera and its first walk everything draws; the first walk culls', () => {
    const c = createCaveCuller();
    c.setRadius(4);
    reveal(c, -8, 8, -8, 8, stone);
    expect(c.drawAll).toBe(true);
    settle(c, 0);
    expect(c.walk.walkId, 'no camera, no walk').toBe(0);
    camAt(c, 0, 12, 0);
    expect(c.drawAll).toBe(true);
    settle(c, 16);
    expect(c.walk.walkId).toBe(1);
    expect(c.shown).toBe(1);
    expect(c.drawAll).toBe(false);
    expect([...drawnSet(c, -8, 8, -8, 8)].sort()).toEqual([...boxAndShell([0, 12, 0])].sort());
    settle(c, 32);
    expect(c.walk.walkId, 'nothing owes a walk').toBe(1);
  });

  test('(1) a camera section change: a walk; drawAll only when the camera leaves the last completed walk\'s box', () => {
    const c = settled();
    const before = drawnSet(c, -8, 8, -8, 8);
    // Inside the box: the set stays in force, a walk seeded at the new section starts.
    camAt(c, 1, 12, 0);
    expect(c.drawAll).toBe(false);
    c.frame(16, 1, null, 0);
    expect(c.walk.running).toBe(true);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([1, 12, 0]);
    // A half-done walk never hides what the previous one showed.
    for (const s of before) {
      const [x, y, z] = s.split(',').map(Number) as [number, number, number];
      expect(c.drawn(x, y, z), s).toBe(true);
    }
    settle(c, 32);
    expect(c.shown).toBe(2);
    expect(c.drawAll).toBe(false);
    expect([...drawnSet(c, -8, 8, -8, 8)].sort()).toEqual([...boxAndShell([1, 12, 0])].sort());
    // A move during a walk does not abandon it: the walk completes, then one seeded at the new section starts.
    camAt(c, 2, 12, 0);
    c.frame(48, 1, null, 0);
    expect(c.walk.walkId).toBe(3);
    camAt(c, 1, 12, 0);
    c.frame(64, Infinity, null, 0);
    expect(c.shown).toBe(3);
    expect(c.walk.walkId).toBe(4);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([1, 12, 0]);
    settle(c, 80);
    expect(c.shown).toBe(4);
    // Out of the box (two sections from the last completed walk's S0): drawAll at once, cleared by the walk around it.
    camAt(c, 3, 12, 0);
    expect(c.drawAll).toBe(true);
    settle(c, 96);
    expect(c.drawAll).toBe(false);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([3, 12, 0]);
    // Leaving the box while a walk seeded inside it runs: that walk's completion does not clear drawAll (it started
    // before the trigger), even though its box holds the camera; the next one does.
    camAt(c, 4, 12, 0);
    c.frame(112, 1, null, 0);
    const started = c.walk.walkId;
    camAt(c, 5, 12, 0);
    expect(c.drawAll).toBe(true);
    c.frame(128, Infinity, null, 0);
    expect(c.shown).toBe(started);
    expect(c.drawAll).toBe(true);
    settle(c, 144);
    expect(c.shown).toBe(started + 1);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([5, 12, 0]);
    expect(c.drawAll).toBe(false);
  });

  test('a walk that completes after the camera left its box sets drawAll', () => {
    const c = settled();
    camAt(c, 1, 12, 0);
    c.frame(16, 1, null, 0); // seeded at (1, 12, 0)
    camAt(c, -1, 12, 0); // inside (0, 12, 0)'s box, outside (1, 12, 0)'s
    expect(c.drawAll).toBe(false);
    c.frame(32, Infinity, null, 0);
    expect(c.shown).toBe(2);
    expect(c.drawAll, 'the completed walk does not cover the eye').toBe(true);
    settle(c, 48);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([-1, 12, 0]);
    expect(c.drawAll).toBe(false);
  });

  test('(2) a swap adding a bit sets drawAll and starts a walk; a swap only removing bits keeps the set', () => {
    const c = settled();
    // Column (2, 0) opens: its sections join everything, so (3, 0) beyond it is reached.
    const open = new Uint16Array(SECTIONS).fill(OPEN);
    c.onSwap(keyOf(2, 0), 2, 0, open);
    expect(c.drawAll).toBe(true);
    c.frame(16, 1, null, 0);
    expect(c.walk.running).toBe(true);
    expect(c.drawAll).toBe(true);
    settle(c, 32);
    expect(c.drawAll).toBe(false);
    expect(c.drawn(3, 12, 0)).toBe(true);
    // Closed again: only bits removed; the set stays in force (a superset) and drawAll stays clear.
    c.onSwap(keyOf(2, 0), 2, 0, new Uint16Array(SECTIONS));
    expect(c.drawAll).toBe(false);
    expect(c.drawn(3, 12, 0)).toBe(true);
    settle(c, 48);
    expect(c.drawAll).toBe(false);
    expect(c.drawn(3, 12, 0)).toBe(false);
    // A gain while a walk runs: that walk (started before) does not clear drawAll; the next one does.
    camAt(c, 1, 12, 0);
    c.frame(64, 1, null, 0);
    const running = c.walk.walkId;
    c.onSwap(keyOf(-3, 0), -3, 0, open);
    c.frame(80, Infinity, null, 0);
    expect(c.shown).toBe(running);
    expect(c.drawAll).toBe(true);
    settle(c, 96);
    expect(c.shown).toBe(running + 1);
    expect(c.drawAll).toBe(false);
  });

  test('(3) reveals during a stand-still: a walk within 250 ms, at most every 250 ms while they arrive, one when they drain; never drawAll', () => {
    const c = createCaveCuller();
    c.setRadius(6);
    camAt(c, 0, 12, 0);
    settle(c, 0); // every column unrevealed: walked as open
    expect(c.drawAll).toBe(false);
    const starts: number[] = [];
    let last = c.walk.walkId;
    const tick = (t: number): void => {
      c.frame(t, Infinity, null, 0);
      expect(c.drawAll, `at ${t} ms`).toBe(false);
      if (c.walk.walkId !== last) starts.push(t);
      last = c.walk.walkId;
    };
    // One column revealed per frame, every 16 ms, for 40 frames; then 20 frames with none.
    const order = discOffsetsOf(6);
    for (let k = 0; k < 40; k++) {
      const [dx, dz] = order[k]!;
      c.onReveal(keyOf(dx, dz), dx, dz, new Uint16Array(SECTIONS));
      expect(c.drawAll).toBe(false);
      tick(1000 + 16 * k);
    }
    for (let k = 40; k < 60; k++) tick(1000 + 16 * k);
    expect(starts).toEqual([1000, 1256, 1512, 1640]);
    // The walk after the drain saw every reveal (the 37 columns with dx² + dz² ≤ 10 among them, as stone): the shell
    // column (2, 0) is entered, (3, 0) behind it no longer.
    expect(c.drawn(2, 12, 0)).toBe(true);
    expect(c.drawn(3, 12, 0)).toBe(false);
  });

  test('a revealed column draws until a walk that saw it completes', () => {
    const c = createCaveCuller();
    c.setRadius(4);
    camAt(c, 0, 12, 0);
    settle(c, 0);
    // A walk in progress when (3, 0) is revealed as stone, the columns around it too.
    camAt(c, 1, 12, 0);
    c.frame(16, 1, null, 0);
    reveal(c, -6, 6, -6, 6, stone);
    expect(c.drawn(-3, 12, 0)).toBe(true);
    c.frame(32, Infinity, null, 0); // the walk in progress completes (it started before the reveals)
    expect(c.drawn(-3, 12, 0)).toBe(true);
    expect(c.drawAll).toBe(false);
    settle(c, 48); // no reveal since the last frame: drained, a walk that saw them
    expect(c.drawn(-3, 12, 0)).toBe(false);
  });

  test('Review Focus 3: eye y 400, then y 300, then a jump of 20,000 blocks', () => {
    const c = settled();
    // Eye y 400: drawAll and no walk (a walk in progress is dropped).
    camAt(c, 1, 12, 0);
    c.frame(16, 1, null, 0);
    const before = c.walk.walkId;
    c.setCamera(24, 400, 8);
    expect(c.drawAll).toBe(true);
    for (let f = 0; f < 10; f++) c.frame(32 + 16 * f, Infinity, null, 0);
    expect(c.walk.walkId).toBe(before);
    expect(c.walk.running).toBe(false);
    expect(c.shown).toBe(before - 1);
    // Eye y 300 (section 22): a walk starts and drawAll clears when it completes.
    c.setCamera(24, 300, 8);
    expect(c.drawAll).toBe(true);
    c.frame(200, 1, null, 0);
    expect(c.walk.running).toBe(true);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([1, 22, 0]);
    expect(c.drawAll).toBe(true);
    settle(c, 216);
    expect(c.drawAll).toBe(false);
    // A walk in progress at the old place, then the jump.
    camAt(c, 0, 12, 0);
    c.frame(232, 1, null, 0);
    const old = c.walk.walkId;
    expect(c.walk.running).toBe(true);
    c.setCamera(20_000 + 8, 12 * 16 - 64 + 8, 20_000 + 8);
    expect(c.drawAll, 'drawAll at once').toBe(true);
    const nx = 1250;
    c.frame(248, Infinity, null, 0);
    expect(c.shown).toBe(old);
    expect(c.drawAll, 'the old place\'s walk completing does not clear it').toBe(true);
    expect(c.walk.running).toBe(true);
    expect([c.walk.s0x, c.walk.s0y, c.walk.s0z]).toEqual([nx, 12, nx]);
    settle(c, 264);
    expect(c.shown).toBe(old + 1);
    expect(c.drawAll, 'cleared by the walk seeded around the new section').toBe(false);
    // Every unrevealed column within RD walked as open: every section of the disc dx² + dz² ≤ 4.5² drawn by stamp.
    const lim = 4.5 * 4.5;
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -6; dx <= 6; dx++) {
        for (let sy = 0; sy < SECTIONS; sy++) expect(c.drawn(nx + dx, sy, nx + dz), `(${dx}, ${sy}, ${dz})`).toBe(dx * dx + dz * dz <= lim);
      }
    }
    // The disc streams in as stone: drawn until a walk that saw it completes.
    reveal(c, nx - 6, nx + 6, nx - 6, nx + 6, stone);
    expect(c.drawn(nx + 3, 12, nx)).toBe(true);
    c.frame(280, 1, null, 0); // 280 ms after the last walk reveals started: a walk starts, half done
    expect(c.walk.running).toBe(true);
    expect(c.drawn(nx + 3, 12, nx)).toBe(true);
    settle(c, 296);
    expect(c.drawAll).toBe(false);
    expect([...drawnSet(c, nx - 6, nx + 6, nx - 6, nx + 6)].sort()).toEqual([...boxAndShell([nx, 12, nx])].sort());
  });

  test('the eye\'s range: y −64 … 319', () => {
    const c = settled();
    for (const [y, inside] of [[-64, true], [-64.01, false], [319.99, true], [320, false], [Number.NaN, false]] as const) {
      c.setCamera(8, y, 8);
      settle(c, 0);
      expect(c.drawAll, `y ${y}`).toBe(!inside);
    }
  });

  test('X on: no walk across 30 frames whatever arrives; X off: drawAll until a walk started after it completes', () => {
    const c = settled();
    camAt(c, 1, 12, 0);
    c.frame(16, 1, null, 0);
    const id0 = c.walk.walkId;
    const shown0 = c.shown;
    c.setXray(true);
    expect(c.drawAll).toBe(true);
    for (let f = 0; f < 30; f++) {
      if (f === 3) c.onSwap(keyOf(2, 0), 2, 0, new Uint16Array(SECTIONS).fill(OPEN));
      if (f === 5) c.onReveal(keyOf(20, 0), 20, 0, new Uint16Array(SECTIONS));
      if (f === 7) camAt(c, 3, 12, 0);
      c.frame(32 + 16 * f, Infinity, null, 0);
      expect(c.walk.walkId).toBe(id0);
      expect(c.drawAll).toBe(true);
    }
    expect(c.shown).toBe(shown0);
    for (const s of [[0, 0, 0], [8, 23, -8], [3, 12, 0]] as const) expect(c.drawn(s[0], s[1], s[2])).toBe(true);
    c.setXray(false);
    expect(c.drawAll).toBe(true);
    c.frame(600, 1, null, 0);
    expect(c.walk.walkId).toBe(id0 + 1);
    expect(c.drawAll).toBe(true);
    settle(c, 616);
    expect(c.drawAll).toBe(false);
  });

  test('the hold (ruling P45): a walk that would complete during it hides nothing; drawAll survives until a walk started after the release completes', () => {
    const c = settled();
    const shown0 = c.shown;
    camAt(c, 1, 12, 0);
    c.frame(16, 1, null, 0);
    const held = c.walk.walkId;
    c.setHold(true);
    for (let f = 0; f < 5; f++) c.frame(32 + 16 * f, Infinity, null, 0);
    expect(c.shown).toBe(shown0);
    expect(c.walk.walkId).toBe(held);
    for (let cz = -8; cz <= 8; cz++) for (let cx = -8; cx <= 8; cx++) for (let sy = 0; sy < SECTIONS; sy++) expect(c.drawn(cx, sy, cz)).toBe(true);
    c.setHold(false);
    expect(c.drawAll).toBe(true);
    c.frame(200, 1, null, 0);
    expect(c.walk.walkId).toBe(held + 1);
    expect(c.drawAll).toBe(true);
    settle(c, 216);
    expect(c.shown).toBe(held + 1);
    expect(c.drawAll).toBe(false);
  });

  test('enabled false (the bench\'s switch): drawAll, no walk; true again: a walk, then culling', () => {
    const c = settled();
    c.enabled = false;
    expect(c.enabled).toBe(false);
    expect(c.drawAll).toBe(true);
    camAt(c, 1, 12, 0);
    settle(c, 16);
    expect(c.walk.walkId).toBe(1);
    c.enabled = true;
    expect(c.drawAll).toBe(true);
    settle(c, 32);
    expect(c.walk.walkId).toBe(2);
    expect(c.drawAll).toBe(false);
  });

  test('the slice stops at the first poll past 0.5 ms (polled every 256 pops); with no clock it runs maxPops', () => {
    // RD 16, every column unrevealed: a walk of thousands of pops.
    const rangeOf = (s0x: number, s0z: number) => (cx: number, cz: number): boolean =>
      (cx - s0x) * (cx - s0x) + (cz - s0z) * (cz - s0z) <= 16.5 * 16.5;
    const reference = (pops: number): CaveWalk => {
      const w = newCaveWalk();
      startWalk(w, 3, 12, -2, rangeOf(3, -2));
      stepWalk(w, pops, rangeOf(3, -2), () => false);
      return w;
    };
    const c = createCaveCuller();
    c.setRadius(16);
    camAt(c, 3, 12, -2);
    let calls = 0;
    const clock = (): number => 0.2 * calls++; // 0 at the slice's start, then 0.2, 0.4, 0.6 …
    c.frame(0, Infinity, clock, 0.5);
    expect(calls, 'the start and three polls').toBe(4);
    expect(c.walk.running).toBe(true);
    const ref = reference(768);
    expect(c.walk.qHead).toBe(ref.qHead);
    expect(c.walk.qSize).toBe(ref.qSize);
    expect(c.walk.stamp).toEqual(ref.stamp);
    // No clock: maxPops (R3's 2,000) per frame.
    const d = createCaveCuller();
    d.setRadius(16);
    camAt(d, 3, 12, -2);
    d.frame(0, 2000, null, 0);
    const ref2 = reference(2000);
    expect(d.walk.qHead).toBe(ref2.qHead);
    expect(d.walk.qSize).toBe(ref2.qSize);
    expect(d.walk.running).toBe(true);
  });

  test('drawn(cx, sy, cz) and drawnAt(torusSlot(cx, cz)·24 + sy) agree at every section of a walked grid', () => {
    const s0 = [62, 11, -1] as const;
    let seed = 777;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const c = createCaveCuller();
    c.setRadius(6);
    reveal(c, s0[0] - 7, s0[0] + 7, s0[2] - 7, s0[2] + 7, () => {
      let bits = 0;
      for (let b = 0; b < 15; b++) if (rnd() < 0.45) bits |= 1 << b;
      return bits;
    });
    camAt(c, s0[0], s0[1], s0[2]);
    const check = (): number => {
      let hidden = 0;
      for (let cz = s0[2] - 7; cz <= s0[2] + 7; cz++) {
        for (let cx = s0[0] - 7; cx <= s0[0] + 7; cx++) {
          for (let sy = 0; sy < SECTIONS; sy++) {
            const at = torusSlot(cx, cz) * SECTIONS + sy;
            expect(c.drawn(cx, sy, cz)).toBe(c.drawnAt(at));
            expect(c.drawnAt(at)).toBe(c.drawAll || c.walk.stamp[at]! >= c.shown);
            if (!c.drawnAt(at)) hidden++;
          }
        }
      }
      return hidden;
    };
    settle(c, 0);
    expect(check(), 'the walk culls something').toBeGreaterThan(0);
    camAt(c, s0[0] + 1, s0[1], s0[2]);
    c.frame(16, 50, null, 0);
    expect(c.walk.running).toBe(true);
    check();
  });
});

/** The disc offsets dx² + dz² ≤ (r + 0.5)², nearest first (ties by dz, then dx). */
function discOffsetsOf(r: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= (r + 0.5) * (r + 0.5)) out.push([dx, dz]);
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
}

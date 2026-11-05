/**
 * The carvers' sources and worm paths (SP6a spec §2.1-§2.2, D5, D21, D35; Task 24): `carverPath` for worms and
 * underground worms against a step-by-step oracle of the plan's draw order (which the golden `sp6a.carver.paths`
 * freezes from Task 27), its purity, the step count, the end taper (`C7.endTaper`'s rule, the start room excluded),
 * the branches (ruling P27), the start room, the box, and the uniformity of the starts. `unit (heavy)`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { detCos, detSin } from '../../src/core/detMath';
import { deriveSeed, hash2, type Seed64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { carverPath, type CarverKind, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { CARVER_DEFAULTS } from '../harness/carverParams';
import { chiSquareP } from '../harness/stats';

const SEED: Seed64 = [42, 0];
const WORM_KINDS: readonly CarverKind[] = ['worm', 'undergroundWorm'];

/** `base` with the worms' (and the underground worms') fields of `w` replaced. */
function withWorms(base: CarverParams, w: Partial<CarverParams['worms']>, under: Partial<CarverParams['undergroundWorms']> = {}): CarverParams {
  return { ...base, worms: { ...base.worms, ...w }, undergroundWorms: { ...base.undergroundWorms, ...under } };
}

/** Every source passes its roll. */
const ALWAYS = withWorms(CARVER_DEFAULTS, { chance: 1 }, { chance: 1 });

/** The sources of a square spiral from (0, 0), in order. */
function* spiral(): Generator<[number, number]> {
  let x = 0;
  let z = 0;
  yield [x, z];
  for (let leg = 1; ; leg++) {
    const dir = leg % 2 === 1 ? 1 : -1;
    for (let i = 0; i < leg; i++) { x += dir; yield [x, z]; }
    for (let i = 0; i < leg; i++) { z += dir; yield [x, z]; }
  }
}

function firstSources(count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of spiral()) {
    if (out.length === count) break;
    out.push(s);
  }
  return out;
}

/** What the oracle saw along one path: its ellipsoids and the draws that shaped them. */
interface Walk {
  readonly ell: number[];
  readonly room: boolean;
  readonly roomScale: number;
  readonly n: number;
  readonly t: number;
  readonly hMul: number;
  readonly vMul: number;
  readonly floor: number;
  readonly branched: boolean;
  readonly half: number;
  /** The branches' thicknesses, first then second (empty without branches). */
  readonly tb: number[];
  /** The trunk's state when its fork ellipsoid was emitted (null without branches). */
  readonly fork: { x: number; y: number; z: number; yaw: number; pitch: number; yd: number; pd: number } | null;
}

/**
 * The plan's draw order, written out step by step (Task 24's rules 1-7 with ruling P27): the roll; the start x, z, y,
 * yaw, pitch; n, t, hMul, vMul, floor; the room roll and a room's radius and yScale; the branch roll; per step the
 * ellipsoid, then the move and the drift; the trunk's fork step emits and stops; each branch draws its thickness and
 * runs i = ⌊n/2⌋ … n − 1 from the fork with yaw ± π/2.
 */
function oracle(kind: CarverKind, sx: number, sz: number, p: CarverParams): Walk | null {
  const r = new Xoshiro128(hash2(deriveSeed(SEED, 'caves.' + kind), sx, sz));
  const u = (): number => r.nextFloat();
  const w = p.worms;
  const sh = w.shape;
  const under = kind === 'undergroundWorm';
  if (!(u() < (under ? p.undergroundWorms.chance : w.chance))) return null;
  const yMin = under ? p.undergroundWorms.startYMin : w.startYMin;
  const yMax = under ? p.undergroundWorms.startYMax : w.startYMax;
  const sxw = 16 * sx + 16 * u();
  const szw = 16 * sz + 16 * u();
  const syw = yMin + (yMax - yMin) * u();
  const yaw0 = 2 * Math.PI * u();
  const pitch0 = (u() - 0.5) / 4;
  const n = Math.max(1, w.length - Math.floor(w.lengthVar * u()));
  const t1 = u();
  const t2 = u();
  const t = 2 * t1 + t2;
  const hMul = w.radiusMin + (w.radiusMax - w.radiusMin) * u();
  const vMul = w.vRatioMin + (w.vRatioMax - w.vRatioMin) * u();
  const floor = w.floorMin + (w.floorMax - w.floorMin) * u();
  const ell: number[] = [];
  const room = u() < w.roomChance;
  let roomScale = NaN;
  if (room) {
    const rh = (1 + 6 * u()) * hMul;
    roomScale = w.roomYScaleMin + (w.roomYScaleMax - w.roomYScaleMin) * u();
    ell.push(sxw, syw, szw, rh, rh * roomScale, floor);
  }
  const branched = u() < w.branchChance && t > 1;
  const half = Math.floor(n / 2);
  const s = { x: sxw, y: syw, z: szw, yaw: yaw0, pitch: pitch0, yd: 0, pd: 0 };
  const run = (from: number, thick: number, stopAt: number): void => {
    for (let i = from; i < n; i++) {
      const g = 1.5 + detSin(Math.PI * i / n) * thick;
      ell.push(s.x, s.y, s.z, g * hMul, g * vMul, floor);
      if (i === stopAt) return;
      s.x += detCos(s.pitch) * detCos(s.yaw);
      s.y += detSin(s.pitch);
      s.z += detCos(s.pitch) * detSin(s.yaw);
      s.pitch *= sh.pitchKeep;
      s.yaw += sh.yawStep * s.yd;
      s.pitch += sh.pitchStep * s.pd;
      const a1 = u();
      const a2 = u();
      const a3 = u();
      s.yd = sh.yawDriftKeep * s.yd + (a1 - a2) * a3 * sh.yawDriftMul;
      const b1 = u();
      const b2 = u();
      const b3 = u();
      s.pd = sh.pitchDriftKeep * s.pd + (b1 - b2) * b3 * sh.pitchDriftMul;
    }
  };
  run(0, t, branched ? half : -1);
  const tb: number[] = [];
  let fork: Walk['fork'] = null;
  if (branched) {
    fork = { ...s };
    for (const turn of [Math.PI / 2, -Math.PI / 2]) {
      const thick = 0.5 + 0.5 * u();
      tb.push(thick);
      Object.assign(s, fork, { yaw: fork.yaw + turn });
      run(half, thick, -1);
    }
  }
  return { ell, room, roomScale, n, t, hMul, vMul, floor, branched, half, tb, fork };
}

/** The ellipsoid ranges of a walk: the trunk, then each branch (the room excluded). */
function segments(wk: Walk): Array<[from: number, to: number]> {
  const r = wk.room ? 1 : 0;
  if (!wk.branched) return [[r, r + wk.n]];
  const trunk = wk.half + 1;
  const branch = wk.n - wk.half;
  return [[r, r + trunk], [r + trunk, r + trunk + branch], [r + trunk + branch, r + trunk + 2 * branch]];
}

/** The first byte at which `a` and `b` differ (−1 when byte-identical; null equals only null). */
function firstDiff(a: Float64Array | null, b: Float64Array | null): number {
  if (a === null || b === null) return a === b ? -1 : 0;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) return Math.min(x.length, y.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i;
  return -1;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

describe('carverPath: sources and worm paths (SP6a §2.1-§2.2)', () => {
  test('the draw order: every path equals the oracle\'s, bit for bit, and a failed roll is null', () => {
    const variants: CarverParams[] = [CARVER_DEFAULTS, withWorms(ALWAYS, { roomChance: 1, branchChance: 1 }), withWorms(ALWAYS, { roomChance: 0, branchChance: 0 })];
    for (const p of variants) {
      for (const kind of WORM_KINDS) {
        let built = 0;
        for (const [sx, sz] of firstSources(1500)) {
          const want = oracle(kind, sx, sz, p);
          const got = carverPath(SEED, kind, sx, sz, p);
          if (want === null) { expect(got, `${kind} (${sx}, ${sz})`).toBeNull(); continue; }
          built++;
          expect(got, `${kind} (${sx}, ${sz})`).not.toBeNull();
          expect(got!.kind).toBe(kind);
          expect([got!.sx, got!.sz]).toEqual([sx, sz]);
          expect(got!.count).toBe(want.ell.length / 6);
          expect(got!.ell.length).toBe(want.ell.length);
          expect(firstDiff(got!.ell, Float64Array.from(want.ell)), `${kind} (${sx}, ${sz})`).toBe(-1);
          expect(got!.widthSq).toBeNull();
        }
        expect(built).toBeGreaterThan(p === CARVER_DEFAULTS ? 30 : 1000);
      }
    }
  });

  test('purity: 64 fixed sources per kind give byte-identical ell, box and widthSq across two calls and in reversed order', () => {
    for (const kind of WORM_KINDS) {
      const sources: Array<[number, number]> = [];
      for (const s of spiral()) {
        if (sources.length === 64) break;
        if (carverPath(SEED, kind, s[0], s[1], CARVER_DEFAULTS) !== null) sources.push(s);
      }
      const once = sources.map(([sx, sz]) => carverPath(SEED, kind, sx, sz, CARVER_DEFAULTS)!);
      const twice = sources.map(([sx, sz]) => carverPath(SEED, kind, sx, sz, CARVER_DEFAULTS)!);
      const reversed = [...sources].reverse().map(([sx, sz]) => carverPath(SEED, kind, sx, sz, CARVER_DEFAULTS)!).reverse();
      for (const other of [twice, reversed]) {
        for (let i = 0; i < 64; i++) {
          expect(firstDiff(other[i]!.ell, once[i]!.ell)).toBe(-1);
          expect(firstDiff(other[i]!.box, once[i]!.box)).toBe(-1);
          expect(firstDiff(other[i]!.widthSq, once[i]!.widthSq)).toBe(-1);
        }
      }
    }
  });

  test('n ≥ 1 for length and lengthVar at their static ends (32 … 160, 0 … 64); lengthVar ≥ length gives 1-step worms', () => {
    for (const length of [32, 160]) {
      for (const lengthVar of [0, 64]) {
        const p = withWorms(ALWAYS, { length, lengthVar, roomChance: 0, branchChance: 0 });
        const counts = new Set<number>();
        for (const [sx, sz] of firstSources(2000)) {
          const path = carverPath(SEED, 'worm', sx, sz, p)!;
          counts.add(path.count);
          expect(path.count).toBeGreaterThanOrEqual(1);
          expect(path.count).toBeGreaterThanOrEqual(Math.max(1, length - Math.max(0, lengthVar - 1)));
          expect(path.count).toBeLessThanOrEqual(length);
        }
        if (lengthVar === 0) expect([...counts]).toEqual([length]);
        // Ruling P26: with lengthVar ≥ length, n = 1 occurs among the sources (it is not forced for each one).
        if (lengthVar >= length) expect(counts.has(1)).toBe(true);
      }
    }
  });

  test('the end taper (C7.endTaper\'s rule; branch points and the start room excluded): 10,000 sources per kind', () => {
    for (const kind of WORM_KINDS) {
      const p = withWorms(CARVER_DEFAULTS, { chance: 1 }, { chance: 1 });
      let ends = 0;
      let rooms = 0;
      let branched = 0;
      const bad: string[] = [];
      for (const [sx, sz] of firstSources(10_000)) {
        const path = carverPath(SEED, kind, sx, sz, p)!;
        const wk = oracle(kind, sx, sz, p)!;
        if (wk.room) rooms++;
        if (wk.branched) branched++;
        const segs = segments(wk);
        expect(segs[segs.length - 1]![1]).toBe(path.count);
        for (const col of [3, 4]) {
          const steps: number[] = [];
          for (let k = wk.room ? 1 : 0; k < path.count; k++) steps.push(path.ell[k * 6 + col]!);
          const med = median(steps);
          const check = (end: number, near: number[]): void => {
            ends++;
            const v = path.ell[end * 6 + col]!;
            if (near.some((k) => v > path.ell[k * 6 + col]!) || v > med) bad.push(`${kind} (${sx}, ${sz}) end ${end} col ${col}`);
          };
          /** Up to 4 ellipsoids of [from, to) next to `end`, walking inward by `dir`. */
          const inward = (end: number, from: number, to: number, dir: 1 | -1): number[] => {
            const out: number[] = [];
            for (let k = 1; k <= 4; k++) { const j = end + dir * k; if (j >= from && j < to) out.push(j); }
            return out;
          };
          const [t0, t1] = segs[0]!;
          // The trunk's start: its first step ellipsoid (after the room), against the 4 after it.
          check(t0, inward(t0, t0, t1, 1));
          // The trunk's end is a path end only without branches; each branch's last ellipsoid is one.
          if (!wk.branched) check(t1 - 1, inward(t1 - 1, t0, t1, -1));
          for (const [b0, b1] of segs.slice(1)) check(b1 - 1, inward(b1 - 1, b0, b1, -1));
        }
      }
      expect(bad.slice(0, 10)).toEqual([]);
      expect(rooms).toBeGreaterThan(2000);
      expect(branched).toBeGreaterThan(1000);
      expect(ends).toBeGreaterThan(40_000);
    }
  });

  test('branches (branchChance 1, ruling P27): the trunk holds ⌊n/2⌋ + 1 ellipsoids, two branches of n − ⌊n/2⌋ start at its last centre with yaw ± π/2, the trunk\'s pitch, and no pinch; t ≤ 1 never branches', () => {
    const p = withWorms(ALWAYS, { roomChance: 0, branchChance: 1 });
    let forks = 0;
    let plain = 0;
    for (const kind of WORM_KINDS) {
      for (const [sx, sz] of firstSources(3000)) {
        const path = carverPath(SEED, kind, sx, sz, p)!;
        const wk = oracle(kind, sx, sz, p)!;
        const { n, half } = wk;
        if (wk.t <= 1) {
          plain++;
          expect(wk.branched).toBe(false);
          expect(path.count).toBe(n);
          continue;
        }
        forks++;
        expect(wk.branched).toBe(true);
        const trunk = half + 1;
        const branch = n - half;
        expect(path.count).toBe(trunk + 2 * branch);
        const e = path.ell;
        const fork = wk.fork!;
        const last = (trunk - 1) * 6;
        // The trunk's fork ellipsoid is i = ⌊n/2⌋ at the trunk's thickness.
        expect(e[last + 3]).toBe((1.5 + detSin(Math.PI * half / n) * wk.t) * wk.hMul);
        expect([e[last], e[last + 1], e[last + 2]]).toEqual([fork.x, fork.y, fork.z]);
        for (let b = 0; b < 2; b++) {
          const at = (trunk + b * branch) * 6;
          const tb = wk.tb[b]!;
          expect(tb).toBeGreaterThanOrEqual(0.5);
          expect(tb).toBeLessThan(1);
          // It starts at the trunk's last centre, with i = ⌊n/2⌋ (no pinch) and its own thickness.
          expect([e[at], e[at + 1], e[at + 2]]).toEqual([e[last], e[last + 1], e[last + 2]]);
          expect(e[at + 3]).toBe((1.5 + detSin(Math.PI * half / n) * tb) * wk.hMul);
          expect(e[at + 4]).toBe((1.5 + detSin(Math.PI * half / n) * tb) * wk.vMul);
          // Its last ellipsoid is i = n − 1.
          const end = at + (branch - 1) * 6;
          expect(e[end + 3]).toBe((1.5 + detSin(Math.PI * (n - 1) / n) * tb) * wk.hMul);
          if (branch < 2) continue;
          // Its first move: the trunk's pitch at the fork, the trunk's yaw turned by ±π/2.
          const yaw = fork.yaw + (b === 0 ? Math.PI / 2 : -Math.PI / 2);
          expect(e[at + 6]! - e[at]!).toBeCloseTo(detCos(fork.pitch) * detCos(yaw), 9);
          expect(e[at + 7]! - e[at + 1]!).toBeCloseTo(detSin(fork.pitch), 9);
          expect(e[at + 8]! - e[at + 2]!).toBeCloseTo(detCos(fork.pitch) * detSin(yaw), 9);
        }
      }
    }
    expect(forks).toBeGreaterThan(3000);
    expect(plain).toBeGreaterThan(300);
  });

  test('branches with a straight trunk (no yaw or pitch steps): each branch leaves at a right angle, left then right, level with the trunk', () => {
    const shape = { ...CARVER_DEFAULTS.worms.shape, pitchKeep: 1, yawStep: 0, pitchStep: 0 };
    const p = withWorms(ALWAYS, { roomChance: 0, branchChance: 1, shape });
    let checked = 0;
    for (const [sx, sz] of firstSources(500)) {
      const path = carverPath(SEED, 'worm', sx, sz, p)!;
      const n = path.count;
      const e = path.ell;
      if (e[6] === undefined) continue;
      const dt = [e[6]! - e[0]!, e[7]! - e[1]!, e[8]! - e[2]!];
      // Without branches the count is n ≥ 85; with them ⌊n/2⌋ + 1 + 2·(n − ⌊n/2⌋); recover the trunk from the centres.
      let trunk = 0;
      while (trunk + 1 < n && Math.abs(e[(trunk + 1) * 6]! - e[trunk * 6]! - dt[0]!) < 1e-9 && Math.abs(e[(trunk + 1) * 6 + 2]! - e[trunk * 6 + 2]! - dt[2]!) < 1e-9) trunk++;
      trunk++;
      if (trunk === n) continue;
      const branch = (n - trunk) / 2;
      expect(Number.isInteger(branch)).toBe(true);
      for (let b = 0; b < 2; b++) {
        const at = (trunk + b * branch) * 6;
        const d = [e[at + 6]! - e[at]!, e[at + 7]! - e[at + 1]!, e[at + 8]! - e[at + 2]!];
        const sign = b === 0 ? 1 : -1;
        expect(d[0]).toBeCloseTo(-sign * dt[2]!, 9);
        expect(d[1]).toBeCloseTo(dt[1]!, 9);
        expect(d[2]).toBeCloseTo(sign * dt[0]!, 9);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });

  test('the room (roomChance 1): the first ellipsoid at the start, rh in [hMul, 7·hMul), rv = rh·yScale with yScale in [0.1, 0.9], the worm\'s floor', () => {
    const p = withWorms(ALWAYS, { roomChance: 1, branchChance: 0 });
    for (const kind of WORM_KINDS) {
      for (const [sx, sz] of firstSources(2000)) {
        const e = carverPath(SEED, kind, sx, sz, p)!.ell;
        const wk = oracle(kind, sx, sz, p)!;
        expect(wk.room).toBe(true);
        expect([e[0], e[1], e[2]]).toEqual([e[6], e[7], e[8]]);
        expect(e[3]).toBeGreaterThanOrEqual(wk.hMul);
        expect(e[3]).toBeLessThan(7 * wk.hMul);
        expect(wk.roomScale).toBeGreaterThanOrEqual(0.1);
        expect(wk.roomScale).toBeLessThanOrEqual(0.9);
        expect(e[4]).toBe(e[3]! * wk.roomScale);
        expect(e[5]).toBe(wk.floor);
        expect(e[9]).toBe(1.5 * wk.hMul);
      }
    }
  });

  test('the box is the voxel reach: each ellipsoid\'s centre widened by its rh horizontally and its rv vertically', () => {
    const p = withWorms(ALWAYS, { roomChance: 0.5, branchChance: 0.5 });
    for (const kind of WORM_KINDS) {
      for (const [sx, sz] of firstSources(500)) {
        const path: CarverPath = carverPath(SEED, kind, sx, sz, p)!;
        const want = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let k = 0; k < path.count; k++) {
          const [x, y, z, rh, rv] = Array.from(path.ell.subarray(k * 6, k * 6 + 5));
          want[0] = Math.min(want[0]!, x! - rh!);
          want[1] = Math.min(want[1]!, y! - rv!);
          want[2] = Math.min(want[2]!, z! - rh!);
          want[3] = Math.max(want[3]!, x! + rh!);
          want[4] = Math.max(want[4]!, y! + rv!);
          want[5] = Math.max(want[5]!, z! + rh!);
        }
        expect(Array.from(path.box)).toEqual(want);
      }
    }
  });

  test('the starts are uniform in their chunk: χ² of (x mod 16, z mod 16) over 100,000 sources, p ≥ 0.01', () => {
    // The start draws come before the size draws, so the shortest length changes no start and keeps the test fast.
    const p = withWorms(ALWAYS, { length: 32, lengthVar: 0, roomChance: 0, branchChance: 0 });
    const bins = new Float64Array(256);
    let total = 0;
    for (const [sx, sz] of firstSources(100_000)) {
      const e = carverPath(SEED, 'worm', sx, sz, p)!.ell;
      const bx = Math.floor(e[0]!) - 16 * sx;
      const bz = Math.floor(e[2]!) - 16 * sz;
      expect(bx >= 0 && bx < 16 && bz >= 0 && bz < 16).toBe(true);
      bins[bz * 16 + bx]!++;
      total++;
    }
    const expected = total / 256;
    let chi2 = 0;
    for (const c of bins) chi2 += (c - expected) * (c - expected) / expected;
    expect(chiSquareP(chi2, 255)).toBeGreaterThanOrEqual(0.01);
  });

  test('the module uses detSin/detCos only: no Math.sin, Math.cos or ** (the gen arch rule)', () => {
    const src = readFileSync(new URL('../../src/gen/caves/carvers.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\s*\.\s*(sin|cos)\b/);
    expect(src).not.toContain('**');
  });
});

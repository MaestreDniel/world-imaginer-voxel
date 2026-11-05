/**
 * The carvers' sources and paths (SP6a spec §2.1-§2.3, D5, D21, D35; Tasks 24-25): `carverPath` for worms, underground
 * worms and ravines against step-by-step oracles of the plan's draw orders (which the golden `sp6a.carver.paths`
 * freezes from Task 27), its purity, the step counts, the end taper (`C7.endTaper`'s rule, the start room excluded),
 * the branches (ruling P27), the start room, the box, the ravines' width factors and radii, the underground worms'
 * start range, the uniformity of the starts, and `reachOverflow`'s unit form (§10.1: every path's box inside the
 * chunks within `CARVER_WINDOW_R` of its source chunk, at the defaults and at the static maxima). Task 27: the harness's
 * `CARVER_DEFAULTS` and `CARVER_MAXIMA` mirror the schema's carver leaves (`carverParamsOf`). `unit (heavy)`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CARVER_WINDOW_R } from '../../src/core/constants';
import { detCos, detSin } from '../../src/core/detMath';
import { deriveSeed, hash2, type Seed64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch, patchAt } from '../../src/core/params/kit';
import { SCHEMA, type Params } from '../../src/core/params/schema';
import { carverParamsOf, carverPath, type CarverKind, type CarverParams, type CarverPath } from '../../src/gen/caves/carvers';
import { CARVER_DEFAULTS, CARVER_MAXIMA } from '../harness/carverParams';
import { chiSquareP } from '../harness/stats';

const SEED: Seed64 = [42, 0];
const WORM_KINDS: readonly CarverKind[] = ['worm', 'undergroundWorm'];
const ALL_KINDS: readonly CarverKind[] = ['worm', 'undergroundWorm', 'ravine'];

/** `base` with the worms' (and the underground worms') fields of `w` replaced. */
function withWorms(base: CarverParams, w: Partial<CarverParams['worms']>, under: Partial<CarverParams['undergroundWorms']> = {}): CarverParams {
  return { ...base, worms: { ...base.worms, ...w }, undergroundWorms: { ...base.undergroundWorms, ...under } };
}

/** `base` with the ravines' fields of `r` replaced. */
function withRavines(base: CarverParams, r: Partial<CarverParams['ravines']>): CarverParams {
  return { ...base, ravines: { ...base.ravines, ...r } };
}

/** Every source passes its roll. */
const ALWAYS = withRavines(withWorms(CARVER_DEFAULTS, { chance: 1 }, { chance: 1 }), { chance: 1 });

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

/** What the ravine oracle saw along one path. */
interface RavineWalk {
  readonly ell: number[];
  readonly widthSq: number[];
  readonly n: number;
  readonly t: number;
  readonly pitch0: number;
}

/**
 * Task 25's ravine draw order, written out step by step: the roll against `ravines.chance`; the start x, z as worms,
 * y in [startYMin, startYMax]; yaw `2π·u`; pitch `(u − 0.5)·2·vRotation`; t `u·(thicknessMax − g) + u·g` with
 * g = (thicknessMax − min(plateau, thicknessMax))/2; n `lengthMin + ⌊(max(lengthMin, lengthMax) − lengthMin + 1)·u⌋`;
 * the 384 width factors from y −64, one draw pair `f = 1 + u·u` per `widthSmoothness` rows, stored as f²; then per
 * step the ellipsoid (rh = 1.5 + detSin(π·i/n)·t, rv = rh·yScale, floor −1), the move and the worms' drift.
 */
function ravineOracle(sx: number, sz: number, p: CarverParams): RavineWalk | null {
  const r = new Xoshiro128(hash2(deriveSeed(SEED, 'caves.ravine'), sx, sz));
  const u = (): number => r.nextFloat();
  const rv = p.ravines;
  const sh = p.worms.shape;
  if (!(u() < rv.chance)) return null;
  const s = { x: 16 * sx + 16 * u(), z: 0, y: 0, yaw: 0, pitch: 0, yd: 0, pd: 0 };
  s.z = 16 * sz + 16 * u();
  s.y = rv.startYMin + (rv.startYMax - rv.startYMin) * u();
  s.yaw = 2 * Math.PI * u();
  s.pitch = (u() - 0.5) * 2 * rv.vRotation;
  const pitch0 = s.pitch;
  const g = (rv.thicknessMax - Math.min(rv.plateau, rv.thicknessMax)) / 2;
  const ta = u();
  const tb = u();
  const t = ta * (rv.thicknessMax - g) + tb * g;
  const n = rv.lengthMin + Math.floor((Math.max(rv.lengthMin, rv.lengthMax) - rv.lengthMin + 1) * u());
  const widthSq: number[] = [];
  while (widthSq.length < 384) {
    const a = u();
    const b = u();
    const f = 1 + a * b;
    for (let k = 0; k < rv.widthSmoothness && widthSq.length < 384; k++) widthSq.push(f * f);
  }
  const ell: number[] = [];
  for (let i = 0; i < n; i++) {
    const rh = 1.5 + detSin(Math.PI * i / n) * t;
    ell.push(s.x, s.y, s.z, rh, rh * rv.yScale, -1);
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
  return { ell, widthSq, n, t, pitch0 };
}

/**
 * The end-taper rule (`C7.endTaper`, §10.1) on one end of a path, for column `col` (3 rh, 4 rv): the end's value is no
 * larger than any of the up-to-4 ellipsoids of [from, to) next to it inward, nor than `med`. True when it holds.
 */
function tapers(ell: Float64Array, col: number, end: number, from: number, to: number, dir: 1 | -1, med: number): boolean {
  const v = ell[end * 6 + col]!;
  if (v > med) return false;
  for (let k = 1; k <= 4; k++) {
    const j = end + dir * k;
    if (j >= from && j < to && v > ell[j * 6 + col]!) return false;
  }
  return true;
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

describe('the carver leaves (SP6a spec §4; Task 27, ruling P17)', () => {
  /** The schema's carver leaves: caves.worms.* (with caves.worms.shape.*), caves.undergroundWorms.*, caves.ravines.*. */
  const carverLeaves = () => SCHEMA.leaves.filter((l) => /^caves\.(worms|undergroundWorms|ravines)\./.test(l.path));

  test('carverParamsOf(DEFAULTS) equals the harness defaults (CARVER_DEFAULTS)', () => {
    expect(carverParamsOf(DEFAULTS)).toEqual(CARVER_DEFAULTS);
  });

  test('every carver leaf at its schema maximum (the limits leaves too) gives the harness maxima (CARVER_MAXIMA), so Task 25\'s reach holds for the leaves', () => {
    const leaves = carverLeaves();
    expect(leaves.length).toBe(36);
    let p: Params = DEFAULTS;
    for (const l of [...leaves, ...SCHEMA.leaves.filter((x) => ['caves.limits.waterDepth', 'caves.limits.bandSpan', 'caves.limits.capTop'].includes(x.path))]) {
      expect(Number.isFinite(l.leaf.max), l.path).toBe(true);
      const r = applyPatch(SCHEMA, p, patchAt(l.path, l.leaf.max));
      if (!r.ok) throw new Error(`${l.path}: ${JSON.stringify(r.issues)}`);
      p = r.value;
    }
    expect(carverParamsOf(p)).toEqual(CARVER_MAXIMA);
  });

  test('the ranges §4 gives and the plan\'s where it gives none (P17: the three shape keeps 0 … 1, the other shape leaves 0 … 8)', () => {
    const range = (path: string) => {
      const l = SCHEMA.leaves.find((x) => x.path === path)!;
      return [l.leaf.kind, l.leaf.min, l.leaf.max];
    };
    expect(range('caves.worms.chance')).toEqual(['number', 0, 1]);
    expect(range('caves.worms.length')).toEqual(['int', 32, 160]);
    expect(range('caves.worms.lengthVar')).toEqual(['int', 0, 64]);
    expect(range('caves.worms.radiusMin')).toEqual(['number', 0.1, 2]);
    expect(range('caves.worms.vRatioMax')).toEqual(['number', 0.1, 3]);
    expect(range('caves.worms.floorMin')).toEqual(['number', -1, 1]);
    expect(range('caves.worms.branchChance')).toEqual(['number', 0, 1]);
    expect(range('caves.worms.roomChance')).toEqual(['number', 0, 1]);
    expect(range('caves.worms.roomYScaleMin')).toEqual(['number', 0.1, 0.9]);
    expect(range('caves.worms.startYMax')).toEqual(['int', -64, 320]);
    for (const k of ['pitchKeep', 'yawDriftKeep', 'pitchDriftKeep']) expect(range(`caves.worms.shape.${k}`)).toEqual(['number', 0, 1]);
    for (const k of ['yawStep', 'pitchStep', 'yawDriftMul', 'pitchDriftMul']) expect(range(`caves.worms.shape.${k}`)).toEqual(['number', 0, 8]);
    expect(range('caves.undergroundWorms.chance')).toEqual(['number', 0, 1]);
    expect(range('caves.undergroundWorms.startYMin')).toEqual(['int', -64, 320]);
    expect(range('caves.undergroundWorms.maxY')).toEqual(['int', -32, 120]);
    expect(range('caves.ravines.chance')).toEqual(['number', 0, 0.2]);
    expect(range('caves.ravines.lengthMin')).toEqual(['int', 32, 160]);
    expect(range('caves.ravines.thicknessMax')).toEqual(['number', 0, 8]);
    expect(range('caves.ravines.plateau')).toEqual(['number', 0, 8]);
    expect(range('caves.ravines.yScale')).toEqual(['number', 0.5, 6]);
    expect(range('caves.ravines.widthSmoothness')).toEqual(['int', 1, 16]);
    expect(range('caves.ravines.vRotation')).toEqual(['number', 0, 0.5]);
    expect(range('caves.ravines.startYMax')).toEqual(['int', -64, 320]);
    // Every carver leaf is a Terrain leaf (the terrain stage reads caves.*).
    for (const l of carverLeaves()) expect([l.path, l.meta.stage]).toEqual([l.path, 'terrain']);
  });
});

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
    for (const kind of ALL_KINDS) {
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
    for (const kind of ALL_KINDS) {
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

describe('carverPath: ravine and underground-worm paths (SP6a §2.2-§2.3)', () => {
  test('the ravines\' draw order: every path equals the oracle\'s, bit for bit (ell and widthSq), and a failed roll is null', () => {
    const variants: CarverParams[] = [
      CARVER_DEFAULTS,
      ALWAYS,
      withRavines(ALWAYS, { plateau: 8, thicknessMax: 8, widthSmoothness: 16, vRotation: 0.5, lengthMin: 32, lengthMax: 160 }),
      withRavines(ALWAYS, { plateau: 0, widthSmoothness: 1, yScale: 0.5 }),
      withRavines(CARVER_MAXIMA, { chance: 1 }),
    ];
    for (const p of variants) {
      let built = 0;
      for (const [sx, sz] of firstSources(1500)) {
        const want = ravineOracle(sx, sz, p);
        const got = carverPath(SEED, 'ravine', sx, sz, p);
        if (want === null) { expect(got, `ravine (${sx}, ${sz})`).toBeNull(); continue; }
        built++;
        expect(got, `ravine (${sx}, ${sz})`).not.toBeNull();
        expect(got!.kind).toBe('ravine');
        expect([got!.sx, got!.sz]).toEqual([sx, sz]);
        expect(got!.count).toBe(want.n);
        expect(got!.ell.length).toBe(want.ell.length);
        expect(firstDiff(got!.ell, Float64Array.from(want.ell)), `ravine (${sx}, ${sz})`).toBe(-1);
        expect(firstDiff(got!.widthSq, Float64Array.from(want.widthSq)), `ravine (${sx}, ${sz}) widthSq`).toBe(-1);
      }
      expect(built).toBeGreaterThan(p === CARVER_DEFAULTS ? 10 : 1400);
    }
  });

  test('ravines: n in [84, 112] over 10,000 sources (both ends reached); lengthMin > lengthMax gives n = lengthMin', () => {
    const seen = new Set<number>();
    for (const [sx, sz] of firstSources(10_000)) {
      const path = carverPath(SEED, 'ravine', sx, sz, ALWAYS)!;
      expect(path.count).toBeGreaterThanOrEqual(84);
      expect(path.count).toBeLessThanOrEqual(112);
      expect(Number.isInteger(path.count)).toBe(true);
      seen.add(path.count);
    }
    expect(seen.has(84) && seen.has(112)).toBe(true);
    expect(seen.size).toBe(112 - 84 + 1);
    const inverted = withRavines(ALWAYS, { lengthMin: 120, lengthMax: 90 });
    for (const [sx, sz] of firstSources(2000)) expect(carverPath(SEED, 'ravine', sx, sz, inverted)!.count).toBe(120);
  });

  test('ravines: widthSq holds 384 values f² ∈ [1, 4), constant over each run of widthSmoothness rows from y −64', () => {
    for (const ws of [3, 1, 5, 16]) {
      const p = withRavines(ALWAYS, { widthSmoothness: ws });
      let changes = 0;
      const bad: string[] = [];
      for (const [sx, sz] of firstSources(1000)) {
        const w = carverPath(SEED, 'ravine', sx, sz, p)!.widthSq!;
        if (w.length !== 384) bad.push(`ws ${ws} (${sx}, ${sz}) length ${w.length}`);
        for (let j = 0; j < 384; j++) {
          const v = w[j]!;
          if (!(v >= 1 && v < 4)) bad.push(`ws ${ws} (${sx}, ${sz}) row ${j}: ${v}`);
          if (j % ws !== 0) { if (v !== w[j - 1]) bad.push(`ws ${ws} (${sx}, ${sz}) row ${j} differs inside its run`); }
          else if (j > 0 && v !== w[j - 1]) changes++;
        }
      }
      expect(bad.slice(0, 10)).toEqual([]);
      // A new pair at every run start (two equal draws are vanishingly rare).
      expect(changes).toBeGreaterThan(1000 * (Math.ceil(384 / ws) - 1) * 0.99);
    }
  });

  test('ravines: every rh in [1.5, 1.5 + thicknessMax], rv = rh·yScale, floor −1 (none), at the default plateau and at its static maximum (8)', () => {
    for (const r of [{}, { plateau: 8 }, { thicknessMax: 8, plateau: 8 }, { thicknessMax: 8 }, { thicknessMax: 3, plateau: 0 }, { yScale: 6 }]) {
      const p = withRavines(ALWAYS, r);
      const tMax = p.ravines.thicknessMax;
      let tTop = 0;
      const bad: string[] = [];
      for (const [sx, sz] of firstSources(3000)) {
        const path = carverPath(SEED, 'ravine', sx, sz, p)!;
        const wk = ravineOracle(sx, sz, p)!;
        if (!(wk.t >= 0 && wk.t <= tMax)) bad.push(`(${sx}, ${sz}) t ${wk.t}`);
        tTop = Math.max(tTop, wk.t);
        for (let k = 0; k < path.count; k++) {
          const rh = path.ell[k * 6 + 3]!;
          if (!(rh >= 1.5 && rh <= 1.5 + tMax)) bad.push(`(${sx}, ${sz}) #${k}: rh ${rh}`);
          if (path.ell[k * 6 + 4] !== rh * p.ravines.yScale) bad.push(`(${sx}, ${sz}) #${k}: rv ${path.ell[k * 6 + 4]}`);
          if (path.ell[k * 6 + 5] !== -1) bad.push(`(${sx}, ${sz}) #${k}: floor ${path.ell[k * 6 + 5]}`);
        }
      }
      expect(bad.slice(0, 10), JSON.stringify(r)).toEqual([]);
      // The trapezoid reaches near its top end.
      expect(tTop).toBeGreaterThan(tMax * 0.9);
    }
  });

  test('ravines: the start y in [10, 72] and the start pitch within ±vRotation (the first move\'s rise ≤ sin 0.125)', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [sx, sz] of firstSources(10_000)) {
      const e = carverPath(SEED, 'ravine', sx, sz, ALWAYS)!.ell;
      lo = Math.min(lo, e[1]!);
      hi = Math.max(hi, e[1]!);
      expect(e[1]! >= 10 && e[1]! < 72).toBe(true);
      expect(Math.abs(e[7]! - e[1]!)).toBeLessThanOrEqual(detSin(0.125));
      expect(Math.abs(ravineOracle(sx, sz, ALWAYS)!.pitch0)).toBeLessThanOrEqual(0.125);
    }
    expect(lo).toBeLessThan(11);
    expect(hi).toBeGreaterThan(71);
  });

  test('ravines: both ends taper (C7.endTaper\'s rule) over 10,000 sources', () => {
    const bad: string[] = [];
    let ends = 0;
    for (const [sx, sz] of firstSources(10_000)) {
      const path = carverPath(SEED, 'ravine', sx, sz, ALWAYS)!;
      const n = path.count;
      for (const col of [3, 4]) {
        const steps: number[] = [];
        for (let k = 0; k < n; k++) steps.push(path.ell[k * 6 + col]!);
        const med = median(steps);
        ends += 2;
        if (!tapers(path.ell, col, 0, 0, n, 1, med)) bad.push(`(${sx}, ${sz}) start col ${col}`);
        if (!tapers(path.ell, col, n - 1, 0, n, -1, med)) bad.push(`(${sx}, ${sz}) end col ${col}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(ends).toBe(40_000);
  });

  test('underground worms start in [−56, 24] (the undergroundWorms start range, not the worms\')', () => {
    const p = withWorms(ALWAYS, { roomChance: 0.5 });
    let lo = Infinity;
    let hi = -Infinity;
    for (const [sx, sz] of firstSources(10_000)) {
      const y = carverPath(SEED, 'undergroundWorm', sx, sz, p)!.ell[1]!;
      expect(y >= -56 && y < 24, `(${sx}, ${sz}): ${y}`).toBe(true);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    expect(lo).toBeLessThan(-55);
    expect(hi).toBeGreaterThan(23);
  });
});

describe('reachOverflow, the unit form (SP6a §2.1, §10.1): the window R = CARVER_WINDOW_R', () => {
  /**
   * The paths that reach farthest: every length and radius leaf at its static maximum, no branch (a branch turns the
   * second half by π/2), and no turning (pitchKeep 0, no yaw or pitch steps, vRotation 0), so each path runs straight
   * and level for 159 blocks. The static maxima turn hard (the shape leaves at their maxima), so their paths meander
   * and stay well inside the window; this case reaches the outermost chunk ring, so it fails for any smaller R.
   */
  const straightShape = { ...CARVER_MAXIMA.worms.shape, pitchKeep: 0, yawStep: 0, pitchStep: 0 };
  const STRAIGHT = withRavines(withWorms(CARVER_MAXIMA, { branchChance: 0, lengthVar: 0, shape: straightShape }), { chance: 1, vRotation: 0 });
  const cases: Array<[name: string, p: CarverParams, min: Record<CarverKind, number>, ring: boolean]> = [
    ['the defaults', CARVER_DEFAULTS, { worm: 1000, undergroundWorm: 500, ravine: 80 }, false],
    ['the static maxima', CARVER_MAXIMA, { worm: 9999, undergroundWorm: 9999, ravine: 1500 }, false],
    ['the straightest paths (lengths and radii at their maxima, no turning, no branch)', STRAIGHT, { worm: 9999, undergroundWorm: 9999, ravine: 9999 }, true],
  ];
  for (const [name, p, min, ring] of cases) {
    test(`at ${name}: over 10,000 sources per kind, every path's box lies inside the chunks within R of its source chunk; every ell, box and widthSq value is finite`, () => {
      const R = CARVER_WINDOW_R;
      for (const kind of ALL_KINDS) {
        let paths = 0;
        /** The farthest any box reaches from its source chunk's near edge, in blocks along x or z. */
        let deepest = 0;
        const over: string[] = [];
        for (const [sx, sz] of firstSources(10_000)) {
          const path = carverPath(SEED, kind, sx, sz, p);
          if (path === null) continue;
          paths++;
          for (const v of path.ell) if (!Number.isFinite(v)) { over.push(`${kind} (${sx}, ${sz}) ell ${v}`); break; }
          for (const v of path.box) if (!Number.isFinite(v)) { over.push(`${kind} (${sx}, ${sz}) box ${v}`); break; }
          if (path.widthSq !== null) for (const v of path.widthSq) if (!Number.isFinite(v)) { over.push(`${kind} (${sx}, ${sz}) widthSq ${v}`); break; }
          const b = path.box;
          if (!(b[0]! >= 16 * (sx - R) && b[3]! <= 16 * (sx + R + 1) && b[2]! >= 16 * (sz - R) && b[5]! <= 16 * (sz + R + 1))) {
            over.push(`${kind} (${sx}, ${sz}) box ${Array.from(b).join(', ')}`);
          }
          deepest = Math.max(deepest, 16 * sx + 16 - b[0]!, b[3]! - 16 * sx, 16 * sz + 16 - b[2]!, b[5]! - 16 * sz);
        }
        expect(over.slice(0, 10), `${kind} at ${name}`).toEqual([]);
        expect(paths, `${kind} at ${name}`).toBeGreaterThan(min[kind]);
        // Spec §2.1's bound: no reach beyond 16 + L_max + r_max = 185.5 blocks from the chunk's near edge.
        expect(deepest, `${kind} at ${name}`).toBeLessThan(185.5);
        // The straight paths reach into the outermost ring of chunks: a window of R − 1 would truncate them.
        if (ring) expect(deepest, `${kind} at ${name}`).toBeGreaterThan(16 * R);
      }
    });
  }
});

import { describe, expect, test } from 'vitest';
import { createFnv64, hex64 } from '../../src/core/hash';
import { latticeIndex, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { createDensityBounds, fillDensityColumn, type DensityBounds } from '../../src/gen/density/bounds';
import { colValueIndex, compileDensity, cornerValueIndex, posValueIndex, type CompiledDensity } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr, SlideKnot } from '../../src/gen/density/expr';
import {
  ivAbs, ivAdd, ivClamp, ivHull, ivMax, ivMin, ivMul, ivNeg, ivNoise, ivRangeChoice, ivSet, ivSlide, ivSlideFactor,
  ivSquare, ivUnknown, ivWiden, rangeChoiceCase, valClamp,
} from '../../src/gen/density/nodes';
import { probe } from '../../src/gen/density/probe';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

// SP3d spec §1.9 D: interval poison in nodes.ts and NaN-testing hulls in bounds.ts.

const OUT = new Float64Array(4);
const iv = (f: (out: Float64Array, k: number) => void): [number, number] => { f(OUT, 2); return [OUT[2]!, OUT[3]!]; };
const UNKNOWN: [number, number] = [-Infinity, Infinity];
const BAD = [NaN, Infinity, -Infinity];

/** Each binary op, as (a0, a1, b0, b1) → interval. */
const BINARY: Record<string, (a0: number, a1: number, b0: number, b1: number) => [number, number]> = {
  add: (a0, a1, b0, b1) => iv((o, k) => ivAdd(a0, a1, b0, b1, o, k)),
  mul: (a0, a1, b0, b1) => iv((o, k) => ivMul(a0, a1, b0, b1, o, k)),
  min: (a0, a1, b0, b1) => iv((o, k) => ivMin(a0, a1, b0, b1, o, k)),
  max: (a0, a1, b0, b1) => iv((o, k) => ivMax(a0, a1, b0, b1, o, k)),
  hull: (a0, a1, b0, b1) => iv((o, k) => ivHull(a0, a1, b0, b1, o, k)),
};
const UNARY: Record<string, (x0: number, x1: number) => [number, number]> = {
  set: (x0, x1) => iv((o, k) => ivSet(x0, x1, o, k)),
  neg: (x0, x1) => iv((o, k) => ivNeg(x0, x1, o, k)),
  abs: (x0, x1) => iv((o, k) => ivAbs(x0, x1, o, k)),
  square: (x0, x1) => iv((o, k) => ivSquare(x0, x1, o, k)),
  clamp: (x0, x1) => iv((o, k) => ivClamp(x0, x1, -1, 1, o, k)),
  widen: (x0, x1) => iv((o, k) => ivWiden(x0, x1, o, k)),
  slide: (x0, x1) => iv((o, k) => ivSlide(x0, x1, [[0, 0], [100, 1]], 16, 24, o, k)),
};

/** SP3b's endpoint formulas (the ops before SP3d), for finite inputs. */
const OLD_BINARY: Record<string, (a0: number, a1: number, b0: number, b1: number) => [number, number]> = {
  add: (a0, a1, b0, b1) => [a0 + b0, a1 + b1],
  mul: (a0, a1, b0, b1) => {
    const p = a0 * b0, q = a0 * b1, r = a1 * b0, s = a1 * b1;
    let lo = p, hi = p;
    if (q < lo) lo = q; if (q > hi) hi = q;
    if (r < lo) lo = r; if (r > hi) hi = r;
    if (s < lo) lo = s; if (s > hi) hi = s;
    return [lo, hi];
  },
  min: (a0, a1, b0, b1) => [b0 < a0 ? b0 : a0, b1 < a1 ? b1 : a1],
  max: (a0, a1, b0, b1) => [b0 > a0 ? b0 : a0, b1 > a1 ? b1 : a1],
  hull: (a0, a1, b0, b1) => [b0 < a0 ? b0 : a0, b1 > a1 ? b1 : a1],
};
const OLD_UNARY: Record<string, (x0: number, x1: number) => [number, number]> = {
  set: (x0, x1) => [x0, x1],
  neg: (x0, x1) => [-x1, -x0],
  abs: (x0, x1) => (x0 >= 0 ? [x0, x1] : x1 <= 0 ? [-x1, -x0] : [0, -x0 > x1 ? -x0 : x1]),
  square: (x0, x1) => {
    const a = x0 * x0, b = x1 * x1;
    return x0 >= 0 ? [a, b] : x1 <= 0 ? [b, a] : [0, a > b ? a : b];
  },
  clamp: (x0, x1) => [valClamp(x0, -1, 1), valClamp(x1, -1, 1)],
  widen: (x0, x1) => {
    const w = 1e-9 * (1 + Math.max(Math.abs(x0), Math.abs(x1)));
    return [x0 - w, x1 + w];
  },
  slide: (x0, x1) => OLD_BINARY['mul']!(x0, x1, 0.16, 0.24),
};

/** A random finite endpoint: zeros of both signs, small integers, or a log-uniform magnitude in [1e-6, 1e12]. */
function endpoint(next: () => number): number {
  const r = next() % 8;
  if (r === 0) return 0;
  if (r === 1) return -0;
  if (r === 2) return (next() % 21) - 10;
  const mag = Math.exp(Math.log(1e-6) + (Math.log(1e12) - Math.log(1e-6)) * testFloat(next));
  return next() % 2 === 0 ? mag : -mag;
}
function randIv(next: () => number): [number, number] {
  const a = endpoint(next), b = endpoint(next);
  return a <= b ? [a, b] : [b, a];
}
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

describe('interval poison: UNKNOWN = [−∞, +∞] (SP3d spec §1.9 D)', () => {
  test('every op returns UNKNOWN when any input endpoint is NaN or ±∞', () => {
    for (const [name, f] of Object.entries(BINARY)) {
      for (const bad of BAD) {
        for (let at = 0; at < 4; at++) {
          const args: [number, number, number, number] = [-1, 2, 3, 5];
          args[at] = bad;
          if (!same(f(...args), UNKNOWN)) throw new Error(`${name}(${String(args)}) = [${String(f(...args))}]`);
        }
      }
    }
    for (const [name, f] of Object.entries(UNARY)) {
      for (const bad of BAD) {
        for (const [x0, x1] of [[bad, 2], [-1, bad]] as const) {
          if (!same(f(x0, x1), UNKNOWN)) throw new Error(`${name}(${x0}, ${x1}) = [${String(f(x0, x1))}]`);
        }
      }
    }
    for (const bad of BAD) {
      expect(iv((o, k) => ivClamp(0, 1, bad, 1, o, k))).toEqual(UNKNOWN);
      expect(iv((o, k) => ivClamp(0, 1, 0, bad, o, k))).toEqual(UNKNOWN);
      expect(iv((o, k) => ivNoise(bad, o, k))).toEqual(UNKNOWN);
    }
    const out = new Float64Array(2);
    ivUnknown(out, 0);
    expect([...out]).toEqual(UNKNOWN);
  });

  test('UNKNOWN propagates: max and min do not keep a known side, clamp and rangeChoice never make it known', () => {
    // SP3b's max([−∞, ∞], [1, 1]) was [1, ∞]: the measured unsound early-out (map-density.md §2).
    expect(BINARY['max']!(-Infinity, Infinity, 1, 1)).toEqual(UNKNOWN);
    expect(BINARY['min']!(-1, 1, -Infinity, Infinity)).toEqual(UNKNOWN);
    expect(UNARY['clamp']!(-Infinity, Infinity)).toEqual(UNKNOWN);
    expect(UNARY['abs']!(-Infinity, Infinity)).toEqual(UNKNOWN);
    expect(UNARY['square']!(NaN, NaN)).toEqual(UNKNOWN);
    const rc = (x0: number, x1: number, i0: number, i1: number, o0: number, o1: number): [number, number] =>
      iv((o, k) => ivRangeChoice(x0, x1, 0, 10, i0, i1, o0, o1, o, k));
    expect(rc(-Infinity, Infinity, 1, 1, 2, 2)).toEqual(UNKNOWN);
    expect(rc(NaN, NaN, 1, 1, 2, 2)).toEqual(UNKNOWN);
    // An UNKNOWN branch is UNKNOWN even when x decides the other one.
    expect(rc(1, 2, 1, 1, -Infinity, Infinity)).toEqual(UNKNOWN);
    expect(rc(20, 30, NaN, NaN, 2, 2)).toEqual(UNKNOWN);
    // Known inputs: SP3b's choice.
    expect(rc(1, 2, 1, 1, 2, 2)).toEqual([1, 1]);
    expect(rc(20, 30, 1, 1, 2, 2)).toEqual([2, 2]);
    expect(rc(5, 30, 1, 1, 2, 3)).toEqual([1, 3]);
    expect(rc(-0, 9, -0, 0, 5, 5)).toEqual([-0, 0]);
  });

  test('a NaN result endpoint is UNKNOWN: slide factors with an overflowing segment (0 · ∞ at a knot)', () => {
    const cases: Array<readonly SlideKnot[]> = [
      [[0, -1e308], [1, 1e308]],
      [[0, 0], [5e-324, 1], [10, 1]],
    ];
    for (const knots of cases) {
      expect(iv((o, k) => ivSlideFactor(knots, 0, 8, o, k))).toEqual(UNKNOWN);
      expect(iv((o, k) => ivSlide(1, 2, knots, 0, 8, o, k))).toEqual(UNKNOWN);
      // Away from the segment the factor is known.
      expect(iv((o, k) => ivSlideFactor(knots, 16, 24, o, k))).toEqual([knots[knots.length - 1]![1], knots[knots.length - 1]![1]]);
    }
    // A finite segment that only reaches its overflowing slope at an interior knot (the left formula is ±∞).
    expect(iv((o, k) => ivSlideFactor([[-100, 0], [4, -1e308], [5, 1e308]], 0, 8, o, k))).toEqual(UNKNOWN);
  });

  test('finite inputs give SP3b\'s intervals exactly (±0 included); an overflow keeps its ±∞ end and poisons the parent', () => {
    const next = testRng(707);
    for (let n = 0; n < 3000; n++) {
      const A = randIv(next), B = randIv(next);
      for (const [name, f] of Object.entries(BINARY)) {
        const got = f(A[0], A[1], B[0], B[1]), want = OLD_BINARY[name]!(A[0], A[1], B[0], B[1]);
        if (!same(got, want)) throw new Error(`${name}([${A}], [${B}]) = [${got}], SP3b [${want}]`);
      }
      for (const [name, f] of Object.entries(UNARY)) {
        const got = f(A[0], A[1]), want = OLD_UNARY[name]!(A[0], A[1]);
        if (!same(got, want)) throw new Error(`${name}([${A}]) = [${got}], SP3b [${want}]`);
      }
      const lo = Math.min(B[0], -B[0]), hi = -lo;
      const rcGot = iv((o, k) => ivRangeChoice(A[0], A[1], lo, hi === lo ? hi + 1 : hi, 1, 2, -3, -1, o, k));
      const which = rangeChoiceCase(A[0], A[1], lo, hi === lo ? hi + 1 : hi);
      expect(rcGot).toEqual(which === 'inside' ? [1, 2] : which === 'outside' ? [-3, -1] : [-3, 2]);
    }
    expect(BINARY['mul']!(1e200, 1e200, 1e200, 1e200)).toEqual([Infinity, Infinity]);
    expect(BINARY['add']!(-1e308, 1, -1e308, 1)).toEqual([-Infinity, 2]);
    expect(UNARY['neg']!(...BINARY['mul']!(1e200, 1e200, 1e200, 1e200))).toEqual(UNKNOWN);
  });
});

// ---- bounds.ts: the hulls test every folded value for NaN and the finished hull for finiteness ----

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: 'offset' | 'E'): Expr => ({ op: 'col', field });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });
const interp = (x: Expr): Expr => ({ op: 'interpolated', x });
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });
const none: DensityNoiseSource = () => undefined;

/** A hand-built ColumnSample at column (2, −3): offset i·j + 0.5 and E i + 10·j on the lattice, every other field 0. */
function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      s.f.offset[latticeIndex(i, j)] = i * j + 0.5;
      s.f.E[latticeIndex(i, j)] = i + 10 * j;
    }
  }
  return s;
}

const vIdx = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;
const rootIv = (b: DensityBounds, ci: number, ck: number, cj: number): [number, number] => {
  const out = new Float64Array(2);
  b.cellInterval(ci, ck, cj, out, 0);
  return [out[0]!, out[1]!];
};
const slotOf = (c: CompiledDensity, key: 'colSlot' | 'posSlot' | 'interpSlot'): number => {
  const n = c.nodes.find((d) => d[key] >= 0);
  if (n === undefined) throw new Error(`no ${key}`);
  return n[key];
};

describe('bounds: NaN and ±∞ slot and corner values never decide a cell (SP3d spec §1.9 D)', () => {
  test('a position hull: a NaN or ±∞ at any of the 16 positions makes the root UNKNOWN; finite hulls are unchanged', () => {
    const c = compileDensity(only(add(mul(col('E'), C(0.5)), Y)), none);
    const b = createDensityBounds(c, none);
    const s = handSample();
    c.columnFn(s);
    c.positionFn(s);
    b.beginColumn();
    const clean = rootIv(b, 1, 20, 2), other = rootIv(b, 3, 20, 0);
    expect(clean.every(Number.isFinite)).toBe(true);
    const slot = slotOf(c, 'posSlot');
    for (const bad of BAD) {
      for (let q = 0; q < 16; q++) {
        const lx = 4 + (q & 3), lz = 8 + (q >> 2);
        c.positionFn(s);
        c.posValues[posValueIndex(slot, lx, lz)] = bad;
        b.beginColumn();
        if (!same(rootIv(b, 1, 20, 2), UNKNOWN)) throw new Error(`position (${lx}, ${lz}) = ${bad}: [${String(rootIv(b, 1, 20, 2))}]`);
        // Another cell's hull is untouched.
        expect(rootIv(b, 3, 20, 0)).toEqual(other);
      }
    }
    c.positionFn(s);
    b.beginColumn();
    expect(rootIv(b, 1, 20, 2)).toEqual(clean);
  });

  test('a column hull: a NaN or ±∞ at any of the cell\'s 4 corner columns makes the root UNKNOWN', () => {
    const c = compileDensity(only(interp(add(col('offset'), neg(Y)))), none);
    const b = createDensityBounds(c, none);
    const s = handSample();
    const slot = slotOf(c, 'colSlot');
    for (const bad of BAD) {
      for (const [i, j] of [[1, 2], [2, 2], [1, 3], [2, 3]] as const) {
        c.columnFn(s);
        c.positionFn(s);
        c.colValues[colValueIndex(slot, i, j)] = bad;
        b.beginColumn();
        expect(rootIv(b, 1, 10, 2)).toEqual(UNKNOWN);
        expect(rootIv(b, 3, 10, 0).every(Number.isFinite)).toBe(true);
      }
    }
  });

  test('a corner hull: a NaN or ±∞ at any of the cell\'s 8 corners makes the refined root UNKNOWN', () => {
    const s = handSample();
    const slot = slotOf(compileDensity(only(interp(add(col('offset'), neg(Y)))), none), 'interpSlot');
    const out = new Float64Array(2);
    for (const bad of BAD) {
      for (let q = 0; q < 8; q++) {
        const i = 1 + (q & 1), j = 2 + ((q >> 1) & 1), k = 10 + (q >> 2);
        const fresh = compileDensity(only(interp(add(col('offset'), neg(Y)))), none);
        const fb = createDensityBounds(fresh, none);
        fresh.columnFn(s);
        fresh.positionFn(s);
        fb.beginColumn();
        fb.cellInterval(1, 10, 2, out, 0);
        fresh.cellCorners(1, 10, 2);
        fb.cellIntervalCorners(1, 10, 2, out, 0);
        expect([out[0], out[1]].every(Number.isFinite)).toBe(true);
        fresh.cornerValues[cornerValueIndex(slot, i, k, j)] = bad;
        fb.cellIntervalCorners(1, 10, 2, out, 0);
        if (!same([out[0]!, out[1]!], UNKNOWN)) throw new Error(`corner (${i}, ${k}, ${j}) = ${bad}: [${out[0]}, ${out[1]}]`);
      }
    }
  });

  /** The driver's solidity against a full evaluation of an independent compile; returns the evaluated voxel count. */
  function driverEqualsFull(e: DensityExpr, s: ColumnSample, noises: DensityNoiseSource): number {
    const b = createDensityBounds(compileDensity(e, noises), noises);
    const full = compileDensity(e, noises);
    full.columnFn(s);
    full.positionFn(s);
    const solid = new Uint8Array(98304), mask = new Uint8Array(98304);
    expect(fillDensityColumn(b, s, solid, null, mask, () => false)).toBe(true);
    let masked = 0;
    for (let y = -64; y < 320; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const i = vIdx(lx, y, lz);
          const v = full.voxelFn(lx, y, lz);
          if (solid[i] !== (v > 0 ? 1 : 0)) throw new Error(`voxel (${lx}, ${y}, ${lz}) solid ${solid[i]} but full value ${v}`);
          masked += mask[i]!;
        }
      }
    }
    return masked;
  }

  test('a NaN or ±∞ ColumnSample value: the early-out driver equals full evaluation at every voxel', () => {
    for (const bad of BAD) {
      for (const at of [[2, 2], [0, 0], [4, 4]] as const) {
        const s = handSample();
        s.f.offset[latticeIndex(at[0], at[1])] = bad;
        // A voxel-level read (position hull) and a corner read inside interpolated (column hull), both ≫ 0 elsewhere.
        expect(driverEqualsFull(only(add(col('offset'), C(100))), s, none)).toBeGreaterThan(0);
        expect(driverEqualsFull(only(interp(add(col('offset'), C(100)))), s, none)).toBeGreaterThan(0);
      }
    }
    // Finite values: every cell early-outs solid.
    expect(driverEqualsFull(only(add(col('offset'), C(100))), handSample(), none)).toBe(0);
    expect(driverEqualsFull(only(interp(add(col('offset'), C(100)))), handSample(), none)).toBe(0);
  });

  test('the measured unsound tree max(add(Z, neg(Z)), 1), Z = mul(mul(noise, 1e308), 1e308): voxels evaluated, equal to the probe', () => {
    const tree: DensityExpr = {
      root: { op: 'max', a: add({ op: 'ref', name: 'Z' }, neg({ op: 'ref', name: 'Z' })), b: C(1) },
      defs: { Z: mul(mul({ op: 'noise', id: 'detail' }, C(1e308)), C(1e308)) },
    };
    const dc = createDensityContext(ctxFor('42'), tree);
    const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
    for (const [cx, cz] of [[0, 0], [-5, 7]] as const) {
      expect(fillDensityColumn(dc.bounds, dc.columns.get(cx, cz), solid, values, mask, () => false)).toBe(true);
      let masked = 0, mismatches = 0, nan = 0;
      for (let y = -64; y < 320; y++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const i = vIdx(lx, y, lz);
            masked += mask[i]!;
            const p = probe(dc, 16 * cx + lx, y, 16 * cz + lz);
            if (Number.isNaN(p)) nan++;
            if (solid[i] !== (p > 0 ? 1 : 0)) mismatches++;
            if (mask[i] === 1 && !Object.is(values[i], p)) mismatches++;
          }
        }
      }
      expect(mismatches).toBe(0);
      // The root interval is UNKNOWN in every cell: SP3b's [1, ∞] marked every cell solid without evaluating it.
      expect(masked).toBe(98304);
      expect(nan).toBeGreaterThan(98000);
    }
  });

  test('a constant-valued noise: every voxel is NaN and air, with no early-out', () => {
    const flat: DensityNoise = { dims: 3, remap: 'none', clampSigma: 4, z2: () => 0, z3: () => 1 };
    const noises: DensityNoiseSource = (id) => (id === 'n' ? flat : undefined);
    const tree: DensityExpr = {
      root: { op: 'max', a: add({ op: 'ref', name: 'Z' }, neg({ op: 'ref', name: 'Z' })), b: C(1) },
      defs: { Z: mul(mul({ op: 'noise', id: 'n' }, C(1e308)), C(1e308)) },
    };
    expect(driverEqualsFull(tree, handSample(), noises)).toBe(98304);
  });
});

describe('the default world is unchanged (SP3d spec §1.9 D: proven, not only claimed)', () => {
  test('fillDensityColumn\'s mask and solid arrays over 32 seed-\'42\' columns hash as at main (9fababa)', () => {
    // Computed with main's code (2ffec6a = 9fababa's code) in a detached worktree, by this same loop.
    const dc = createDensityContext(ctxFor('42'));
    const solid = new Uint8Array(98304), mask = new Uint8Array(98304);
    const h = createFnv64();
    let masked = 0, solids = 0;
    for (let i = 0; i < 32; i++) {
      const cx = ((i * 7919) % 513) - 256, cz = ((i * 104729) % 513) - 256;
      expect(fillDensityColumn(dc.bounds, dc.columns.get(cx, cz), solid, null, mask, () => false)).toBe(true);
      h.update(mask).update(solid);
      for (let k = 0; k < 98304; k++) { masked += mask[k]!; solids += solid[k]!; }
    }
    expect(`${hex64(h.digest())} ${masked} ${solids}`).toBe('1e25082c8ed7a949 167808 1040924');
  });
});

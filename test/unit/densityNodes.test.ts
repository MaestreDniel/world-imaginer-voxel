import { describe, expect, test } from 'vitest';
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef } from '../../src/core/noise/types';
import type { ColExpr, Expr, InterpolatedExpr, Noise2Expr, NoiseExpr, RefExpr, SlideKnot } from '../../src/gen/density/expr';
import {
  evalNode, exprClass, inRange, ivAbs, ivAdd, ivClamp, ivHull, ivMax, ivMin, ivMul, ivNeg, ivNoise, ivSet, ivSlide,
  ivSlideFactor, ivSquare, ivWiden, joinClass, ownClass, rangeChoiceCase, slideAt, valAbs, valAdd, valClamp, valMax,
  valMin, valMul, valNeg, valSlide, valSquare, type NodeEnv,
} from '../../src/gen/density/nodes';
import { nextDown, nextUp, testFloat, testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const COL_E: Expr = { op: 'col', field: 'E' };
const N2: Expr = { op: 'noise2', id: 'jag' };
const N3: Expr = { op: 'noise', id: 'overhang' };
const READS: Record<string, number> = { 'col:E': 0.25, 'col:offset': 70, 'noise2:jag': 0.5, 'noise:overhang': -1.5 };
type ReadExpr = ColExpr | Noise2Expr | NoiseExpr | InterpolatedExpr | RefExpr;

/** A test walker over evalNode: children recurse, reads come from READS, and every child visit is logged. */
function evaluate(e: Expr, y: number, log: Expr[] = []): number {
  const env: NodeEnv = {
    y,
    child: (c) => { log.push(c); return evaluate(c, y, log); },
    read: (r: ReadExpr) => {
      const key = r.op === 'col' ? `col:${r.field}` : r.op === 'noise2' || r.op === 'noise' ? `${r.op}:${r.id}` : r.op;
      const v = READS[key];
      if (v === undefined) throw new Error(`no read for ${key}`);
      return v;
    },
  };
  return evalNode(e, env);
}

const OUT = new Float64Array(4);
const iv = (f: (out: Float64Array, k: number) => void): [number, number] => { f(OUT, 2); return [OUT[2]!, OUT[3]!]; };
const inside = (v: number, [lo, hi]: [number, number]): boolean => lo <= v && v <= hi;

/** A random endpoint: small integers, zeros, or a log-uniform magnitude in [1e-6, 1e9] with a random sign. */
function endpoint(next: () => number): number {
  const r = next() % 8;
  if (r === 0) return 0;
  if (r === 1) return -0;
  if (r === 2) return (next() % 21) - 10;
  const mag = Math.exp(Math.log(1e-6) + (Math.log(1e9) - Math.log(1e-6)) * testFloat(next));
  return next() % 2 === 0 ? mag : -mag;
}
function randIv(next: () => number): [number, number] {
  const a = endpoint(next), b = endpoint(next);
  return a <= b ? [a, b] : [b, a];
}
/** Points of [lo, hi]: both ends, their neighbours inside, zero if inside, and uniform draws. */
function pointsIn(next: () => number, [lo, hi]: [number, number]): number[] {
  const out = [lo, hi];
  if (lo < hi) out.push(nextUp(lo), nextDown(hi));
  if (lo <= 0 && hi >= 0) out.push(0, -0);
  for (let i = 0; i < 6; i++) {
    const t = testFloat(next);
    const v = lo + (hi - lo) * t;
    if (v >= lo && v <= hi) out.push(v);
  }
  return out;
}

/** Interval soundness of a binary op: every value of points inside the operand intervals lies in the result. */
function soundBinary(seed: number, val: (a: number, b: number) => number, rule: (a0: number, a1: number, b0: number, b1: number, out: Float64Array, k: number) => void): void {
  const next = testRng(seed);
  for (let n = 0; n < 2000; n++) {
    const A = randIv(next), B = randIv(next);
    const r = iv((o, k) => rule(A[0], A[1], B[0], B[1], o, k));
    for (const a of pointsIn(next, A)) for (const b of pointsIn(next, B)) {
      const v = val(a, b);
      if (!inside(v, r)) throw new Error(`${v} = op(${a}, ${b}) outside [${r}] for [${A}] × [${B}]`);
    }
  }
}
function soundUnary(seed: number, val: (x: number) => number, rule: (x0: number, x1: number, out: Float64Array, k: number) => void): void {
  const next = testRng(seed);
  for (let n = 0; n < 4000; n++) {
    const X = randIv(next);
    const r = iv((o, k) => rule(X[0], X[1], o, k));
    for (const x of pointsIn(next, X)) {
      const v = val(x);
      if (!inside(v, r)) throw new Error(`${v} = op(${x}) outside [${r}] for [${X}]`);
    }
  }
}

describe('leaves', () => {
  test('const: value v, interval [v, v], class COLUMN', () => {
    expect(Object.is(evaluate(C(-0), 0), -0)).toBe(true);
    expect(evaluate(C(2.5), 7)).toBe(2.5);
    expect(iv((o, k) => ivSet(2.5, 2.5, o, k))).toEqual([2.5, 2.5]);
    expect(exprClass(C(1), false, {})).toBe('column');
    expect(exprClass(C(1), true, {})).toBe('column');
  });

  test("y: the point's y, interval the cell's [y0, y1], never COLUMN", () => {
    expect(evaluate(Y, -64)).toBe(-64);
    expect(evaluate(Y, 13)).toBe(13);
    expect(iv((o, k) => ivSet(-64, -56, o, k))).toEqual([-64, -56]);
    expect(exprClass(Y, false, {})).toBe('voxel');
    expect(exprClass(Y, true, {})).toBe('cell');
  });

  test('col, noise2, noise are reads of the caller; col and noise2 are COLUMN, noise is y-dependent', () => {
    expect(evaluate(COL_E, 0)).toBe(0.25);
    expect(evaluate(N2, 0)).toBe(0.5);
    expect(evaluate(N3, 0)).toBe(-1.5);
    expect(exprClass(COL_E, false, {})).toBe('column');
    expect(exprClass(N2, true, {})).toBe('column');
    expect(exprClass(N3, false, {})).toBe('voxel');
    expect(exprClass(N3, true, {})).toBe('cell');
  });

  test('noise interval [−clampSigma, clampSigma] holds for real NormalNoise samples', () => {
    for (const clampSigma of [0.5, 1.5, 3]) {
      const def = completeNoiseDef({ wavelength: 8, octaves: 2, clampSigma });
      const nz = new NormalNoise([1, 2], 'density.test', def);
      const r = iv((o, k) => ivNoise(clampSigma, o, k));
      expect(r).toEqual([-clampSigma, clampSigma]);
      let hitEdge = false;
      for (let i = 0; i < 4000; i++) {
        const x = (i * 7) % 113 - 56, y = (i * 13) % 97 - 48, z = (i * 3) % 89;
        const a = nz.z2(x, z), b = nz.z3(x, y, z);
        expect(inside(a, r) && inside(b, r)).toBe(true);
        if (Math.abs(b) === clampSigma) hitEdge = true;
      }
      if (clampSigma === 0.5) expect(hitEdge).toBe(true);
    }
  });
});

describe('binary ops: a then b, IEEE in the written order', () => {
  test('evaluation order is a, then b', () => {
    for (const op of ['add', 'mul', 'min', 'max'] as const) {
      const a = C(1), b = C(2);
      const log: Expr[] = [];
      evaluate({ op, a, b }, 0, log);
      expect(log[0]).toBe(a);
      expect(log[1]).toBe(b);
      expect(log.length).toBe(2);
    }
  });

  test('add: a + b, −0 rules, endpoint interval', () => {
    expect(evaluate({ op: 'add', a: C(0.1), b: C(0.2) }, 0)).toBe(0.1 + 0.2);
    expect(Object.is(valAdd(-0, -0), -0)).toBe(true);
    expect(Object.is(valAdd(-0, 0), 0)).toBe(true);
    expect(iv((o, k) => ivAdd(-1, 2, 3, 5, o, k))).toEqual([2, 7]);
    soundBinary(201, valAdd, ivAdd);
    expect(exprClass({ op: 'add', a: COL_E, b: N2 }, false, {})).toBe('column');
    expect(exprClass({ op: 'add', a: COL_E, b: Y }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'add', a: Y, b: COL_E }, true, {})).toBe('cell');
  });

  test('mul: a · b, signed zeros, the min and max of the four endpoint products', () => {
    expect(evaluate({ op: 'mul', a: C(3), b: C(-0.5) }, 0)).toBe(-1.5);
    expect(Object.is(valMul(-0, 5), -0)).toBe(true);
    expect(Object.is(valMul(-0, -5), 0)).toBe(true);
    expect(iv((o, k) => ivMul(-2, 3, -5, 4, o, k))).toEqual([-15, 12]);
    expect(iv((o, k) => ivMul(1, 2, 3, 4, o, k))).toEqual([3, 8]);
    soundBinary(202, valMul, ivMul);
    expect(exprClass({ op: 'mul', a: N3, b: C(2) }, true, {})).toBe('cell');
  });

  test('min: b < a ? b : a, ties (also +0 against −0) return a, endpoint-wise interval', () => {
    expect(valMin(3, 2)).toBe(2);
    expect(valMin(2, 3)).toBe(2);
    expect(Object.is(valMin(0, -0), 0)).toBe(true);
    expect(Object.is(valMin(-0, 0), -0)).toBe(true);
    expect(Object.is(evaluate({ op: 'min', a: C(-0), b: C(0) }, 0), -0)).toBe(true);
    expect(iv((o, k) => ivMin(-1, 5, 2, 3, o, k))).toEqual([-1, 3]);
    soundBinary(203, valMin, ivMin);
    expect(exprClass({ op: 'min', a: C(1), b: COL_E }, false, {})).toBe('column');
  });

  test('max: b > a ? b : a, ties (also +0 against −0) return a, endpoint-wise interval', () => {
    expect(valMax(3, 2)).toBe(3);
    expect(valMax(2, 3)).toBe(3);
    expect(Object.is(valMax(0, -0), 0)).toBe(true);
    expect(Object.is(valMax(-0, 0), -0)).toBe(true);
    expect(Object.is(evaluate({ op: 'max', a: C(0), b: C(-0) }, 0), 0)).toBe(true);
    expect(iv((o, k) => ivMax(-1, 5, 2, 3, o, k))).toEqual([2, 5]);
    soundBinary(204, valMax, ivMax);
    expect(exprClass({ op: 'max', a: C(1), b: N3 }, false, {})).toBe('voxel');
  });
});

describe('unary ops', () => {
  test('neg: −x (neg 0 is −0), interval [−x1, −x0]', () => {
    expect(evaluate({ op: 'neg', x: C(2) }, 0)).toBe(-2);
    expect(Object.is(valNeg(0), -0)).toBe(true);
    expect(iv((o, k) => ivNeg(-1, 4, o, k))).toEqual([-4, 1]);
    soundUnary(301, valNeg, ivNeg);
    expect(exprClass({ op: 'neg', x: Y }, true, {})).toBe('cell');
  });

  test('abs: |x| (|−0| is +0), exact image interval', () => {
    expect(evaluate({ op: 'abs', x: C(-2) }, 0)).toBe(2);
    expect(Object.is(valAbs(-0), 0)).toBe(true);
    expect(iv((o, k) => ivAbs(-3, 2, o, k))).toEqual([0, 3]);
    expect(iv((o, k) => ivAbs(1, 4, o, k))).toEqual([1, 4]);
    expect(iv((o, k) => ivAbs(-4, -1, o, k))).toEqual([1, 4]);
    soundUnary(302, valAbs, ivAbs);
    expect(exprClass({ op: 'abs', x: N2 }, false, {})).toBe('column');
  });

  test('square: x · x (square −0 is +0), exact image interval', () => {
    expect(evaluate({ op: 'square', x: C(-3) }, 0)).toBe(9);
    expect(Object.is(valSquare(-0), 0)).toBe(true);
    expect(iv((o, k) => ivSquare(-3, 2, o, k))).toEqual([0, 9]);
    expect(iv((o, k) => ivSquare(2, 3, o, k))).toEqual([4, 9]);
    expect(iv((o, k) => ivSquare(-3, -2, o, k))).toEqual([4, 9]);
    soundUnary(303, valSquare, ivSquare);
    expect(exprClass({ op: 'square', x: N3 }, false, {})).toBe('voxel');
  });

  test('clamp: x < lo ? lo : x > hi ? hi : x (−0 stays −0), monotone interval', () => {
    const cl = (x: number): Expr => ({ op: 'clamp', x: C(x), lo: 0, hi: 1 });
    expect(evaluate(cl(-2), 0)).toBe(0);
    expect(evaluate(cl(5), 0)).toBe(1);
    expect(evaluate(cl(0.5), 0)).toBe(0.5);
    expect(Object.is(valClamp(-0, 0, 1), -0)).toBe(true);
    expect(Object.is(valClamp(0, -1, -0), 0)).toBe(true);
    expect(iv((o, k) => ivClamp(-5, 0.5, 0, 1, o, k))).toEqual([0, 0.5]);
    expect(iv((o, k) => ivClamp(3, 7, 0, 1, o, k))).toEqual([1, 1]);
    const next = testRng(304);
    for (let n = 0; n < 500; n++) {
      const [lo, hi] = randIv(next);
      soundUnaryOnce(next, (x) => valClamp(x, lo, hi), (x0, x1, o, k) => ivClamp(x0, x1, lo, hi, o, k));
    }
    expect(exprClass({ op: 'clamp', x: COL_E, lo: 0, hi: 1 }, false, {})).toBe('column');
  });
});

function soundUnaryOnce(next: () => number, val: (x: number) => number, rule: (x0: number, x1: number, out: Float64Array, k: number) => void): void {
  for (let n = 0; n < 8; n++) {
    const X = randIv(next);
    const r = iv((o, k) => rule(X[0], X[1], o, k));
    for (const x of pointsIn(next, X)) if (!inside(val(x), r)) throw new Error(`${val(x)} = op(${x}) outside [${r}]`);
  }
}

describe('slide', () => {
  const SLIDE: SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

  test('segments are half-open, constant beyond the end knots (also at the last knot)', () => {
    expect(slideAt(SLIDE, -100)).toBe(0);
    expect(slideAt(SLIDE, -64)).toBe(0);
    expect(slideAt(SLIDE, -52)).toBe(0.5);
    expect(slideAt(SLIDE, -40)).toBe(1);
    expect(slideAt(SLIDE, 239.5)).toBe(1);
    expect(slideAt(SLIDE, 280)).toBe(0.5);
    expect(slideAt(SLIDE, 320)).toBe(0);
    expect(slideAt(SLIDE, 400)).toBe(0);
    // At an interior knot the right segment starts: its value is exactly v_k.
    const K: SlideKnot[] = [[0, 0], [3, 1], [10, -0.3]];
    expect(slideAt(K, 3)).toBe(1);
    expect(slideAt(K, nextDown(3))).toBeLessThan(1);
  });

  test('s(y) = v_k + (y − y_k) · ((v_{k+1} − v_k) / (y_{k+1} − y_k)) bit for bit', () => {
    const next = testRng(401);
    let otherOrderDiffers = 0;
    for (let n = 0; n < 20000; n++) {
      const y0 = -100 + 200 * testFloat(next), y1 = y0 + 1e-3 + 50 * testFloat(next);
      const v0 = -3 + 6 * testFloat(next), v1 = -3 + 6 * testFloat(next);
      const y = y0 + (y1 - y0) * testFloat(next);
      if (!(y >= y0 && y < y1)) continue;
      const pinned = v0 + (y - y0) * ((v1 - v0) / (y1 - y0));
      expect(Object.is(slideAt([[y0, v0], [y1, v1]], y), pinned)).toBe(true);
      if (pinned !== v0 + ((y - y0) * (v1 - v0)) / (y1 - y0)) otherOrderDiffers++;
    }
    expect(otherOrderDiffers).toBeGreaterThan(0);
  });

  test('value x · s(y), class never COLUMN', () => {
    expect(evaluate({ op: 'slide', x: C(4), knots: SLIDE }, -52)).toBe(2);
    expect(valSlide(4, SLIDE, -52)).toBe(2);
    expect(Object.is(valSlide(-0, SLIDE, 0), -0)).toBe(true);
    const log: Expr[] = [];
    const x = C(3);
    evaluate({ op: 'slide', x, knots: SLIDE }, 0, log);
    expect(log).toEqual([x]);
    expect(exprClass({ op: 'slide', x: C(1), knots: SLIDE }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'slide', x: COL_E, knots: SLIDE }, true, {})).toBe('cell');
  });

  test('interval: s at y0 and y1, and both the left formula and v_k at interior knots', () => {
    expect(iv((o, k) => ivSlideFactor(SLIDE, -64, -56, o, k))).toEqual([0, 1 / 3]);
    expect(iv((o, k) => ivSlideFactor(SLIDE, -48, 256, o, k))).toEqual([2 / 3, 1]);
    expect(iv((o, k) => ivSlideFactor(SLIDE, -100, 400, o, k))).toEqual([0, 1]);
    expect(iv((o, k) => ivSlide(-2, 3, SLIDE, -48, 256, o, k))).toEqual([-2, 3]);
    const next = testRng(402);
    for (let n = 0; n < 3000; n++) {
      const count = 2 + (next() % 4);
      const knots: SlideKnot[] = [];
      let y = -50 + 20 * testFloat(next);
      for (let i = 0; i < count; i++) {
        knots.push([y, next() % 5 === 0 ? endpoint(next) : -2 + 4 * testFloat(next)]);
        y += 1e-3 + 30 * testFloat(next);
      }
      let a = -70 + 140 * testFloat(next), b = -70 + 140 * testFloat(next);
      if (next() % 3 === 0) a = knots[next() % count]![0];
      if (next() % 3 === 0) b = knots[next() % count]![0];
      const [y0, y1] = a <= b ? [a, b] : [b, a];
      const s = iv((o, k) => ivSlideFactor(knots, y0, y1, o, k));
      const ys = [y0, y1, nextUp(y0), nextDown(y1), y0 + (y1 - y0) * testFloat(next)];
      for (let i = 0; i < count; i++) {
        const [yk, vk] = knots[i]!;
        if (yk > y0 && yk <= y1) {
          ys.push(yk, nextDown(yk));
          expect(inside(vk, s)).toBe(true);
          if (i > 0) {
            const [ya, va] = knots[i - 1]!;
            expect(inside(va + (yk - ya) * ((vk - va) / (yk - ya)), s)).toBe(true);
          }
        }
      }
      for (const q of ys) if (q >= y0 && q <= y1) expect(inside(slideAt(knots, q), s)).toBe(true);
      const X = randIv(next);
      const r = iv((o, k) => ivSlide(X[0], X[1], knots, y0, y1, o, k));
      for (const x of pointsIn(next, X)) for (const q of ys) if (q >= y0 && q <= y1) {
        if (!inside(valSlide(x, knots, q), r)) throw new Error(`slide(${x}, ${q}) outside [${r}]`);
      }
    }
  });
});

describe('structure', () => {
  test('interpolated: a read of the caller; class VOXEL; nothing interpolated inside it', () => {
    expect(() => evaluate({ op: 'interpolated', x: Y }, 0)).toThrow(/no read for interpolated/);
    expect(exprClass({ op: 'interpolated', x: C(1) }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'interpolated', x: Y }, false, {})).toBe('voxel');
    expect(() => exprClass({ op: 'interpolated', x: Y }, true, {})).toThrow(/interpolated/);
  });

  test('rangeChoice: x first, then only the chosen branch; lo ≤ x < hi chooses inside', () => {
    const x = C(0.5), a = C(10), b = C(20);
    const log: Expr[] = [];
    expect(evaluate({ op: 'rangeChoice', x, lo: 0, hi: 1, inside: a, outside: b }, 0, log)).toBe(10);
    expect(log).toEqual([x, a]);
    expect(log[1]).toBe(a);
    const log2: Expr[] = [];
    expect(evaluate({ op: 'rangeChoice', x: C(1), lo: 0, hi: 1, inside: a, outside: b }, 0, log2)).toBe(20);
    expect(log2[1]).toBe(b);
    expect(log2.length).toBe(2);
    expect(inRange(0, 0, 1)).toBe(true);
    expect(inRange(-0, 0, 1)).toBe(true);
    expect(inRange(1, 0, 1)).toBe(false);
    expect(inRange(nextDown(0), 0, 1)).toBe(false);
  });

  test('rangeChoice interval: inside if x ⊆ [lo, hi), outside if disjoint, hull otherwise', () => {
    expect(rangeChoiceCase(0.2, 0.5, 0, 1)).toBe('inside');
    expect(rangeChoiceCase(0, nextDown(1), 0, 1)).toBe('inside');
    expect(rangeChoiceCase(1, 2, 0, 1)).toBe('outside');
    expect(rangeChoiceCase(-1, nextDown(0), 0, 1)).toBe('outside');
    expect(rangeChoiceCase(-1, 0, 0, 1)).toBe('both');
    expect(rangeChoiceCase(0.5, 1, 0, 1)).toBe('both');
    expect(rangeChoiceCase(-5, 5, 0, 1)).toBe('both');
    expect(iv((o, k) => ivHull(-1, 2, 5, 6, o, k))).toEqual([-1, 6]);
    expect(iv((o, k) => ivHull(3, 4, -2, 3.5, o, k))).toEqual([-2, 4]);
    const next = testRng(501);
    for (let n = 0; n < 4000; n++) {
      const X = randIv(next), R = randIv(next);
      if (!(R[0] < R[1])) continue;
      const c = rangeChoiceCase(X[0], X[1], R[0], R[1]);
      for (const x of pointsIn(next, X)) {
        const inR = inRange(x, R[0], R[1]);
        if (c === 'inside') expect(inR).toBe(true);
        if (c === 'outside') expect(inR).toBe(false);
      }
    }
    expect(exprClass({ op: 'rangeChoice', x: COL_E, lo: 0, hi: 1, inside: C(1), outside: N3 }, false, {})).toBe('voxel');
    expect(exprClass({ op: 'rangeChoice', x: COL_E, lo: 0, hi: 1, inside: C(1), outside: N2 }, true, {})).toBe('column');
  });

  test('tap and ref pass the child through (value, interval, class)', () => {
    const x = C(7);
    const log: Expr[] = [];
    expect(evaluate({ op: 'tap', name: 't', x }, 0, log)).toBe(7);
    expect(log).toEqual([x]);
    expect(() => evaluate({ op: 'ref', name: 'd' }, 0)).toThrow(/no read for ref/);
    const defs = { d: { op: 'add', a: Y, b: C(1) } as Expr, e: COL_E, f: { op: 'ref', name: 'e' } as Expr };
    expect(exprClass({ op: 'ref', name: 'd' }, false, defs)).toBe('voxel');
    expect(exprClass({ op: 'ref', name: 'd' }, true, defs)).toBe('cell');
    expect(exprClass({ op: 'tap', name: 't', x: { op: 'ref', name: 'f' } }, false, defs)).toBe('column');
    expect(() => exprClass({ op: 'ref', name: 'zz' }, false, defs)).toThrow(/zz/);
  });
});

describe('class rule (SP3b spec §2.1)', () => {
  test('ownClass and joinClass: COLUMN < CELL < VOXEL', () => {
    expect(ownClass('const', false)).toBe('column');
    expect(ownClass('noise2', true)).toBe('column');
    expect(ownClass('add', false)).toBe('column');
    for (const op of ['y', 'slide', 'noise'] as const) {
      expect(ownClass(op, true)).toBe('cell');
      expect(ownClass(op, false)).toBe('voxel');
    }
    expect(ownClass('interpolated', false)).toBe('voxel');
    expect(joinClass('column', 'cell')).toBe('cell');
    expect(joinClass('voxel', 'cell')).toBe('voxel');
    expect(joinClass('column', 'column')).toBe('column');
  });

  test('the memo is shared across calls and DAG-shaped trees stay linear', () => {
    let e: Expr = { op: 'add', a: COL_E, b: N2 };
    for (let i = 0; i < 60; i++) e = { op: 'add', a: e, b: e };
    const memo = new WeakMap<Expr, boolean>();
    expect(exprClass(e, false, {}, memo)).toBe('column');
    expect(memo.get(e)).toBe(true);
    let f: Expr = Y;
    for (let i = 0; i < 60; i++) f = { op: 'max', a: f, b: f };
    expect(exprClass(f, true, {}, memo)).toBe('cell');
  });
});

describe('widening (SP3b spec §1.2)', () => {
  test('w = 1e-9 · (1 + max(|lo|, |hi|)) on both ends', () => {
    const w = 1e-9 * (1 + 1e9);
    expect(iv((o, k) => ivWiden(-1e9, 0, o, k))).toEqual([-1e9 - w, w]);
    expect(iv((o, k) => ivWiden(2, 3, o, k))).toEqual([2 - 4e-9, 3 + 4e-9]);
    const next = testRng(601);
    for (let n = 0; n < 5000; n++) {
      const [lo, hi] = randIv(next);
      const [a, b] = iv((o, k) => ivWiden(lo, hi, o, k));
      expect(a < lo && b > hi).toBe(true);
      // A lerp of two values inside [lo, hi] stays inside the widened interval.
      const p = lo + (hi - lo) * testFloat(next), q = lo + (hi - lo) * testFloat(next);
      const t = testFloat(next);
      const l = p + t * (q - p);
      expect(l >= a && l <= b).toBe(true);
    }
  });
});

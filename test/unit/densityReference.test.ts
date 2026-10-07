import { describe, expect, test } from 'vitest';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr, InterpolatedExpr } from '../../src/gen/density/expr';
import { ExprValidationError } from '../../src/gen/density/expr';
import { cellXZ, cellY, cornerY, fracXZ, fracY, lerp, trilerp } from '../../src/gen/density/nodes';
import { createDensityReference, findTap, interpolatedNodes } from '../../src/gen/density/reference';
import { buildColumnSample, latticeIndex, newColumnSample, readField, SAMPLE_FIELDS, type ColumnSample } from '../../src/gen/column/columnStage';
import { fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testFloat, testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: (typeof SAMPLE_FIELDS)[number]): Expr => ({ op: 'col', field });
const n2 = (id: string): Expr => ({ op: 'noise2', id });
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): InterpolatedExpr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });

/** A fake density noise: z2/z3 are plain functions of world coordinates; every call is logged. */
function fake(dims: 2 | 3, f: (x: number, y: number, z: number) => number, log: number[][] = []): DensityNoise {
  return {
    dims, remap: 'none', clampSigma: 4,
    z2: (x, z) => { log.push([x, z]); return f(x, 0, z); },
    z3: (x, y, z) => { log.push([x, y, z]); return f(x, y, z); },
  };
}
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

/** A hand-built ColumnSample at column (2, −3): E is i + 10·j on the lattice, every other field 0. */
function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) s.f.E[latticeIndex(i, j)] = i + 10 * j;
  return s;
}
const X0 = 32;   // 16 · cx
const Z0 = -48;  // 16 · cz

describe('geometry (SP3b spec §2.2)', () => {
  test('cells are 4 × 8 × 4, corners at y = −64 + 8k', () => {
    expect([0, 3, 4, 7, 8, 15].map(cellXZ)).toEqual([0, 0, 1, 1, 2, 3]);
    expect([0, 1, 3, 4, 15].map(fracXZ)).toEqual([0, 0.25, 0.75, 0, 0.75]);
    expect([-64, -57, -56, 0, 318, 319].map(cellY)).toEqual([0, 0, 1, 8, 47, 47]);
    expect([-64, -63, -57, -56, 319].map(fracY)).toEqual([0, 0.125, 0.875, 0, 0.875]);
    expect([0, 1, 8, 48].map(cornerY)).toEqual([-64, -56, 0, 320]);
  });

  test('lerp is a + t · (b − a), in that order', () => {
    const next = testRng(301);
    for (let n = 0; n < 2000; n++) {
      const a = (testFloat(next) - 0.5) * 1e6, b = (testFloat(next) - 0.5) * 1e-3, t = testFloat(next);
      expect(Object.is(lerp(a, b, t), a + t * (b - a))).toBe(true);
    }
    // The other common form, (1 − t) · a + t · b, gives another double here.
    expect(lerp(0.1, 0.7, 0.3)).not.toBe((1 - 0.3) * 0.1 + 0.3 * 0.7);
  });

  test('trilerp lerps along x on the four x-edges, then along z, then along y', () => {
    const next = testRng(302);
    let discriminating = 0;
    for (let n = 0; n < 2000; n++) {
      const c = Array.from({ length: 8 }, () => (testFloat(next) - 0.5) * 10 ** (next() % 12));
      const [c000, c100, c001, c101, c010, c110, c011, c111] = c as [number, number, number, number, number, number, number, number];
      const tx = (next() % 4) / 4, ty = (next() % 8) / 8, tz = (next() % 4) / 4;
      const L = (a: number, b: number, t: number) => a + t * (b - a);
      const xzy = L(L(L(c000, c100, tx), L(c001, c101, tx), tz), L(L(c010, c110, tx), L(c011, c111, tx), tz), ty);
      const yzx = L(L(L(c000, c010, ty), L(c001, c011, ty), tz), L(L(c100, c110, ty), L(c101, c111, ty), tz), tx);
      expect(Object.is(trilerp(c000, c100, c001, c101, c010, c110, c011, c111, tx, ty, tz), xzy)).toBe(true);
      if (!Object.is(xzy, yzx)) discriminating++;
    }
    expect(discriminating).toBeGreaterThan(100);
  });
});

describe('reference interpreter: hand-computed values', () => {
  const s = handSample();

  test('const, y and arithmetic at a voxel', () => {
    const r = createDensityReference(only(add(Y, C(0.5))), source({}));
    expect(r.voxel(s, X0 + 3, 70, Z0 + 9)).toBe(70.5);
    expect(r.voxel(s, X0, -64, Z0)).toBe(-63.5);
    expect(r.voxel(s, X0 + 15, 319, Z0 + 15)).toBe(319.5);
  });

  test('col at a voxel is the bilinear readout; at a corner it is the lattice value exactly', () => {
    const r = createDensityReference(only(col('E')), source({}));
    expect(r.voxel(s, X0 + 6, 0, Z0 + 10)).toBe(1.5 + 25);
    expect(r.voxel(s, X0 + 6, 0, Z0 + 10)).toBe(readField(s, 'E', X0 + 6, Z0 + 10));
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) expect(r.corner(s, col('E'), i, 17, j)).toBe(i + 10 * j);
    // A lattice value the bilinear readout cannot reach at x = 16: v00 + (v10 − v00) · 1 ≠ v10.
    const t = handSample();
    t.f.E[latticeIndex(3, 0)] = 1e17;
    t.f.E[latticeIndex(4, 0)] = 0.1;
    expect(readField(t, 'E', X0 + 16, Z0)).not.toBe(0.1);
    expect(r.corner(t, col('E'), 4, 0, 0)).toBe(0.1);
  });

  test('noises sample unscaled world coordinates: the voxel at a voxel, the corner at a corner', () => {
    const log: number[][] = [];
    const noises = source({ a: fake(2, (x, _y, z) => x + 0.5 * z, log), b: fake(3, (x, y, z) => x + 2 * y + 4 * z, log) });
    const r = createDensityReference(only(add(n2('a'), n3('b'))), noises);
    expect(r.voxel(s, X0 + 5, 70, Z0 + 2)).toBe(37 + 0.5 * -46 + (37 + 140 + 4 * -46));
    expect(log).toEqual([[37, -46], [37, 70, -46]]);
    log.length = 0;
    expect(r.corner(s, add(n2('a'), n3('b')), 1, 3, 4)).toBe(36 + 0.5 * -32 + (36 + 2 * -40 + 4 * -32));
    expect(log).toEqual([[36, -32], [36, -40, -32]]);
  });

  test('interpolated reproduces y and affine fields exactly, and interpolates a non-affine noise in x, z, y order', () => {
    const affine = fake(3, (x, y, z) => 0.25 * x - 0.5 * y + 2 * z);
    const bumpy = fake(3, (x, y, z) => Math.sin(x * 0.3) * 1e3 + Math.cos(z * 0.7) * 7 + y * y * 0.001);
    const r = createDensityReference(only(interp(Y)), source({ a: affine, b: bumpy }));
    for (let y = -64; y <= 319; y++) expect(r.voxel(s, X0 + (y & 15), y, Z0 + ((y >> 4) & 15))).toBe(y);
    const ra = createDensityReference(only(interp(n3('a'))), source({ a: affine }));
    for (const [lx, y, lz] of [[0, -64, 0], [5, 70, 9], [15, 319, 15], [3, -57, 12]] as const) {
      expect(ra.voxel(s, X0 + lx, y, Z0 + lz)).toBe(0.25 * (X0 + lx) - 0.5 * y + 2 * (Z0 + lz));
    }
    const rb = createDensityReference(only(interp(n3('b'))), source({ b: bumpy }));
    const f = (x: number, y: number, z: number) => bumpy.z3(x, y, z);
    for (const [lx, y, lz] of [[1, 70, 2], [7, -61, 13], [14, 300, 5]] as const) {
      const ci = lx >> 2, cj = lz >> 2, ck = (y + 64) >> 3;
      const x0 = X0 + 4 * ci, z0 = Z0 + 4 * cj, y0 = -64 + 8 * ck;
      const tx = (lx - 4 * ci) / 4, ty = (y + 64 - 8 * ck) / 8, tz = (lz - 4 * cj) / 4;
      const L = (a: number, b: number, t: number) => a + t * (b - a);
      const e00 = L(f(x0, y0, z0), f(x0 + 4, y0, z0), tx), e01 = L(f(x0, y0, z0 + 4), f(x0 + 4, y0, z0 + 4), tx);
      const e10 = L(f(x0, y0 + 8, z0), f(x0 + 4, y0 + 8, z0), tx), e11 = L(f(x0, y0 + 8, z0 + 4), f(x0 + 4, y0 + 8, z0 + 4), tx);
      const want = L(L(e00, e01, tz), L(e10, e11, tz), ty);
      expect(Object.is(rb.voxel(s, X0 + lx, y, Z0 + lz), want)).toBe(true);
      expect(rb.voxel(s, X0 + lx, y, Z0 + lz)).not.toBe(f(X0 + lx, y, Z0 + lz));
    }
  });

  test('placement: y and slide read the voxel y outside interpolated and the corner y inside', () => {
    const slide: Expr = { op: 'slide', x: C(1), knots: [[-64, 0], [-60, 1], [400, 1]] };
    const r = createDensityReference(only(slide), source({}));
    expect(r.voxel(s, X0, -62, Z0)).toBe(0.5);
    const ri = createDensityReference(only(interp(slide)), source({}));
    expect(ri.voxel(s, X0, -62, Z0)).toBe(0.25); // corners s(−64) = 0 and s(−56) = 1, ty = 2/8
    // noise2 at a voxel is sampled at the voxel; inside interpolated it is the bilinear blend of its corners.
    const q = fake(2, (x, _y, z) => x * x + z);
    const r2 = createDensityReference(only(n2('q')), source({ q }));
    const r2i = createDensityReference(only(interp(n2('q'))), source({ q }));
    expect(r2.voxel(s, X0 + 2, 10, Z0)).toBe(34 * 34 - 48);
    expect(r2i.voxel(s, X0 + 2, 10, Z0)).toBe(lerp(32 * 32 - 48, 36 * 36 - 48, 0.5));
  });

  test('rangeChoice evaluates x, then only the chosen branch', () => {
    const boom = fake(3, () => { throw new Error('evaluated'); });
    const e: Expr = { op: 'rangeChoice', x: Y, lo: 0, hi: 64, inside: C(1), outside: n3('boom') };
    const r = createDensityReference(only(e), source({ boom }));
    expect(r.voxel(s, X0, 0, Z0)).toBe(1);
    expect(r.voxel(s, X0, 63, Z0)).toBe(1);
    expect(() => r.voxel(s, X0, 64, Z0)).toThrow('evaluated');
    expect(() => r.voxel(s, X0, -1, Z0)).toThrow('evaluated');
  });

  test('ref resolves through defs at the placement of its use', () => {
    const defs = { h: add(Y, col('E')) };
    const r = createDensityReference(only({ op: 'max', a: { op: 'ref', name: 'h' }, b: interp({ op: 'ref', name: 'h' }) }, defs), source({}));
    // At lx = 2, lz = 0: E = 0.5 (bilinear) at the voxel; inside interpolated the corners give the same affine value.
    expect(r.voxel(s, X0 + 2, 5, Z0)).toBe(5.5);
  });

  test('taps: outside interpolated the tap is its x at the voxel; inside, its corners interpolated', () => {
    const q = fake(3, (x, y, z) => x * y + z);
    const root: Expr = add({ op: 'tap', name: 'outer', x: interp({ op: 'tap', name: 'inner', x: n3('q') }) }, { op: 'tap', name: 'v', x: Y });
    const r = createDensityReference(only(root, { unused: { op: 'tap', name: 'lost', x: C(1) } }), source({ q }));
    const [x, y, z] = [X0 + 5, 33, Z0 + 7];
    const interpolatedQ = createDensityReference(only(interp(n3('q'))), source({ q })).voxel(s, x, y, z);
    expect(r.tap(s, 'outer', x, y, z)).toBe(interpolatedQ);
    expect(r.tap(s, 'inner', x, y, z)).toBe(interpolatedQ);
    expect(r.tap(s, 'v', x, y, z)).toBe(33);
    expect(r.voxel(s, x, y, z)).toBe(interpolatedQ + 33);
    expect(() => r.tap(s, 'lost', x, y, z)).toThrow(/no tap "lost"/);
    expect(() => r.tap(s, 'nope', x, y, z)).toThrow(/no tap "nope"/);
    expect(findTap(r.expr, 'inner')).toMatchObject({ inside: true });
    expect(findTap(r.expr, 'outer')).toMatchObject({ inside: false });
    expect(findTap(r.expr, 'lost')).toBeUndefined();
  });

  test('interpolatedNodes lists each reachable interpolated once, in evaluation order', () => {
    const a = interp(Y), b = interp(col('E'));
    const defs = { d: a, unused: interp(C(2)) };
    const e = only(add({ op: 'ref', name: 'd' }, add(b, { op: 'ref', name: 'd' })), defs);
    expect(interpolatedNodes(e)).toEqual([a, b]);
    expect(interpolatedNodes(e)[0]).toBe(a);
  });

  test('rejects invalid expressions and points outside the sample', () => {
    expect(() => createDensityReference(only(n3('missing')), source({}))).toThrow(ExprValidationError);
    expect(() => createDensityReference(only(interp(interp(Y))), source({}))).toThrow(ExprValidationError);
    const r = createDensityReference(only(Y), source({}));
    expect(() => r.voxel(s, X0 + 16, 0, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0 - 1, 0, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0, 0, Z0 + 16)).toThrow(RangeError);
    expect(() => r.voxel(s, X0, -65, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0, 320, Z0)).toThrow(RangeError);
    expect(() => r.voxel(s, X0 + 0.5, 0, Z0)).toThrow(RangeError);
    expect(() => r.corner(s, Y, 5, 0, 0)).toThrow(RangeError);
    expect(() => r.corner(s, Y, 0, 49, 0)).toThrow(RangeError);
    expect(() => r.corner(s, Y, 0, 0, -1)).toThrow(RangeError);
    expect(() => r.corner(s, interp(Y), 0, 0, 0)).toThrow(/interpolated/);
  });
});

describe('reference interpreter on real columns', () => {
  const ctx = ctxFor('42');
  const noises = fuzzNoiseSource();
  const sample = (cx: number, cz: number) => buildColumnSample(ctx, cx, cz, newColumnSample());

  test('corners on a chunk border are computed identically by both neighbours', () => {
    const exprs: DensityExpr[] = [
      only(add(add(col('offset'), { op: 'mul', a: col('jag'), b: n2('fz2a') }), { op: 'neg', x: Y })),
      only(add({ op: 'mul', a: col('sigma'), b: { op: 'slide', x: n3('fz3b'), knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] } }, col('E'))),
    ];
    const next = testRng(303);
    while (exprs.length < 12) {
      const d = randomDensityExpr(next);
      const nodes = interpolatedNodes(d);
      if (nodes.length > 0) exprs.push({ root: nodes[0]!.x, defs: d.defs });
    }
    for (const [cx, cz] of [[-1, -1], [0, 0], [5, -7]] as const) {
      const a = sample(cx, cz), east = sample(cx + 1, cz), south = sample(cx, cz + 1);
      for (const d of exprs) {
        const r = createDensityReference(d, noises);
        const e = d.root;
        for (let k = 0; k <= 48; k += 3) {
          for (let t = 0; t <= 4; t++) {
            expect(Object.is(r.corner(a, e, 4, k, t), r.corner(east, e, 0, k, t))).toBe(true);
            expect(Object.is(r.corner(a, e, t, k, 4), r.corner(south, e, t, k, 0))).toBe(true);
          }
        }
      }
    }
  });

  test('a voxel on a corner of a cell equals that corner through interpolated', () => {
    const s = sample(3, -2);
    const next = testRng(304);
    let checked = 0;
    for (let n = 0; n < 40; n++) {
      const e = randomDensityExpr(next);
      const r = createDensityReference(e, noises);
      for (const node of interpolatedNodes(e)) {
        for (const [i, k, j] of [[0, 0, 0], [3, 47, 3], [1, 20, 2]] as const) {
          const v = r.voxel(s, 16 * 3 + 4 * i, -64 + 8 * k, -32 + 4 * j, node);
          expect(v === r.corner(s, node.x, i, k, j)).toBe(true); // == : lerp(a, b, 0) may turn −0 into +0
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

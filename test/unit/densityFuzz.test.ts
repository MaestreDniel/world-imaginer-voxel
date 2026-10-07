import { describe, expect, test } from 'vitest';
import { EXPR_OPS, exprChildren, exprHash, validateExpr, type DensityExpr, type Expr, type ExprOp } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { FUZZ_NOISE_SPECS, exprHeight, fuzzConstant, fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

/** Every node reachable from the root and the defs (each def walked once). */
function nodesOf(e: DensityExpr): Expr[] {
  const out: Expr[] = [];
  const walk = (n: Expr) => { out.push(n); for (const c of exprChildren(n)) walk(c); };
  walk(e.root);
  for (const d of Object.values(e.defs)) walk(d);
  return out;
}

const hashOf = (e: DensityExpr): string => [exprHash(e.root), ...Object.entries(e.defs).map(([k, d]) => `${k}:${exprHash(d)}`)].join('|');

describe('densityFuzz: random valid Expr trees (SP3b spec §10)', () => {
  const noises = fuzzNoiseSource();
  const trees = (seed: number, n: number): DensityExpr[] => {
    const next = testRng(seed);
    return Array.from({ length: n }, () => randomDensityExpr(next));
  };

  test('the test noise map: 2D and 3D noises with remap none, each sampled by its own dimension', () => {
    expect(FUZZ_NOISE_SPECS.map((n) => n.dims).sort()).toEqual([2, 2, 3, 3]);
    for (const { id, dims } of FUZZ_NOISE_SPECS) {
      const n = noises(id)!;
      expect(n).toMatchObject({ dims, remap: 'none' });
      const v = dims === 2 ? n.z2(13, -7) : n.z3(13, 70, -7);
      expect(Math.abs(v)).toBeLessThanOrEqual(n.clampSigma);
      expect(v).not.toBe(dims === 2 ? n.z2(17, -7) : n.z3(13, 78, -7));
    }
    expect(noises('jag')).toBeUndefined();
  });

  test('every tree validates, stays within the depth bound and is reproducible from its seed', () => {
    const a = trees(11, 400), b = trees(11, 400);
    for (let i = 0; i < a.length; i++) {
      expect(validateExpr(a[i], noises)).toEqual([]);
      expect(exprHeight(a[i]!.root, a[i]!.defs)).toBeLessThanOrEqual(6);
      expect(hashOf(a[i]!)).toBe(hashOf(b[i]!));
    }
    expect(new Set(a.map(hashOf)).size).toBeGreaterThan(390);
  });

  test('every op, refs inside and outside interpolated, ±0 and both rangeChoice branches occur', () => {
    const all = trees(12, 400);
    const ops = new Set<ExprOp>();
    for (const e of all) for (const n of nodesOf(e)) ops.add(n.op);
    expect([...ops].sort()).toEqual([...EXPR_OPS].sort());
    expect(all.filter((e) => interpolatedNodes(e).length > 0).length).toBeGreaterThan(80);
    const refInside = all.some((e) => interpolatedNodes(e).some((i) => JSON.stringify(i.x).includes('"ref"')));
    expect(refInside).toBe(true);
    const consts = all.flatMap(nodesOf).flatMap((n) => (n.op === 'const' ? [n.v] : []));
    expect(consts.some((v) => Object.is(v, -0))).toBe(true);
    expect(consts.some((v) => Object.is(v, 0))).toBe(true);
    expect(consts.some((v) => Math.abs(v) > 1e8)).toBe(true);
    expect(consts.some((v) => v !== 0 && Math.abs(v) < 1e-5)).toBe(true);
  });

  test('constants: 0, −0, small integers and log-uniform magnitudes in [1e-6, 1e9] with both signs', () => {
    const next = testRng(13);
    const vs = Array.from({ length: 20000 }, () => fuzzConstant(next));
    for (const v of vs) {
      expect(Number.isFinite(v)).toBe(true);
      if (v !== 0) expect(Math.abs(v)).toBeGreaterThanOrEqual(1e-6);
      expect(Math.abs(v)).toBeLessThanOrEqual(1e9);
    }
    const decades = new Set(vs.filter((v) => v !== 0 && !Number.isInteger(v)).map((v) => Math.floor(Math.log10(Math.abs(v)))));
    for (let d = -6; d <= 8; d++) expect(decades.has(d)).toBe(true);
    expect(vs.some((v) => v < -1)).toBe(true);
    expect(vs.some((v) => v > 1)).toBe(true);
  });

  test('the reference gives finite values on every tree, at voxels and at corners', () => {
    const s = buildColumnSample(ctxFor('42'), -4, 9, newColumnSample());
    const next = testRng(14);
    for (const e of trees(15, 150)) {
      const r = createDensityReference(e, noises);
      for (let n = 0; n < 4; n++) {
        const x = -64 + (next() % 16), y = -64 + (next() % 384), z = 144 + (next() % 16);
        expect(Number.isFinite(r.voxel(s, x, y, z))).toBe(true);
      }
      for (const node of interpolatedNodes(e)) expect(Number.isFinite(r.corner(s, node.x, next() % 5, next() % 49, next() % 5))).toBe(true);
    }
  });
});

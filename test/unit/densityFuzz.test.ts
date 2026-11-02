import { describe, expect, test } from 'vitest';
import { DEFAULT_DENSITY_TREE } from '../../src/core/params/defaultTrees';
import { DEFAULTS } from '../../src/core/params/defaults';
import { applyPatch } from '../../src/core/params/kit';
import { SCHEMA } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { compileDensity } from '../../src/gen/density/compile';
import { densityNoiseSource } from '../../src/gen/density/context';
import { EXPR_OPS, exprChildren, exprHash, validateExpr, type DensityExpr, type Expr, type ExprOp } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { resolveDensity } from '../../src/gen/density/source';
import { validateParamTrees } from '../../src/gen/trees';
import { FUZZ_NOISE_SPECS, FUZZ_SCALES, exprHeight, fuzzConstant, fuzzNoiseSource, randomDensityExpr, SCHEMA_DENSITY_NOISES } from '../harness/densityFuzz';
import { mutateTree } from '../harness/treeMutator';
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

describe('the fuzzers and noiseScaled (SP6a spec §1.5, §10.3)', () => {
  const noises = fuzzNoiseSource();

  test('randomDensityExpr draws noiseScaled inside and outside interpolated, s from FUZZ_SCALES ⊂ [1/16, 16]; compiled == reference on them', () => {
    for (const sc of FUZZ_SCALES) expect(sc >= 1 / 16 && sc <= 16).toBe(true);
    const ctx = ctxFor('42');
    const samples = [[0, 0], [-37, 12]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));
    const next = testRng(16);
    let trees = 0, inside = 0, outside = 0, voxels = 0, corners = 0;
    const scales = new Set<number>();
    while (trees < 120) {
      const e = randomDensityExpr(next);
      const scaled = new Set<Expr>();
      const walk = (n: Expr, inInterp: boolean): void => {
        if (n.op === 'noiseScaled') { scaled.add(n); scales.add(n.s); if (inInterp) inside++; else outside++; }
        if (n.op === 'ref') return;
        for (const c of exprChildren(n)) walk(c, inInterp || n.op === 'interpolated');
      };
      walk(e.root, false);
      for (const d of Object.values(e.defs)) walk(d, false);
      if (scaled.size === 0) continue;
      trees++;
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      for (const s of samples) {
        c.columnFn(s);
        c.positionFn(s);
        for (let m = 0; m < 16; m++) {
          const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
          const want = r.voxel(s, 16 * s.cx + lx, y, 16 * s.cz + lz);
          const got = c.voxelFn(lx, y, lz);
          if (!Object.is(got, want)) throw new Error(`voxel (${lx}, ${y}, ${lz}): compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
          voxels++;
        }
        for (const node of interpolatedNodes(e)) {
          const i = next() % 5, k = next() % 49, j = next() % 5;
          const want = r.corner(s, node.x, i, k, j);
          c.cornerFn(i, k, j);
          const got = c.cornerValues[c.interpolatedSlot(node) * 1225 + (k * 5 + j) * 5 + i]!;
          if (!Object.is(got, want)) throw new Error(`corner (${i}, ${k}, ${j}): compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
          corners++;
        }
      }
    }
    expect(inside).toBeGreaterThan(10);
    expect(outside).toBeGreaterThan(10);
    expect(scales.size).toBeGreaterThanOrEqual(6);
    expect(voxels).toBe(120 * 2 * 16);
    expect(corners).toBeGreaterThan(20);
    // Over the schema noises, a fuzz tree with noiseScaled is a valid density.defs value (both tiers).
    const n2 = testRng(17);
    let valid = 0;
    for (let i = 0; i < 160; i++) {
      const e = randomDensityExpr(n2, { noises: SCHEMA_DENSITY_NOISES, negativeZero: false });
      if (!JSON.stringify(e).includes('"noiseScaled"')) continue;
      const p = applyPatch(SCHEMA, DEFAULTS, { density: { defs: e as never } });
      expect(p.ok && validateParamTrees(p.value)).toEqual([]);
      valid++;
    }
    expect(valid).toBeGreaterThan(5);
  });

  test('treeMutator\'s scaleNoise turns a noise of the default tree into a noiseScaled; the edited params resolve and compiled == reference', () => {
    const next = testRng(18);
    const ctxOf = (p: typeof DEFAULTS) => createGenContext(seedFromInput('42'), p);
    let edited = 0;
    for (let i = 0; i < 400 && edited < 12; i++) {
      const m = mutateTree(next, DEFAULT_DENSITY_TREE, 'density', { cls: 'preserving', count: 1 });
      if (m.names[0] !== 'scaleNoise') continue;
      const text = JSON.stringify(m.value);
      expect(text).toContain('"op":"noiseScaled"');
      const r = applyPatch(SCHEMA, DEFAULTS, { density: { defs: m.value as never } });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(validateParamTrees(r.value)).toEqual([]);
      edited++;
      const ctx = ctxOf(r.value);
      const e = resolveDensity(r.value.density.defs, r.value);
      const dn = densityNoiseSource(ctx);
      const ref = createDensityReference(e, dn);
      const c = compileDensity(e, dn);
      const s = buildColumnSample(ctx, -37, 12, newColumnSample());
      c.columnFn(s);
      c.positionFn(s);
      for (let m2 = 0; m2 < 24; m2++) {
        const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
        const want = ref.voxel(s, -592 + lx, y, 192 + lz);
        const got = c.voxelFn(lx, y, lz);
        if (!Object.is(got, want)) throw new Error(`voxel (${lx}, ${y}, ${lz}): compiled ${got} ≠ reference ${want}\n${text}`);
      }
    }
    expect(edited).toBe(12);
  });
});

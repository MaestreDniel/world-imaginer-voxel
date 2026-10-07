import { describe, expect, test } from 'vitest';
import { buildColumnSample, latticeIndex, newColumnSample, readField, SAMPLE_FIELDS, type ColumnSample } from '../../src/gen/column/columnStage';
import { colValueIndex, compileDensity, cornerValueIndex, posValueIndex, type CompiledDensity } from '../../src/gen/density/compile';
import { exprChildren, exprHash, ExprValidationError, type DensityExpr, type DensityNoise, type DensityNoiseSource, type Expr, type InterpolatedExpr } from '../../src/gen/density/expr';
import { createDensityReference, interpolatedNodes } from '../../src/gen/density/reference';
import { fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: (typeof SAMPLE_FIELDS)[number]): Expr => ({ op: 'col', field });
const n2 = (id: string): Expr => ({ op: 'noise2', id });
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): InterpolatedExpr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const ref = (name: string): Expr => ({ op: 'ref', name });
const SLIDE: Expr = { op: 'slide', x: C(1), knots: [[-64, 0], [-40, 1], [240, 1], [320, 0]] };
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });

/** A fake density noise whose calls are logged as [x, z] / [x, y, z]. */
function fake(dims: 2 | 3, f: (x: number, y: number, z: number) => number, log: number[][] = []): DensityNoise {
  return {
    dims, remap: 'none', clampSigma: 4,
    z2: (x, z) => { log.push([x, z]); return f(x, 0, z); },
    z3: (x, y, z) => { log.push([x, y, z]); return f(x, y, z); },
  };
}
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

/** A hand-built ColumnSample at column (2, −3): E is i + 10·j on the lattice, offset i·j, every other field 0. */
function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++) {
      s.f.E[latticeIndex(i, j)] = i + 10 * j;
      s.f.offset[latticeIndex(i, j)] = i * j + 0.5;
    }
  }
  return s;
}
const X0 = 32;   // 16 · cx
const Z0 = -48;  // 16 · cz

function begin(c: CompiledDensity, s: ColumnSample): void {
  c.columnFn(s);
  c.positionFn(s);
}

/** The node of `c` whose representative source node is `e` (by identity) and placement `inside`. */
function nodeOf(c: CompiledDensity, e: Expr, inside: boolean) {
  const n = c.nodes.find((m) => m.expr === e && m.inside === inside);
  if (n === undefined) throw new Error(`no node for ${e.op} (inside ${inside})`);
  return n;
}

describe('compileDensity: stage placement (SP3b spec §2.1)', () => {
  test('y and slide are never COLUMN: VOXEL outside interpolated, CELL inside', () => {
    const slideIn: Expr = { op: 'slide', x: col('E'), knots: [[0, 0], [8, 1]] };
    const yIn: Expr = { op: 'y' };
    const e = only(add(add(Y, SLIDE), interp(add(slideIn, yIn))));
    const c = compileDensity(e, source({}));
    expect(nodeOf(c, Y, false).cls).toBe('voxel');
    expect(nodeOf(c, SLIDE, false).cls).toBe('voxel');
    expect(nodeOf(c, slideIn, true).cls).toBe('cell');
    expect(nodeOf(c, yIn, true).cls).toBe('cell');
    expect(nodeOf(c, (slideIn as { x: Expr }).x, true)).toMatchObject({ cls: 'column', colSlot: 0, posSlot: -1 });
    // A slide of a constant still reads y: VOXEL, evaluated per voxel.
    expect(nodeOf(c, (SLIDE as { x: Expr }).x, false)).toMatchObject({ cls: 'column', posSlot: -1, colSlot: -1 });
    expect(c.nodes.filter((n) => n.cls === 'column' && n.op === 'slide')).toEqual([]);
    expect(c.nodes.filter((n) => n.cls === 'column' && n.op === 'y')).toEqual([]);
  });

  test('a COLUMN sub-tree read by a VOXEL node goes through positionFn, at the 16 × 16 positions', () => {
    const log2: number[][] = [], log3: number[][] = [];
    const a = fake(2, (x, _y, z) => x - 0.25 * z, log2);
    const b = fake(3, (x, y, z) => x + y + z, log3);
    const amp = mul(col('E'), n2('a'));
    const c = compileDensity(only(add(amp, n3('b'))), source({ a, b }));
    expect(nodeOf(c, amp, false)).toMatchObject({ cls: 'column', posSlot: 0, colSlot: -1 });
    expect(c.columnSlotCount).toBe(0);
    expect(c.positionSlotCount).toBe(1);
    const s = handSample();
    c.columnFn(s);
    expect(log2).toEqual([]);
    c.positionFn(s);
    expect(log2.length).toBe(256);
    expect(new Set(log2.map(([x, z]) => `${x},${z}`)).size).toBe(256);
    for (const [x, z] of log2) {
      expect(x - X0).toBeGreaterThanOrEqual(0);
      expect(x - X0).toBeLessThan(16);
      expect(z - Z0).toBeGreaterThanOrEqual(0);
      expect(z - Z0).toBeLessThan(16);
    }
    // The stored value: bilinear E at the position times noise2 at the position's integer (x, z).
    for (const [lx, lz] of [[0, 0], [5, 9], [15, 15]] as const) {
      const want = readField(s, 'E', X0 + lx, Z0 + lz) * a.z2(X0 + lx, Z0 + lz);
      expect(c.posValues[posValueIndex(0, lx, lz)]).toBe(want);
    }
    log2.length = 0;
    log3.length = 0;
    expect(c.voxelFn(5, 70, 9)).toBe(c.posValues[posValueIndex(0, 5, 9)]! + (X0 + 5 + 70 + Z0 + 9));
    expect(log2).toEqual([]);
    expect(log3).toEqual([[X0 + 5, 70, Z0 + 9]]);
  });

  test('a COLUMN sub-tree inside interpolated goes through columnFn, at the 5 × 5 corner columns, from the lattice', () => {
    const log2: number[][] = [];
    const a = fake(2, (x, _y, z) => x * 0.5 + z, log2);
    const inner = add(col('offset'), n2('a'));
    const c = compileDensity(only(interp(add(inner, Y))), source({ a }));
    expect(nodeOf(c, inner, true)).toMatchObject({ cls: 'column', colSlot: 0, posSlot: -1 });
    expect(c.positionSlotCount).toBe(0);
    const s = handSample();
    c.columnFn(s);
    expect(log2.length).toBe(25);
    for (let j = 0; j <= 4; j++) {
      for (let i = 0; i <= 4; i++) {
        const x = X0 + 4 * i, z = Z0 + 4 * j;
        expect(c.colValues[colValueIndex(0, i, j)]).toBe(s.f.offset[latticeIndex(i, j)]! + (x * 0.5 + z));
      }
    }
    c.positionFn(s);
    expect(log2.length).toBe(25);
    c.cornerFn(1, 20, 3);
    expect(c.cornerValues[cornerValueIndex(0, 1, 20, 3)]).toBe(c.colValues[colValueIndex(0, 1, 3)]! + (-64 + 8 * 20));
    expect(log2.length).toBe(25);
    // A lattice value the bilinear readout cannot reach at x = 16 (v00 + (v10 − v00) · 1 ≠ v10) comes back exactly.
    const t = handSample();
    t.f.E[latticeIndex(3, 0)] = 1e17;
    t.f.E[latticeIndex(4, 0)] = 0.1;
    expect(readField(t, 'E', X0 + 16, Z0)).not.toBe(0.1);
    const e = compileDensity(only(interp(col('E'))), source({}));
    e.columnFn(t);
    expect(e.colValues[colValueIndex(0, 4, 0)]).toBe(0.1);
    e.cornerFn(4, 7, 0);
    expect(e.cornerValues[cornerValueIndex(0, 4, 7, 0)]).toBe(0.1);
  });

  test('cornerFn evaluates each corner once per column; voxelFn fills its cell first; columnFn starts a new column', () => {
    const log: number[][] = [];
    const q = fake(3, (x, y, z) => x * 0.25 + y * 0.5 + z, log);
    const c = compileDensity(only(interp(n3('q'))), source({ q }));
    expect(c.interpolatedSlotCount).toBe(1);
    const s = handSample();
    begin(c, s);
    c.cornerFn(2, 10, 4);
    c.cornerFn(2, 10, 4);
    expect(log).toEqual([[X0 + 8, -64 + 80, Z0 + 16]]);
    expect(c.cornerReady[2 + 5 * 4 + 25 * 10]).toBe(1);
    log.length = 0;
    // Every voxel of the column: each of the 5 × 49 × 5 corners exactly once.
    for (let y = -64; y <= 319; y++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) c.voxelFn(lx, y, lz);
    expect(log.length).toBe(1225 - 1);
    // The affine noise is reproduced exactly at a voxel.
    expect(c.voxelFn(5, 70, 9)).toBe((X0 + 5) * 0.25 + 70 * 0.5 + Z0 + 9);
    log.length = 0;
    const t = handSample();
    t.cx = 3;
    begin(c, t);
    expect(c.cornerReady.every((v) => v === 0)).toBe(true);
    expect(c.voxelFn(0, -64, 0)).toBe((X0 + 16) * 0.25 - 32 + Z0);
    expect(log.length).toBe(8);
  });

  test('cellCorners fills the 8 corners of one cell; positionFn needs the column of columnFn', () => {
    const c = compileDensity(only(add(interp(Y), col('E'))), source({}));
    const s = handSample();
    c.columnFn(s);
    expect(c.hasColumn(2, -3)).toBe(true);
    expect(c.hasPositions(2, -3)).toBe(false);
    c.cellCorners(1, 47, 3);
    const ready: number[] = [];
    c.cornerReady.forEach((v, k) => { if (v === 1) ready.push(k); });
    expect(ready).toEqual([1 + 15 + 25 * 47, 2 + 15 + 25 * 47, 1 + 20 + 25 * 47, 2 + 20 + 25 * 47,
      1 + 15 + 25 * 48, 2 + 15 + 25 * 48, 1 + 20 + 25 * 48, 2 + 20 + 25 * 48]);
    expect(c.cornerValues[cornerValueIndex(0, 2, 48, 4)]).toBe(320);
    const other = handSample();
    other.cz = 7;
    expect(() => c.positionFn(other)).toThrow(/columnFn/);
    c.positionFn(s);
    expect(c.hasPositions(2, -3)).toBe(true);
    expect(c.hasColumn(2, 7)).toBe(false);
  });

  test('rangeChoice evaluates x, then only the chosen branch', () => {
    const boom = fake(3, () => { throw new Error('evaluated'); });
    const c = compileDensity(only({ op: 'rangeChoice', x: Y, lo: 0, hi: 64, inside: C(1), outside: n3('boom') }), source({ boom }));
    begin(c, handSample());
    expect(c.voxelFn(0, 0, 0)).toBe(1);
    expect(c.voxelFn(0, 63, 0)).toBe(1);
    expect(() => c.voxelFn(0, 64, 0)).toThrow('evaluated');
  });

  test('the root may be COLUMN (read from positionFn) or a bare interpolated', () => {
    const s = handSample();
    const c = compileDensity(only(col('E')), source({}));
    begin(c, s);
    expect(c.voxelFn(6, 100, 10)).toBe(readField(s, 'E', X0 + 6, Z0 + 10));
    const k = compileDensity(only(C(-0)), source({}));
    begin(k, s);
    expect(Object.is(k.voxelFn(3, 3, 3), -0)).toBe(true);
    const i = compileDensity(only(interp(col('E'))), source({}));
    begin(i, s);
    expect(i.voxelFn(6, 100, 10)).toBe(1.5 + 25);
  });

  test('invalid expressions throw ExprValidationError with real node paths', () => {
    let err: unknown;
    try { compileDensity(only(add(Y, n3('missing')), { d: interp(interp(Y)) }), source({})); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ExprValidationError);
    expect((err as ExprValidationError).issues.map((i) => i.path)).toEqual(['root.b.id']);
    expect(() => compileDensity(only(ref('d'), { d: interp(interp(Y)) }), source({}))).toThrow(/defs\.d\.x: NESTED_INTERPOLATED/);
  });
});

describe('compileDensity: placement-keyed CSE', () => {
  test('equal sub-trees are shared within one placement and evaluated once per point', () => {
    const log: number[][] = [];
    const q = fake(3, (x, y, z) => x + y - z, log);
    // Two separate (structurally equal) copies of square(noise q) outside interpolated.
    const e = only(add({ op: 'square', x: n3('q') }, { op: 'square', x: n3('q') }));
    const c = compileDensity(e, source({ q }));
    expect(c.nodes.map((n) => n.op)).toEqual(['noise', 'square', 'add']);
    expect(c.nodes[2]!.kids).toEqual([1, 1]);
    begin(c, handSample());
    log.length = 0;
    const v = c.voxelFn(1, 2, 3);
    expect(log.length).toBe(1);
    expect(v).toBe(2 * (X0 + 1 + 2 - (Z0 + 3)) ** 2);
  });

  test('the same sub-tree inside and outside interpolated gives two nodes, one per placement', () => {
    const outside = add(n2('a'), Y);
    const inside = add(n2('a'), Y);
    const c = compileDensity(only(add(outside, interp(inside))), source({ a: fake(2, (x) => x) }));
    const o = nodeOf(c, outside, false), i = nodeOf(c, inside, true);
    expect(o).not.toBe(i);
    expect(o.cls).toBe('voxel');
    expect(i.cls).toBe('cell');
    expect(c.nodes.filter((n) => n.op === 'noise2').map((n) => [n.inside, n.colSlot, n.posSlot])).toEqual([[false, -1, 0], [true, 0, -1]]);
  });

  test('refs resolve to their def; an inline copy of a def is the same node; −0 ≠ +0; tap names count', () => {
    const d = mul(col('E'), C(2));
    const c = compileDensity(only(add(add(ref('d'), ref('d')), add(mul(col('E'), C(2)), interp(ref('d')))), { d }), source({}));
    const outer = c.nodes.filter((n) => n.op === 'mul' && !n.inside);
    expect(outer.length).toBe(1);
    expect(c.nodes.filter((n) => n.op === 'mul' && n.inside).length).toBe(1);
    expect(c.nodes.some((n) => (n.op as string) === 'ref')).toBe(false);
    const z = compileDensity(only(add(C(0), C(-0))), source({}));
    expect(z.nodes.filter((n) => n.op === 'const').length).toBe(2);
    const t = compileDensity(only(add({ op: 'tap', name: 'a', x: Y }, { op: 'tap', name: 'b', x: Y })), source({}));
    expect(t.nodes.filter((n) => n.op === 'tap').length).toBe(2);
    expect(t.nodes.filter((n) => n.op === 'y').length).toBe(1);
  });

  test('structurally equal interpolated nodes share one corner slot', () => {
    const a = interp(add(Y, col('E'))), b = interp(add(Y, col('E')));
    const c = compileDensity(only(mul(a, b)), source({}));
    expect(c.interpolatedSlotCount).toBe(1);
    expect(c.interpolatedSlot(a)).toBe(0);
    expect(c.interpolatedSlot(b)).toBe(0);
    expect(c.interpolatedSlot(interp(Y))).toBe(-1);
  });

  test('on random trees the nodes are exactly the distinct (structural hash, inside) keys after ref resolution', () => {
    const next = testRng(401);
    const noises = fuzzNoiseSource();
    for (let n = 0; n < 200; n++) {
      const e = randomDensityExpr(next);
      const keys = new Set<string>();
      const memo = new WeakMap<Expr, string>();
      const resolved = new Map<Expr, Expr>();
      const resolve = (x: Expr): Expr => {
        if (x.op === 'ref') return resolve(e.defs[x.name]!);
        const hit = resolved.get(x);
        if (hit !== undefined) return hit;
        const rec: Record<string, unknown> = { ...x };
        const keysOf = Object.keys(rec).filter((k) => typeof rec[k] === 'object' && rec[k] !== null && !Array.isArray(rec[k]));
        for (const k of keysOf) rec[k] = resolve(rec[k] as Expr);
        resolved.set(x, rec as unknown as Expr);
        return rec as unknown as Expr;
      };
      const walk = (x: Expr, inside: boolean) => {
        keys.add(`${exprHash(x, memo)}|${inside ? 1 : 0}`);
        for (const k of exprChildren(x)) walk(k, inside || x.op === 'interpolated');
      };
      walk(resolve(e.root), false);
      expect(compileDensity(e, noises).nodes.length).toBe(keys.size);
    }
  });
});

describe('compileDensity: compiled == reference, bit for bit (fuzz)', () => {
  const ctx = ctxFor('42');
  const noises = fuzzNoiseSource();
  const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));

  test('voxels, corners and taps on random trees', () => {
    const next = testRng(402);
    let voxels = 0, corners = 0, taps = 0, interpTrees = 0;
    for (let n = 0; n < 300; n++) {
      const e = randomDensityExpr(next);
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      const nodes = interpolatedNodes(e);
      if (nodes.length > 0) interpTrees++;
      const tapNames = new Set<string>();
      JSON.stringify(e, (k, v: unknown) => { if (k === 'name' && typeof v === 'string' && v.startsWith('t')) tapNames.add(v); return v; });
      // Two columns, then the first again: the scratch is reused across columns.
      for (const s of [samples[n % 4]!, samples[(n + 1) % 4]!, samples[n % 4]!]) {
        begin(c, s);
        for (let m = 0; m < 24; m++) {
          const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
          const want = r.voxel(s, 16 * s.cx + lx, y, 16 * s.cz + lz);
          const got = c.voxelFn(lx, y, lz);
          if (!Object.is(got, want)) throw new Error(`tree ${n}: voxel (${lx}, ${y}, ${lz}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
          voxels++;
        }
        for (const node of nodes) {
          const slot = c.interpolatedSlot(node);
          expect(slot).toBeGreaterThanOrEqual(0);
          for (let m = 0; m < 8; m++) {
            const i = next() % 5, k = next() % 49, j = next() % 5;
            c.cornerFn(i, k, j);
            const want = r.corner(s, node.x, i, k, j);
            const got = c.cornerValues[cornerValueIndex(slot, i, k, j)]!;
            if (!Object.is(got, want)) throw new Error(`tree ${n}: corner (${i}, ${k}, ${j}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
            corners++;
          }
        }
        for (const name of tapNames) {
          let reachable = true;
          try { r.tap(s, name, 16 * s.cx, 0, 16 * s.cz); } catch { reachable = false; }
          if (!reachable) { expect(() => c.tapFn(name, 0, 0, 0)).toThrow(/no tap/); continue; }
          for (let m = 0; m < 3; m++) {
            const lx = next() % 16, lz = next() % 16, y = -64 + (next() % 384);
            const want = r.tap(s, name, 16 * s.cx + lx, y, 16 * s.cz + lz);
            const got = c.tapFn(name, lx, y, lz);
            if (!Object.is(got, want)) throw new Error(`tree ${n}: tap ${name} at (${lx}, ${y}, ${lz}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
            taps++;
          }
        }
      }
    }
    expect(voxels).toBe(300 * 3 * 24);
    expect(interpTrees).toBeGreaterThan(60);
    expect(corners).toBeGreaterThan(2000);
    expect(taps).toBeGreaterThan(500);
  });

  test('every voxel of one cell layer per column, in scan order, on trees with interpolated', () => {
    const next = testRng(403);
    let trees = 0;
    while (trees < 12) {
      const e = randomDensityExpr(next);
      if (interpolatedNodes(e).length === 0) continue;
      trees++;
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      const s = samples[trees % 4]!;
      begin(c, s);
      const y0 = -64 + 8 * (next() % 48);
      for (let y = y0; y < y0 + 8; y++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const want = r.voxel(s, 16 * s.cx + lx, y, 16 * s.cz + lz);
            const got = c.voxelFn(lx, y, lz);
            if (!Object.is(got, want)) throw new Error(`voxel (${lx}, ${y}, ${lz}) compiled ${got} ≠ reference ${want}\n${JSON.stringify(e)}`);
          }
        }
      }
    }
  });
});

import { describe, expect, test } from 'vitest';
import { buildColumnSample, latticeIndex, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { createDensityBounds, fillDensityColumn, type DensityBounds } from '../../src/gen/density/bounds';
import { compileDensity, posValueIndex } from '../../src/gen/density/compile';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr } from '../../src/gen/density/expr';
import { cornerY, ivWiden } from '../../src/gen/density/nodes';
import { createDensityReference } from '../../src/gen/density/reference';
import { fuzzNoiseSource, randomDensityExpr, terrainStandInExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: 'offset' | 'E'): Expr => ({ op: 'col', field });
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): Expr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });

/** A constant-valued 3D noise with clampSigma 4. */
const flat3: DensityNoise = { dims: 3, remap: 'none', clampSigma: 4, z2: () => 0, z3: () => 1 };
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

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

const widened = (lo: number, hi: number): [number, number] => {
  const o = new Float64Array(2);
  ivWiden(lo, hi, o, 0);
  return [o[0]!, o[1]!];
};

function begin(b: DensityBounds, s: ColumnSample): void {
  b.compiled.columnFn(s);
  b.compiled.positionFn(s);
  b.beginColumn();
}

/** Column-wide voxel index, as the T stage's sections: ((y + 64)·16 + lz)·16 + lx. */
const vIdx = (lx: number, y: number, lz: number): number => (((y + 64) << 4) | lz) << 4 | lx;

describe('bounds: the root interval per cell (SP3b spec §1.2, §2.4)', () => {
  test('interpolated: its child over the cell corners (col from the 4 corner columns, y over [y0, y0 + 8]), widened', () => {
    // root = interpolated(offset − y) + 2·noise(b), noise b with clampSigma 4.
    const e = only(add(interp(add(col('offset'), neg(Y))), mul(n3('b'), C(2))));
    const b = createDensityBounds(compileDensity(e, source({ b: flat3 })), source({ b: flat3 }));
    begin(b, handSample());
    const out = new Float64Array(2);
    // Cell (1, 10, 2): corner columns i ∈ {1, 2}, j ∈ {2, 3} hold offsets 2.5, 4.5, 3.5, 6.5; corners y 16 and 24.
    b.cellInterval(1, 10, 2, out, 0);
    const [l, h] = widened(2.5 - 24, 6.5 - 16);
    expect([out[0], out[1]]).toEqual([l - 8, h + 8]);
    // After the cell's corners exist, the interpolated part is the hull of its 8 corner values, widened.
    b.compiled.cellCorners(1, 10, 2);
    b.cellIntervalCorners(1, 10, 2, out, 0);
    expect([out[0], out[1]]).toEqual([l - 8, h + 8]);
  });

  test('voxel level: y over [y0, y0 + 7]; a COLUMN value read per voxel is the hull of its 4 × 4 positions, widened', () => {
    const amp = mul(col('E'), C(0.5));
    const c = compileDensity(only(add(amp, Y)), source({}));
    const b = createDensityBounds(c, source({}));
    const s = handSample();
    begin(b, s);
    const out = new Float64Array(2);
    for (const [ci, ck, cj] of [[0, 0, 0], [3, 47, 3], [2, 20, 1]] as const) {
      let lo = Infinity, hi = -Infinity;
      for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
        for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
          const v = c.posValues[posValueIndex(0, lx, lz)]!;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      const [wl, wh] = widened(lo, hi);
      b.cellInterval(ci, ck, cj, out, 0);
      expect([out[0], out[1]]).toEqual([wl + cornerY(ck), wh + (cornerY(ck) + 7)]);
    }
  });

  test('rangeChoice takes one branch when x decides it, else the hull; nodeIntervals hold every node of the last call', () => {
    // rangeChoice(y, 0, 100, inside 1, outside −1) at voxel level.
    const e = only({ op: 'rangeChoice', x: Y, lo: 0, hi: 100, inside: C(1), outside: C(-1) });
    const b = createDensityBounds(compileDensity(e, source({})), source({}));
    begin(b, handSample());
    const out = new Float64Array(2);
    b.cellInterval(0, 10, 0, out, 0); // y 16 … 23: inside
    expect([out[0], out[1]]).toEqual([1, 1]);
    b.cellInterval(0, 7, 0, out, 0); // y −8 … −1: outside
    expect([out[0], out[1]]).toEqual([-1, -1]);
    b.cellInterval(0, 20, 0, out, 0); // y 96 … 103: both
    expect([out[0], out[1]]).toEqual([-1, 1]);
    const r = b.compiled.root;
    expect([b.nodeIntervals[2 * r], b.nodeIntervals[2 * r + 1]]).toEqual([-1, 1]);
  });
});

describe('fillDensityColumn: the early-out driver (SP3b spec §2.4, §4)', () => {
  test('solid below y 100: early-outs above and below, voxels only in the straddling layer, values where mask is set', () => {
    const e = only(interp(add(C(100), neg(Y))));
    const b = createDensityBounds(compileDensity(e, source({})), source({}));
    const solid = new Uint8Array(98304).fill(7);
    const values = new Float64Array(98304).fill(NaN);
    const mask = new Uint8Array(98304).fill(7);
    let polls = 0;
    expect(fillDensityColumn(b, handSample(), solid, values, mask, () => { polls++; return false; })).toBe(true);
    expect(polls).toBe(6);
    for (let y = -64; y < 320; y++) {
      for (const [lx, lz] of [[0, 0], [5, 9], [15, 15]] as const) {
        const i = vIdx(lx, y, lz);
        expect(solid[i]).toBe(y < 100 ? 1 : 0);
        // Only cell layer 20 (y 96 … 103) straddles 0: its corners are 4 and −4.
        expect(mask[i]).toBe(y >= 96 && y < 104 ? 1 : 0);
        if (mask[i] === 1) expect(values[i]).toBe(100 - y);
      }
    }
  });

  test('stop() is polled before every 8 cell layers; true returns false at once', () => {
    const e = only(interp(add(C(100), neg(Y))));
    const b = createDensityBounds(compileDensity(e, source({})), source({}));
    const solid = new Uint8Array(98304).fill(7);
    let polls = 0;
    expect(fillDensityColumn(b, handSample(), solid, null, null, () => ++polls === 3)).toBe(false);
    expect(polls).toBe(3);
    // Layers 0 … 15 (y −64 … 63) were filled; nothing from layer 16 on.
    expect(solid.subarray(0, 16 * 8 * 256).every((v) => v === 1)).toBe(true);
    expect(solid.subarray(16 * 8 * 256).every((v) => v === 7)).toBe(true);
  });
});

describe('bounds and early-outs: fuzz (SP3b spec §1.2, §10)', () => {
  const ctx = ctxFor('42');
  const noises = fuzzNoiseSource();
  const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));

  test('no evaluated value leaves its interval, at every node, before and after the corners', () => {
    const next = testRng(501);
    let checks = 0, big = 0, tiny = 0;
    const out = new Float64Array(2);
    for (let n = 0; n < 300; n++) {
      const e = randomDensityExpr(next);
      JSON.stringify(e, (k, v: unknown) => {
        if (k === 'v' && typeof v === 'number') { if (Math.abs(v) >= 1e6) big++; if (v !== 0 && Math.abs(v) <= 1e-3) tiny++; }
        return v;
      });
      const r = createDensityReference(e, noises);
      const c = compileDensity(e, noises);
      const b = createDensityBounds(c, noises);
      const s = samples[n % 4]!;
      begin(b, s);
      const x0 = 16 * s.cx, z0 = 16 * s.cz;
      for (let m = 0; m < 3; m++) {
        const ci = next() % 4, ck = next() % 48, cj = next() % 4;
        const y0 = cornerY(ck);
        const vox = Array.from({ length: 6 }, () => [4 * ci + (next() % 4), y0 + (next() % 8), 4 * cj + (next() % 4)] as const);
        vox.push([4 * ci, y0, 4 * cj], [4 * ci + 3, y0 + 7, 4 * cj + 3]);
        const check = (pass: string): void => {
          const iv = b.nodeIntervals;
          for (let id = 0; id < c.nodes.length; id++) {
            const node = c.nodes[id]!;
            const lo = iv[2 * id]!, hi = iv[2 * id + 1]!;
            if (Number.isNaN(lo)) {
              // Only COLUMN nodes no non-COLUMN node reads go without an interval.
              expect(node.cls === 'column' && node.colSlot < 0 && node.posSlot < 0).toBe(true);
              continue;
            }
            const inCheck = (v: number, where: string): void => {
              if (!(lo <= v && v <= hi)) {
                throw new Error(`tree ${n} ${pass}: node ${id} (${node.op}, inside ${node.inside}) at ${where} = ${v} outside [${lo}, ${hi}]\n${JSON.stringify(e)}`);
              }
              checks++;
            };
            if (node.inside) {
              for (let q = 0; q < 8; q++) {
                const i = ci + (q & 1), j = cj + ((q >> 1) & 1), k = ck + (q >> 2);
                inCheck(r.corner(s, node.expr, i, k, j), `corner (${i}, ${k}, ${j})`);
              }
            } else {
              for (const [lx, y, lz] of vox) inCheck(r.voxel(s, x0 + lx, y, z0 + lz, node.expr), `voxel (${lx}, ${y}, ${lz})`);
            }
          }
        };
        b.cellInterval(ci, ck, cj, out, 0);
        expect([out[0], out[1]]).toEqual([b.nodeIntervals[2 * c.root], b.nodeIntervals[2 * c.root + 1]]);
        check('cellInterval');
        c.cellCorners(ci, ck, cj);
        b.cellIntervalCorners(ci, ck, cj, out, 0);
        check('cellIntervalCorners');
        // The refined interval holds the compiled value of every voxel of the cell.
        for (let y = y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              const v = c.voxelFn(lx, y, lz);
              if (!(out[0]! <= v && v <= out[1]!)) throw new Error(`tree ${n}: voxel (${lx}, ${y}, ${lz}) = ${v} outside [${out[0]}, ${out[1]}]`);
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(20000);
    expect(big).toBeGreaterThan(30);
    expect(tiny).toBeGreaterThan(30);
  });

  /** Runs the driver and checks every voxel against a full evaluation on an independent compile; returns early-out cells. */
  function driverEqualsFull(e: DensityExpr, s: ColumnSample, what: string): { air: number; solid: number; voxel: number } {
    const b = createDensityBounds(compileDensity(e, noises), noises);
    const full = compileDensity(e, noises);
    full.columnFn(s);
    full.positionFn(s);
    const solid = new Uint8Array(98304), values = new Float64Array(98304), mask = new Uint8Array(98304);
    expect(fillDensityColumn(b, s, solid, values, mask, () => false)).toBe(true);
    const cells = { air: 0, solid: 0, voxel: 0 };
    for (let ck = 0; ck < 48; ck++) {
      for (let cj = 0; cj < 4; cj++) {
        for (let ci = 0; ci < 4; ci++) {
          let masked = 0, solids = 0;
          for (let y = cornerY(ck); y < cornerY(ck) + 8; y++) {
            for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
              for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
                const i = vIdx(lx, y, lz);
                const v = full.voxelFn(lx, y, lz);
                if (solid[i] !== (v > 0 ? 1 : 0)) throw new Error(`${what}: voxel (${lx}, ${y}, ${lz}) solid ${solid[i]} but full value ${v}\n${JSON.stringify(e)}`);
                if (mask[i] === 1 && !Object.is(values[i], v)) throw new Error(`${what}: voxel (${lx}, ${y}, ${lz}) value ${values[i]} ≠ ${v}`);
                masked += mask[i]!;
                solids += solid[i]!;
              }
            }
          }
          // A cell is evaluated whole or not at all.
          expect(masked === 0 || masked === 128).toBe(true);
          if (masked === 128) cells.voxel++;
          else if (solids === 128) cells.solid++;
          else { expect(solids).toBe(0); cells.air++; }
        }
      }
    }
    return cells;
  }

  test('the driver\'s solidity equals full evaluation at every voxel of random trees', () => {
    const next = testRng(502);
    const total = { air: 0, solid: 0, voxel: 0 };
    let n = 0, withInterp = 0;
    while (n < 80) {
      const e = randomDensityExpr(next);
      const hasInterp = JSON.stringify(e).includes('"interpolated"');
      // Half the trees have an interpolated node (the early-out with corners).
      if (!hasInterp && n - withInterp >= 40) continue;
      if (hasInterp) withInterp++;
      const cells = driverEqualsFull(e, samples[n % 4]!, `tree ${n}`);
      total.air += cells.air;
      total.solid += cells.solid;
      total.voxel += cells.voxel;
      n++;
    }
    expect(withInterp).toBeGreaterThanOrEqual(40);
    // Both early-outs and the voxel path are exercised.
    expect(total.air).toBeGreaterThan(1000);
    expect(total.solid).toBeGreaterThan(1000);
    expect(total.voxel).toBeGreaterThan(1000);
  });

  test('a terrain-shaped stand-in: driver == full evaluation, and most cells early-out', () => {
    const e = terrainStandInExpr();
    const total = { air: 0, solid: 0, voxel: 0 };
    for (const [m, s] of samples.entries()) {
      const cells = driverEqualsFull(e, s, `stand-in column ${m}`);
      total.air += cells.air;
      total.solid += cells.solid;
      total.voxel += cells.voxel;
    }
    expect(total.air).toBeGreaterThan(0);
    expect(total.solid).toBeGreaterThan(0);
    expect(total.voxel).toBeGreaterThan(0);
    expect(total.voxel / (4 * 768)).toBeLessThan(0.2);
  });
});

/**
 * SP6a ruling R13 (Task 15e): output-keeping speedups of T. Each keeps every stored block and every cave tag bit for
 * bit; each is checked against the fill without it over 64 columns (48 default, 8 amplified, 8 floating-islands:
 * `test/harness/densityBitExact.ts`) and, where it applies to any tree, over random trees.
 */
import { describe, expect, test } from 'vitest';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createDensityBounds, fillDensityColumn } from '../../src/gen/density/bounds';
import { compileDensity, cornerValueIndex, type CompileOptions } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import type { DensityNoise, DensityNoiseSource, Expr } from '../../src/gen/density/expr';
import { trilerp } from '../../src/gen/density/nodes';
import { checkBitExact } from '../harness/densityBitExact';
import { fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const NEVER = (): boolean => false;

describe('the air witness: a cell decided air by the pre-cave term alone (SP6a R13)', () => {
  test('the default tree\'s witness is the precave tap; a sky cell runs only its sub-program', () => {
    const ctx = ctxFor('42');
    const dc = createDensityContext(ctx);
    const b = dc.bounds;
    const w = b.airWitness;
    expect(w).toBeGreaterThanOrEqual(0);
    const n = dc.compiled.nodes[w]!;
    expect([n.op, (n.expr as { name?: string }).name]).toEqual(['tap', 'precave']);
    const off = createDensityBounds(dc.compiled, dc.noises, true, false);
    expect(off.airWitness).toBe(-1);
  });

  test('random trees: the fill with the witness equals the fill without it', () => {
    const noises = fuzzNoiseSource();
    const ctx = ctxFor('42');
    const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));
    const next = testRng(1513);
    const solid = [new Uint8Array(98304), new Uint8Array(98304)];
    const values = [new Float64Array(98304), new Float64Array(98304)];
    const mask = [new Uint8Array(98304), new Uint8Array(98304)];
    const cells = [new Uint8Array(768), new Uint8Array(768)];
    let decided = 0, trees = 0;
    for (let n = 0; n < 200 && trees < 40; n++) {
      const e = randomDensityExpr(next);
      const on = createDensityBounds(compileDensity(e, noises), noises);
      if (on.airWitness < 0) continue;
      trees++;
      const off = createDensityBounds(compileDensity(e, noises), noises, true, false);
      const s = samples[n % 4]!;
      fillDensityColumn(on, s, solid[0]!, values[0]!, mask[0]!, NEVER, cells[0]!);
      fillDensityColumn(off, s, solid[1]!, values[1]!, mask[1]!, NEVER, cells[1]!);
      for (let i = 0; i < 98304; i++) {
        if (solid[0]![i] !== solid[1]![i]) throw new Error(`tree ${n} voxel ${i}: solid differs\n${JSON.stringify(e)}`);
        if (mask[0]![i] !== 0 && mask[1]![i] !== 0 && !Object.is(values[0]![i], values[1]![i])) {
          throw new Error(`tree ${n} voxel ${i}: ${values[0]![i]} with the witness, ${values[1]![i]} without\n${JSON.stringify(e)}`);
        }
      }
      decided += on.airWitnessCount[0]!;
      expect(off.airWitnessCount[0]).toBe(0);
    }
    console.log(`air witness over ${trees} random trees with one: ${decided} cells decided by the witness alone`);
    expect(trees).toBeGreaterThan(10);
  }, 120_000);

  test('with and without the witness, the solidity, the cells, every value and every tag of 64 columns are equal', () => {
    let decided = 0;
    const ons: ReturnType<typeof createDensityBounds>[] = [];
    const stats = checkBitExact((ctx) => {
      const on = createDensityContext(ctx).bounds;
      const off = createDensityContext(ctx);
      ons.push(on);
      return { on, off: createDensityBounds(off.compiled, off.noises, true, false) };
    }, true);
    for (const b of ons) decided += b.airWitnessCount[0]!;
    console.log(`air witness over ${stats.columns} columns: ${decided} cells decided by the witness alone; ${stats.voxels} voxels compared, ${stats.tagged} tagged`);
    expect(stats.columns).toBe(64);
    expect(decided).toBeGreaterThan(64 * 100);
    expect(stats.voxels).toBeGreaterThan(100000);
    expect(stats.tagged).toBeGreaterThan(0);
  }, 300_000);
});

/** The 64-column check of one compile option: the default compile against one with `off` (the rest on). */
function checkOption(off: CompileOptions): ReturnType<typeof checkBitExact> {
  return checkBitExact((ctx) => {
    const dc = createDensityContext(ctx);
    return { on: dc.bounds, off: createDensityBounds(compileDensity(dc.expr, dc.noises, off), dc.noises) };
  }, true);
}

/** Random trees: the fill with every option on against the fill with `off`; returns the voxels compared. */
function randomTreesEqual(off: CompileOptions, seed: number, trees: number): number {
  const noises = fuzzNoiseSource();
  const ctx = ctxFor('42');
  const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));
  const next = testRng(seed);
  const solid = [new Uint8Array(98304), new Uint8Array(98304)];
  const values = [new Float64Array(98304), new Float64Array(98304)];
  const mask = [new Uint8Array(98304), new Uint8Array(98304)];
  let voxels = 0;
  for (let n = 0; n < trees; n++) {
    const e = randomDensityExpr(next);
    const on = createDensityBounds(compileDensity(e, noises), noises);
    const offB = createDensityBounds(compileDensity(e, noises, off), noises);
    const s = samples[n % 4]!;
    fillDensityColumn(on, s, solid[0]!, values[0]!, mask[0]!, NEVER);
    fillDensityColumn(offB, s, solid[1]!, values[1]!, mask[1]!, NEVER);
    for (let i = 0; i < 98304; i++) {
      if (solid[0]![i] !== solid[1]![i] || mask[0]![i] !== mask[1]![i]) throw new Error(`tree ${n} voxel ${i}: solid or mask differs\n${JSON.stringify(e)}`);
      if (mask[0]![i] === 0) continue;
      voxels++;
      if (!Object.is(values[0]![i], values[1]![i])) throw new Error(`tree ${n} voxel ${i}: ${values[0]![i]} on, ${values[1]![i]} off\n${JSON.stringify(e)}`);
    }
  }
  return voxels;
}

const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

describe('the plane cache: a trilerp\'s z-lerps kept per cell visit (SP6a R13)', () => {
  test('the options: planes on by default, off when asked', () => {
    const noises = fuzzNoiseSource();
    const e = { root: { op: 'interpolated', x: { op: 'y' } }, defs: {} } as const;
    expect(compileDensity(e, noises).options.planes).toBe(true);
    expect(compileDensity(e, noises, { planes: false }).options.planes).toBe(false);
  });

  test('every voxel of a column, its cells entered again and again, is trilerp of its cell\'s corner values bit for bit', () => {
    const wave: DensityNoise = { dims: 3, remap: 'none', clampSigma: 4, z2: () => 0, z3: (x, y, z) => 3.7 * Math.sin(0.31 * x - 0.17 * y + 0.23 * z) + 1e-3 * y };
    const ns = source({ w: wave });
    const n3: Expr = { op: 'noise', id: 'w' };
    const a: Expr = { op: 'interpolated', x: n3 };
    const b: Expr = { op: 'interpolated', x: { op: 'mul', a: n3, b: { op: 'y' } } };
    const c = compileDensity({ root: { op: 'add', a, b: { op: 'mul', a: b, b: { op: 'const', v: 1e-3 } } }, defs: {} }, ns);
    const slotA = c.nodes.find((n) => n.expr === a)!.interpSlot, slotB = c.nodes.find((n) => n.expr === b)!.interpSlot;
    const s = buildColumnSample(ctxFor('42'), 3, -2, newColumnSample());
    c.columnFn(s);
    c.positionFn(s);
    const tri = (slot: number, lx: number, y: number, lz: number): number => {
      const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
      const v = (i: number, k: number, j: number): number => c.cornerValues[cornerValueIndex(slot, i, k, j)]!;
      return trilerp(v(ci, ck, cj), v(ci + 1, ck, cj), v(ci, ck, cj + 1), v(ci + 1, ck, cj + 1),
        v(ci, ck + 1, cj), v(ci + 1, ck + 1, cj), v(ci, ck + 1, cj + 1), v(ci + 1, ck + 1, cj + 1),
        (lx - 4 * ci) / 4, (y + 64 - 8 * ck) / 8, (lz - 4 * cj) / 4);
    };
    let n = 0;
    // y outermost, then x, then z: each voxel of a row leaves its cell for the next one, so cells are entered again.
    for (let y = -64; y < 320; y += 3) {
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const v = c.voxelFn(lx, y, lz);
          const want = tri(slotA, lx, y, lz) + tri(slotB, lx, y, lz) * 1e-3;
          if (!Object.is(v, want)) throw new Error(`voxel (${lx}, ${y}, ${lz}): ${v}, trilerp ${want}`);
          n++;
        }
      }
    }
    expect(n).toBe(128 * 256);
  });

  test('random trees: the fill with the plane cache equals the fill without it', () => {
    expect(randomTreesEqual({ planes: false }, 1521, 40)).toBeGreaterThan(100000);
  }, 120_000);

  test('with and without the plane cache, the solidity, the cells, every value and every tag of 64 columns are equal', () => {
    const stats = checkOption({ planes: false });
    expect(stats.columns).toBe(64);
    expect(stats.voxels).toBeGreaterThan(100000);
    expect(stats.tagged).toBeGreaterThan(0);
  }, 300_000);
});

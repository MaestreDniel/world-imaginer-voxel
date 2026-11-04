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
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { bitExactSets, checkBitExact } from '../harness/densityBitExact';
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

describe('the y cache: a node of y alone kept per y (SP6a R13)', () => {
  test('the default tree\'s y nodes: the caps, at corners and at voxels; none with yCache off', () => {
    const dc = createDensityContext(ctxFor('42'));
    const c = dc.compiled;
    expect(c.yNodes.filter((id) => c.nodes[id]!.inside).length).toBeGreaterThan(4);
    expect(c.yNodes.filter((id) => !c.nodes[id]!.inside).length).toBeGreaterThan(0);
    for (const id of c.yNodes) {
      const n = c.nodes[id]!;
      expect(['y', 'const', 'tap', 'interpolated', 'noise', 'noiseScaled', 'noise2', 'col']).not.toContain(n.op);
    }
    expect(compileDensity(dc.expr, dc.noises, { yCache: false }).yNodes).toEqual([]);
  });

  test('a y node inside a min chain keeps its full value: a cell\'s skip never reaches another cell through the cache', () => {
    // root = min(min(2, y − 3), N), N = interpolated(noise) 0.5 below x 8 and 9 from it (column (0, 0)). In cell ci 0
    // the chain skips the constant 2 (above N's 0.5), so min(2, y − 3) read there with its skip would be y − 3 (3 at
    // y 6); in cell ci 2 (N 9) nothing is skipped and the root is min(2, y − 3) = 2 at y 6.
    const step: DensityNoise = { dims: 3, remap: 'none', clampSigma: 10, z2: () => 0, z3: (x) => (x < 8 ? 0.5 : 9) };
    const ns = source({ s: step });
    const Y: Expr = { op: 'y' };
    const inner: Expr = { op: 'min', a: { op: 'const', v: 2 }, b: { op: 'add', a: Y, b: { op: 'const', v: -3 } } };
    const e = { root: { op: 'min', a: inner, b: { op: 'interpolated', x: { op: 'noise', id: 's' } } }, defs: {} } as const;
    const on = createDensityBounds(compileDensity(e, ns), ns);
    const off = createDensityBounds(compileDensity(e, ns, { yCache: false }), ns);
    expect(on.compiled.yNodes).toHaveLength(1);
    expect(on.compiled.minChains).toHaveLength(1);
    const s = buildColumnSample(ctxFor('42'), 0, 0, newColumnSample());
    const solid = [new Uint8Array(98304), new Uint8Array(98304)];
    const values = [new Float64Array(98304), new Float64Array(98304)];
    const mask = [new Uint8Array(98304), new Uint8Array(98304)];
    fillDensityColumn(on, s, solid[0]!, values[0]!, mask[0]!, NEVER);
    fillDensityColumn(off, s, solid[1]!, values[1]!, mask[1]!, NEVER);
    expect(on.minSkipCounts[1]).toBeGreaterThan(0);
    let compared = 0;
    for (let i = 0; i < 98304; i++) {
      expect(mask[0]![i]).toBe(mask[1]![i]);
      if (mask[0]![i] === 0) continue;
      compared++;
      if (!Object.is(values[0]![i], values[1]![i])) throw new Error(`voxel ${i}: ${values[0]![i]} with the y cache, ${values[1]![i]} without`);
    }
    // y 6 of cell ci 2 (x 8), the voxel the guard is for: the root is 2 there.
    expect(values[0]![((6 + 64) * 16 + 0) * 16 + 8]).toBe(2);
    expect(compared).toBeGreaterThan(0);
  });

  test('random trees: the fill with the y cache equals the fill without it', () => {
    expect(randomTreesEqual({ yCache: false }, 1523, 40)).toBeGreaterThan(100000);
  }, 120_000);

  test('with and without the y cache, the solidity, the cells, every value and every tag of 64 columns are equal', () => {
    const stats = checkOption({ yCache: false });
    expect(stats.columns).toBe(64);
    expect(stats.voxels).toBeGreaterThan(100000);
    expect(stats.tagged).toBeGreaterThan(0);
  }, 300_000);
});

describe('the air witnesses through a max of two terms (SP6a R13)', () => {
  test('floating_islands\' witnesses are the precave and islands taps; the default tree\'s the precave tap alone', () => {
    const names = (params: Parameters<typeof createGenContext>[1]): string[] => {
      const dc = createDensityContext(createGenContext(seedFromInput('42'), params));
      return dc.bounds.airWitnesses.map((id) => `${dc.compiled.nodes[id]!.op} ${(dc.compiled.nodes[id]!.expr as { name?: string }).name}`);
    };
    expect(names(resolveProfile('floating_islands'))).toEqual(['tap precave', 'tap islands']);
    expect(names(resolveProfile('amplified'))).toEqual(['tap precave']);
    expect(names(ctxFor('42').params)).toEqual(['tap precave']);
  });

  test('a max of two terms is decided air only where both are below 0', () => {
    const noises = fuzzNoiseSource();
    const Y: Expr = { op: 'y' };
    // root = max(64 − y, y − 256): air from y 64 to 256, solid elsewhere; the witnesses are both terms.
    const a: Expr = { op: 'add', a: { op: 'const', v: 64 }, b: { op: 'neg', x: Y } };
    const b: Expr = { op: 'add', a: Y, b: { op: 'const', v: -256 } };
    const bounds = createDensityBounds(compileDensity({ root: { op: 'max', a, b }, defs: {} }, noises), noises);
    expect(bounds.airWitnesses).toHaveLength(2);
    const s = buildColumnSample(ctxFor('42'), 0, 0, newColumnSample());
    const solid = new Uint8Array(98304);
    fillDensityColumn(bounds, s, solid, null, null, NEVER);
    for (let y = -64; y < 320; y++) expect(solid[(y + 64) * 256]).toBe(y < 64 || y > 256 ? 1 : 0);
    // Only the cells wholly inside 65 … 255 are decided by the witnesses: 23 layers of 16.
    expect(bounds.airWitnessCount[0]).toBe(16 * 23);
  });

  test('the 64 columns\' islands columns: cells decided by both witnesses, the same fill as without them', () => {
    const set = bitExactSets().find((x) => x.name === 'floating_islands')!;
    const ctx = createGenContext(seedFromInput('42'), set.params);
    const on = createDensityContext(ctx).bounds;
    const offDc = createDensityContext(ctx);
    const off = createDensityBounds(offDc.compiled, offDc.noises, true, false);
    const s = newColumnSample();
    const solid = [new Uint8Array(98304), new Uint8Array(98304)], cells = [new Uint8Array(768), new Uint8Array(768)];
    for (const [cx, cz] of set.columns) {
      buildColumnSample(ctx, cx, cz, s);
      fillDensityColumn(on, s, solid[0]!, null, null, NEVER, cells[0]!);
      fillDensityColumn(off, s, solid[1]!, null, null, NEVER, cells[1]!);
      for (let i = 0; i < 98304; i++) if (solid[0]![i] !== solid[1]![i]) throw new Error(`(${cx}, ${cz}) voxel ${i}: solid differs`);
    }
    expect(on.airWitnessCount[0]).toBeGreaterThan(8 * 100);
  }, 120_000);
});

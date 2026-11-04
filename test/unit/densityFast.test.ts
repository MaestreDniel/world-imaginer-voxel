/**
 * SP6a ruling R13 (Task 15e): output-keeping speedups of T. Each keeps every stored block and every cave tag bit for
 * bit; each is checked against the fill without it over 64 columns (48 default, 8 amplified, 8 floating-islands:
 * `test/harness/densityBitExact.ts`) and, where it applies to any tree, over random trees.
 */
import { describe, expect, test } from 'vitest';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createDensityBounds, fillDensityColumn } from '../../src/gen/density/bounds';
import { compileDensity } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
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

/**
 * SP6a Task 15a (spec §1.6 lever (4), D25): per cell, from the corner hulls, an operand of a `min` chain whose interval's
 * low end exceeds the high end of another operand's cannot be the minimum and is not evaluated at the cell's voxels
 * (the families E, C, S3, S2 of `min(E, C, S3, S2)`; the noodle against `min(T + detailG, caves)`). The output is kept
 * bit for bit: a `min` returns the leftmost operand at the minimum, which a skipped operand never is.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { seedFromInput } from '../../src/core/seed';
import { caveReadersOf, tagColumn } from '../../src/gen/caves/tags';
import { buildColumnSample, latticeIndex, newColumnSample, type ColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext } from '../../src/gen/context';
import { createDensityBounds, fillDensityColumn } from '../../src/gen/density/bounds';
import { compileDensity, type CompiledDensity } from '../../src/gen/density/compile';
import { createDensityContext } from '../../src/gen/density/context';
import type { DensityExpr, DensityNoise, DensityNoiseSource, Expr } from '../../src/gen/density/expr';
import { fuzzNoiseSource, randomDensityExpr } from '../harness/densityFuzz';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

const C = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const n3 = (id: string): Expr => ({ op: 'noise', id });
const interp = (x: Expr): Expr => ({ op: 'interpolated', x });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const min = (a: Expr, b: Expr): Expr => ({ op: 'min', a, b });
const neg = (x: Expr): Expr => ({ op: 'neg', x });
const only = (root: Expr, defs: Record<string, Expr> = {}): DensityExpr => ({ root, defs });
const NEVER = (): boolean => false;

/** A 3D noise of clampSigma 4 whose value varies with the position and whose calls are counted. */
function counted(): { noise: DensityNoise; calls: () => number } {
  let n = 0;
  return {
    noise: { dims: 3, remap: 'none', clampSigma: 4, z2: () => 0, z3: (x, y, z) => { n++; return 3.5 * Math.sin(0.37 * x + 0.11 * y - 0.23 * z); } },
    calls: () => n,
  };
}
const source = (m: Record<string, DensityNoise>): DensityNoiseSource => (id) => (Object.hasOwn(m, id) ? m[id] : undefined);

function handSample(): ColumnSample {
  const s = newColumnSample();
  s.cx = 2;
  s.cz = -3;
  for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) s.f.offset[latticeIndex(i, j)] = i * j + 0.5;
  return s;
}

/** The first index where two arrays differ, or −1. */
function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** The node index of the first node reachable from the root whose source expression is `e` (by identity). */
function nodeOf(c: CompiledDensity, e: Expr): number {
  const id = c.nodes.findIndex((n) => n.expr === e);
  if (id < 0) throw new Error('no node for that expression');
  return id;
}

describe('min chains (SP6a §1.6 lever (4))', () => {
  test('a left-nested min is one chain: its mins (children first) and its operands; a shared or tapped min starts a chain of its own', () => {
    const a = add(n3('a'), C(1)), b = add(n3('b'), C(2)), cc = add(n3('a'), C(3));
    const inner = min(a, b), outer = min(inner, cc);
    const noises = source({ a: counted().noise, b: counted().noise });
    const c = compileDensity(only(outer), noises);
    expect(c.minChains.map((ch) => ({ mins: [...ch.mins], operands: [...ch.operands] })))
      .toEqual([{ mins: [nodeOf(c, inner), nodeOf(c, outer)], operands: [nodeOf(c, a), nodeOf(c, b), nodeOf(c, cc)] }]);
    expect(c.minSlotCount).toBe(2);
    expect(c.nodes.filter((n) => n.minSlot >= 0).length).toBe(2);
    // The inner min read twice (CSE): its value is needed apart from the chain, so it is an operand and a chain.
    const shared = min(a, b);
    const d = compileDensity(only(add(min(shared, cc), shared)), noises);
    expect(d.minChains.map((ch) => ch.operands.length).sort()).toEqual([2, 2]);
    // A tapped min likewise (a tap reader reads it).
    const e = compileDensity(only(min({ op: 'tap', name: 't', x: min(a, b) }, cc)), noises);
    expect(e.minChains.map((ch) => ch.operands.length).sort()).toEqual([2, 2]);
    // A min inside interpolated (evaluated at corners) or of COLUMN operands only is no chain.
    expect(compileDensity(only(interp(min(add(Y, C(1)), Y))), noises).minChains).toEqual([]);
    expect(compileDensity(only(add(min(C(1), { op: 'col', field: 'offset' }), Y)), noises).minChains).toEqual([]);
  });

  test('an operand that cannot be the minimum in a cell is not evaluated at its voxels; every voxel value is kept', () => {
    // root = min(min(big, interpolated(offset − y)), small): big = noise + 100 ∈ [96, 104] (widened), small ∈ [−4, 4].
    const big = counted(), small = counted();
    const e = only(min(min(add(n3('big'), C(100)), interp(add({ op: 'col', field: 'offset' }, neg(Y)))), n3('small')));
    const noises = source({ big: big.noise, small: small.noise });
    const on = createDensityBounds(compileDensity(e, noises), noises);
    const off = createDensityBounds(compileDensity(e, noises), noises, false);
    expect([on.minSkip, off.minSkip]).toEqual([true, false]);
    const s = handSample();
    const solidOn = new Uint8Array(98304), solidOff = new Uint8Array(98304);
    const valuesOn = new Float64Array(98304), valuesOff = new Float64Array(98304);
    const maskOn = new Uint8Array(98304), maskOff = new Uint8Array(98304);
    const big0 = big.calls();
    fillDensityColumn(off, s, solidOff, valuesOff, maskOff, NEVER);
    const bigOff = big.calls() - big0;
    fillDensityColumn(on, s, solidOn, valuesOn, maskOn, NEVER);
    const bigOn = big.calls() - big0 - bigOff;
    expect([firstDiff(maskOn, maskOff), firstDiff(solidOn, solidOff)]).toEqual([-1, -1]);
    let voxels = 0;
    for (let i = 0; i < 98304; i++) {
      if (maskOn[i] === 0) continue;
      voxels++;
      if (!Object.is(valuesOn[i], valuesOff[i])) throw new Error(`voxel ${i}: ${valuesOn[i]} with the lever, ${valuesOff[i]} without`);
    }
    expect(voxels).toBeGreaterThan(0);
    // Without the lever `big` is read at every evaluated voxel; with it, wherever `small` or the slope is below 96.
    expect(bigOff).toBe(voxels);
    expect(bigOn).toBeLessThan(bigOff / 10);
    expect(on.minSkipCounts[1]).toBeGreaterThan(0);
    expect([off.minSkipCounts[0], off.minSkipCounts[1]]).toEqual([0, 0]);
  });

  test('a min that roots a chain of its own is an operand of its reader\'s chain and skips there like any other', () => {
    // root = min(S, small) + 0·S, S = min(big + 100, big + 200) read twice (its own chain); S ∈ [96, 104] > small.
    const big = counted(), small = counted();
    const S = min(add(n3('big'), C(100)), add(n3('big'), C(200)));
    const e = only(add(min(S, n3('small')), { op: 'mul', a: S, b: C(0) }));
    const noises = source({ big: big.noise, small: small.noise });
    const on = createDensityBounds(compileDensity(e, noises), noises);
    const off = createDensityBounds(compileDensity(e, noises), noises, false);
    const c = on.compiled;
    expect(c.minChains.map((ch) => ch.operands.length)).toEqual([2, 2]);
    const s = handSample();
    const out = [new Uint8Array(98304), new Uint8Array(98304)];
    const values = [new Float64Array(98304), new Float64Array(98304)];
    const mask = [new Uint8Array(98304), new Uint8Array(98304)];
    fillDensityColumn(on, s, out[0]!, values[0]!, mask[0]!, NEVER);
    fillDensityColumn(off, s, out[1]!, values[1]!, mask[1]!, NEVER);
    expect([firstDiff(mask[0]!, mask[1]!), firstDiff(out[0]!, out[1]!)]).toEqual([-1, -1]);
    let voxels = 0;
    for (let i = 0; i < 98304; i++) if (mask[0]![i] === 1) { voxels++; expect(Object.is(values[0]![i], values[1]![i])).toBe(true); }
    expect(voxels).toBeGreaterThan(0);
    // S's own chain skips big + 200 wherever it is evaluated; the outer chain skips S at every evaluated cell.
    expect(on.minSkipCounts[1]).toBe(2 * on.minSkipCounts[0]!);
    expect(on.minSkipCounts[0]).toBe(voxels / 128);
  });

  test('random trees (±0, huge and tiny constants): the fill with the lever equals the fill without it', () => {
    const noises = fuzzNoiseSource();
    const ctx = ctxFor('42');
    const samples = [[-4, 9], [0, 0], [7, -3], [-1, -1]].map(([cx, cz]) => buildColumnSample(ctx, cx!, cz!, newColumnSample()));
    const next = testRng(1515);
    const solid = [new Uint8Array(98304), new Uint8Array(98304)];
    const values = [new Float64Array(98304), new Float64Array(98304)];
    const mask = [new Uint8Array(98304), new Uint8Array(98304)];
    let skipped = 0, voxels = 0, cells = 0;
    // 40 random trees with a min chain (the others have nothing to skip).
    for (let n = 0; n < 40;) {
      const e = randomDensityExpr(next);
      const on = createDensityBounds(compileDensity(e, noises), noises);
      if (on.compiled.minChains.length === 0) continue;
      n++;
      const off = createDensityBounds(compileDensity(e, noises), noises, false);
      const s = samples[n % 4]!;
      fillDensityColumn(on, s, solid[0]!, values[0]!, mask[0]!, NEVER);
      fillDensityColumn(off, s, solid[1]!, values[1]!, mask[1]!, NEVER);
      expect([firstDiff(mask[0]!, mask[1]!), firstDiff(solid[0]!, solid[1]!)]).toEqual([-1, -1]);
      for (let i = 0; i < 98304; i++) {
        if (mask[0]![i] === 0) continue;
        voxels++;
        if (!Object.is(values[0]![i], values[1]![i])) {
          throw new Error(`tree ${n} voxel ${i}: ${values[0]![i]} with the lever, ${values[1]![i]} without\n${JSON.stringify(e)}`);
        }
      }
      skipped += on.minSkipCounts[1]!;
      cells += on.minSkipCounts[0]!;
      expect(off.minSkipCounts[1]).toBe(0);
    }
    console.log(`lever 4 over 40 random trees with a min chain: ${voxels} voxels evaluated; cells with a skip ${cells}, operands skipped ${skipped}`);
    expect(skipped).toBeGreaterThan(1000);
    expect(voxels).toBeGreaterThan(100000);
  }, 120_000);

  test('with and without the lever, every voxel value and every tag of 64 columns are equal bit for bit', () => {
    const ctx = createGenContext(seedFromInput('42'), DEFAULTS);
    const dcOn = createDensityContext(ctx), dcOff = createDensityContext(ctx);
    const on = dcOn.bounds, off = createDensityBounds(dcOff.compiled, dcOff.noises, false);
    expect([on.minSkip, off.minSkip]).toEqual([true, false]);
    const c = dcOn.compiled;
    // Operand labels: the family taps, the precave tap, and the two `add(…, ref wetSteep)` (caves, noodle).
    const label = (id: number): string => {
      const n = c.nodes[id]!;
      if (n.op === 'tap') return (n.expr as { name: string }).name;
      if (n.op === 'add') {
        const a = c.nodes[n.kids[0]!]!;
        if (a.op === 'tap') return `${(a.expr as { name: string }).name} + S_w`;
        if (a.op === 'max') return 'caves + S_w';
      }
      return `${n.op}#${id}`;
    };
    const chains = c.minChains.map((ch) => ch.operands.map(label));
    expect(chains).toContainEqual(['entrances', 'cheese', 'spag3d', 'spag2d']);
    expect(chains).toContainEqual(['precave', 'caves + S_w', 'noodle + S_w']);
    // The others are the noodle cap's voxel-level min(1, …) (SP6a §1.4), two operands with the constant 1 first.
    expect(chains.filter((ch) => ch.length !== 2 || !ch[0]!.startsWith('const#'))).toHaveLength(2);
    const skipped = new Map<string, number>();
    const sample = newColumnSample();
    const solid = [new Uint8Array(98304), new Uint8Array(98304)];
    const values = [new Float64Array(98304), new Float64Array(98304)];
    const mask = [new Uint8Array(98304), new Uint8Array(98304)];
    const cells = [new Uint8Array(768), new Uint8Array(768)];
    const tags = [new Uint8Array(98304), new Uint8Array(98304)];
    const th = DEFAULTS.caves.pillars.threshold;
    let voxels = 0, tagged = 0;
    for (let t = 1; t <= 64; t++) {
      // terrain.real's candidate sequence (test/bench/noise.bench.ts).
      const cx = (t * 7919) % 60000 - 30000, cz = (t * 104729) % 60000 - 30000;
      buildColumnSample(ctx, cx, cz, sample);
      [on, off].forEach((b, k) => {
        expect(fillDensityColumn(b, sample, solid[k]!, values[k]!, mask[k]!, NEVER, cells[k]!)).toBe(true);
        if (k === 0) {
          // Which operands the lever skipped in this column (read before the tag pass moves the registers).
          for (let cell = 0; cell < 768; cell++) {
            if (c.minSkipReady[cell] !== 1) continue;
            for (const ch of c.minChains) {
              for (const m of ch.mins) {
                const st = c.minSkips[cell * c.minSlotCount + c.nodes[m]!.minSlot]!;
                c.nodes[m]!.kids.forEach((kid, side) => {
                  if ((st & (1 << side)) !== 0 && ch.operands.includes(kid)) skipped.set(label(kid), (skipped.get(label(kid)) ?? 0) + 1);
                });
              }
            }
          }
        }
        tagColumn(b.compiled, caveReadersOf(b.compiled), th, solid[k]!, cells[k]!, tags[k]!, b);
      });
      expect([firstDiff(mask[0]!, mask[1]!), firstDiff(solid[0]!, solid[1]!), firstDiff(cells[0]!, cells[1]!)]).toEqual([-1, -1, -1]);
      for (let i = 0; i < 98304; i++) {
        if (mask[0]![i] !== 0) {
          voxels++;
          if (!Object.is(values[0]![i], values[1]![i])) {
            throw new Error(`(${cx}, ${cz}) voxel ${i}: ${values[0]![i]} with the lever, ${values[1]![i]} without`);
          }
        }
        if (tags[0]![i] !== tags[1]![i]) throw new Error(`(${cx}, ${cz}) voxel ${i}: tag ${tags[0]![i]} with the lever, ${tags[1]![i]} without`);
        if (tags[0]![i] !== 0) tagged++;
      }
    }
    console.log(`lever 4 over 64 columns: ${voxels} voxels evaluated, ${tagged} tagged; cells with a skip ${on.minSkipCounts[0]}, `
      + `operands skipped ${on.minSkipCounts[1]}; per operand (cells): ${[...skipped].map(([k, v]) => `${k} ${v}`).join(', ')}`);
    expect(voxels).toBeGreaterThan(0);
    expect(tagged).toBeGreaterThan(0);
    // Both parts of the lever act: a family, and the noodle against min(T + detailG, caves).
    expect(skipped.get('noodle + S_w') ?? 0).toBeGreaterThan(0);
    expect(['entrances', 'cheese', 'spag3d', 'spag2d'].some((f) => (skipped.get(f) ?? 0) > 0)).toBe(true);
    expect([off.minSkipCounts[0], off.minSkipCounts[1]]).toEqual([0, 0]);
  }, 300_000);
});

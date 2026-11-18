import { describe, expect, test } from 'vitest';
import { AQUIFER_EMPTY } from '../../src/core/constants';
import { seedFromInput } from '../../src/core/seed';
import { newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import { createGenContext } from '../../src/gen/context';
import {
  aquiferInputs, cellCandidates, cellCentre, cellKindOf, cellOf, cellStatus, statusOf, type AquiferInputs, type AquiferSettings,
} from '../../src/gen/fluids/aquifer';
import { FLUID_LAVA, FLUID_WATER } from '../../src/world/blocks/fluid';
import { AQUIFER_NOISES, AQUIFER_SETTINGS } from '../harness/aquiferDefaults';
import { ctxFor, paramsWith } from '../harness/gen';
import { testRng } from '../harness/stats';

const ST: AquiferSettings = AQUIFER_SETTINGS;
const typeOf = (s: number): number => s >>> 16;
const levelOf = (s: number): number => (s & 0xffff) - 32768;
/** A uniform integer in lo … hi from `testRng`. */
const intIn = (next: () => number, lo: number, hi: number): number => lo + (next() % (hi - lo + 1));
const inputsFor = (seed: string): AquiferInputs => aquiferInputs(createGenContext(seedFromInput(seed), paramsWith()), ST, AQUIFER_NOISES);

describe('the aquifer cells (SP7a spec §1.1, Spec correction 3)', () => {
  test('cellOf: i = ⌊(x − 5)/16⌋, j = ⌊(y + 1)/12⌋, k = ⌊(z − 5)/16⌋', () => {
    const out = new Int32Array(3);
    const iOf = (x: number): number => (cellOf(x, 0, 0, out), out[0]!);
    const jOf = (y: number): number => (cellOf(0, y, 0, out), out[1]!);
    const kOf = (z: number): number => (cellOf(0, 0, z, out), out[2]!);
    expect([4, 5, 20, 21].map(iOf)).toEqual([-1, 0, 0, 1]);
    expect([4, 5, 20, 21].map(kOf)).toEqual([-1, 0, 0, 1]);
    expect([-2, -1, 10, 11].map(jOf)).toEqual([-1, 0, 0, 1]);
  });

  test('every centre lies within its cell\'s ranges (16i + 0 … 9, 12j + 0 … 8, 16k + 0 … 9), each jitter reaching both ends', () => {
    const inp = inputsFor('42');
    const rng = testRng(5);
    const c = new Int32Array(3);
    const seen = [new Set<number>(), new Set<number>(), new Set<number>()];
    for (let n = 0; n < 4000; n++) {
      const i = intIn(rng, -300, 300);
      const j = intIn(rng, -7, 27);
      const k = intIn(rng, -300, 300);
      cellCentre(inp, i, j, k, c);
      const d = [c[0]! - 16 * i, c[1]! - 12 * j, c[2]! - 16 * k];
      expect(d[0]).toBeGreaterThanOrEqual(0);
      expect(d[0]).toBeLessThanOrEqual(9);
      expect(d[1]).toBeGreaterThanOrEqual(0);
      expect(d[1]).toBeLessThanOrEqual(8);
      expect(d[2]).toBeGreaterThanOrEqual(0);
      expect(d[2]).toBeLessThanOrEqual(9);
      for (let a = 0; a < 3; a++) seen[a]!.add(d[a]!);
    }
    expect(seen.map((s) => s.size)).toEqual([10, 9, 10]);
  });

  test('centres are identical across call orders and two inputs of one seed, and differ for seed \'43\'', () => {
    const a = inputsFor('42');
    const b = inputsFor('42');
    const other = inputsFor('43');
    const cells: Array<[number, number, number]> = [];
    for (let i = -3; i <= 3; i++) for (let j = -7; j <= 27; j += 5) for (let k = -3; k <= 3; k++) cells.push([i, j, k]);
    const c = new Int32Array(3);
    const forward = cells.map(([i, j, k]) => (cellCentre(a, i, j, k, c), [c[0]!, c[1]!, c[2]!]));
    const backward = [...cells].reverse().map(([i, j, k]) => (cellCentre(b, i, j, k, c), [c[0]!, c[1]!, c[2]!])).reverse();
    expect(forward.length).toBe(cells.length);
    for (let n = 0; n < cells.length; n++) for (let a3 = 0; a3 < 3; a3++) expect(Object.is(forward[n]![a3], backward[n]![a3])).toBe(true);
    const fromOther = cells.map(([i, j, k]) => (cellCentre(other, i, j, k, c), [c[0]!, c[1]!, c[2]!]));
    expect(fromOther).not.toEqual(forward);
  });

  test('the 12 candidates: i … i + 1, j − 1 … j + 1, k … k + 1, i outer, j, k inner', () => {
    const out = new Int32Array(36);
    cellCandidates(21, 11, 4, out); // cell (1, 1, −1)
    const expected: number[] = [];
    for (let i = 1; i <= 2; i++) for (let j = 0; j <= 2; j++) for (let k = -1; k <= 0; k++) expected.push(i, j, k);
    expect([...out]).toEqual(expected);
  });
});

describe('the aquifer statuses (SP7a spec §1.2-§1.4)', () => {
  test('near the surface: ⌊surfaceWaterLevel⌋ water under the sea and under a lake, empty on land', () => {
    const sea = statusOf(ST, 30, 40, 63, 0, 0, 0); // centre 30 ≥ 40 − 12
    expect([typeOf(sea), levelOf(sea)]).toEqual([FLUID_WATER, 63]);
    const lake = statusOf(ST, 30, 40, 95, 0, 0, 0);
    expect([typeOf(lake), levelOf(lake)]).toEqual([FLUID_WATER, 95]);
    expect(statusOf(ST, 30, 40, -Infinity, 0, 0, 0)).toBe(AQUIFER_EMPTY);
    expect(statusOf(ST, 28, 40, 63.6, -1, 0, 0)).toBe(statusOf(ST, 28, 40, 63, 1, 1, 1)); // ⌊63.6⌋, no noise read
  });

  test('the ocean factor: offset 63 → t 0, 55 → 1, 59 → 0.5 (full threshold 0.25)', () => {
    const full = (offset: number, nf: number): boolean => cellKindOf(ST, 0, offset, -Infinity, nf) === 2;
    expect([full(63, 0.81), full(63, 0.79)]).toEqual([true, false]);
    expect([full(55, -0.29), full(55, -0.31)]).toEqual([true, false]);
    expect([full(59, 0.26), full(59, 0.24)]).toEqual([true, false]);
    const s = statusOf(ST, 0, 59, -Infinity, 0.26, 0, 0);
    expect([typeOf(s), levelOf(s)]).toEqual([FLUID_WATER, 63]);
    expect(statusOf(ST, 0, 59, -Infinity, 0.24, 0, 0)).not.toBe(s);
  });

  test('partial levels: ⌊cy/40⌋·40 + 20 + 3·round(ns·10/3)', () => {
    const level = (cy: number, ns: number): number => levelOf(statusOf(ST, cy, 200, -Infinity, 0.5, ns, 0));
    expect(level(25, 1)).toBe(29);
    expect(level(25, -1)).toBe(11);
    expect(level(25, 0.15)).toBe(23); // Math.round(0.5) = 1
    expect(level(25, 3)).toBe(29); // ns clamped to [−1, 1]
    expect(level(-5, 0)).toBe(-20); // band −40 … 0, middle −20
    expect(level(-5, 1)).toBe(-11);
    expect(level(-5, -1)).toBe(-29);
  });

  test('lava: a partial level ≤ −10 with |nlava| > 0.3 (rulings P3)', () => {
    const at = (cy: number, ns: number, nlava: number): number => statusOf(ST, cy, 200, -Infinity, 0.5, ns, nlava);
    expect(levelOf(at(-20, -0.3, 0.31))).toBe(-23);
    expect(typeOf(at(-20, -0.3, 0.31))).toBe(FLUID_LAVA);
    expect(typeOf(at(-20, -0.3, -0.31))).toBe(FLUID_LAVA);
    expect(typeOf(at(-20, -0.3, 0.29))).toBe(FLUID_WATER);
    expect(levelOf(at(-20, 1, 0.9))).toBe(-11); // the highest level of the band −40 … 0 is lava-eligible
    expect(typeOf(at(-20, 1, 0.9))).toBe(FLUID_LAVA);
    expect(levelOf(at(20, -1, 0.9))).toBe(11);
    expect(typeOf(at(20, -1, 0.9))).toBe(FLUID_WATER);
    expect(typeOf(at(-20, -0.3, 5))).toBe(FLUID_LAVA); // nlava clamped
  });

  test('under the sea (t 1) a cell floods partially at nf −0.79; empty otherwise', () => {
    expect(cellKindOf(ST, 0, 40, 63, -0.79)).toBe(3);
    expect(statusOf(ST, 0, 40, 63, -0.79, 0, 0)).not.toBe(AQUIFER_EMPTY);
    expect(cellKindOf(ST, 0, 40, 63, -0.81)).toBe(0);
    expect(statusOf(ST, 0, 40, 63, -0.81, 0, 0)).toBe(AQUIFER_EMPTY);
    expect(statusOf(ST, 0, 100, -Infinity, 0.39, 0, 0)).toBe(AQUIFER_EMPTY); // inland (t 0): partial needs nf > 0.4
  });

  test('cellKindOf names each branch; a partial cell at level 63 reads 3, not 2', () => {
    expect(cellKindOf(ST, 30, 40, 63, 0)).toBe(1);
    expect(cellKindOf(ST, 30, 40, -Infinity, 0)).toBe(1);
    expect(cellKindOf(ST, 0, 100, -Infinity, 0.9)).toBe(2);
    expect(cellKindOf(ST, 0, 100, -Infinity, 0.5)).toBe(3);
    expect(cellKindOf(ST, 0, 100, -Infinity, 0.3)).toBe(0);
    const s = statusOf(ST, 50, 200, -Infinity, 0.5, 0.3, 0); // cy 40 … 79, ns 0.3: 40 + 20 + 3
    expect([typeOf(s), levelOf(s)]).toEqual([FLUID_WATER, 63]);
    expect(s).toBe(statusOf(ST, 0, 200, -Infinity, 0.9, 0, 0)); // the same packed status as a full cell
    expect(cellKindOf(ST, 50, 200, -Infinity, 0.5)).toBe(3);
  });

  test('cellStatus equals statusOf on the sampled values at 200 cells of seed \'42\', and its kindOut cellKindOf\'s', () => {
    const ctx = ctxFor('42');
    const inp = aquiferInputs(ctx, ST, AQUIFER_NOISES);
    const rng = testRng(7);
    const rec = newPointRecord();
    const c = new Int32Array(3);
    const kind = new Int32Array(1);
    const kinds = new Set<number>();
    for (let n = 0; n < 200; n++) {
      const i = intIn(rng, -40, 40);
      const j = intIn(rng, -7, 10);
      const k = intIn(rng, -40, 40);
      cellCentre(inp, i, j, k, c);
      const [cx, cy, cz] = [c[0]!, c[1]!, c[2]!];
      const p = samplePoint(ctx, 16 * i, 16 * k, false, rec);
      const nf = inp.floodedness.z3(cx, 0.67 * cy, cz);
      const ns = inp.spread.z3(cx, 0.714 * cy, cz);
      const nlava = inp.lava.z3(64 * Math.floor(cx / 64), 40 * Math.floor(cy / 40), 64 * Math.floor(cz / 64));
      kind[0] = -1;
      expect(cellStatus(inp, i, j, k, kind)).toBe(statusOf(ST, cy, p.offset, p.surfaceWaterLevel, nf, ns, nlava));
      expect(kind[0]).toBe(cellKindOf(ST, cy, p.offset, p.surfaceWaterLevel, nf));
      expect(cellStatus(inp, i, j, k)).toBe(statusOf(ST, cy, p.offset, p.surfaceWaterLevel, nf, ns, nlava));
      kinds.add(kind[0]!);
    }
    expect([...kinds].sort()).toEqual([0, 1, 2, 3]);
  });
});

import { describe, expect, test } from 'vitest';
import type { ParamsPatch } from '../../src/core/params/schema';
import { newPointRecord, samplePoint } from '../../src/gen/column/columnPoint';
import {
  CROSS_SECTION_FIELDS, CROSS_SECTION_POINTS, crossSectionInto, crossSectionLength, segmentLength, segmentPointAt, segmentProblem,
  summarizeCrossSection, type Segment,
} from '../../src/metrics/crossSection';
import { ctxFor } from '../harness/gen';

const N = 512;
/**
 * Seed 42, default params: 1536 blocks east along z = 3072, from the sea over the coast, two river channels,
 * two gorges and a lake at level 153 (the line of the browser check).
 */
const COAST: Segment = { ax: 5120, az: 3072, bx: 6656, bz: 3072 };

/** The direct computation: samplePoint (no steep) at A + (B − A)·i/511, field by field in the documented order. */
function direct(seed: string, patch: ParamsPatch, s: Segment): number[] {
  const ctx = ctxFor(seed, patch);
  const out = new Array<number>(8 * N).fill(0);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const p = samplePoint(ctx, s.ax + (s.bx - s.ax) * t, s.az + (s.bz - s.az) * t, false, newPointRecord());
    const fields = [p.offset0, p.offset, p.sigma, p.jag, p.riverWet ? 1 : 0, p.gorge ? 1 : 0, p.lakeLevel, p.surfaceWaterLevel];
    fields.forEach((v, f) => { out[f * N + i] = v; });
  }
  return out;
}

const run = (seed: string, patch: ParamsPatch, s: Segment, from = 0, to = N, stop?: () => boolean) => {
  const out = new Float64Array(crossSectionLength());
  const done = crossSectionInto(ctxFor(seed, patch), s, from, to, out, stop);
  return { out, done };
};
const field = (out: ArrayLike<number>, f: number): number[] => Array.from(out).slice(f * N, (f + 1) * N);

describe('layout', () => {
  test('8 fields of 512 points, field f of point i at f·512 + i', () => {
    expect(CROSS_SECTION_POINTS).toBe(N);
    expect(CROSS_SECTION_FIELDS).toEqual(['offset0', 'offset', 'sigma', 'jag', 'riverWet', 'gorge', 'lakeLevel', 'surfaceWaterLevel']);
    expect(crossSectionLength()).toBe(4096);
  });
});

describe('crossSectionInto', () => {
  test('equals a direct samplePoint loop on the coast line (sea, rivers, gorges and a lake)', () => {
    const want = direct('42', {}, COAST);
    const got = run('42', {}, COAST);
    expect(got.done).toBe(true);
    expect(Array.from(got.out)).toEqual(want);
    const offset = field(want, 1);
    const water = field(want, 7);
    // The line crosses every feature the tab draws.
    expect(offset.some((v, i) => v < 63 && water[i] === 63)).toBe(true);
    expect(water.some((v) => v === -Infinity)).toBe(true);
    expect(field(want, 4).filter((v) => v === 1).length).toBeGreaterThan(0);
    expect(field(want, 5).filter((v) => v === 1).length).toBeGreaterThan(0);
    expect(field(want, 6).filter((v) => v === 153).length).toBe(34);
    expect(field(want, 6).filter((v) => v !== 153).every((v) => v === -Infinity)).toBe(true);
  });
  test('equals the direct loop on a diagonal line with fractional ends, a line across the whole window and another seed', () => {
    const diagonal: Segment = { ax: -3001.5, az: 777.25, bx: 4123, bz: -2500.75 };
    const corners: Segment = { ax: -524288, az: -524288, bx: 524287, bz: 524287 };
    expect(Array.from(run('42', {}, diagonal).out)).toEqual(direct('42', {}, diagonal));
    expect(Array.from(run('42', {}, corners).out)).toEqual(direct('42', {}, corners));
    expect(Array.from(run('7', {}, COAST).out)).toEqual(direct('7', {}, COAST));
  });
  test('follows the params: a deeper gorge lowers offset at every gorge point and nowhere outside the channels', () => {
    const patch: ParamsPatch = { rivers: { gorgeDepth: 40 } };
    const base = run('42', {}, COAST).out;
    const deep = run('42', patch, COAST).out;
    expect(Array.from(deep)).toEqual(direct('42', patch, COAST));
    const wet = field(base, 4);
    const gorge = field(base, 5);
    const lower = field(deep, 1).flatMap((v, i) => (v < base[N + i]! ? [i] : []));
    expect(gorge.flatMap((g, i) => (g === 1 ? [i] : []))).toEqual([317, 318, 319, 350, 351]);
    expect([317, 318, 319, 350, 351].every((i) => lower.includes(i))).toBe(true);
    expect(lower.every((i) => gorge[i] === 1 || wet[i] === 1)).toBe(true);
    expect(field(deep, 1).every((v, i) => v <= base[N + i]!)).toBe(true);
    expect(field(deep, 0)).toEqual(field(base, 0));
  });
  test('a range [from, to) writes only its points; disjoint ranges add up to the whole line', () => {
    const whole = run('42', {}, COAST).out;
    const a = run('42', {}, COAST, 0, 200).out;
    const b = run('42', {}, COAST, 200, N).out;
    const wrong: number[] = [];
    for (let k = 0; k < whole.length; k++) {
      const i = k % N;
      if ((i < 200 ? b[k] : a[k]) !== 0) wrong.push(k);
      if (a[k]! + b[k]! !== whole[k]) wrong.push(k);
    }
    expect(wrong).toEqual([]);
  });
  test('calls stop before points from, from + 256, …; a stopped call returns false and leaves the rest unwritten', () => {
    let calls = 0;
    expect(run('42', {}, COAST, 0, N, () => { calls++; return false; }).done).toBe(true);
    expect(calls).toBe(2);
    calls = 0;
    const stopped = run('42', {}, COAST, 0, N, () => ++calls === 2);
    expect(stopped.done).toBe(false);
    const whole = run('42', {}, COAST).out;
    expect(field(stopped.out, 1).slice(0, 256)).toEqual(field(whole, 1).slice(0, 256));
    expect(field(stopped.out, 1).slice(256).every((v) => v === 0)).toBe(true);
    calls = 0;
    expect(run('42', {}, COAST, 10, 300, () => { calls++; return false; }).done).toBe(true);
    expect(calls).toBe(2);
  });
  test('throws RangeError on a bad segment, output length or point range', () => {
    const ctx = ctxFor('42');
    const out = new Float64Array(crossSectionLength());
    expect(() => crossSectionInto(ctx, { ...COAST, bx: 524288 }, 0, N, out)).toThrow(RangeError);
    expect(() => crossSectionInto(ctx, { ...COAST, bx: COAST.ax, bz: COAST.az }, 0, N, out)).toThrow(RangeError);
    expect(() => crossSectionInto(ctx, COAST, 0, N, new Float64Array(4095))).toThrow(RangeError);
    for (const [from, to] of [[-1, 10], [10, 9], [0, 513], [0.5, 10]] as const) {
      expect(() => crossSectionInto(ctx, COAST, from, to, out)).toThrow(RangeError);
    }
  });
});

describe('segments', () => {
  test('segmentProblem: both ends inside the half-open window [−2^19, 2^19) and A ≠ B', () => {
    expect(segmentProblem(COAST)).toBeNull();
    expect(segmentProblem({ ax: -524288, az: -524288, bx: 524287.5, bz: 0 })).toBeNull();
    expect(segmentProblem({ ax: 524288, az: 0, bx: 0, bz: 0 })).toBe('A (524288, 0) is outside the world window [-524288, 524288)');
    expect(segmentProblem({ ax: 0, az: 0, bx: 7, bz: -524289 })).toBe('B (7, -524289) is outside the world window [-524288, 524288)');
    expect(segmentProblem({ ax: Number.NaN, az: 0, bx: 7, bz: 1 })).toBe('A (NaN, 0) is outside the world window [-524288, 524288)');
    expect(segmentProblem({ ax: 0, az: 0, bx: Infinity, bz: 1 })).toBe('B (Infinity, 1) is outside the world window [-524288, 524288)');
    expect(segmentProblem({ ax: 12, az: -3, bx: 12, bz: -3 })).toBe('A and B are the same point (12, -3)');
    expect(segmentProblem({ ax: 0, az: 5, bx: -0, bz: 5 })).toBe('A and B are the same point (0, 5)');
  });
  test('segmentLength and segmentPointAt: A at 0, B at 511, evenly spaced, inside the bounding box', () => {
    expect(segmentLength(COAST)).toBe(1536);
    expect(segmentLength({ ax: 0, az: 0, bx: 3, bz: -4 })).toBe(5);
    expect(segmentPointAt(COAST, 0)).toEqual([5120, 3072]);
    expect(segmentPointAt(COAST, 511)).toEqual([6656, 3072]);
    expect(segmentPointAt(COAST, 318)).toEqual([5120 + 1536 * (318 / 511), 3072]);
    // B is the largest double below 2^19: A + (B − A)·511/511 rounds to 2^19, outside the window; the clamp keeps B.
    const edge: Segment = { ax: -0.1, az: 0, bx: 524287.99999999994, bz: 0 };
    expect(segmentProblem(edge)).toBeNull();
    expect(edge.ax + (edge.bx - edge.ax) * (511 / 511)).toBe(524288);
    expect(segmentPointAt(edge, 511)).toEqual([524287.99999999994, 0]);
  });
  test('summarizeCrossSection: the distance of each point from A, the fields and the flags', () => {
    const p = summarizeCrossSection(run('42', {}, COAST).out, COAST);
    const want = direct('42', {}, COAST);
    expect(p.segment).toEqual(COAST);
    expect(p.length).toBe(1536);
    expect([p.distance[0], p.distance[1], p.distance[511]]).toEqual([0, 1536 / 511, 1536]);
    expect(Array.from(p.offset0)).toEqual(field(want, 0));
    expect(Array.from(p.offset)).toEqual(field(want, 1));
    expect(Array.from(p.sigma)).toEqual(field(want, 2));
    expect(Array.from(p.jag)).toEqual(field(want, 3));
    expect(p.riverWet).toBeInstanceOf(Uint8Array);
    expect(Array.from(p.riverWet)).toEqual(field(want, 4));
    expect(Array.from(p.gorge)).toEqual(field(want, 5));
    expect(Array.from(p.lakeLevel)).toEqual(field(want, 6));
    expect(Array.from(p.surfaceWaterLevel)).toEqual(field(want, 7));
    expect(() => summarizeCrossSection(new Float64Array(10), COAST)).toThrow(RangeError);
  });
});

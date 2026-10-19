/**
 * The preset window search (SP3e spec §6 "Windows", D14): candidates w(a, b) in rings r = 0 … 64 (max(|a|, |b|) = r),
 * within a ring by a then b ascending; the first candidate whose predicate holds through `columnPoint` on the preset's
 * ctx (seed '42') is the preset's window, whose centre fixes the review lines of every tuning set (§1.5 step 1, §8).
 */
import { describe, expect, test } from 'vitest';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext } from '../../src/gen/context';
import { columnPoint } from '../../src/gen/column/columnPoint';
import {
  findWindow, presetWindow, ringCandidates, windowHolds, WINDOW_PRESETS, type Sp3ePreset,
} from '../../src/metrics/sp3eGoldens';

const ctxOf = (p: Sp3ePreset) => createGenContext(seedFromInput('42'), resolveProfile(p));

describe('candidate order', () => {
  test('rings 0 … 2 in order: a then b ascending within a ring', () => {
    expect(ringCandidates(0)).toEqual([[0, 0]]);
    expect(ringCandidates(1)).toEqual([[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]);
    expect(ringCandidates(2)).toEqual([
      [-2, -2], [-2, -1], [-2, 0], [-2, 1], [-2, 2],
      [-1, -2], [-1, 2], [0, -2], [0, 2], [1, -2], [1, 2],
      [2, -2], [2, -1], [2, 0], [2, 1], [2, 2],
    ]);
  });

  test('ring r holds the 8r cells with max(|a|, |b|) = r, each once', () => {
    for (const r of [3, 17, 64]) {
      const c = ringCandidates(r);
      expect(c).toHaveLength(8 * r);
      expect(new Set(c.map(([a, b]) => `${a},${b}`)).size).toBe(8 * r);
      for (const [a, b] of c) expect(Math.max(Math.abs(a), Math.abs(b))).toBe(r);
    }
  });

  test('a ring outside 0 … 64 or not an integer is refused', () => {
    expect(() => ringCandidates(-1)).toThrow(RangeError);
    expect(() => ringCandidates(65)).toThrow(RangeError);
    expect(() => ringCandidates(1.5)).toThrow(RangeError);
  });
});

describe('findWindow', () => {
  test('returns the first holding candidate with its chunk origin (8a − 4, 8b − 4) and centre block (128a, 128b)', () => {
    const seen: string[] = [];
    const w = findWindow('x', (a, b) => {
      seen.push(`${a},${b}`);
      return a === 1 && b === -1;
    });
    expect(w).toEqual({ a: 1, b: -1, chunkX: 4, chunkZ: -12, centreX: 128, centreZ: -128 });
    expect(seen).toEqual(['0,0', '-1,-1', '-1,0', '-1,1', '0,-1', '0,1', '1,-1']);
  });

  test('a never-true predicate throws `no window for x` after ring 64', () => {
    let calls = 0;
    expect(() => findWindow('x', () => { calls++; return false; })).toThrow(/^no window for x$/);
    expect(calls).toBe(129 * 129);
  });
});

describe('the three preset windows (seed 42)', () => {
  test('WINDOW_PRESETS are the three draft presets in PROFILE_IDS order', () => {
    expect(WINDOW_PRESETS).toEqual(['archipelago', 'amplified', 'floating_islands']);
  });

  test('an unknown preset is refused', () => {
    expect(() => presetWindow('default' as Sp3ePreset)).toThrow(RangeError);
    expect(() => windowHolds('toString' as Sp3ePreset, ctxOf('amplified'), 0, 0)).toThrow(RangeError);
  });

  test.each(WINDOW_PRESETS)('%s: the found window holds its predicate and no earlier candidate does', (p) => {
    const ctx = ctxOf(p);
    const w = presetWindow(p);
    expect(windowHolds(p, ctx, w.a, w.b)).toBe(true);
    const r = Math.max(Math.abs(w.a), Math.abs(w.b));
    let earlier = 0;
    outer: for (let k = 0; k <= r; k++) {
      for (const [a, b] of ringCandidates(k)) {
        if (a === w.a && b === w.b) break outer;
        expect(windowHolds(p, ctx, a, b), `${p}: w(${a}, ${b}) is earlier and holds`).toBe(false);
        earlier++;
      }
    }
    expect(earlier).toBe(r === 0 ? 0 : (2 * r - 1) * (2 * r - 1) + ringCandidates(r).findIndex(([a, b]) => a === w.a && b === w.b));
  });

  test('the predicates, re-stated on columnPoint at the found centres (archipelago\'s probes on the review line, z = centre)', () => {
    const amp = presetWindow('amplified');
    expect(columnPoint(ctxOf('amplified'), amp.centreX, amp.centreZ).offset0).toBeGreaterThanOrEqual(180);
    const fl = presetWindow('floating_islands');
    const fp = columnPoint(ctxOf('floating_islands'), fl.centreX, fl.centreZ);
    expect(fp.islandMask).toBeGreaterThanOrEqual(0.9);
    expect(fp.offset0).toBeLessThan(63);
    const ar = presetWindow('archipelago');
    const actx = ctxOf('archipelago');
    // Checkpoint M (controller ruling): the centre and x ± 60 along the review line, not the diagonal (128a ± 60, 128b ± 60).
    const pts = [-60, 0, 60].map((dx) => columnPoint(actx, ar.centreX + dx, ar.centreZ).offset0);
    expect(pts.some((o) => o < 63)).toBe(true);
    expect(pts.some((o) => o >= 63)).toBe(true);
  });

  test('archipelago: w(−2, 2), whose diagonal probes hold sea and land while its review line is land, no longer holds', () => {
    const actx = ctxOf('archipelago');
    const diag = [[-60, -60], [-60, 60], [60, -60], [60, 60]].map(([dx, dz]) => columnPoint(actx, -256 + dx!, 256 + dz!).offset0);
    expect(diag.some((o) => o < 63)).toBe(true);
    for (const dx of [-60, 0, 60]) expect(columnPoint(actx, -256 + dx, 256).offset0).toBeGreaterThanOrEqual(63);
    expect(windowHolds('archipelago', actx, -2, 2)).toBe(false);
  });

  test('another seed text searches on its own ctx', () => {
    const w = presetWindow('floating_islands', '1');
    expect(windowHolds('floating_islands', createGenContext(seedFromInput('1'), resolveProfile('floating_islands')), w.a, w.b)).toBe(true);
  });
});

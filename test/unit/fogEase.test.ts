import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { FILL_SCAN_FRAMES, FOG_EASE_BLOCKS_PER_S, createFogEase, filledRadius } from '../../src/ui/world/fogEase';

/** One 60 Hz frame, as the brief's 120 steps of 16.667 ms (0.5333 blocks each). */
const FRAME_MS = 16.667;
/** The fog's end in blocks for the fog's RD (SP4b spec §6.3: (rd − 1)·16). */
const end = (rd: number): number => (rd - 1) * 16;

describe('filledRadius (SP4b spec §5)', () => {
  test('the pinned values', () => {
    expect(FOG_EASE_BLOCKS_PER_S).toBe(32);
    expect(FILL_SCAN_FRAMES).toBe(30);
  });

  test('filledRadius: an unrevealed column at (5, 0) gives 4, at (3, 4) 4, at (4, 4) 5; all revealed gives rd', () => {
    // Around a far camera column too: offsets, not absolute columns, decide.
    for (const [cx, cz] of [[0, 0], [-31_249, -31_249]] as const) {
      const missing = (dx: number, dz: number) => (x: number, z: number) => !(x === cx + dx && z === cz + dz);
      expect(filledRadius(cx, cz, 12, missing(5, 0))).toBe(4);
      expect(filledRadius(cx, cz, 12, missing(3, 4))).toBe(4);
      expect(filledRadius(cx, cz, 12, missing(4, 4))).toBe(5);
      expect(filledRadius(cx, cz, 12, () => true)).toBe(12);
      expect(filledRadius(cx, cz, 8, () => true)).toBe(8);
    }
  });

  test('the nearest unrevealed column decides, and the scan stops there', () => {
    const hidden = new Set([colKey(7, 0), colKey(0, -3), colKey(10, 10)]);
    let lookups = 0;
    const r = filledRadius(0, 0, 12, (x, z) => {
      lookups++;
      return !hidden.has(colKey(x, z));
    });
    // (0, −3) at d = 3: the disc of radius 2 is the largest without it.
    expect(r).toBe(2);
    // The scan is in spiral order: it stopped at d² = 9, well before the 489 columns of RD 12.
    expect(lookups).toBeLessThan(40);
  });
});

describe('createFogEase (SP4b spec §5, D18; Review Focus 5)', () => {
  test('raise 8 → 12 with every ring filled: the fog end goes 112 → 176 in 2.0 s (120 steps of 16.667 ms, 0.5333 blocks each) and stops', () => {
    const fog = createFogEase(8);
    expect(end(fog.step(FRAME_MS, 8))).toBe(112);
    fog.setTarget(12);
    expect(fog.target).toBe(12);
    let rd = 8;
    for (let i = 1; i <= 119; i++) {
      const next = fog.step(FRAME_MS, 12);
      expect(end(next) - end(rd)).toBeCloseTo(0.5333, 3);
      rd = next;
    }
    expect(end(rd)).toBeLessThan(176);
    expect(end(fog.step(FRAME_MS, 12))).toBe(176);
    for (let i = 0; i < 60; i++) expect(fog.step(FRAME_MS, 12)).toBe(12);
  });

  test('a long frame moves it no more than 32 blocks/s allow', () => {
    const fog = createFogEase(8);
    fog.setTarget(12);
    expect(end(fog.step(250, 12))).toBeCloseTo(112 + 8, 9);
    expect(end(fog.step(5_000, 12))).toBe(176);
  });

  test('with the filled radius at 10 it stops at 144 until the radius grows', () => {
    const fog = createFogEase(8);
    fog.setTarget(12);
    let rd = 8;
    for (let i = 0; i < 200; i++) rd = fog.step(FRAME_MS, 10);
    expect(end(rd)).toBe(144);
    // The radius grows to 11: on to 160 and no further.
    for (let i = 0; i < 200; i++) rd = fog.step(FRAME_MS, 11);
    expect(end(rd)).toBe(160);
    for (let i = 0; i < 200; i++) rd = fog.step(FRAME_MS, 12);
    expect(end(rd)).toBe(176);
  });

  test('never inward while the filled radius shrinks after the target is reached', () => {
    const fog = createFogEase(8);
    fog.setTarget(12);
    for (let i = 0; i < 200; i++) fog.step(FRAME_MS, 12);
    // Flying too fast empties the rings: the fog stays put (the spec's empty areas).
    for (const filled of [11, 6, 0, -1]) expect(fog.step(FRAME_MS, filled)).toBe(12);
    // And while easing: a shrinking radius holds it where it is, never pulls it in.
    const easing = createFogEase(8);
    easing.setTarget(12);
    let rd = 8;
    for (let i = 0; i < 60; i++) rd = easing.step(FRAME_MS, 12);
    expect(end(rd)).toBeGreaterThan(140);
    expect(easing.step(FRAME_MS, 9)).toBe(rd);
    expect(easing.step(FRAME_MS, -1)).toBe(rd);
  });

  test('raise 8 → 12, 30 frames later (fog end 128) lower to 10: the fog end stays 128, eases on to 144 and stops; lowering to 8 at 128 gives 112 at once', () => {
    const fog = createFogEase(8);
    fog.setTarget(12);
    let rd = 8;
    for (let i = 0; i < 30; i++) rd = fog.step(FRAME_MS, 12);
    expect(end(rd)).toBeCloseTo(128, 2);
    fog.setTarget(10);
    expect(fog.target).toBe(10);
    // Lowering never pulls the fog past where it is.
    const at = fog.step(0, 12);
    expect(at).toBe(rd);
    for (let i = 0; i < 29; i++) rd = fog.step(FRAME_MS, 12);
    expect(end(rd)).toBeLessThan(144);
    expect(end(fog.step(FRAME_MS, 12))).toBe(144);
    for (let i = 0; i < 60; i++) expect(end(fog.step(FRAME_MS, 12))).toBe(144);

    const lower = createFogEase(8);
    lower.setTarget(12);
    let r2 = 8;
    for (let i = 0; i < 30; i++) r2 = lower.step(FRAME_MS, 12);
    expect(end(r2)).toBeCloseTo(128, 2);
    lower.setTarget(8);
    // At once: before any step, and every step after.
    expect(end(lower.step(0, 12))).toBe(112);
    for (let i = 0; i < 60; i++) expect(end(lower.step(FRAME_MS, 12))).toBe(112);
  });

  test('a lower target at rest moves the fog in at once', () => {
    const fog = createFogEase(12);
    fog.setTarget(8);
    expect(end(fog.step(FRAME_MS, 12))).toBe(112);
    fog.setTarget(8);
    expect(fog.step(FRAME_MS, 12)).toBe(8);
  });
});

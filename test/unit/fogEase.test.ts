import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { FILL_SCAN_FRAMES, FOG_EASE_BLOCKS_PER_S, createFogEase, createFogStep, filledRadius } from '../../src/ui/world/fogEase';

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

describe('createFogStep (the page\'s live-RD glue, SP4b spec §5; final review UI-4, UI-5)', () => {
  /** A fog step at the load RD over counted reveal lookups; `hidden` columns are unrevealed, `skipped` marked failed. */
  function rig(loadRd: number, o: { hidden?: ReadonlyArray<readonly [number, number]>; skipped?: ReadonlyArray<readonly [number, number]> } = {}) {
    const hidden = new Set((o.hidden ?? []).map(([x, z]) => colKey(x, z)));
    const skipped = new Set((o.skipped ?? []).map(([x, z]) => colKey(x, z)));
    const r = { lookups: 0, scans: 0 };
    let inScan = false;
    const fog = createFogEase(loadRd);
    const step = createFogStep(fog, { x: 8, z: 8 }, {
      isRevealed: (cx, cz) => {
        r.lookups++;
        if (!inScan) { inScan = true; r.scans++; }
        return !hidden.has(colKey(cx, cz));
      },
      isSkipped: (cx, cz) => skipped.has(colKey(cx, cz)),
    }, loadRd);
    /** One rendered frame; a scan is counted once per frame that looks anything up. */
    const frame = (): number => {
      inScan = false;
      return step.step(FRAME_MS);
    };
    return { r, fog, step, frame };
  }

  test('at the load RD (filled starts there) nothing is scanned and the fog stays put', () => {
    const { r, frame } = rig(8);
    for (let i = 0; i < 100; i++) expect(frame()).toBe(8);
    expect(r.lookups).toBe(0);
  });

  test('a raise scans on the next rendered frame, then every 30 frames while the fog eases, and never once it has arrived', () => {
    const { r, fog, step, frame } = rig(8);
    fog.setTarget(12);
    step.rescan();
    frame();
    expect(r.scans).toBe(1);
    for (let i = 1; i < FILL_SCAN_FRAMES; i++) frame();
    expect(r.scans).toBe(1);
    frame();
    expect(r.scans).toBe(2);
    // 8 → 12 at 32 blocks/s: 2 s, 120 frames; then no scan at all.
    let at = 0;
    for (let i = 0; i < 200; i++) if (frame() === 12 && at === 0) at = r.scans;
    expect(at).toBeGreaterThan(0);
    const scans = r.scans;
    for (let i = 0; i < 300; i++) expect(frame()).toBe(12);
    expect(r.scans).toBe(scans);
  });

  test('rescan on a second raise mid-countdown scans on the next frame, not 30 frames later', () => {
    const { r, fog, step, frame } = rig(8);
    fog.setTarget(10);
    step.rescan();
    frame();
    for (let i = 0; i < 4; i++) frame();
    expect(r.scans).toBe(1);
    fog.setTarget(12);
    step.rescan();
    frame();
    expect(r.scans).toBe(2);
  });

  test('a column skipped after two failures 3 columns away counts as filled: a raise 8 → 12 reaches 12; unrevealed and not skipped, it holds the fog at 8', () => {
    const skipped = rig(8, { hidden: [[3, 0]], skipped: [[3, 0]] });
    skipped.fog.setTarget(12);
    skipped.step.rescan();
    let fogRd = 8;
    for (let i = 0; i < 300; i++) fogRd = skipped.frame();
    expect(fogRd).toBe(12);
    const held = rig(8, { hidden: [[3, 0]] });
    held.fog.setTarget(12);
    held.step.rescan();
    for (let i = 0; i < 300; i++) fogRd = held.frame();
    expect(fogRd).toBe(8);
  });
});

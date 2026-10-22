import { describe, expect, test } from 'vitest';
import { createFpsLimiter } from '../../src/render/fpsLimiter';

type Cap = Parameters<typeof createFpsLimiter>[0];

/** `n` rAF timestamps at `hz` with a deterministic jitter in ±0.3 ms (a small LCG). */
function timestamps(hz: number, n: number): number[] {
  let s = 0x2545f491;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(1000 + (k * 1000) / hz + ((s / 2 ** 32) * 2 - 1) * 0.3);
  }
  return out;
}

/** The rendered frames per second of a limiter at `cap` over 600 ticks at `hz`, and the rendered count. */
function run(cap: Cap, hz: number): { fps: number; rendered: number } {
  const limiter = createFpsLimiter(cap);
  const ts = timestamps(hz, 600);
  let rendered = 0;
  for (const t of ts) if (limiter.tick(t)) rendered++;
  return { fps: (rendered * 1000) / (ts[ts.length - 1]! - ts[0]!), rendered };
}

describe('FPS limiter (SP4a spec §6.8, master §4.17)', () => {
  test('60 Hz, cap 60 renders at least 59.5 fps', () => {
    expect(run(60, 60).fps).toBeGreaterThanOrEqual(59.5);
  });

  test('60 Hz, cap 30 renders 30 ± 0.5 fps', () => {
    expect(Math.abs(run(30, 60).fps - 30)).toBeLessThanOrEqual(0.5);
  });

  test('cap off renders every tick', () => {
    expect(run(0, 60).rendered).toBe(600);
    expect(run(0, 144).rendered).toBe(600);
  });

  test('144 Hz, cap 60 renders 60 ± 0.5 fps', () => {
    expect(Math.abs(run(60, 144).fps - 60)).toBeLessThanOrEqual(0.5);
  });

  test('144 Hz, cap 120 renders 120 ± 0.5 fps (ruling P38)', () => {
    expect(Math.abs(run(120, 144).fps - 120)).toBeLessThanOrEqual(0.5);
  });

  test('setCap switches the cap and restarts the accumulator', () => {
    const limiter = createFpsLimiter(0);
    const ts = timestamps(60, 600);
    let rendered = 0;
    ts.forEach((t, i) => {
      if (i === 300) limiter.setCap(30);
      if (limiter.tick(t) && i >= 300) rendered++;
    });
    // 300 ticks at 60 Hz under cap 30: 150 frames, give or take the first.
    expect(Math.abs(rendered - 150)).toBeLessThanOrEqual(1);
  });

  test('a long pause (hidden tab) does not make the limiter render every tick afterwards', () => {
    const limiter = createFpsLimiter(30);
    const ts = timestamps(60, 300).map((t, i) => (i >= 150 ? t + 5000 : t));
    let rendered = 0;
    ts.forEach((t, i) => {
      if (limiter.tick(t) && i >= 160) rendered++;
    });
    // Ticks 160-299 (140 ticks at 60 Hz) under cap 30: 70 frames, give or take one.
    expect(Math.abs(rendered - 70)).toBeLessThanOrEqual(1);
  });
});

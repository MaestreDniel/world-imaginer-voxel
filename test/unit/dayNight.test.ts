import { describe, expect, test } from 'vitest';
import {
  advanceTime,
  clockHours,
  DAY_LENGTH_MS,
  dayFactor,
  duskFactor,
  OPENING_T,
  phaseOf,
  skyColors,
  skyColorsInto,
  sunDirection,
  sunDirectionInto,
  sunElevationDeg,
  SUN_TILT_DEG,
  TIME_SPEEDS,
} from '../../src/daynight/dayNight';

const RAD = Math.PI / 180;
/** The t in [0, 1) where the sun stands at elevation e on its rising (t < 0.25 or t > 0.75) or setting half. */
const tAt = (eDeg: number, rising: boolean): number => {
  const a = Math.asin(Math.sin(eDeg * RAD) / Math.cos(SUN_TILT_DEG * RAD)) / (2 * Math.PI);
  return rising ? (a + 1) % 1 : 0.5 - a;
};
/** Samples t over one day: every 1/960 plus the exact phase boundaries on both halves. */
const SAMPLES: number[] = [
  ...Array.from({ length: 960 }, (_, i) => i / 960),
  ...[-6, 0, 10].flatMap((e) => [tAt(e, true), tAt(e, false)]),
];

describe('time and the sun (SP4a spec §6.5, D16)', () => {
  test('the constants: 20-minute day, opening at 08:00, 20° tilt, ×1 ×10 ×60 paused', () => {
    expect(DAY_LENGTH_MS).toBe(1_200_000);
    expect(OPENING_T).toBe(1 / 12);
    expect(SUN_TILT_DEG).toBe(20);
    expect(TIME_SPEEDS).toEqual([1, 10, 60, 0]);
  });

  test('the elevation is 0 at t 0 and 0.5, 70 at noon, −70 at midnight and ≈ 28 at the opening', () => {
    expect(sunElevationDeg(0)).toBeCloseTo(0, 9);
    expect(sunElevationDeg(0.5)).toBeCloseTo(0, 9);
    expect(Math.abs(sunElevationDeg(0.25) - 70)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(sunElevationDeg(0.75) + 70)).toBeLessThanOrEqual(1e-9);
    const opening = sunElevationDeg(OPENING_T);
    expect(opening).toBeGreaterThanOrEqual(27.9);
    expect(opening).toBeLessThanOrEqual(28.1);
  });

  test('the sun direction is (cos 2πt, sin 2πt·cos 20°, sin 2πt·sin 20°), a unit vector', () => {
    for (const t of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.9]) {
      const [x, y, z] = sunDirection(t);
      expect(x).toBeCloseTo(Math.cos(2 * Math.PI * t), 12);
      expect(y).toBeCloseTo(Math.sin(2 * Math.PI * t) * Math.cos(20 * RAD), 12);
      expect(z).toBeCloseTo(Math.sin(2 * Math.PI * t) * Math.sin(20 * RAD), 12);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
      expect(sunElevationDeg(t)).toBeCloseTo(Math.asin(y) / RAD, 9);
    }
  });

  test('clockHours: 08:00 at the opening, 12:00 at noon, 06:00 at sunrise', () => {
    expect(clockHours(OPENING_T)).toBeCloseTo(8, 12);
    expect(clockHours(0.25)).toBeCloseTo(12, 12);
    expect(clockHours(0)).toBe(6);
    expect(clockHours(0.75)).toBeCloseTo(0, 12);
    expect(clockHours(0.9)).toBeCloseTo(3.6, 12);
  });
});

describe('phases (SP4a spec §6.5, master §4.9)', () => {
  test('day at e ≥ 10, night at e ≤ −6, dawn while rising and dusk while setting in between', () => {
    for (const t of SAMPLES) {
      const e = sunElevationDeg(t);
      const rising = t < 0.25 || t > 0.75;
      const expected = e >= 10 ? 'day' : e <= -6 ? 'night' : rising ? 'dawn' : 'dusk';
      expect(phaseOf(t), `t ${t}, e ${e}`).toBe(expected);
    }
    expect(phaseOf(0)).toBe('dawn');
    expect(phaseOf(0.25)).toBe('day');
    expect(phaseOf(0.5)).toBe('dusk');
    expect(phaseOf(0.75)).toBe('night');
  });

  test('the dawn window lasts (asin(sin 10°/cos 20°) − asin(sin −6°/cos 20°)) / 2π of a day', () => {
    /** The first t in [lo, hi] where `phaseOf` turns to `to`, by bisection. */
    const edge = (lo: number, hi: number, to: string): number => {
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (phaseOf(mid) === to) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const start = edge(0.9, 0.999999, 'dawn') - 1; // night → dawn, before t 0
    const end = edge(0, 0.1, 'day'); // dawn → day
    const c = Math.cos(20 * RAD);
    const expected = (Math.asin(Math.sin(10 * RAD) / c) - Math.asin(Math.sin(-6 * RAD) / c)) / (2 * Math.PI);
    expect(Math.abs(end - start - expected)).toBeLessThanOrEqual(1e-6);
    // The dusk window mirrors it.
    const duskStart = edge(0.4, 0.5, 'dusk');
    const duskEnd = edge(0.5, 0.6, 'night');
    expect(Math.abs(duskEnd - duskStart - expected)).toBeLessThanOrEqual(1e-6);
  });

  test('dayFactor is 0 at e ≤ −6, 1 at e ≥ 10 and rises in between', () => {
    for (const t of SAMPLES) {
      const e = sunElevationDeg(t);
      const f = dayFactor(t);
      if (e <= -6) expect(f, `t ${t}`).toBe(0);
      else if (e >= 10) expect(f, `t ${t}`).toBe(1);
      else {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
    expect(dayFactor(tAt(2, true))).toBeCloseTo(0.5, 9); // smoothstep's midpoint, e 2
    expect(dayFactor(tAt(2, false))).toBeCloseTo(0.5, 9);
  });

  test('duskFactor is 1 at e 0 and 0 at e ≤ −6 and e ≥ 10', () => {
    expect(duskFactor(0)).toBeCloseTo(1, 12);
    expect(duskFactor(0.5)).toBeCloseTo(1, 12);
    for (const t of SAMPLES) {
      const e = sunElevationDeg(t);
      const f = duskFactor(t);
      if (e <= -6 || e >= 10) expect(f, `t ${t}, e ${e}`).toBe(0);
      else {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
    expect(duskFactor(tAt(-3, true))).toBeCloseTo(0.5, 9); // the rising edge's midpoint
    expect(duskFactor(tAt(5, false))).toBeCloseTo(0.5, 9); // the falling edge's midpoint
  });

  test('skyColors: day zenith and horizon at noon, night at midnight, the warm horizon at e 0', () => {
    const hex = (h: number): number[] => [(h >> 16) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
    const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));
    close(skyColors(0.25).zenith, hex(0x3d78d6));
    close(skyColors(0.25).horizon, hex(0xa8ccf5));
    close(skyColors(0.75).zenith, hex(0x04070f));
    close(skyColors(0.75).horizon, hex(0x0d1526));
    close(skyColors(0.5).horizon, hex(0xe8914d));
  });
});

describe('advanceTime (SP4a spec §6.5)', () => {
  test('wraps into [0, 1), scales by the speed, and speed 0 leaves t unchanged', () => {
    expect(advanceTime(0.99, DAY_LENGTH_MS * 0.02, 1)).toBeCloseTo(0.01, 12);
    expect(advanceTime(0.3, 12_345, 0)).toBe(0.3);
    expect(advanceTime(0.25, DAY_LENGTH_MS / 60, 60)).toBeCloseTo(0.25, 12);
    expect(advanceTime(0, 1000, 10)).toBeCloseTo(10_000 / DAY_LENGTH_MS, 15);
    for (const [t, dt, s] of [[0.5, DAY_LENGTH_MS * 3.7, 1], [0.999999999999, 1e-6, 1], [0, -1, 1]] as const) {
      const r = advanceTime(t, dt, s);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });
});

describe('the allocation-free variants (SP4b spec §3.10)', () => {
  test('skyColorsInto and sunDirectionInto equal skyColors and sunDirection', () => {
    const zenith = new Float64Array(3);
    const horizon = new Float64Array(3);
    const sun = new Float64Array(3);
    for (const t of [0, 1 / 12, 0.25, 0.5, 0.75]) {
      skyColorsInto(t, zenith, horizon);
      const c = skyColors(t);
      expect(Array.from(zenith), `zenith t ${t}`).toEqual([...c.zenith]);
      expect(Array.from(horizon), `horizon t ${t}`).toEqual([...c.horizon]);
      sunDirectionInto(t, sun);
      expect(Array.from(sun), `sun t ${t}`).toEqual(sunDirection(t));
    }
  });
});

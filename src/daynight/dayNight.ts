/**
 * The day/night time model (SP4a spec §6.5, D16; master §4.9). Time t ∈ [0, 1) is the fraction of a day since sunrise:
 * t 0 sunrise (06:00), 0.25 noon (12:00), 0.5 sunset (18:00), 0.75 midnight. The sun moves on a circle tilted 20° from
 * the zenith towards south, so noon stands at elevation 70°. Phases and the day factor come from the elevation alone.
 * Pure: no DOM, no three; the lightmap (`render/lightmap.ts`) and the sky (`render/sky.ts`) read these values.
 */

/** One day at ×1: 20 minutes (master §4.9). */
export const DAY_LENGTH_MS = 1_200_000;
/** The time the world opens at: 08:00, elevation ≈ 28° (SP4a spec §6.5). */
export const OPENING_T = 1 / 12;
/** The sun path's tilt from the zenith, in degrees (noon at 90° − 20° = 70°). */
export const SUN_TILT_DEG = 20;
/** The speeds T cycles through: ×1, ×10, ×60, paused (D16). */
export const TIME_SPEEDS = [1, 10, 60, 0] as const;

export type Phase = 'day' | 'dawn' | 'dusk' | 'night';
/** An sRGB colour, each channel in [0, 1]. */
export type Rgb = readonly [number, number, number];

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const COS_TILT = Math.cos(SUN_TILT_DEG * DEG);
const SIN_TILT = Math.sin(SUN_TILT_DEG * DEG);

/** Phase edges in degrees of elevation (master §4.9): day at or above 10°, night at or below −6°. */
const DAY_FROM = 10;
const NIGHT_TO = -6;

/** t·t·(3 − 2t) with t = (x − lo) / (hi − lo) clamped to [0, 1]; lo < hi. */
const smoothstep = (lo: number, hi: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return u * u * (3 - 2 * u);
};
const mix = (a: number, b: number, f: number): number => a + (b - a) * f;
const mixRgb = (a: Rgb, b: Rgb, f: number): Rgb => [mix(a[0], b[0], f), mix(a[1], b[1], f), mix(a[2], b[2], f)];
const hex = (h: number): Rgb => [(h >> 16) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
/** t wrapped into [0, 1). */
const wrap01 = (t: number): number => {
  const r = t - Math.floor(t);
  return r >= 1 ? 0 : r;
};

/** Sky gradient stops (SP4a spec §6.5): day, night and the dusk horizon. */
const DAY_ZENITH = hex(0x3d78d6);
const DAY_HORIZON = hex(0xa8ccf5);
const NIGHT_ZENITH = hex(0x04070f);
const NIGHT_HORIZON = hex(0x0d1526);
const DUSK_HORIZON = hex(0xe8914d);

/** The unit vector towards the sun at t: (cos 2πt, sin 2πt·cos 20°, sin 2πt·sin 20°), x east, y up, z south. */
export function sunDirection(t: number): [number, number, number] {
  const a = TAU * t;
  const s = Math.sin(a);
  return [Math.cos(a), s * COS_TILT, s * SIN_TILT];
}

/** The sun's elevation above the horizon in degrees: asin(sin 2πt·cos 20°), in [−70, 70]. */
export function sunElevationDeg(t: number): number {
  return Math.asin(Math.sin(TAU * t) * COS_TILT) / DEG;
}

/** Day at e ≥ 10°, night at e ≤ −6°; in between dawn while the sun rises (t < 0.25 or t > 0.75), else dusk. */
export function phaseOf(t: number): Phase {
  const e = sunElevationDeg(t);
  if (e >= DAY_FROM) return 'day';
  if (e <= NIGHT_TO) return 'night';
  const w = wrap01(t);
  return w < 0.25 || w > 0.75 ? 'dawn' : 'dusk';
}

/** smoothstep(−6°, 10°, e): 0 at night, 1 by day. */
export function dayFactor(t: number): number {
  return smoothstep(NIGHT_TO, DAY_FROM, sunElevationDeg(t));
}

/** The dusk bump (SP4a plan): 0 outside (−6°, 10°), rising to 1 at e 0 and falling back to 0 at 10°. */
export function duskFactor(t: number): number {
  const e = sunElevationDeg(t);
  return e <= 0 ? smoothstep(NIGHT_TO, 0, e) : 1 - smoothstep(0, DAY_FROM, e);
}

/**
 * The sky gradient's two stops at t (SP4a plan): the zenith from night to day by the day factor; the horizon from
 * night to day by the day factor, then towards the warm dusk horizon by the dusk bump.
 */
export function skyColors(t: number): { zenith: Rgb; horizon: Rgb } {
  const day = dayFactor(t);
  return {
    zenith: mixRgb(NIGHT_ZENITH, DAY_ZENITH, day),
    horizon: mixRgb(mixRgb(NIGHT_HORIZON, DAY_HORIZON, day), DUSK_HORIZON, duskFactor(t)),
  };
}

/** The clock in hours, [0, 24): (6 + 24t) mod 24. */
export function clockHours(t: number): number {
  const h = (6 + 24 * t) % 24;
  return h < 0 ? h + 24 : h;
}

/** t advanced by dtMs of wall time at `speed` (×1 = one day per `DAY_LENGTH_MS`), wrapped into [0, 1). */
export function advanceTime(t: number, dtMs: number, speed: number): number {
  if (speed === 0) return t;
  return wrap01(t + (dtMs * speed) / DAY_LENGTH_MS);
}

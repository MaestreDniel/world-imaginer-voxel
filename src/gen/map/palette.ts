/** Map colour ramps (SP2a spec §6.2). Pure functions returning 0xRRGGBB; the numeric stops stay private. */

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (a: number, b: number, t: number): number => {
  const r = ((a >>> 16) & 255) + ((((b >>> 16) & 255) - ((a >>> 16) & 255)) * t);
  const g = ((a >>> 8) & 255) + ((((b >>> 8) & 255) - ((a >>> 8) & 255)) * t);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

/** Piecewise-linear ramp over [0, 1] through evenly spaced colours. */
function ramp(stops: readonly number[], t: number): number {
  const u = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  return mix(stops[i]!, stops[i + 1]!, u - i);
}

const COOLWARM = [0x3b4cc0, 0xdddddd, 0xb40426];
const HYPSO = [0x3d7a3a, 0x7fa65a, 0xc8c07a, 0xa0784a, 0x8a8a8a, 0xf4f4f4];
const DEPTH = [0x7ec8e8, 0x2a78c0, 0x0c2a66];
const SEQ = [0x0d0887, 0x7e03a8, 0xcc4778, 0xf89540, 0xf0f921];

/** Diverging map for fields on [−1, 1]. */
export const diverging = (v: number): number => ramp(COOLWARM, (v + 1) / 2);
/** Land by height: sea level (63) to 263. */
export const hypsometric = (y: number): number => ramp(HYPSO, (y - 63) / 200);
/** Water by depth below the surface water level, 0 to 64 blocks. */
export const waterByDepth = (depth: number): number => ramp(DEPTH, depth / 64);
/** Sequential ramp for a value in [lo, hi]. */
export const sequential = (v: number, lo: number, hi: number): number => ramp(SEQ, (v - lo) / (hi - lo));
/** Multiplies each channel by k (shading), clamped to 255. */
export const shade = (rgb: number, k: number): number =>
  (Math.min(255, Math.round(((rgb >>> 16) & 255) * k)) << 16) | (Math.min(255, Math.round(((rgb >>> 8) & 255) * k)) << 8) | Math.min(255, Math.round((rgb & 255) * k));
/** Grey with the luma of rgb. */
export const grey = (rgb: number): number => {
  const l = Math.round(0.299 * ((rgb >>> 16) & 255) + 0.587 * ((rgb >>> 8) & 255) + 0.114 * (rgb & 255));
  return (l << 16) | (l << 8) | l;
};
export const blend = mix;

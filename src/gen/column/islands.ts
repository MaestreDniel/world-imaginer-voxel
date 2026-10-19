/**
 * The island cluster mask (SP3e spec §2.2, D11): with `islands.enabled` (the floating_islands preset),
 * islandMask = smoothstep(lo, hi, u), u = toUniform(z2) of the `islands.noise` instance at the caller's world block
 * coordinates, unscaled and unwarped (as the density and surface noises: `climate.scaleMul` does not zoom the
 * clusters); lo ≥ hi is a step at lo; off, the literal +0. One function for the three writers (the lattice of
 * buildColumnSample, samplePoint and sampleCoarse), so point == bulk (§2.3). m ∈ {+0} ∪ (0, 1], never −0 or NaN.
 */
import { detSmoothstep } from '../../core/detMath';
import { toUniform } from '../../core/noise/cdf';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import { noiseFor, type GenContext } from '../context';

const SMOOTH = detSmoothstep;
const U = toUniform;
const NOISE = noiseFor;

/**
 * The mask at uniform value u: smoothstep(lo, hi, u) capped at 1 when lo < hi, else the step at lo (rivers' `fade`
 * guard: unguarded, lo = hi would give 0/0 = NaN). t·t ≥ +0 and 3 − 2t ≥ 1, so the smoothstep is +0 or positive; a
 * subnormal hi − lo gives t = ±Infinity, which the clamp turns into 0 or 1.
 */
export function islandMaskOfU(u: number, lo: number, hi: number): number {
  if (lo < hi) {
    const s = SMOOTH(lo, hi, u);
    return s > 1 ? 1 : s;
  }
  return u >= lo ? 1 : 0;
}

const MASK = new WeakMap<GenContext, NormalNoiseT>();

function maskNoise(ctx: GenContext): NormalNoiseT {
  let n = MASK.get(ctx);
  if (n === undefined) { n = NOISE(ctx, 'islands.noise'); MASK.set(ctx, n); }
  return n;
}

/** islandMask at world block (x, z) of `ctx` (SP3e spec §2.2): +0 unless `islands.enabled`. */
export function islandMaskAt(ctx: GenContext, x: number, z: number): number {
  const p = ctx.params.islands;
  if (!p.enabled) return 0;
  return islandMaskOfU(U(maskNoise(ctx).z2(x, z)), p.lo, p.hi);
}

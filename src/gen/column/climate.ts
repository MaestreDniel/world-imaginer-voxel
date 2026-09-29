/**
 * Climate at a point (master §3.2, SP2a spec §2.1): divide by scaleMul, shift warp, the extra C and R
 * warps, six NormalNoises, CDF to [−uMax, uMax], and the PV fold.
 */
import { toUniform } from '../../core/noise/cdf';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import { noiseFor, type GenContext } from '../context';

const U = toUniform;
const NOISE = noiseFor;

/** Mutable climate record; the point path allocates one, the batch path reuses one. */
export interface ClimateOut {
  C: number; E: number; W: number; T: number; H: number; R: number; PV: number;
  /** R's NormalNoise value before the CDF, and the scaled, warped coordinates it was sampled at. */
  Rz: number; xr: number; zr: number;
}

export const newClimate = (): ClimateOut => ({ C: 0, E: 0, W: 0, T: 0, H: 0, R: 0, PV: 0, Rz: 0, xr: 0, zr: 0 });

interface ClimateNoises {
  readonly shiftX: NormalNoiseT; readonly shiftZ: NormalNoiseT; readonly cX: NormalNoiseT; readonly cZ: NormalNoiseT;
  readonly rX: NormalNoiseT; readonly rZ: NormalNoiseT;
  readonly C: NormalNoiseT; readonly E: NormalNoiseT; readonly W: NormalNoiseT; readonly T: NormalNoiseT; readonly H: NormalNoiseT; readonly R: NormalNoiseT;
  readonly aShift: number; readonly aC: number; readonly aR: number;
}

const CACHE = new WeakMap<GenContext, ClimateNoises>();

function prepared(ctx: GenContext): ClimateNoises {
  let n = CACHE.get(ctx);
  if (n === undefined) {
    const w = ctx.params.climate.warp;
    n = {
      shiftX: NOISE(ctx, 'climate.warp.shift.noise.x'), shiftZ: NOISE(ctx, 'climate.warp.shift.noise.z'),
      cX: NOISE(ctx, 'climate.warp.C.noise.x'), cZ: NOISE(ctx, 'climate.warp.C.noise.z'),
      rX: NOISE(ctx, 'climate.warp.R.noise.x'), rZ: NOISE(ctx, 'climate.warp.R.noise.z'),
      C: NOISE(ctx, 'climate.C'), E: NOISE(ctx, 'climate.E'), W: NOISE(ctx, 'climate.W'),
      T: NOISE(ctx, 'climate.T'), H: NOISE(ctx, 'climate.H'), R: NOISE(ctx, 'climate.R'),
      aShift: w.shift.amplitude, aC: w.C.amplitude, aR: w.R.amplitude,
    };
    CACHE.set(ctx, n);
  }
  return n;
}

/** PV = 1 − |3|W| − 2|: 1 at |W| = 2/3 (ridges), −1 at W = 0. */
export function pvFold(w: number): number {
  return 1 - Math.abs(3 * Math.abs(w) - 2);
}

/** Writes the climate at world (x, z) into `out`. */
export function sampleClimate(ctx: GenContext, x: number, z: number, out: ClimateOut): ClimateOut {
  const n = prepared(ctx);
  const xs = x / ctx.scale;
  const zs = z / ctx.scale;
  const xw = xs + n.aShift * n.shiftX.z2(xs, zs);
  const zw = zs + n.aShift * n.shiftZ.z2(xs, zs);
  const xc = xw + n.aC * n.cX.z2(xw, zw);
  const zc = zw + n.aC * n.cZ.z2(xw, zw);
  const xr = xw + n.aR * n.rX.z2(xw, zw);
  const zr = zw + n.aR * n.rZ.z2(xw, zw);
  const rz = n.R.z2(xr, zr);
  out.C = U(n.C.z2(xc, zc));
  out.E = U(n.E.z2(xw, zw));
  out.W = U(n.W.z2(xw, zw));
  out.T = U(n.T.z2(xw, zw));
  out.H = U(n.H.z2(xw, zw));
  out.R = U(rz);
  out.PV = pvFold(out.W);
  out.Rz = rz;
  out.xr = xr;
  out.zr = zr;
  return out;
}

/** R's NormalNoise at scaled, R-warped coordinates (rivers' gradient, SP2a spec §2.4). */
export function riverZ(ctx: GenContext, xr: number, zr: number): number {
  return prepared(ctx).R.z2(xr, zr);
}

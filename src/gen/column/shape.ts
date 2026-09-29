/**
 * Shape (master §3.3, SP2a spec §2.2): offset0, sigma0 and jag0 in blocks from the three splines over
 * the climate coordinates [C, E, W, PV, T, H]; sigma and jag are clamped at 0.
 */
import { evalSpline } from '../../core/spline/hermite';
import type { GenContext } from '../context';
import type { ClimateOut } from './climate';

const EVAL = evalSpline;

export interface ShapeOut { offset0: number; sigma0: number; jag0: number }

export const newShape = (): ShapeOut => ({ offset0: 0, sigma0: 0, jag0: 0 });

/** Fills the spline coordinate vector in SP1 slot order. */
export function splineCoords(c: ClimateOut, coords: Float64Array): Float64Array {
  coords[0] = c.C;
  coords[1] = c.E;
  coords[2] = c.W;
  coords[3] = c.PV;
  coords[4] = c.T;
  coords[5] = c.H;
  return coords;
}

export function offsetFrom(ctx: GenContext, c: ClimateOut, coords: Float64Array): number {
  return EVAL(ctx.offset, splineCoords(c, coords));
}

export function sampleShape(ctx: GenContext, c: ClimateOut, coords: Float64Array, out: ShapeOut): ShapeOut {
  splineCoords(c, coords);
  out.offset0 = EVAL(ctx.offset, coords);
  out.sigma0 = Math.max(0, EVAL(ctx.sigma, coords));
  out.jag0 = Math.max(0, EVAL(ctx.jag, coords));
  return out;
}

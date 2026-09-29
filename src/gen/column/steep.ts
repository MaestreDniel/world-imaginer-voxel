/**
 * steep = |∇offset0| by central differences at ±4 blocks (one quart; SP2a spec §2.3). The point path
 * samples the four neighbours; the batch path reads them from its lattice. Both call steepFrom.
 */
import type { GenContext } from '../context';
import { newClimate, sampleClimate } from './climate';
import { offsetFrom } from './shape';

const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const OFFSET = offsetFrom;

/** |(east − west, south − north)| / 8 for offsets at x ± 4 and z ± 4. */
export function steepFrom(east: number, west: number, north: number, south: number): number {
  const gx = (east - west) / 8;
  const gz = (south - north) / 8;
  return Math.sqrt(gx * gx + gz * gz);
}

/** offset0 at world (x, z) (climate plus the offset spline). */
export function offset0At(ctx: GenContext, x: number, z: number, coords: Float64Array): number {
  return OFFSET(ctx, CLIMATE(ctx, x, z, NEW_CLIMATE()), coords);
}

export function steepAt(ctx: GenContext, x: number, z: number, coords: Float64Array): number {
  return steepFrom(offset0At(ctx, x + 4, z, coords), offset0At(ctx, x - 4, z, coords), offset0At(ctx, x, z - 4, coords), offset0At(ctx, x, z + 4, coords));
}

/**
 * The probe (SP3b spec §2.3, master §5.5): the density, or one tap's value, at one voxel through the compiled closures,
 * with no early-outs; `solidAt` (SP6a spec §3.4, D22) the voxel's solidity. The column's ColumnSample comes from the
 * DensityContext's ColumnCache, and its columnFn and positionFn values and evaluated corners are reused while the probes
 * stay in one column.
 */
import { inWindow } from '../../core/coords';
import type { DensityContext } from './context';

const IN_WINDOW = inWindow;

function checkInt(v: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} ${v} is outside [${lo}, ${hi}]`);
}

/**
 * The final density at world voxel (x, y, z) (integers; y ∈ −64 … 319; x and z in the world window), or the value of
 * tap `tap` there (as `tapFn`: an unknown or unreachable tap name throws).
 */
export function probe(dc: DensityContext, x: number, y: number, z: number, tap?: string): number {
  if (!Number.isInteger(x) || !Number.isInteger(z) || !IN_WINDOW(x, z)) throw new RangeError(`probe (x, z) = (${x}, ${z}) is not an integer position in the world window`);
  checkInt(y, -64, 319, 'probe y');
  const cx = x >> 4, cz = z >> 4;
  dc.column(cx, cz);
  const c = dc.compiled;
  return tap === undefined ? c.voxelFn(x - 16 * cx, y, z - 16 * cz) : c.tapFn(tap, x - 16 * cx, y, z - 16 * cz);
}

/**
 * Whether world voxel (x, y, z) is solid (SP6a spec §3.4, D22): the final density there is > 0 (`probe`, whose window and
 * integer checks it shares: a RangeError outside them). The T stage's solidity voxel for voxel above y −64, which T
 * makes bedrock whatever the density.
 */
export function solidAt(dc: DensityContext, x: number, y: number, z: number): boolean {
  return probe(dc, x, y, z) > 0;
}

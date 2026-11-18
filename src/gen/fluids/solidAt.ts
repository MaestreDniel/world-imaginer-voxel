/**
 * The barrier-aware point solidity (SP7a spec D20; Spec correction 4): the voxel T leaves solid once its aquifer step
 * has turned barriers into rock. The density probe's `solidAt` (`gen/density/probe.ts`, SP6a D22: density > 0 and not
 * carved) keeps its name and meaning; whatever compares a probe with T's stored solidity reads this one.
 */
import { caveTagAt } from '../caves/tags';
import type { DensityContext } from '../density/context';
import { solidAt } from '../density/probe';
import { barrierAt, type AquiferInputs } from './aquifer';

const SOLID_AT = solidAt;
const TAG_AT = caveTagAt;
const BARRIER_AT = barrierAt;

/**
 * Whether T leaves world voxel (x, y, z) solid above y −64 (D20): the density probe's solidity (`solidAt`), or a tagged
 * voxel (`caveTagAt` ≠ 0) that the aquifer makes a barrier (`barrierAt`). A pure point function: it reads no column
 * property (no `top`). Integers only, y in −64 … 319, (x, z) in the world window (a RangeError otherwise, as `probe`).
 */
export function terrainSolidAt(inp: AquiferInputs, dc: DensityContext, x: number, y: number, z: number): boolean {
  return SOLID_AT(dc, x, y, z) || (TAG_AT(dc, x, y, z) !== 0 && BARRIER_AT(inp, dc, x, y, z));
}

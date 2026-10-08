/**
 * The surface pass (SP3c spec §1 step 5, §3.4): over one column's solidity and water (the T stage's density phase and
 * water v0) and its per-block surface biome buffer, the whole-column scan (§3.2) and the compiled rule tree with its
 * fast path write the final state of every solid voxel at y −63 … 319 into a column-wide state array (stone becomes
 * its final block). Non-solid voxels and y −64 are never written; solidity is never changed. The T stage and the
 * `surface.column` bench row call this one function. Follows the gen determinism rules.
 */
import type { ColumnSample } from '../column/columnStage';
import type { SurfaceContext } from './context';
import { newSurfaceScan, scanColumn, type SurfaceScan } from './scan';

const SCAN_COLUMN = scanColumn;
const NEW_SCAN = newSurfaceScan;

/** The pass's own scan (one column at a time; overwritten by every call that does not pass its own). */
const PASS_SCAN = NEW_SCAN();

/**
 * Scans column (s.cx, s.cz) with `sc.settings` into `scan` (default: the pass's own) and writes the compiled tree's
 * final state of every solid voxel, fast path taken, to `out` (98,304 entries, index `256·(y + 64) + p`, p = lz·16 +
 * lx; the other entries untouched). `solid` and `water` as `scanColumn` reads them; `biomes` the 256-entry surface
 * biome buffer. Returns the number of voxels whose rules were evaluated. RangeError on wrong array sizes.
 */
export function surfacePass(
  sc: SurfaceContext, s: ColumnSample, solid: Uint8Array, water: Uint8Array, biomes: Uint8Array, out: Uint16Array,
  scan: SurfaceScan = PASS_SCAN,
): number {
  SCAN_COLUMN(scan, sc.settings, s, solid, water, biomes);
  return sc.compiled.fillColumn(scan, out, true);
}

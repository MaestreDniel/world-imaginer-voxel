/**
 * The top-down heightmap predicate (SP3a spec §3.4; SP3e spec D18, moved from `test/unit/terrainStage.test.ts`): the
 * reference the T stage's aux A heightmaps are compared with. `terrainStage.test.ts` (aux A) uses it, and SP3e's
 * `presetHeightmaps` part (spec §5.2) checks the presets' columns with it.
 */
import { fluidType } from '../../src/world/blocks/fluid';
import { AIR, COLLIDE } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';

/** What the scan reads of a column: its block and fluid at a local position (a `ColumnView` is one). */
export type HeightmapView = Pick<ColumnView, 'block' | 'fluid'>;

/**
 * Position (lx, lz) of `view` scanned from y 319 down to −64: `worldSurfaceWG` is one above the highest voxel that is
 * not air or holds a fluid, `oceanFloorWG` one above the highest colliding voxel; −64 when the scan finds none.
 */
export function topDownHeightmaps(view: HeightmapView, lx: number, lz: number): [worldSurfaceWG: number, oceanFloorWG: number] {
  let ws = -64, of = -64;
  for (let y = 319; y >= -64 && (ws === -64 || of === -64); y--) {
    const b = view.block(lx, y, lz);
    if (ws === -64 && (b !== AIR || fluidType(view.fluid(lx, y, lz)) !== 0)) ws = y + 1;
    if (of === -64 && COLLIDE[b] !== 0) of = y + 1;
  }
  return [ws, of];
}

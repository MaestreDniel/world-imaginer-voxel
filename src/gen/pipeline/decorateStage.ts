/**
 * The D skeleton (SP4a spec §3.1, D7; master §3.0, §3.12): the pull model of the decorate stage with an empty feature
 * list.
 * - It iterates the nine source columns of K's 3 × 3 proto (dz outer, dx inner) and, for each, master §3.12's steps
 *   in order, placing nothing; `stop()` is polled before every step and once more after the last (91 polls), so a
 *   stop writes nothing.
 * - Then, for each section, `w.shareFinal(sy, ZERO_LIGHT)`: the final blocks and fluid share the proto slots, and the
 *   all-zero light is uniform and stores no slot (no light change, SP4a spec §2.5).
 * - Then the final heightmaps of aux A (`finalHeightmaps.ts`, §3.2), over the final blocks and fluid, which with zero
 *   features are the proto's. `tintTH` stays 0 (SP8a writes it) and no proto is freed.
 * Settle (SP7), freeze_top_layer (SP8b) and the diff overlay (SP5a) are its later steps. Never commits: the caller
 * does (`fillColumnD`, `workers/worldJobs.ts`). Follows the gen determinism rules.
 */
import type { ColumnView as ColumnViewT, ColumnWriter as ColumnWriterT, NeighborhoodReader as NeighborhoodReaderT } from '../../world/store/api';
import type { GenContext } from '../context';
import { writeFinalHeightmaps } from './finalHeightmaps';

const WRITE_HEIGHTMAPS = writeFinalHeightmaps;

/** Master §3.12's steps, in order; each places nothing until its features arrive (SP6 onwards). */
const STEPS: readonly string[] = [
  'raw_generation', 'lakes', 'local_modifications', 'underground_structures', 'surface_structures',
  'underground_ores', 'underground_decoration', 'fluid_springs', 'vegetal_decoration', 'top_layer_modification',
];

/** The final light the skeleton shares with: all zero, which `storeBytes` keeps as a uniform entry. */
const ZERO_LIGHT = new Uint8Array(4096);

/** The proto entries of the centre column's 24 sections, read once per run (a section view or its uniform value). */
const SECTION_BLOCKS: Array<Uint16Array | number> = [];
const SECTION_FLUID: Array<Uint8Array | number> = [];

const blockAt = (lx: number, y: number, lz: number): number => {
  const yy = y + 64;
  const b = SECTION_BLOCKS[yy >> 4]!;
  return typeof b === 'number' ? b : b[((yy & 15) << 8) | (lz << 4) | lx]!;
};

const fluidAt = (lx: number, y: number, lz: number): number => {
  const yy = y + 64;
  const f = SECTION_FLUID[yy >> 4]!;
  return typeof f === 'number' ? f : f[((yy & 15) << 8) | (lz << 4) | lx]!;
};

/** The source column (cx + dx, cz + dz) at ≥ Proto; the coordinator runs D only once the whole 3 × 3 is there. */
function source(nb: NeighborhoodReaderT, dx: number, dz: number): ColumnViewT {
  const v = nb.proto(dx, dz);
  if (v === null) throw new Error(`decorateStage: source column (${nb.cx + dx}, ${nb.cz + dz}) is not at Proto`);
  return v;
}

/**
 * Decorates column K = (nb.cx, nb.cz) through `w` (a writer of K reopened at Proto): the steps over the 3 × 3, the
 * shares and the final heightmaps. False, with nothing written, as soon as `stop()` returns true.
 */
export function decorateStage(ctx: GenContext, nb: NeighborhoodReaderT, w: ColumnWriterT, stop: () => boolean): boolean {
  void ctx; // The features' placements read the seed and params (master §3.12); none exist yet.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      source(nb, dx, dz);
      for (let i = 0; i < STEPS.length; i++) {
        if (stop()) return false;
        // Master §3.12: every feature of step STEPS[i] of the biomes present in this source column; none yet.
      }
    }
  }
  if (stop()) return false;
  const k = source(nb, 0, 0);
  for (let sy = 0; sy < 24; sy++) {
    w.shareFinal(sy, ZERO_LIGHT);
    SECTION_BLOCKS[sy] = k.sectionBlocks(sy);
    SECTION_FLUID[sy] = k.sectionFluid(sy);
  }
  try {
    WRITE_HEIGHTMAPS(blockAt, fluidAt, w.aux());
  } finally {
    // Holds no slot view past the run.
    SECTION_BLOCKS.length = 0;
    SECTION_FLUID.length = 0;
  }
  return true;
}

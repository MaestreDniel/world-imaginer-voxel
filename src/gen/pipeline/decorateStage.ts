/**
 * The D skeleton (SP4a spec §3.1, D7; master §3.0, §3.12): the pull model of the decorate stage with an empty feature
 * list.
 * - It iterates the nine source columns of K's 3 × 3 proto (dz outer, dx inner) and, for each, master §3.12's steps
 *   in order, placing nothing; `stop()` is polled before every step and once more after the last (91 polls), so a
 *   stop writes nothing.
 * - Then, for each section, `w.shareFinal(sy, ZERO_LIGHT)`: the final blocks and fluid share the proto slots, and the
 *   all-zero light is uniform and stores no slot (no light change, SP4a spec §2.5).
 * - SP5a (spec §2.5, D21): with a diff (the column's edit entries, `ColumnDiff`), each section holding entries is
 *   rebuilt from the proto plus the entries into this module's scratch and written with `w.replaceBlocks`
 *   (copy-on-write, so the proto stays generated; no light written), and `w.setDiffFlag()` marks the column for L's
 *   scan gate (D23). Without a diff, or with an empty one, nothing more is written.
 * - Then the final heightmaps of aux A (`finalHeightmaps.ts`, §3.2), over the final blocks and fluid: the proto's
 *   sections, and the rebuilt scratch for the overlaid ones (`nb.final` is null below Decorated). `tintTH` stays 0
 *   (SP8a writes it) and no proto is freed.
 * Settle (SP7) and freeze_top_layer (SP8b) are its later steps. Never commits: the caller does (`fillColumnD`,
 * `workers/worldJobs.ts`). Follows the gen determinism rules.
 */
import type { ColumnDiff as ColumnDiffT, ColumnView as ColumnViewT, ColumnWriter as ColumnWriterT, NeighborhoodReader as NeighborhoodReaderT } from '../../world/store/api';
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

/**
 * The centre column's 24 sections as the heightmaps read them, set once per run: the proto's entry (a section view or
 * its uniform value), or the overlay's rebuilt scratch.
 */
const SECTION_BLOCKS: Array<Uint16Array | number> = [];
const SECTION_FLUID: Array<Uint8Array | number> = [];

/** The overlay's rebuilt sections (SP5a), one scratch pair per section index, allocated on first use and reused. */
const REBUILT_BLOCKS: Uint16Array[] = [];
const REBUILT_FLUID: Uint8Array[] = [];
/** 1 for each section the current run's diff touches. */
const TOUCHED = new Uint8Array(24);

/**
 * Rebuilds every section of `d` from the proto `k` plus the entries into the scratch, marking it in TOUCHED; entries in
 * any order, a later entry of the same voxel winning. Returns whether any section was rebuilt.
 */
function rebuild(k: ColumnViewT, d: ColumnDiffT): boolean {
  const { sy: dsy, idx: didx, value: dval } = d;
  TOUCHED.fill(0);
  for (let e = 0; e < dsy.length; e++) {
    const sy = dsy[e]!;
    if (TOUCHED[sy] === 0) {
      TOUCHED[sy] = 1;
      const b = (REBUILT_BLOCKS[sy] ??= new Uint16Array(4096));
      const f = (REBUILT_FLUID[sy] ??= new Uint8Array(4096));
      const pb = k.sectionBlocks(sy);
      const pf = k.sectionFluid(sy);
      if (typeof pb === 'number') b.fill(pb);
      else b.set(pb);
      if (typeof pf === 'number') f.fill(pf);
      else f.set(pf);
    }
    const v = dval[e]!;
    REBUILT_BLOCKS[sy]![didx[e]!] = v >>> 8;
    REBUILT_FLUID[sy]![didx[e]!] = v & 255;
  }
  return dsy.length > 0;
}

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
 * shares, the overlay of `diff` (SP5a; null, the default, overlays nothing) and the final heightmaps. False, with
 * nothing written, as soon as `stop()` returns true.
 */
export function decorateStage(ctx: GenContext, nb: NeighborhoodReaderT, w: ColumnWriterT, stop: () => boolean, diff: ColumnDiffT | null = null): boolean {
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
    if (diff !== null && rebuild(k, diff)) {
      for (let sy = 0; sy < 24; sy++) {
        if (TOUCHED[sy] === 0) continue;
        const b = REBUILT_BLOCKS[sy]!;
        const f = REBUILT_FLUID[sy]!;
        w.replaceBlocks(sy, b, f);
        SECTION_BLOCKS[sy] = b;
        SECTION_FLUID[sy] = f;
      }
      w.setDiffFlag();
    }
    WRITE_HEIGHTMAPS(blockAt, fluidAt, w.aux());
  } finally {
    // Holds no slot view past the run.
    SECTION_BLOCKS.length = 0;
    SECTION_FLUID.length = 0;
  }
  return true;
}

/**
 * The D stage (SP4a spec §3.1, D7; master §3.0, §3.12): the pull model of the decorate stage, its feature list empty,
 * and SP7a's gen-time settle at step 2 (the SP7a spec §4.2, D22, D23).
 * - It iterates the nine source columns of K's 3 × 3 proto (dz outer, dx inner) and, for each, master §3.12's steps
 *   in order, placing nothing (`fluid_springs` too: springs are proto sources, placed by T, D21); `stop()` is polled
 *   before every step and once more after the last (91 polls).
 * - Step 2, settle (§4.2): the seeds are the in-column seeds of each source column's sections that its aux B
 *   `seedSections` names (rescanned with `isInColumnSeed`; every section when a column has no aux B), plus the
 *   cross-column seeds of the 12 boundaries between the 3 × 3's columns (a fluid voxel beside a seed target across the
 *   boundary, `isSeedTarget`), section pairs whose fluid is uniform on both sides with nothing to tell apart skipped;
 *   every seed goes to `settleWindow` (its cap skip drops the far ones, rulings P17) over a `SettleSource` reading the
 *   nine proto views' sections (no region copy), with K as the box; `stop()` is polled inside it once per 1,024 visits.
 *   K's changed voxels land in a per-section scratch over the proto fluid. A stop anywhere writes nothing.
 * - The writes: `w.clearGeneratedFluid()` (a stopped earlier D's layer released), then for each section
 *   `w.shareFinal(sy, ZERO_LIGHT)` (the final blocks, fluid and cave share the proto slots; the all-zero light is
 *   uniform and stores no slot, SP4a spec §2.5), then for each section the settle changed `w.replaceFluid` (copy-on-
 *   write: blocks and cave stay shared) and `w.setGeneratedFluid` (the layer references the settled entry). An
 *   unchanged section stays shared and carries no bit 6, since the proto carries none (§1.7); bit 6 in the final set
 *   marks only truncated fronts and contacts (§4.1).
 * - SP5a (spec §2.5, D21), step 5 on the settled output: with a diff (the column's edit entries, `ColumnDiff`), each
 *   section holding entries is rebuilt from the settled section (the proto's where the settle changed nothing) plus the
 *   entries into this module's scratch and written with `w.replaceBlocks` (copy-on-write, so the proto and the layer
 *   keep their slots; no light written). Without a diff, or with an empty one, nothing more is written.
 *   `w.setDiffFlag()` marks the column for L's scan gate (D23) only when an entry writes a state that emits light (SP5b,
 *   lever 18f): generated terrain holds no emitter, so another overlay gives the scan nothing to find, and lava opens it
 *   by itself (`lightRegion`'s `anyLava`). A later D overlays the whole diff again, so a saved emitter is flagged again;
 *   the sim flags its own edits.
 * - Step 6, the final heightmaps of aux A (`finalHeightmaps.ts`, §3.2), over the final blocks and fluid: the proto's
 *   sections, the settled ones and the overlay's rebuilt ones (`nb.final` is null below Decorated), so WORLD_SURFACE
 *   and MOTION_BLOCKING count the waterfalls. `tintTH` stays 0 (SP8a writes it) and no proto is freed.
 * `decorateStatsInto` is a test and bench hook (the last run's visits, seeds and changed sections). freeze_top_layer
 * (SP8b) is a later step. Never commits: the caller does (`fillColumnD`, `metrics/region.ts`). Follows the gen
 * determinism rules.
 */
import { MIN_Y } from '../../core/constants';
import type { ColumnDiff as ColumnDiffT, ColumnView as ColumnViewT, ColumnWriter as ColumnWriterT, NeighborhoodReader as NeighborhoodReaderT } from '../../world/store/api';
import { NO_FLUID } from '../../world/blocks/fluid';
import { isPassable } from '../../world/blocks/fluidRules';
import { EMIT } from '../../world/blocks/index';
import type { GenContext } from '../context';
import { createSettleScratch, isInColumnSeed, isSeedTarget, settleWindow, type SeedColumn, type SettleSink, type SettleSource } from '../fluids/settle';
import { writeFinalHeightmaps } from './finalHeightmaps';

const WRITE_HEIGHTMAPS = writeFinalHeightmaps;
const EMITS = EMIT;
const Y_MIN = MIN_Y;
const DRY = NO_FLUID;
const PASSABLE = isPassable;
const SEED = isInColumnSeed;
const TARGET = isSeedTarget;
const SETTLE = settleWindow;
const CREATE_SCRATCH = createSettleScratch;

/** Master §3.12's steps, in order; each places nothing until its features arrive (SP8b onwards). */
const STEPS: readonly string[] = [
  'raw_generation', 'lakes', 'local_modifications', 'underground_structures', 'surface_structures',
  'underground_ores', 'underground_decoration', 'fluid_springs', 'vegetal_decoration', 'top_layer_modification',
];

/** The final light D shares with: all zero, which `storeBytes` keeps as a uniform entry. */
const ZERO_LIGHT = new Uint8Array(4096);
/** Every section of a column, for a source column without aux B. */
const ALL_SECTIONS = 0xffffff;

/**
 * The centre column's 24 sections as the overlay and the heightmaps read them, set once per run: the proto's entry (a
 * section view or its uniform value), the settled scratch, or the overlay's rebuilt scratch.
 */
const SECTION_BLOCKS: Array<Uint16Array | number> = [];
const SECTION_FLUID: Array<Uint8Array | number> = [];

/** The overlay's rebuilt sections (SP5a), one scratch pair per section index, allocated on first use and reused. */
const REBUILT_BLOCKS: Uint16Array[] = [];
const REBUILT_FLUID: Uint8Array[] = [];
/** 1 for each section the current run's diff touches. */
const TOUCHED = new Uint8Array(24);
/** Whether the current run's diff writes a state that emits light (set by `rebuild`). */
let emitting = false;

/** The settle's changed sections of K: one scratch per section index (the proto's fluid plus the settled bytes). */
const SETTLED: Uint8Array[] = [];
/** 1 for each section of K the current run's settle changed. */
const CHANGED = new Uint8Array(24);

/** The 3 × 3's sections, at (dz + 1)·3 + (dx + 1) for column and then ·24 + sy, set once per run. */
const SRC_BLOCKS: Array<Uint16Array | number> = [];
const SRC_FLUID: Array<Uint8Array | number> = [];
const SRC_CAVE: Array<Uint8Array | number> = [];

/** The settle's scratch (one per worker), its seeds (packed window keys, grown by doubling) and the last run's stats. */
const SCRATCH = CREATE_SCRATCH();
let seeds = new Int32Array(4096);
let nSeeds = 0;
const BOX = new Int32Array(4);
const STATS = new Int32Array(3);

/** The window's world origin and K's, set once per run. */
let wx0 = 0;
let wz0 = 0;
let kx0 = 0;
let kz0 = 0;

/** The section entry `e` at voxel index `i` (a view or a uniform value). */
const at16 = (e: Uint16Array | number, i: number): number => (typeof e === 'number' ? e : e[i]!);
const at8 = (e: Uint8Array | number, i: number): number => (typeof e === 'number' ? e : e[i]!);

/** The proto window over the nine views (SP7a spec §4.2): x0 ≤ x < x0 + 48, z0 ≤ z < z0 + 48, read section by section. */
const SOURCE: SettleSource & { x0: number; z0: number; x1: number; z1: number } = {
  x0: 0,
  z0: 0,
  x1: 0,
  z1: 0,
  block(x, y, z) {
    const u = x - wx0;
    const v = z - wz0;
    const yy = y - Y_MIN;
    return at16(SRC_BLOCKS[((v >> 4) * 3 + (u >> 4)) * 24 + (yy >> 4)]!, ((yy & 15) << 8) | ((v & 15) << 4) | (u & 15));
  },
  fluid(x, y, z) {
    const u = x - wx0;
    const v = z - wz0;
    const yy = y - Y_MIN;
    return at8(SRC_FLUID[((v >> 4) * 3 + (u >> 4)) * 24 + (yy >> 4)]!, ((yy & 15) << 8) | ((v & 15) << 4) | (u & 15));
  },
  cave(x, y, z) {
    const u = x - wx0;
    const v = z - wz0;
    const yy = y - Y_MIN;
    return at8(SRC_CAVE[((v >> 4) * 3 + (u >> 4)) * 24 + (yy >> 4)]!, ((yy & 15) << 8) | ((v & 15) << 4) | (u & 15));
  },
};

/** One source column of the 3 × 3 (`col` = (dz + 1)·3 + dx + 1) as §1.7's seed test reads it. */
const COLUMN: SeedColumn & { col: number } = {
  col: 0,
  passable(lx, y, lz) {
    const yy = y - Y_MIN;
    return PASSABLE(at16(SRC_BLOCKS[this.col * 24 + (yy >> 4)]!, ((yy & 15) << 8) | (lz << 4) | lx));
  },
  fluid(lx, y, lz) {
    const yy = y - Y_MIN;
    return at8(SRC_FLUID[this.col * 24 + (yy >> 4)]!, ((yy & 15) << 8) | (lz << 4) | lx);
  },
};
/** The other side of a boundary, as `COLUMN`. */
const ACROSS: SeedColumn & { col: number } = { col: 0, passable: COLUMN.passable, fluid: COLUMN.fluid };

/** Appends the seed at the window's world voxel (x, y, z), packed as `settleWindow` reads it (W = 48). */
function addSeed(x: number, y: number, z: number): void {
  if (nSeeds === seeds.length) {
    const grown = new Int32Array(seeds.length * 2);
    grown.set(seeds);
    seeds = grown;
  }
  seeds[nSeeds++] = ((y - Y_MIN) * 48 + (z - wz0)) * 48 + (x - wx0);
}

/** The in-column seeds of source column `col` in the sections `mask` names (§1.7). */
function columnSeeds(col: number, mask: number): void {
  COLUMN.col = col;
  const ox = wx0 + 16 * (col % 3);
  const oz = wz0 + 16 * ((col / 3) | 0);
  for (let sy = 0; sy < 24; sy++) {
    if (((mask >>> sy) & 1) === 0 || SRC_FLUID[col * 24 + sy] === DRY) continue;
    for (let i = 0; i < 4096; i++) {
      const lx = i & 15;
      const lz = (i >> 4) & 15;
      const y = Y_MIN + 16 * sy + (i >> 8);
      if (SEED(COLUMN, lx, y, lz)) addSeed(ox + lx, y, oz + lz);
    }
  }
}

/**
 * The cross-column seeds of the boundary between source columns `a` and `b` (`b` the +x neighbour of `a` when `alongX`,
 * else its +z neighbour): a fluid voxel on one side beside a seed target on the other (§4.2). A section pair whose
 * fluid is uniform on both sides, both dry or both fluid, holds no seed and is skipped.
 */
function boundarySeeds(a: number, b: number, alongX: boolean): void {
  const ax = wx0 + 16 * (a % 3);
  const az = wz0 + 16 * ((a / 3) | 0);
  for (let sy = 0; sy < 24; sy++) {
    const fa = SRC_FLUID[a * 24 + sy]!;
    const fb = SRC_FLUID[b * 24 + sy]!;
    if (typeof fa === 'number' && typeof fb === 'number' && (fa === DRY) === (fb === DRY)) continue;
    for (let ly = 0; ly < 16; ly++) {
      const y = Y_MIN + 16 * sy + ly;
      for (let t = 0; t < 16; t++) {
        // The voxel of `a` on the boundary and its neighbour in `b`.
        const alx = alongX ? 15 : t;
        const alz = alongX ? t : 15;
        const blx = alongX ? 0 : t;
        const blz = alongX ? t : 0;
        COLUMN.col = a;
        ACROSS.col = b;
        if (COLUMN.fluid(alx, y, alz) !== DRY && TARGET(ACROSS, blx, y, blz)) addSeed(ax + alx, y, az + alz);
        if (ACROSS.fluid(blx, y, blz) !== DRY && TARGET(COLUMN, alx, y, alz)) {
          addSeed(ax + (alongX ? 16 : t), y, az + (alongX ? t : 16));
        }
      }
    }
  }
}

/** Receives K's settled voxels (after convergence), each into its section's scratch over the proto's fluid. */
const SINK: SettleSink = {
  set(x, y, z, byte) {
    const yy = y - Y_MIN;
    const sy = yy >> 4;
    if (CHANGED[sy] === 0) {
      CHANGED[sy] = 1;
      const f = (SETTLED[sy] ??= new Uint8Array(4096));
      const pf = SRC_FLUID[4 * 24 + sy]!;
      if (typeof pf === 'number') f.fill(pf);
      else f.set(pf);
    }
    SETTLED[sy]![((yy & 15) << 8) | ((z - kz0) << 4) | (x - kx0)] = byte;
  },
};

/**
 * Rebuilds every section of `d` from K's settled sections (`SECTION_BLOCKS`, `SECTION_FLUID`) plus the entries into
 * the scratch, marking it in TOUCHED and setting `emitting` when an entry's state emits; entries in any order, a later
 * entry of the same voxel winning. Returns whether any section was rebuilt.
 */
function rebuild(d: ColumnDiffT): boolean {
  const { sy: dsy, idx: didx, value: dval } = d;
  TOUCHED.fill(0);
  emitting = false;
  for (let e = 0; e < dsy.length; e++) {
    const sy = dsy[e]!;
    if (TOUCHED[sy] === 0) {
      TOUCHED[sy] = 1;
      const b = (REBUILT_BLOCKS[sy] ??= new Uint16Array(4096));
      const f = (REBUILT_FLUID[sy] ??= new Uint8Array(4096));
      const pb = SECTION_BLOCKS[sy]!;
      const pf = SECTION_FLUID[sy]!;
      if (typeof pb === 'number') b.fill(pb);
      else b.set(pb);
      if (typeof pf === 'number') f.fill(pf);
      else f.set(pf);
    }
    const v = dval[e]!;
    REBUILT_BLOCKS[sy]![didx[e]!] = v >>> 8;
    REBUILT_FLUID[sy]![didx[e]!] = v & 255;
    if (EMITS[v >>> 8]! > 0) emitting = true;
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
 * Step 2, the settle (SP7a spec §4.2): the 3 × 3's sections, the seeds, then `settleWindow` with K as the box into
 * SETTLED/CHANGED. False when `stop()` returned true (nothing written anywhere). Records the stats.
 */
function settle(nb: NeighborhoodReaderT, stop: () => boolean): boolean {
  wx0 = 16 * (nb.cx - 1);
  wz0 = 16 * (nb.cz - 1);
  kx0 = wx0 + 16;
  kz0 = wz0 + 16;
  SOURCE.x0 = wx0;
  SOURCE.z0 = wz0;
  SOURCE.x1 = wx0 + 48;
  SOURCE.z1 = wz0 + 48;
  nSeeds = 0;
  CHANGED.fill(0);
  for (let col = 0; col < 9; col++) {
    const v = source(nb, (col % 3) - 1, ((col / 3) | 0) - 1);
    for (let sy = 0; sy < 24; sy++) {
      SRC_BLOCKS[col * 24 + sy] = v.sectionBlocks(sy);
      SRC_FLUID[col * 24 + sy] = v.sectionFluid(sy);
      SRC_CAVE[col * 24 + sy] = v.sectionCave(sy);
    }
  }
  for (let col = 0; col < 9; col++) {
    const b = source(nb, (col % 3) - 1, ((col / 3) | 0) - 1).auxB();
    columnSeeds(col, b === null ? ALL_SECTIONS : b.seedSections[0]!);
  }
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < 2; k++) {
      boundarySeeds(row * 3 + k, row * 3 + k + 1, true);
      boundarySeeds(k * 3 + row, (k + 1) * 3 + row, false);
    }
  }
  BOX[0] = kx0;
  BOX[1] = kz0;
  BOX[2] = kx0 + 16;
  BOX[3] = kz0 + 16;
  const visits = SETTLE(SOURCE, seeds, nSeeds, BOX, SINK, SCRATCH, stop);
  if (visits < 0) return false;
  let changed = 0;
  for (let sy = 0; sy < 24; sy++) changed += CHANGED[sy]!;
  STATS[0] = visits;
  STATS[1] = nSeeds;
  STATS[2] = changed;
  return true;
}

/**
 * Test and bench hook: the last completed run's [visits, seeds, changedSections] into `out[0 … 2]` (the settle's pops,
 * the seeds it was given, K's sections it changed).
 */
export function decorateStatsInto(out: Int32Array): void {
  out[0] = STATS[0]!;
  out[1] = STATS[1]!;
  out[2] = STATS[2]!;
}

/**
 * Decorates column K = (nb.cx, nb.cz) through `w` (a writer of K reopened at Proto): the steps over the 3 × 3, the
 * settle, the shares and the settled sections with their generated-fluid layer, the overlay of `diff` (SP5a; null, the
 * default, overlays nothing) and the final heightmaps. False, with nothing written, as soon as `stop()` returns true.
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
  try {
    if (!settle(nb, stop)) return false;
    const k = source(nb, 0, 0);
    w.clearGeneratedFluid();
    for (let sy = 0; sy < 24; sy++) {
      w.shareFinal(sy, ZERO_LIGHT);
      SECTION_BLOCKS[sy] = k.sectionBlocks(sy);
      SECTION_FLUID[sy] = k.sectionFluid(sy);
    }
    for (let sy = 0; sy < 24; sy++) {
      if (CHANGED[sy] === 0) continue;
      w.replaceFluid(sy, SETTLED[sy]!);
      w.setGeneratedFluid(sy);
      SECTION_FLUID[sy] = SETTLED[sy]!;
    }
    if (diff !== null && rebuild(diff)) {
      for (let sy = 0; sy < 24; sy++) {
        if (TOUCHED[sy] === 0) continue;
        const b = REBUILT_BLOCKS[sy]!;
        const f = REBUILT_FLUID[sy]!;
        w.replaceBlocks(sy, b, f);
        SECTION_BLOCKS[sy] = b;
        SECTION_FLUID[sy] = f;
      }
      if (emitting) w.setDiffFlag();
    }
    WRITE_HEIGHTMAPS(blockAt, fluidAt, w.aux());
  } finally {
    // Holds no slot view past the run.
    SECTION_BLOCKS.length = 0;
    SECTION_FLUID.length = 0;
    SRC_BLOCKS.length = 0;
    SRC_FLUID.length = 0;
    SRC_CAVE.length = 0;
  }
  return true;
}

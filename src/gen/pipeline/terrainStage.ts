/**
 * The T stage (SP3b spec §4, SP3c spec §1): fills a column's proto set with the surfaced density terrain, through the
 * store API.
 * - Density phase: the column's ColumnSample, then `fillDensityColumn` (columnFn, positionFn, then the 48 cell layers
 *   bottom up with bounds and early-outs) into a column-wide solidity scratch; `stop()` is polled before every 8 cell
 *   layers (6 polls). No section is written in this phase: the aquifer's barriers change the solidity later.
 * - The carve (SP6a spec §2.4, §3.1): each position's density top from the fill's solidity (`densityTopColumn`), a
 *   `stop()` poll (the 7th), then `carveColumn` over the carver window's paths (`carverCacheOf(ctx)`): the voxels it
 *   carves become air in the solidity scratch and take their carver kind in the tag scratch (§3.2 step 4).
 * - The cave tag (SP6a spec §3.1-§3.2): `tagColumn` right after the carve, from the fill's per-cell record of the cells
 *   whose corners (or voxels) it evaluated, through the compiled tap readers, into the tag scratch at the density air
 *   the carve did not tag (the noise kinds and 9; 0 for rock, sky and surface air), with the kinds its fill already
 *   found (`PreTags`, the fill's hooks, Task 31p: the same tags, fewer taps read).
 * - The cave biome (SP6b spec §1, §2.1, D16-D17): right after the tag, the column's picker pass (`fillCaveColumnPass` on
 *   `cavePickerOf(ctx)`, its (16 + 2J)² positions), then at every tagged voxel (kind ≠ 0) the byte becomes
 *   `kind | caveBiomeOfPass(…) << 4`; untagged voxels keep 0. The aquifer runs after it, so a tagged voxel that holds
 *   fluid keeps its kind and biome (SP7a O31).
 * - The aquifer step (SP7a spec §1.7, D17-D20; replaces SP3b's water v0): `aquiferColumn` on `aquiferOf(ctx)` over the
 *   carved solidity and the cave bytes: an untagged non-solid voxel (the terrain's own air: the sky, overhangs, the gap
 *   under a floating island) takes a water source iff y ≤ ⌊surfaceWaterLevel⌋ at its nearest quart corner (D19's
 *   sky-open water, whatever lies above it); a tagged one the aquifer's voxel rule (water or lava at or below its
 *   cell's level, air above); a barrier becomes solid with its cave byte cleared (D20). It writes the column-wide fluid
 *   and water scratches and each position's highest fluid voxel. Then `top`, the y of the highest solid voxel per
 *   position (−64 when there is none above bedrock), from the solidity with its barriers (`columnTops`). A position
 *   whose own level is −∞ stays dry beside a neighbour's water (the "water wall", settled in D, SP7a §4).
 * - The biomes and the surface pass see the carved solidity with its barriers and the aquifer's water, so the scan skins
 *   the carved column: a ravine floor open to the sky is the sky run (the biome's top), a cave floor a lower run (stone
 *   or deepslate, never grass), a barrier rock, and rule 4 sees cave water.
 * - The per-block surface biome (`readBiome`), computed once into a 256-entry buffer for the surface pass and aux A.
 * - Surface pass (SP3c §3, `surfacePass`): after a `stop()` poll (the 8th), the whole-column scan (with the cave bytes
 *   and the picker's pass, SP6b spec §3.1) and the compiled rules (fast path included) give every solid voxel at
 *   y −63 … 319 its final state in a column-wide state scratch.
 * - Springs (SP7a spec §3, D17, D21): after the surface pass, `springsColumn` over the column's arrays as they stand
 *   (the solidity, the states, the cave bytes, the aquifer's fluid and `top`) with the springs' own point probes
 *   (`springProbesOf`) for the voxels outside the column; each accepted spring becomes air plus a source (water; lava
 *   for the lava kind) with cave byte 0 in the solidity and fluid scratches, so the voxels around it keep the skin of a
 *   solid run and the seed sections see it. `top` and the heightmaps are unchanged (a spring lies at or below `top` − 2).
 * - Seed sections (SP7a spec §1.7): after the springs step (so springs seed too), `seedSectionsOf` over the solidity
 *   and the fluid scratch, the sections holding an in-column seed, for aux B (T writes no bit in the fluid byte: the
 *   proto carries no bit 6).
 * - Fill: y = −64 bedrock; a solid voxel its surface state; anything else air (with the aquifer's or a spring's fluid
 *   byte).
 * - Sections 0 … 23 go to `setProto` in order with their cave tags (each channel uniform or dense), `stop()` before each
 *   (24 polls). On a
 *   true `stop()` in any phase the stage returns false at once, without aux.
 * - Aux A: `worldSurfaceWG`, `oceanFloorWG` (SP3a §3.4 predicates) and `surfaceBiome` (the step's biome buffer):
 *   `oceanFloorWG` = top + 1, `worldSurfaceWG` = max(top, the position's highest fluid voxel) + 1 (D19: a tagged voxel
 *   above `top` can hold aquifer water, so the maximum is tracked, not proved).
 * - Aux B: `surfaceBiomeQ[qz·4 + qx]` is the 2D biome of lattice point (qx, qz), qx, qz ∈ 0 … 3, before the zoom;
 *   `caveBiomeQ[(qy·4 + qz)·4 + qx]`, qy = (y + 64) >> 2, is 0 for a quart with no tagged voxel, else 1 + the cave
 *   biome most of its tagged voxels carry, a tie to the lower id (SP6b spec §2.2; wet tagged voxels count, barriers,
 *   whose tag the aquifer cleared, do not); `seedSections[0]` the seed sections' mask.
 * The stage uses the SurfaceContext of its GenContext (`surfaceContextOf`, memoised), which holds the DensityContext.
 * Follows the gen determinism rules.
 * `terrainDensityDebug` is a test hook (SP3b §2.3, DT2): the same density phase, recording the bulk-evaluated values.
 * `terrainSurfaceDebug` is another (SP3c §5.2, DT2's `surfaceReference`): the same phases up to the surface pass (the
 * carve, the tag, the cave-biome step and the aquifer step included), which scans into the caller's scan context.
 * `terrainSpringsDebug` is a third (SP7a §3, the springs' tests and U2's mountain witness): the same phases up to the
 * springs step, the column's accepted springs into the caller's list.
 * `terrainAquiferDebug` is a fourth (SP7a §13.5, the bench's `aquifer.column`): the same phases before the aquifer step,
 * handing the step's inputs (the sample, the cave-biome pass, the carved solidity and the cave bytes) to the caller.
 */
import { MIN_Y } from '../../core/constants';
import { LAVA_SOURCE, WATER_SOURCE } from '../../world/blocks/fluid';
import { AIR, BEDROCK } from '../../world/blocks/index';
import type { TerrainWriter } from '../../world/store/api';
import {
  caveBiomeOfPass, cavePickerOf, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs,
} from '../biomes/cavePicker';
import { carveColumn, densityTopColumn } from '../caves/carve';
import { carverCacheOf } from '../caves/carverCache';
import { caveReadersOf, createPreTags, tagColumn } from '../caves/tags';
import { buildColumnSample, latticeIndex, newColumnSample, type ColumnSample } from '../column/columnStage';
import type { GenContext } from '../context';
import { fillDensityColumn, type DensityBounds } from '../density/bounds';
import { aquiferColumn, aquiferOf, createAquiferScratch } from '../fluids/aquifer';
import { seedSectionsOf } from '../fluids/settle';
import { newSpringList, springProbesOf, springsColumn, type SpringList } from '../fluids/springs';
import { surfaceContextOf } from '../surface/context';
import { surfacePass } from '../surface/pass';
import { fillSurfaceBiomes, type SurfaceScan } from '../surface/scan';

const Y0 = MIN_Y;
const AIR_ = AIR;
const BEDROCK_ = BEDROCK;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const LATTICE = latticeIndex;
const FILL = fillDensityColumn;
const SURFACE_CONTEXT = surfaceContextOf;
const SURFACE_PASS = surfacePass;
const SURFACE_BIOMES = fillSurfaceBiomes;
const READERS = caveReadersOf;
const TAG_COLUMN = tagColumn;
const CARVE = carveColumn;
const DENSITY_TOPS = densityTopColumn;
const CARVER_CACHE = carverCacheOf;
const PICKER_OF = cavePickerOf;
const FILL_PASS = fillCaveColumnPass;
const BIOME_OF_PASS = caveBiomeOfPass;
const NEW_PASS = newCaveColumnPass;
const AQUIFER_OF = aquiferOf;
const AQUIFER_COLUMN = aquiferColumn;
const SEED_SECTIONS = seedSectionsOf;
const NEW_AQUIFER_SCRATCH = createAquiferScratch;
const SPRINGS_COLUMN = springsColumn;
const NEW_SPRING_LIST = newSpringList;
const NEW_PRE_TAGS = createPreTags;
const SPRING_PROBES = springProbesOf;
const WATER_SOURCE_ = WATER_SOURCE;
const LAVA_SOURCE_ = LAVA_SOURCE;

const SAMPLE = NEW_SAMPLE();
/** Solidity per voxel `((y + 64)·16 + lz)·16 + lx` (fillDensityColumn's order): section sy is 4096·sy … + 4095. */
const SOLID = new Uint8Array(98304);
/** The cave tag per voxel (same index; SP6a spec §3.2): `tagColumn`'s output. */
const TAG = new Uint8Array(98304);
/** Per column index `lz·16 + lx`: the density top after the fill, before the carve (`densityTopColumn`, SP6a §2.4). */
const DENSITY_TOP = new Int16Array(256);
/** Per cell `(ck·4 + cj)·4 + ci`: 1 where the fill evaluated the cell's corners or voxels (`fillDensityColumn`'s cells). */
const CELLS = new Uint8Array(768);
/** The aquifer step's water per voxel (same index; SP7a §1.7): 1 at a water voxel, the surface pass's scratch. */
const WATER_V = new Uint8Array(98304);
/** The aquifer step's fluid byte per voxel (same index; 0 for none): water or lava sources, the proto `FLUID`. */
const FLUID_V = new Uint8Array(98304);
/** Per column index `lz·16 + lx`: the highest fluid voxel's y (Y0 − 1 when none; the aquifer step tracks it, D19). */
const TOP_FLUID = new Int32Array(256);
/** The aquifer's per-job status cache (SP7a §1.8). */
const AQUIFER_SCRATCH = NEW_AQUIFER_SCRATCH();
/** The surface pass's final state per solid voxel (same index; other entries stale). */
const STATE = new Uint16Array(98304);
/** The per-block surface biome per column index `lz·16 + lx` (SP3c §1 step 4). */
const BIOMES = new Uint8Array(256);
/** Per column index `lz·16 + lx`: the highest solid y (Y0 when none), barriers included (`columnTops`). */
const TOP = new Int32Array(256);
/** The column's cave-biome pass (SP6b spec §1.2): C′, E′, H′ and Y0 at the positions within J of it. */
const PASS = NEW_PASS();
/** `terrainSurfaceDebug`'s own pass (its scan keeps it; a stage run never touches it). */
const DEBUG_PASS = NEW_PASS();
/** Tagged voxels per quart and nibble (`caveBiomeQuarts`): entry `16·q + biome`, q = (qy·4 + qz)·4 + qx (≤ 64 each). */
const QUART_BIOMES = new Uint8Array(16 * 1536);
/** The springs step's accepted springs (SP7a §3; `springsColumn`'s list). */
const SPRINGS = NEW_SPRING_LIST();
const BLOCKS = new Uint16Array(4096);
const FLUID = new Uint8Array(4096);
const CAVE = new Uint8Array(4096);
/** The tag pass's work done during the fill (Task 31p): the fill's hooks, then `tagColumn`'s `pre`. */
const PRE_TAGS = NEW_PRE_TAGS();

const NEVER = (): boolean => false;

/**
 * `terrainAquiferDebug`'s output (SP7a §13.5): a column's inputs to T's aquifer step as T hands them over, each array in
 * T's voxel index `((y + 64)·16 + lz)·16 + lx` (98,304 entries).
 */
export interface AquiferStepInputs {
  /** The column's ColumnSample. */
  readonly sample: ColumnSample;
  /** The cave-biome pass the cave-biome step filled. */
  readonly pass: CaveColumnPass;
  /** The carved solidity before the step (its barriers are not in it yet). */
  readonly solid: Uint8Array;
  /** The cave bytes, `kind | biome << 4` at tagged voxels and 0 elsewhere. */
  readonly tags: Uint8Array;
}

/** A fresh `AquiferStepInputs` for `terrainAquiferDebug`. */
export function newAquiferStepInputs(): AquiferStepInputs {
  return { sample: NEW_SAMPLE(), pass: NEW_PASS(), solid: new Uint8Array(98304), tags: new Uint8Array(98304) };
}

/**
 * The highest solid y per position of a column's solidity `solid` (98,304 entries, index `256·(y + 64) + p`, p = lz·16
 * + lx; the y −64 entries are ignored) into `top[p]`: scanned from y 319 down to y −63, Y0 when none (bedrock at Y0 is
 * not stone). Water v0's top loop, kept for aux A (SP7a §1.7).
 */
function columnTops(solid: Uint8Array, top: Int32Array): void {
  for (let p = 0; p < 256; p++) {
    let t = Y0;
    for (let i = 98048 + p; i >= 256; i -= 256) {
      if (solid[i] !== 0) { t = (i >> 8) + Y0; break; }
    }
    top[p] = t;
  }
}

/**
 * The density fill of s's column into `SOLID` and `CELLS` (`fillDensityColumn` on `bounds`) with `PRE_TAGS` as its hooks,
 * for the tag pass; false when `stop()` fired.
 */
function fill(ctx: GenContext, bounds: DensityBounds, s: ColumnSample, stop: () => boolean): boolean {
  PRE_TAGS.begin(bounds, ctx.params.caves.pillars.threshold);
  return FILL(bounds, s, SOLID, null, null, stop, CELLS, PRE_TAGS);
}

/**
 * The carve of column (cx, cz) after its fill (SP6a spec §2.4): `TAG` cleared, then `carveColumn` through `ctx`'s path
 * cache on `SOLID`, with the density tops in `DENSITY_TOP`, writing the carver kinds into `TAG`.
 */
function carve(ctx: GenContext, s: ColumnSample, cx: number, cz: number): void {
  const cache = CARVER_CACHE(ctx);
  TAG.fill(0);
  CARVE(cache, cache.params, s, cx, cz, SOLID, DENSITY_TOP, TAG);
}

/**
 * The cave-biome step (SP6b spec §2.1) of column (s.cx, s.cz): fills `pass` for it with the picker inputs `inp`, then
 * writes `kind | biome << 4` into `tags` (98,304 entries, index `((y + 64)·16 + lz)·16 + lx`, the tag pass's output) at
 * every tagged voxel (kind ≠ 0, `caveBiomeOfPass`); untagged voxels keep 0. The T stage and the surface probe (which
 * rebuilds a column the way T does) share it. Throws a RangeError on other sizes.
 */
export function columnCaveBiomes(inp: CavePickerInputs, s: ColumnSample, tags: Uint8Array, pass: CaveColumnPass): void {
  if (tags.length !== 98304) throw new RangeError('columnCaveBiomes: tags needs 98,304 entries');
  FILL_PASS(inp, s, pass);
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  for (let j = 0; j < 98304; j++) {
    const t = tags[j]!;
    if (t === 0) continue;
    tags[j] = t | (BIOME_OF_PASS(inp, pass, x0 + (j & 15), (j >> 8) + Y0, z0 + ((j >> 4) & 15)) << 4);
  }
}

/**
 * Writes the accepted springs of `list` into the column's scratches (SP7a §3.1): each spring voxel becomes non-solid
 * with a source (`WATER_SOURCE`, `LAVA_SOURCE` for the lava kind, 2) and cave byte 0; the water scratch, the states and
 * `top` are not read again, so they are left as they are.
 */
function writeSprings(list: SpringList): void {
  for (let k = 0; k < list.n; k++) {
    const j = list.pos[k]!;
    SOLID[j] = 0;
    FLUID_V[j] = list.kind[k] === 2 ? LAVA_SOURCE_ : WATER_SOURCE_;
    TAG[j] = 0;
  }
}

/** The stage's surface-pass cave argument (its picker and `PASS`): rebuilt only when the picker inputs change. */
let caveScan: { readonly inputs: CavePickerInputs; readonly pass: CaveColumnPass } | null = null;

/**
 * The tag and the cave-biome step of s's column after its carve, as T runs them: `tagColumn` into `TAG` (from `SOLID`
 * and the fill's `CELLS`), then `columnCaveBiomes` into `TAG` and `pass`; returns `ctx`'s picker inputs.
 */
function tagAndPick(ctx: GenContext, s: ColumnSample, bounds: DensityBounds, pass: CaveColumnPass): CavePickerInputs {
  const c = bounds.compiled;
  TAG_COLUMN(c, READERS(c), ctx.params.caves.pillars.threshold, SOLID, CELLS, TAG, bounds, true, PRE_TAGS);
  const inp = PICKER_OF(ctx);
  columnCaveBiomes(inp, s, TAG, pass);
  return inp;
}

/**
 * `caveBiomeQ` of a column (SP6b spec §2.2) from its cave bytes `tags` (98,304 entries, index `((y + 64)·16 + lz)·16 +
 * lx`, the kind in bits 0-3 and the biome in bits 4-7) into `out[(qy·4 + qz)·4 + qx]` (1,536 entries), qy = (y + 64) >> 2:
 * 0 for a quart with no tagged voxel (kind ≠ 0), else 1 + the biome most of its tagged voxels carry, a tie to the lower
 * id. The fluid is not read: tagged voxels holding water count like dry ones. Throws a RangeError on other sizes.
 */
export function caveBiomeQuarts(tags: Uint8Array, out: Uint8Array): void {
  if (tags.length !== 98304 || out.length !== 1536) throw new RangeError('caveBiomeQuarts: tags needs 98,304 entries, out 1,536');
  QUART_BIOMES.fill(0);
  for (let j = 0; j < 98304; j++) {
    const t = tags[j]!;
    if ((t & 15) === 0) continue;
    QUART_BIOMES[16 * ((((j >> 10) << 2) + ((j >> 6) & 3)) * 4 + ((j >> 2) & 3)) + (t >> 4)]!++;
  }
  for (let k = 0; k < 1536; k++) {
    let best = -1;
    let most = 0;
    for (let b = 0; b < 16; b++) {
      const n = QUART_BIOMES[16 * k + b]!;
      if (n > most) { most = n; best = b; }
    }
    out[k] = best + 1;
  }
}

/**
 * Writes column (cx, cz)'s proto sections, aux A and aux B through `w`; false (nothing more written) as soon as
 * `stop()` returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
 */
export function terrainStage(ctx: GenContext, cx: number, cz: number, w: TerrainWriter, stop: () => boolean): boolean {
  const sc = SURFACE_CONTEXT(ctx);
  const s = BUILD(ctx, cx, cz, SAMPLE);
  const bounds = sc.density.bounds;
  if (!fill(ctx, bounds, s, stop)) return false;
  const islands = ctx.params.islands.enabled;
  DENSITY_TOPS(SOLID, islands, DENSITY_TOP);
  if (stop()) return false;
  carve(ctx, s, cx, cz);
  const inp = tagAndPick(ctx, s, bounds, PASS);
  if (caveScan === null || caveScan.inputs !== inp) caveScan = { inputs: inp, pass: PASS };
  AQUIFER_COLUMN(AQUIFER_OF(ctx), s, inp, PASS, SOLID, TAG, WATER_V, FLUID_V, TOP_FLUID, AQUIFER_SCRATCH);
  columnTops(SOLID, TOP);
  SURFACE_BIOMES(s, ctx, BIOMES);
  if (stop()) return false;
  SURFACE_PASS(sc, s, SOLID, WATER_V, BIOMES, STATE, undefined, TAG, caveScan);
  SPRINGS_COLUMN(ctx, s, PASS, SOLID, STATE, TAG, FLUID_V, TOP, SPRING_PROBES(ctx), SPRINGS);
  writeSprings(SPRINGS);
  const seeds = SEED_SECTIONS(SOLID, FLUID_V);
  for (let sy = 0; sy < 24; sy++) {
    if (stop()) return false;
    const base = 4096 * sy;
    for (let i = 0; i < 4096; i++) {
      const j = base + i;
      CAVE[i] = TAG[j]!;
      if (j < 256) {
        BLOCKS[i] = BEDROCK_;
        FLUID[i] = 0;
      } else if (SOLID[j] !== 0) {
        BLOCKS[i] = STATE[j]!;
        FLUID[i] = 0;
      } else {
        BLOCKS[i] = AIR_;
        FLUID[i] = FLUID_V[j]!;
      }
    }
    w.setProto(sy, BLOCKS, FLUID, CAVE);
  }
  const aux = w.aux();
  for (let p = 0; p < 256; p++) {
    // OCEAN_FLOOR_WG: the highest colliding voxel is the highest solid one (every surface state collides, barriers
    // included), or the bedrock at Y0. WORLD_SURFACE_WG also counts fluid: the highest non-air voxel is the higher of
    // the solid top and the highest fluid voxel the aquifer step tracked (D19: a tagged voxel above `top`, a crack in
    // the sea floor, can hold aquifer water). Both equal a top-down scan with the SP3a §3.4 predicates.
    const top = TOP[p]!;
    aux.oceanFloorWG[p] = top + 1;
    aux.worldSurfaceWG[p] = Math.max(top, TOP_FLUID[p]!) + 1;
    aux.surfaceBiome[p] = BIOMES[p]!;
  }
  const auxB = w.auxB();
  const q = auxB.surfaceBiomeQ;
  for (let qz = 0; qz < 4; qz++) {
    for (let qx = 0; qx < 4; qx++) q[qz * 4 + qx] = s.biome[LATTICE(qx, qz)]!;
  }
  caveBiomeQuarts(TAG, auxB.caveBiomeQ);
  auxB.seedSections[0] = seeds;
  return true;
}

/**
 * Test hook (SP3b spec §2.3, DT2 `probeBulk`): runs column (cx, cz)'s density phase exactly as `terrainStage` does
 * (its ColumnSample, then `fillDensityColumn` on the DensityContext of `surfaceContextOf(ctx)`, never stopped) and writes no
 * store. `mask` (98,304 entries, index `((y + 64)·16 + lz)·16 + lx`) is cleared, then set to 1 at every voxel the bulk
 * evaluated with `voxelFn`, and `out` (same index) receives those voxels' values; the early-out voxels keep mask 0 and
 * their `out` entries are left untouched. Throws a RangeError when either array is not 98,304 long.
 */
export function terrainDensityDebug(ctx: GenContext, cx: number, cz: number, out: Float64Array, mask: Uint8Array): void {
  if (out.length !== SOLID.length || mask.length !== SOLID.length) {
    throw new RangeError(`terrainDensityDebug: out has ${out.length} and mask ${mask.length} entries, expected ${SOLID.length}`);
  }
  FILL(SURFACE_CONTEXT(ctx).density.bounds, BUILD(ctx, cx, cz, SAMPLE), SOLID, out, mask, NEVER);
}

/**
 * Test hook (SP3c spec §5.2, DT2 `surfaceReference`): runs column (cx, cz) exactly as `terrainStage` does up to and
 * including the surface pass (its ColumnSample, the density fill, the carve, the tag and the cave-biome step (SP6b spec
 * §2.3), the aquifer step (SP7a §1.7), the biome buffer, then `surfacePass` on `surfaceContextOf(ctx)` with the cave
 * bytes and the picker's pass, never stopped), with `scan` as the pass's scan context, and writes no store. Afterwards `scan` holds the
 * stage's scan of the column (its runs' floor and ceiling cave biomes included; its `cavePass` is the hook's own pass,
 * which only the next hook call overwrites), on which the stage's compiled tree and the reference evaluator can be
 * compared voxel by voxel. Returns the pass's evaluated-voxel count.
 */
export function terrainSurfaceDebug(ctx: GenContext, cx: number, cz: number, scan: SurfaceScan): number {
  const sc = SURFACE_CONTEXT(ctx);
  const s = BUILD(ctx, cx, cz, SAMPLE);
  const bounds = sc.density.bounds;
  fill(ctx, bounds, s, NEVER);
  DENSITY_TOPS(SOLID, ctx.params.islands.enabled, DENSITY_TOP);
  carve(ctx, s, cx, cz);
  const inputs = tagAndPick(ctx, s, bounds, DEBUG_PASS);
  AQUIFER_COLUMN(AQUIFER_OF(ctx), s, inputs, DEBUG_PASS, SOLID, TAG, WATER_V, FLUID_V, TOP_FLUID, AQUIFER_SCRATCH);
  SURFACE_BIOMES(s, ctx, BIOMES);
  return SURFACE_PASS(sc, s, SOLID, WATER_V, BIOMES, STATE, scan, TAG, { inputs, pass: DEBUG_PASS });
}

/**
 * Test hook (SP7a spec §3, the springs' tests, DT2's spring exclusion checks and U2's mountain witness): runs column (cx,
 * cz) exactly as `terrainStage` does up to and including the springs step (the density fill, the carve, the tag and the
 * cave-biome step, the aquifer step, `top`, the biome buffer and the surface pass, never stopped), with the hook's own
 * cave pass, and writes no store; `out` receives the column's accepted springs (`springsColumn`'s list).
 */
export function terrainSpringsDebug(ctx: GenContext, cx: number, cz: number, out: SpringList): void {
  const sc = SURFACE_CONTEXT(ctx);
  const s = BUILD(ctx, cx, cz, SAMPLE);
  const bounds = sc.density.bounds;
  fill(ctx, bounds, s, NEVER);
  DENSITY_TOPS(SOLID, ctx.params.islands.enabled, DENSITY_TOP);
  carve(ctx, s, cx, cz);
  const inputs = tagAndPick(ctx, s, bounds, DEBUG_PASS);
  AQUIFER_COLUMN(AQUIFER_OF(ctx), s, inputs, DEBUG_PASS, SOLID, TAG, WATER_V, FLUID_V, TOP_FLUID, AQUIFER_SCRATCH);
  columnTops(SOLID, TOP);
  SURFACE_BIOMES(s, ctx, BIOMES);
  SURFACE_PASS(sc, s, SOLID, WATER_V, BIOMES, STATE, undefined, TAG, { inputs, pass: DEBUG_PASS });
  SPRINGS_COLUMN(ctx, s, DEBUG_PASS, SOLID, STATE, TAG, FLUID_V, TOP, SPRING_PROBES(ctx), out);
}

/**
 * Test and bench hook (SP7a §13.5, `aquifer.column`): runs column (cx, cz) exactly as `terrainStage` does up to the
 * aquifer step, not including it (its ColumnSample into `out.sample`, the density fill, the carve, the tag and the
 * cave-biome step into `out.pass`, never stopped), copies the carved solidity and the cave bytes into `out.solid` and
 * `out.tags`, and writes no store. Returns `ctx`'s cave picker inputs, so `aquiferColumn(aquiferOf(ctx), out.sample,
 * <returned>, out.pass, out.solid, out.tags, …)` is T's own step on the column.
 */
export function terrainAquiferDebug(ctx: GenContext, cx: number, cz: number, out: AquiferStepInputs): CavePickerInputs {
  if (out.solid.length !== SOLID.length || out.tags.length !== TAG.length) {
    throw new RangeError(`terrainAquiferDebug: solid has ${out.solid.length} and tags ${out.tags.length} entries, expected ${SOLID.length}`);
  }
  const sc = SURFACE_CONTEXT(ctx);
  const s = BUILD(ctx, cx, cz, out.sample);
  const bounds = sc.density.bounds;
  fill(ctx, bounds, s, NEVER);
  DENSITY_TOPS(SOLID, ctx.params.islands.enabled, DENSITY_TOP);
  carve(ctx, s, cx, cz);
  const inputs = tagAndPick(ctx, s, bounds, out.pass);
  out.solid.set(SOLID);
  out.tags.set(TAG);
  return inputs;
}

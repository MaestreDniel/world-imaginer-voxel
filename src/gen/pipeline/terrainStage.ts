/**
 * The T stage (SP3b spec §4, SP3c spec §1): fills a column's proto set with the surfaced density terrain, through the
 * store API.
 * - Density phase: the column's ColumnSample, then `fillDensityColumn` (columnFn, positionFn, then the 48 cell layers
 *   bottom up with bounds and early-outs) into a column-wide solidity scratch; `stop()` is polled before every 8 cell
 *   layers (6 polls). No section is written in this phase: water needs the whole column's `top`.
 * - Water v0: `top` is the y of the highest solid voxel per position (−64 when there is none above bedrock); air with
 *   `top − 12 < y ≤ surfaceWaterLevel` (nearest quart corner, as SP3a) becomes a water source, recorded in a
 *   column-wide water scratch. Air under an overhang near the water line fills; deeper enclosed air stays dry
 *   (aquifers, SP6). A position whose own level is −∞ stays dry beside a neighbour's water (the v0 "water wall").
 * - The per-block surface biome (`readBiome`), computed once into a 256-entry buffer for the surface pass and aux A.
 * - Surface pass (SP3c §3, `surfacePass`): after a `stop()` poll (the 7th), the whole-column scan and the compiled
 *   rules (fast path included) give every solid voxel at y −63 … 319 its final state in a column-wide state scratch.
 * - Fill: y = −64 bedrock; a solid voxel its surface state; anything else air (with its water).
 * - Sections 0 … 23 go to `setProto` in order (each channel uniform or dense), `stop()` before each (24 polls). On a
 *   true `stop()` in any phase the stage returns false at once, without aux.
 * - Aux A: `worldSurfaceWG`, `oceanFloorWG` (SP3a §3.4 predicates) and `surfaceBiome` (the step's biome buffer).
 * - Aux B: `surfaceBiomeQ[qz·4 + qx]` is the 2D biome of lattice point (qx, qz), qx, qz ∈ 0 … 3, before the zoom;
 *   `caveBiomeQ[(qy·4 + qz)·4 + qx]` stays 0 (none) until SP6.
 * The stage uses the SurfaceContext of its GenContext (`surfaceContextOf`, memoised), which holds the DensityContext.
 * Follows the gen determinism rules.
 * `terrainDensityDebug` is a test hook (SP3b §2.3, DT2): the same density phase, recording the bulk-evaluated values.
 * `terrainSurfaceDebug` is another (SP3c §5.2, DT2's `surfaceReference`): the same phases up to the surface pass, which
 * scans into the caller's scan context.
 */
import { MIN_Y } from '../../core/constants';
import { WATER_SOURCE } from '../../world/blocks/fluid';
import { AIR, BEDROCK } from '../../world/blocks/index';
import type { ColumnWriter as ColumnWriterT } from '../../world/store/api';
import { buildColumnSample, latticeIndex, newColumnSample, readLevel, type ColumnSample } from '../column/columnStage';
import type { GenContext } from '../context';
import { fillDensityColumn } from '../density/bounds';
import { surfaceContextOf } from '../surface/context';
import { surfacePass } from '../surface/pass';
import { fillSurfaceBiomes, type SurfaceScan } from '../surface/scan';

const Y0 = MIN_Y;
const WATER = WATER_SOURCE;
const AIR_ = AIR;
const BEDROCK_ = BEDROCK;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const LATTICE = latticeIndex;
const LEVEL = readLevel;
const FILL = fillDensityColumn;
const SURFACE_CONTEXT = surfaceContextOf;
const SURFACE_PASS = surfacePass;
const SURFACE_BIOMES = fillSurfaceBiomes;

/** Highest y of the world (MIN_Y + 384 − 1); water tops are clamped to [Y0 − 1, TOP_Y], which changes no comparison. */
const TOP_Y = Y0 + 383;
/** Water fills air down to `top − 12` exclusive (§4). */
const WATER_DEPTH = 12;

const SAMPLE = NEW_SAMPLE();
/** Solidity per voxel `((y + 64)·16 + lz)·16 + lx` (fillDensityColumn's order): section sy is 4096·sy … + 4095. */
const SOLID = new Uint8Array(98304);
/** Water v0 per voxel (same index): 1 where the stage writes a water source. */
const WATER_V = new Uint8Array(98304);
/** The surface pass's final state per solid voxel (same index; other entries stale). */
const STATE = new Uint16Array(98304);
/** The per-block surface biome per column index `lz·16 + lx` (SP3c §1 step 4). */
const BIOMES = new Uint8Array(256);
/** Per column index `lz·16 + lx`: the highest solid y (Y0 when none) and ⌊surfaceWaterLevel⌋ (−∞ becomes Y0 − 1). */
const TOP = new Int32Array(256);
const WATER_TOP = new Int32Array(256);
const BLOCKS = new Uint16Array(4096);
const FLUID = new Uint8Array(4096);

const NEVER = (): boolean => false;

const clampY = (v: number): number => Math.min(TOP_Y, Math.max(Y0 - 1, v));

/**
 * Water v0 (§4) of column (s.cx, s.cz) from its solidity `solid` (98,304 entries, index `256·(y + 64) + p`, p = lz·16 +
 * lx; the y −64 entries are ignored): `top[p]` is the y of the highest solid voxel above the bedrock (Y0 when none)
 * and `waterTop[p]` ⌊surfaceWaterLevel⌋ at the nearest quart corner, clamped to [Y0 − 1, 319] (−∞ becomes Y0 − 1).
 * With `water` (98,304 entries), every entry is set: 1 at a non-solid voxel y −63 … 319 with
 * `top − 12 < y ≤ waterTop` (a water source in T), 0 elsewhere (solid voxels and y −64 included). The T stage and the
 * surface probe (which rebuilds a column the way T does) share it. Throws a RangeError on other sizes.
 */
export function columnWaterV0(s: ColumnSample, solid: Uint8Array, top: Int32Array, waterTop: Int32Array, water: Uint8Array | null): void {
  if (solid.length !== 98304 || top.length !== 256 || waterTop.length !== 256 || (water !== null && water.length !== 98304)) {
    throw new RangeError('columnWaterV0: solid and water need 98,304 entries, top and waterTop 256');
  }
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  for (let p = 0; p < 256; p++) {
    let t = Y0;
    // From y 319 down to y −63 (index 256·(y + 64) + p); bedrock at Y0 is not stone.
    for (let i = 98048 + p; i >= 256; i -= 256) {
      if (solid[i] !== 0) { t = (i >> 8) + Y0; break; }
    }
    top[p] = t;
    waterTop[p] = clampY(Math.floor(LEVEL(s, 'surfaceWaterLevel', x0 + (p & 15), z0 + (p >> 4))));
  }
  if (water === null) return;
  water.fill(0, 0, 256);
  for (let i = 256; i < 98304; i++) {
    const p = i & 255;
    const y = (i >> 8) + Y0;
    water[i] = solid[i] === 0 && y > top[p]! - WATER_DEPTH && y <= waterTop[p]! ? 1 : 0;
  }
}

/**
 * Writes column (cx, cz)'s proto sections, aux A and aux B through `w`; false (nothing more written) as soon as
 * `stop()` returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
 */
export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriterT, stop: () => boolean): boolean {
  const sc = SURFACE_CONTEXT(ctx);
  const s = BUILD(ctx, cx, cz, SAMPLE);
  if (!FILL(sc.density.bounds, s, SOLID, null, null, stop)) return false;
  columnWaterV0(s, SOLID, TOP, WATER_TOP, WATER_V);
  SURFACE_BIOMES(s, ctx, BIOMES);
  if (stop()) return false;
  SURFACE_PASS(sc, s, SOLID, WATER_V, BIOMES, STATE);
  for (let sy = 0; sy < 24; sy++) {
    if (stop()) return false;
    const base = 4096 * sy;
    for (let i = 0; i < 4096; i++) {
      const j = base + i;
      if (j < 256) {
        BLOCKS[i] = BEDROCK_;
        FLUID[i] = 0;
      } else if (SOLID[j] !== 0) {
        BLOCKS[i] = STATE[j]!;
        FLUID[i] = 0;
      } else {
        BLOCKS[i] = AIR_;
        FLUID[i] = WATER_V[j] !== 0 ? WATER : 0;
      }
    }
    w.setProto(sy, BLOCKS, FLUID);
  }
  const aux = w.aux();
  for (let p = 0; p < 256; p++) {
    // OCEAN_FLOOR_WG: the highest colliding voxel is the highest solid one (every surface state collides), or the
    // bedrock at Y0. WORLD_SURFACE_WG also counts water: when WATER_TOP > top, the air at WATER_TOP is above every
    // solid voxel and > top − 12, so it holds water; otherwise every water voxel lies below top. Both equal a top-down
    // scan with the SP3a §3.4 predicates.
    const top = TOP[p]!;
    aux.oceanFloorWG[p] = top + 1;
    aux.worldSurfaceWG[p] = Math.max(top, WATER_TOP[p]!) + 1;
    aux.surfaceBiome[p] = BIOMES[p]!;
  }
  const q = w.auxB().surfaceBiomeQ;
  for (let qz = 0; qz < 4; qz++) {
    for (let qx = 0; qx < 4; qx++) q[qz * 4 + qx] = s.biome[LATTICE(qx, qz)]!;
  }
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
 * including the surface pass (its ColumnSample, the density fill, water v0, the biome buffer, then `surfacePass` on
 * `surfaceContextOf(ctx)`, never stopped), with `scan` as the pass's scan context, and writes no store. Afterwards
 * `scan` holds the stage's scan of the column, on which the stage's compiled tree and the reference evaluator can be
 * compared voxel by voxel. Returns the pass's evaluated-voxel count.
 */
export function terrainSurfaceDebug(ctx: GenContext, cx: number, cz: number, scan: SurfaceScan): number {
  const sc = SURFACE_CONTEXT(ctx);
  const s = BUILD(ctx, cx, cz, SAMPLE);
  FILL(sc.density.bounds, s, SOLID, null, null, NEVER);
  columnWaterV0(s, SOLID, TOP, WATER_TOP, WATER_V);
  SURFACE_BIOMES(s, ctx, BIOMES);
  return SURFACE_PASS(sc, s, SOLID, WATER_V, BIOMES, STATE, scan);
}

/**
 * The T stage (SP3b spec §4): fills a column's proto set with the density terrain, through the store API.
 * - Density phase: the column's ColumnSample, then `fillDensityColumn` (columnFn, positionFn, then the 48 cell layers
 *   bottom up with bounds and early-outs) into a column-wide solidity scratch; `stop()` is polled before every 8 cell
 *   layers (6 polls). No section is written in this phase: water needs the whole column's `top`.
 * - Fill: y = −64 bedrock; otherwise density > 0 stone, anything else air.
 * - Water v0: `top` is the y of the highest stone voxel per position (−64 when there is none above bedrock); air with
 *   `top − 12 < y ≤ surfaceWaterLevel` (nearest quart corner, as SP3a) becomes a water source. Air under an overhang
 *   near the water line fills; deeper enclosed air stays dry (aquifers, SP6). A position whose own level is −∞ stays
 *   dry beside a neighbour's water (the v0 "water wall").
 * - Sections 0 … 23 go to `setProto` in order (each channel uniform or dense), `stop()` before each (24 polls). On a
 *   true `stop()` in either phase the stage returns false at once, without aux.
 * - Aux A: `worldSurfaceWG`, `oceanFloorWG` (SP3a §3.4 predicates) and `surfaceBiome` (the zoomed biome).
 * - Aux B: `surfaceBiomeQ[qz·4 + qx]` is the 2D biome of lattice point (qx, qz), qx, qz ∈ 0 … 3, before the zoom;
 *   `caveBiomeQ[(qy·4 + qz)·4 + qx]` stays 0 (none) until SP6.
 * The stage keeps one DensityContext per GenContext (module-level WeakMap). Follows the gen determinism rules.
 */
import { MIN_Y } from '../../core/constants';
import { WATER_SOURCE } from '../../world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../world/blocks/index';
import type { ColumnWriter as ColumnWriterT } from '../../world/store/api';
import { buildColumnSample, latticeIndex, newColumnSample, readBiome, readLevel } from '../column/columnStage';
import type { GenContext } from '../context';
import { fillDensityColumn } from '../density/bounds';
import { createDensityContext, type DensityContext } from '../density/context';

const Y0 = MIN_Y;
const WATER = WATER_SOURCE;
const AIR_ = AIR;
const STONE_ = STONE;
const BEDROCK_ = BEDROCK;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const LATTICE = latticeIndex;
const LEVEL = readLevel;
const BIOME = readBiome;
const FILL = fillDensityColumn;
const CREATE_DC = createDensityContext;

/** Highest y of the world (MIN_Y + 384 − 1); water tops are clamped to [Y0 − 1, TOP_Y], which changes no comparison. */
const TOP_Y = Y0 + 383;
/** Water fills air down to `top − 12` exclusive (§4). */
const WATER_DEPTH = 12;

const SAMPLE = NEW_SAMPLE();
/** Solidity per voxel `((y + 64)·16 + lz)·16 + lx` (fillDensityColumn's order): section sy is 4096·sy … + 4095. */
const SOLID = new Uint8Array(98304);
/** Per column index `lz·16 + lx`: the highest stone y (Y0 when none) and ⌊surfaceWaterLevel⌋ (−∞ becomes Y0 − 1). */
const TOP = new Int32Array(256);
const WATER_TOP = new Int32Array(256);
const BLOCKS = new Uint16Array(4096);
const FLUID = new Uint8Array(4096);

const DCS = new WeakMap<GenContext, DensityContext>();

/** The stage's DensityContext for `ctx` (built on first use). */
function densityContextOf(ctx: GenContext): DensityContext {
  let dc = DCS.get(ctx);
  if (dc === undefined) {
    dc = CREATE_DC(ctx);
    DCS.set(ctx, dc);
  }
  return dc;
}

const clampY = (v: number): number => Math.min(TOP_Y, Math.max(Y0 - 1, v));

/**
 * Writes column (cx, cz)'s proto sections, aux A and aux B through `w`; false (nothing more written) as soon as
 * `stop()` returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
 */
export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriterT, stop: () => boolean): boolean {
  const dc = densityContextOf(ctx);
  const s = BUILD(ctx, cx, cz, SAMPLE);
  if (!FILL(dc.bounds, s, SOLID, null, null, stop)) return false;
  const x0 = 16 * cx;
  const z0 = 16 * cz;
  for (let p = 0; p < 256; p++) {
    let top = Y0;
    // From y 319 down to y −63 (index 256·(y + 64) + p); bedrock at Y0 is not stone.
    for (let i = 98048 + p; i >= 256; i -= 256) {
      if (SOLID[i] !== 0) { top = (i >> 8) + Y0; break; }
    }
    TOP[p] = top;
    WATER_TOP[p] = clampY(Math.floor(LEVEL(s, 'surfaceWaterLevel', x0 + (p & 15), z0 + (p >> 4))));
  }
  for (let sy = 0; sy < 24; sy++) {
    if (stop()) return false;
    const yBase = Y0 + 16 * sy;
    const base = 4096 * sy;
    for (let ly = 0; ly < 16; ly++) {
      const y = yBase + ly;
      const row = ly << 8;
      for (let p = 0; p < 256; p++) {
        const i = row | p;
        if (y === Y0) {
          BLOCKS[i] = BEDROCK_;
          FLUID[i] = 0;
        } else if (SOLID[base + i] !== 0) {
          BLOCKS[i] = STONE_;
          FLUID[i] = 0;
        } else {
          BLOCKS[i] = AIR_;
          FLUID[i] = y > TOP[p]! - WATER_DEPTH && y <= WATER_TOP[p]! ? WATER : 0;
        }
      }
    }
    w.setProto(sy, BLOCKS, FLUID);
  }
  const aux = w.aux();
  for (let p = 0; p < 256; p++) {
    // OCEAN_FLOOR_WG: the highest colliding voxel is the highest stone, or the bedrock at Y0. WORLD_SURFACE_WG also
    // counts water: when WATER_TOP > top, the air at WATER_TOP is above every stone and > top − 12, so it holds
    // water; otherwise every water voxel lies below top. Both equal a top-down scan with the SP3a §3.4 predicates.
    const top = TOP[p]!;
    aux.oceanFloorWG[p] = top + 1;
    aux.worldSurfaceWG[p] = Math.max(top, WATER_TOP[p]!) + 1;
    aux.surfaceBiome[p] = BIOME(s, ctx, x0 + (p & 15), z0 + (p >> 4));
  }
  const q = w.auxB().surfaceBiomeQ;
  for (let qz = 0; qz < 4; qz++) {
    for (let qx = 0; qx < 4; qx++) q[qz * 4 + qx] = s.biome[LATTICE(qx, qz)]!;
  }
  return true;
}

/**
 * The provisional T stage (SP3a spec §4): fills a column's proto set from today's 2D world, through the store API.
 * Per block position, from the column's ColumnSample: `surfaceEst` (still `offset`, bilinear readout) and
 * `surfaceWaterLevel` (nearest-corner readout). From the bottom: y = −64 bedrock; y ≤ ⌊surfaceEst⌋ stone;
 * ⌊surfaceEst⌋ < y ≤ surfaceWaterLevel air with a water source; above, air. This is master §10's v0 water rule in
 * a world without overhangs. Sections 0 … 23 go to `setProto` in order (the store keeps each channel uniform or
 * dense); `stop()` is polled before each section and on true the stage returns false at once, without aux.
 * Then aux A: `worldSurfaceWG`, `oceanFloorWG` (§3.4 predicates) and `surfaceBiome` (the zoomed biome). SP3b
 * replaces this fill with the density terrain.
 */
import { MIN_Y } from '../../core/constants';
import { WATER_SOURCE } from '../../world/blocks/fluid';
import { AIR, BEDROCK, STONE } from '../../world/blocks/index';
import type { ColumnWriter as ColumnWriterT } from '../../world/store/api';
import { buildColumnSample, newColumnSample, readBiome, readField, readLevel } from '../column/columnStage';
import type { GenContext } from '../context';

const Y0 = MIN_Y;
const WATER = WATER_SOURCE;
const AIR_ = AIR;
const STONE_ = STONE;
const BEDROCK_ = BEDROCK;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const FIELD = readField;
const LEVEL = readLevel;
const BIOME = readBiome;

/** Highest y of the world (MIN_Y + 384 − 1); tops are clamped to [Y0 − 1, TOP_Y], which changes no comparison. */
const TOP_Y = Y0 + 383;

const SAMPLE = NEW_SAMPLE();
/** Per column index `lz·16 + lx`: ⌊surfaceEst⌋ and ⌊surfaceWaterLevel⌋, clamped (−∞ becomes Y0 − 1). */
const SOLID_TOP = new Int32Array(256);
const WATER_TOP = new Int32Array(256);
const BLOCKS = new Uint16Array(4096);
const FLUID = new Uint8Array(4096);

const clampY = (v: number): number => Math.min(TOP_Y, Math.max(Y0 - 1, v));

/**
 * Writes column (cx, cz)'s proto sections and aux A through `w`; false (nothing more written) as soon as `stop()`
 * returns true. Never commits: the caller does (`fillColumnT`, `metrics/region.ts`).
 */
export function terrainStage(ctx: GenContext, cx: number, cz: number, w: ColumnWriterT, stop: () => boolean): boolean {
  const s = BUILD(ctx, cx, cz, SAMPLE);
  const x0 = 16 * cx;
  const z0 = 16 * cz;
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const p = (lz << 4) | lx;
      SOLID_TOP[p] = clampY(Math.floor(FIELD(s, 'surfaceEst', x0 + lx, z0 + lz)));
      WATER_TOP[p] = clampY(Math.floor(LEVEL(s, 'surfaceWaterLevel', x0 + lx, z0 + lz)));
    }
  }
  for (let sy = 0; sy < 24; sy++) {
    if (stop()) return false;
    const yBase = Y0 + 16 * sy;
    for (let ly = 0; ly < 16; ly++) {
      const y = yBase + ly;
      const row = ly << 8;
      for (let p = 0; p < 256; p++) {
        const i = row | p;
        if (y === Y0) {
          BLOCKS[i] = BEDROCK_;
          FLUID[i] = 0;
        } else if (y <= SOLID_TOP[p]!) {
          BLOCKS[i] = STONE_;
          FLUID[i] = 0;
        } else {
          BLOCKS[i] = AIR_;
          FLUID[i] = y <= WATER_TOP[p]! ? WATER : 0;
        }
      }
    }
    w.setProto(sy, BLOCKS, FLUID);
  }
  const aux = w.aux();
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const p = (lz << 4) | lx;
      // Bedrock at Y0 is non-air and collides, so neither map is ever below Y0 + 1.
      const floor = Math.max(Y0, SOLID_TOP[p]!);
      aux.oceanFloorWG[p] = floor + 1;
      aux.worldSurfaceWG[p] = Math.max(floor, WATER_TOP[p]!) + 1;
      aux.surfaceBiome[p] = BIOME(s, ctx, x0 + lx, z0 + lz);
    }
  }
  return true;
}

/**
 * Map tile painting (SP2a spec §6.1): a 256 × 256 RGBA tile of one layer at level b blocks/px. Pixel
 * (i, j) of tile (tx, tz) samples the pixel centre (256·b·tx + b·(i + 0.5), 256·b·tz + b·(j + 0.5)).
 * Level 256 is the preview (sampleCoarse: no rivers or lakes, one sample per 2 × 2 pixel block); finer
 * levels use samplePoint without steep. Shaded layers sample a one-pixel border so adjacent tiles shade seamlessly.
 */
import { MAP_LEVELS, MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { GenContext } from '../context';
import { newPointRecord, sampleCoarse, samplePoint, type PointRecord } from '../column/columnPoint';
import { layerColor, needsRelief, slopeShade, type LayerId } from './layers';

const POINT = samplePoint;
const COARSE = sampleCoarse;
const NEW_POINT = newPointRecord;
const COLOR = layerColor;
const NEEDS_RELIEF = needsRelief;
const SLOPE = slopeShade;
const TILE = MAP_TILE_PX;
const LEVELS = MAP_LEVELS;

export type Level = MapLevel;

export function isLevel(v: unknown): v is Level {
  return typeof v === 'number' && (LEVELS as readonly number[]).includes(v);
}

/** Level used for a display scale of `bpp` blocks per screen pixel: the coarsest level ≤ 2·bpp, at least 4. */
export function levelFor(bpp: number): Level {
  for (const l of LEVELS) if (l <= 2 * bpp) return l;
  return 4;
}

/** Samples the pixel centre at level b. */
export function samplePixel(ctx: GenContext, b: Level, x: number, z: number, out: PointRecord): PointRecord {
  return b === 256 ? COARSE(ctx, x, z, out) : POINT(ctx, x, z, false, out);
}

const P = NEW_POINT();
const W = TILE + 2;
const HEIGHT = new Float64Array(W * W);
const WATER_LEVEL = new Float64Array(W * W);
const RIVER_DIST = new Float64Array(W * W);
const LAKE_MASK = new Float64Array(W * W);
const LAKE_LEVEL = new Float64Array(W * W);
const FLAGS = new Uint8Array(W * W);

function put(out: Uint8ClampedArray, o: number, rgb: number): void {
  out[o] = (rgb >>> 16) & 255;
  out[o + 1] = (rgb >>> 8) & 255;
  out[o + 2] = rgb & 255;
  out[o + 3] = 255;
}

const HALF = TILE / 2;

/**
 * The preview level samples one point per 2 × 2 pixel block, at the block's centre, and shades from the
 * neighbouring blocks (4× cheaper; a preview pixel is already 256 blocks wide).
 */
function paintPreview(ctx: GenContext, layer: LayerId, tx: number, tz: number, out: Uint8ClampedArray): Uint8ClampedArray {
  const b = 256;
  const x0 = TILE * b * tx;
  const z0 = TILE * b * tz;
  const WH = HALF + 2;
  const relief = NEEDS_RELIEF(layer);
  const at = (bi: number, bj: number) => samplePixel(ctx, 256, x0 + b * (2 * bi + 1), z0 + b * (2 * bj + 1), P);
  if (relief) for (let bj = -1; bj <= HALF; bj++) for (let bi = -1; bi <= HALF; bi++) HEIGHT[(bj + 1) * WH + (bi + 1)] = at(bi, bj).surfaceEst;
  for (let bj = 0; bj < HALF; bj++) for (let bi = 0; bi < HALF; bi++) {
    const p = at(bi, bj);
    const k0 = (bj + 1) * WH + (bi + 1);
    const k = relief ? SLOPE(HEIGHT[k0 - 1]!, HEIGHT[k0 + 1]!, HEIGHT[k0 - WH]!, HEIGHT[k0 + WH]!, 2 * b) : 1;
    const rgb = COLOR(layer, p, k);
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) put(out, 4 * ((2 * bj + dj) * TILE + 2 * bi + di), rgb);
  }
  return out;
}

/** Paints tile (tx, tz) of `layer` at level b into `out` (256·256·4 bytes, alpha 255). */
export function paintTile(ctx: GenContext, layer: LayerId, b: Level, tx: number, tz: number, out: Uint8ClampedArray): Uint8ClampedArray {
  if (b === 256) return paintPreview(ctx, layer, tx, tz, out);
  const x0 = TILE * b * tx;
  const z0 = TILE * b * tz;
  if (!NEEDS_RELIEF(layer)) {
    for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
      put(out, 4 * (j * TILE + i), COLOR(layer, samplePixel(ctx, b, x0 + b * (i + 0.5), z0 + b * (j + 0.5), P), 1));
    }
    return out;
  }
  // One sampling pass over the tile plus a one-pixel border, keeping only what shaded layers read.
  for (let j = -1; j <= TILE; j++) for (let i = -1; i <= TILE; i++) {
    const k = (j + 1) * W + (i + 1);
    const p = samplePixel(ctx, b, x0 + b * (i + 0.5), z0 + b * (j + 0.5), P);
    HEIGHT[k] = p.surfaceEst;
    WATER_LEVEL[k] = p.surfaceWaterLevel;
    RIVER_DIST[k] = p.riverDist;
    LAKE_MASK[k] = p.lakeMask;
    LAKE_LEVEL[k] = p.lakeLevel;
    FLAGS[k] = (p.riverWet ? 1 : 0) | (p.gorge ? 2 : 0);
  }
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const k = (j + 1) * W + (i + 1);
    P.surfaceEst = HEIGHT[k]!;
    P.surfaceWaterLevel = WATER_LEVEL[k]!;
    P.riverDist = RIVER_DIST[k]!;
    P.lakeMask = LAKE_MASK[k]!;
    P.lakeLevel = LAKE_LEVEL[k]!;
    P.riverWet = (FLAGS[k]! & 1) !== 0;
    P.gorge = (FLAGS[k]! & 2) !== 0;
    const shadeK = SLOPE(HEIGHT[k - 1]!, HEIGHT[k + 1]!, HEIGHT[k - W]!, HEIGHT[k + W]!, b);
    put(out, 4 * (j * TILE + i), COLOR(layer, P, shadeK));
  }
  return out;
}

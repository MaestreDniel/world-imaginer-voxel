/**
 * Map tile painting (SP2a spec §6.1): a 256 × 256 RGBA tile of one layer at level b blocks/px. Pixel
 * (i, j) of tile (tx, tz) samples the pixel centre (256·b·tx + b·(i + 0.5), 256·b·tz + b·(j + 0.5)).
 * Level 256 is the preview (sampleCoarse: no rivers or lakes, one sample per 2 × 2 pixel block); finer
 * levels use samplePoint without steep. Shaded layers sample a one-pixel border so adjacent tiles shade seamlessly.
 * Painting polls a plain `stop` callback once per row of its sampling pass and gives up when it fires
 * (SP2b spec §2.2); the biome layer can also write each pixel's biome id (SP2b spec §5.3). The caveBiome layer
 * (SP6b spec §9.1) is painted at a y with the context's picker inputs (`caveBiomeIdAt` and `caveBiomeIdColor`, the
 * parts of `caveBiomeColor`), in the unshaded path (each pixel sampled whole), and writes each pixel's cave-biome id.
 */
import { MAP_LEVELS, MAP_TILE_PX, type MapLevel } from '../../core/constants';
import type { GenContext } from '../context';
import { cavePickerOf, type CavePickerInputs } from '../biomes/cavePicker';
import { newPointRecord, sampleCoarse, samplePoint, type PointRecord } from '../column/columnPoint';
import { caveBiomeIdAt, caveBiomeIdColor, layerColor, needsRelief, slopeShade, type LayerId } from './layers';

const POINT = samplePoint;
const COARSE = sampleCoarse;
const NEW_POINT = newPointRecord;
const COLOR = layerColor;
const CAVE_ID = caveBiomeIdAt;
const CAVE_COLOR = caveBiomeIdColor;
const PICKER_OF = cavePickerOf;
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
const NEVER = (): boolean => false;

/** The caveBiome layer's picker inputs and height. */
interface CaveAt { readonly picker: CavePickerInputs; readonly y: number }

/** The caveBiome layer's picker inputs and y (an integer in −64 … 319, a RangeError otherwise); null for another layer. */
function caveAtOf(ctx: GenContext, layer: LayerId, y: number | undefined): CaveAt | null {
  if (layer !== 'caveBiome') return null;
  if (y === undefined || !Number.isInteger(y) || y < -64 || y > 319) throw new RangeError(`caveBiome tile: y ${y} is not an integer in −64 … 319`);
  return { picker: PICKER_OF(ctx), y };
}

/** Writes rgb, and the biome id when `ids` is given, into the 2 × 2 pixel block (bi, bj) of a preview tile. */
function putBlock(out: Uint8ClampedArray, ids: Uint8Array | undefined, bi: number, bj: number, rgb: number, biome: number): void {
  for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
    const px = (2 * bj + dj) * TILE + 2 * bi + di;
    put(out, 4 * px, rgb);
    if (ids !== undefined) ids[px] = biome;
  }
}

/**
 * The preview level samples one point per 2 × 2 pixel block, at the block's centre, and shades from the
 * neighbouring blocks (4× cheaper; a preview pixel is already 256 blocks wide). Shaded layers sample each
 * block once (SP2b spec §2.4): at this level their colour reads only surfaceEst and surfaceWaterLevel,
 * and every other field it reads is a constant of sampleCoarse (no river, no lake).
 */
function paintPreview(ctx: GenContext, layer: LayerId, tx: number, tz: number, out: Uint8ClampedArray, stop: () => boolean, ids: Uint8Array | undefined, cave: CaveAt | null): Uint8ClampedArray | null {
  const b = 256;
  const x0 = TILE * b * tx;
  const z0 = TILE * b * tz;
  const WH = HALF + 2;
  const at = (bi: number, bj: number) => samplePixel(ctx, 256, x0 + b * (2 * bi + 1), z0 + b * (2 * bj + 1), P);
  if (!NEEDS_RELIEF(layer)) {
    for (let bj = 0; bj < HALF; bj++) {
      if (stop()) return null;
      for (let bi = 0; bi < HALF; bi++) {
        const p = at(bi, bj);
        const id = cave === null ? p.biome : CAVE_ID(cave.picker, p, cave.y);
        putBlock(out, ids, bi, bj, cave === null ? COLOR(layer, p, 1) : CAVE_COLOR(id, p, 1), id);
      }
    }
    return out;
  }
  for (let bj = -1; bj <= HALF; bj++) {
    if (stop()) return null;
    for (let bi = -1; bi <= HALF; bi++) {
      const p = at(bi, bj);
      const k = (bj + 1) * WH + (bi + 1);
      HEIGHT[k] = p.surfaceEst;
      WATER_LEVEL[k] = p.surfaceWaterLevel;
    }
  }
  // P keeps the constant fields of its last sampleCoarse; restore the two that vary.
  for (let bj = 0; bj < HALF; bj++) for (let bi = 0; bi < HALF; bi++) {
    const k0 = (bj + 1) * WH + (bi + 1);
    P.surfaceEst = HEIGHT[k0]!;
    P.surfaceWaterLevel = WATER_LEVEL[k0]!;
    const k = SLOPE(HEIGHT[k0 - 1]!, HEIGHT[k0 + 1]!, HEIGHT[k0 - WH]!, HEIGHT[k0 + WH]!, 2 * b);
    putBlock(out, undefined, bi, bj, COLOR(layer, P, k), 0);
  }
  return out;
}

/**
 * Paints tile (tx, tz) of `layer` at level b into `out` (256·256·4 bytes, alpha 255), or returns null
 * as soon as `stop()` returns true (`out` is then partly written). `stop` is polled once per block row of
 * a preview tile's sampling pass, once per row of an unshaded fine tile and once per row of a shaded fine
 * tile's sampling pass. For layer 'biome', `ids` (256·256 entries) receives each pixel's biome id (at the
 * preview, the 2 × 2 block's sample); for layer 'caveBiome', painted at height `y` (an integer in −64 … 319, required
 * for it, a RangeError otherwise), each pixel's cave-biome id (`caveBiomeIdAt`: 0-3, 255 above the ground); other
 * layers leave it untouched.
 */
export function paintTileAbortable(ctx: GenContext, layer: LayerId, b: Level, tx: number, tz: number, out: Uint8ClampedArray, stop: () => boolean, ids?: Uint8Array, y?: number): Uint8ClampedArray | null {
  const biomeIds = layer === 'biome' || layer === 'caveBiome' ? ids : undefined;
  const cave = caveAtOf(ctx, layer, y);
  if (b === 256) return paintPreview(ctx, layer, tx, tz, out, stop, biomeIds, cave);
  const x0 = TILE * b * tx;
  const z0 = TILE * b * tz;
  if (!NEEDS_RELIEF(layer)) {
    for (let j = 0; j < TILE; j++) {
      if (stop()) return null;
      for (let i = 0; i < TILE; i++) {
        const p = samplePixel(ctx, b, x0 + b * (i + 0.5), z0 + b * (j + 0.5), P);
        const id = cave === null ? p.biome : CAVE_ID(cave.picker, p, cave.y);
        put(out, 4 * (j * TILE + i), cave === null ? COLOR(layer, p, 1) : CAVE_COLOR(id, p, 1));
        if (biomeIds !== undefined) biomeIds[j * TILE + i] = id;
      }
    }
    return out;
  }
  // One sampling pass over the tile plus a one-pixel border, keeping only what shaded layers read.
  for (let j = -1; j <= TILE; j++) {
    if (stop()) return null;
    for (let i = -1; i <= TILE; i++) {
      const k = (j + 1) * W + (i + 1);
      const p = samplePixel(ctx, b, x0 + b * (i + 0.5), z0 + b * (j + 0.5), P);
      HEIGHT[k] = p.surfaceEst;
      WATER_LEVEL[k] = p.surfaceWaterLevel;
      RIVER_DIST[k] = p.riverDist;
      LAKE_MASK[k] = p.lakeMask;
      LAKE_LEVEL[k] = p.lakeLevel;
      FLAGS[k] = (p.riverWet ? 1 : 0) | (p.gorge ? 2 : 0);
    }
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

/** Paints tile (tx, tz) of `layer` at level b into `out` (256·256·4 bytes, alpha 255); `y` for layer 'caveBiome'. */
export function paintTile(ctx: GenContext, layer: LayerId, b: Level, tx: number, tz: number, out: Uint8ClampedArray, y?: number): Uint8ClampedArray {
  return paintTileAbortable(ctx, layer, b, tx, tz, out, NEVER, undefined, y)!;
}

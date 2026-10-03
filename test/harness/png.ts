/**
 * PNG slices of a generated region (SP3a spec §6.1): a small PNG encoder over `node:zlib` (8-bit RGBA, one IDAT,
 * filter 0 on every row) and vertical (an x or a z plane) and horizontal (a y plane) slices drawn with the Voxels
 * palette of the cut line (§5.2, `src/ui/crossSection/voxels.ts`): air in a sky colour, stone grey, bedrock near
 * black, water blue darkening with depth below the water surface, and the sea-level line at y 63 on the air of
 * vertical slices.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb, type Rgb } from '../../src/ui/crossSection/voxels';
import { fluidType } from '../../src/world/blocks/fluid';
import { AIR } from '../../src/world/blocks/index';
import type { RegionView } from './region';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** 4 bytes per pixel, row-major from the top-left pixel. */
  readonly rgba: Uint8Array;
}

/** The Voxels palette lives with the cut line's Voxels mode (§5.2), so the PNGs and the page draw the same colours. */
export { SEA_LEVEL_Y, VOXEL_COLORS, voxelRgb };
const MIN_Y = -64;
const MAX_Y = 319;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes an RGBA image as a PNG file (colour type 6, bit depth 8, no interlace). */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, rgba } = img;
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 0x7fffffff) throw new RangeError(`encodePng: ${name} ${v}`);
  }
  if (rgba.length !== 4 * width * height) throw new RangeError(`encodePng: ${rgba.length} bytes for ${width} × ${height} RGBA`);
  const raw = Buffer.alloc(height * (1 + 4 * width));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(4 * width * y, 4 * width * (y + 1)), y * (1 + 4 * width) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export function writePng(path: string, img: RgbaImage): void {
  writeFileSync(path, encodePng(img));
}

export interface VerticalSliceOptions {
  /** Lowest y drawn (default −64); the bottom row. */
  readonly yMin?: number;
  /** Highest y drawn (default 319); row 0. */
  readonly yMax?: number;
}

function yRange(opts: VerticalSliceOptions): [number, number] {
  const yMin = opts.yMin ?? MIN_Y;
  const yMax = opts.yMax ?? MAX_Y;
  if (!Number.isInteger(yMin) || !Number.isInteger(yMax) || yMin < MIN_Y || yMax > MAX_Y || yMin > yMax) {
    throw new RangeError(`slice: y range ${yMin} … ${yMax} outside ${MIN_Y} … ${MAX_Y}`);
  }
  return [yMin, yMax];
}

function setPx(rgba: Uint8Array, at: number, c: Rgb): void {
  rgba[at] = c[0];
  rgba[at + 1] = c[1];
  rgba[at + 2] = c[2];
  rgba[at + 3] = 255;
}

/** One voxel's colour; the water surface of its column is `worldSurfaceWG − 1` (§3.4: water counts). */
function colorAt(view: RegionView, x: number, y: number, z: number, line: boolean): Rgb {
  const state = view.block(x, y, z);
  const fluid = view.fluid(x, y, z);
  if (line && y === SEA_LEVEL_Y && state === AIR && fluidType(fluid) === 0) return VOXEL_COLORS.seaLevel;
  return voxelRgb(state, fluid, view.worldSurfaceWG(x, z) - 1 - y);
}

function vertical(view: RegionView, at: (i: number) => [number, number], width: number, opts: VerticalSliceOptions): RgbaImage {
  const [yMin, yMax] = yRange(opts);
  const height = yMax - yMin + 1;
  const rgba = new Uint8Array(4 * width * height);
  for (let i = 0; i < width; i++) {
    const [x, z] = at(i);
    for (let y = yMax; y >= yMin; y--) setPx(rgba, 4 * ((yMax - y) * width + i), colorAt(view, x, y, z, true));
  }
  return { width, height, rgba };
}

function checkPlane(what: string, v: number, lo: number, n: number): void {
  if (!Number.isInteger(v) || v < lo || v >= lo + n) throw new RangeError(`${what} = ${v} outside the region (${lo} … ${lo + n - 1})`);
}

/** The x plane at `x`: z across (the region's z extent, increasing), y down from `yMax`. */
export function sliceX(view: RegionView, x: number, opts: VerticalSliceOptions = {}): RgbaImage {
  checkPlane('sliceX: x', x, 16 * view.cx0, 16 * view.w);
  const z0 = 16 * view.cz0;
  return vertical(view, (i) => [x, z0 + i], 16 * view.h, opts);
}

/** The z plane at `z`: x across (the region's x extent, increasing), y down from `yMax`. */
export function sliceZ(view: RegionView, z: number, opts: VerticalSliceOptions = {}): RgbaImage {
  checkPlane('sliceZ: z', z, 16 * view.cz0, 16 * view.h);
  const x0 = 16 * view.cx0;
  return vertical(view, (i) => [x0 + i, z], 16 * view.w, opts);
}

/** The y plane at `y`: x across, z down (north at the top); no sea-level line. */
export function sliceY(view: RegionView, y: number): RgbaImage {
  checkPlane('sliceY: y', y, MIN_Y, MAX_Y - MIN_Y + 1);
  const width = 16 * view.w;
  const height = 16 * view.h;
  const x0 = 16 * view.cx0;
  const z0 = 16 * view.cz0;
  const rgba = new Uint8Array(4 * width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) setPx(rgba, 4 * (j * width + i), colorAt(view, x0 + i, y, z0 + j, false));
  }
  return { width, height, rgba };
}

/**
 * The SP3a visual review (spec §12, master §10 "PNG slices … attached to the SP spec"): the harness PNG slices of
 * the provisional T stage, at world seed '42' on the default profile — vertical slices across a coast, a lake and a
 * river, and a horizontal slice at y 62 — written by `npm run docs:review-slices` into
 * `docs/superpowers/specs/assets/sp3a/`.
 *
 * Each site states which kinds of position its line crosses (`needs`), and `lineKinds` re-derives them from the
 * ColumnSample (the §4 inputs), so a change of the 2D world that moves a coast, a lake or a river away from its
 * site fails the unit test instead of silently writing a slice without it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Params } from '../../src/core/params/schema';
import {
  buildColumnSample, latticeIndex, newColumnSample, readField, readLevel, riverWetAt, type ColumnSample,
} from '../../src/gen/column/columnStage';
import type { GenContext } from '../../src/gen/context';
import { genRegion, type RegionView } from './region';
import { encodePng, sliceY, sliceZ, type RgbaImage } from './png';

/** What a block position holds on the provisional T: dry land, or water of the sea, a lake or a river. */
export type ReviewKind = 'land' | 'sea' | 'lake' | 'river';

export const REVIEW_KINDS: readonly ReviewKind[] = ['land', 'sea', 'lake', 'river'];

/**
 * The kind of position (x, z), from a ColumnSample built for its column: land when it holds no water voxel
 * (`⌊surfaceWaterLevel⌋ ≤ ⌊surfaceEst⌋`, or no water level at all); otherwise a lake when the nearest quart corner
 * (as `readLevel` picks it) is inside a lake mask, a river when that corner is a wet river channel, else the sea.
 */
export function positionKind(s: ColumnSample, x: number, z: number): ReviewKind {
  const lx = x - 16 * s.cx;
  const lz = z - 16 * s.cz;
  if (lx < 0 || lx > 15 || lz < 0 || lz > 15) throw new RangeError(`positionKind: (${x}, ${z}) is outside column (${s.cx}, ${s.cz})`);
  const top = Math.floor(readField(s, 'surfaceEst', x, z));
  const swl = readLevel(s, 'surfaceWaterLevel', x, z);
  if (swl === -Infinity || Math.floor(swl) <= top) return 'land';
  const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
  if (s.f.lakeMask[k] === 1) return 'lake';
  return riverWetAt(s, k) ? 'river' : 'sea';
}

/**
 * A vertical slice: the z plane `z` of the one-row region of columns cx0 … cx0 + w − 1 at cz = z >> 4, x across,
 * y from `yMax` (row 0) down to `yMin`.
 */
export interface VerticalSite {
  readonly name: string;
  readonly file: string;
  readonly kind: 'vertical';
  readonly cx0: number;
  readonly w: number;
  readonly z: number;
  readonly yMin: number;
  readonly yMax: number;
  /** Nearest-neighbour upscale of the PNG (1: one pixel per block). */
  readonly scale: number;
  /** Kinds the slice line must cross. */
  readonly needs: readonly ReviewKind[];
}

/** A horizontal slice: the y plane `y` of a w × h region, x across, z down (north at the top). */
export interface HorizontalSite {
  readonly name: string;
  readonly file: string;
  readonly kind: 'horizontal';
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
  readonly y: number;
  /** The row checked against `needs` (a full-region scan would cost a ColumnSample per column). */
  readonly checkZ: number;
  readonly needs: readonly ReviewKind[];
}

export type ReviewSite = VerticalSite | HorizontalSite;

/** The row z = −31992 (column row cz −2000, lz 8) of world seed '42', default profile, found by a scan. */
const ROW_CZ = -2000;
const ROW_Z = 16 * ROW_CZ + 8;

/**
 * The review sites (world seed '42', default profile). Vertical slices are cropped in y: the tests check that every
 * column's water and ground surface lies inside the crop, so it removes only air above and stone below. The lake and
 * river slices are narrow bands and are drawn at 2 pixels per block.
 */
export const REVIEW_SITES: readonly ReviewSite[] = [
  {
    name: 'coast', file: 'slice-coast.png', kind: 'vertical', cx0: -1696, w: 64, z: ROW_Z, yMin: -64, yMax: 159, scale: 1,
    needs: ['sea', 'land'],
  },
  {
    name: 'lake', file: 'slice-lake.png', kind: 'vertical', cx0: -1024, w: 32, z: ROW_Z, yMin: 32, yMax: 95, scale: 2,
    needs: ['lake', 'land'],
  },
  {
    name: 'river', file: 'slice-river.png', kind: 'vertical', cx0: -972, w: 32, z: ROW_Z, yMin: 32, yMax: 95, scale: 2,
    needs: ['river', 'land'],
  },
  {
    name: 'y62', file: 'slice-y62.png', kind: 'horizontal', cx0: -1696, cz0: ROW_CZ - 32, w: 64, h: 64, y: 62, checkZ: ROW_Z,
    needs: ['sea', 'land'],
  },
];

/** Kind counts (block positions) along a site's line: the vertical slice's line, or a horizontal site's `checkZ` row. */
export function lineKinds(ctx: GenContext, site: ReviewSite): Record<ReviewKind, number> {
  const out: Record<ReviewKind, number> = { land: 0, sea: 0, lake: 0, river: 0 };
  const z = site.kind === 'vertical' ? site.z : site.checkZ;
  const cz = z >> 4;
  const s = newColumnSample();
  for (let cx = site.cx0; cx < site.cx0 + site.w; cx++) {
    buildColumnSample(ctx, cx, cz, s);
    for (let lx = 0; lx < 16; lx++) out[positionKind(s, 16 * cx + lx, z)]++;
  }
  return out;
}

/** Each pixel of `img` as a k × k block. */
export function upscale(img: RgbaImage, k: number): RgbaImage {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`upscale: factor ${k}`);
  if (k === 1) return img;
  const width = img.width * k;
  const height = img.height * k;
  const rgba = new Uint8Array(4 * width * height);
  const src = new Uint32Array(img.rgba.buffer, img.rgba.byteOffset, img.width * img.height);
  const dst = new Uint32Array(rgba.buffer);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / k) * img.width;
    for (let x = 0; x < width; x++) dst[y * width + x] = src[row + Math.floor(x / k)]!;
  }
  return { width, height, rgba };
}

/** The PNG image of a site over its generated region. */
export function renderSite(view: RegionView, site: ReviewSite): RgbaImage {
  if (site.kind === 'horizontal') return sliceY(view, site.y);
  return upscale(sliceZ(view, site.z, { yMin: site.yMin, yMax: site.yMax }), site.scale);
}

/** Generates a site's region: provisional T, cold (no region cache), spiral order, 1 thread. */
export async function generateSite(seed: string, params: Params, site: ReviewSite): Promise<RegionView> {
  const h = site.kind === 'vertical' ? 1 : site.h;
  const cz0 = site.kind === 'vertical' ? site.z >> 4 : site.cz0;
  const r = await genRegion({ seed, params, cx0: site.cx0, cz0, w: site.w, h, upTo: 'T', order: 'spiral', threads: 1 });
  return r.view;
}

export interface WrittenSlice {
  readonly site: ReviewSite;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Generates every site and writes its PNG into `dir` (created if missing). */
export async function writeReviewSlices(dir: string, seed: string, params: Params, sites: readonly ReviewSite[] = REVIEW_SITES): Promise<WrittenSlice[]> {
  mkdirSync(dir, { recursive: true });
  const out: WrittenSlice[] = [];
  for (const site of sites) {
    const img = renderSite(await generateSite(seed, params, site), site);
    const png = encodePng(img);
    const path = join(dir, site.file);
    writeFileSync(path, png);
    out.push({ site, path, width: img.width, height: img.height, bytes: png.length });
  }
  return out;
}

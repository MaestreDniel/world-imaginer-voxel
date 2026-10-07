/**
 * The visual review (SP3b spec §7, §11; SP3a spec §12; master §10 "PNG slices … attached to the SP spec"): the harness
 * PNG slices of the T stage, at world seed '42' on the default profile — vertical slices across a coast, a lake, a
 * river and a mountain, and a horizontal slice at y 62 — written by `npm run docs:review-slices` into
 * `docs/superpowers/specs/assets/sp3b/` (SP3a's slices of the provisional T stay in `assets/sp3a/`).
 *
 * Each site states which kinds of position its line crosses (`needs`). The kinds and the crop checks are read from
 * the voxels (SP3b §7): a position is wet when water stands above its highest stone, and only the water body (sea,
 * lake or river) comes from the ColumnSample, so a world change that moves a coast, a lake or a river away from its
 * site fails the unit test instead of silently writing a slice without it, and an overhang is checked as voxels.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { biomeFamily } from '../../src/gen/biomes/registry';
import {
  buildColumnSample, latticeIndex, newColumnSample, readBiome, readField, riverWetAt, type ColumnSample,
} from '../../src/gen/column/columnStage';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { fluidType } from '../../src/world/blocks/fluid';
import { AIR } from '../../src/world/blocks/index';
import { genRegion, type RegionView } from './region';
import { encodePng, sliceY, sliceZ, type RgbaImage } from './png';

/** What a block position holds: dry land, or water of the sea, a lake or a river. */
export type ReviewKind = 'land' | 'sea' | 'lake' | 'river';

export const REVIEW_KINDS: readonly ReviewKind[] = ['land', 'sea', 'lake', 'river'];

/** The σ a mountain site's line must exceed (SP3b spec §7 "a highland site with σ > 8"). */
export const MOUNTAIN_SIGMA = 8;

const MIN_Y = -64;
const MAX_Y = 319;
/** T2's overhang window (SP3b spec §8.2): transitions in [top − 30, top]. */
const OVERHANG_DEPTH = 30;

/** One position's column, read from the voxels. */
export interface PositionVoxels {
  /** The true top: the highest solid voxel (`OCEAN_FLOOR_WG − 1`). */
  readonly top: number;
  /** The water surface above the top (`WORLD_SURFACE_WG − 1`), or null when no water stands above the top. */
  readonly water: number | null;
  /** The lowest air voxel (with or without water) above the bedrock: the crop's yMin must not cut it. */
  readonly lowestOpen: number;
  /** The highest voxel that is not dry air (stone or water): the crop's yMax must not cut it. */
  readonly highestFilled: number;
  /** Solid→air transitions (solid at y, air at y + 1) with y in [top − 30, top] (T2's count). */
  readonly transitions: number;
  /** Water voxels below the top (under an overhang). */
  readonly waterUnderTop: number;
}

const solidAt = (view: RegionView, x: number, y: number, z: number): boolean => y <= MAX_Y && view.block(x, y, z) !== AIR;
const wetAt = (view: RegionView, x: number, y: number, z: number): boolean => view.block(x, y, z) === AIR && fluidType(view.fluid(x, y, z)) !== 0;

export function positionVoxels(view: RegionView, x: number, z: number): PositionVoxels {
  const top = view.oceanFloorWG(x, z) - 1;
  const surface = view.worldSurfaceWG(x, z) - 1;
  let lowestOpen = MAX_Y + 1;
  let highestFilled = MIN_Y;
  let transitions = 0;
  let waterUnderTop = 0;
  for (let y = MIN_Y; y <= MAX_Y; y++) {
    const solid = solidAt(view, x, y, z);
    const wet = !solid && wetAt(view, x, y, z);
    if (!solid && y < lowestOpen) lowestOpen = y;
    if (solid || wet) highestFilled = y;
    if (wet && y < top) waterUnderTop++;
    if (solid && !solidAt(view, x, y + 1, z) && y >= top - OVERHANG_DEPTH && y <= top) transitions++;
  }
  return { top, water: surface > top ? surface : null, lowestOpen, highestFilled, transitions, waterUnderTop };
}

/**
 * The kind of position (x, z): land when no water stands above its highest stone (on the voxels); otherwise the water
 * body of the quart corner the T stage reads its level from (`readLevel`'s nearest corner): a lake when that corner is
 * inside a lake mask, a river when it is a wet river channel, else the sea. `s` must be the sample of (x, z)'s column.
 */
export function positionKind(view: RegionView, s: ColumnSample, x: number, z: number): ReviewKind {
  const lx = x - 16 * s.cx;
  const lz = z - 16 * s.cz;
  if (lx < 0 || lx > 15 || lz < 0 || lz > 15) throw new RangeError(`positionKind: (${x}, ${z}) is outside column (${s.cx}, ${s.cz})`);
  if (view.worldSurfaceWG(x, z) <= view.oceanFloorWG(x, z)) return 'land';
  const k = latticeIndex(Math.min(4, Math.max(0, Math.round(lx / 4 - 1e-9))), Math.min(4, Math.max(0, Math.round(lz / 4 - 1e-9))));
  if (s.f.lakeMask[k] === 1) return 'lake';
  return riverWetAt(s, k) ? 'river' : 'sea';
}

/** `positionKind` along the row z of `view`, building each column's ColumnSample once. */
export function kindReader(ctx: GenContext, view: RegionView, z: number): (x: number) => ReviewKind {
  const s = newColumnSample();
  let cx = Number.NaN;
  return (x) => {
    if (x >> 4 !== cx) buildColumnSample(ctx, (cx = x >> 4), z >> 4, s);
    return positionKind(view, s, x, z);
  };
}

/** A line's kinds and voxel facts, for the slices' summary (`slices.json`) and the rulings. */
export interface LineSummary {
  readonly kinds: Record<ReviewKind, number>;
  /** The lowest and highest true top on the line. */
  readonly topMin: number;
  readonly topMax: number;
  /** The highest water surface above a top, or null when the line is dry. */
  readonly waterMax: number | null;
  /** Land positions with ≥ 2 solid→air transitions in [top − 30, top] (T2's overhang count). */
  readonly overhangs: number;
  /** Water voxels' faces along the line (x ± 1, same y) that touch dry air: the v0 water walls (SP3b §4). */
  readonly waterWallFaces: number;
  /** Water voxels under the true top. */
  readonly waterUnderStone: number;
}

/** The summary of the n positions x0 … x0 + n − 1 of row z of `view`, with each position's kind from `kindOf`. */
export function lineSummary(view: RegionView, z: number, x0: number, n: number, kindOf: (x: number) => ReviewKind): LineSummary {
  const kinds: Record<ReviewKind, number> = { land: 0, sea: 0, lake: 0, river: 0 };
  let topMin = Infinity;
  let topMax = -Infinity;
  let waterMax: number | null = null;
  let overhangs = 0;
  let waterWallFaces = 0;
  let waterUnderStone = 0;
  const dryAir = (x: number, y: number) => x >= x0 && x < x0 + n && view.block(x, y, z) === AIR && fluidType(view.fluid(x, y, z)) === 0;
  for (let x = x0; x < x0 + n; x++) {
    const kind = kindOf(x);
    kinds[kind]++;
    const p = positionVoxels(view, x, z);
    topMin = Math.min(topMin, p.top);
    topMax = Math.max(topMax, p.top);
    if (p.water !== null) waterMax = Math.max(waterMax ?? -Infinity, p.water);
    if (kind === 'land' && p.transitions >= 2) overhangs++;
    waterUnderStone += p.waterUnderTop;
    for (let y = MIN_Y; y <= MAX_Y; y++) {
      if (!wetAt(view, x, y, z)) continue;
      if (dryAir(x - 1, y)) waterWallFaces++;
      if (dryAir(x + 1, y)) waterWallFaces++;
    }
  }
  return { kinds, topMin, topMax, waterMax, overhangs, waterWallFaces, waterUnderStone };
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
  /** The row checked against `needs` (a full-region check would generate all w × h columns). */
  readonly checkZ: number;
  readonly needs: readonly ReviewKind[];
}

export type ReviewSite = VerticalSite | HorizontalSite;

/** The row z = −31992 (column row cz −2000, lz 8) of world seed '42', default profile, found by a scan (SP3a). */
const ROW_CZ = -2000;
const ROW_Z = 16 * ROW_CZ + 8;

/**
 * The review sites (world seed '42', default profile). Vertical slices are cropped in y: the tests check on the
 * voxels that the crop removes only dry air above and solid voxels below. The lake and river slices are narrow
 * bands and are drawn at 2 pixels per block.
 *
 * The mountain was found by a scan of the 2D world: rows cz −1024 … 960 (step 64) and −786, every 64-column window
 * over cx −1088 … 1023, scored by the quart points of the row lz 8 that are highland with σ > 8. The window
 * cx −104 … −41 at cz 0 ranked first, with all 256 points (σ up to 15.9). After the SP3b retune (§8.4) the scan
 * gives seven rows a full 256-point window; the six generated have 75 … 214 overhang positions of 1024 and this row
 * the most (214), so the line stays: its voxel tops run 140 … 257, with undercut crests and floating rocks.
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
    name: 'river', file: 'slice-river.png', kind: 'vertical', cx0: -972, w: 32, z: ROW_Z, yMin: 32, yMax: 127, scale: 2,
    needs: ['river', 'land'],
  },
  {
    name: 'mountain', file: 'slice-mountain.png', kind: 'vertical', cx0: -104, w: 64, z: 8, yMin: 64, yMax: 319, scale: 1,
    needs: ['land'],
  },
  {
    name: 'y62', file: 'slice-y62.png', kind: 'horizontal', cx0: -1696, cz0: ROW_CZ - 32, w: 64, h: 64, y: 62, checkZ: ROW_Z,
    needs: ['sea', 'land'],
  },
];

/** The line a site's kinds are read on: the vertical slice's line, or a horizontal site's `checkZ` row. */
export function siteLine(site: ReviewSite): { readonly z: number; readonly x0: number; readonly n: number } {
  return { z: site.kind === 'vertical' ? site.z : site.checkZ, x0: 16 * site.cx0, n: 16 * site.w };
}

/** The share of a vertical site's line positions whose 2D surface biome is highland with σ > MOUNTAIN_SIGMA. */
export function mountainShare(ctx: GenContext, site: VerticalSite): number {
  const s = newColumnSample();
  let hits = 0;
  for (let cx = site.cx0; cx < site.cx0 + site.w; cx++) {
    buildColumnSample(ctx, cx, site.z >> 4, s);
    for (let x = 16 * cx; x < 16 * cx + 16; x++) {
      if (biomeFamily(readBiome(s, ctx, x, site.z)) === 'highland' && readField(s, 'sigma', x, site.z) > MOUNTAIN_SIGMA) hits++;
    }
  }
  return hits / (16 * site.w);
}

/** What is wrong with a vertical site's crop, read from the voxels: an open voxel below yMin or a filled one above yMax. */
export function cropProblems(view: RegionView, site: VerticalSite): string[] {
  const out: string[] = [];
  const { z, x0, n } = siteLine(site);
  for (let x = x0; x < x0 + n; x++) {
    const p = positionVoxels(view, x, z);
    if (p.lowestOpen < site.yMin) out.push(`(${x}, ${z}): open at y ${p.lowestOpen}, below the crop`);
    if (p.highestFilled > site.yMax) out.push(`(${x}, ${z}): filled at y ${p.highestFilled}, above the crop`);
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

/** Generates a site's region: T, cold (no region cache), spiral order, 1 thread. */
export async function generateSite(seed: string, params: Params, site: ReviewSite): Promise<RegionView> {
  const h = site.kind === 'vertical' ? 1 : site.h;
  const cz0 = site.kind === 'vertical' ? site.z >> 4 : site.cz0;
  const r = await genRegion({ seed, params, cx0: site.cx0, cz0, w: site.w, h, upTo: 'T', order: 'spiral', threads: 1 });
  return r.view;
}

/** Generates only the one-row region of a site's line (a horizontal site's `checkZ` row), for the unit checks. */
export async function generateLine(seed: string, params: Params, site: ReviewSite): Promise<RegionView> {
  const { z } = siteLine(site);
  const r = await genRegion({ seed, params, cx0: site.cx0, cz0: z >> 4, w: site.w, h: 1, upTo: 'T', order: 'spiral', threads: 1 });
  return r.view;
}

export interface WrittenSlice {
  readonly site: ReviewSite;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** The site's line, read from the same generated voxels. */
  readonly summary: LineSummary;
}

/** Generates every site and writes its PNG into `dir` (created if missing). */
export async function writeReviewSlices(dir: string, seed: string, params: Params, sites: readonly ReviewSite[] = REVIEW_SITES): Promise<WrittenSlice[]> {
  mkdirSync(dir, { recursive: true });
  const ctx = createGenContext(seedFromInput(seed), params);
  const out: WrittenSlice[] = [];
  for (const site of sites) {
    const view = await generateSite(seed, params, site);
    const img = renderSite(view, site);
    const png = encodePng(img);
    const path = join(dir, site.file);
    writeFileSync(path, png);
    const { z, x0, n } = siteLine(site);
    out.push({ site, path, width: img.width, height: img.height, bytes: png.length, summary: lineSummary(view, z, x0, n, kindReader(ctx, view, z)) });
  }
  return out;
}

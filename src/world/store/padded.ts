/**
 * Padded copies of the store for the light and mesh jobs (SP4a spec §4.3, §5.1; master §4.4, §4.8): the only store
 * file `light/` and `mesh/` may value-import. Two layouts, each with its index function and its copy routine:
 *
 * - the **mesh section**: 18³ voxels, a section plus one voxel on every side, copied from the 3 × 3 columns' final
 *   sets (blocks u16, light u8, fluid u8). Below y −64 it reads `BEDROCK`, light 0 and no fluid; above y 319 air with
 *   sky 15 (0xF0) and no fluid;
 * - the **light region**: 46 × 384 × 46 voxels (15 + 16 + 15 around the centre column, the whole height), with the
 *   final blocks and fluid and the nine columns' `LIGHT_BLOCKING`; its `light` array is the light job's output.
 *
 * Both read through `NeighborhoodReader` and the `ColumnView` section accessors, filling uniform sections, and throw
 * when one of the 3 × 3 columns has no final set (the coordinator never runs a job before its prerequisites).
 */
import { AIR, BEDROCK } from '../blocks/index';
import type { ColumnView, NeighborhoodReader } from './api';

const AIR_STATE = AIR;
const BEDROCK_STATE = BEDROCK;

/** Sections per column and the world's lowest y (SP3a spec §3). */
const SECTIONS = 24;
const Y_MIN = -64;
/** The light byte above the world: sky 15, block 0. */
const ABOVE_LIGHT = 0xF0;

/** The padded section's side: a 16-voxel section plus one voxel each side. */
export const PAD = 18;
/** Voxels in a padded section (18³). */
export const PAD_VOXELS = 5832;
const PAD_LAYER = PAD * PAD;

/** Index of section-local (x, y, z), each −1 … 16, in a padded section: `(y+1)·324 + (z+1)·18 + (x+1)`. */
export function padIndex(x: number, y: number, z: number): number {
  return (y + 1) * PAD_LAYER + (z + 1) * PAD + (x + 1);
}

/** A section with its one-voxel border (SP4a spec §5.1), indexed by `padIndex`. */
export interface PaddedSection {
  readonly blocks: Uint16Array;
  readonly light: Uint8Array;
  readonly fluid: Uint8Array;
}

export function createPaddedSection(): PaddedSection {
  return { blocks: new Uint16Array(PAD_VOXELS), light: new Uint8Array(PAD_VOXELS), fluid: new Uint8Array(PAD_VOXELS) };
}

/** The light region's side in x and z: 15 + 16 + 15 (the maximum light reach around the centre column). */
export const LIGHT_W = 46;
/** The light region's height: the whole column, y −64 … 319. */
export const LIGHT_H = 384;
/** The lowest column-local x and z of the light region. */
export const LIGHT_LO = -15;
const LIGHT_LAYER = LIGHT_W * LIGHT_W;
/** Light region voxels (46 · 384 · 46). */
const LIGHT_VOXELS = LIGHT_LAYER * LIGHT_H;

/**
 * Index of (x, y, z) in the light region: x and z column-local in [−15, 31), y absolute in [−64, 320); y-major, then
 * z, then x: `((y + 64)·46 + (z + 15))·46 + (x + 15)`. `lightBlocking` is indexed by the last two terms alone,
 * `(z + 15)·46 + (x + 15)`.
 */
export function lightIndex(x: number, y: number, z: number): number {
  return ((y - Y_MIN) * LIGHT_W + (z - LIGHT_LO)) * LIGHT_W + (x - LIGHT_LO);
}

/** The light job's region (SP4a spec §4.2), allocated once per worker (≈ 1.6 MB blocks, 0.8 MB fluid, 0.8 MB light). */
export interface LightRegion {
  readonly blocks: Uint16Array;
  readonly fluid: Uint8Array;
  readonly light: Uint8Array;
  /** 46 · 46: the absolute y of each position's `LIGHT_BLOCKING` heightmap (aux A). */
  readonly lightBlocking: Int16Array;
}

export function createLightRegion(): LightRegion {
  return {
    blocks: new Uint16Array(LIGHT_VOXELS),
    fluid: new Uint8Array(LIGHT_VOXELS),
    light: new Uint8Array(LIGHT_VOXELS),
    lightBlocking: new Int16Array(LIGHT_LAYER),
  };
}

function finalOf(nb: NeighborhoodReader, dx: number, dz: number, who: string): ColumnView {
  const v = nb.final(dx, dz);
  if (v === null) throw new Error(`${who}: column (${nb.cx + dx}, ${nb.cz + dz}) has no final set`);
  return v;
}

/**
 * Writes the box of section-local voxels lx ∈ [x0, x1), ly ∈ [y0, y1), lz ∈ [z0, z1) of one channel (`src`: a
 * 4096-entry section, voxel `ly<<8|lz<<4|lx`, or a uniform value) into a padded array at `dst` index `base` +
 * `ly·layer + lz·row + lx`.
 */
function copyBox(
  dst: Uint8Array | Uint16Array, src: Uint8Array | Uint16Array | number, base: number, row: number, layer: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): void {
  for (let ly = y0; ly < y1; ly++) {
    for (let lz = z0; lz < z1; lz++) {
      const d = base + ly * layer + lz * row;
      if (typeof src === 'number') {
        dst.fill(src, d + x0, d + x1);
      } else {
        const s = (ly << 8) | (lz << 4);
        for (let lx = x0; lx < x1; lx++) dst[d + lx] = src[s + lx]!;
      }
    }
  }
}

/** The local range [lo, hi) of a neighbour at offset `d` (−1, 0, 1) that a border of `reach` voxels covers. */
const lo = (d: number, reach: number): number => (d < 0 ? 16 - reach : 0);
const hi = (d: number, reach: number): number => (d > 0 ? reach : 16);

/**
 * Copies section `sy` (0 … 23) of the centre column with its one-voxel border from the 3 × 3 final sets into `out`
 * (SP4a spec §5.1). The border's sections below y −64 read `BEDROCK`, light 0 and no fluid; above y 319, air with
 * light 0xF0 and no fluid.
 */
export function copyPaddedSection(nb: NeighborhoodReader, sy: number, out: PaddedSection): void {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`copyPaddedSection: section ${sy} outside 0 … ${SECTIONS - 1}`);
  const { blocks, light, fluid } = out;
  for (let dz = -1; dz <= 1; dz++) {
    const z0 = lo(dz, 1);
    const z1 = hi(dz, 1);
    for (let dx = -1; dx <= 1; dx++) {
      const x0 = lo(dx, 1);
      const x1 = hi(dx, 1);
      const v = finalOf(nb, dx, dz, 'copyPaddedSection');
      for (let dy = -1; dy <= 1; dy++) {
        const s = sy + dy;
        // Index of local (0, 0, 0) of this neighbour section in the padded array.
        const base = padIndex(16 * dx, 16 * dy, 16 * dz);
        const y0 = lo(dy, 1);
        const y1 = hi(dy, 1);
        const below = s < 0;
        const above = s >= SECTIONS;
        const b = below ? BEDROCK_STATE : above ? AIR_STATE : v.sectionBlocks(s);
        const l = below ? 0 : above ? ABOVE_LIGHT : v.sectionLight(s);
        const f = below || above ? 0 : v.sectionFluid(s);
        copyBox(blocks, b, base, PAD, PAD_LAYER, x0, x1, y0, y1, z0, z1);
        copyBox(light, l, base, PAD, PAD_LAYER, x0, x1, y0, y1, z0, z1);
        copyBox(fluid, f, base, PAD, PAD_LAYER, x0, x1, y0, y1, z0, z1);
      }
    }
  }
}

/**
 * Copies the light region of the centre column from the 3 × 3 final sets into `out` (SP4a spec §4.2 step 1): the
 * blocks and fluid of x, z ∈ [−15, 31) over the whole height, and each position's aux A `lightBlocking`. `out.light`
 * is left as it is (the light job writes it).
 */
export function copyLightRegion(nb: NeighborhoodReader, out: LightRegion): void {
  const reach = -LIGHT_LO;
  for (let dz = -1; dz <= 1; dz++) {
    const z0 = lo(dz, reach);
    const z1 = hi(dz, reach);
    for (let dx = -1; dx <= 1; dx++) {
      const x0 = lo(dx, reach);
      const x1 = hi(dx, reach);
      const v = finalOf(nb, dx, dz, 'copyLightRegion');
      const aux = v.aux();
      if (aux === null) throw new Error(`copyLightRegion: column (${nb.cx + dx}, ${nb.cz + dz}) has no aux A`);
      const heights = aux.lightBlocking;
      for (let lz = z0; lz < z1; lz++) {
        // lightBlocking is the y = −64 layer of the region's index: (z + 15)·46 + (x + 15).
        const row = lightIndex(16 * dx, Y_MIN, 16 * dz + lz);
        for (let lx = x0; lx < x1; lx++) out.lightBlocking[row + lx] = heights[lz * 16 + lx]!;
      }
      for (let sy = 0; sy < SECTIONS; sy++) {
        const base = lightIndex(16 * dx, Y_MIN + 16 * sy, 16 * dz);
        copyBox(out.blocks, v.sectionBlocks(sy), base, LIGHT_W, LIGHT_LAYER, x0, x1, 0, 16, z0, z1);
        copyBox(out.fluid, v.sectionFluid(sy), base, LIGHT_W, LIGHT_LAYER, x0, x1, 0, 16, z0, z1);
      }
    }
  }
}

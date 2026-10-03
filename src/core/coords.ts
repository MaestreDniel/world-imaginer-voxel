/**
 * Voxel coordinates, indices and numeric keys (master §2.1, SP3a spec §1). Every argument is an integer; x and z lie
 * in the half-open window [−2^19, 2^19) (SP2b spec §6.3), so cx and cz lie in [−2^15, 2^15) and a colKey is < 2^32.
 * No string keys anywhere.
 */
import { MIN_Y } from './constants';

const Y0 = MIN_Y;

/** Sections per column: y −64 … 319 in 24 sections of 16. */
export const SECTIONS = 24;
/** Voxels per section (16³). */
export const SECTION_VOXELS = 4096;
/** Highest block y (inclusive). */
export const MAX_Y = 319;
/** Vertical quarts per column (4-block cells): qy ∈ [0, 96). */
export const QUARTS_Y = 96;
/** Side of the loaded-column torus. */
export const TORUS_SIZE = 64;
/** Records in the torus (64 × 64). */
export const TORUS_RECORDS = 4096;
/** Half-width of the world window: x, z ∈ [−WINDOW_HALF, WINDOW_HALF). */
export const WINDOW_HALF = 524288;

/** Column (chunk) coordinate of a block coordinate: cx = x >> 4 (also cz from z). */
export const chunkCoord = (v: number): number => v >> 4;
/** Coordinate inside the column, 0 … 15: lx = x & 15 (also lz from z). */
export const localCoord = (v: number): number => v & 15;
/** Section index of a block y: sy = (y + 64) >> 4, 0 … 23. */
export const sectionY = (y: number): number => (y - Y0) >> 4;
/** y inside its section, 0 … 15. */
export const localY = (y: number): number => (y - Y0) & 15;
/** Absolute y of a section's lowest voxel: sy·16 − 64. */
export const sectionBaseY = (sy: number): number => sy * 16 + Y0;
/** True for y in the world's closed range [−64, 319]. */
export const yInWorld = (y: number): boolean => y >= Y0 && y <= MAX_Y;

/** Voxel index inside a section: ly << 8 | lz << 4 | lx (0 … 4095). */
export const voxelIndex = (lx: number, ly: number, lz: number): number => (ly << 8) | (lz << 4) | lx;
/** lx of a voxel index. */
export const voxelLx = (i: number): number => i & 15;
/** ly of a voxel index. */
export const voxelLy = (i: number): number => i >> 8;
/** lz of a voxel index. */
export const voxelLz = (i: number): number => (i >> 4) & 15;
/** Index in a 16 × 16 per-position column map (heightmaps, surfaceBiome): lz·16 + lx. */
export const columnIndex = (lx: number, lz: number): number => (lz << 4) | lx;

/** Numeric column key: (cx + 32768)·65536 + (cz + 32768), in [0, 2^32). */
export const colKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
/** cx of a colKey. */
export const colKeyCx = (key: number): number => Math.floor(key / 65536) - 32768;
/** cz of a colKey. */
export const colKeyCz = (key: number): number => (key % 65536) - 32768;
/** Numeric section key: colKey·32 + sy, in [0, 2^37). */
export const sectionKey = (cx: number, cz: number, sy: number): number => colKey(cx, cz) * 32 + sy;
/** colKey of a section key. */
export const sectionKeyColKey = (key: number): number => Math.floor(key / 32);
/** sy of a section key. */
export const sectionKeySy = (key: number): number => key % 32;

/** Record of a column in the 64 × 64 torus: (cx & 63) + 64·(cz & 63). Columns 64 apart share a record. */
export const torusSlot = (cx: number, cz: number): number => (cx & 63) + ((cz & 63) << 6);

/** Horizontal quart coordinate: qx = x >> 2 (also qz from z). */
export const quartCoord = (v: number): number => v >> 2;
/** Vertical quart coordinate: qy = (y + 64) >> 2, 0 … 95. */
export const quartY = (y: number): number => (y - Y0) >> 2;

/** True when the block (x, z) lies in the half-open window [−2^19, 2^19)². */
export const inWindow = (x: number, z: number): boolean =>
  x >= -WINDOW_HALF && x < WINDOW_HALF && z >= -WINDOW_HALF && z < WINDOW_HALF;
/** True when the column (cx, cz) lies in the window: cx, cz ∈ [−2^15, 2^15). */
export const columnInWindow = (cx: number, cz: number): boolean => cx >= -32768 && cx < 32768 && cz >= -32768 && cz < 32768;

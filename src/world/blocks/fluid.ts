/**
 * The fluid byte (SP3a spec §2.1, frozen): bits 0-2 level (0 = source … 7), bit 3 falling, bits 4-5 type (0 none,
 * 1 water, 2 lava), bit 6 unsettled, bit 7 reserved (never set by `packFluid`, ignored by the readers). A pure fluid
 * voxel is `air` plus a fluid byte; the fluid byte of a waterlogged block is its waterlogging.
 */

export const FLUID_NONE = 0;
export const FLUID_WATER = 1;
export const FLUID_LAVA = 2;
/** The byte of a voxel without fluid. */
export const NO_FLUID = 0;
/** A still water source: type water, level 0, not falling, settled. */
export const WATER_SOURCE = 16;

/** Packs the fields; each is masked to its width (type 2 bits, level 3 bits). */
export const packFluid = (type: number, level: number, falling = false, unsettled = false): number =>
  (level & 7) | (falling ? 8 : 0) | ((type & 3) << 4) | (unsettled ? 64 : 0);
/** Level: 0 = source, 1 … 7 flowing. */
export const fluidLevel = (b: number): number => b & 7;
export const fluidFalling = (b: number): boolean => (b & 8) !== 0;
/** Type: 0 none, 1 water, 2 lava. */
export const fluidType = (b: number): number => (b >> 4) & 3;
export const fluidUnsettled = (b: number): boolean => (b & 64) !== 0;
/** True when the voxel holds a fluid (type ≠ 0). */
export const hasFluid = (b: number): boolean => (b & 48) !== 0;

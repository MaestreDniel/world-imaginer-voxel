/**
 * The flat block colours (SP4a spec §6.3, D14): one sRGB colour per block type name, read by the Voxels palette
 * (`ui/crossSection/voxels.ts`) and the 3D flat-colour array (`render/textureArray.ts`). These are the SP3c terrain
 * palette (SP3c spec §2.1, §6), pairwise ≥ 24 apart in summed |ΔRGB| (SP3c spec §8), with packed_ice an ice blue
 * [100, 146, 226] (was [142, 180, 250]: 155 from the sky colour instead of 55). Air has no entry. SP8a replaces the
 * flat colours with painted textures; this table stays as the average colour (SP11's LOD).
 */

/** An sRGB colour, 0-255 per channel. */
export type FlatColor = readonly [number, number, number];

const ENTRIES: readonly (readonly [string, FlatColor])[] = [
  ['stone', [125, 125, 125]],
  ['bedrock', [28, 28, 30]],
  // The SP3c terrain palette (SP3c spec §2.1, §6), in state order.
  ['grass_block', [95, 159, 53]],
  ['dirt', [122, 88, 58]],
  ['coarse_dirt', [100, 72, 50]],
  ['podzol', [91, 63, 24]],
  ['mud', [60, 57, 61]],
  ['sand', [219, 207, 160]],
  ['red_sand', [214, 120, 46]],
  ['sandstone', [190, 174, 120]],
  ['red_sandstone', [160, 80, 28]],
  ['gravel', [152, 143, 140]],
  ['clay', [160, 166, 180]],
  ['calcite', [222, 223, 218]],
  ['snow_block', [250, 253, 255]],
  ['packed_ice', [100, 146, 226]],
  ['deepslate', [78, 78, 84]],
  ['terracotta', [152, 94, 67]],
  ['white_terracotta', [214, 180, 168]],
  ['orange_terracotta', [184, 104, 40]],
  ['yellow_terracotta', [186, 133, 35]],
  ['brown_terracotta', [77, 51, 36]],
  ['red_terracotta', [143, 61, 47]],
  ['light_gray_terracotta', [135, 107, 98]],
];

/** The flat colour of each block type, by type name (every registry type but air). */
export const FLAT_COLORS: ReadonlyMap<string, FlatColor> = new Map(ENTRIES);

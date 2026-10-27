/**
 * The flat block colours (SP4a spec §6.3, D14): one sRGB colour per block type name, read by the Voxels palette
 * (`ui/crossSection/voxels.ts`) and the 3D flat-colour array (`render/textureArray.ts`). These are the SP3c terrain
 * palette (SP3c spec §2.1, §6), pairwise ≥ 24 apart in summed |ΔRGB| (SP3c spec §8), with packed_ice an ice blue
 * [100, 146, 226] (was [142, 180, 250]: 155 from the sky colour instead of 55). Air has no entry. SP5a appends its
 * 25 types (SP5a spec §1.3): Minecraft's average colours, each ≥ 24 from every other type, the sky, water, lava and
 * unknown; where a candidate clashed with an older colour, the new one moved (cobblestone from stone, bricks from
 * terracotta, ladder from dirt, oak_log from coarse_dirt, gray_wool from mud, light_gray_wool from gravel, black_wool
 * from bedrock). SP8a replaces the flat colours with painted textures; this table stays as the average colour (SP11's
 * LOD).
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
  // SP5a's building and terrain types (SP5a spec §1.1, §1.3), in state order. A wall torch is a little deeper than a
  // torch, since every type keeps its own colour.
  ['oak_planks', [162, 130, 78]],
  ['oak_log', [109, 85, 42]],
  ['cobblestone', [100, 100, 100]],
  ['bricks', [168, 80, 70]],
  ['glass', [175, 213, 219]],
  ['torch', [250, 214, 90]],
  ['wall_torch', [236, 186, 72]],
  ['ladder', [150, 116, 60]],
  ['ice', [145, 183, 253]],
  ['white_wool', [233, 236, 236]],
  ['orange_wool', [240, 118, 19]],
  ['magenta_wool', [189, 68, 179]],
  ['light_blue_wool', [58, 175, 217]],
  ['yellow_wool', [248, 197, 39]],
  ['lime_wool', [112, 185, 25]],
  ['pink_wool', [237, 141, 172]],
  ['gray_wool', [52, 66, 76]],
  ['light_gray_wool', [160, 160, 154]],
  ['cyan_wool', [21, 137, 145]],
  ['purple_wool', [121, 42, 172]],
  ['blue_wool', [53, 57, 157]],
  ['brown_wool', [118, 70, 36]],
  ['green_wool', [85, 110, 28]],
  ['red_wool', [161, 39, 35]],
  ['black_wool', [16, 16, 20]],
];

/** The flat colour of each block type, by type name (every registry type but air). */
export const FLAT_COLORS: ReadonlyMap<string, FlatColor> = new Map(ENTRIES);

/** Still lava's colour (SP5a spec §1.3): lava is air plus a fluid byte, not a type, so it has no `FLAT_COLORS` entry. */
export const LAVA_COLOR: FlatColor = [207, 92, 20];

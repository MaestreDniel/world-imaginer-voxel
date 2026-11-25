import { CAVE_BIOME, CAVE_BIOME_COLORS, CAVE_FILM_KIND, CAVE_KIND } from '../core/constants';

/**
 * The X-ray's colours and the legend's names by kind (SP6a spec §5.2, D10): index = the X-ray pack's `kind` (the cave
 * kind of `CAVE_KIND`, 1-9, or `CAVE_FILM_KIND` 15, the surface film). Colours are sRGB hex strings, named only so the
 * kinds can be told apart (styling deferred); the material converts them to linear (`materials/uniforms.ts`), and the
 * UI (the strip's legend, the Caves tab, the slice's `caves` field) reads them as they are. Kinds 0 and 10-14 are
 * unused: black (adds nothing under the X-ray's additive blending) and no label.
 */

const UNUSED_COLOR = '#000000';

function byKind<T>(unused: T, entries: ReadonlyArray<readonly [kind: number, value: T]>): readonly T[] {
  const out = Array.from({ length: 16 }, () => unused);
  for (const [k, v] of entries) out[k] = v;
  return Object.freeze(out);
}

/** The 16 sRGB colours by kind (D10: cheese amber … underground worm yellow, other density air grey, the film grey). */
export const XRAY_COLORS: readonly string[] = byKind(UNUSED_COLOR, [
  [CAVE_KIND.cheese, '#ffb000'],
  [CAVE_KIND.spaghetti3d, '#00e5ff'],
  [CAVE_KIND.spaghetti2d, '#3d7bff'],
  [CAVE_KIND.noodle, '#ff3df0'],
  [CAVE_KIND.entrance, '#3ddc5a'],
  [CAVE_KIND.worm, '#ff7a1a'],
  [CAVE_KIND.ravine, '#ff3030'],
  [CAVE_KIND.undergroundWorm, '#ffe83d'],
  [CAVE_KIND.other, '#9aa0a6'],
  [CAVE_FILM_KIND, '#c8c8c8'],
]);

/** The legend's names by kind: 1-9 and 15; the unused kinds empty. */
export const XRAY_LABELS: readonly string[] = byKind('', [
  [CAVE_KIND.cheese, 'Cheese'],
  [CAVE_KIND.spaghetti3d, 'Spaghetti 3D'],
  [CAVE_KIND.spaghetti2d, 'Spaghetti 2D'],
  [CAVE_KIND.noodle, 'Noodle'],
  [CAVE_KIND.entrance, 'Entrance'],
  [CAVE_KIND.worm, 'Worm'],
  [CAVE_KIND.ravine, 'Ravine'],
  [CAVE_KIND.undergroundWorm, 'Underground worm'],
  [CAVE_KIND.other, 'Other density air'],
  [CAVE_FILM_KIND, 'Surface'],
]);

/**
 * The X-ray's colours and the legend's names by cave biome (SP6b spec §7.2, D7): index = the X-ray pack's `biome` (the
 * cave biome of `CAVE_BIOME`, 0-3), with 15 the surface film's (the material picks by kind for the film, whose biome is
 * 0, so entry 15 is the legend's). Colours 0-3 are `CAVE_BIOME_COLORS`, the one table the map's layer and the slice
 * read too; entries 4-14 are unused: the unused colour and no label.
 */
export const XRAY_BIOME_COLORS: readonly string[] = byKind(UNUSED_COLOR, [
  [CAVE_BIOME.plain, CAVE_BIOME_COLORS[CAVE_BIOME.plain]!],
  [CAVE_BIOME.lush, CAVE_BIOME_COLORS[CAVE_BIOME.lush]!],
  [CAVE_BIOME.dripstone, CAVE_BIOME_COLORS[CAVE_BIOME.dripstone]!],
  [CAVE_BIOME.abyss, CAVE_BIOME_COLORS[CAVE_BIOME.abyss]!],
  [CAVE_FILM_KIND, '#c8c8c8'],
]);

/** The biome legend's names: 0-3 and 15; the unused entries empty. */
export const XRAY_BIOME_LABELS: readonly string[] = byKind('', [
  [CAVE_BIOME.plain, 'Plain cave'],
  [CAVE_BIOME.lush, 'Lush'],
  [CAVE_BIOME.dripstone, 'Dripstone'],
  [CAVE_BIOME.abyss, 'Abyss'],
  [CAVE_FILM_KIND, 'Surface'],
]);

/**
 * The X-ray's fluid tint and the legend's names by fluid (SP7a spec §10.1, D13): index = the X-ray pack's `fluid` (2
 * bits: 0 dry, 1 water, 2 lava, 3 unused), the fluid type of the hollow voxel a wall bounds. The material mixes a wall's
 * kind or biome colour toward its fluid's by `xrayFluidMix` (`materials/uniforms.ts`), in both colour modes; both of the
 * strip's legends end with the two rows. Entries 0 and 3 are the unused colour and no label (a dry wall is not mixed).
 */
export const XRAY_FLUID_COLORS: readonly string[] = Object.freeze([UNUSED_COLOR, '#1e64ff', '#ff4a00', UNUSED_COLOR]);

/** The fluid legend's names: [1] "Flooded", [2] "Lava"; 0 and 3 empty. */
export const XRAY_FLUID_LABELS: readonly string[] = Object.freeze(['', 'Flooded', 'Lava', '']);

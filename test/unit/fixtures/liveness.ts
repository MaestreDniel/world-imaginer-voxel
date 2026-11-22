/**
 * The pins and helpers U2's liveness tests share (`liveness.test.ts`, `livenessBands.test.ts`, `livenessSp6b.test.ts`,
 * `livenessCaveBiomes.test.ts`, `livenessSp7a.test.ts`; split by leaf group in SP6b Task 58, ruling U14, so CI's unit shards run them in
 * parallel). Each test file imports its own copy: the class-column scan (`columns()`) runs once per file.
 */
import { DEFAULTS } from '../../../src/core/params/defaults';
import { patchAt } from '../../../src/core/params/kit';
import { SCHEMA, type ParamsPatch } from '../../../src/core/params/schema';
import { latticeIndex, type ColumnSample } from '../../../src/gen/column/columnStage';
import { biomeName } from '../../../src/gen/biomes/registry';
import { livenessColumns, type CaveSlot, type LivenessClass, type LivenessColumn, type SurfaceClass } from '../../../src/metrics/liveness';
import { ctxFor } from '../../harness/gen';

/** SP3e's island class column at seed 42 (spec §5.6) and its index among the U2.islands draws. */
export const ISLAND_PIN: LivenessColumn = { cx: 975, cz: -735, cls: 'island' };
export const ISLAND_DRAW = 33;
/**
 * SP6a's cave class columns at seed 42 (its spec §4), one per scan slot, and their indices among the sp6a.liveness.caves
 * draws. Task 38's tuned defaults moved both: the caverns' (546, 25857) at draw 7 and the tunnels' (4705, −24478) at
 * draw 224 before it. The user's check's noodles (R31, R32: threshold 1, thickness 0.22, maxY 48) moved both again: the
 * caverns' (4705, −24478) at draw 224 (where caves.limits.bandSpan no longer changes the T column: it changed the noodle's
 * band edge there) and the tunnels' (−24763, −17996) at draw 314 before them. SP6b's rock floor (Task 19) moved the
 * caverns' from (19524, −7785) at draw 512, where a caverns leaf no longer changes the T column once the floor closes
 * its bottom. Task 25's lever 25c (`caves.floor.y` −58 → −60) moved the tunnels' from (−16103, 13714) at draw 422.
 */
export const CAVE_PINS: Readonly<Record<CaveSlot, readonly [LivenessColumn, number]>> = {
  caverns: [{ cx: 18487, cz: -15384, cls: 'cave' }, 1765],
  tunnels: [{ cx: -1986, cz: -30779, cls: 'cave' }, 896],
};
/** The two cave class columns' verdict strings. */
export const CAVERNS_VIA = 'cave column (18487, -15384)';
export const TUNNELS_VIA = 'cave column (-1986, -30779)';
/**
 * The leaves of SP6a Tasks 6, 7, 8, 9 and 27 (the caves group): U2 covers 73 + 19 + 30 + 11 + 1 + 1 + 36 = 171 leaves
 * (Task 9: the island cap's capTop, then the wet roof's waterDepth; Task 27: the 36 carver leaves), and the user's check's
 * `caves.noodles.threshold` (R31): 172; SP6b Task 17's 15 `caves.biomes.*` leaves (Spec correction 5): 187; SP6b Task
 * 19's rock floor (`caves.noises.floor`, `caves.floor.y`, `.amp`, `.span`): 191; SP6b Task 22's rule-4 noises
 * (`surface.noises.cavePatch`, `strataOffset`): 193; SP7a Task 13's 15 `aquifer.*` leaves (the plan's Spec correction
 * 5): 208; SP7a Task 19's 2 `springs.water.*` leaves (no `minY`, Task 19's Spec correction): 210; SP7a Task 20's
 * `springs.island.tries` (no `minFall`, Task 20's Spec correction): 211; SP7a Task 21's 2 `springs.lava.*` leaves: 213.
 */
export const U2_LEAVES = 213;
/** The aquifer's leaves (SP7a spec §1.9, Task 13), in schema order; each noise counts as one leaf. */
export const AQUIFER_LEAVES = [
  'aquifer.enabled', 'aquifer.surfaceBand',
  'aquifer.thresholds.fullInland', 'aquifer.thresholds.fullOcean', 'aquifer.thresholds.partialInland', 'aquifer.thresholds.partialOcean',
  'aquifer.lavaMaxLevel', 'aquifer.lavaThreshold', 'aquifer.lavaLevel', 'aquifer.barrierBand', 'aquifer.abyssMargin',
  'aquifer.noises.floodedness', 'aquifer.noises.spread', 'aquifer.noises.lava', 'aquifer.noises.barrier',
] as const;
/** The water springs' leaves (SP7a spec §3.5, Task 19), in schema order. */
export const SPRING_LEAVES = ['springs.water.tries', 'springs.water.minFall'] as const;
/** The island springs' leaves (SP7a spec §3.3, §3.5, Task 20; their least fall is the constant `ISLAND_SPRING_MIN_FALL`). */
export const ISLAND_SPRING_LEAVES = ['springs.island.tries'] as const;
/** The lava springs' leaves (SP7a spec §3.4, §3.5, Task 21), in schema order. */
export const LAVA_SPRING_LEAVES = ['springs.lava.tries', 'springs.lava.minFall'] as const;
/** The cave-biome leaves (SP6b Task 17), decided on the class columns or on their bounded biome witness. */
export const BIOME_LEAVES = [
  'caves.biomes.lush.hMin', 'caves.biomes.lush.depthMin', 'caves.biomes.lush.depthMax',
  'caves.biomes.dripstone.cMin', 'caves.biomes.dripstone.depthMin', 'caves.biomes.dripstone.depthMax',
  'caves.biomes.abyss.eMax', 'caves.biomes.abyss.cMin', 'caves.biomes.abyss.depthMin',
  'caves.biomes.depthScale', 'caves.biomes.borderWarp', 'caves.biomes.depthWarp', 'caves.biomes.edgeJitter',
  'caves.biomes.noises.border', 'caves.biomes.noises.depth',
] as const;
/** The rock floor's leaves (SP6b Task 19, spec §5.2, §12.7), decided on the class columns, the cave columns first. */
export const FLOOR_LEAVES = ['caves.noises.floor', 'caves.floor.y', 'caves.floor.amp', 'caves.floor.span'] as const;
/** The four floor leaves' deciding column at seed 42 (SP6b Task 29's full-tier audit, at Task 25's floor −60, amp 7): the tunnels'. */
export const FLOOR_VIA = TUNNELS_VIA;
/** The carver leaves (SP6a Task 27), decided on the class columns or on their bounded carver witness (ruling P18). */
export const CARVER_LEAVES = SCHEMA.leaves.filter((l) => /^caves\.(worms|undergroundWorms|ravines)\./.test(l.path)).map((l) => l.path);
/** The spaghetti scale leaves (SP6a Task 7), decided on the class columns or on their bounded witness search (ruling P5). */
export const SCALE_LEAVES = [
  'caves.spaghetti3d.scales.s0', 'caves.spaghetti3d.scales.s1', 'caves.spaghetti3d.scales.s2', 'caves.spaghetti3d.scales.s3',
  'caves.spaghetti2d.scales.s0', 'caves.spaghetti2d.scales.s1', 'caves.spaghetti2d.scales.s2', 'caves.spaghetti2d.scales.s3',
  'caves.spaghetti2d.scales.s4',
] as const;

/** The depth-band leaves (SP6a Task 8), decided on the class columns or on their bounded band witness (rulings P3, P4, R5). */
export const BAND_LEAVES = [
  'caves.cheese.minY', 'caves.cheese.maxY', 'caves.spaghetti3d.minY', 'caves.spaghetti3d.maxY',
  'caves.spaghetti2d.minY', 'caves.spaghetti2d.maxY', 'caves.noodles.minY', 'caves.noodles.maxY',
  'caves.entrances.minY', 'caves.entrances.maxY',
] as const;
/**
 * Each depth-band leaf's U2 verdict at seed 42 (SP6a spec §4): the noodle's maxY on a class column, the maxY leaves of
 * cheese, spaghetti 3D and the entrances on the amplified base (P3: the default base's scan has none), spaghetti 2D's
 * maxY 215 on its witness (R5). SP6b's rock floor (Task 19) shadows every minY at SP6a's defaults (g_b saturates the
 * caps at corners −64 and −56), so ruling R10 raised them to the shadow's edge (−55; entrances −54) with no change to the
 * world: cheese's minY on the cliffSteep class column, the other four on their own band witness (P4); spaghetti 3D's on
 * the tunnels' cave column since Task 25's lever 25c (`caves.floor.y` −60; its witness before). Before: cheese's
 * and spaghetti 3D's minY on the cave columns, spaghetti 2D's on (−17888, 14467), the entrances' on the badlands column.
 */
export const BAND_PINS: Readonly<Record<(typeof BAND_LEAVES)[number], string>> = {
  'caves.cheese.minY': 'cliffSteep column (-24200, -4864)',
  'caves.cheese.maxY': 'amplified witness column (15998, 4660)',
  'caves.spaghetti3d.minY': TUNNELS_VIA,
  'caves.spaghetti3d.maxY': 'amplified witness column (15676, 27143)',
  'caves.spaghetti2d.minY': 'witness column (-4103, 15609)',
  'caves.spaghetti2d.maxY': 'witness column (-8539, 19151)',
  'caves.noodles.minY': 'witness column (30642, 22358)',
  'caves.noodles.maxY': CAVERNS_VIA,
  'caves.entrances.minY': 'witness column (-19897, -15804)',
  'caves.entrances.maxY': 'amplified witness column (17330, 32119)',
};
/**
 * The leaves whose default sits at a range end, so U2 has one step for them: the band leaves at 320 (→ 272), the
 * island cap's top (344 → 292; Task 9) and three carver leaves (Task 27: the worms' floorMin −1 → −0.85, the rooms'
 * yScale 0.1 → 0.115 and 0.9 → 0.765). Spaghetti 2D's and the entrances' minY left the range end −64 with SP6b's ruling
 * R10 (Task 19: −55 and −54).
 */
export const ONE_STEP = [
  'caves.cheese.maxY', 'caves.spaghetti3d.maxY', 'caves.entrances.maxY',
  'caves.worms.floorMin', 'caves.worms.roomYScaleMin', 'caves.worms.roomYScaleMax', 'caves.limits.capTop',
];
/**
 * Each carver leaf's U2 verdict at seed 42 (Task 27, ruling P18; re-pinned at Task 38's tuned defaults, at the user's
 * check's cave columns, at SP6b's rock floor, Task 19, which moved the caverns' column, and at Task 25's lever 25c,
 * `caves.floor.y` −60, which moved the tunnels'): most worm leaves on the caverns' cave column, the worms' floorMin and
 * floorMax and the underground worms' chance on the tunnels', the worms' chance on the snowline class column, the
 * underground worms' startYMin on the patch class column (their startYMax too until SP6b Task 20's σ_b closed the low
 * start there; now on its carver witness), the ravine leaves on their carver witness (5, 1) (the ravines' chance on
 * (0, −3)), the rest on their carver witness (the spiral's first source whose path a step changes; for
 * `undergroundWorms.maxY` the first reaching its shrink's band). Before the floor the worms' start range was decided on
 * the tunnels' column and the underground worms' start range and the ravine leaves on the caverns' (19524, −7785);
 * before lever 25c the worms' floorMax was on a land class column, the underground worms' chance on its carver witness
 * (3, −6) and the ravines' widthSmoothness on the tunnels' column.
 */
export const CARVER_PINS: Readonly<Record<string, string>> = {
  'caves.worms.chance': 'snowline column (-25681, 32120)',
  'caves.worms.floorMin': TUNNELS_VIA,
  'caves.worms.floorMax': TUNNELS_VIA,
  'caves.worms.branchChance': 'carver witness column (-3, -5)',
  'caves.worms.roomYScaleMin': 'carver witness column (5, 5)',
  'caves.worms.roomYScaleMax': 'carver witness column (-3, -5)',
  'caves.undergroundWorms.chance': TUNNELS_VIA,
  'caves.undergroundWorms.startYMin': 'patch column (-20548, -22882)',
  'caves.undergroundWorms.startYMax': 'carver witness column (-3, -5)',
  'caves.undergroundWorms.maxY': 'carver witness column (-2, -2)',
  'caves.ravines.chance': 'carver witness column (0, -3)',
};
/** The other ravine leaves: decided on their carver witness (5, 1). */
export const RAVINE_VIA = 'carver witness column (5, 1)';

/** The island cap's top (SP6a Task 9), decided on a floating_islands base at its own witness. */
export const CAP_TOP = 'caves.limits.capTop';
/**
 * The wet roof's depth (SP6a Task 9); since SP7a D24 the lake roof's (it acts under lakes only), meant for the basin
 * class column and decided on its bounded lake witness (Task 15, ruling P13).
 */
export const WATER_DEPTH = 'caves.limits.waterDepth';
/** waterDepth's lake witness at seed 42: its cell and column and the scan's figures (spiral cells visited, columns hashed). */
export const LAKE_ROOF_PIN = { via: 'lake witness cell (-2, -1) → column (-37, -8)', cells: 25, checks: 2 } as const;
/** capTop's witness at seed 42: its column and the scan's figures (draws of sp6a.liveness.capTop, examined, hashed). */
export const CAP_TOP_PIN = { via: 'floating_islands witness column (-4875, 15131)', draws: 59, examined: 3, checks: 1 } as const;

export const leaf = (path: string) => {
  const info = SCHEMA.leaves.find((l) => l.path === path);
  if (info === undefined) throw new Error(`no leaf ${path}`);
  return info;
};
export const CTX = ctxFor('42');
export const moved = (path: string, value: unknown) => ctxFor('42', patchAt(path, value) as ParamsPatch);

export const CLASSES: readonly LivenessClass[] = [
  'land', 'land', 'coast', 'coast', 'channel', 'channel', 'gorge', 'gorge', 'basin', 'basin', 'rim', 'rim',
  'threshold:lakes.p', 'threshold:lakes.minC', 'threshold:lakes.offsetMin', 'threshold:lakes.offsetMax',
  'cliffY', 'cliffSteep', 'snowline', 'patch', 'badlands',
];
/** SP3b's 16 class columns at seed 42 (the third pass leaves them, and every verdict decided on them, unchanged). */
export const SP3B_COLUMNS: readonly (readonly [number, number])[] = [
  [-25833, 16792], [-15542, -30245], [23279, 27598], [-1451, 21847], [6298, -18132], [13027, -10891], [-2619, 6024],
  [31185, -27596], [-13409, -28645], [-22814, -6798], [-10536, 924], [-31628, -24239], [-24389, -23313], [23605, 2444],
  [-16278, -8451], [26525, 25423],
];
/** SP3c spec §3.5's pins: (cx, cz) and the stream index of each surface class column at seed 42. */
export const SURFACE_PINS: Readonly<Record<SurfaceClass, readonly [number, number, number]>> = {
  cliffY: [17107, 13836, 53],
  cliffSteep: [-24200, -4864, 61],
  snowline: [-25681, 32120, 255],
  patch: [-20548, -22882, 11],
  badlands: [-26426, -31088, 35],
};
export const SURFACE_LEAVES = SCHEMA.leaves.filter((l) => l.path.startsWith('surface.')).map((l) => l.path);
/** Rule 4's two noises (SP6b spec §3.4, Task 22): meant for the cave class, decided apart from SP3c's surface leaves. */
export const RULE4_NOISES = ['surface.noises.cavePatch', 'surface.noises.strataOffset'] as const;
let cached: LivenessColumn[] | null = null;
/** The class columns of seed 42 and the default params (the scan runs once per file). */
export const columns = (): LivenessColumn[] => (cached ??= livenessColumns(CTX));

export const PATCH_BIOMES = ['taiga', 'snowy_taiga', 'savanna', 'jungle', 'swamp', 'windswept_hills', 'stony_shore', 'volcano', 'stony_peaks', 'frozen_peaks'];
/**
 * SP3c spec §3.5's corner prefilters at the default params, written from the spec: a dry corner (surfaceWaterLevel −∞)
 * of the 25 quart corners (i, j ∈ 0 … 4) with T_top = T − lapse·max(0, surfaceEst − lapseBase).
 */
export function surfaceShows(s: ColumnSample): Record<SurfaceClass, () => boolean> {
  const f = s.f;
  const p = DEFAULTS.surface;
  const corners = Array.from({ length: 25 }, (_, n) => latticeIndex(n % 5, Math.floor(n / 5)));
  const dry = (holds: (k: number) => boolean) => () => corners.some((k) => f.surfaceWaterLevel[k] === -Infinity && holds(k));
  const tTop = (k: number) => f.T[k]! - p.lapse * Math.max(0, f.surfaceEst[k]! - p.lapseBase);
  return {
    cliffY: dry((k) => f.steep[k]! >= 0.85 * p.cliffSteep && f.surfaceEst[k]! >= 0.85 * p.cliffMinY - 8 && f.surfaceEst[k]! <= 1.15 * p.cliffMinY + 8),
    cliffSteep: dry((k) => f.steep[k]! >= 0.85 * p.cliffSteep && f.surfaceEst[k]! >= p.cliffMinY - 8),
    snowline: dry((k) => f.steep[k]! < p.cliffSteep && f.surfaceEst[k]! >= p.lapseBase && Math.abs(tTop(k) - p.snowline) <= 0.1),
    patch: dry((k) => f.steep[k]! < p.cliffSteep && tTop(k) >= p.snowline && PATCH_BIOMES.includes(biomeName(s.biome[k]!))),
    badlands: dry((k) => biomeName(s.biome[k]!) === 'badlands'),
  };
}

/**
 * The water metrics' instruments (SP7a spec §13.1, D30): the A parts' counts of one region, read after the global settle
 * reference (`refs.ts`' `referenceSettle`, run by the caves metric's region worker over the region's T, `caveRegionWorker.ts`)
 * on the region's interior, 2 chunks in from its edge (the reference has no fluid beyond the region, so its border
 * columns are not D's). Pure over a `RegionView`'s proto and the settled overlay (the bytes the reference changed, keyed
 * `referenceSettleKey`, which is the `CaveGrid` index), so a unit test reads them on hand-built views; the counts are
 * numbers (and the poses plain objects of numbers), so the worker's structured clone carries them and
 * `caves.metric.ts` pools them per group.
 *
 * The definitions as built (the spec's §13.1 words them; where it leaves a choice, the choice is stated here):
 * - A voxel's fluid "after settle" is its settled byte (the overlay's, else the proto's); "in T" its proto byte. Cave
 *   voxels are the tagged non-solid ones (a cave kind ≠ 0 and an air block); sky-open water (D19) is untagged proto
 *   water. A position's sky-open level is read from the proto, where D19 put it (an untagged non-solid voxel holds water
 *   iff y ≤ ⌊`surfaceWaterLevel`⌋): it is 63 when its voxel at y 63 holds untagged proto water and its voxel at y 64 does
 *   not (a lake at Lw ≥ 64 holds water there too); a position whose voxel at 63 is solid is not read, its water reaching
 *   the sea's through its neighbours. (No generator context is needed, so a hand-built view carries its own sea.)
 * - **A1** `dryShare`: the components of the cave voxels and the fluid voxels after settle, all at y ≤ 62 (`components3d`,
 *   6-connected; untagged air never links two caves); a component holding sky-open water at a level-63 position is
 *   linked to the sea or a river. The population is the interior's cave voxels at y ≤ 62 in no linked component; the
 *   part their share with no fluid after settle (`a1Dry` over `a1Population`), recorded with no fluid in T (`a1DryT`)
 *   over the same population.
 * - **A3** (after settle; lava voxels of the interior): `lavaBelow54` the lava voxels at y ≤ −55 (the region holds lava
 *   there when > 0); `aquiferLavaAbove10` (rulings P19) the proto lava voxels above y −10 whose cave tag is not 0
 *   (springs are written untagged and untagged air takes only water, so a spring is never one; 0 by construction);
 *   `lavaSupported` the lava voxels that fall or have a solid voxel (a non-air block) or a lava voxel below; `lavaSky` the
 *   lava voxels face-adjacent to cave air (a cave voxel with no fluid after settle) of a C2 component (`deepSkyLabels`
 *   over `caveComponents` of the region's grid: sky-connected, reaching 8 below its position's pre-cave top).
 * - **A4** `aquiferBodies`: the components of the water voxels after settle (6-connected, the whole region from y −64 to
 *   its highest water voxel) holding no untagged proto water (sky-open water, or a spring, which is not an aquifer
 *   body) and a voxel of the interior below its position's pre-cave top (`preCaveTops`: so the sea above its floor is
 *   not one).
 * - The ground's top of a position (`groundTop`, §1.7's): the top of its highest solid run whose bottom lies below
 *   y 181 (SP3e's rule: a floating island's runs start at 181 or above), −65 when none; "land" is a ground top ≥ 63.
 * - Recorded: `skyOpenDeep` (D19) the interior's sky-open water voxels more than 12 below their position's ground top
 *   (so the sea under a floating island is not deep); `marginBarriers` (§1.6) the aquifer barriers in the abyss margin (`barrierAt`, whose
 *   own nibble, `caveBiomeAt`, is not the abyss, inside `inAbyssMargin`'s widened box), found by a flood from the solid
 *   untagged voxels of the box face-adjacent to a cave voxel of another nibble than the abyss, through barriers in the
 *   margin (a cave the margin plugs whole is not seen; NaN without `marginProbes`); `dryPitsBelowSea` (O25) the interior
 *   positions whose ground top lies below 63 (`lowTops`) whose voxel above it holds no fluid after settle (`dryPits`)
 *   and in T (`dryPitsT`), every position counted, the open sea's included (`surface.metric.ts`' land-biome population
 *   needs the climate): so `waterParts`' `dryPitsBelowSea` is not `surface.metric.ts`' diagnostic of that name (§13.2, over
 *   land-biome positions) and the two are not compared.
 * - The review poses (§13.9, D16; `waterExamples`): per pose, of its candidates in the interior, scanned y, then z, then x
 *   ascending, the first nearest `findSpawn` horizontally (voxel centres): `floodedUnderSea` a cave voxel holding water
 *   after settle in an A1-linked component below its level-63 position's pre-cave top (the eye there, as a cave pose);
 *   `dryBelowSea` a dry cave voxel of A1's population over a dry cave voxel over solid, under land (the eye
 *   there); `riverMouth` a sky-open water voxel at y 63 of a river position (`riverMaskOf`) beside one of a level-63
 *   position that is not river (the eye 17 above, looking down at 60°); `lake` a sky-open water voxel at y ≥ 64 under an
 *   untagged dry non-solid voxel, its four sides sky-open water (a lake's surface, not a spring; the eye 8 above it, 45°
 *   down); `coastFancy` a sky-open water voxel at
 *   y 63 of a level-63 position beside a land position (the eye 2.5 above the surface, facing away from the
 *   land at 10° down, a grazing view over the water); `underwater` a level-63 position whose voxels y 53 … 63 all hold
 *   sky-open water (the eye at y 58, 6 under the surface at 64). A cave pose's yaw looks along its longest straight run of
 *   non-solid voxels (`longestRunYaw`), every other's as stated (0° facing −z, 90° +x); null where none is found.
 * - **A2** (Task 23; `a2RegionCounts`, `a2Parts`): over the interior's fluid voxels after settle, `unsupported` those one
 *   application of §4.1's rules (`ruleOffers`) would change, counting the unsettled (an offer of a lower value into a
 *   voxel of the offering type, or any offer into a voxel with no fluid, which counts the offering voxel), and
 *   `unsettled` those with bit 6 outside the water/lava contacts (a contact is SP7b's reaction, counted apart), each
 *   over all fluid voxels; recorded by origin (`refs.ts`' `referenceSettleOrigins`: a spring's when its own front,
 *   `springFront`, reaches the voxel, else its nearest proto source's, sky-open before aquifer at equal distance; a
 *   proto fluid voxel is its own, `protoOrigin`) and per km².
 * - The springs of a region (`springsOfRegion`, from its proto alone, so the A parts need no generator context): the
 *   voxels matched by a replay of `springTries` per chunk and kind (its doc states the match), each a spring when its
 *   faces other than the outlet are solid or another matched voxel; a unit test pins them equal to T's springs
 *   (`springsColumn`) on real columns of seed '42'.
 */
import { CAVE_BIOME, caveBiomeOf, ISLAND_SPRING_MIN_FALL } from '../../src/core/constants';
import type { Seed64 } from '../../src/core/hash';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { cavePickerOf, caveBiomeAt, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass } from '../../src/gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { aquiferOf, barrierAt, inAbyssMargin } from '../../src/gen/fluids/aquifer';
import { settleWindow, type SettleScratch, type SettleSink, type SettleSource } from '../../src/gen/fluids/settle';
import { springTries, type SpringKind, type SpringList } from '../../src/gen/fluids/springs';
import {
  FLUID_LAVA, FLUID_WATER, fluidFalling, fluidLevel, fluidType, fluidUnsettled, hasFluid, LAVA_SOURCE, NO_FLUID, WATER_SOURCE,
} from '../../src/world/blocks/fluid';
import { capOf, FLUID_VALUE_FALLING, FLUID_VALUE_SOURCE, isPassable, ruleOffers, type FluidRuleReader } from '../../src/world/blocks/fluidRules';
import { AIR, STONE } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/store';
import {
  BIOME_SHIFT, caveComponents, caveGridOf, deepSkyLabels, FLUID_BIT, GRID_H, GRID_Y0, longestRunYaw, preCaveTops, riverMaskOf, SOLID_BIT, TAG_MASK,
  type CaveGrid, type CavePose,
} from './caveMetrics';
import { components3d } from './flood';
import type { RegionView } from './regionView';

/**
 * The proto set holding world voxel (x, y, z) of the view's region, or null outside the region (or outside y −64 … 319):
 * the columns' `ColumnView`s, each asked of the store once (`who` names the caller in the error of a column with no proto
 * set).
 */
function protoColumns(view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, who: string): (x: number, y: number, z: number) => ColumnView | null {
  const cols: (ColumnView | undefined)[] = new Array(view.w * view.h);
  return (x, y, z) => {
    const cx = Math.floor(x / 16) - view.cx0;
    const cz = Math.floor(z / 16) - view.cz0;
    if (cx < 0 || cx >= view.w || cz < 0 || cz >= view.h || y < GRID_Y0 || y >= GRID_Y0 + GRID_H) return null;
    const k = cz * view.w + cx;
    let col = cols[k];
    if (col === undefined) {
      const v = view.store.proto(view.cx0 + cx, view.cz0 + cz);
      if (v === null) throw new Error(`${who}: column (${view.cx0 + cx}, ${view.cz0 + cz}) has no proto set`);
      col = cols[k] = v;
    }
    return col;
  };
}

/** A box of world x0 ≤ x < x1, z0 ≤ z < z1 (every y). */
export interface WaterBox {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/** One region's A counts (see the header): numbers only. */
export interface WaterRegionCounts {
  /** The interior's area, km². */
  readonly areaKm2: number;
  /** A1: the population, its voxels with no fluid after settle, and with no fluid in T. */
  readonly a1Population: number;
  readonly a1Dry: number;
  readonly a1DryT: number;
  /** A3: the lava voxels at y ≤ −55, the tagged proto lava voxels above −10, the lava voxels, those supported, those touching C2's cave air. */
  readonly lavaBelow54: number;
  readonly aquiferLavaAbove10: number;
  readonly lava: number;
  readonly lavaSupported: number;
  readonly lavaSky: number;
  /** A4: the aquifer water bodies. */
  readonly aquiferBodies: number;
  /** Recorded: sky-open water more than 12 below the ground's top; barriers in the abyss margin (NaN without probes); the pits below sea. */
  readonly skyOpenDeep: number;
  readonly marginBarriers: number;
  readonly lowTops: number;
  readonly dryPits: number;
  readonly dryPitsT: number;
}

/** The review poses `waterExamples` finds (SP7a spec §13.9; Task 24 adds A5's). */
export const WATER_EXAMPLE_IDS = ['floodedUnderSea', 'dryBelowSea', 'riverMouth', 'lake', 'coastFancy', 'underwater'] as const;
export type WaterExampleId = (typeof WATER_EXAMPLE_IDS)[number];

/** The highest y whose voxels A1 links (below the sea surface at 63). */
export const A1_Y_MAX = 62;
/** A3's deep lava: y ≤ −55 (below `aquifer.lavaLevel` −54). */
export const LAVA_DEEP_Y = -55;
/** A3's aquifer lava: above y −10 (`aquifer.lavaMaxLevel`). */
export const AQUIFER_LAVA_Y = -10;
/** D19's deep sky-open water: more than this many blocks below the ground's top. */
export const SKY_OPEN_DEEP = 12;
/** A solid run whose bottom lies at or above this y is a floating island's, not the ground (SP3e's `groundTop` rule). */
export const GROUND_RUN_BOTTOM = 181;
/** The sea surface's voxel. */
const SEA_Y = 63;
/** The abyss's nibble in the grid's biome bits. */
const ABYSS = CAVE_BIOME.abyss;

/**
 * The view's proto as §4.1's rules read it (`refs.ts`' `referenceSettle`'s reader, read voxel by voxel from the store's
 * proto sets instead of loaded whole): `isPassable` over the block state, the proto fluid byte and the cave nibble
 * (`caveBiomeOf`), `block` (passable false, fluid NO_FLUID, nibble 0) outside the region and wherever the voxel is not
 * passable. C7.waterWall's spread sides read it (`caveMetrics.ts`' `spreadSides`), only at the few voxels that could be
 * walls, so it loads nothing up front.
 */
export function protoRuleReader(view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>): FluidRuleReader {
  const column = protoColumns(view, 'protoRuleReader');
  const reader: FluidRuleReader = {
    passable: (x, y, z) => {
      const col = column(x, y, z);
      return col !== null && isPassable(col.block(x & 15, y, z & 15));
    },
    protoFluid: (x, y, z) => (reader.passable(x, y, z) ? column(x, y, z)!.fluid(x & 15, y, z & 15) : NO_FLUID),
    nibble: (x, y, z) => (reader.passable(x, y, z) ? caveBiomeOf(column(x, y, z)!.cave(x & 15, y, z & 15)) : 0),
  };
  return reader;
}

// ---------------------------------------------------------------- the springs of a region (SP7a spec §3.1; Task 23)

/** The outlet directions in `springs.ts`' face order (N −z, E +x, S +z, W −x): x and z steps. */
const DIR_DX = [0, 1, 0, -1] as const;
const DIR_DZ = [-1, 0, 1, 0] as const;
/** A spring's front reads within cap + search = 16 blocks of the spring (§4.1's radius), plus the unsettled test's block. */
const SPRING_FRONT_R = 17;

/** The key of world voxel (x, y, z) of the view's region: `refs.ts`' `referenceSettleKey`, the `CaveGrid` index. */
const keyAt = (view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h'>, x: number, y: number, z: number): number =>
  ((y - GRID_Y0) * 16 * view.h + (z - 16 * view.cz0)) * 16 * view.w + (x - 16 * view.cx0);

/** World (x, y, z) of the view's region key `k` (`keyAt`'s inverse). */
export function regionVoxelOf(view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h'>, k: number): [number, number, number] {
  const W = 16 * view.w;
  const D = 16 * view.h;
  return [16 * view.cx0 + (k % W), Math.floor(k / (W * D)) + GRID_Y0, 16 * view.cz0 + (Math.floor(k / W) % D)];
}

/** One spring kind of the replay (`springsColumn`'s order): its name, kind byte, source byte, tries and least open fall. */
interface ReplayKind {
  readonly kind: SpringKind;
  readonly byte: number;
  readonly source: number;
  readonly tries: number;
  readonly fall: number;
}

/** The kinds T runs under `params`, in its order (water, island with `islands.enabled`, lava); a kind with 0 tries left out. */
function replayKinds(params: Params): ReplayKind[] {
  const s = params.springs;
  const kinds: ReplayKind[] = [{ kind: 'water', byte: 0, source: WATER_SOURCE, tries: s.water.tries, fall: s.water.minFall }];
  if (params.islands.enabled) kinds.push({ kind: 'island', byte: 1, source: WATER_SOURCE, tries: s.island.tries, fall: ISLAND_SPRING_MIN_FALL });
  kinds.push({ kind: 'lava', byte: 2, source: LAVA_SOURCE, tries: s.lava.tries, fall: s.lava.minFall });
  return kinds.filter((k) => k.tries > 0);
}

/** A spring list with room for every try of the view's region under `params` (`springsOfRegion`'s `out`). */
export function regionSpringList(view: Pick<RegionView, 'w' | 'h'>, params: Params): SpringList {
  const n = view.w * view.h * replayKinds(params).reduce((a, k) => a + k.tries, 0);
  return { n: 0, pos: new Int32Array(n), kind: new Uint8Array(n), dir: new Uint8Array(n) };
}

/**
 * The springs of the view's region (SP7a spec §3.1), found from its proto alone by replaying `springTries` per chunk
 * and kind (T's order: water, island with `islands.enabled`, lava): a try (x, z, d) of kind k matches every voxel of
 * its column holding k's source byte (`WATER_SOURCE`, `LAVA_SOURCE` for lava) in untagged air whose outlet (the
 * neighbour in d) and the k's `minFall` voxels below it are open (non-solid, no fluid), the lava outlet tagged air of
 * the abyss nibble, and (with `islands.enabled`) whose solid run below starts below y 181 for water and at or above it
 * for an island try (SP3e's island runs); every condition holds at T's springs, whose writes change only their own
 * voxels (§3.1). A matched voxel is a spring when its other five faces are each solid or a matched voxel of any try
 * of the region (two springs side by side, §3.1, are both found), its kind and direction its first try's. A voxel
 * outside the region reads as solid rock, so a spring whose outlet lies outside is not found. `out` (`regionSpringList`)
 * receives them in their first try's order, `pos[i]` the voxel's region key (`refs.ts`' `referenceSettleKey`), `kind`
 * and `dir` as `springsColumn`'s.
 */
export function springsOfRegion(view: RegionView, seed: Seed64, params: Params, out: SpringList): void {
  const kinds = replayKinds(params);
  const perChunk = kinds.reduce((a, k) => a + k.tries, 0);
  if (out.pos.length < view.w * view.h * perChunk) throw new RangeError(`springsOfRegion: out holds ${out.pos.length} springs, the region ${view.w * view.h * perChunk} tries`);
  const column = protoColumns(view, 'springsOfRegion');
  const solid = (x: number, y: number, z: number): boolean => {
    const c = column(x, y, z);
    return c === null || c.block(x & 15, y, z & 15) !== AIR;
  };
  const open = (x: number, y: number, z: number): boolean => !solid(x, y, z) && column(x, y, z)!.fluid(x & 15, y, z & 15) === NO_FLUID;
  const islands = params.islands.enabled;
  const draws = new Float64Array(5 * Math.max(0, ...kinds.map((k) => k.tries)));
  /** The matched voxels, in try order: key → kind byte · 4 + direction. */
  const matched = new Map<number, number>();
  for (let cz = view.cz0; cz < view.cz0 + view.h; cz++) {
    for (let cx = view.cx0; cx < view.cx0 + view.w; cx++) {
      const col = view.store.proto(cx, cz);
      if (col === null) throw new Error(`springsOfRegion: column (${cx}, ${cz}) has no proto set`);
      for (const k of kinds) {
        springTries(seed, k.kind, cx, cz, k.tries, draws);
        for (let t = 0; t < k.tries; t++) {
          const lx = draws[5 * t]!, lz = draws[5 * t + 1]!, d = draws[5 * t + 2]!;
          const x = 16 * cx + lx, z = 16 * cz + lz;
          const ox = x + DIR_DX[d]!, oz = z + DIR_DZ[d]!;
          for (let sy = 0; sy < 24; sy++) {
            const sf = col.sectionFluid(sy);
            if (typeof sf === 'number' && sf !== k.source) continue;
            for (let y = GRID_Y0 + 16 * sy; y < GRID_Y0 + 16 * sy + 16; y++) {
              if (y - k.fall <= GRID_Y0 || y >= GRID_Y0 + GRID_H - 1) continue;
              if (col.fluid(lx, y, lz) !== k.source || col.block(lx, y, lz) !== AIR || (col.cave(lx, y, lz) & TAG_MASK) !== 0) continue;
              if (!open(ox, y, oz)) continue;
              let fall = true;
              for (let f = 1; f <= k.fall && fall; f++) fall = open(ox, y - f, oz);
              if (!fall) continue;
              if (k.kind === 'lava') {
                const c = column(ox, y, oz)!.cave(ox & 15, y, oz & 15);
                if ((c & TAG_MASK) === 0 || caveBiomeOf(c) !== ABYSS) continue;
              } else if (islands) {
                let bottom = y - 1;
                while (bottom - 1 > GRID_Y0 && solid(x, bottom - 1, z)) bottom--;
                if ((bottom >= GROUND_RUN_BOTTOM) !== (k.kind === 'island')) continue;
              }
              const key = keyAt(view, x, y, z);
              if (!matched.has(key)) matched.set(key, 4 * k.byte + d);
            }
          }
        }
      }
    }
  }
  out.n = 0;
  for (const [key, v] of matched) {
    const [x, y, z] = regionVoxelOf(view, key);
    const d = v & 3;
    const closed = (qx: number, qy: number, qz: number): boolean => solid(qx, qy, qz) || matched.has(keyAt(view, qx, qy, qz));
    let ok = closed(x, y + 1, z) && closed(x, y - 1, z);
    for (let e = 1; e < 4 && ok; e++) ok = closed(x + DIR_DX[(d + e) & 3]!, y, z + DIR_DZ[(d + e) & 3]!);
    if (!ok) continue;
    const i = out.n++;
    out.pos[i] = key;
    out.kind[i] = v >> 2;
    out.dir[i] = d;
  }
}

/**
 * Spring i's own front (SP7a spec §4.1, §13.1): `settleWindow` (Task 3's kernel, D's and the reference's rules) seeded
 * from that spring's voxel alone, over a `SettleSource` on the view's proto (a window of 2·17 + 1 blocks around the
 * spring, the settle's radius of 16 and a block; voxels outside the region read as stone), its box the whole window:
 * `out` receives every voxel the front gives a byte other than its proto's (the spring's own voxel, a proto source,
 * keeps its byte), so the front is those voxels and the spring. Every other proto fluid voxel the front meets is a
 * source of its own and spreads nothing here. Returns the settle's pops; `s` is a settle scratch
 * (`createSettleScratch`), reused between calls.
 */
export function springFront(view: RegionView, springs: SpringList, i: number, s: SettleScratch, out: SettleSink): number {
  if (i < 0 || i >= springs.n) throw new RangeError(`springFront: spring ${i} of ${springs.n}`);
  const [x, y, z] = regionVoxelOf(view, springs.pos[i]!);
  const column = protoColumns(view, 'springFront');
  const R = SPRING_FRONT_R;
  const W = 2 * R + 1;
  const src: SettleSource = {
    x0: x - R, z0: z - R, x1: x + R + 1, z1: z + R + 1,
    block: (qx, qy, qz) => column(qx, qy, qz)?.block(qx & 15, qy, qz & 15) ?? STONE,
    fluid: (qx, qy, qz) => column(qx, qy, qz)?.fluid(qx & 15, qy, qz & 15) ?? NO_FLUID,
    cave: (qx, qy, qz) => column(qx, qy, qz)?.cave(qx & 15, qy, qz & 15) ?? 0,
  };
  const seeds = Int32Array.of(((y - GRID_Y0) * W + R) * W + R);
  return settleWindow(src, seeds, 1, Int32Array.of(src.x0, src.z0, src.x1, src.z1), out, s, () => false);
}

/**
 * A region's settled bytes: `fl`, the settled fluid byte of every voxel of the view's region (the proto's, and
 * `settled`'s where the reference changed it), in the `CaveGrid` index `((y + 64)·D + (z − z0))·W + (x − x0)`, which is
 * `referenceSettleKey`'s; `orig`, the proto byte of each voxel the overlay changed.
 */
export interface SettledBytes {
  readonly fl: Uint8Array;
  readonly orig: ReadonlyMap<number, number>;
}

/** The view's `SettledBytes` under the overlay `settled`. */
export function settledBytes(view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, settled: ReadonlyMap<number, number>): SettledBytes {
  const W = 16 * view.w;
  const D = 16 * view.h;
  const fl = new Uint8Array(W * D * GRID_H);
  for (let cz = view.cz0; cz < view.cz0 + view.h; cz++) {
    for (let cx = view.cx0; cx < view.cx0 + view.w; cx++) {
      const col = view.store.proto(cx, cz);
      if (col === null) throw new Error(`settledBytes: column (${cx}, ${cz}) has no proto set`);
      const bx = 16 * (cx - view.cx0);
      const bz = 16 * (cz - view.cz0);
      for (let sy = 0; sy < 24; sy++) {
        const src = col.sectionFluid(sy);
        for (let ly = 0; ly < 16; ly++) {
          for (let lz = 0; lz < 16; lz++) {
            const at = ((16 * sy + ly) * D + bz + lz) * W + bx;
            if (typeof src === 'number') fl.fill(src, at, at + 16);
            else fl.set(src.subarray(ly * 256 + lz * 16, ly * 256 + lz * 16 + 16), at);
          }
        }
      }
    }
  }
  const orig = new Map<number, number>();
  for (const [k, v] of settled) {
    if (k < 0 || k >= fl.length) throw new RangeError(`settledBytes: key ${k} outside the region`);
    orig.set(k, fl[k]!);
    fl[k] = v;
  }
  return { fl, orig };
}

/**
 * A region loaded for the instruments (`loadWaterRegion`): its grid (proto fluid bit), settled bytes, proto bytes, tops
 * and interior, built once and read by both `waterRegionCounts` and `waterExamples` (the region worker passes one to
 * each), with A1's labelling kept on first use (`a1Of`).
 */
export interface WaterRegion {
  readonly g: CaveGrid;
  readonly fl: Uint8Array;
  readonly orig: ReadonlyMap<number, number>;
  /** The pre-cave top (`preCaveTops`) and the ground's top (`GROUND_RUN_BOTTOM`; −65 when none), per position. */
  readonly tops: Int16Array;
  readonly groundTop: Int16Array;
  /** The interior in grid-local x and z: lx0 ≤ x < lx1, lz0 ≤ z < lz1. */
  readonly lx0: number;
  readonly lz0: number;
  readonly lx1: number;
  readonly lz1: number;
}

/**
 * The region of `view` loaded for `waterRegionCounts` and `waterExamples` on `interior`; `bytes`, when the caller has
 * them already (`settledBytes(view, settled)`), are kept, not read again.
 */
export function loadWaterRegion(
  view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, settled: ReadonlyMap<number, number>, interior: WaterBox,
  bytes: SettledBytes = settledBytes(view, settled),
): WaterRegion {
  const g = caveGridOf(view);
  const { fl, orig } = bytes;
  const { w, d, cells } = g;
  const plane = w * d;
  const groundTop = new Int16Array(plane);
  const solid = (y: number, p: number): boolean => (cells[(y - GRID_Y0) * plane + p]! & SOLID_BIT) !== 0;
  for (let p = 0; p < plane; p++) {
    let y = GRID_Y0 + GRID_H - 1;
    for (;;) {
      while (y >= GRID_Y0 && !solid(y, p)) y--;
      const top = y;
      while (y >= GRID_Y0 && solid(y, p)) y--;
      if (top < GRID_Y0 || y + 1 < GROUND_RUN_BOTTOM) {
        groundTop[p] = top;
        break;
      }
    }
  }
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(hi, v));
  return {
    g, fl, orig, tops: preCaveTops(g), groundTop,
    lx0: clamp(interior.x0 - g.x0, w), lz0: clamp(interior.z0 - g.z0, d), lx1: clamp(interior.x1 - g.x0, w), lz1: clamp(interior.z1 - g.z0, d),
  };
}

/** The proto byte of cell i. */
const protoOf = (L: WaterRegion, i: number): number => L.orig.get(i) ?? L.fl[i]!;
/** Whether cell byte c is a cave voxel (tagged, not solid). */
const caveCell = (c: number): boolean => (c & TAG_MASK) !== 0 && (c & SOLID_BIT) === 0;
/** Whether cell i holds sky-open water: untagged proto water (the grid's fluid bit is T's, read first). */
const skyOpen = (L: WaterRegion, i: number): boolean => {
  const c = L.g.cells[i]!;
  return (c & TAG_MASK) === 0 && (c & FLUID_BIT) !== 0 && fluidType(protoOf(L, i)) === FLUID_WATER;
};

/** Per position, 1 when its sky-open level is 63 (see the header). */
function level63(L: WaterRegion): Uint8Array {
  const plane = L.g.w * L.g.d;
  const out = new Uint8Array(plane);
  const at63 = (SEA_Y - GRID_Y0) * plane;
  const at64 = at63 + plane;
  for (let p = 0; p < plane; p++) if (skyOpen(L, at63 + p) && !skyOpen(L, at64 + p)) out[p] = 1;
  return out;
}

/** A1's level-63 positions and labelling of a region (`a1Of`). */
interface A1Labels {
  readonly sea: Uint8Array;
  readonly label: Int32Array;
  readonly linked: ReadonlySet<number>;
}

const a1Cache = new WeakMap<WaterRegion, A1Labels>();

/** The region's level-63 positions and A1's labelling, computed on first use and kept with the region. */
function a1Of(L: WaterRegion): A1Labels {
  let a = a1Cache.get(L);
  if (a === undefined) {
    const sea = level63(L);
    a = { sea, ...seaLinked(L, sea) };
    a1Cache.set(L, a);
  }
  return a;
}

/** A1's components (index = the grid's, y −64 … 62) and the labels linked to level-63 sky-open water. */
function seaLinked(L: WaterRegion, sea: Uint8Array): { label: Int32Array; linked: Set<number> } {
  const { w, d, cells } = L.g;
  const { fl } = L;
  const plane = w * d;
  const c = components3d(
    (x, y, z) => {
      const i = (y - GRID_Y0) * plane + z * w + x;
      return caveCell(cells[i]!) || hasFluid(fl[i]!);
    },
    () => false,
    w, d, GRID_Y0, A1_Y_MAX,
  );
  const linked = new Set<number>();
  for (let p = 0; p < plane; p++) {
    if (sea[p] === 0) continue;
    for (let y = GRID_Y0; y <= A1_Y_MAX; y++) {
      const i = (y - GRID_Y0) * plane + p;
      if (skyOpen(L, i)) linked.add(c.label[i]!);
    }
  }
  return { label: c.label, linked };
}

/** Probes reading the generator (the recorded margin barriers): `marginProbes`. */
export interface MarginProbes {
  /** Whether world voxel (x, y, z) lies in the abyss box widened by the margin (`inAbyssMargin`; its own nibble aside). */
  inBox(x: number, y: number, z: number): boolean;
  /** Whether the voxel is an aquifer barrier (`barrierAt`) whose own nibble (`caveBiomeAt`) is not the abyss. */
  barrier(x: number, y: number, z: number): boolean;
}

/** `MarginProbes` of (seed, params): `aquiferOf` and a DensityContext of their own, each column's cave-biome pass kept. */
export function marginProbes(seed: string, params: Params): MarginProbes {
  const ctx = createGenContext(seedFromInput(seed), params);
  const dc = createDensityContext(ctx);
  const aq = aquiferOf(ctx);
  const pick = cavePickerOf(ctx);
  const sample = newColumnSample();
  const passes = new Map<string, CaveColumnPass>();
  const passOf = (cx: number, cz: number): CaveColumnPass => {
    const k = `${cx},${cz}`;
    let pass = passes.get(k);
    if (pass === undefined) {
      pass = fillCaveColumnPass(pick, buildColumnSample(ctx, cx, cz, sample), newCaveColumnPass());
      passes.set(k, pass);
    }
    return pass;
  };
  return {
    inBox: (x, y, z) => inAbyssMargin(aq, pick, passOf(x >> 4, z >> 4), x, y, z),
    barrier: (x, y, z) => barrierAt(aq, dc, x, y, z) && caveBiomeAt(dc, x, y, z) !== ABYSS,
  };
}

/** The recorded margin barriers of the interior (see the header). */
function marginBarrierCount(L: WaterRegion, probes: MarginProbes): number {
  const { x0, z0, w, d, cells } = L.g;
  const plane = w * d;
  const solidUntagged = (i: number): boolean => (cells[i]! & SOLID_BIT) !== 0 && (cells[i]! & TAG_MASK) === 0;
  const inBox = (i: number): boolean => {
    const x = i % w;
    const z = ((i - x) / w) % d;
    return probes.inBox(x0 + x, Math.floor(i / plane) + GRID_Y0, z0 + z);
  };
  const seen = new Set<number>();
  const queue: number[] = [];
  let count = 0;
  for (let cz = L.lz0; cz < L.lz1; cz += 16) {
    for (let cx = L.lx0; cx < L.lx1; cx += 16) {
      // A column whose positions all lie outside the widened box at its deepest voxel holds no margin voxel.
      let any = false;
      for (let z = cz; z < Math.min(cz + 16, L.lz1) && !any; z++) for (let x = cx; x < Math.min(cx + 16, L.lx1) && !any; x++) any = probes.inBox(x0 + x, GRID_Y0 + 1, z0 + z);
      if (!any) continue;
      for (let y = GRID_Y0 + 1; y < GRID_Y0 + GRID_H - 1; y++) {
        for (let z = cz; z < Math.min(cz + 16, L.lz1); z++) {
          for (let x = cx; x < Math.min(cx + 16, L.lx1); x++) {
            const i = (y - GRID_Y0) * plane + z * w + x;
            if (!solidUntagged(i) || seen.has(i)) continue;
            let seed = false;
            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, z > 0 ? i - w : -1, z < d - 1 ? i + w : -1, i - plane, i + plane]) {
              if (j >= 0 && caveCell(cells[j]!) && cells[j]! >> BIOME_SHIFT !== ABYSS) seed = true;
            }
            if (!seed || !inBox(i)) continue;
            seen.add(i);
            queue.push(i);
            while (queue.length > 0) {
              const v = queue.pop()!;
              const vx = v % w;
              const vz = ((v - vx) / w) % d;
              if (!probes.barrier(x0 + vx, Math.floor(v / plane) + GRID_Y0, z0 + vz)) continue;
              count++;
              for (const j of [vx > L.lx0 ? v - 1 : -1, vx < L.lx1 - 1 ? v + 1 : -1, vz > L.lz0 ? v - w : -1, vz < L.lz1 - 1 ? v + w : -1, v - plane, v + plane]) {
                if (j < plane || j >= cells.length - plane || seen.has(j) || !solidUntagged(j) || !inBox(j)) continue;
                seen.add(j);
                queue.push(j);
              }
            }
          }
        }
      }
    }
  }
  return count;
}

/**
 * One region's A counts (see the header) over the view's proto and the settle reference's overlay `settled` (keyed
 * `referenceSettleKey`, as `referenceSettle` returns it), on `interior` (world blocks); with `probes`, the margin
 * barriers too (else NaN).
 */
export function waterRegionCounts(
  view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, settled: ReadonlyMap<number, number>, interior: WaterBox, probes: MarginProbes | null = null,
  region: WaterRegion = loadWaterRegion(view, settled, interior),
): WaterRegionCounts {
  const L = region;
  const { w, d, cells } = L.g;
  const { fl, tops, groundTop } = L;
  const plane = w * d;
  // A1.
  let a1Population = 0;
  let a1Dry = 0;
  let a1DryT = 0;
  {
    const { label, linked } = a1Of(L);
    for (let y = GRID_Y0; y <= A1_Y_MAX; y++) {
      for (let z = L.lz0; z < L.lz1; z++) {
        for (let x = L.lx0; x < L.lx1; x++) {
          const i = (y - GRID_Y0) * plane + z * w + x;
          if (!caveCell(cells[i]!) || linked.has(label[i]!)) continue;
          a1Population++;
          if (!hasFluid(fl[i]!)) a1Dry++;
          if ((cells[i]! & FLUID_BIT) === 0) a1DryT++;
        }
      }
    }
  }
  // A3, and the recorded skyOpenDeep.
  let lavaBelow54 = 0;
  let aquiferLavaAbove10 = 0;
  let lava = 0;
  let lavaSupported = 0;
  let skyOpenDeep = 0;
  let maxWater = GRID_Y0 - 1;
  for (let y = GRID_Y0; y < GRID_Y0 + GRID_H; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const i = (y - GRID_Y0) * plane + z * w + x;
        const b = fl[i]!;
        if (fluidType(b) === FLUID_WATER) maxWater = y;
        if (x < L.lx0 || x >= L.lx1 || z < L.lz0 || z >= L.lz1) continue;
        const c = cells[i]!;
        if (y > AQUIFER_LAVA_Y && (c & TAG_MASK) !== 0 && (c & FLUID_BIT) !== 0 && fluidType(protoOf(L, i)) === FLUID_LAVA) aquiferLavaAbove10++;
        if (skyOpen(L, i) && groundTop[z * w + x]! - y > SKY_OPEN_DEEP) skyOpenDeep++;
        if (fluidType(b) !== FLUID_LAVA) continue;
        lava++;
        if (y <= LAVA_DEEP_Y) lavaBelow54++;
        if (fluidFalling(b) || (y > GRID_Y0 && ((cells[i - plane]! & SOLID_BIT) !== 0 || fluidType(fl[i - plane]!) === FLUID_LAVA))) lavaSupported++;
      }
    }
  }
  // A3's lavaSky: lava beside cave air of a C2 component (the components only where the interior holds lava).
  let lavaSky = 0;
  if (lava > 0) {
    const c = caveComponents(L.g, tops);
    const sky = deepSkyLabels(L.g, tops, c);
    const skyAir = (j: number): boolean => {
      const y = Math.floor(j / plane) + GRID_Y0;
      if (y < c.yMin || y > c.yMax || hasFluid(fl[j]!)) return false;
      const l = c.label[j - (c.yMin - GRID_Y0) * plane]!;
      return l !== 0 && sky.has(l);
    };
    for (let y = GRID_Y0 + 1; y < GRID_Y0 + GRID_H - 1; y++) {
      for (let z = L.lz0; z < L.lz1; z++) {
        for (let x = L.lx0; x < L.lx1; x++) {
          const i = (y - GRID_Y0) * plane + z * w + x;
          if (fluidType(fl[i]!) !== FLUID_LAVA) continue;
          if ((x > 0 && skyAir(i - 1)) || (x < w - 1 && skyAir(i + 1)) || (z > 0 && skyAir(i - w)) || (z < d - 1 && skyAir(i + w)) || skyAir(i - plane) || skyAir(i + plane)) lavaSky++;
        }
      }
    }
  }
  // A4.
  let aquiferBodies = 0;
  if (maxWater >= GRID_Y0) {
    const c = components3d((x, y, z) => fluidType(fl[(y - GRID_Y0) * plane + z * w + x]!) === FLUID_WATER, () => false, w, d, GRID_Y0, maxWater);
    const n = c.size.size + 1;
    const open = new Uint8Array(n);
    const below = new Uint8Array(n);
    for (let i = 0; i < c.label.length; i++) {
      const l = c.label[i]!;
      if (l === 0) continue;
      if (skyOpen(L, i)) open[l] = 1;
      const x = i % w;
      const z = ((i - x) / w) % d;
      if (x >= L.lx0 && x < L.lx1 && z >= L.lz0 && z < L.lz1 && Math.floor(i / plane) + GRID_Y0 < tops[z * w + x]!) below[l] = 1;
    }
    for (let l = 1; l < n; l++) if (open[l] === 0 && below[l] === 1) aquiferBodies++;
  }
  // The pits below sea.
  let lowTops = 0;
  let dryPits = 0;
  let dryPitsT = 0;
  for (let z = L.lz0; z < L.lz1; z++) {
    for (let x = L.lx0; x < L.lx1; x++) {
      const top = groundTop[z * w + x]!;
      if (top >= SEA_Y || top < GRID_Y0) continue;
      lowTops++;
      const i = (top + 1 - GRID_Y0) * plane + z * w + x;
      if (!hasFluid(fl[i]!)) dryPits++;
      if ((cells[i]! & FLUID_BIT) === 0) dryPitsT++;
    }
  }
  return {
    areaKm2: ((L.lx1 - L.lx0) * (L.lz1 - L.lz0)) / 1e6,
    a1Population, a1Dry, a1DryT, lavaBelow54, aquiferLavaAbove10, lava, lavaSupported, lavaSky, aquiferBodies, skyOpenDeep,
    marginBarriers: probes === null ? Number.NaN : marginBarrierCount(L, probes), lowTops, dryPits, dryPitsT,
  };
}

// ---------------------------------------------------------------- A2 by origin (SP7a spec §13.1; Task 23)

/**
 * A settled voxel's origin (`refs.ts`' `referenceSettleOrigins`): sky-open water (D19's untagged proto water), an
 * aquifer cell (tagged proto fluid), a spring; ties of distance go to the lower of the first two.
 */
export const ORIGIN_SKY_OPEN = 0;
export const ORIGIN_AQUIFER = 1;
export const ORIGIN_SPRING = 2;
/** The origins' names, by label (A2's record). */
export const ORIGIN_NAMES = ['skyOpen', 'aquifer', 'spring'] as const;
export type OriginName = (typeof ORIGIN_NAMES)[number];

/**
 * The origin of a proto fluid voxel that `referenceSettleOrigins` does not list (it is its own nearest source, at
 * distance 0): from its cave byte (or a grid cell's tag bits), sky-open when untagged, else aquifer.
 */
export const protoOrigin = (cave: number): number => ((cave & TAG_MASK) === 0 ? ORIGIN_SKY_OPEN : ORIGIN_AQUIFER);

/** The settle's value code of a fluid byte (`fluidRules.ts`' encoding): source, falling, flowing level k as 1 + k. */
const codeOf = (b: number): number => (fluidFalling(b) ? FLUID_VALUE_FALLING : fluidLevel(b) === 0 ? FLUID_VALUE_SOURCE : 1 + fluidLevel(b));

/** Three counts by origin. */
type ByOrigin = Readonly<Record<OriginName, number>>;
const byOrigin = (a: readonly number[]): ByOrigin => ({ skyOpen: a[0]!, aquifer: a[1]!, spring: a[2]! });

/** One region's A2 counts on its interior (`a2RegionCounts`): numbers only. */
export interface A2RegionCounts {
  /** The interior's area, km². */
  readonly areaKm2: number;
  /**
   * By origin: the fluid voxels after settle; those A2 counts unsupported (one application of §4.1's rules would change
   * them, the unsettled counted); the unsettled (bit 6 outside the contact set).
   */
  readonly fluid: ByOrigin;
  readonly unsupported: ByOrigin;
  readonly unsettled: ByOrigin;
  /** The water/lava contacts (§4.1's merge) among the interior's fluid voxels. */
  readonly contacts: number;
}

/**
 * A2's counts of one region (SP7a spec §13.1) on `interior`, after the settle reference (`settled`, keyed
 * `referenceSettleKey`), with `referenceSettleOrigins`' `origins` and `contacts` (same keys):
 * - each fluid voxel after settle counts in its origin (`origins`' label, else `protoOrigin` of its cave tag);
 * - `unsettled`: a fluid voxel whose bit 6 is set and that is not a contact (a contact is SP7b's reaction, counted
 *   apart in `contacts`);
 * - `unsupported`: the fluid voxels one application of §4.1's rules (`ruleOffers` over the proto, `protoRuleReader`)
 *   would change, counting the unsettled: at each fluid voxel u (of the interior grown by a block, so a feeder outside
 *   the interior is read), its offers at its settled value (its distance unknown from the byte: 0, or the cap when its
 *   bit 6 is set, so it offers what the settle let it offer) are applied to the settled bytes; an offer into a voxel
 *   with no fluid (a spread or a fall into a passable voxel) counts u; an offer of a lower value into a voxel of u's
 *   type (a level a feeder would lower, a missing fall) counts that voxel; an offer into the other type's fluid is a
 *   contact's, not counted. Each voxel counts once, in its origin, only inside the interior. A voxel none of whose
 *   neighbours below and beside is passable without fluid, or holds its type's fluid other than a source, can offer
 *   nothing that changes them, so `ruleOffers` runs only at the others.
 */
export function a2RegionCounts(
  view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, settled: ReadonlyMap<number, number>, interior: WaterBox,
  origins: ReadonlyMap<number, number>, contacts: ReadonlySet<number>, region: WaterRegion = loadWaterRegion(view, settled, interior),
): A2RegionCounts {
  const L = region;
  const { x0, z0, w, d, cells } = L.g;
  const { fl } = L;
  const plane = w * d;
  const r = protoRuleReader(view);
  const offers = new Int32Array(45);
  const inside = (x: number, z: number): boolean => x >= L.lx0 && x < L.lx1 && z >= L.lz0 && z < L.lz1;
  const fluid = [0, 0, 0];
  const unsettled = [0, 0, 0];
  let contactN = 0;
  /** The interior's voxels the rules would change (or that are unsettled). */
  const changed = new Set<number>();
  const gx0 = Math.max(0, L.lx0 - 1), gz0 = Math.max(0, L.lz0 - 1), gx1 = Math.min(w, L.lx1 + 1), gz1 = Math.min(d, L.lz1 + 1);
  for (let y = GRID_Y0; y < GRID_Y0 + GRID_H; y++) {
    for (let z = gz0; z < gz1; z++) {
      for (let x = gx0; x < gx1; x++) {
        const i = (y - GRID_Y0) * plane + z * w + x;
        const b = fl[i]!;
        if (!hasFluid(b)) continue;
        const own = inside(x, z);
        if (own) {
          fluid[origins.get(i) ?? protoOrigin(cells[i]!)]!++;
          if (contacts.has(i)) contactN++;
          else if (fluidUnsettled(b)) {
            unsettled[origins.get(i) ?? protoOrigin(cells[i]!)]!++;
            changed.add(i);
          }
        }
        const type = fluidType(b);
        let open = false;
        for (let f = 0; f < 5 && !open; f++) {
          const nx = f < 4 ? x + DIR_DX[f]! : x;
          const nz = f < 4 ? z + DIR_DZ[f]! : z;
          const ny = f < 4 ? y : y - 1;
          if (nx < 0 || nx >= w || nz < 0 || nz >= d || ny < GRID_Y0) continue;
          const nb = fl[(ny - GRID_Y0) * plane + nz * w + nx]!;
          open = hasFluid(nb) ? fluidType(nb) === type && codeOf(nb) !== FLUID_VALUE_SOURCE : r.passable(x0 + nx, ny, z0 + nz);
        }
        if (!open) continue;
        const n = ruleOffers(type, r, x0 + x, y, z0 + z, codeOf(b), fluidUnsettled(b) ? capOf(type) : 0, offers) & 15;
        for (let o = 0; o < 5 * n; o += 5) {
          const tx = x + offers[o]!, ty = y + offers[o + 1]!, tz = z + offers[o + 2]!;
          const t = (ty - GRID_Y0) * plane + tz * w + tx;
          const tb = fl[t]!;
          if (!hasFluid(tb)) {
            if (own) changed.add(i);
          } else if (fluidType(tb) === type && offers[o + 3]! < codeOf(tb) && inside(tx, tz)) {
            changed.add(t);
          }
        }
      }
    }
  }
  const unsupported = [0, 0, 0];
  for (const i of changed) unsupported[origins.get(i) ?? protoOrigin(cells[i]!)]!++;
  return {
    areaKm2: ((L.lx1 - L.lx0) * (L.lz1 - L.lz0)) / 1e6,
    fluid: byOrigin(fluid), unsupported: byOrigin(unsupported), unsettled: byOrigin(unsettled), contacts: contactN,
  };
}

/** A2's values for one origin (or all): its fluid voxels, the unsupported and unsettled counts, their shares and their rates per km². */
export interface A2OriginValues {
  readonly fluid: number;
  readonly unsupported: number;
  readonly unsettled: number;
  readonly unsupportedShare: number;
  readonly unsettledShare: number;
  readonly unsupportedKm2: number;
  readonly unsettledKm2: number;
}

/** A group's A2 (SP7a spec §13.1): the two parts over every fluid voxel, the record by origin, the contacts apart. */
export interface A2Parts {
  /** A2's parts: the unsupported (counting the unsettled) and the unsettled, each over all fluid voxels, pooled. */
  readonly unsupported: number;
  readonly unsettled: number;
  /** Recorded: the pooled counts and rates (`all`) and by origin. */
  readonly all: A2OriginValues;
  readonly byOrigin: Readonly<Record<OriginName, A2OriginValues>>;
  /** `A2.contacts` (recorded): the contacts, and per km². */
  readonly contacts: number;
  readonly contactsKm2: number;
}

/** A group's A2 (`A2Parts`) over its regions' counts; the shares and rates NaN over an empty population. */
export function a2Parts(regions: readonly A2RegionCounts[]): A2Parts {
  const area = regions.reduce((a, r) => a + r.areaKm2, 0);
  const values = (f: (c: ByOrigin) => number): A2OriginValues => {
    const fl = regions.reduce((a, r) => a + f(r.fluid), 0);
    const un = regions.reduce((a, r) => a + f(r.unsupported), 0);
    const us = regions.reduce((a, r) => a + f(r.unsettled), 0);
    return {
      fluid: fl, unsupported: un, unsettled: us, unsupportedShare: share(un, fl), unsettledShare: share(us, fl),
      unsupportedKm2: share(un, area), unsettledKm2: share(us, area),
    };
  };
  const all = values((c) => c.skyOpen + c.aquifer + c.spring);
  const contacts = regions.reduce((a, r) => a + r.contacts, 0);
  return {
    unsupported: all.unsupportedShare, unsettled: all.unsettledShare, all,
    byOrigin: { skyOpen: values((c) => c.skyOpen), aquifer: values((c) => c.aquifer), spring: values((c) => c.spring) },
    contacts, contactsKm2: share(contacts, area),
  };
}

/** The four sides as [dx, dz, the yaw facing that way]. */
const SIDES: ReadonlyArray<readonly [number, number, number]> = [[0, -1, 0], [1, 0, 90], [0, 1, 180], [-1, 0, 270]];

/**
 * The review poses of one region (see the header): at most one per id, from the view's proto and the overlay, on
 * `interior`; `spawn` is `findSpawn`'s (x, z) and `river` `riverMaskOf`'s over the region (per position (z − z0)·W +
 * (x − x0)). `waterExamplesOf` computes both from the seed and the params. `region` as `waterRegionCounts`'.
 */
export function waterExamples(
  view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, settled: ReadonlyMap<number, number>, interior: WaterBox,
  spawn: { readonly x: number; readonly z: number }, river: (g: CaveGrid) => Uint8Array,
  region: WaterRegion = loadWaterRegion(view, settled, interior),
): Record<WaterExampleId, CavePose | null> {
  const L = region;
  const { x0, z0, w, d, cells } = L.g;
  const { fl, tops, groundTop } = L;
  const plane = w * d;
  const riv = river(L.g);
  const { sea, label, linked } = a1Of(L);
  const best = new Map<WaterExampleId, { d2: number; pose: CavePose }>();
  const offer = (id: WaterExampleId, x: number, y: number, z: number, eye: (wx: number, wz: number) => Omit<CavePose, 'voxel' | 'component'>, component: number): void => {
    const wx = x0 + x;
    const wz = z0 + z;
    const d2 = (wx + 0.5 - spawn.x) * (wx + 0.5 - spawn.x) + (wz + 0.5 - spawn.z) * (wz + 0.5 - spawn.z);
    const b = best.get(id);
    if (b !== undefined && b.d2 <= d2) return;
    best.set(id, { d2, pose: { ...eye(wx, wz), voxel: [wx, y, wz], component } });
  };
  const caveEye = (x: number, y: number, z: number) => (wx: number, wz: number) => ({ x: wx + 0.5, y: y + 0.5, z: wz + 0.5, yaw: longestRunYaw(L.g, x, y, z), pitch: 0 });
  const dryCave = (i: number): boolean => caveCell(cells[i]!) && !hasFluid(fl[i]!);
  for (let y = GRID_Y0 + 2; y < GRID_Y0 + GRID_H - 1; y++) {
    for (let z = L.lz0; z < L.lz1; z++) {
      for (let x = L.lx0; x < L.lx1; x++) {
        const p = z * w + x;
        const i = (y - GRID_Y0) * plane + p;
        if (y <= A1_Y_MAX && caveCell(cells[i]!)) {
          const l = label[i]!;
          if (linked.has(l)) {
            if (sea[p] === 1 && y < tops[p]! && fluidType(fl[i]!) === FLUID_WATER) offer('floodedUnderSea', x, y, z, caveEye(x, y, z), l);
          } else if (groundTop[p]! >= SEA_Y && dryCave(i) && dryCave(i - plane) && (cells[i - 2 * plane]! & SOLID_BIT) !== 0) {
            offer('dryBelowSea', x, y, z, caveEye(x, y, z), l);
          }
        }
        if (!skyOpen(L, i)) continue;
        if (y === SEA_Y && sea[p] === 1) {
          for (const [dx, dz, yaw] of SIDES) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nx >= w || nz < 0 || nz >= d) continue;
            const q = nz * w + nx;
            if (riv[p] === 1 && riv[q] === 0 && sea[q] === 1 && skyOpen(L, i + q - p)) {
              offer('riverMouth', x, y, z, (wx, wz) => ({ x: wx + 0.5, y: SEA_Y + 17, z: wz + 0.5, yaw: 0, pitch: -60 }), 0);
            }
            if (groundTop[q]! >= SEA_Y && (cells[i + q - p]! & SOLID_BIT) !== 0) {
              offer('coastFancy', x, y, z, (wx, wz) => ({ x: wx + 0.5, y: SEA_Y + 2.5, z: wz + 0.5, yaw: (yaw + 180) % 360, pitch: -10 }), 0);
            }
          }
          let deep = true;
          for (let k = 1; k <= 10 && deep; k++) deep = skyOpen(L, i - k * plane);
          if (deep) offer('underwater', x, SEA_Y - 5, z, (wx, wz) => ({ x: wx + 0.5, y: SEA_Y + 1 - 6, z: wz + 0.5, yaw: longestRunYaw(L.g, x, SEA_Y - 5, z), pitch: 0 }), 0);
        }
        if (y > SEA_Y && (cells[i + plane]! & (SOLID_BIT | TAG_MASK | FLUID_BIT)) === 0 && x > 0 && x < w - 1 && z > 0 && z < d - 1
          && skyOpen(L, i - 1) && skyOpen(L, i + 1) && skyOpen(L, i - w) && skyOpen(L, i + w)) {
          offer('lake', x, y, z, (wx, wz) => ({ x: wx + 0.5, y: y + 9, z: wz + 0.5, yaw: 0, pitch: -45 }), 0);
        }
      }
    }
  }
  const out = {} as Record<WaterExampleId, CavePose | null>;
  for (const id of WATER_EXAMPLE_IDS) out[id] = best.get(id)?.pose ?? null;
  return out;
}

/** `waterExamples` with `findSpawn` and `riverMaskOf` of (seed, params). */
export function waterExamplesOf(
  view: Pick<RegionView, 'cx0' | 'cz0' | 'w' | 'h' | 'store'>, settled: ReadonlyMap<number, number>, interior: WaterBox, seed: string, params: Params,
  region: WaterRegion = loadWaterRegion(view, settled, interior),
): Record<WaterExampleId, CavePose | null> {
  const spawn = findSpawn(createGenContext(seedFromInput(seed), params));
  return waterExamples(view, settled, interior, spawn, (g) => riverMaskOf(g, seed, params), region);
}

/** The A parts of a group (SP7a spec §13.1), from its regions' counts: the parts, and the values recorded beside them. */
export interface WaterParts {
  /** A1's share after settle, pooled over the regions, and on T alone over the same population. */
  readonly dryShare: number;
  readonly dryShareT: number;
  /** A3: the regions holding lava at y ≤ −55 over the regions; the tagged proto lava above −10; the supported share; the regions where lava touches C2's cave air over the regions. */
  readonly lavaBelow54: number;
  readonly aquiferLavaAbove10: number;
  readonly lavaSupported: number;
  readonly lavaSkyRegions: number;
  /** A4: the fewest aquifer bodies of a region. */
  readonly aquiferBodies: number;
  /** Recorded: the sums of `skyOpenDeep` and `marginBarriers`, and the pits below sea dry after settle and in T over the low tops. */
  readonly skyOpenDeep: number;
  readonly marginBarriers: number;
  readonly dryPitsBelowSea: number;
  readonly dryPitsBelowSeaT: number;
}

/** A ratio, NaN over an empty population. */
const share = (a: number, b: number): number => (b === 0 ? Number.NaN : a / b);

/** A group's A parts (`WaterParts`) over its regions' counts; every part NaN over no region. */
export function waterParts(regions: readonly WaterRegionCounts[]): WaterParts {
  const sum = (f: (r: WaterRegionCounts) => number): number => regions.reduce((a, r) => a + f(r), 0);
  const regionsWith = (f: (r: WaterRegionCounts) => number): number => share(regions.filter((r) => f(r) > 0).length, regions.length);
  return {
    dryShare: share(sum((r) => r.a1Dry), sum((r) => r.a1Population)),
    dryShareT: share(sum((r) => r.a1DryT), sum((r) => r.a1Population)),
    lavaBelow54: regionsWith((r) => r.lavaBelow54),
    aquiferLavaAbove10: regions.length === 0 ? Number.NaN : sum((r) => r.aquiferLavaAbove10),
    lavaSupported: share(sum((r) => r.lavaSupported), sum((r) => r.lava)),
    lavaSkyRegions: regionsWith((r) => r.lavaSky),
    aquiferBodies: regions.length === 0 ? Number.NaN : Math.min(...regions.map((r) => r.aquiferBodies)),
    skyOpenDeep: regions.length === 0 ? Number.NaN : sum((r) => r.skyOpenDeep),
    marginBarriers: regions.length === 0 ? Number.NaN : sum((r) => r.marginBarriers),
    dryPitsBelowSea: share(sum((r) => r.dryPits), sum((r) => r.lowTops)),
    dryPitsBelowSeaT: share(sum((r) => r.dryPitsT), sum((r) => r.lowTops)),
  };
}

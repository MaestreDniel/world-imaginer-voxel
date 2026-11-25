/**
 * SP7a golden digests (SP7a spec §15.3, D33), chained last into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`),
 * so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. The generator push adds
 * `sp7a.aquifer.points` (Task 14), `sp7a.springs` (Task 21) and `sp7a.region.D.water` (Task 32).
 * - `sp7a.aquifer.points` (SP7a spec §1, §13.4, §15.3): the aquifer's point functions at 256 fixed 3D points, world seed
 *   '42', default profile: `fluidAt` (the proto fluid byte T writes there) and `barrierAt` (whether T makes it barrier
 *   rock) over `aquiferOf(ctx)` and a DensityContext of `ctx`. The points are drawn from
 *   `Xoshiro128(fnv1a32('sp7a.aquifer.points'))` as x = −4096 + nextInt(8193), z = −4096 + nextInt(8193),
 *   y = −63 + nextInt(184) (within ±4,096 blocks, y −63 … 120), in that order; the digest is the FNV-1a 64 of two bytes
 *   per point in draw order, the `fluidAt` byte then the `barrierAt` bit (1 or 0).
 * - `sp7a.springs` (SP7a spec §3, §15.3; Task 21): the springs T's springs step accepts (`terrainSpringsDebug`) in 16
 *   fixed chunk columns per kind, world seed '42': `WATER_CHUNKS` on the default profile (water springs), `ISLAND_CHUNKS`
 *   on floating_islands (island springs) and `LAVA_CHUNKS` on the default profile (lava springs in the abyss), in that
 *   order, each list in its order. Each list is a literal found by a scan at seed '42' at Task 21 (water re-scanned when
 *   a springs lever moves its springs, Tasks 28 and 31r), each chunk holding at least one spring of its kind (the first
 *   16 in ring order, ring r then cz then cx): water from chunk (0, 0) over the columns whose 7 × 7 offset lattice
 *   reaches y 64 with a relief of at least 8 (the mountain witness's prefilter);
 *   island from (0, 0) over the columns whose lattice holds an islandMask above 0; lava from SP6b's abyss column
 *   (−3000, −1182). The digest is the FNV-1a 64 of, per chunk, its spring count (one byte), then per spring in decision
 *   order its world x, y and z (int32 little-endian each), its kind byte (0 water, 1 island, 2 lava) and its outlet's
 *   direction (0 … 3, N, E, S, W): every spring of the chunk, whatever its kind.
 * - `sp7a.region.D.water` (SP7a spec §13.4, §15.3; Task 32): the final fluid of the 6 × 6 interior of DT1's first settle
 *   window (the coast window, which holds a water spring), world seed '42', default profile: the interior's columns at
 *   chunks (6a … 6a + 5, 6b … 6b + 5) for candidate S(a, b) = `SETTLE_WINDOW_GOLDEN`, each decorated (D with its settle)
 *   from its own 3 × 3 at Proto, so T runs on the interior grown by one ring (`genRegionDInProcess` over the 8 × 8 window
 *   at (6a − 1, 6b − 1), in process on a fresh `ArrayBuffer` store). `SETTLE_WINDOW_GOLDEN` mirrors `SETTLE_WINDOWS[0]`
 *   (`test/harness/settleWindows.ts`; a `metrics/` module cannot import `test/`), pinned equal by
 *   `goldens.sp7a.test.ts`, and moves with it when a lever re-scans the window. The digest is `finalFluidHash` of the
 *   interior: per column (cz outer, cx inner) its 24 sections' 4096 final fluid bytes.
 * Follows the core determinism rules (in `DET_FILES`, arch-tested). Every value is hex64.
 */
import { fnv1a32, fnv1a64Bytes, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { createGenContext } from '../gen/context';
import { createDensityContext } from '../gen/density/context';
import { aquiferOf, barrierAt, fluidAt } from '../gen/fluids/aquifer';
import { newSpringList } from '../gen/fluids/springs';
import { terrainSpringsDebug } from '../gen/pipeline/terrainStage';
import { createStore } from '../world/store/store';
import { finalFluidHash, genRegionDInProcess } from './region';

const FNV32 = fnv1a32;
const FNV64 = fnv1a64Bytes;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const CREATE_DC = createDensityContext;
const AQUIFER_OF = aquiferOf;
const FLUID_AT = fluidAt;
const BARRIER_AT = barrierAt;
const NEW_SPRING_LIST = newSpringList;
const SPRINGS_OF = terrainSpringsDebug;
const CREATE_STORE = createStore;
const GEN_REGION_D = genRegionDInProcess;
const FINAL_FLUID_HASH = finalFluidHash;

const POINTS = 256;
/** The points' horizontal reach (±4,096 blocks) and height range (y −63 … 120). */
const POINT_REACH = 4096;
const POINT_Y_LO = -63;
const POINT_Y_HI = 120;

/** `sp7a.aquifer.points`' 256 points, world [x, y, z], drawn as the module comment states. */
export function aquiferPoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp7a.aquifer.points'));
  const out: Array<[number, number, number]> = [];
  for (let n = 0; n < POINTS; n++) {
    const x = -POINT_REACH + r.nextInt(2 * POINT_REACH + 1);
    const z = -POINT_REACH + r.nextInt(2 * POINT_REACH + 1);
    const y = POINT_Y_LO + r.nextInt(POINT_Y_HI - POINT_Y_LO + 1);
    out.push([x, y, z]);
  }
  return out;
}

/** `sp7a.aquifer.points`: the FNV-1a 64 of the `fluidAt` byte and the `barrierAt` bit at each point (seed '42', default profile). */
export function aquiferPointsDigest(): string {
  const ctx = CREATE_CTX(SEED('42'), RESOLVE('default'));
  const inp = AQUIFER_OF(ctx);
  const dc = CREATE_DC(ctx);
  const bytes = new Uint8Array(2 * POINTS);
  let n = 0;
  for (const [x, y, z] of aquiferPoints()) {
    bytes[n++] = FLUID_AT(inp, dc, x, y, z);
    bytes[n++] = BARRIER_AT(inp, dc, x, y, z) ? 1 : 0;
  }
  return HEX64(FNV64(bytes));
}

/**
 * `sp7a.springs`' water chunks: default profile, seed '42' (the module comment's scan, re-run by Task 31r at
 * `springs.water.tries` 18 with Task 28d's rejection of a predicted truncation: 3,125 columns examined; at tries 3,
 * Task 28a's list at `minFall` 7, 9,144; at `minFall` 8, Task 21's list, 11,108).
 */
export const WATER_CHUNKS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [-23, 18], [-24, -2], [-25, 23], [-27, 25], [-26, 28], [-31, -8], [-31, -7], [-32, -15],
  [-32, -7], [-32, 2], [-33, -15], [-33, -6], [-35, -16], [-37, -3], [-39, 1], [-40, 16],
] as const);
/** `sp7a.springs`' island chunks: floating_islands, seed '42' (1,921 columns examined; the first 8 are `springs.test.ts`' ISLAND_SPRINGS). */
export const ISLAND_CHUNKS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [-14, 15], [-20, 5], [-21, 0], [-23, -16], [-26, -1], [-27, -3], [-30, 0], [-31, -4],
  [-32, 8], [33, 29], [-35, 3], [-36, 4], [-37, -16], [39, 25], [40, 24], [39, 42],
] as const);
/** `sp7a.springs`' lava chunks: default profile, seed '42', around SP6b's abyss column (5,518 columns examined). */
export const LAVA_CHUNKS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [-3002, -1181], [-3009, -1182], [-3002, -1194], [-2987, -1181], [-2979, -1163], [-2977, -1195], [-2979, -1206], [-2974, -1201],
  [-2984, -1209], [-2973, -1197], [-2982, -1210], [-2997, -1213], [-2968, -1163], [-3011, -1217], [-3012, -1219], [-2963, -1162],
] as const);

/** `sp7a.springs`: the FNV-1a 64 of the springs of the three chunk lists (the module comment's bytes). */
export function springsDigest(): string {
  const def = CREATE_CTX(SEED('42'), RESOLVE('default'));
  const fi = CREATE_CTX(SEED('42'), RESOLVE('floating_islands'));
  const list = NEW_SPRING_LIST();
  const bytes: number[] = [];
  const word = (v: number): void => { bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
  const lists = [[def, WATER_CHUNKS], [fi, ISLAND_CHUNKS], [def, LAVA_CHUNKS]] as const;
  for (const [ctx, chunks] of lists) {
    for (const [cx, cz] of chunks) {
      SPRINGS_OF(ctx, cx, cz, list);
      bytes.push(list.n);
      for (let k = 0; k < list.n; k++) {
        const j = list.pos[k]!;
        word(16 * cx + (j & 15));
        word((j >> 8) - 64);
        word(16 * cz + ((j >> 4) & 15));
        bytes.push(list.kind[k]!, list.dir[k]!);
      }
    }
  }
  return HEX64(FNV64(Uint8Array.from(bytes)));
}

/**
 * `sp7a.region.D.water`'s settle window, candidate S(a, b) of DT1's settle windows: `SETTLE_WINDOWS[0]` (the coast,
 * Task 19's re-scan S(19, −30), kept by Tasks 21-31r), mirrored here as a literal (module comment).
 */
export const SETTLE_WINDOW_GOLDEN: { readonly a: number; readonly b: number } = Object.freeze({ a: 19, b: -30 });
/** The settle window's interior side, in chunks (the 10 × 10 window keeps two rings around it). */
const SETTLE_INTERIOR = 6;
const MiB = 1048576;

/** `sp7a.region.D.water`: `finalFluidHash` of the settle window's 6 × 6 interior after D (module comment). */
export function settleWindowWaterDigest(): string {
  const cx0 = 6 * SETTLE_WINDOW_GOLDEN.a;
  const cz0 = 6 * SETTLE_WINDOW_GOLDEN.b;
  const store = CREATE_STORE({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  GEN_REGION_D(store, CREATE_CTX(SEED('42'), RESOLVE('default')), cx0 - 1, cz0 - 1, SETTLE_INTERIOR + 2, SETTLE_INTERIOR + 2);
  return HEX64(FINAL_FLUID_HASH(store, cx0, cz0, SETTLE_INTERIOR, SETTLE_INTERIOR));
}

export function sp7aGoldenKeys(): string[] {
  return ['sp7a.aquifer.points', 'sp7a.springs', 'sp7a.region.D.water'];
}

export function computeSp7aGolden(key: string): string {
  if (key === 'sp7a.aquifer.points') return aquiferPointsDigest();
  if (key === 'sp7a.springs') return springsDigest();
  if (key === 'sp7a.region.D.water') return settleWindowWaterDigest();
  throw new Error(`unknown golden ${key}`);
}

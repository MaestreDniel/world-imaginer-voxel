/**
 * The region harness `genRegion` (SP3a spec §6.1, SP4a spec §9.2): generates a w × h region R of columns up to the T
 * stage (SP3b's density terrain), the D skeleton, the light or the column meshes, in a chosen order, on 1 thread (a
 * plain `ArrayBuffer` store, the stage functions in process) or on 4 `worker_threads` (a growable `SharedArrayBuffer`
 * store; each worker runs `regionWorker.ts`, and the main thread hands the next column of a stage's list to whichever
 * worker is idle, so every column of a stage is run by exactly one thread), optionally through the region cache
 * (`cache.ts`). The stages run one after the other, each over its own set, which honours the coordinator's
 * prerequisite rules (D needs its 3 × 3 at Proto, L its 3 × 3 at Decorated, MESH its 3 × 3 Published). The result is
 * read through a `RegionView`, which reads the store per column and never stitches the region into one array.
 * SP5a (spec §6.3): `diff` hands each column's edit entries to its D (`fillColumnD`'s overlay, spec §2.5), on 1 thread
 * and without the cache only.
 * SP6a (spec §10.3): `carverCacheCapacity` sets the carver path cache's capacity in every thread that generates, and
 * `isolatedColumn` generates one column alone on a fresh store (`DT1.carverCache`, `DT1.isolated`). SP6a (spec §10.1):
 * the view reads the store's cave channel (`tag`) and the pre-cave top (`preCaveTop`), and with `debugTags` the pillar
 * bit and the `terrain` tap per voxel (`caveDebugColumn`).
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { colKey } from '../../src/core/coords';
import { createFnv64, hex64, type Fnv64, type Hash64 } from '../../src/core/hash';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import type { Params } from '../../src/core/params/schema';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput } from '../../src/core/seed';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { carverCacheOf } from '../../src/gen/caves/carverCache';
import { caveReadersOf } from '../../src/gen/caves/tags';
import type { GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { createLightScratch, type LightScratch } from '../../src/light/initial';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { createMeshScratch, type ColumnMeshPayload } from '../../src/mesh/column';
import type { MeshOptions } from '../../src/mesh/greedy';
import { AIR } from '../../src/world/blocks/index';
import type { ColumnDiff } from '../../src/world/store/api';
import { protoAt, STATUS_PUBLISHED } from '../../src/world/store/columnTable';
import { PROTO_INTS } from '../../src/world/store/section';
import { createStore, type AuxView, type ColumnView, type VoxelStore } from '../../src/world/store/store';
import { fillColumnD, fillColumnL, meshColumnJob } from '../../src/workers/worldJobs';
import { readRegionDump, regionCachePath, srcKey, writeRegionDump, type RegionCacheHeader, type RegionUpTo } from './cache';
import { ask, buildNodeTaskWorker } from './nodeWorker';
import { genContextWith, type RegionAttachMsg, type RegionColumnMsg, type RegionMeshMsg, type RegionWorkerReply } from './regionWorker';

export type RegionOrder = 'spiral' | 'shuffled';

export interface GenRegionOptions {
  /** World seed text, as typed in the UI ('42'). */
  readonly seed: string;
  readonly params: Params;
  readonly cx0: number;
  readonly cz0: number;
  /**
   * 1 … 64 columns per side (a larger region would collide on the 64 × 64 torus), and the outermost set at most 64
   * per side: w + 2 for 'D', w + 4 for 'L', w + 6 for 'MESH' (ruling P31).
   */
  readonly w: number;
  readonly h: number;
  /**
   * The last stage (SP4a spec §9.2, ruling P31). For 'T', 'D' and 'L' that stage covers R and each earlier stage one
   * more ring than the stage after it ('L': L on R, D on R + 1, T on R + 2). 'MESH' takes the 'L' region grown by one
   * ring, (cx0 − 1, cz0 − 1, w + 2, h + 2) (from the cache, or generated and dumped), and meshes R's columns, which are
   * never dumped: T on R + 3, D on R + 2, L on R + 1, MESH on R.
   */
  readonly upTo: RegionUpTo;
  readonly order: RegionOrder;
  readonly threads: 1 | 4;
  /**
   * The store over growable `SharedArrayBuffer`s (default `threads === 4`): `threads: 1, shared: true` gives a store a
   * worker can attach (the attach guard needs shared buffers), such as the sim handler's tests (SP5a).
   */
  readonly shared?: boolean;
  /** Read the dump on a hit, write it on a miss (default false: never touch a dump). */
  readonly cache?: boolean;
  /** Seed of the `shuffled` permutation (default 1). */
  readonly shuffleSeed?: number;
  /** Test seam: the directory of the dumps (default `test/.cache/regions/`). */
  readonly cacheDir?: string;
  /** Test seam: the source key to use instead of the repository's (`srcKey()`). */
  readonly srcKey?: RegionCacheHeader['srcKey'];
  /** Where the 4-thread worker bundle is built, under test/.cache/ (default `regionWorker`; one per test file). */
  readonly workerDir?: string;
  /** The mesher's options for 'MESH' (default the Medium preset's AO and smooth light, as the page's jobs). */
  readonly meshOptions?: MeshOptions;
  /**
   * Each column's edit entries by `colKey` (SP5a spec §6.3), overlaid by its D (`fillColumnD`, spec §2.5); a column
   * absent from the map runs D without a diff. Needs `threads: 1` and no `cache`: the 4-thread D runs in
   * `regionWorker.ts` with no diff, and the dump's key ignores it.
   */
  readonly diff?: ReadonlyMap<number, ColumnDiff>;
  /**
   * The capacity (an integer ≥ 1) of the carver path cache of every thread that generates (SP6a spec §10.3,
   * `DT1.carverCache`): each builds its GenContext's cache at it (`setCarverCacheCapacity`; default
   * `CARVER_CACHE_PATHS`). It moves no output, so the dump's key ignores it, and it needs no `cache` (a hit would
   * generate nothing at it).
   */
  readonly carverCacheCapacity?: number;
  /**
   * The view's debug readings of the caves (SP6a spec §3.2, §10.1): `pillar` and `terrainT`, recomputed per column by
   * `caveDebugColumn` on a DensityContext of the region's seed and params (default false: both throw). They move no
   * output, so the dump's key ignores it.
   */
  readonly debugTags?: boolean;
}

/**
 * A generated region, read through the store: the final set of a column at Decorated or above (D shares the proto into
 * it), else its proto set. x, z are world block coordinates inside the region.
 */
export interface RegionView {
  readonly store: VoxelStore;
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
  block(x: number, y: number, z: number): number;
  fluid(x: number, y: number, z: number): number;
  /** The light byte (sky << 4 | block) of the final set; 0 below Decorated, and all 0 below 'L' (SP4a spec §9.2). */
  light(x: number, y: number, z: number): number;
  /** Column (cx, cz)'s aux A (its T fields and, from 'D' on, the final heightmaps). */
  aux(cx: number, cz: number): AuxView;
  /** Column (cx, cz)'s mesh payload: non-null exactly on R's columns for 'MESH', null everywhere else. */
  mesh(cx: number, cz: number): ColumnMeshPayload | null;
  /** The zoomed surface biome (aux A `surfaceBiome`). */
  biome(x: number, z: number): number;
  worldSurfaceWG(x: number, z: number): number;
  oceanFloorWG(x: number, z: number): number;
  /**
   * A copy of column (cx, cz)'s 24 proto descriptors, 24 × `PROTO_INTS` ints: blocks, fluid then cave per section (slot
   * id, or −1 − value; the cave entry is SP6a's, its spec §3.3).
   */
  descriptors(cx: number, cz: number): Int32Array;
  /** The cave tag (`CAVE_KIND`) the store's cave channel holds at the voxel (SP6a spec §3.2, §3.3). */
  tag(x: number, y: number, z: number): number;
  /**
   * The pillar bit (SP6a spec §3.2's debug channel; `debugTags` only, else it throws): rock (a non-air block above
   * y −64) that is pre-cave solid and that `keep` holds (keep > 0) where min(E, C, S3, S2) < 0, from `caveDebugColumn`.
   */
  pillar(x: number, y: number, z: number): boolean;
  /** The `terrain` tap's value at the voxel (`debugTags` only, else it throws; NaN without the tap), for C7.switchWall. */
  terrainT(x: number, y: number, z: number): number;
  /**
   * The pre-cave top of position (x, z) (SP6a spec §10.1): the highest voxel that is solid (a non-air block) or tagged,
   * so an entrance that breaches the top keeps it; not the carve's density top (Spec correction 18).
   */
  preCaveTop(x: number, z: number): number;
  /** hex64 of `regionHash` over the region, or over a sub-window of it (the proto data: no light). */
  hash(cx0?: number, cz0?: number, w?: number, h?: number): string;
  /** `litRegionHash` over the region or a sub-window (blocks, fluid, light, aux); 'L' and 'MESH' only (ruling P33). */
  litHash(cx0?: number, cz0?: number, w?: number, h?: number): string;
}

export interface RegionResult {
  readonly view: RegionView;
  /**
   * `perColumnMs` is indexed row-major in R, `(cz − cz0)·w + (cx − cx0)`: the last stage's milliseconds per column
   * (the mesh for 'MESH'); for 'T', 'D' and 'L' on a hit it holds the rebuild.
   */
  readonly timings: { readonly perColumnMs: Float64Array; readonly totalMs: number };
  /** The dump was read: R's for 'T', 'D' and 'L', the grown 'L' region's for 'MESH'. */
  readonly cacheHit: boolean;
  /** T, D and L column jobs run by each thread, every stage counted (one entry per thread; `[0]` on a cache hit). */
  readonly columnsPerThread: number[];
  /**
   * The most paths each thread's carver path cache held after a T, D or L job (one entry per thread; `[0]` on a cache
   * hit; ruling P28): at most `carverCacheCapacity`.
   */
  readonly carverCacheSizes: number[];
}

function checkSize(what: string, w: number, h: number): void {
  for (const [name, v] of [['w', w], ['h', h]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 64) throw new RangeError(`${what}: ${name} = ${v} outside 1 … 64`);
  }
}

/** A rectangle of columns. */
interface Rect {
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
}

const grow = (r: Rect, ring: number): Rect => ({ cx0: r.cx0 - ring, cz0: r.cz0 - ring, w: r.w + 2 * ring, h: r.h + 2 * ring });

/** The column stages a dump can hold, in order; stage i of an upTo at index k covers R grown by k − i (ruling P31). */
type Stage = 'T' | 'D' | 'L';
const STAGES: readonly Stage[] = ['T', 'D', 'L'];
const UP_TO: readonly RegionUpTo[] = ['T', 'D', 'L', 'MESH'];

/** The mesher's options of the page's jobs (`taskHandler.ts`): the Medium preset's. */
const MEDIUM_MESH: MeshOptions = Object.freeze({ ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight });

/** Dense block sections are hashed through a byte view of their slot when the platform is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function hashWords(fnv: Fnv64, a: Uint16Array): void {
  if (LITTLE_ENDIAN) {
    fnv.update(new Uint8Array(a.buffer, a.byteOffset, 2 * a.length));
    return;
  }
  for (let i = 0; i < a.length; i++) fnv.updateU16LE(a[i]!);
}

/**
 * hex64 of the FNV-1a 64 of the w × h window at (cx0, cz0) of lit columns (ruling P33), in `regionHash`'s encoding
 * (cz outer, cx inner) over the final set: per column, for sy 0 … 23 the 4096 block states (u16 little-endian), the
 * 4096 fluid bytes and the 4096 light bytes, each in voxel order with uniform sections expanded (the bytes `light()`
 * reads), then the 4096 aux A bytes and the 4096 aux B bytes (zeros for an absent slot). Throws when a column of the
 * window has no final set.
 */
export function litRegionHash(store: VoxelStore, cx0: number, cz0: number, w: number, h: number): string {
  checkSize('litRegionHash', w, h);
  const fnv = createFnv64();
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = store.final(cx, cz);
      if (v === null) throw new Error(`litRegionHash: column (${cx}, ${cz}) has no final set in the store`);
      for (let sy = 0; sy < 24; sy++) {
        const b = v.sectionBlocks(sy);
        if (typeof b === 'number') fnv.updateRepeatU16LE(b, 4096);
        else hashWords(fnv, b);
        for (const c of [v.sectionFluid(sy), v.sectionLight(sy)]) {
          if (typeof c === 'number') fnv.updateRepeatU8(c, 4096);
          else fnv.update(c);
        }
      }
      const a = v.aux();
      if (a === null) fnv.updateRepeatU8(0, 4096);
      else fnv.update(new Uint8Array(a.worldSurfaceWG.buffer, a.worldSurfaceWG.byteOffset, 4096));
      const b = v.auxB();
      if (b === null) fnv.updateRepeatU8(0, 4096);
      else fnv.update(new Uint8Array(b.caveBiomeQ.buffer, b.caveBiomeQ.byteOffset, 4096));
    }
  }
  return hex64(fnv.digest());
}

/**
 * The column list (§6.1). `spiral`: the centre (cx0 + ⌊w/2⌋, cz0 + ⌊h/2⌋), then square rings of growing radius r,
 * each walked clockwise seen from +y from its north-west corner (cx − r, cz − r): east along the north edge, south
 * along the east edge, west along the south edge, north along the west edge; columns outside the region are
 * skipped. `shuffled`: a Fisher-Yates permutation of the row-major list (cz outer), i from n − 1 down to 1 swapping
 * with j = `nextInt(i + 1)` of `Xoshiro128(shuffleSeed)`.
 */
export function regionColumns(order: RegionOrder, cx0: number, cz0: number, w: number, h: number, shuffleSeed = 1): Array<[number, number]> {
  checkSize('regionColumns', w, h);
  const out: Array<[number, number]> = [];
  if (order === 'shuffled') {
    for (let cz = cz0; cz < cz0 + h; cz++) for (let cx = cx0; cx < cx0 + w; cx++) out.push([cx, cz]);
    const rng = new Xoshiro128(shuffleSeed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  if (order !== 'spiral') throw new Error(`regionColumns: unknown order '${String(order)}'`);
  const cx = cx0 + Math.floor(w / 2);
  const cz = cz0 + Math.floor(h / 2);
  const inside = (x: number, z: number) => x >= cx0 && x < cx0 + w && z >= cz0 && z < cz0 + h;
  const add = (x: number, z: number) => {
    if (inside(x, z)) out.push([x, z]);
  };
  add(cx, cz);
  const rMax = Math.max(cx - cx0, cx0 + w - 1 - cx, cz - cz0, cz0 + h - 1 - cz);
  for (let r = 1; r <= rMax; r++) {
    for (let x = cx - r; x <= cx + r; x++) add(x, cz - r);
    for (let z = cz - r + 1; z <= cz + r; z++) add(cx + r, z);
    for (let x = cx + r - 1; x >= cx - r; x--) add(x, cz + r);
    for (let z = cz + r - 1; z > cz - r; z--) add(cx - r, z);
  }
  return out;
}

/** What a `RegionView` knows beyond its store: the `upTo` that made it, and the mesh payloads of a 'MESH' run. */
export interface RegionViewExtra {
  /** Default 'T'; `litHash` needs 'L' or 'MESH'. */
  readonly upTo?: RegionUpTo;
  /** Keyed `${cx},${cz}`. */
  readonly meshes?: ReadonlyMap<string, ColumnMeshPayload>;
  /** The DensityContext of `pillar` and `terrainT` (`debugTags`); without it both throw. */
  readonly debug?: DensityContext;
}

/** One column's debug readings (`caveDebugColumn`), 98,304 entries each in `fillDensityColumn`'s index. */
export interface CaveDebugColumn {
  /** 1 where the pre-cave density is solid, keep > 0 and min(E, C, S3, S2) < 0 (the density's pillar rock), else 0. */
  readonly pillar: Uint8Array;
  /** The `terrain` tap's value per voxel (NaN without a `terrain` tap). */
  readonly terrainT: Float64Array;
}

/**
 * The debug readings of column (cx, cz) of `dc` (SP6a spec §3.2, §10.1), recomputed per voxel through Task 11's tap
 * readers (`caveReadersOf`, at the voxel registers `atVoxel` sets, every cell's corners ready), into `out` (fresh when
 * absent), index `((y + 64)·16 + lz)·16 + lx`. `pillar` is the density's pillar rock: above y −64, pre-cave solid (the
 * `precave` tap > 0, else the `terrain` tap > 0, as the tag's step 2), keep > 0 (keep = −1e6 where pillars·(1/16) <
 * `threshold`, else pillars; −∞ without a `pillars` tap) and min(E, C, S3, S2) < 0 over the family taps present (+∞
 * with none); `RegionView.pillar` also asks the final block to be rock (a noodle or a carver opens pillar rock).
 * `terrainT` is the `terrain` tap's value, equal to `tapFn('terrain', …)`.
 */
export function caveDebugColumn(dc: DensityContext, threshold: number, cx: number, cz: number, out?: CaveDebugColumn): CaveDebugColumn {
  const o = out ?? { pillar: new Uint8Array(98304), terrainT: new Float64Array(98304) };
  dc.column(cx, cz);
  const c = dc.compiled;
  const r = caveReadersOf(c);
  const pre = r.precave ?? r.terrain;
  const { terrain: ft, entrances: fe, cheese: fc, spaghetti3d: f3, spaghetti2d: f2, pillars: fp } = r;
  const slots = c.interpolatedSlotCount > 0;
  for (let ck = 0; ck < 48; ck++) {
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        if (slots) c.cellCorners(ci, ck, cj);
        for (let y = -64 + 8 * ck; y < -56 + 8 * ck; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              const i = ((y + 64) * 16 + lz) * 16 + lx;
              c.atVoxel(lx, y, lz);
              o.terrainT[i] = ft === null ? NaN : ft();
              let bit = 0;
              if (y > -64 && pre !== null && pre() > 0 && fp !== null) {
                const pv = fp();
                const keep = pv * 0.0625 < threshold ? -1e6 : pv;
                if (keep > 0) {
                  const low = Math.min(fe === null ? Infinity : fe(), fc === null ? Infinity : fc(), f3 === null ? Infinity : f3(), f2 === null ? Infinity : f2());
                  if (low < 0) bit = 1;
                }
              }
              o.pillar[i] = bit;
            }
          }
        }
      }
    }
  }
  return o;
}

/** The columns of debug readings a view keeps (least recently used out). */
const DEBUG_COLUMNS = 8;

/**
 * A `RegionView` over the w × h region at (cx0, cz0) of `store`; every column must hold its proto set, and is read
 * through its final set from Decorated on.
 */
export function regionView(store: VoxelStore, cx0: number, cz0: number, w: number, h: number, extra: RegionViewExtra = {}): RegionView {
  checkSize('regionView', w, h);
  const upTo = extra.upTo ?? 'T';
  const meshes = extra.meshes ?? new Map<string, ColumnMeshPayload>();
  const views: ColumnView[] = [];
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const v = store.final(cx, cz) ?? store.proto(cx, cz);
      if (v === null) throw new Error(`regionView: column (${cx}, ${cz}) has no proto set in the store`);
      views.push(v);
    }
  }
  const columnAt = (cx: number, cz: number): number => {
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || cx < cx0 || cx >= cx0 + w || cz < cz0 || cz >= cz0 + h) {
      throw new RangeError(`regionView: column (${cx}, ${cz}) outside the region`);
    }
    return (cz - cz0) * w + (cx - cx0);
  };
  const col = (x: number, z: number): ColumnView => views[columnAt(x >> 4, z >> 4)]!;
  const debugDc = extra.debug ?? null;
  const debugCols = new Map<number, CaveDebugColumn>();
  const debugAt = (what: string, x: number, y: number, z: number): { d: CaveDebugColumn; i: number } => {
    if (debugDc === null) throw new Error(`regionView.${what}: needs debugTags`);
    const k = columnAt(x >> 4, z >> 4);
    if (!Number.isInteger(y) || y < -64 || y > 319) throw new RangeError(`regionView.${what}: y ${y} outside −64 … 319`);
    let d = debugCols.get(k);
    if (d === undefined) {
      let reuse: CaveDebugColumn | undefined;
      if (debugCols.size >= DEBUG_COLUMNS) {
        const oldest = debugCols.keys().next().value!;
        reuse = debugCols.get(oldest);
        debugCols.delete(oldest);
      }
      d = caveDebugColumn(debugDc, debugDc.ctx.params.caves.pillars.threshold, x >> 4, z >> 4, reuse);
    } else debugCols.delete(k);
    debugCols.set(k, d);
    return { d, i: ((y + 64) * 16 + (z & 15)) * 16 + (x & 15) };
  };
  const aux = (x: number, z: number) => {
    const a = col(x, z).aux();
    if (a === null) throw new Error(`regionView: column (${x >> 4}, ${z >> 4}) has no aux A`);
    return { a, i: ((z & 15) << 4) | (x & 15) };
  };
  return {
    store, cx0, cz0, w, h,
    block: (x, y, z) => col(x, z).block(x & 15, y, z & 15),
    fluid: (x, y, z) => col(x, z).fluid(x & 15, y, z & 15),
    light: (x, y, z) => col(x, z).light(x & 15, y, z & 15),
    tag: (x, y, z) => col(x, z).cave(x & 15, y, z & 15),
    pillar(x, y, z) {
      const { d, i } = debugAt('pillar', x, y, z);
      return d.pillar[i] === 1 && col(x, z).block(x & 15, y, z & 15) !== AIR;
    },
    terrainT(x, y, z) {
      const { d, i } = debugAt('terrainT', x, y, z);
      return d.terrainT[i]!;
    },
    preCaveTop(x, z) {
      const v = col(x, z);
      const lx = x & 15, lz = z & 15;
      let y = 319;
      while (y > -64 && v.block(lx, y, lz) === AIR && v.cave(lx, y, lz) === 0) y--;
      return y;
    },
    aux(cx, cz) {
      const a = views[columnAt(cx, cz)]!.aux();
      if (a === null) throw new Error(`regionView: column (${cx}, ${cz}) has no aux A`);
      return a;
    },
    mesh: (cx, cz) => meshes.get(`${cx},${cz}`) ?? null,
    biome: (x, z) => { const { a, i } = aux(x, z); return a.surfaceBiome[i]!; },
    worldSurfaceWG: (x, z) => { const { a, i } = aux(x, z); return a.worldSurfaceWG[i]!; },
    oceanFloorWG: (x, z) => { const { a, i } = aux(x, z); return a.oceanFloorWG[i]!; },
    descriptors(cx, cz) {
      columnAt(cx, cz);
      const d0 = protoAt(store.table.find(cx, cz), 0);
      return store.table.ints.slice(d0, d0 + 24 * PROTO_INTS);
    },
    hash(hx = cx0, hz = cz0, hw = w, hh = h) {
      checkSize('regionView.hash', hw, hh);
      columnAt(hx, hz);
      columnAt(hx + hw - 1, hz + hh - 1);
      return hex64(regionHash(store, hx, hz, hw, hh));
    },
    litHash(hx = cx0, hz = cz0, hw = w, hh = h) {
      if (upTo !== 'L' && upTo !== 'MESH') throw new Error(`regionView.litHash: upTo '${upTo}' has no light ('L' or 'MESH' only)`);
      checkSize('regionView.litHash', hw, hh);
      columnAt(hx, hz);
      columnAt(hx + hw - 1, hz + hh - 1);
      for (let cz = hz; cz < hz + hh; cz++) {
        for (let cx = hx; cx < hx + hw; cx++) {
          const base = store.table.find(cx, cz);
          if (store.table.status(base) !== STATUS_PUBLISHED) throw new Error(`regionView.litHash: column (${cx}, ${cz}) is not Published`);
        }
      }
      return litRegionHash(store, hx, hz, hw, hh);
    },
  };
}

const sameChannel = (a: Uint16Array | Uint8Array | number, b: Uint16Array | Uint8Array | number): boolean => {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
};

/**
 * The first difference between two views of the same region, or null when they hold the same proto data: per
 * column, each section's blocks, fluid and cave (SP6a spec §3.3; uniform against uniform by value, dense against
 * dense by bytes; a uniform section never equals a dense one, so the per-channel layout must match too), the 4096 aux
 * A bytes and the 4096 aux B bytes (an absent slot compares as zeros, as in `regionHash`). Byte comparison, much faster
 * than hashing both regions.
 */
export function regionDiff(a: RegionView, b: RegionView): string | null {
  if (a.cx0 !== b.cx0 || a.cz0 !== b.cz0 || a.w !== b.w || a.h !== b.h) return 'the views cover other regions';
  for (let cz = a.cz0; cz < a.cz0 + a.h; cz++) {
    for (let cx = a.cx0; cx < a.cx0 + a.w; cx++) {
      const va = a.store.proto(cx, cz)!;
      const vb = b.store.proto(cx, cz)!;
      for (let sy = 0; sy < 24; sy++) {
        if (!sameChannel(va.sectionBlocks(sy), vb.sectionBlocks(sy))) return `column (${cx}, ${cz}) section ${sy}: blocks differ`;
        if (!sameChannel(va.sectionFluid(sy), vb.sectionFluid(sy))) return `column (${cx}, ${cz}) section ${sy}: fluid differs`;
        if (!sameChannel(va.sectionCave(sy), vb.sectionCave(sy))) return `column (${cx}, ${cz}) section ${sy}: cave differs`;
      }
      const xa = va.aux();
      const xb = vb.aux();
      const bytes = (x: typeof xa) => (x === null ? Buffer.alloc(4096) : Buffer.from(x.worldSurfaceWG.buffer, x.worldSurfaceWG.byteOffset, 4096));
      if (!bytes(xa).equals(bytes(xb))) return `column (${cx}, ${cz}): aux A differs`;
      const ya = va.auxB();
      const yb = vb.auxB();
      const bytesB = (y: typeof ya) => (y === null ? Buffer.alloc(4096) : Buffer.from(y.caveBiomeQ.buffer, y.caveBiomeQ.byteOffset, 4096));
      if (!bytesB(ya).equals(bytesB(yb))) return `column (${cx}, ${cz}): aux B differs`;
    }
  }
  return null;
}

const workerScripts = new Map<string, Promise<string>>();

function regionWorkerScript(dir: string): Promise<string> {
  let p = workerScripts.get(dir);
  if (p === undefined) {
    p = buildNodeTaskWorker(dir, { entry: 'test/harness/regionWorker.ts' });
    workerScripts.set(dir, p);
  }
  return p;
}

/**
 * DT1's worker directory for a metrics tier (SP3a §10's minor, SP3b spec §7): one per tier, so the fast, quick and
 * full tiers running at once never share a build's `emptyOutDir`.
 */
export function dt1WorkerDir(tier: 'fast' | 'quick' | 'full'): string {
  return `dt1RegionWorker-${tier}`;
}

let spawned = 0;

/** Region worker threads this module has spawned so far (a test seam: a cache hit spawns none). */
export function regionWorkersSpawned(): number {
  return spawned;
}

const askRegion = (w: Worker, msg: RegionAttachMsg | RegionColumnMsg | RegionMeshMsg): Promise<RegionWorkerReply> => ask<RegionWorkerReply>(w, msg);

/** Four region workers attached to `store` (shared). Terminated by the caller. */
async function openWorkers(store: VoxelStore, o: GenRegionOptions): Promise<Worker[]> {
  const script = await regionWorkerScript(o.workerDir ?? 'regionWorker');
  const workers = Array.from({ length: 4 }, () => new Worker(script));
  spawned += workers.length;
  try {
    const attach: RegionAttachMsg = {
      type: 'attach', handles: store.handles(), seedText: o.seed, params: o.params,
      ...(o.carverCacheCapacity === undefined ? {} : { carverCacheCapacity: o.carverCacheCapacity }),
    };
    const ready = await Promise.all(workers.map((w) => askRegion(w, attach)));
    for (const r of ready) if (r.type !== 'ready') throw new Error(`region worker: ${r.type === 'error' ? r.message : r.type}`);
  } catch (e) {
    await Promise.all(workers.map((w) => w.terminate()));
    throw e;
  }
  return workers;
}

/**
 * Runs one message per column of `cols` on the workers, each taking the next column of the list when idle; calls
 * `done(t, k, reply)` with the thread and the column's row-major index in `r`. Throws on an error reply, a reply of
 * another kind or column, or a column of `r` not run exactly once.
 */
async function drainThreaded(
  workers: readonly Worker[], r: Rect, cols: ReadonlyArray<[number, number]>,
  msgOf: (cx: number, cz: number) => RegionColumnMsg | RegionMeshMsg,
  done: (t: number, k: number, reply: Extract<RegionWorkerReply, { type: 'done' | 'meshed' }>) => void,
): Promise<void> {
  const written = new Uint8Array(r.w * r.h);
  let next = 0;
  const drain = async (t: number): Promise<void> => {
    while (next < cols.length) {
      const [cx, cz] = cols[next++]!;
      const msg = msgOf(cx, cz);
      const reply = await askRegion(workers[t]!, msg);
      if (reply.type !== (msg.type === 'meshColumn' ? 'meshed' : 'done')) {
        throw new Error(`region worker ${t}, ${msg.type} (${cx}, ${cz}): ${reply.type === 'error' ? reply.message : reply.type}`);
      }
      const ok = reply as Extract<RegionWorkerReply, { type: 'done' | 'meshed' }>;
      if (ok.cx !== cx || ok.cz !== cz) throw new Error(`region worker ${t}: asked (${cx}, ${cz}), answered (${ok.cx}, ${ok.cz})`);
      const k = (cz - r.cz0) * r.w + (cx - r.cx0);
      written[k]!++;
      done(t, k, ok);
    }
  };
  await Promise.all(workers.map((_, t) => drain(t)));
  const wrong = written.findIndex((n) => n !== 1);
  if (wrong >= 0) throw new Error(`genRegion: column ${wrong} (row-major) run ${written[wrong]} times`);
}

const NEVER = (): boolean => false;

/** The in-process stage functions over one thread's scratch; D overlays the column's entries of `diff`, if any. */
function runInProcess(
  store: VoxelStore, ctx: GenContext, stage: Stage, cx: number, cz: number, light: () => LightScratch, diff: ReadonlyMap<number, ColumnDiff> | undefined,
): void {
  if (stage === 'T') fillColumnT(store, ctx, cx, cz, NEVER);
  else if (stage === 'D') {
    if (!fillColumnD(store, ctx, cx, cz, NEVER, diff?.get(colKey(cx, cz)) ?? null)) throw new Error(`genRegion: D of (${cx}, ${cz}) stopped`);
  } else if (fillColumnL(store, cx, cz, light(), NEVER) === null) throw new Error(`genRegion: L of (${cx}, ${cz}) stopped`);
}

const STAGE_MSG: Readonly<Record<Stage, RegionColumnMsg['type']>> = Object.freeze({ T: 'column', D: 'decorate', L: 'light' });

/**
 * Generates the region (§6.1; SP4a spec §9.2, ruling P31). The store is fresh per call: a plain `ArrayBuffer` one for
 * 1 thread, a growable `SharedArrayBuffer` one for 4 (and for a cache hit with `threads: 4`, rebuilt in this thread).
 * The stages run in turn, T, D, L, each over its whole set in `order`, then the meshes of R ('MESH'): on the four
 * workers that generated the region, or in this thread on 1 thread or after a cache hit (no worker is spawned).
 */
export async function genRegion(o: GenRegionOptions): Promise<RegionResult> {
  if (o.threads !== 1 && o.threads !== 4) throw new Error(`genRegion: threads ${String(o.threads)} (1 or 4)`);
  if (o.diff !== undefined && (o.threads !== 1 || o.cache === true)) throw new Error('genRegion: diff needs threads 1 and no cache');
  if (o.carverCacheCapacity !== undefined && o.cache === true) throw new Error('genRegion: carverCacheCapacity needs no cache');
  if (!UP_TO.includes(o.upTo)) throw new Error(`genRegion: upTo '${String(o.upTo)}' (T, D, L or MESH)`);
  checkSize('genRegion', o.w, o.h);
  const region: Rect = { cx0: o.cx0, cz0: o.cz0, w: o.w, h: o.h };
  const isMesh = o.upTo === 'MESH';
  const top: Stage = isMesh ? 'L' : (o.upTo as Stage);
  const k = STAGES.indexOf(top);
  // The generated region: R, or for 'MESH' the 'L' region grown by one ring. Its stage i covers it grown by k − i.
  const gen = isMesh ? grow(region, 1) : region;
  const outer = grow(gen, k);
  for (const [name, v] of [['w', outer.w], ['h', outer.h]] as const) {
    if (v > 64) throw new RangeError(`genRegion: upTo '${o.upTo}' runs T over ${v} columns of ${name} (R plus ${(v - (name === 'w' ? o.w : o.h)) / 2} rings), more than 64`);
  }
  const shuffleSeed = o.shuffleSeed ?? 1;
  const regionOrder = regionColumns(o.order, region.cx0, region.cz0, region.w, region.h, shuffleSeed);
  const t0 = performance.now();
  const store = createStore({ shared: o.shared ?? o.threads === 4 });
  const header: RegionCacheHeader | null = o.cache === true
    ? {
        genKey: genKey(seedFromInput(o.seed), stageHashes(o.params)), srcKey: o.srcKey ?? srcKey(),
        cx0: gen.cx0, cz0: gen.cz0, w: gen.w, h: gen.h, upTo: top,
      }
    : null;
  const path = header === null ? '' : regionCachePath(header, o.cacheDir);
  const hitMs = header === null ? null : readRegionDump(store, header, path);
  let workers: Worker[] | null = null;
  let columnsPerThread = [0];
  let carverCacheSizes = [0];
  let ms: Float64Array;
  const meshes = new Map<string, ColumnMeshPayload>();
  try {
    let genMs: Float64Array;
    if (hitMs !== null) genMs = hitMs;
    else {
      const perThread = o.threads === 4 ? [0, 0, 0, 0] : [0];
      const cacheSizes = o.threads === 4 ? [0, 0, 0, 0] : [0];
      genMs = new Float64Array(gen.w * gen.h);
      if (o.threads === 4) workers = await openWorkers(store, o);
      const ctx = o.threads === 1 ? genContextWith(o.seed, o.params, o.carverCacheCapacity) : null;
      let lightScratch: LightScratch | null = null;
      const light = (): LightScratch => (lightScratch ??= createLightScratch());
      for (let i = 0; i <= k; i++) {
        const stage = STAGES[i]!;
        const r = grow(gen, k - i);
        const cols = regionColumns(o.order, r.cx0, r.cz0, r.w, r.h, shuffleSeed);
        const stageMs = new Float64Array(r.w * r.h);
        if (workers !== null) {
          await drainThreaded(workers, r, cols, (cx, cz) => ({ type: STAGE_MSG[stage], cx, cz }), (t, j, reply) => {
            stageMs[j] = reply.ms;
            perThread[t]!++;
            if (reply.type === 'done') cacheSizes[t] = Math.max(cacheSizes[t]!, reply.carverCacheSize);
          });
        } else {
          for (const [cx, cz] of cols) {
            const c0 = performance.now();
            runInProcess(store, ctx!, stage, cx, cz, light, o.diff);
            stageMs[(cz - r.cz0) * r.w + (cx - r.cx0)] = performance.now() - c0;
          }
          perThread[0]! += cols.length;
          cacheSizes[0] = Math.max(cacheSizes[0]!, carverCacheOf(ctx!).size);
        }
        if (i === k) genMs = stageMs;
      }
      if (header !== null) writeRegionDump(store, header, path);
      columnsPerThread = perThread;
      carverCacheSizes = cacheSizes;
    }
    if (!isMesh) ms = genMs;
    else {
      const options = o.meshOptions ?? MEDIUM_MESH;
      const meshMs = new Float64Array(o.w * o.h);
      if (workers !== null) {
        await drainThreaded(workers, region, regionOrder, (cx, cz) => ({ type: 'meshColumn', cx, cz, options }), (_t, j, reply) => {
          if (reply.type !== 'meshed') throw new Error(`genRegion: no mesh payload for column ${j}`);
          meshMs[j] = reply.ms;
          meshes.set(`${reply.cx},${reply.cz}`, reply.payload);
        });
      } else {
        const scratch = createMeshScratch();
        for (const [cx, cz] of regionOrder) {
          const c0 = performance.now();
          meshes.set(`${cx},${cz}`, meshColumnJob(store, cx, cz, scratch, options));
          meshMs[(cz - o.cz0) * o.w + (cx - o.cx0)] = performance.now() - c0;
        }
      }
      ms = meshMs;
    }
  } finally {
    if (workers !== null) await Promise.all(workers.map((w) => w.terminate()));
  }
  const debug = o.debugTags === true ? { debug: createDensityContext(genContextWith(o.seed, o.params)) } : {};
  return {
    view: regionView(store, o.cx0, o.cz0, o.w, o.h, { upTo: o.upTo, meshes, ...debug }), timings: { perColumnMs: ms, totalMs: performance.now() - t0 },
    cacheHit: hitMs !== null, columnsPerThread, carverCacheSizes,
  };
}

/**
 * Column (cx, cz) generated alone (SP6a spec §10.3, `DT1.isolated`): T on a fresh plain store with a fresh GenContext
 * (its carver path cache empty, at `carverCacheCapacity`, default `CARVER_CACHE_PATHS`), nothing else generated; its
 * `regionHash` (the 1 × 1 window). Equal to the column's window of any region that holds it.
 */
export async function isolatedColumn(o: {
  seed: string; params: Params; cx: number; cz: number; carverCacheCapacity?: number;
}): Promise<Hash64> {
  const ctx = genContextWith(o.seed, o.params, o.carverCacheCapacity);
  const store = createStore({ shared: false });
  if (!fillColumnT(store, ctx, o.cx, o.cz, NEVER)) throw new Error(`isolatedColumn: T of (${o.cx}, ${o.cz}) stopped`);
  return regionHash(store, o.cx, o.cz, 1, 1);
}

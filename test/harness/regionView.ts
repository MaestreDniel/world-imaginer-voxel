/**
 * The region harness's view (SP3a spec §6.1, SP4a spec §9.2, SP6a spec §10.1): `RegionView` over a store, the debug
 * readings behind its pillar bit and `terrain` tap, and `litRegionHash`. Moved out of `region.ts` (SP6b spec §13 L6),
 * which re-exports every name, so a worker entry bundled by `buildNodeTaskWorker`, which never imports `node:` modules,
 * reads a region through the same view (`caveRegionWorker.ts`). It imports `src/` modules only.
 */
import { createFnv64, hex64, type Fnv64 } from '../../src/core/hash';
import { caveReadersOf } from '../../src/gen/caves/tags';
import type { DensityContext } from '../../src/gen/density/context';
import { regionHash } from '../../src/metrics/region';
import type { ColumnMeshPayload } from '../../src/mesh/column';
import { AIR } from '../../src/world/blocks/index';
import { protoAt, STATUS_PUBLISHED } from '../../src/world/store/columnTable';
import { PROTO_INTS } from '../../src/world/store/section';
import type { AuxView, ColumnView, VoxelStore } from '../../src/world/store/store';
import type { RegionUpTo } from './cache';

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

export function checkSize(what: string, w: number, h: number): void {
  for (const [name, v] of [['w', w], ['h', h]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 64) throw new RangeError(`${what}: ${name} = ${v} outside 1 … 64`);
  }
}

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

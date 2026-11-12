/**
 * The region worker (SP3a spec §6.1, SP4a spec §9.2), bundled by `buildNodeTaskWorker(dir, {entry:
 * 'test/harness/regionWorker.ts'})` and driven by `genRegion` (`test/harness/region.ts`) with `threads: 4`. Its
 * messages are the harness's own test-only protocol, never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', handles, seedText, params, carverCacheCapacity?}` once (`attachStore` and
 * `genContextWith`: the GenContext with its carver path cache built at that capacity, SP6a spec §10.3), answered
 * `{type: 'ready'}`; then one job per message on the shared store, never stopped:
 * - `{type: 'column', cx, cz}`: `fillColumnT` (epoch 0);
 * - `{type: 'decorate', cx, cz}`: `fillColumnD` (`src/workers/worldJobs.ts`);
 * - `{type: 'light', cx, cz}`: `fillColumnL`, with this worker's light scratch;
 * each answered `{type: 'done', cx, cz, ms, carverCacheSize}` (the paths its context's carver cache holds after the
 *   job, ruling P28);
 * - `{type: 'meshColumn', cx, cz, options}`: `meshColumnJob` with this worker's mesh scratch, answered
 *   `{type: 'meshed', cx, cz, ms, payload}` with the payload's seven buffers transferred (each owns its buffer whole,
 *   ruling P27);
 * - `{type: 'scatter', cols}` (T1-T5's analysis, SP6b spec §13 L5, ruling P5; `scatterColumnsThreaded`): per column in
 *   order, `fillColumnT`, `analyseColumn` in place (`surfaceEst3` and `preCaveTop` on this worker's DensityContext,
 *   built once from its GenContext) and `freeColumn`, answered `{type: 'scattered', scattered, ms}`: one `Scattered`
 *   for all its columns (`seconds` 0), its Float64Arrays' buffers transferred.
 * Anything that throws is answered `{type: 'error', message}`.
 */
import { CARVER_CACHE_PATHS } from '../../src/core/constants';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { carverCacheOf, setCarverCacheCapacity } from '../../src/gen/caves/carverCache';
import { surfaceEst3 } from '../../src/gen/column/surfaceEstimate';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { createLightScratch, type LightScratch } from '../../src/light/initial';
import { fillColumnT } from '../../src/metrics/region';
import { createMeshScratch, type ColumnMeshPayload, type MeshScratch } from '../../src/mesh/column';
import type { MeshOptions } from '../../src/mesh/greedy';
import { attachStore, type StoreHandles, type VoxelStore } from '../../src/world/store/store';
import { fillColumnD, fillColumnL, meshColumnJob } from '../../src/workers/worldJobs';
import { analyseColumn, newScatterScratch, newScattered, preCaveTop, type Scattered, type ScatterScratch } from './terrainAnalysis';

export interface RegionAttachMsg {
  readonly type: 'attach';
  readonly handles: StoreHandles;
  readonly seedText: string;
  readonly params: Params;
  /** The capacity of its context's carver path cache (default `CARVER_CACHE_PATHS`; `GenRegionOptions`). */
  readonly carverCacheCapacity?: number;
}

/** One column job: T (`column`), D (`decorate`) or L (`light`). */
export interface RegionColumnMsg {
  readonly type: 'column' | 'decorate' | 'light';
  readonly cx: number;
  readonly cz: number;
}

export interface RegionMeshMsg {
  readonly type: 'meshColumn';
  readonly cx: number;
  readonly cz: number;
  readonly options: MeshOptions;
}

/** T1-T5's analysis of `cols` (generated, analysed and freed one by one, in order). */
export interface RegionScatterMsg {
  readonly type: 'scatter';
  readonly cols: ReadonlyArray<readonly [number, number]>;
}

export type RegionWorkerReply =
  | { type: 'ready' }
  | { type: 'done'; cx: number; cz: number; ms: number; carverCacheSize: number }
  | { type: 'meshed'; cx: number; cz: number; ms: number; payload: ColumnMeshPayload }
  | { type: 'scattered'; scattered: Scattered; ms: number }
  | { type: 'error'; message: string };

interface Reply {
  msg: RegionWorkerReply;
  transfer: Transferable[];
}

const NEVER = (): boolean => false;

/**
 * A GenContext over `seedText` and `params` whose carver path cache (`carverCacheOf`) is built now at `capacity` (an
 * integer ≥ 1, default `CARVER_CACHE_PATHS`; SP6a spec §10.3); the module's capacity is the default again after.
 */
export function genContextWith(seedText: string, params: Params, capacity: number = CARVER_CACHE_PATHS): GenContext {
  setCarverCacheCapacity(capacity);
  try {
    const ctx = createGenContext(seedFromInput(seedText), params);
    carverCacheOf(ctx);
    return ctx;
  } finally {
    setCarverCacheCapacity(CARVER_CACHE_PATHS);
  }
}

export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let store: VoxelStore | null = null;
  let ctx: GenContext | null = null;
  let lightScratch: LightScratch | null = null;
  let meshScratch: MeshScratch | null = null;
  let dc: DensityContext | null = null;
  let scatterScratch: ScatterScratch | null = null;
  const reply = (msg: RegionWorkerReply, transfer: Transferable[] = []): Reply => ({ msg, transfer });
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown };
        if (m.type === 'attach') {
          const a = raw as RegionAttachMsg;
          store = attachStore(a.handles);
          ctx = genContextWith(a.seedText, a.params, a.carverCacheCapacity);
          dc = null;
          return reply({ type: 'ready' });
        }
        if (m.type === 'scatter') {
          if (store === null || ctx === null) throw new Error("region worker: 'scatter' before 'attach'");
          const t0 = performance.now();
          const density = dc ??= createDensityContext(ctx);
          const scratch = scatterScratch ??= newScatterScratch();
          const est = (x: number, z: number): number => surfaceEst3(density, x, z);
          const pre = (x: number, z: number, top: number): number => preCaveTop(density, x, z, top);
          const s = newScattered();
          for (const [cx, cz] of (raw as RegionScatterMsg).cols) {
            if (!fillColumnT(store, ctx, cx, cz, NEVER)) throw new Error(`region worker: column (${cx}, ${cz}) not filled`);
            try {
              const view = store.proto(cx, cz);
              if (view === null) throw new Error(`region worker: column (${cx}, ${cz}) has no proto set`);
              analyseColumn(s, view, cx, cz, est, scratch, pre);
            } finally {
              store.freeColumn(cx, cz);
            }
          }
          const transfer = [s.hist, s.inside, s.insideSteep, s.borderPairs, s.borderSteep].map((a) => a.buffer as ArrayBuffer);
          return reply({ type: 'scattered', scattered: s, ms: performance.now() - t0 }, transfer);
        }
        if (m.type === 'column' || m.type === 'decorate' || m.type === 'light' || m.type === 'meshColumn') {
          if (store === null || ctx === null) throw new Error(`region worker: '${m.type}' before 'attach'`);
          const { cx, cz } = raw as RegionColumnMsg;
          const t0 = performance.now();
          if (m.type === 'meshColumn') {
            meshScratch ??= createMeshScratch();
            const payload = meshColumnJob(store, cx, cz, meshScratch, (raw as RegionMeshMsg).options);
            const ms = performance.now() - t0;
            const transfer = [payload.versions, payload.connectivity, payload.position, payload.data, payload.index, payload.rows, payload.spheres]
              .map((a) => a.buffer as ArrayBuffer);
            return reply({ type: 'meshed', cx, cz, ms, payload }, transfer);
          }
          if (m.type === 'column') fillColumnT(store, ctx, cx, cz, NEVER);
          else if (m.type === 'decorate') {
            if (!fillColumnD(store, ctx, cx, cz, NEVER)) throw new Error(`region worker: D of (${cx}, ${cz}) stopped`);
          } else {
            lightScratch ??= createLightScratch();
            if (fillColumnL(store, cx, cz, lightScratch, NEVER) === null) throw new Error(`region worker: L of (${cx}, ${cz}) stopped`);
          }
          const ms = performance.now() - t0;
          return reply({ type: 'done', cx, cz, ms, carverCacheSize: carverCacheOf(ctx).size });
        }
        throw new Error(`region worker: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}

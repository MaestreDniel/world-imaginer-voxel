/**
 * The region worker (SP3a spec §6.1, SP4a spec §9.2), bundled by `buildNodeTaskWorker(dir, {entry:
 * 'test/harness/regionWorker.ts'})` and driven by `genRegion` (`test/harness/region.ts`) with `threads: 4`. Its
 * messages are the harness's own test-only protocol, never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', handles, seedText, params}` once (`attachStore` and `createGenContext`), answered
 * `{type: 'ready'}`; then one job per message on the shared store, never stopped:
 * - `{type: 'column', cx, cz}`: `fillColumnT` (epoch 0);
 * - `{type: 'decorate', cx, cz}`: `fillColumnD` (`src/workers/worldJobs.ts`);
 * - `{type: 'light', cx, cz}`: `fillColumnL`, with this worker's light scratch;
 * each answered `{type: 'done', cx, cz, ms}`;
 * - `{type: 'meshColumn', cx, cz, options}`: `meshColumnJob` with this worker's mesh scratch, answered
 *   `{type: 'meshed', cx, cz, ms, payload}` with the payload's seven buffers transferred (each owns its buffer whole,
 *   ruling P27).
 * Anything that throws is answered `{type: 'error', message}`.
 */
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createLightScratch, type LightScratch } from '../../src/light/initial';
import { fillColumnT } from '../../src/metrics/region';
import { createMeshScratch, type ColumnMeshPayload, type MeshScratch } from '../../src/mesh/column';
import type { MeshOptions } from '../../src/mesh/greedy';
import { attachStore, type StoreHandles, type VoxelStore } from '../../src/world/store/store';
import { fillColumnD, fillColumnL, meshColumnJob } from '../../src/workers/worldJobs';

export interface RegionAttachMsg {
  readonly type: 'attach';
  readonly handles: StoreHandles;
  readonly seedText: string;
  readonly params: Params;
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

export type RegionWorkerReply =
  | { type: 'ready' }
  | { type: 'done'; cx: number; cz: number; ms: number }
  | { type: 'meshed'; cx: number; cz: number; ms: number; payload: ColumnMeshPayload }
  | { type: 'error'; message: string };

interface Reply {
  msg: RegionWorkerReply;
  transfer: Transferable[];
}

const NEVER = (): boolean => false;

export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let store: VoxelStore | null = null;
  let ctx: GenContext | null = null;
  let lightScratch: LightScratch | null = null;
  let meshScratch: MeshScratch | null = null;
  const reply = (msg: RegionWorkerReply, transfer: Transferable[] = []): Reply => ({ msg, transfer });
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown };
        if (m.type === 'attach') {
          const a = raw as RegionAttachMsg;
          store = attachStore(a.handles);
          ctx = createGenContext(seedFromInput(a.seedText), a.params);
          return reply({ type: 'ready' });
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
          return reply({ type: 'done', cx, cz, ms: performance.now() - t0 });
        }
        throw new Error(`region worker: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}

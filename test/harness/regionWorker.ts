/**
 * The region worker (SP3a spec §6.1), bundled by `buildNodeTaskWorker(dir, {entry: 'test/harness/regionWorker.ts'})`
 * and driven by `genRegion` (`test/harness/region.ts`) with `threads: 4`. Never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', handles, seedText, params}` once (`attachStore` and `createGenContext`), answered
 * `{type: 'ready'}`; then `{type: 'column', cx, cz}`, answered `{type: 'done', cx, cz, ms}` after `fillColumnT`
 * (never stopped, epoch 0). Anything that throws is answered `{type: 'error', message}`.
 */
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { fillColumnT } from '../../src/metrics/region';
import { attachStore, type StoreHandles, type VoxelStore } from '../../src/world/store/store';

export interface RegionAttachMsg {
  readonly type: 'attach';
  readonly handles: StoreHandles;
  readonly seedText: string;
  readonly params: Params;
}

export interface RegionColumnMsg {
  readonly type: 'column';
  readonly cx: number;
  readonly cz: number;
}

export type RegionWorkerReply =
  | { type: 'ready' }
  | { type: 'done'; cx: number; cz: number; ms: number }
  | { type: 'error'; message: string };

interface Reply {
  msg: RegionWorkerReply;
  transfer: Transferable[];
}

const NEVER = (): boolean => false;

export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let store: VoxelStore | null = null;
  let ctx: GenContext | null = null;
  const reply = (msg: RegionWorkerReply): Reply => ({ msg, transfer: [] });
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
        if (m.type === 'column') {
          if (store === null || ctx === null) throw new Error("region worker: 'column' before 'attach'");
          const { cx, cz } = raw as RegionColumnMsg;
          const t0 = performance.now();
          fillColumnT(store, ctx, cx, cz, NEVER);
          return reply({ type: 'done', cx, cz, ms: performance.now() - t0 });
        }
        throw new Error(`region worker: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}

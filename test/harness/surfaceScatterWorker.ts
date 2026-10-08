/**
 * The surface metric's region worker (SP3c spec §5.1-§5.2), bundled by
 * `buildNodeTaskWorker(dir, {entry: 'test/harness/surfaceScatterWorker.ts'})` and driven by
 * `test/metrics/surface.metric.ts` with 4 of them. It generates each column up to the T stage in its own small
 * ArrayBuffer store (`fillColumnT`, never stopped, epoch 0), analyses it in place (`createSurfaceColumnAnalyser`) and
 * frees it, so only the counts leave the worker. Never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', seedText, params}` once (`createGenContext`, a new store and analyser), answered
 * `{type: 'ready'}`; then `{type: 'column', cx, cz}`, answered `{type: 'done', cx, cz, ms}`; `{type: 'take'}` answers
 * `{type: 'acc', acc}` with the counts since the last take (a structured clone of a `SurfaceAcc`) and starts a new
 * one. Anything that throws is answered `{type: 'error', message}`.
 */
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { fillColumnT } from '../../src/metrics/region';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { createSurfaceColumnAnalyser, newSurfaceAcc, type SurfaceAcc, type SurfaceColumnAnalyser } from './surfaceScatter';

export interface SurfaceScatterAttachMsg {
  readonly type: 'attach';
  readonly seedText: string;
  readonly params: Params;
}

export interface SurfaceScatterColumnMsg {
  readonly type: 'column';
  readonly cx: number;
  readonly cz: number;
}

export interface SurfaceScatterTakeMsg {
  readonly type: 'take';
}

export type SurfaceScatterMsg = SurfaceScatterAttachMsg | SurfaceScatterColumnMsg | SurfaceScatterTakeMsg;

export type SurfaceScatterReply =
  | { type: 'ready' }
  | { type: 'done'; cx: number; cz: number; ms: number }
  | { type: 'acc'; acc: SurfaceAcc }
  | { type: 'error'; message: string };

interface Reply {
  msg: SurfaceScatterReply;
  transfer: Transferable[];
}

const NEVER = (): boolean => false;

export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let store: VoxelStore | null = null;
  let state: { analyse: SurfaceColumnAnalyser; ctx: GenContext } | null = null;
  let acc = newSurfaceAcc();
  const reply = (msg: SurfaceScatterReply): Reply => ({ msg, transfer: [] });
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown };
        if (m.type === 'attach') {
          const a = raw as SurfaceScatterAttachMsg;
          const ctx = createGenContext(seedFromInput(a.seedText), a.params);
          store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
          state = { ctx, analyse: createSurfaceColumnAnalyser(a.seedText, ctx) };
          acc = newSurfaceAcc();
          return reply({ type: 'ready' });
        }
        if (m.type === 'column') {
          if (store === null || state === null) throw new Error("surface scatter worker: 'column' before 'attach'");
          const { cx, cz } = raw as SurfaceScatterColumnMsg;
          const t0 = performance.now();
          if (!fillColumnT(store, state.ctx, cx, cz, NEVER)) throw new Error(`surface scatter worker: column (${cx}, ${cz}) not filled`);
          try {
            const view = store.proto(cx, cz);
            if (view === null) throw new Error(`surface scatter worker: column (${cx}, ${cz}) has no proto set`);
            state.analyse(view, cx, cz, acc);
          } finally {
            store.freeColumn(cx, cz);
          }
          return reply({ type: 'done', cx, cz, ms: performance.now() - t0 });
        }
        if (m.type === 'take') {
          const out = acc;
          acc = newSurfaceAcc();
          return reply({ type: 'acc', acc: out });
        }
        throw new Error(`surface scatter worker: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}

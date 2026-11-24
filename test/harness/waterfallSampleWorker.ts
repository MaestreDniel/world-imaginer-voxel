/**
 * `A5.waterfalls`' sample in worker threads (SP7a Task 31, spec §13.1, §14; `test/metrics/waterfalls.metric.ts`): a
 * harness entry (`nodeWorker.ts`' contract: it exports `createTaskHandler()`, whose `handle(message)` returns
 * `{msg, transfer}`, and imports no `node:` module), answering `{ type: 'rows', seed, params, b0, b1, half }` with the raw
 * counts of the lattice rows b0 … b1 − 1 (`waterfallSampleRows`), which the metric sums (`mergeSampleAccs`).
 */
import type { Params } from '../../src/core/params/schema';
import { waterfallSampleRows, type SampleAcc } from './waterfallSample';

/** A slice of the sample's lattice rows to scan and count. */
export interface SampleRowsMsg {
  readonly type: 'rows';
  readonly seed: string;
  readonly params: Params;
  readonly b0: number;
  readonly b1: number;
  readonly half: number;
}

export type SampleRowsReply =
  | { readonly type: 'counted'; readonly b0: number; readonly accs: SampleAcc[] }
  | { readonly type: 'error'; readonly message: string };

export function createTaskHandler(): { handle(raw: unknown): { msg: SampleRowsReply; transfer: [] } } {
  return {
    handle(raw) {
      try {
        const m = raw as Partial<SampleRowsMsg>;
        if (m.type !== 'rows') throw new Error(`waterfall sample worker: unknown message '${String(m.type)}'`);
        const { seed, params, b0, b1, half } = raw as SampleRowsMsg;
        return { msg: { type: 'counted', b0, accs: waterfallSampleRows(seed, params, b0, b1, half) }, transfer: [] };
      } catch (e) {
        return { msg: { type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) }, transfer: [] };
      }
    },
  };
}

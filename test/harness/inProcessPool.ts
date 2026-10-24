/**
 * The in-process task-handler worker (SP4b spec §8.1, §8.5; from `perfHook.test.ts`'s `handlerWorker`): the real
 * `createTaskHandler()` behind the `WorkerLike` surface the pool uses, so unit tests and `stream.metric.ts` run the
 * pool's protocol without threads. Each message is handled on a `setTimeout(0)` (a reply never arrives inside
 * `postMessage`, as with a real worker), and after each reply the handler's limbo is drained as the worker shell does
 * (`drainAfterReply`, SP4b spec §2.5: at once, then every `LIMBO_RETRY_MS` while entries are left). After `terminate`
 * nothing more is handled or replied.
 */
import type { WorkerLike } from '../../src/engine/workerPool';
import { createTaskHandler, drainAfterReply } from '../../src/workers/taskHandler';

export function inProcessWorker(): WorkerLike {
  const h = createTaskHandler();
  let terminated = false;
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) {
      setTimeout(() => {
        if (terminated) return;
        const r = h.handle(msg);
        w.onmessage?.({ data: r.msg });
        drainAfterReply(h, setTimeout);
      }, 0);
    },
    terminate() {
      terminated = true;
    },
  };
  return w;
}

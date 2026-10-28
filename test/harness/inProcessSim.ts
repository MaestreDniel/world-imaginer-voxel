/**
 * The in-process sim worker (SP5a spec §6.1, E5): the real `createSimHandler()` behind the `SimWorkerLike` surface
 * `createSimClient` spawns, so `edit.metric.ts` runs the sim's protocol without a thread, as `inProcessPool.ts` does for
 * the pool. Each message is handled and answered after the injected delay (`delayMs()`, read at its post), in the order
 * posted: a message waits for the one before it, as the sim handles messages in order (§2.1). The reply's arrays are
 * passed as they are (transfers kept: nothing is cloned or detached). After each reply the handler's limbo is drained as
 * `sim.worker.ts` does (ruling R33): at once, then every `SIM_DRAIN_MS` while entries are left. After `terminate`
 * nothing more is handled, replied or drained.
 */
import type { SimWorkerLike } from '../../src/engine/simClient';
import { SIM_DRAIN_MS, type createSimHandler } from '../../src/workers/simHandler';

export function inProcessSimWorker(handler: ReturnType<typeof createSimHandler>, delayMs: () => number): SimWorkerLike {
  const queue: Array<{ readonly msg: unknown; readonly due: number }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let terminated = false;

  const retry = (): void => {
    drainTimer = null;
    if (!terminated && handler.drain() > 0) drainTimer = setTimeout(retry, SIM_DRAIN_MS);
  };
  const schedule = (): void => {
    if (terminated || timer !== null || queue.length === 0) return;
    timer = setTimeout(next, Math.max(0, queue[0]!.due - performance.now()));
  };
  const next = (): void => {
    timer = null;
    if (terminated) return;
    const { msg } = queue.shift()!;
    const r = handler.handle(msg);
    w.onmessage?.({ data: r.msg });
    if (!terminated && drainTimer === null && handler.drain() > 0) drainTimer = setTimeout(retry, SIM_DRAIN_MS);
    schedule();
  };

  const w: SimWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      if (terminated) return;
      queue.push({ msg, due: performance.now() + delayMs() });
      schedule();
    },
    terminate() {
      terminated = true;
      queue.length = 0;
      if (timer !== null) clearTimeout(timer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      timer = null;
      drainTimer = null;
    },
  };
  return w;
}

/**
 * Sim worker shell (SP5a spec §2.1, D17): wires the sim's handler to the worker's message port, attached by the page as
 * thread 15. After each message it drains the thread's limbo and, while entries are left, retries every `SIM_DRAIN_MS`
 * (the sim has no reply loop like the pool's, so an idle sim would otherwise keep its retired slots counted as used).
 */
import { createSimHandler, SIM_DRAIN_MS } from './simHandler';

const handler = createSimHandler();
/** A retry timer is pending, so a message during the retries starts no second chain. */
let retrying = false;

const retry = (): void => {
  if (handler.drain() > 0) setTimeout(retry, SIM_DRAIN_MS);
  else retrying = false;
};

self.onmessage = (event: MessageEvent<unknown>) => {
  const r = handler.handle(event.data);
  postMessage(r.msg, { transfer: r.transfer });
  if (handler.drain() === 0 || retrying) return;
  retrying = true;
  setTimeout(retry, SIM_DRAIN_MS);
};

export {};

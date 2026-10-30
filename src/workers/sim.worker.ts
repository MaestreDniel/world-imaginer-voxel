/**
 * Sim worker shell (SP5a spec §2.1, D17): wires the sim's handler to the worker's message port, attached by the page as
 * thread 15. After each reply it drains the thread's limbo and, while entries are left, retries every
 * `SIM_DRAIN_MS` (the sim has no reply loop like the pool's, so an idle sim would otherwise keep its retired slots
 * counted as used). SP5b (spec §3.3, D17, D18): the handler opens the saved world's IndexedDB database itself
 * (`openIdbKV`) and answers through `post`, at once or when a transaction settles.
 */
import { openIdbKV } from '../persist/idb';
import { createSimHandler, SIM_DRAIN_MS, type SimReply } from './simHandler';

const handler = createSimHandler({ openKV: (db) => openIdbKV(db) });
/** A retry timer is pending, so a message during the retries starts no second chain. */
let retrying = false;

const retry = (): void => {
  if (handler.drain() > 0) setTimeout(retry, SIM_DRAIN_MS);
  else retrying = false;
};

const drainSoon = (): void => {
  if (handler.drain() === 0 || retrying) return;
  retrying = true;
  setTimeout(retry, SIM_DRAIN_MS);
};

const post = (r: SimReply): void => {
  postMessage(r.msg, { transfer: r.transfer });
  drainSoon();
};

self.onmessage = (event: MessageEvent<unknown>) => handler.handle(event.data, post);

export {};

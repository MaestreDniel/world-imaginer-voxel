/** The store spike's worker shell (SP4a spec §1.2 item 6, ruling P18): wires the pure handler to the worker's port. */
import { createTaskHandler } from './spikeStoreHandler';

const handler = createTaskHandler();

self.onmessage = (event: MessageEvent<unknown>) => {
  const r = handler.handle(event.data);
  postMessage(r.msg, { transfer: [...r.transfer] });
};

export {};

/** Task worker shell (SP2a spec §5.1): wires the pure handler to the worker's message port. */
import { createTaskHandler } from './taskHandler';

const handler = createTaskHandler();

self.onmessage = (event: MessageEvent<unknown>) => {
  const r = handler.handle(event.data);
  postMessage(r.msg, { transfer: [...r.transfer] });
};

export {};

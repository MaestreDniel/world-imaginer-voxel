/**
 * Task worker shell (SP2a spec §5.1): wires the pure handler to the worker's message port. After each reply it drains the
 * worker's limbo and retries every 16 ms while entries are left (SP4b spec §2.5, `drainAfterReply`).
 */
import { createTaskHandler, drainAfterReply } from './taskHandler';

const handler = createTaskHandler();

self.onmessage = (event: MessageEvent<unknown>) => {
  const r = handler.handle(event.data);
  postMessage(r.msg, { transfer: [...r.transfer] });
  drainAfterReply(handler, setTimeout);
};

export {};

import { parentPort, workerData } from 'node:worker_threads';

const { sab, role, adds, rounds } = workerData;
const i32 = new Int32Array(sab);
const COUNTER = 0;
const TURN = 1;
const LOG_LEN = 2;
const LOG = 3;
const WAIT_MS = 5000;

function main() {
  for (let k = 0; k < adds; k++) Atomics.add(i32, COUNTER, 1);
  for (let r = 0; r < rounds; r++) {
    while (Atomics.load(i32, TURN) !== role) {
      if (Atomics.wait(i32, TURN, 1 - role, WAIT_MS) === 'timed-out') {
        return { ok: false, error: `role ${role} timed out waiting in round ${r}` };
      }
    }
    const idx = Atomics.add(i32, LOG_LEN, 1);
    Atomics.store(i32, LOG + idx, role);
    Atomics.store(i32, TURN, 1 - role);
    Atomics.notify(i32, TURN);
  }
  return { ok: true };
}

parentPort.postMessage(main());

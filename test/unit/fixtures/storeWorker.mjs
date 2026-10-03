// The worker side of store.test.ts "attachStore across two threads": attaches to the main thread's store, reads
// its column (2, 2), writes columns (3 … 7, 2) with 24 dense block sections each (growing the block pool), bumps
// the terrain epoch cell and replies with what it read.
import { parentPort, workerData } from 'node:worker_threads';

const { storeUrl, handles } = workerData;

async function main() {
  const { attachStore } = await import(storeUrl);
  const s = attachStore(handles);
  const v = s.proto(2, 2);
  if (v === null) return { ok: false, error: 'column (2, 2) absent in the worker' };
  const read = [];
  for (let sy = 0; sy < 24; sy++) read.push(v.block(1, sy * 16 - 64, 0));
  read.push(v.block(0, -64, 0), v.fluid(0, -64, 0), v.aux().worldSurfaceWG[3]);
  for (let cx = 3; cx <= 7; cx++) {
    const w = s.claimColumn(cx, 2, 0);
    for (let sy = 0; sy < 24; sy++) {
      const b = new Uint16Array(4096);
      b.fill(1, 0, 2048);
      b[1] = 1000 + cx * 100 + sy;
      w.setProto(sy, b, new Uint8Array(4096));
    }
    w.aux().oceanFloorWG[255] = cx;
    w.commit(1);
  }
  s.epochs.bump(0);
  return { ok: true, read, slotCount: s.blockPool.slotCount() };
}

main().then(
  (r) => parentPort.postMessage(r),
  (e) => parentPort.postMessage({ ok: false, error: String(e && e.stack ? e.stack : e) }),
);

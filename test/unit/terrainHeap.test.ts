/**
 * SP2a minor 5 (SP3b spec §4): the T stage's hot path retains nothing once its caches are warm. 1000 columns of seed
 * '42' go through `fillColumnT` and `freeColumn` on one `ArrayBuffer` store twice; the second pass (same columns: the
 * lake cells, the DensityContext, the store's pools and the JIT are warm) may grow the heap, measured after a full GC
 * on both sides, by less than HEAP_GROWTH_MAX bytes. Short-lived garbage (boxed doubles returned by the noise, climate
 * and density closures) is collected by scavenges and is not counted: see the column stage's notes in `lakes.ts`.
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { fillColumnT } from '../../src/metrics/region';
import { createStore } from '../../src/world/store/store';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const used = (): number => {
  gc();
  gc();
  return v8.getHeapStatistics().used_heap_size;
};

/** 16 bytes per column on average: retaining even one small object per column fails (measured: about −4 KiB). */
const HEAP_GROWTH_MAX = 16 * 1024;
const COLUMNS = 1000;

test(`the T stage's hot path: heap growth over ${COLUMNS} warm columns < ${HEAP_GROWTH_MAX} bytes`, () => {
  const ctx = ctxFor('42');
  const next = testRng(1005);
  const cols = Array.from({ length: COLUMNS }, () => [(next() % 2048) - 1024, (next() % 2048) - 1024] as const);
  const store = createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  const NEVER = (): boolean => false;
  let committed = 0;
  const pass = (): void => {
    for (const [cx, cz] of cols) {
      if (fillColumnT(store, ctx, cx, cz, NEVER)) committed++;
      store.freeColumn(cx, cz);
    }
  };
  pass();
  const before = used();
  pass();
  const growth = used() - before;
  expect(committed).toBe(2 * COLUMNS);
  expect(growth, `heap growth ${growth} bytes`).toBeLessThan(HEAP_GROWTH_MAX);
}, 60_000);

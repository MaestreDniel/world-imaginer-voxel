/**
 * SP2a minor 5 (SP3b spec §4): the T stage's hot path retains nothing once its caches are warm. 1000 columns of seed
 * '42' go through `fillColumnT` and `freeColumn` on one `ArrayBuffer` store twice; the second pass (same columns: the
 * lake cells, the DensityContext, the store's pools and the JIT are warm) may grow the heap, measured after a full GC
 * on both sides, by less than HEAP_GROWTH_MAX bytes. Short-lived garbage (boxed doubles returned by the noise, climate
 * and density closures) is collected by scavenges and is not counted: see the column stage's notes in `lakes.ts`.
 *
 * The heap is measured without V8's JIT spaces (`code_*` and `trusted_*`: machine code, bytecode and deoptimisation
 * data). What the compiler installs there during the second pass depends on when its background threads finish, which
 * a loaded machine delays (`npm run test:goldens` runs this file beside metrics-quick). Measured on the SP3c tree:
 * the second pass grows those spaces by 12,048 bytes when run alone and by −1,296 … +12,048 under load, and the
 * other spaces by 4,056 … 5,568 bytes in every run; the whole heap grew by 17,824 and 19,000 bytes (> 16 KiB) in the
 * two failed runs under load. The T stage's own data never lives in the JIT spaces, so a retained object per column
 * still fails.
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
/** V8's spaces for compiled code and its metadata (code, bytecode, deoptimisation data): not counted. */
const JIT_SPACE = /^(code|trusted|shared_trusted)_/;
const used = (): number => {
  gc();
  gc();
  let n = 0;
  for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) n += s.space_used_size;
  return n;
};

/** 16 bytes per column on average: retaining even one small object per column fails (measured: 4,056 … 5,568 bytes). */
const HEAP_GROWTH_MAX = 16 * 1024;
const COLUMNS = 1000;

test('the JIT spaces left out of the measurement exist under these names', () => {
  const names = v8.getHeapSpaceStatistics().map((s) => s.space_name);
  expect(names.filter((n) => JIT_SPACE.test(n))).toEqual(expect.arrayContaining(['code_space', 'trusted_space']));
  expect(names).toEqual(expect.arrayContaining(['new_space', 'old_space', 'large_object_space']));
  expect(names.filter((n) => !JIT_SPACE.test(n))).not.toContain('code_space');
});

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

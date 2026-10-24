import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RECORD_COUNT, RECORD_INTS, REC_CLAIMED, REC_GEN } from '../../src/world/store/columnTable';
import type { SlabPool } from '../../src/world/store/pool';
import { R_LIMBO, R_READER, RECLAIM_THREADS } from '../../src/world/store/reclaim';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { integerEnv } from '../harness/env';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';
import {
  createTableFuzzShared, RARE_COUNTS, STOPPED, TABLE_FUZZ_COUNTS, type TableFuzzPhase, type TableFuzzReply, type TableFuzzShared,
  type TableFuzzStats,
} from '../harness/tableFuzzWorker';

/**
 * The column-table race fuzz (SP4b spec §2.9): 4 worker threads (reclaim threads 1 … 4, spec §2.5, so each read
 * section has its own reader slot) on one shared store, 100,000 operations in three phases, seeded by
 * `SLAB_FUZZ_SEED`. Each phase ends with a settle (every thread frees what it holds, drains its limbo), then this
 * thread checks the whole store while every worker is idle: every record free, every slot free, no limbo, no reader.
 * - races: claim / unclaim / find on 64 shared records, takeovers of abandoned writers (`twoHolders`, `staleFinds`,
 *   `versionsDecreased`, `missedStale`, `spuriousStale`);
 * - handoff: slots and columns made on one thread, freed on another (`doubleAllocs`, `negativeRefcounts`);
 * - reclaim: canaries stamped in slots inside read sections while writers retire and reuse slots (`reusedUnderReader`).
 */
const THREADS = 4;
const OPS = 100_000;
const PHASE_OPS: readonly (readonly [TableFuzzPhase, number])[] = [['races', 50_000], ['handoff', 20_000], ['reclaim', 30_000]];
const MiB = 1 << 20;
const SEED = integerEnv('SLAB_FUZZ_SEED', 1);

let script = '';
const workers: Worker[] = [];

beforeAll(async () => {
  script = await buildNodeTaskWorker('columnTableFuzz', { entry: 'test/harness/tableFuzzWorker.ts' });
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

/** Every reply of a step (`msg` per thread index 0 … 3), failing with the worker's message and the seed on an error. */
async function all(msg: (i: number) => unknown): Promise<TableFuzzStats[]> {
  const replies = await Promise.all(workers.map((w, i) => ask<TableFuzzReply>(w, msg(i))));
  // The failing thread's error, not the `STOPPED` of the threads it stopped.
  const failed = replies.flatMap((r, i) => (r.type === 'error' ? [{ i, message: r.message }] : []))
    .sort((a, b) => Number(a.message.includes(STOPPED)) - Number(b.message.includes(STOPPED)));
  const fail = (f: { i: number; message: string }) => new Error(`table fuzz thread ${f.i + 1} (SLAB_FUZZ_SEED=${SEED}): ${f.message}`);
  if (failed.length > 0) throw fail(failed[0]!);
  return replies.map((r, i) => {
    if (r.type === 'error') throw fail({ i, message: r.message });
    return r.stats;
  });
}

/** A pool with every slot free: refcounts 0, the free stack full and without repeats, the lock released. */
function poolLeaks(p: SlabPool): { slots: number; live: number; lost: number; badStack: number; lock: number } {
  const slots = p.slotCount();
  let live = 0;
  for (let id = 0; id < slots; id++) if (p.refcount(id) !== 0) live++;
  const stack = p.freeStack();
  const seen = new Uint8Array(slots);
  let badStack = 0;
  for (const id of stack) {
    if (id < 0 || id >= slots || seen[id] === 1) badStack++;
    else seen[id] = 1;
  }
  return { slots, live, lost: slots - stack.length, badStack, lock: p.lockWord() };
}

/** The whole-store check while every worker is idle (after a settle). */
function checkIdle(store: VoxelStore, shared: TableFuzzShared, phase: string): void {
  const ints = store.table.ints;
  let claimed = 0;
  let oddGen = 0;
  for (let rec = 0; rec < RECORD_COUNT; rec++) {
    if (Atomics.load(ints, rec * RECORD_INTS + REC_CLAIMED) !== 0) claimed++;
    if ((Atomics.load(ints, rec * RECORD_INTS + REC_GEN) & 1) !== 0) oddGen++;
  }
  expect({ claimed, oddGen }, `records after ${phase}`).toEqual({ claimed: 0, oddGen: 0 });
  expect(new Int32Array(shared.own).some((v) => v !== 0), `ownership tokens after ${phase}`).toBe(false);
  for (const name of ['blocks', 'bytes'] as const) {
    expect(new Int32Array(shared.slotOwner[name]).some((v) => v !== 0), `${name} slot owners after ${phase}`).toBe(false);
    expect(new Int32Array(shared.outstanding[name]).some((v) => v !== 0), `${name} outstanding refs after ${phase}`).toBe(false);
  }
  const leak = { block: poolLeaks(store.blockPool), byte: poolLeaks(store.bytePool) };
  expect({ live: leak.block.live, lost: leak.block.lost, badStack: leak.block.badStack, lock: leak.block.lock }, `block pool after ${phase}`)
    .toEqual({ live: 0, lost: 0, badStack: 0, lock: 0 });
  expect({ live: leak.byte.live, lost: leak.byte.lost, badStack: leak.byte.badStack, lock: leak.byte.lock }, `byte pool after ${phase}`)
    .toEqual({ live: 0, lost: 0, badStack: 0, lock: 0 });
  const r = new Int32Array(store.handles().reclaim);
  for (let t = 0; t < RECLAIM_THREADS; t++) {
    expect(Atomics.load(r, R_READER + t), `thread ${t}'s reader epoch after ${phase}`).toBe(0);
    expect(Atomics.load(r, R_LIMBO + t), `thread ${t}'s limbo after ${phase}`).toBe(0);
  }
}

test('column-table race fuzz: 4 threads, 100k ops: column-table races, cross-thread slot handoff, deferred reclamation', async () => {
  const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 32 * MiB });
  const shared = createTableFuzzShared(store, PHASE_OPS[0]![1]);
  for (let i = 0; i < THREADS; i++) workers.push(new Worker(script));
  // Reclaim threads 1 … 4 (spec §2.5): the main thread keeps 0, so the reclamation phase exercises four reader slots.
  await all((i) => ({ type: 'attach', thread: i + 1, seed: SEED, handles: store.handles(), shared }));

  let ops = 0;
  for (const [phase, total] of PHASE_OPS) {
    await all(() => ({ type: 'run', phase, ops: total / THREADS }));
    const settled = await all(() => ({ type: 'settle', phase }));
    ops += total;
    expect(settled.reduce((n, st) => n + st.ops, 0), `operations after ${phase}`).toBe(ops);
    for (const [i, st] of settled.entries()) {
      const who = `${phase}, thread ${i + 1}`;
      expect(st.twoHolders, `${who}: a record claimed by two threads at once`).toBe(0);
      expect(st.staleFinds, `${who}: a find returned a record that never held the column while it ran`).toBe(0);
      expect(st.versionsDecreased, `${who}: a record's versions or generation went down`).toBe(0);
      expect(st.missedStale, `${who}: a writer call after a completed takeover did not throw WriterStale`).toBe(0);
      expect(st.spuriousStale, `${who}: a writer call under its ownership token threw WriterStale`).toBe(0);
      expect(st.missedFinds, `${who}: a find missed a column this thread held`).toBe(0);
      expect(st.doubleAllocs, `${who}: a slot handed out while a reference still held it`).toBe(0);
      expect(st.negativeRefcounts, `${who}: a refcount below 0`).toBe(0);
      expect(st.dataMismatches, `${who}: a handed-over slot or column changed under its references`).toBe(0);
      expect(st.ownerMismatches, `${who}: an ownership token or slot owner held by another thread`).toBe(0);
      expect(st.reusedUnderReader, `${who}: a slot reused under an active reader`).toBe(0);
      expect(st.timeouts, `${who}: a bounded wait ran out`).toBe(0);
      expect(st.limbo, `${who}: limbo entries left after the settle`).toBe(0);
    }
    checkIdle(store, shared, phase);
  }
  expect(ops).toBe(OPS);

  // Every kind of operation ran on every thread; the rare ones (a race outcome, not a choice) at least once in all.
  const final = await all(() => ({ type: 'stats' }));
  const sums: Record<string, number> = {};
  for (const st of final) for (const [k, n] of Object.entries(st.counts)) sums[k] = (sums[k] ?? 0) + n;
  for (const [i, st] of final.entries()) {
    for (const k of TABLE_FUZZ_COUNTS) {
      if (!RARE_COUNTS.includes(k)) expect(st.counts[k], `${k} on thread ${i + 1}`).toBeGreaterThan(0);
    }
  }
  for (const k of RARE_COUNTS) expect(sums[k], `${k} over all threads`).toBeGreaterThan(0);
  console.log(
    `column-table fuzz (SLAB_FUZZ_SEED=${SEED}): ${TABLE_FUZZ_COUNTS.map((k) => `${k} ${sums[k]}`).join(', ')}; ` +
      `pools at ${store.blockPool.slotCount()} block and ${store.bytePool.slotCount()} byte slots`,
  );
}, 60_000);

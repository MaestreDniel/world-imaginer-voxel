import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { finalAt, protoAt, RECORD_COUNT, RECORD_INTS, REC_AUX_A, REC_AUX_B, REC_CLAIMED, SECTIONS } from '../../src/world/store/columnTable';
import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, PROTO_BLOCKS, PROTO_FLUID } from '../../src/world/store/section';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import type { SlabPool } from '../../src/world/store/pool';
import { FUZZ_LIMITS, type FuzzReply, type FuzzStats } from '../harness/fuzzWorker';
import { integerEnv } from '../harness/env';
import { ask, buildNodeTaskWorker } from '../harness/nodeWorker';

/**
 * Slab fuzz (SP3a spec §3.6, §9): 4 worker threads × 100k random ops on one shared store (64 MiB block pool,
 * 32 MiB byte pool): raw alloc/retain/free, uniform ↔ dense section rewrites, proto and final sets (shared or
 * not), freeProto, freeColumn, aux slots, and claims with torus collisions. The pools start empty and grow while
 * the threads race. Between phases every thread is idle and this thread checks the whole store; the limits are
 * hard assertions (no threshold row, §9).
 */
const THREADS = 4;
const OPS = 100_000;
const PHASES = 10;
const MiB = 1 << 20;
const SEED = integerEnv('SLAB_FUZZ_SEED', 1);

let script = '';
const workers: Worker[] = [];

beforeAll(async () => {
  script = await buildNodeTaskWorker('slabFuzz', { entry: 'test/harness/fuzzWorker.ts' });
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

/** Every reply of a phase (`msg` per thread), failing with the worker's message and the seed on an error reply. */
async function all(msg: (thread: number) => unknown): Promise<FuzzStats[]> {
  const replies = await Promise.all(workers.map((w, t) => ask<FuzzReply>(w, msg(t))));
  return replies.map((r, t) => {
    if (r.type === 'error') throw new Error(`fuzz thread ${t} (SLAB_FUZZ_SEED=${SEED}): ${r.message}`);
    return r.stats;
  });
}

interface PoolCheck {
  slots: number;
  /** Slots whose refcount differs from their raw references plus the entries that reference them. */
  refMismatches: number;
  /** slot count − (free-stack size + slots with refcount > 0). */
  lost: number;
  /** Free-stack entries that repeat, or whose slot has refcount ≠ 0. */
  badStack: number;
  /** Slots whose owner cell disagrees with their holder (0 for a free slot, the referencing thread otherwise). */
  ownerMismatches: number;
  live: number;
  lock: number;
}

/** The whole-store check made while every thread is idle (SP3a spec §3.6). */
function check(s: VoxelStore, raw: { blocks: Int32Array; bytes: Int32Array }, owners: { blocks: Int32Array; bytes: Int32Array }) {
  const expected = { blocks: new Int32Array(s.blockPool.maxSlots), bytes: new Int32Array(s.bytePool.maxSlots) };
  const holder = { blocks: new Int32Array(s.blockPool.maxSlots), bytes: new Int32Array(s.bytePool.maxSlots) };
  for (let i = 0; i < expected.blocks.length; i++) expected.blocks[i] = Atomics.load(raw.blocks, i);
  for (let i = 0; i < expected.bytes.length; i++) expected.bytes[i] = Atomics.load(raw.bytes, i);
  const ints = s.table.ints;
  let claimed = 0;
  for (let rec = 0; rec < RECORD_COUNT; rec++) {
    const base = rec * RECORD_INTS;
    if (Atomics.load(ints, base + REC_CLAIMED) !== 1) continue;
    claimed++;
    const thread = 1 + (rec % THREADS);
    const add = (pool: 'blocks' | 'bytes', code: number) => {
      if (code < 0) return;
      expected[pool][code]!++;
      holder[pool][code] = thread;
    };
    for (let sy = 0; sy < SECTIONS; sy++) {
      const p = protoAt(base, sy);
      const f = finalAt(base, sy);
      add('blocks', ints[p + PROTO_BLOCKS]!);
      add('bytes', ints[p + PROTO_FLUID]!);
      add('blocks', ints[f + FINAL_BLOCKS]!);
      add('bytes', ints[f + FINAL_LIGHT]!);
      add('bytes', ints[f + FINAL_FLUID]!);
    }
    add('bytes', ints[base + REC_AUX_A]!);
    add('bytes', ints[base + REC_AUX_B]!);
  }
  const pool = (p: SlabPool, name: 'blocks' | 'bytes'): PoolCheck => {
    const slots = p.slotCount();
    let refMismatches = 0;
    let live = 0;
    let ownerMismatches = 0;
    for (let id = 0; id < slots; id++) {
      const rc = p.refcount(id);
      if (rc !== expected[name][id]) refMismatches++;
      if (rc > 0) live++;
      const owner = Atomics.load(owners[name], id);
      if (rc === 0 ? owner !== 0 : owner === 0 || (holder[name][id] !== 0 && owner !== holder[name][id])) ownerMismatches++;
    }
    for (let id = slots; id < expected[name].length; id++) if (expected[name][id] !== 0) refMismatches++;
    const stack = p.freeStack();
    const seen = new Uint8Array(slots);
    let badStack = 0;
    for (const id of stack) {
      if (id < 0 || id >= slots || seen[id] === 1 || p.refcount(id) !== 0) badStack++;
      else seen[id] = 1;
    }
    return { slots, refMismatches, lost: slots - (stack.length + live), badStack, ownerMismatches, live, lock: p.lockWord() };
  };
  return { blocks: pool(s.blockPool, 'blocks'), bytes: pool(s.bytePool, 'bytes'), claimed };
}

const clean = (c: PoolCheck) => ({ refMismatches: c.refMismatches, lost: c.lost, badStack: c.badStack, ownerMismatches: c.ownerMismatches, lock: c.lock });
const ZERO = { refMismatches: 0, lost: 0, badStack: 0, ownerMismatches: 0, lock: 0 };

test('slab fuzz: 4 threads × 100k ops, both pools, growth, promotion, sharing, torus collisions', async () => {
  const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 32 * MiB });
  const sab = (slots: number) => new Int32Array(new SharedArrayBuffer(4 * slots));
  const raw = { blocks: sab(store.blockPool.maxSlots), bytes: sab(store.bytePool.maxSlots) };
  const owners = { blocks: sab(store.blockPool.maxSlots), bytes: sab(store.bytePool.maxSlots) };
  expect(store.blockPool.maxSlots).toBe(8192);
  expect(store.bytePool.maxSlots).toBe(8192);
  expect(store.blockPool.slotCount() + store.bytePool.slotCount()).toBe(0);

  for (let t = 0; t < THREADS; t++) workers.push(new Worker(script));
  await all((thread) => ({
    type: 'attach', thread, threads: THREADS, seed: SEED, handles: store.handles(),
    raw: { blocks: raw.blocks.buffer, bytes: raw.bytes.buffer },
    owners: { blocks: owners.blocks.buffer, bytes: owners.bytes.buffer },
  }));
  for (let phase = 0; phase < PHASES; phase++) {
    const stats = await all(() => ({ type: 'run', ops: OPS / PHASES }));
    for (const st of stats) {
      expect(st.doubleAllocs, 'double allocations').toBe(0);
      expect(st.wrongLookups, 'lookups returning another column').toBe(0);
      expect(st.busyFailures, 'claims of a held record that did not throw SlotBusy').toBe(0);
      expect(st.dataMismatches, 'slot contents changed under a reference').toBe(0);
      expect(st.ownerMismatches, 'owner cells').toBe(0);
      expect(st.maxRaw.blocks).toBeLessThanOrEqual(FUZZ_LIMITS.rawRefs);
      expect(st.maxRaw.bytes).toBeLessThanOrEqual(FUZZ_LIMITS.rawRefs);
      expect(st.maxColumns).toBeLessThanOrEqual(FUZZ_LIMITS.columns);
    }
    const c = check(store, raw, owners);
    expect(clean(c.blocks), `block pool after phase ${phase}`).toEqual(ZERO);
    expect(clean(c.bytes), `byte pool after phase ${phase}`).toEqual(ZERO);
  }

  const before = check(store, raw, owners);
  const final = await all(() => ({ type: 'teardown' }));
  const ops = final.reduce((n, st) => n + st.ops, 0);
  expect(ops).toBe(THREADS * OPS);
  // Every kind of op ran, on every thread.
  for (const st of final) {
    for (const [kind, n] of Object.entries(st.counts)) expect(n, `${kind} ops`).toBeGreaterThan(0);
    expect(st.doubleAllocs + st.wrongLookups + st.busyFailures + st.dataMismatches + st.ownerMismatches).toBe(0);
  }
  // Growth happened many times while the threads raced (128 block or 256 byte slots per step).
  expect(before.blocks.slots / 128).toBeGreaterThanOrEqual(16);
  expect(before.bytes.slots / 256).toBeGreaterThanOrEqual(8);

  // Teardown: every refcount 0, every slot on the free stack, every record free, every owner and raw cell 0.
  const after = check(store, raw, owners);
  expect(clean(after.blocks)).toEqual(ZERO);
  expect(clean(after.bytes)).toEqual(ZERO);
  expect(after.blocks.live + after.bytes.live).toBe(0);
  expect(store.blockPool.freeCount()).toBe(store.blockPool.slotCount());
  expect(store.bytePool.freeCount()).toBe(store.bytePool.slotCount());
  expect(after.claimed).toBe(0);
  expect(raw.blocks.some((v) => v !== 0) || raw.bytes.some((v) => v !== 0)).toBe(false);
  expect(owners.blocks.some((v) => v !== 0) || owners.bytes.some((v) => v !== 0)).toBe(false);
  console.log(`slab fuzz (SLAB_FUZZ_SEED=${SEED}): pools grew to ${before.blocks.slots} block and ${before.bytes.slots} byte slots`);
}, 300_000);

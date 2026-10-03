/**
 * The slab-fuzz worker (SP3a spec §3.6), bundled by `buildNodeTaskWorker(dir, {entry: 'test/harness/fuzzWorker.ts'})`
 * and driven by `test/integration/slabFuzz.test.ts`. Never part of `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', thread, threads, seed, handles, raw, owners}` once (`attachStore`), then
 * `{type: 'run', ops}` per phase and `{type: 'teardown'}` at the end; each is answered with the thread's
 * cumulative `FuzzStats` (`ready`, `phase`, `done`), or `{type: 'error', message}` when anything throws (`StoreFull`
 * included: the limits below keep every pool under half its slots).
 *
 * Bookkeeping, per pool:
 * - `held[slot]`: the references this thread holds (its raw references plus the entries of its records);
 * - `raw[slot]` (shared, Atomics): this thread's raw references, which the main thread adds to the entries it finds
 *   in the column table to get every slot's expected refcount;
 * - `owner[slot]` (shared, Atomics): the thread (index + 1) that holds the slot, 0 when none. A thread claims the
 *   cell by compare-exchange 0 → me when it gets a slot it held no reference to, and clears it before it lets go of
 *   its last reference; a failed claim is a double allocation (the slot came back while another thread, or this
 *   one, still held it).
 * Raw slots carry a stamp (thread, counter) in their first two words, checked before every retain and free.
 *
 * Torus: thread t owns the records whose slot ≡ t (mod 4), i.e. cx ≡ t (mod 4); it uses 12 of them, records
 * (t + 4i, j) for i < 3, j < 4, and claims columns 64 apart on each (cx − 64, cx, cx + 64, each at cz and cz + 64),
 * at most 8 held at once.
 */
import { Xoshiro128 } from '../../src/core/rng';
import { finalAt, protoAt, recordBase, REC_AUX_A, REC_AUX_B, SECTIONS } from '../../src/world/store/columnTable';
import type { SlabPool } from '../../src/world/store/pool';
import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, PROTO_BLOCKS, PROTO_FLUID, SECTION_VOXELS } from '../../src/world/store/section';
import { attachStore, SlotBusy, type ColumnWriter, type StoreHandles, type VoxelStore } from '../../src/world/store/store';

/** Per thread: live raw references per pool, and claimed columns (SP3a spec §3.6). */
export const FUZZ_LIMITS = { rawRefs: 1000, columns: 8 } as const;

/** Every kind of op and section transition the fuzz counts; each must happen on every thread. */
export const FUZZ_COUNTS = [
  'alloc', 'retain', 'free', 'claim', 'busy', 'collide', 'protoSection', 'promote', 'demote', 'protoSet', 'finalSet',
  'finalSection', 'share', 'freeProto', 'freeColumn', 'aux', 'auxB', 'lookup',
] as const;
export type FuzzCount = (typeof FUZZ_COUNTS)[number];

export interface FuzzStats {
  ops: number;
  counts: Record<FuzzCount, number>;
  /** An alloc (raw or inside the store) returned a slot that a reference still held. */
  doubleAllocs: number;
  /** A lookup returned another column's record, or none for a held column. */
  wrongLookups: number;
  /** A claim on a held record did not throw `SlotBusy`. */
  busyFailures: number;
  /** A stamp or a section's contents changed under a reference, or a new aux slot was not zero. */
  dataMismatches: number;
  /** An owner cell held another thread (or nothing) when this thread let go of the slot. */
  ownerMismatches: number;
  maxRaw: { blocks: number; bytes: number };
  maxColumns: number;
}

export type FuzzReply = { type: 'ready' | 'phase' | 'done'; stats: FuzzStats } | { type: 'error'; message: string };

interface Reply {
  msg: FuzzReply;
  transfer: Transferable[];
}

interface AttachMsg {
  type: 'attach';
  thread: number;
  threads: number;
  seed: number;
  handles: StoreHandles;
  raw: { blocks: SharedArrayBuffer; bytes: SharedArrayBuffer };
  owners: { blocks: SharedArrayBuffer; bytes: SharedArrayBuffer };
}

/** Block pool 0, byte pool 1. */
type PoolIx = 0 | 1;

interface Pos {
  at: number;
  pool: PoolIx;
}

interface Col {
  cx: number;
  cz: number;
  base: number;
  w: ColumnWriter;
  /** The last committed status (0 before the first commit) and the number of commits (= blockVersion). */
  status: number;
  commits: number;
  /** Expected block state at voxel 0 of each proto and final section. */
  proto: Int32Array;
  final: Int32Array;
}

const RECORDS_X = 3;
const RECORDS_Z = 4;
/** Columns per record: cx − 64, cx, cx + 64 at cz and at cz + 64. */
const VARIANTS = 6;
const PATTERNS = 8;
/** Dense block sections carry a tag at voxel 0, in [TAG_MIN, 4096): states the 4096-entry PASS table covers. */
const TAG_MIN = 3;

function newStats(): FuzzStats {
  const counts = {} as Record<FuzzCount, number>;
  for (const k of FUZZ_COUNTS) counts[k] = 0;
  return {
    ops: 0, counts, doubleAllocs: 0, wrongLookups: 0, busyFailures: 0, dataMismatches: 0, ownerMismatches: 0,
    maxRaw: { blocks: 0, bytes: 0 }, maxColumns: 0,
  };
}

/** One fuzz thread over an attached store. */
function createFuzzer(m: AttachMsg) {
  const store: VoxelStore = attachStore(m.handles);
  const ints = store.table.ints;
  const me = m.thread + 1;
  const rng = new Xoshiro128((m.seed * 1000 + m.thread) | 0);
  const pools: readonly [SlabPool, SlabPool] = [store.blockPool, store.bytePool];
  const raw = [new Int32Array(m.raw.blocks), new Int32Array(m.raw.bytes)] as const;
  const owner = [new Int32Array(m.owners.blocks), new Int32Array(m.owners.bytes)] as const;
  const held = [new Int32Array(pools[0].maxSlots), new Int32Array(pools[1].maxSlots)] as const;
  const stampOf = [new Int32Array(pools[0].maxSlots), new Int32Array(pools[1].maxSlots)] as const;
  const refs: [number[], number[]] = [[], []];
  const cols: (Col | null)[] = new Array<Col | null>(RECORDS_X * RECORDS_Z).fill(null);
  const st = newStats();
  let stamp = 0;
  let tag = 0;

  // Dense patterns: block states 0-2, light and fluid bytes (random, never uniform).
  const blockPatterns: Uint16Array[] = [];
  const bytePatterns: Uint8Array[] = [];
  for (let k = 0; k < PATTERNS; k++) {
    const b = new Uint16Array(SECTION_VOXELS);
    const y = new Uint8Array(SECTION_VOXELS);
    for (let i = 0; i < SECTION_VOXELS; i++) {
      b[i] = rng.nextInt(3);
      y[i] = rng.nextU32() & 0xff;
    }
    blockPatterns.push(b);
    bytePatterns.push(y);
  }
  const blocks = new Uint16Array(SECTION_VOXELS);
  const light = new Uint8Array(SECTION_VOXELS);
  const fluid = new Uint8Array(SECTION_VOXELS);
  const UNIFORM_FLUID = [0, 0x10, 0x21];
  const UNIFORM_LIGHT = [0, 0xf0, 0x0f];

  /** Fills `blocks` dense (a tagged pattern) or uniform (state 0-2); returns the state at voxel 0. */
  function fillBlocks(dense: boolean): number {
    if (dense) {
      blocks.set(blockPatterns[rng.nextInt(PATTERNS)]!);
      blocks[0] = TAG_MIN + (tag++ % (4096 - TAG_MIN));
    } else {
      blocks.fill(rng.nextInt(3));
    }
    return blocks[0]!;
  }
  function fillBytes(a: Uint8Array, dense: boolean, uniform: readonly number[]): void {
    if (dense) a.set(bytePatterns[rng.nextInt(PATTERNS)]!);
    else a.fill(uniform[rng.nextInt(uniform.length)]!);
  }

  function claimOwner(pool: PoolIx, slot: number): void {
    if (Atomics.compareExchange(owner[pool], slot, 0, me) !== 0) st.doubleAllocs++;
  }
  function dropOwner(pool: PoolIx, slot: number): void {
    if (Atomics.compareExchange(owner[pool], slot, me, 0) !== me) st.ownerMismatches++;
  }

  /**
   * Runs a store op that rewrites the entries at `pos`, keeping `held` and the owner cells right: the slots whose
   * last reference goes are released from their owner cell first; a new dense entry this thread held no reference
   * to is claimed; a new entry it already held is a double allocation unless its position shares (`shares`).
   */
  function tracked(pos: readonly Pos[], op: () => void, shares: readonly number[] = []): void {
    const old = pos.map((p) => ints[p.at]!);
    const going: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
    pos.forEach((p, i) => {
      const c = old[i]!;
      if (c >= 0) going[p.pool].set(c, (going[p.pool].get(c) ?? 0) + 1);
    });
    for (const pool of [0, 1] as const) {
      for (const [slot, k] of going[pool]) if (held[pool][slot] === k) dropOwner(pool, slot);
    }
    op();
    pos.forEach((p, i) => {
      const c = old[i]!;
      if (c >= 0) held[p.pool][c]!--;
    });
    for (const p of pos) {
      const c = ints[p.at]!;
      if (c < 0) continue;
      if (held[p.pool][c] === 0) claimOwner(p.pool, c);
      else if (!shares.includes(p.at)) st.doubleAllocs++;
      held[p.pool][c]!++;
    }
  }

  const protoPos = (base: number, sy: number): Pos[] => {
    const p = protoAt(base, sy);
    return [{ at: p + PROTO_BLOCKS, pool: 0 }, { at: p + PROTO_FLUID, pool: 1 }];
  };
  const finalPos = (base: number, sy: number): Pos[] => {
    const f = finalAt(base, sy);
    return [{ at: f + FINAL_BLOCKS, pool: 0 }, { at: f + FINAL_LIGHT, pool: 1 }, { at: f + FINAL_FLUID, pool: 1 }];
  };
  const allProtoPos = (base: number): Pos[] => {
    const out: Pos[] = [];
    for (let sy = 0; sy < SECTIONS; sy++) out.push(...protoPos(base, sy));
    return out;
  };
  const allPos = (base: number): Pos[] => {
    const out = allProtoPos(base);
    for (let sy = 0; sy < SECTIONS; sy++) out.push(...finalPos(base, sy));
    out.push({ at: base + REC_AUX_A, pool: 1 }, { at: base + REC_AUX_B, pool: 1 });
    return out;
  };

  // ---- raw slots ----

  const wordsPerSlot = (pool: PoolIx) => pools[pool].slotBytes >> 1;
  function checkStamp(pool: PoolIx, slot: number): void {
    const w = pools[pool].words;
    const at = slot * wordsPerSlot(pool);
    if (w[at] !== me || w[at + 1] !== stampOf[pool][slot]) st.dataMismatches++;
  }

  function rawAlloc(pool: PoolIx): void {
    const s = pools[pool].alloc();
    if (held[pool][s] !== 0) st.doubleAllocs++;
    else claimOwner(pool, s);
    held[pool][s]!++;
    Atomics.add(raw[pool], s, 1);
    refs[pool].push(s);
    const at = s * wordsPerSlot(pool);
    stampOf[pool][s] = stamp = (stamp + 1) & 0xffff;
    pools[pool].words[at] = me;
    pools[pool].words[at + 1] = stamp;
    st.counts.alloc++;
  }

  function rawRetain(pool: PoolIx): void {
    const s = refs[pool][rng.nextInt(refs[pool].length)]!;
    checkStamp(pool, s);
    pools[pool].retain(s);
    held[pool][s]!++;
    Atomics.add(raw[pool], s, 1);
    refs[pool].push(s);
    st.counts.retain++;
  }

  function rawFree(pool: PoolIx, i: number): void {
    const list = refs[pool];
    const s = list[i]!;
    list[i] = list[list.length - 1]!;
    list.pop();
    checkStamp(pool, s);
    if (held[pool][s] === 1) dropOwner(pool, s);
    held[pool][s]!--;
    Atomics.sub(raw[pool], s, 1);
    pools[pool].free(s);
    st.counts.free++;
  }

  function rawOp(kind: number): void {
    const pool = rng.nextInt(2) as PoolIx;
    const n = refs[pool].length;
    if (n === 0 || (kind === 0 && n < FUZZ_LIMITS.rawRefs)) rawAlloc(pool);
    else if (kind === 1 && n < FUZZ_LIMITS.rawRefs) rawRetain(pool);
    else rawFree(pool, rng.nextInt(n));
    st.maxRaw.blocks = Math.max(st.maxRaw.blocks, refs[0].length);
    st.maxRaw.bytes = Math.max(st.maxRaw.bytes, refs[1].length);
  }

  // ---- columns ----

  const recordCx = (r: number) => m.thread + m.threads * (r % RECORDS_X);
  const recordCz = (r: number) => Math.floor(r / RECORDS_X);
  const variantCx = (r: number, k: number) => recordCx(r) + 64 * ((k % 3) - 1);
  const variantCz = (r: number, k: number) => recordCz(r) + 64 * Math.floor(k / 3);
  const heldCount = () => cols.reduce((n, c) => n + (c === null ? 0 : 1), 0);

  function expectBusy(cx: number, cz: number): void {
    try {
      store.claimColumn(cx, cz, 0);
      st.busyFailures++;
    } catch (e) {
      if (!(e instanceof SlotBusy)) throw e;
    }
  }

  function freeCol(r: number): void {
    const c = cols[r]!;
    tracked(allPos(c.base), () => store.freeColumn(c.cx, c.cz));
    cols[r] = null;
    if (store.table.find(c.cx, c.cz) !== -1 || store.proto(c.cx, c.cz) !== null) st.wrongLookups++;
    st.counts.freeColumn++;
  }

  function claimOp(): void {
    const r = rng.nextInt(cols.length);
    const k = rng.nextInt(VARIANTS);
    const cx = variantCx(r, k);
    const cz = variantCz(r, k);
    const holder = cols[r];
    if (holder !== null) {
      expectBusy(cx, cz);
      if (holder.cx === cx && holder.cz === cz) {
        st.counts.busy++;
        return;
      }
      st.counts.collide++;
      freeCol(r);
    } else if (heldCount() >= FUZZ_LIMITS.columns) {
      const live = cols.flatMap((c, i) => (c === null ? [] : [i]));
      freeCol(live[rng.nextInt(live.length)]!);
    }
    const w = store.claimColumn(cx, cz, rng.nextInt(1000));
    cols[r] = { cx, cz, base: recordBase(cx, cz), w, status: 0, commits: 0, proto: new Int32Array(SECTIONS), final: new Int32Array(SECTIONS) };
    if (store.table.find(cx, cz) !== recordBase(cx, cz) || store.proto(cx, cz) !== null) st.wrongLookups++;
    st.maxColumns = Math.max(st.maxColumns, heldCount());
    st.counts.claim++;
  }

  function writeProto(c: Col, sy: number): void {
    const p = protoAt(c.base, sy);
    const wasDense = [ints[p + PROTO_BLOCKS]! >= 0, ints[p + PROTO_FLUID]! >= 0];
    const v = fillBlocks(rng.nextInt(2) === 0);
    fillBytes(fluid, rng.nextInt(3) === 0, UNIFORM_FLUID);
    tracked(protoPos(c.base, sy), () => c.w.setProto(sy, blocks, fluid));
    c.proto[sy] = v;
    const isDense = [ints[p + PROTO_BLOCKS]! >= 0, ints[p + PROTO_FLUID]! >= 0];
    for (let ch = 0; ch < 2; ch++) {
      if (!wasDense[ch] && isDense[ch]) st.counts.promote++;
      if (wasDense[ch] && !isDense[ch]) st.counts.demote++;
    }
  }

  function writeFinal(c: Col, sy: number): void {
    fillBytes(light, rng.nextInt(3) === 0, UNIFORM_LIGHT);
    if (rng.nextInt(2) === 0) {
      const f = finalAt(c.base, sy);
      tracked(finalPos(c.base, sy), () => c.w.shareFinal(sy, light), [f + FINAL_BLOCKS, f + FINAL_FLUID]);
      c.final[sy] = c.proto[sy]!;
      if (ints[f + FINAL_BLOCKS]! >= 0 || ints[f + FINAL_FLUID]! >= 0) st.counts.share++;
    } else {
      const v = fillBlocks(rng.nextInt(2) === 0);
      fillBytes(fluid, rng.nextInt(3) === 0, UNIFORM_FLUID);
      tracked(finalPos(c.base, sy), () => c.w.setFinal(sy, blocks, light, fluid));
      c.final[sy] = v;
    }
  }

  function commit(c: Col, status: 1 | 2): void {
    c.w.commit(status);
    c.status = status;
    c.commits++;
  }

  function auxOp(c: Col): void {
    const b = rng.nextInt(2) === 1;
    const at = c.base + (b ? REC_AUX_B : REC_AUX_A);
    if (ints[at]! < 0) {
      tracked([{ at, pool: 1 }], () => (b ? c.w.auxB() : c.w.aux()));
      const slot = pools[1].u8(ints[at]!);
      if (slot.some((v) => v !== 0)) st.dataMismatches++;
    }
    // Dirty the slot, so that a recycled aux slot must be zero-filled again.
    if (b) c.w.auxB().caveBiomeQ.fill(rng.nextInt(255) + 1);
    else c.w.aux().tintTH.fill(rng.nextInt(255) + 1);
    st.counts[b ? 'auxB' : 'aux']++;
  }

  function lookupOp(): void {
    const r = rng.nextInt(cols.length);
    const c = cols[r];
    for (let k = 0; k < VARIANTS; k++) {
      const cx = variantCx(r, k);
      const cz = variantCz(r, k);
      const mine = c !== null && c.cx === cx && c.cz === cz ? c : null;
      if (store.table.find(cx, cz) !== (mine === null ? -1 : mine.base)) st.wrongLookups++;
      const sy = rng.nextInt(SECTIONS);
      const pv = store.proto(cx, cz);
      if (mine === null || mine.status < 1) {
        if (pv !== null) st.wrongLookups++;
      } else if (pv === null || pv.cx !== cx || pv.cz !== cz) {
        st.wrongLookups++;
      } else if (pv.block(0, sy * 16 - 64, 0) !== mine.proto[sy]) {
        st.dataMismatches++;
      }
      const fv = store.final(cx, cz);
      if (mine === null || mine.status < 2) {
        if (fv !== null) st.wrongLookups++;
      } else if (fv === null || fv.cx !== cx || fv.cz !== cz) {
        st.wrongLookups++;
      } else if (fv.block(0, sy * 16 - 64, 0) !== mine.final[sy]) {
        st.dataMismatches++;
      }
      const v = store.neighborhood(cx, cz).versions();
      if (v[8] !== (mine === null || mine.status < 1 ? -1 : mine.commits)) st.wrongLookups++;
    }
    st.counts.lookup++;
  }

  /** A random held column, or null (the op then claims one). */
  function someCol(): Col | null {
    const live = cols.filter((c): c is Col => c !== null);
    return live.length === 0 ? null : live[rng.nextInt(live.length)]!;
  }

  function step(): void {
    const k = rng.nextInt(100);
    if (k < 18) return rawOp(0);
    if (k < 24) return rawOp(1);
    if (k < 40) return rawOp(2);
    if (k < 48) return claimOp();
    if (k >= 83) return lookupOp();
    const c = someCol();
    if (c === null) return claimOp();
    if (k < 60) {
      writeProto(c, rng.nextInt(SECTIONS));
      st.counts.protoSection++;
    } else if (k < 64) {
      for (let sy = 0; sy < SECTIONS; sy++) writeProto(c, sy);
      commit(c, 1);
      st.counts.protoSet++;
    } else if (k < 67) {
      for (let sy = 0; sy < SECTIONS; sy++) writeFinal(c, sy);
      commit(c, 2);
      st.counts.finalSet++;
    } else if (k < 73) {
      writeFinal(c, rng.nextInt(SECTIONS));
      st.counts.finalSection++;
    } else if (k < 76) {
      tracked(allProtoPos(c.base), () => store.freeProto(c.cx, c.cz));
      c.proto.fill(0);
      st.counts.freeProto++;
    } else if (k < 80) {
      freeCol(cols.indexOf(c));
    } else {
      auxOp(c);
    }
  }

  return {
    stats: () => st,
    run(ops: number): void {
      for (let i = 0; i < ops; i++) {
        step();
        st.ops++;
      }
    },
    teardown(): void {
      for (const pool of [0, 1] as const) while (refs[pool].length > 0) rawFree(pool, refs[pool].length - 1);
      for (let r = 0; r < cols.length; r++) if (cols[r] !== null) freeCol(r);
    },
  };
}

/** The worker contract of `buildNodeTaskWorker`: `handle(message)` → `{msg, transfer}`. */
export function createTaskHandler(): { handle(raw: unknown): Reply } {
  let fuzzer: ReturnType<typeof createFuzzer> | null = null;
  const reply = (msg: FuzzReply): Reply => ({ msg, transfer: [] });
  return {
    handle(raw) {
      try {
        const m = raw as { type?: unknown; ops?: unknown };
        if (m.type === 'attach') {
          fuzzer = createFuzzer(raw as AttachMsg);
          return reply({ type: 'ready', stats: fuzzer.stats() });
        }
        if (fuzzer === null) throw new Error(`fuzz: '${String(m.type)}' before 'attach'`);
        if (m.type === 'run') {
          fuzzer.run(Number(m.ops));
          return reply({ type: 'phase', stats: fuzzer.stats() });
        }
        if (m.type === 'teardown') {
          fuzzer.teardown();
          return reply({ type: 'done', stats: fuzzer.stats() });
        }
        throw new Error(`fuzz: unknown message '${String(m.type)}'`);
      } catch (e) {
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}

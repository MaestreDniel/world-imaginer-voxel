/**
 * The column-table race fuzz worker (SP4b spec §2.9), bundled by
 * `buildNodeTaskWorker(dir, {entry: 'test/harness/tableFuzzWorker.ts'})` and driven by
 * `test/integration/columnTableFuzz.test.ts`, as `fuzzWorker.ts` is the slab fuzz's. Never part of
 * `src/workers/protocol.ts`.
 *
 * Messages: `{type: 'attach', thread, seed, handles, shared}` once (`attachStore(handles, thread)`, thread 1 … 4: the
 * main thread keeps reclaim thread 0, spec §2.5), then per phase `{type: 'run', phase, ops}` and `{type: 'settle',
 * phase}` (free everything this thread holds, drain its limbo), and `{type: 'stats'}`; each is answered with the
 * thread's cumulative `TableFuzzStats` (`ready`, `phase`, `settled`, `stats`), or `{type: 'error', message}`.
 *
 * **races** (64 records, torus (x, z) for x, z < 8; each record's columns alias in both axes: (x + 64a, z + 64b) for
 * a, b ∈ {−1, 0, 1}, so a torn read of cx from one claim and cz from another can match a queried column):
 * - every thread claims, writes, frees, abandons and takes over the same 64 records and `find`s against them;
 * - the ownership token `own[slot]` (the fuzz's analogue of the pins): 0 free, the holder's thread after a successful
 *   claim (a compare-exchange from 0: failing it is `twoHolders`), `ABANDONED` once its holder gave its writer up.
 *   Only the token's holder frees a record; it clears the token first (the record stays claimed until its `unclaim`,
 *   so the next claimer finds the token at 0);
 * - a takeover takes an `ABANDONED` token, frees the column, re-claims the same column half the time (the ABA case
 *   only the generation catches), then counts `takeovers[slot]`. The abandoner reads `takeovers[slot]` before it lets
 *   go, makes no call on its writer until the count moved (the handshake: a call racing the free would be the
 *   check-then-act the pins exclude), then expects `WriterStale` (`missedStale`); a call under the token that throws it
 *   is `spuriousStale`;
 * - `staleFinds`, exact: every successful claim logs its column in `hist[rec][(g − 1) / 2]` at its odd generation g
 *   (a compare-exchange from 0: a second log is `twoHolders`). A finder reads g0 before `find` and g3 after; when
 *   `find` returns the base it waits (bounded) for every odd g in [g0, g3] to be logged and counts a stale find when
 *   none holds the queried column. A correct `find` linearises at an odd g1 = g2 inside the window;
 * - `versionsDecreased`: per thread and record, the largest blockVersion, lightVersion and generation seen; any lower
 *   reading counts (versions are monotone over a record's life, spec §2.3).
 *
 * **handoff** (each thread's own 8 records at z = 8): raw slots allocated, stamped and retained on one thread and every
 * reference posted to the others through single-producer rings, which free them; columns claimed, written (proto and
 * shared final sections tagged at voxel 0) and committed on one thread and freed on another (half of them inside a
 * read section, so through the limbo). `slotOwner` (compare-exchange 0 → sender at alloc: failing it is
 * `doubleAllocs`) and `outstanding` (the test-level reference count; below 0, or a pool `free` refusing, is
 * `negativeRefcounts`) track every raw slot.
 *
 * **reclaim** (each thread's own 4 records at z = 16): writers rewrite proto sections (alloc, then retire the old
 * slot), free and re-claim their columns, a quarter of the time inside their own read section; readers enter a read
 * section, stamp a canary into every dense proto slot of another thread's columns (a word of their own per thread),
 * dwell on lookups, then check every canary before `exitRead`: a changed one is `reusedUnderReader`.
 */
import { Xoshiro128 } from '../../src/core/rng';
import { protoAt, recordBase, REC_CLAIMED, REC_CX, REC_CZ, RECORD_COUNT, RECORD_INTS, SECTIONS } from '../../src/world/store/columnTable';
import type { SlabPool } from '../../src/world/store/pool';
import { PROTO_BLOCKS, PROTO_FLUID, SECTION_VOXELS } from '../../src/world/store/section';
import { attachStore, SlotBusy, WriterStale, type ColumnWriter, type StoreHandles, type VoxelStore } from '../../src/world/store/store';

export type TableFuzzPhase = 'races' | 'handoff' | 'reclaim';

/** Every kind of operation the fuzz counts; each must happen on every thread, except `RARE_COUNTS` (once in all). */
export const TABLE_FUZZ_COUNTS = [
  // races
  'claim', 'busy', 'write', 'free', 'abandon', 'takeover', 'sameColumnReclaim', 'staleProbe', 'abaProbe', 'find', 'found',
  // handoff
  'rawSend', 'rawReceive', 'columnSend', 'columnReceive', 'freeInRead',
  // reclaim
  'rewrite', 'columnFree', 'retiredUnderReader', 'readSection', 'canary',
] as const;
export type TableFuzzCount = (typeof TABLE_FUZZ_COUNTS)[number];
/** Outcomes of a race rather than choices of the thread: asserted over all threads. */
export const RARE_COUNTS: readonly TableFuzzCount[] = ['sameColumnReclaim', 'abaProbe'];

export interface TableFuzzStats {
  ops: number;
  counts: Record<TableFuzzCount, number>;
  /** A record claimed while another thread held its token, or two claims logged at one generation. */
  twoHolders: number;
  /** A `find` returned a base while the record never held the queried column inside the find's window. */
  staleFinds: number;
  /** A record's blockVersion, lightVersion or generation read lower than this thread saw before. */
  versionsDecreased: number;
  /** A writer call that started after a completed takeover (or this thread's own free) did not throw `WriterStale`. */
  missedStale: number;
  /** A writer call under its ownership token threw `WriterStale`. */
  spuriousStale: number;
  /** A `find` of a column this thread held under its token returned −1. */
  missedFinds: number;
  /** An alloc returned a slot whose owner cell was still set (a reference still held it). */
  doubleAllocs: number;
  /** A test-level reference count went below 0, a held slot read refcount < 1, or a pool `free` refused. */
  negativeRefcounts: number;
  /** A handed-over slot's stamp or a handed-over column's tagged voxel changed. */
  dataMismatches: number;
  /** A token or slot owner held by another thread than the protocol says, or a free record found busy. */
  ownerMismatches: number;
  /** A canary stamped inside a read section changed before `exitRead`. */
  reusedUnderReader: number;
  /** A bounded wait (a generation's log, a takeover, a drain) ran out. */
  timeouts: number;
  /** This thread's limbo entries after its last settle. */
  limbo: number;
}

export type TableFuzzReply =
  | { type: 'ready' | 'phase' | 'settled' | 'stats'; stats: TableFuzzStats }
  | { type: 'error'; message: string };

/** The shared buffers of the fuzz (all `SharedArrayBuffer`s, Int32), made once by the test's thread. */
export interface TableFuzzShared {
  /** Per torus record (4096): the ownership token (0 free, the holder's thread 1 … 4, `ABANDONED`). */
  readonly own: SharedArrayBuffer;
  /** Per torus record: the packed column its last race claim took (`packColumn`). */
  readonly col: SharedArrayBuffer;
  /** Per torus record: completed takeovers. */
  readonly takeovers: SharedArrayBuffer;
  /** Per race record (64) × `histCap`: the packed column claimed at odd generation 2i + 1, 0 until logged. */
  readonly hist: SharedArrayBuffer;
  readonly histCap: number;
  /** Per pool slot: the thread that allocated a raw handoff slot, 0 once its last reference is gone. */
  readonly slotOwner: { readonly blocks: SharedArrayBuffer; readonly bytes: SharedArrayBuffer };
  /** Per pool slot: the raw handoff references not yet freed. */
  readonly outstanding: { readonly blocks: SharedArrayBuffer; readonly bytes: SharedArrayBuffer };
  /** 16 single-producer rings (sender × receiver): `RING_CTL` ints of heads and tails, then the entries. */
  readonly rings: SharedArrayBuffer;
  /**
   * Int32 [0]: arrivals at the barrier every `ROUND_OPS` operations of a run (so the four threads' runs overlap); [1]: 1
   * once a thread failed, so the others stop at their next barrier (`STOPPED`) instead of waiting for it.
   */
  readonly barrier: SharedArrayBuffer;
}

const THREADS = 4;
const ABANDONED = -1;
const RACE_SIDE = 8;
const RACE_RECORDS = RACE_SIDE * RACE_SIDE;
const VARIANTS = 9;
/** Records a thread holds at once in the races (a claim beyond frees one first). */
const RACE_HELD = 8;
const HANDOFF_Z = 8;
const RECLAIM_Z = 16;
const RECLAIM_RECORDS = 4;
const RING_CAP = 512;
const RING_CTL = 2 * THREADS * THREADS;
const ENTRY_INTS = 3;
const KIND_COLUMN = 2;
/** Dense block sections carry a tag at voxel 0 in [TAG_MIN, 4096): states the PASS table covers. */
const TAG_MIN = 3;
/** A canary's u16 word in a slot: `CANARY_WORD + thread` (each thread its own word, below any slot's 2048 words). */
const CANARY_WORD = 1000;
/** The message of a thread that stopped because another one failed (the test reports the other's error). */
export const STOPPED = 'table fuzz: stopped, another thread failed';
/** Operations between two barriers of a run (every thread runs the same count, so each reaches every barrier). */
const ROUND_OPS = 250;
/** A bounded wait gives up after this long (ms). */
const WAIT_MS = 5000;

/** One int for a column (never 0): the fuzz's coordinates stay within ±1024. */
export function packColumn(cx: number, cz: number): number {
  return 1 + (cx + 1024) * 4096 + (cz + 1024);
}
function unpackColumn(code: number): { cx: number; cz: number } {
  const v = code - 1;
  return { cx: Math.floor(v / 4096) - 1024, cz: (v % 4096) - 1024 };
}

/** The shared buffers for a store; `raceOps` (all threads) bounds the claims of one race record, so the log never fills. */
export function createTableFuzzShared(store: VoxelStore, raceOps: number): TableFuzzShared {
  const sab = (ints: number) => new SharedArrayBuffer(4 * ints);
  const histCap = raceOps + 1;
  return {
    own: sab(RECORD_COUNT),
    col: sab(RECORD_COUNT),
    takeovers: sab(RECORD_COUNT),
    hist: sab(RACE_RECORDS * histCap),
    histCap,
    slotOwner: { blocks: sab(store.blockPool.maxSlots), bytes: sab(store.bytePool.maxSlots) },
    outstanding: { blocks: sab(store.blockPool.maxSlots), bytes: sab(store.bytePool.maxSlots) },
    rings: sab(RING_CTL + THREADS * THREADS * RING_CAP * ENTRY_INTS),
    barrier: sab(2),
  };
}

interface AttachMsg {
  type: 'attach';
  thread: number;
  seed: number;
  handles: StoreHandles;
  shared: TableFuzzShared;
}

interface Held {
  w: ColumnWriter;
  cx: number;
  cz: number;
  /** The writer's last committed status (0 before its first commit). */
  last: number;
}

interface Probe {
  w: ColumnWriter;
  slot: number;
  cx: number;
  cz: number;
  /** `takeovers[slot]` before the writer was given up; −1 when this thread freed the record itself. */
  done0: number;
}

type PoolIx = 0 | 1;

function newStats(): TableFuzzStats {
  const counts = {} as Record<TableFuzzCount, number>;
  for (const k of TABLE_FUZZ_COUNTS) counts[k] = 0;
  return {
    ops: 0, counts, twoHolders: 0, staleFinds: 0, versionsDecreased: 0, missedStale: 0, spuriousStale: 0, missedFinds: 0,
    doubleAllocs: 0, negativeRefcounts: 0, dataMismatches: 0, ownerMismatches: 0, reusedUnderReader: 0, timeouts: 0, limbo: 0,
  };
}

const nap = new Int32Array(new SharedArrayBuffer(4));

/** Spins, then naps in 1 ms steps, until `cond()` holds or `WAIT_MS` passed; returns whether it holds. */
function waitUntil(cond: () => boolean): boolean {
  for (let i = 0; i < 1000; i++) if (cond()) return true;
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if (cond()) return true;
    Atomics.wait(nap, 0, 0, 1);
  }
  return cond();
}

/** One fuzz thread over an attached store. */
function createFuzzer(m: AttachMsg) {
  if (!Number.isInteger(m.thread) || m.thread < 1 || m.thread > THREADS) throw new RangeError(`table fuzz: thread ${m.thread} outside 1 … ${THREADS}`);
  const me = m.thread;
  const ti = me - 1;
  const store: VoxelStore = attachStore(m.handles, me);
  const { table } = store;
  const ints = table.ints;
  const rng = new Xoshiro128((m.seed * 1000 + me) | 0);
  const pools: readonly [SlabPool, SlabPool] = [store.blockPool, store.bytePool];
  const own = new Int32Array(m.shared.own);
  const col = new Int32Array(m.shared.col);
  const takeovers = new Int32Array(m.shared.takeovers);
  const hist = new Int32Array(m.shared.hist);
  const { histCap } = m.shared;
  const slotOwner = [new Int32Array(m.shared.slotOwner.blocks), new Int32Array(m.shared.slotOwner.bytes)] as const;
  const outstanding = [new Int32Array(m.shared.outstanding.blocks), new Int32Array(m.shared.outstanding.bytes)] as const;
  const rings = new Int32Array(m.shared.rings);
  const barrier = new Int32Array(m.shared.barrier);
  const st = newStats();
  let arrivals = 0;
  /** Waits until all four threads arrived here as often as this one (each run's rounds keep the threads in step). */
  function sync(): void {
    const target = THREADS * ++arrivals;
    Atomics.add(barrier, 0, 1);
    const failed = () => Atomics.load(barrier, 1) !== 0;
    if (!waitUntil(() => failed() || Atomics.load(barrier, 0) >= target)) st.timeouts++;
    if (failed()) throw new Error(STOPPED);
  }

  // Section contents: a uniform pair, and dense patterns (block states 0-2 with a tag at voxel 0, random bytes).
  const uniformBlocks = new Uint16Array(SECTION_VOXELS);
  const uniformBytes = new Uint8Array(SECTION_VOXELS);
  const blocks = new Uint16Array(SECTION_VOXELS);
  const bytes = new Uint8Array(SECTION_VOXELS);
  const patternBlocks = new Uint16Array(SECTION_VOXELS);
  for (let i = 0; i < SECTION_VOXELS; i++) {
    patternBlocks[i] = rng.nextInt(3);
    bytes[i] = rng.nextU32() & 0xff;
  }
  bytes[1] = bytes[0]! ^ 1;
  let tagSeq = 0;
  /** `blocks` dense, tagged with a fresh tag at voxel 0; returns the tag. */
  function denseBlocks(): number {
    blocks.set(patternBlocks);
    const tag = TAG_MIN + ((me * 1009 + tagSeq++) % (4096 - TAG_MIN));
    blocks[0] = tag;
    blocks[1] = tag === 4095 ? 4094 : tag + 1;
    return tag;
  }
  const wordsPerSlot = (p: PoolIx) => pools[p].slotBytes >> 1;

  // ---- races ----

  const raceSlot = (r: number) => (r % RACE_SIDE) + 64 * Math.floor(r / RACE_SIDE);
  const raceColumn = (r: number, k: number) => ({
    cx: (r % RACE_SIDE) + 64 * ((k % 3) - 1),
    cz: Math.floor(r / RACE_SIDE) + 64 * (Math.floor(k / 3) - 1),
  });
  const held: (Held | null)[] = new Array<Held | null>(RACE_RECORDS).fill(null);
  const probes: Probe[] = [];
  const seenGen = new Int32Array(RACE_RECORDS);
  const seenBlock = new Int32Array(RACE_RECORDS);
  const seenLight = new Int32Array(RACE_RECORDS);

  /** Records this thread's readings of the record's generation and versions; a lower one than before counts. */
  function observe(r: number, base: number): void {
    const g = table.generation(base);
    const b = table.blockVersion(base);
    const l = table.lightVersion(base);
    if (g < seenGen[r]! || b < seenBlock[r]! || l < seenLight[r]!) st.versionsDecreased++;
    seenGen[r] = Math.max(g, seenGen[r]!);
    seenBlock[r] = Math.max(b, seenBlock[r]!);
    seenLight[r] = Math.max(l, seenLight[r]!);
  }

  const heldCount = () => held.reduce((n, h) => n + (h === null ? 0 : 1), 0);
  function someHeld(): number {
    const live: number[] = [];
    for (let r = 0; r < RACE_RECORDS; r++) if (held[r] !== null) live.push(r);
    return live.length === 0 ? -1 : live[rng.nextInt(live.length)]!;
  }

  /** Claims (cx, cz) on race record `r`: takes the token, logs the generation. False on `SlotBusy`. */
  function claimRace(r: number, cx: number, cz: number): boolean {
    let w: ColumnWriter;
    try {
      w = store.claimColumn(cx, cz, rng.nextInt(1000));
    } catch (e) {
      if (!(e instanceof SlotBusy)) throw e;
      st.counts.busy++;
      return false;
    }
    const slot = raceSlot(r);
    const base = recordBase(cx, cz);
    if (Atomics.compareExchange(own, slot, 0, me) !== 0) st.twoHolders++;
    const code = packColumn(cx, cz);
    const g = table.generation(base);
    if ((g & 1) === 0) {
      st.twoHolders++;
    } else {
      const i = (g - 1) >> 1;
      if (i >= histCap) throw new Error(`table fuzz: record ${r} claimed more than ${histCap} times`);
      if (Atomics.compareExchange(hist, r * histCap + i, 0, code) !== 0) st.twoHolders++;
    }
    Atomics.store(col, slot, code);
    held[r] = { w, cx, cz, last: 0 };
    observe(r, base);
    st.counts.claim++;
    return true;
  }

  /** A write and commit under the token: a proto section (then commit ≥ 1), a shared final (≥ 2) or aux A. */
  function writeRace(r: number): void {
    const h = held[r]!;
    const base = recordBase(h.cx, h.cz);
    observe(r, base);
    try {
      const sy = rng.nextInt(SECTIONS);
      const kind = rng.nextInt(3);
      if (kind === 0) {
        if (rng.nextInt(4) === 0) denseBlocks();
        h.w.setProto(sy, rng.nextInt(4) === 0 ? blocks : uniformBlocks, uniformBytes);
        h.last = Math.max(1, h.last);
        h.w.commit(h.last as 1 | 2);
      } else if (kind === 1) {
        h.w.shareFinal(sy, rng.nextInt(2) === 0 ? bytes : uniformBytes);
        h.last = 2;
        h.w.commit(2);
      } else {
        h.w.aux().tintTH[0] = me;
      }
    } catch (e) {
      if (!(e instanceof WriterStale)) throw e;
      st.spuriousStale++;
      return;
    }
    observe(r, base);
    st.counts.write++;
  }

  /** Frees the held record `r` under its token; the writer becomes a probe that must throw `WriterStale`. */
  function freeRace(r: number): void {
    const h = held[r]!;
    const slot = raceSlot(r);
    if (Atomics.compareExchange(own, slot, me, 0) !== me) st.twoHolders++;
    store.freeColumn(h.cx, h.cz);
    held[r] = null;
    probes.push({ w: h.w, slot, cx: h.cx, cz: h.cz, done0: -1 });
    st.counts.free++;
  }

  /** Gives the held record `r` up for a takeover: the takeover count first, then the token to `ABANDONED`. */
  function abandonRace(r: number): void {
    const h = held[r]!;
    const slot = raceSlot(r);
    const done0 = Atomics.load(takeovers, slot);
    if (Atomics.compareExchange(own, slot, me, ABANDONED) !== me) st.twoHolders++;
    held[r] = null;
    probes.push({ w: h.w, slot, cx: h.cx, cz: h.cz, done0 });
    st.counts.abandon++;
  }

  /** Takes over abandoned race record `r` (false when it is not abandoned): free, maybe re-claim the same column. */
  function takeOver(r: number, reclaim: boolean): boolean {
    const slot = raceSlot(r);
    if (Atomics.load(own, slot) !== ABANDONED || Atomics.compareExchange(own, slot, ABANDONED, me) !== ABANDONED) return false;
    const { cx, cz } = unpackColumn(Atomics.load(col, slot));
    // The token goes back to 0 before the free: the record stays claimed until `unclaim`, and the next claimer takes it from 0.
    Atomics.store(own, slot, 0);
    store.freeColumn(cx, cz);
    if (reclaim && rng.nextInt(2) === 0 && heldCount() < RACE_HELD && claimRace(r, cx, cz)) st.counts.sameColumnReclaim++;
    Atomics.add(takeovers, slot, 1);
    st.counts.takeover++;
    return true;
  }

  function takeoverRace(): void {
    const start = rng.nextInt(RACE_RECORDS);
    for (let i = 0; i < RACE_RECORDS; i++) if (takeOver((start + i) % RACE_RECORDS, true)) return;
  }

  /** A call on a given-up writer whose takeover completed: it must throw `WriterStale`. */
  function callStale(p: Probe): void {
    const base = recordBase(p.cx, p.cz);
    const aba = Atomics.load(ints, base + REC_CLAIMED) === 1 && Atomics.load(ints, base + REC_CX) === p.cx && Atomics.load(ints, base + REC_CZ) === p.cz;
    try {
      const k = rng.nextInt(4);
      if (k === 0) p.w.setProto(rng.nextInt(SECTIONS), uniformBlocks, uniformBytes);
      else if (k === 1) p.w.commit(1);
      else if (k === 2) p.w.aux();
      else p.w.resetLight();
    } catch (e) {
      if (e instanceof WriterStale) {
        st.counts.staleProbe++;
        if (aba) st.counts.abaProbe++;
        return;
      }
      // Any other outcome means the guard let the call through (the call then failed on the record's new state).
    }
    st.missedStale++;
  }

  const takenOver = (p: Probe) => p.done0 < 0 || Atomics.load(takeovers, p.slot) > p.done0;

  function probeRace(): void {
    if (probes.length === 0) return;
    const i = rng.nextInt(probes.length);
    const p = probes[i]!;
    // The handshake: no call on the writer until its takeover completed.
    if (!takenOver(p)) return;
    probes[i] = probes[probes.length - 1]!;
    probes.pop();
    callStale(p);
  }

  function findRace(): void {
    const r = rng.nextInt(RACE_RECORDS);
    const { cx, cz } = raceColumn(r, rng.nextInt(VARIANTS));
    const base = recordBase(cx, cz);
    const g0 = table.generation(base);
    const b = table.find(cx, cz);
    const g3 = table.generation(base);
    if (g3 < g0) st.versionsDecreased++;
    observe(r, base);
    st.counts.find++;
    if (b === -1) {
      const h = held[r];
      if (h !== null && h.cx === cx && h.cz === cz) st.missedFinds++;
      return;
    }
    if (b !== base) {
      st.staleFinds++;
      return;
    }
    st.counts.found++;
    const code = packColumn(cx, cz);
    for (let g = g0 | 1; g <= g3; g += 2) {
      const at = r * histCap + ((g - 1) >> 1);
      if (!waitUntil(() => Atomics.load(hist, at) !== 0)) {
        st.timeouts++;
        return;
      }
      if (Atomics.load(hist, at) === code) return;
    }
    st.staleFinds++;
  }

  function raceStep(): void {
    const k = rng.nextInt(100);
    if (k < 22) {
      const r = rng.nextInt(RACE_RECORDS);
      if (held[r] !== null) return writeRace(r);
      if (heldCount() >= RACE_HELD) freeRace(someHeld());
      const { cx, cz } = raceColumn(r, rng.nextInt(VARIANTS));
      claimRace(r, cx, cz);
      return;
    }
    if (k < 52) {
      if (k >= 40 && k < 46) return takeoverRace();
      if (k >= 46) return probeRace();
      const r = someHeld();
      if (r < 0) return takeoverRace();
      if (k < 30) return writeRace(r);
      if (k < 36) return freeRace(r);
      return abandonRace(r);
    }
    findRace();
  }

  function settleRaces(): void {
    for (let r = 0; r < RACE_RECORDS; r++) if (held[r] !== null) freeRace(r);
    for (let r = 0; r < RACE_RECORDS; r++) takeOver(r, false);
    // Every abandoned record is being taken over by some thread now: wait for each, then probe.
    for (const p of probes) {
      if (!waitUntil(() => takenOver(p))) st.timeouts++;
      else callStale(p);
    }
    probes.length = 0;
  }

  // ---- handoff ----

  const ringOf = (from: number, to: number) => (from - 1) * THREADS + (to - 1);
  /** Posts an entry to thread `to`'s ring from this thread; false when the ring is full. */
  function push(to: number, a: number, b: number, c: number): boolean {
    const ring = ringOf(me, to);
    const head = Atomics.load(rings, 2 * ring);
    const tail = Atomics.load(rings, 2 * ring + 1);
    if (tail - head >= RING_CAP) return false;
    const at = RING_CTL + (ring * RING_CAP + (tail % RING_CAP)) * ENTRY_INTS;
    Atomics.store(rings, at, a);
    Atomics.store(rings, at + 1, b);
    Atomics.store(rings, at + 2, c);
    Atomics.store(rings, 2 * ring + 1, tail + 1);
    return true;
  }
  const entry = new Int32Array(ENTRY_INTS);
  /** Pops the oldest entry from thread `from`'s ring into `entry`; false when it is empty. */
  function pop(from: number): boolean {
    const ring = ringOf(from, me);
    const head = Atomics.load(rings, 2 * ring);
    if (Atomics.load(rings, 2 * ring + 1) === head) return false;
    const at = RING_CTL + (ring * RING_CAP + (head % RING_CAP)) * ENTRY_INTS;
    for (let i = 0; i < ENTRY_INTS; i++) entry[i] = Atomics.load(rings, at + i);
    Atomics.store(rings, 2 * ring, head + 1);
    return true;
  }
  const other = () => {
    const t = 1 + rng.nextInt(THREADS - 1);
    return t >= me ? t + 1 : t;
  };

  let stamp = 0;
  /** A raw slot: allocated, stamped (thread, stamp), retained 0-2 times, every reference posted to another thread. */
  function rawSend(): void {
    const p = rng.nextInt(2) as PoolIx;
    const s = pools[p].alloc();
    if (Atomics.compareExchange(slotOwner[p], s, 0, me) !== 0) st.doubleAllocs++;
    stamp = (stamp % 0xfffe) + 1;
    const at = s * wordsPerSlot(p);
    pools[p].words[at] = me;
    pools[p].words[at + 1] = stamp;
    const refs = 1 + rng.nextInt(3);
    for (let i = 1; i < refs; i++) pools[p].retain(s);
    Atomics.store(outstanding[p], s, refs);
    for (let i = 0; i < refs; i++) if (!push(other(), p, s, (me << 16) | stamp)) releaseRaw(p, s, me, stamp);
    st.counts.rawSend++;
  }

  /** Drops one reference to raw slot `s` (stamp checked while it is still held); the last clears the owner cell first. */
  function releaseRaw(p: PoolIx, s: number, sender: number, stampOf: number): void {
    const at = s * wordsPerSlot(p);
    if (pools[p].words[at] !== sender || pools[p].words[at + 1] !== stampOf) st.dataMismatches++;
    if (pools[p].refcount(s) < 1) st.negativeRefcounts++;
    const left = Atomics.sub(outstanding[p], s, 1) - 1;
    if (left < 0) st.negativeRefcounts++;
    if (left === 0 && Atomics.compareExchange(slotOwner[p], s, sender, 0) !== sender) st.ownerMismatches++;
    try {
      pools[p].free(s);
    } catch (e) {
      if (!(e instanceof Error) || !/refcount/.test(e.message)) throw e;
      st.negativeRefcounts++;
    }
  }

  /** The three distinct sections a handed-over column tags. */
  const tagged = (tag: number) => [tag % SECTIONS, (tag + 7) % SECTIONS, (tag + 13) % SECTIONS];

  /** A column claimed, written (tagged proto sections, then shared into the final set) and committed, then posted. */
  function columnSend(): void {
    const x = RACE_SIDE * ti + rng.nextInt(RACE_SIDE);
    const slot = x + 64 * HANDOFF_Z;
    if (Atomics.load(own, slot) !== 0) {
      receive();
      return;
    }
    if (Atomics.compareExchange(own, slot, 0, me) !== 0) {
      st.ownerMismatches++;
      return;
    }
    const cx = x + 64 * (rng.nextInt(3) - 1);
    const cz = HANDOFF_Z + 64 * (rng.nextInt(3) - 1);
    let w: ColumnWriter;
    try {
      w = store.claimColumn(cx, cz, 0);
    } catch (e) {
      if (!(e instanceof SlotBusy)) throw e;
      // The previous holder released the token only after its free, so the record must be free.
      st.ownerMismatches++;
      Atomics.store(own, slot, 0);
      return;
    }
    const tag = denseBlocks();
    const sys = tagged(tag);
    for (const sy of sys) w.setProto(sy, blocks, rng.nextInt(2) === 0 ? bytes : uniformBytes);
    w.commit(1);
    for (const sy of sys) w.shareFinal(sy, rng.nextInt(2) === 0 ? bytes : uniformBytes);
    w.commit(2);
    const to = other();
    Atomics.store(own, slot, to);
    if (!push(to, KIND_COLUMN, packColumn(cx, cz), tag)) {
      Atomics.store(own, slot, me);
      freeHandoff(cx, cz, slot, tag);
    }
    st.counts.columnSend++;
  }

  /** Checks a handed-over column's tagged voxels, frees it (half the time inside a read section), releases the token. */
  function freeHandoff(cx: number, cz: number, slot: number, tag: number): void {
    if (Atomics.load(own, slot) !== me) st.ownerMismatches++;
    const pv = store.proto(cx, cz);
    const fv = store.final(cx, cz);
    for (const sy of tagged(tag)) {
      if (pv === null || pv.block(0, sy * 16 - 64, 0) !== tag) st.dataMismatches++;
      if (fv === null || fv.block(0, sy * 16 - 64, 0) !== tag) st.dataMismatches++;
    }
    const inRead = rng.nextInt(2) === 0;
    if (inRead) store.enterRead();
    if (rng.nextInt(2) === 0) store.freeProto(cx, cz);
    store.freeColumn(cx, cz);
    if (inRead) {
      store.exitRead();
      st.counts.freeInRead++;
    }
    Atomics.store(own, slot, 0);
  }

  /** Takes one entry from another thread's ring and frees what it carries; false when every ring is empty. */
  function receive(): boolean {
    const start = rng.nextInt(THREADS);
    for (let i = 0; i < THREADS; i++) {
      const from = 1 + ((start + i) % THREADS);
      if (from === me || !pop(from)) continue;
      if (entry[0] === KIND_COLUMN) {
        const { cx, cz } = unpackColumn(entry[1]!);
        freeHandoff(cx, cz, recordBase(cx, cz) / RECORD_INTS, entry[2]!);
        st.counts.columnReceive++;
      } else {
        releaseRaw(entry[0] as PoolIx, entry[1]!, entry[2]! >>> 16, entry[2]! & 0xffff);
        st.counts.rawReceive++;
      }
      return true;
    }
    return false;
  }

  /** Sends (at most 0.75 entries per step on average) stay below receives (up to 2 per receiving step). */
  function handoffStep(): void {
    const k = rng.nextInt(100);
    if (k < 25) rawSend();
    else if (k < 50) columnSend();
    else if (receive()) receive();
  }

  /** Drains this thread's limbo (bounded); returns the entries left. */
  function drainAll(): number {
    if (!waitUntil(() => store.drain() === 0)) st.timeouts++;
    return store.limboCount(me);
  }

  // ---- reclaim ----

  const reclaimX = (t: number, i: number) => RACE_SIDE * (t - 1) + i;
  const mine: (Held | null)[] = new Array<Held | null>(RECLAIM_RECORDS).fill(null);
  /** Per pool slot: the read section that stamped it (so a slot two entries share is stamped once). */
  const stampedIn = [new Int32Array(pools[0].maxSlots), new Int32Array(pools[1].maxSlots)] as const;
  let section = 0;
  let canary = 0;
  const stamps: number[] = [];

  /** Rewrites `n` proto sections of `h` (half dense: an alloc, then the old slot retired). */
  function rewrite(h: Held, n: number): void {
    for (let i = 0; i < n; i++) {
      const sy = n === SECTIONS ? i : rng.nextInt(SECTIONS);
      const dense = rng.nextInt(2) === 0;
      if (dense) denseBlocks();
      h.w.setProto(sy, dense ? blocks : uniformBlocks, rng.nextInt(2) === 0 ? bytes : uniformBytes);
    }
    h.w.commit(1);
    st.counts.rewrite++;
  }

  function writerStep(): void {
    const inRead = rng.nextInt(4) === 0;
    if (inRead) store.enterRead();
    const i = rng.nextInt(RECLAIM_RECORDS);
    const h = mine[i];
    if (h === null) {
      const cx = reclaimX(me, i);
      const cz = RECLAIM_Z + 64 * rng.nextInt(2);
      mine[i] = { w: store.claimColumn(cx, cz, 0), cx, cz, last: 0 };
      rewrite(mine[i]!, SECTIONS);
    } else {
      const k = rng.nextInt(10);
      if (k < 6) rewrite(h, 1 + rng.nextInt(4));
      else if (k < 8) rewrite(h, SECTIONS);
      else {
        store.freeColumn(h.cx, h.cz);
        mine[i] = null;
        st.counts.columnFree++;
      }
    }
    if (store.limboCount(me) > 0) st.counts.retiredUnderReader++;
    if (inRead) store.exitRead();
    store.drain();
  }

  /** Inside a read section: a canary in every dense proto slot of 1-2 other threads' columns, a dwell, the check. */
  function readerStep(): void {
    store.enterRead();
    section++;
    stamps.length = 0;
    const columns = 1 + rng.nextInt(2);
    for (let c = 0; c < columns; c++) {
      const t = other();
      const base = recordBase(reclaimX(t, rng.nextInt(RECLAIM_RECORDS)), RECLAIM_Z);
      for (let sy = 0; sy < SECTIONS; sy++) {
        for (const p of [0, 1] as const) {
          const s = Atomics.load(ints, protoAt(base, sy) + (p === 0 ? PROTO_BLOCKS : PROTO_FLUID));
          if (s < 0 || stampedIn[p][s] === section) continue;
          stampedIn[p][s] = section;
          canary = (canary % 0xfffe) + 1;
          const at = s * wordsPerSlot(p) + CANARY_WORD + me;
          pools[p].words[at] = canary;
          stamps.push(p, at, canary);
        }
      }
    }
    // Dwell: lookups of the other threads' columns while their writers retire and reuse slots.
    const dwell = rng.nextInt(64);
    for (let d = 0; d < dwell; d++) {
      const t = other();
      store.proto(reclaimX(t, rng.nextInt(RECLAIM_RECORDS)), RECLAIM_Z + 64 * rng.nextInt(2));
    }
    for (let i = 0; i < stamps.length; i += 3) {
      if (pools[stamps[i]! as PoolIx].words[stamps[i + 1]!] !== stamps[i + 2]) st.reusedUnderReader++;
      st.counts.canary++;
    }
    st.counts.readSection++;
    store.exitRead();
  }

  function settleReclaim(): void {
    for (let i = 0; i < RECLAIM_RECORDS; i++) {
      const h = mine[i];
      if (h === null) continue;
      store.freeColumn(h.cx, h.cz);
      mine[i] = null;
    }
  }

  return {
    stats: () => st,
    drain: () => store.drain(),
    /** Tells the other threads this one failed. */
    fail: () => Atomics.store(barrier, 1, 1),
    run(phase: TableFuzzPhase, ops: number): void {
      const step = phase === 'races' ? raceStep : phase === 'handoff' ? handoffStep : () => (rng.nextInt(100) < 45 ? writerStep() : readerStep());
      // A barrier every round: a round takes about a millisecond, so without it a thread could finish its run before
      // another starts, and nothing it sends would be received until the settle.
      for (let i = 0; i < ops; i++) {
        if (i % ROUND_OPS === 0) sync();
        step();
        st.ops++;
      }
    },
    settle(phase: TableFuzzPhase): void {
      if (phase === 'races') settleRaces();
      else if (phase === 'handoff') while (receive());
      else settleReclaim();
      st.limbo = drainAll();
    },
  };
}

interface Reply {
  msg: TableFuzzReply;
  transfer: Transferable[];
}

/** The worker contract of `buildNodeTaskWorker`: `handle(message)` → `{msg, transfer}`; `drain` after each reply. */
export function createTaskHandler(): { handle(raw: unknown): Reply; drain(): number } {
  let fuzzer: ReturnType<typeof createFuzzer> | null = null;
  const reply = (msg: TableFuzzReply): Reply => ({ msg, transfer: [] });
  return {
    drain: () => fuzzer?.drain() ?? 0,
    handle(raw) {
      try {
        const m = raw as { type?: unknown; phase?: unknown; ops?: unknown };
        if (m.type === 'attach') {
          fuzzer = createFuzzer(raw as AttachMsg);
          return reply({ type: 'ready', stats: fuzzer.stats() });
        }
        if (fuzzer === null) throw new Error(`table fuzz: '${String(m.type)}' before 'attach'`);
        const phase = m.phase as TableFuzzPhase;
        if (m.type === 'run') {
          fuzzer.run(phase, Number(m.ops));
          return reply({ type: 'phase', stats: fuzzer.stats() });
        }
        if (m.type === 'settle') {
          fuzzer.settle(phase);
          return reply({ type: 'settled', stats: fuzzer.stats() });
        }
        if (m.type === 'stats') return reply({ type: 'stats', stats: fuzzer.stats() });
        throw new Error(`table fuzz: unknown message '${String(m.type)}'`);
      } catch (e) {
        fuzzer?.fail();
        return reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e) });
      }
    },
  };
}

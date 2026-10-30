/**
 * The sim worker's message handler (SP5a spec §2.1, D17), as `taskHandler.ts` is the pool worker's: no DOM and no worker
 * globals, so Node tests drive it directly and `sim.worker.ts` wires it to the worker's port. It owns the session's
 * DiffStore (§2.4) and the edit scratch, and answers each message in the order it comes:
 * - `attach`: attaches the page's shared store as thread 15 (`SIM_THREAD`), once; a repeat with the same store id and
 *   thread is answered `attached` again, anything else is BAD_MESSAGE (as the pool's workers, SP4b spec §2.8);
 * - `edits`: `applyEdits` over the attached store (NOT_ATTACHED before the attach), clocked by `performance.now`,
 *   answered `edited` with its arrays transferred; a refusal (`StoreFull` included, as `'full'`) is a result, not an error;
 * - `diff`: the DiffStore's entries of the column (`readDiff`), transferred; zero-length arrays when it holds none.
 * A message the guard refuses is BAD_MESSAGE, with nothing written. Any throw out of the pipeline is an `error` reply
 * carrying the message's id: STORE_CORRUPT for `StoreCorrupt` (a pool lock held by a failed thread), INTERNAL otherwise;
 * the page treats either as the sim's failure (§2.1). Any `error` reply latches the handler: the page has then released
 * every sim pin and marked thread 15 dead, so each later `edits` (one already queued before the page terminated the
 * worker) is answered INTERNAL with nothing written; `attach` and `diff` answer as before, since neither writes the
 * store. `applyEdits` runs inside its own read section, and the writes it retires wait in this thread's limbo, which
 * `drain` frees; the shell drains after each reply and every `SIM_DRAIN_MS` while entries are left.
 *
 * SP5b (spec §3.3, D18, D19, D22): the handler answers through `post` (`handle(m, post)`), so a reply can wait for a
 * transaction. `attach`, `edits` and `diff` post at once, as above. `load` opens the world's KV (`o.openKV(db)`), reads
 * every `diffs` record of the world in one key-range read, decodes each (a record that fails is skipped and counted),
 * drops its fluid ticks (D21), remaps it to today's ids when the stored table is not today's or a prefix of it (an
 * unknown state → air, counted), and, with `rewrite`, writes in one transaction `worlds` and, for such a table, every
 * column re-encoded under today's ids (each keeping its header genKey), the history, and the deletes of the skipped
 * records (still under the old table's ids); only then does it fill the DiffStore (`setColumn`, nothing dirty) and post
 * `loaded`. A KV open or read failure, or a rewrite write that does not complete (ruling P3), is an INTERNAL `error`,
 * with nothing in the DiffStore. From a `load`'s arrival until it settles every later message waits, in arrival order;
 * a second `load` is BAD_MESSAGE. The load's `flushSeq`, genKey (a `Hash64`) and `updated` are kept for the flush.
 */
import { colKeyCx, colKeyCz } from '../core/coords';
import { parseHex64, type Hash64 } from '../core/hash';
import { decodeColumnDiff, encodeColumnDiff, type DecodedColumn } from '../persist/diffCodec';
import { worldRange, type KV, type WriteOp } from '../persist/kv';
import { createMemoryKV, type MemoryKV } from '../persist/memory';
import { remapDiff, remapOf, tableRelation } from '../persist/saves';
import { createDiffStore, type DiffStore } from '../sim/diffStore';
import { applyEdits, createEditScratch, readDiff, type EditScratch } from '../sim/edits';
import type { ColumnDiff } from '../world/store/api';
import { R_STORE_ID, SIM_THREAD } from '../world/store/reclaim';
import { attachStore, StoreCorrupt, type VoxelStore } from '../world/store/store';
import { parseToSim, type ErrorCode, type FromSim, type LoadMsg, type ToSim } from './protocol';

/** The sim's limbo retry interval while entries are left (§2.1: it has no reply loop like the pool's). */
export const SIM_DRAIN_MS = 100;

export interface SimReply {
  readonly msg: FromSim;
  readonly transfer: ArrayBuffer[];
}

export interface SimHandler {
  /** Handles `m`; its reply goes to `post`, at once or, for `load` and the messages after it, when the load settles. */
  handle(m: unknown, post: (r: SimReply) => void): void;
  /** Frees this thread's limbo entries no live reader can hold (`store.drain()`); the entries left, 0 without a store. */
  drain(): number;
}

const err = (jobId: number | null, code: ErrorCode, message: string): SimReply => ({ msg: { type: 'error', jobId, epoch: null, code, message }, transfer: [] });
/** The message's integer id, or null (for the replies to malformed messages). */
const idOf = (raw: unknown): number | null => {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : undefined;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};
const now = (): number => performance.now();

/** The sim's storage: `sim.worker.ts` opens IndexedDB (`openIdbKV`), tests a `MemoryKV`. */
export interface SimHandlerOptions {
  openKV(db: string): Promise<KV>;
}

/** The open world's save state, kept from its `load` for the flush (Task 9) and the backup's copy (Task 25). */
interface OpenWorld {
  readonly kv: KV;
  readonly worldId: string;
  /** The last committed flush's. */
  flushSeq: number;
  /** The header genKey of the columns the sim writes (a later `record` replaces it). */
  genKey: Hash64;
  /** The stored state's `updated`, the original's last flush for a copy. */
  updated: number;
}

/** A record decoded and remapped, waiting for the rewrite's write before it reaches the DiffStore. */
interface LoadedColumn {
  readonly key: number;
  readonly diff: ColumnDiff;
  readonly genKey: Hash64;
}

/**
 * Runs a `load` (see the module comment): resolves its `loaded` reply once the read and the rewrite's write settled and
 * the DiffStore holds the world's entries; rejects (an INTERNAL `error`) on a KV failure, with the DiffStore untouched.
 */
async function runLoad(m: LoadMsg, o: SimHandlerOptions, diffs: DiffStore): Promise<{ reply: SimReply; world: OpenWorld }> {
  const kv = await o.openKV(m.db);
  const [all] = await kv.read([{ op: 'getAll', store: 'diffs', range: worldRange(m.worldId) }]);
  const { keys, values } = all as { keys: ReadonlyArray<readonly [string, number]>; values: readonly unknown[] };
  const t0 = now();
  const relation = tableRelation(m.stateTable);
  const to = relation === 'other' ? remapOf(m.stateTable).to : null;
  const cols: LoadedColumn[] = [];
  const skipped: number[] = [];
  let unknownStates = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]![1];
    const bytes = values[i];
    let decoded: DecodedColumn;
    try {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('not bytes');
      decoded = decodeColumnDiff(bytes, m.stateTable.length);
    } catch {
      skipped.push(key);
      continue;
    }
    // The ticks are dropped: the DiffStore has no place for them (D21).
    let diff = decoded.diff;
    if (to !== null) {
      const r = remapDiff(diff, to);
      diff = r.diff;
      unknownStates += r.unknown;
    }
    cols.push({ key, diff, genKey: decoded.genKey });
  }
  let decodeMs = now() - t0;
  if (m.rewrite !== null) {
    const ops: WriteOp[] = [{ op: 'put', store: 'worlds', key: m.rewrite.world.id, value: m.rewrite.world }];
    if (relation === 'other') {
      for (const c of cols) ops.push({ op: 'put', store: 'diffs', key: [m.worldId, c.key], value: encodeColumnDiff(c.diff, c.genKey) });
      if (m.rewrite.history !== null) ops.push({ op: 'put', store: 'history', key: m.worldId, value: m.rewrite.history });
      // Still under the old table's ids, they would decode against the wrong table at the next open (D22).
      for (const key of skipped) ops.push({ op: 'delete', store: 'diffs', key: [m.worldId, key] });
    }
    const w = await kv.write(ops);
    if (w.status !== 'complete') throw new Error(`the stateTable rewrite did not commit: ${w.status} (${w.errorName ?? 'no error name'})`);
  }
  const t1 = now();
  let entries = 0;
  for (const c of cols) {
    diffs.setColumn(colKeyCx(c.key), colKeyCz(c.key), c.diff);
    entries += c.diff.value.length;
  }
  decodeMs += now() - t1;
  const entryCols = Float64Array.from(diffs.columns());
  const msg: FromSim = { type: 'loaded', id: m.id, entryCols, entries, unknownStates, skippedColumns: skipped.length, decodeMs };
  return {
    reply: { msg, transfer: [entryCols.buffer] },
    world: { kv, worldId: m.worldId, flushSeq: m.flushSeq, genKey: parseHex64(m.genKey), updated: m.updated },
  };
}

export function createSimHandler(o: SimHandlerOptions): SimHandler {
  let store: VoxelStore | null = null;
  const diffs = createDiffStore();
  /** The relight rings and the 3 × 3 cache (≈ 9 MB), allocated on the first batch. */
  let scratch: EditScratch | null = null;
  /** The first `error` reply's code and message, once one was sent: later batches write nothing. */
  let failed: string | null = null;
  /** A `load` arrived (a second one is BAD_MESSAGE). */
  let loadSeen = false;
  /** A `load` is in flight: every message arriving meanwhile waits in `waiting`, in arrival order. */
  let loading = false;
  const waiting: Array<{ readonly raw: unknown; readonly post: (r: SimReply) => void }> = [];
  /** The open world, once its `load` settled (read by the flush, Task 9, and the backup, Task 25). */
  let world: OpenWorld | null = null;
  /** Posts `r`, latching the handler on its first `error` reply. */
  const send = (r: SimReply, post: (r: SimReply) => void): void => {
    if (r.msg.type === 'error' && failed === null) failed = `${r.msg.code}: ${r.msg.message}`;
    post(r);
  };
  const run = (raw: unknown, post: (r: SimReply) => void): void => {
    const m = parseToSim(raw);
    if (m === null || m.type !== 'load') {
      send(reply(raw, m), post);
      return;
    }
    if (loadSeen) {
      send(err(m.id, 'BAD_MESSAGE', 'the world is already loaded'), post);
      return;
    }
    loadSeen = true;
    loading = true;
    runLoad(m, o, diffs).then(
      (r) => {
        world = r.world;
        return r.reply;
      },
      (e: unknown) => err(m.id, 'INTERNAL', e instanceof Error ? e.message : String(e)),
    ).then((r) => {
      loading = false;
      send(r, post);
      while (!loading && waiting.length > 0) {
        const next = waiting.shift()!;
        run(next.raw, next.post);
      }
    });
  };
  /** The reply to `raw`, `m` its guard's reading. */
  const reply = (raw: unknown, m: ToSim | null): SimReply => {
    const id = idOf(raw);
    if (m === null) return err(id, 'BAD_MESSAGE', 'malformed message');
    try {
      switch (m.type) {
        case 'attach': {
          if (store !== null) {
            // A posted SharedArrayBuffer arrives as a new object, so the store id decides (SP4b spec §2.8).
            const same = Atomics.load(new Int32Array(m.handles.reclaim), R_STORE_ID) === store.storeId;
            return same ? { msg: { type: 'attached' }, transfer: [] } : err(null, 'BAD_MESSAGE', 'the store is already attached');
          }
          store = attachStore(m.handles, SIM_THREAD);
          return { msg: { type: 'attached' }, transfer: [] };
        }
        case 'edits': {
          if (failed !== null) return err(m.id, 'INTERNAL', `the sim failed earlier (${failed}): nothing written`);
          if (store === null) return err(m.id, 'NOT_ATTACHED', 'no attach yet');
          const r = applyEdits(store, diffs, scratch ??= createEditScratch(), m.edits, now);
          const msg: FromSim = {
            type: 'edited', id: m.id, prev: r.prev, next: r.next, dirty: r.dirty, entryAdded: r.entryAdded, entryRemoved: r.entryRemoved,
            refused: r.refused, relightMs: r.relightMs, editMs: r.editMs,
          };
          return { msg, transfer: [r.prev.buffer, r.next.buffer, r.dirty.buffer, r.entryAdded.buffer, r.entryRemoved.buffer] as ArrayBuffer[] };
        }
        case 'diff': {
          const d = readDiff(diffs, m.cx, m.cz);
          if (d === null) {
            return { msg: { type: 'diff', id: m.id, cx: m.cx, cz: m.cz, sy: new Uint8Array(0), idx: new Uint16Array(0), value: new Uint32Array(0) }, transfer: [] };
          }
          return { msg: { type: 'diff', id: m.id, cx: m.cx, cz: m.cz, sy: d.sy, idx: d.idx, value: d.value }, transfer: [d.sy.buffer, d.idx.buffer, d.value.buffer] as ArrayBuffer[] };
        }
        case 'load':
          // `run` handles every `load`; one never reaches here.
          return err(m.id, 'BAD_MESSAGE', 'a load out of order');
        default: {
          const never: never = m;
          return err(id, 'BAD_MESSAGE', `no handler for ${(never as { type: string }).type}`);
        }
      }
    } catch (e) {
      // SP4b spec §2.6: a pool lock held by a failed thread is fatal, never retried.
      return err(id, e instanceof StoreCorrupt ? 'STORE_CORRUPT' : 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  };
  return {
    handle(raw, post) {
      if (loading) waiting.push({ raw, post });
      else run(raw, post);
    },
    drain: () => (store === null ? 0 : store.drain()),
  };
}

/** One `MemoryKV` per database name, for every handler of this module (a renewed handler finds its world again). */
const memoryKVs = new Map<string, MemoryKV>();

/**
 * The sim handler over in-memory storage, for Node (SP5b spec §6.3): the integration test's worker and the in-process
 * metrics run it, so no IndexedDB is needed; each database name has one `MemoryKV` for the module's life.
 */
export function createMemorySimHandler(): SimHandler {
  return createSimHandler({
    openKV: async (db) => {
      let kv = memoryKVs.get(db);
      if (kv === undefined) memoryKVs.set(db, (kv = createMemoryKV()));
      return kv;
    },
  });
}

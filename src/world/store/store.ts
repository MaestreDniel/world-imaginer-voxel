/**
 * The voxel store (SP3a spec §3, master §2.3): a block pool and a byte pool (`pool.ts`), the 64 × 64 column torus
 * (`columnTable.ts`), section descriptors (`section.ts`), aux slots (`aux.ts`) and the epoch cells (`epochs.ts`).
 * `createStore({shared})` builds it over growable `SharedArrayBuffer`s (several threads, through `handles()` and
 * `attachStore`) or over resizable `ArrayBuffer`s (one thread), with the same code.
 *
 * Column lifecycle: `claimColumn` takes the record and returns a `ColumnWriter`; `commit` publishes it (status last);
 * `reopenColumn` returns a writer for a committed column, for the next stage (SP4a: D at Proto, L at Decorated);
 * `proto`/`final` read it once its status allows (`proto` also needs the alive bit, which a claim writer's commit
 * sets and `freeProto` clears, SP4b spec §2.4); `freeProto` releases the proto set; `reopenProto` returns a
 * `ProtoWriter` that rewrites a freed proto of a Decorated or Published column (`T(protoOnly)`, SP4b spec §2.4, §3.7);
 * `freeColumn` releases every reference the record holds and frees the record. A writer captures the record's claim
 * generation and throws `WriterStale` once the record was freed or claimed again (SP4b spec §2.2).
 *
 * The main thread's per-frame reads take no view (SP4b spec §2.4, §3.10): `lightAt` and `heightAt` read a Published
 * column directly, `versionsInto` fills the coordinator's scratch, and `holder` tells which column holds a record.
 * A lookup validates the record's generation from before its `find` to after its status read, and a writer opened on
 * it captures that generation, so a free and a same-column re-claim inside the lookup is never taken as current.
 *
 * Deferred reclamation (SP4b spec §2.5, `reclaim.ts`): each attached store is one thread's (`attachStore(h, thread)`;
 * `createStore` is thread 0, the main thread), and every slot it releases goes through that thread's `retire`, so a
 * slot a reader may hold is freed only once the reader has left its read section (`enterRead`/`exitRead`, `drain`).
 * A shared store's pools lock as that thread (`thread + 1` in the lock word), and a thread spinning on a lock held by
 * a thread marked dead (`markDead`) throws `StoreCorrupt` (SP4b spec §2.6).
 * `gen` imports only the types of `api.ts`, never this file.
 */
import { PASS } from '../blocks/index';
import type {
  AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, HeightmapKind, NeighborhoodReader, ProtoWriter,
} from './api';
import { allocAux, AUX_A_OFFSETS, AUX_BYTES, auxBView, auxView, createScratchAux } from './aux';
import {
  attachColumnTable, createColumnTable, finalAt, PROTO_ALIVE, protoAt, recordBase, REC_AUX_A, REC_AUX_B, REC_CLAIMED,
  REC_CX, REC_CZ, REC_GEN, REC_PROTO_FLAGS, SECTIONS, STATUS_ABSENT, STATUS_DECORATED, STATUS_PROTO, STATUS_PUBLISHED,
  WriterStale, type ColumnTable,
} from './columnTable';
import { attachEpochCells, createEpochCells, type EpochCells } from './epochs';
import {
  assertBufferKind, attachPool, BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES,
  type PoolHandles, type SlabPool,
} from './pool';
import { attachReclaimer, createReclaimBuffer, MAIN_THREAD } from './reclaim';
import {
  byteAt, computeMeta, FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, FINAL_META, isDense, PROTO_BLOCKS, PROTO_FLUID, releaseEntry,
  sectionBytes, sectionWords, SECTION_VOXELS, shareEntry, storeBytes, storeWords, wordAt,
} from './section';

export { SlotBusy, WriterStale } from './columnTable';
export { StoreCorrupt, StoreFull } from './pool';
export type {
  AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, HeightmapKind, NeighborhoodReader, ProtoWriter, TerrainWriter,
} from './api';

/** Entries of a per-state table (the registry's `MAX_STATES`). */
export const STATE_TABLE_SIZE = 4096;

/**
 * The `PASS` table the store uses for meta when none is given: the block registry's own (`world/blocks`), so states
 * appended later (SP3b's terrain palette) get their pass bits without a store change. Never written.
 */
export const DEFAULT_PASS: Uint8Array = PASS;

export interface StoreOptions {
  readonly shared: boolean;
  /** Maximum size of the block pool (default 768 MiB; a multiple of 1 MiB). */
  readonly maxBlockBytes?: number;
  /** Maximum size of the byte pool (default 512 MiB; a multiple of 1 MiB). */
  readonly maxByteBytes?: number;
  /** The per-state `PASS` table for the meta word (4096 entries; default `DEFAULT_PASS`). Copied. */
  readonly pass?: Uint8Array;
}

/** Everything `attachStore` needs to rebuild the store in another thread (structured-cloneable). */
export interface StoreHandles {
  readonly shared: boolean;
  readonly blocks: PoolHandles;
  readonly bytes: PoolHandles;
  readonly table: SharedArrayBuffer | ArrayBuffer;
  readonly epochs: SharedArrayBuffer | ArrayBuffer;
  /** The reclaim buffer (SP4b spec §2.5, `reclaim.ts`): reader epochs, limbo counts, the dead-owner mask, the store id. */
  readonly reclaim: SharedArrayBuffer | ArrayBuffer;
  readonly pass: Uint8Array;
}

export interface VoxelStore {
  readonly shared: boolean;
  readonly blockPool: SlabPool;
  readonly bytePool: SlabPool;
  readonly table: ColumnTable;
  readonly epochs: EpochCells;
  /** The thread this store was attached as (0 the main thread, workers 1 … N, SP5's sim worker 15; SP4b spec §2.5). */
  readonly thread: number;
  /** The id `createStore` stamped in the reclaim buffer (SP4b spec §2.8). */
  readonly storeId: number;
  handles(): StoreHandles;
  /** Enters a read section: no slot this thread may read from now on is freed until `exitRead` (SP4b spec §2.5). */
  enterRead(): void;
  /** Leaves the read section, then drains this thread's limbo. */
  exitRead(): void;
  /** Frees this thread's limbo entries no live reader can hold; returns the entries left. */
  drain(): number;
  /** The entries in thread `thread`'s limbo (the reclaim buffer's [32 + thread]). */
  limboCount(thread: number): number;
  /** Marks a failed thread: its bit in the dead-owner mask, then its reader epoch cleared (SP4b spec §2.6). */
  markDead(thread: number): void;
  /** Takes the record of (cx, cz) (`SlotBusy` if held) and returns its writer. */
  claimColumn(cx: number, cz: number, epoch: number): ColumnWriter;
  /**
   * A writer for the committed column (cx, cz) (SP4a spec §2.5): D reopens at Proto (1), L at Decorated (2).
   * Throws `reopenColumn: (cx, cz) is not at status <from>` unless the record holds (cx, cz) at status `from`. It
   * clears nothing, and its `aux()`/`auxB()` return the record's existing slots, allocating only when there are none.
   */
  reopenColumn(cx: number, cz: number, from: 1 | 2): ColumnWriter;
  /** Releases every reference the record holds and frees it; nothing unless the record holds (cx, cz). */
  freeColumn(cx: number, cz: number): void;
  /**
   * Releases the proto entries only (resets them to −1), then clears the alive bit (SP4b spec §2.4); nothing unless
   * the record holds (cx, cz).
   */
  freeProto(cx: number, cz: number): void;
  /** The proto set, or null unless the record holds (cx, cz) at status ≥ Proto with the alive bit set. */
  proto(cx: number, cz: number): ColumnView | null;
  /** The final set, or null unless the record holds (cx, cz) at status ≥ Decorated. */
  final(cx: number, cz: number): ColumnView | null;
  neighborhood(cx: number, cz: number): NeighborhoodReader;
  /**
   * `T(protoOnly)`'s writer (SP4b spec §2.4, §3.7). Throws `reopenProto: (cx, cz) is not at status ≥ 2 with a freed
   * proto` unless the record holds (cx, cz) at status ≥ Decorated with the alive bit clear. It never touches the
   * record's aux slots: its `aux()`/`auxB()` are worker-local scratch.
   */
  reopenProto(cx: number, cz: number): ProtoWriter;
  /**
   * `neighborhood(cx, cz).versionsInto(out)` without the reader object (the coordinator's `StreamStore`, SP4b spec
   * §2.3, §3.10): the 18 versions of the 3 × 3 into `out[0 … 17]`, −1 for an absent column; allocation-free.
   */
  versionsInto(cx: number, cz: number, out: Int32Array): void;
  /**
   * The raw light byte at block (bx, by, bz) (integers; `by` in −64 … 319, else `RangeError`) of a Published column,
   * −1 when the column is not Published (SP4b spec §2.4: the eye's sky light, no view).
   */
  lightAt(bx: number, by: number, bz: number): number;
  /**
   * The aux A heightmap `kind` at block column (bx, bz) of a Published column (y + 1 of the highest qualifying voxel,
   * −64 … 320); null when the column is not Published or has no aux A (SP4b spec §2.4: a height can be −1, so no
   * sentinel). An unknown `kind` throws `RangeError`.
   */
  heightAt(kind: HeightmapKind, bx: number, bz: number): number | null;
  /**
   * Who holds the record (cx, cz) maps to (SP4b spec §2.4, §3.5): `'free'`, `'self'` (claimed by (cx, cz), committed
   * or not) or `'other'` (held by another column, or by a claim or free in progress).
   */
  holder(cx: number, cz: number): 'free' | 'self' | 'other';
}

/** The Int16 index of heightmap `kind` in an aux A slot (its byte offset / 2), or −1 for an unknown kind. */
function heightmapWords(kind: HeightmapKind): number {
  switch (kind) {
    case 'worldSurfaceWG': return AUX_A_OFFSETS.worldSurfaceWG >> 1;
    case 'oceanFloorWG': return AUX_A_OFFSETS.oceanFloorWG >> 1;
    case 'worldSurface': return AUX_A_OFFSETS.worldSurface >> 1;
    case 'motionBlocking': return AUX_A_OFFSETS.motionBlocking >> 1;
    case 'oceanFloor': return AUX_A_OFFSETS.oceanFloor >> 1;
    case 'lightBlocking': return AUX_A_OFFSETS.lightBlocking >> 1;
    default: return -1;
  }
}

function checkSy(sy: number): void {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`store: section ${sy} outside 0 … ${SECTIONS - 1}`);
}

function checkLength(a: Uint16Array | Uint8Array, what: string): void {
  if (a.length !== SECTION_VOXELS) throw new RangeError(`store: ${what} has ${a.length} entries, expected ${SECTION_VOXELS}`);
}

/** The arguments of a `setProto`: a section index and two 4096-entry channels. */
function checkProto(sy: number, blocks: Uint16Array, fluid: Uint8Array): void {
  checkSy(sy);
  checkLength(blocks, 'blocks');
  checkLength(fluid, 'fluid');
}

/** Voxel index in its section of (lx, y, lz), y absolute; the section is `index >> 12`. */
function voxelOf(lx: number, y: number, lz: number): number {
  const yy = y + 64;
  if ((lx & 15) !== lx || (lz & 15) !== lz || (yy | 0) !== yy || yy < 0 || yy >= 16 * SECTIONS) {
    throw new RangeError(`store: voxel (${lx}, ${y}, ${lz}) outside the column`);
  }
  return (yy << 8) | (lz << 4) | lx;
}

/**
 * The next store id (SP4b spec §2.5, §2.8): a per-thread counter from 1, since `world/` uses no `Math.random`. A store
 * is created on one thread and attached only to that thread's workers, so the ids of one thread are enough.
 */
let nextStoreId = 1;

export function createStore(opts: StoreOptions): VoxelStore {
  const { shared } = opts;
  const pass = opts.pass ?? DEFAULT_PASS;
  if (pass.length !== STATE_TABLE_SIZE) throw new RangeError(`store: pass table of ${pass.length} entries, expected ${STATE_TABLE_SIZE}`);
  const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES });
  const bytes = createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: opts.maxByteBytes ?? DEFAULT_MAX_BYTE_BYTES });
  const storeId = nextStoreId;
  nextStoreId = nextStoreId === 0x7fffffff ? 1 : nextStoreId + 1;
  return attachStore({
    shared,
    blocks: blocks.handles(),
    bytes: bytes.handles(),
    table: createColumnTable(shared).buffer,
    epochs: createEpochCells(shared).buffer,
    reclaim: createReclaimBuffer(shared, storeId),
    pass: pass.slice(),
  }, MAIN_THREAD);
}

/**
 * The store over existing handles (`store.handles()`, possibly from another thread), as thread `thread` (0 … 15; SP4b
 * spec §2.5). Throws `TypeError` when a buffer is not of the kind `h.shared` names (SharedArrayBuffer or ArrayBuffer;
 * `pass` is a private copy and exempt) or a pool's `shared` differs from the store's (SP4a spec §2.5), `RangeError`
 * for a thread outside 0 … 15 or a reclaim buffer of another size.
 */
export function attachStore(h: StoreHandles, thread = MAIN_THREAD): VoxelStore {
  for (const [what, p] of [['blocks', h.blocks], ['bytes', h.bytes]] as const) {
    if (p.shared !== h.shared) throw new TypeError(`store: the ${what} pool has shared ${String(p.shared)}, the store ${String(h.shared)}`);
  }
  assertBufferKind(h.table, h.shared, 'store: table');
  assertBufferKind(h.epochs, h.shared, 'store: epochs');
  // A shared store's pools lock as this thread and check the dead-owner mask (SP4b spec §2.6); an unshared one has a
  // single thread, so no owner.
  const owner = h.shared ? { thread, dead: new Int32Array(h.reclaim) } : undefined;
  const blockPool = attachPool(h.blocks, owner);
  const bytePool = attachPool(h.bytes, owner);
  const table = attachColumnTable(h.table);
  const epochs = attachEpochCells(h.epochs);
  const reclaimer = attachReclaimer(h.reclaim, thread, [blockPool, bytePool], h.shared);
  const { retire } = reclaimer;
  const { pass } = h;
  const ints = table.ints;

  /** The proto (`final` false) or final view of the record at `base`, holding (cx, cz). */
  function view(base: number, cx: number, cz: number, final: boolean): ColumnView {
    const blocksAt = (sy: number) => (final ? finalAt(base, sy) + FINAL_BLOCKS : protoAt(base, sy) + PROTO_BLOCKS);
    const fluidAt = (sy: number) => (final ? finalAt(base, sy) + FINAL_FLUID : protoAt(base, sy) + PROTO_FLUID);
    return {
      cx,
      cz,
      block(lx, y, lz) {
        const v = voxelOf(lx, y, lz);
        return wordAt(blockPool, ints[blocksAt(v >> 12)]!, v & 4095);
      },
      fluid(lx, y, lz) {
        const v = voxelOf(lx, y, lz);
        return byteAt(bytePool, ints[fluidAt(v >> 12)]!, v & 4095);
      },
      light(lx, y, lz) {
        const v = voxelOf(lx, y, lz);
        return final ? byteAt(bytePool, ints[finalAt(base, v >> 12) + FINAL_LIGHT]!, v & 4095) : 0;
      },
      sectionBlocks(sy) {
        checkSy(sy);
        return sectionWords(blockPool, ints[blocksAt(sy)]!);
      },
      sectionFluid(sy) {
        checkSy(sy);
        return sectionBytes(bytePool, ints[fluidAt(sy)]!);
      },
      sectionLight(sy) {
        checkSy(sy);
        return final ? sectionBytes(bytePool, ints[finalAt(base, sy) + FINAL_LIGHT]!) : 0;
      },
      aux() {
        const slot = ints[base + REC_AUX_A]!;
        return slot < 0 ? null : auxView(bytePool, slot);
      },
      auxB() {
        const slot = ints[base + REC_AUX_B]!;
        return slot < 0 ? null : auxBView(bytePool, slot);
      },
    };
  }

  /** The generation the last successful `committedIn` validated (a writer opened on its base captures it). */
  let foundGen = 0;

  /**
   * The record base of (cx, cz) when it holds that column at a status in [`min`, `max`], else −1. The generation is
   * loaded before `find` and must be unchanged after the status read (SP4b spec §2.2), so a free and a re-claim of the
   * same column between the two is not taken for the column found; `foundGen` keeps it.
   */
  function committedIn(cx: number, cz: number, min: number, max: number): number {
    const gen = Atomics.load(ints, recordBase(cx, cz) + REC_GEN);
    const base = table.find(cx, cz);
    if (base < 0) return -1;
    const status = table.status(base);
    if (status < min || status > max || Atomics.load(ints, base + REC_GEN) !== gen) return -1;
    foundGen = gen;
    return base;
  }

  /** The record base of (cx, cz) when it holds that column at status ≥ `min`, else −1 (`committedIn`). */
  function committed(cx: number, cz: number, min: number): number {
    return committedIn(cx, cz, min, STATUS_PUBLISHED);
  }

  /**
   * The stale guard of a writer of the record at `base` (SP4b spec §2.2): throws `WriterStale` unless the record still
   * holds the claim the writer captured (generation `gen`, `claimed`, cx and cz), i.e. was neither freed nor claimed
   * again by any column. A reopened writer passes the generation its lookup validated; a claim's reads it now.
   */
  function staleGuard(base: number, cx: number, cz: number, gen = Atomics.load(ints, base + REC_GEN)): () => void {
    return () => {
      if (
        Atomics.load(ints, base + REC_GEN) !== gen || Atomics.load(ints, base + REC_CLAIMED) !== 1 ||
        Atomics.load(ints, base + REC_CX) !== cx || Atomics.load(ints, base + REC_CZ) !== cz
      ) {
        throw new WriterStale(`store: the record no longer holds column (${cx}, ${cz})`);
      }
    };
  }

  /** Proto section `sy` of the record at `base`, both channels (each releases what it replaces); `checkProto` first. */
  function writeProto(base: number, sy: number, blocks: Uint16Array, fluid: Uint8Array): void {
    const p = protoAt(base, sy);
    storeWords(blockPool, ints, p + PROTO_BLOCKS, blocks, retire);
    storeBytes(bytePool, ints, p + PROTO_FLUID, fluid, retire);
  }

  /** Retires the proto entries of the record at `base` (SP4b spec §2.5) and resets them to −1. */
  function releaseProto(base: number): void {
    for (let sy = 0; sy < SECTIONS; sy++) {
      const p = protoAt(base, sy);
      releaseEntry(blockPool, ints, p + PROTO_BLOCKS, retire);
      releaseEntry(bytePool, ints, p + PROTO_FLUID, retire);
    }
  }

  /**
   * The writer of the record at `base`, which holds (cx, cz): a fresh claim's (`from` 0) or a reopened column's
   * (`from` the status it reopened at). Its aux accessors view the record's slot when it has one and allocate
   * otherwise; `wroteBlocks`/`wroteLight` record the channels written since the previous commit (SP4a spec §2.5), set
   * before a store so a write that throws midway still counts. It captures the record's generation (`gen`, the one
   * its lookup validated, or now for a claim; SP4b spec §2.2), and its commits set the alive bit only when it was
   * opened by a claim (SP4b spec §2.4). Every release goes through the thread's `retire` (SP4b spec §2.5).
   */
  function writer(base: number, cx: number, cz: number, from: 0 | 1 | 2, gen?: number): ColumnWriter {
    const check = staleGuard(base, cx, cz, gen);
    let auxA: AuxView | null = null;
    let auxB: AuxBView | null = null;
    let wroteBlocks = false;
    let wroteLight = false;
    /** The last status this writer committed (`from` before its first commit). */
    let last: number = from;
    const setMeta = (sy: number): void => {
      const f = finalAt(base, sy);
      ints[f + FINAL_META] = computeMeta(sectionWords(blockPool, ints[f + FINAL_BLOCKS]!), sectionBytes(bytePool, ints[f + FINAL_FLUID]!), pass);
    };
    /** The slot at `ints[at]`, allocated (zero-filled) and recorded when the record has none. */
    const auxSlot = (at: number): number => {
      if (ints[at]! < 0) ints[at] = allocAux(bytePool);
      return ints[at]!;
    };
    return {
      cx,
      cz,
      setProto(sy, blocks, fluid) {
        check();
        checkProto(sy, blocks, fluid);
        wroteBlocks = true;
        writeProto(base, sy, blocks, fluid);
      },
      setFinal(sy, blocks, light, fluid) {
        check();
        checkSy(sy);
        checkLength(blocks, 'blocks');
        checkLength(light, 'light');
        checkLength(fluid, 'fluid');
        const f = finalAt(base, sy);
        wroteBlocks = true;
        wroteLight = true;
        storeWords(blockPool, ints, f + FINAL_BLOCKS, blocks, retire);
        storeBytes(bytePool, ints, f + FINAL_LIGHT, light, retire);
        storeBytes(bytePool, ints, f + FINAL_FLUID, fluid, retire);
        setMeta(sy);
      },
      shareFinal(sy, light) {
        check();
        checkSy(sy);
        checkLength(light, 'light');
        const p = protoAt(base, sy);
        const f = finalAt(base, sy);
        wroteBlocks = true;
        // The D skeleton's all-zero light is no light change (SP4a spec §2.5).
        if (!wroteLight && light.some((v) => v !== 0)) wroteLight = true;
        shareEntry(blockPool, ints, p + PROTO_BLOCKS, f + FINAL_BLOCKS, retire);
        shareEntry(bytePool, ints, p + PROTO_FLUID, f + FINAL_FLUID, retire);
        storeBytes(bytePool, ints, f + FINAL_LIGHT, light, retire);
        setMeta(sy);
      },
      setLight(sy, light) {
        check();
        checkSy(sy);
        checkLength(light, 'light');
        const at = finalAt(base, sy) + FINAL_LIGHT;
        // The light-once invariant (SP4a spec §2.5): replacing a dense entry would free a slot a reader may hold.
        if (isDense(ints[at]!)) throw new Error('light already written');
        wroteLight = true;
        storeBytes(bytePool, ints, at, light, retire);
      },
      resetLight() {
        check();
        for (let sy = 0; sy < SECTIONS; sy++) {
          const at = finalAt(base, sy) + FINAL_LIGHT;
          // −1 is uniform light 0 (`section.ts`): nothing to release, and no light change.
          if (ints[at] === -1) continue;
          wroteLight = true;
          releaseEntry(bytePool, ints, at, retire);
        }
      },
      aux() {
        check();
        if (auxA === null) auxA = auxView(bytePool, auxSlot(base + REC_AUX_A));
        return auxA;
      },
      auxB() {
        check();
        if (auxB === null) auxB = auxBView(bytePool, auxSlot(base + REC_AUX_B));
        return auxB;
      },
      commit(status: CommitStatus) {
        check();
        if (status !== 1 && status !== 2 && status !== 3) throw new RangeError(`store: commit status ${String(status)}`);
        // The status guard (SP4b spec §2.4): above the status the writer opened at, never below its own last commit.
        if (status <= from || status < last) {
          throw new RangeError(`store: commit status ${status} of column (${cx}, ${cz}), a writer opened at ${from} that last committed ${last}`);
        }
        if (from === 0) Atomics.or(ints, base + REC_PROTO_FLAGS, PROTO_ALIVE);
        if (wroteBlocks) table.bumpBlockVersion(base);
        if (wroteLight) table.bumpLightVersion(base);
        wroteBlocks = false;
        wroteLight = false;
        last = status;
        table.setStatus(base, status);
      },
    };
  }

  /**
   * The `ProtoWriter` of the record at `base`, which holds (cx, cz) at status ≥ Decorated with a freed proto (SP4b spec
   * §2.4): proto sections only, aux into worker-local scratch made on first use, `commitProto` sets the alive bit. It
   * captures `gen`, the generation its lookup validated (SP4b spec §2.2).
   */
  function protoWriter(base: number, cx: number, cz: number, gen: number): ProtoWriter {
    const check = staleGuard(base, cx, cz, gen);
    let scratch: { readonly a: AuxView; readonly b: AuxBView } | null = null;
    const aux = () => (scratch ??= createScratchAux());
    return {
      cx,
      cz,
      setProto(sy, blocks, fluid) {
        check();
        checkProto(sy, blocks, fluid);
        writeProto(base, sy, blocks, fluid);
      },
      aux() {
        check();
        return aux().a;
      },
      auxB() {
        check();
        return aux().b;
      },
      commitProto() {
        check();
        Atomics.or(ints, base + REC_PROTO_FLAGS, PROTO_ALIVE);
      },
    };
  }

  /** The 3 × 3 versions around (cx, cz) into `out` (`NeighborhoodReader.versions`' layout), with no allocation. */
  function versionsInto(cx: number, cz: number, out: Int32Array): void {
    if (out.length < 18) throw new RangeError(`store: versionsInto needs 18 entries, got ${out.length}`);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const base = committed(cx + dx, cz + dz, STATUS_PROTO);
        const k = 2 * (3 * (dz + 1) + (dx + 1));
        out[k] = base < 0 ? -1 : table.blockVersion(base);
        out[k + 1] = base < 0 ? -1 : table.lightVersion(base);
      }
    }
  }

  const store: VoxelStore = {
    shared: h.shared,
    blockPool,
    bytePool,
    table,
    epochs,
    thread,
    storeId: reclaimer.storeId,
    handles: () => h,
    enterRead: reclaimer.enterRead,
    exitRead: reclaimer.exitRead,
    drain: reclaimer.drain,
    limboCount: reclaimer.limboCount,
    markDead: reclaimer.markDead,

    claimColumn(cx, cz, epoch) {
      return writer(table.claim(cx, cz, epoch), cx, cz, 0);
    },

    reopenColumn(cx, cz, from) {
      if (from !== 1 && from !== 2) throw new RangeError(`store: reopenColumn from status ${String(from)}`);
      const base = committedIn(cx, cz, from, from);
      if (base < 0) throw new Error(`reopenColumn: (${cx}, ${cz}) is not at status ${from}`);
      return writer(base, cx, cz, from, foundGen);
    },

    freeColumn(cx, cz) {
      const base = table.find(cx, cz);
      if (base < 0) return;
      table.setStatus(base, STATUS_ABSENT);
      releaseProto(base);
      for (let sy = 0; sy < SECTIONS; sy++) {
        const f = finalAt(base, sy);
        releaseEntry(blockPool, ints, f + FINAL_BLOCKS, retire);
        releaseEntry(bytePool, ints, f + FINAL_LIGHT, retire);
        releaseEntry(bytePool, ints, f + FINAL_FLUID, retire);
      }
      releaseEntry(bytePool, ints, base + REC_AUX_A, retire);
      releaseEntry(bytePool, ints, base + REC_AUX_B, retire);
      table.clear(base);
      table.unclaim(base);
    },

    freeProto(cx, cz) {
      const base = table.find(cx, cz);
      if (base < 0) return;
      releaseProto(base);
      Atomics.and(ints, base + REC_PROTO_FLAGS, ~PROTO_ALIVE);
    },

    proto(cx, cz) {
      const base = committed(cx, cz, STATUS_PROTO);
      return base < 0 || (Atomics.load(ints, base + REC_PROTO_FLAGS) & PROTO_ALIVE) === 0 ? null : view(base, cx, cz, false);
    },

    final(cx, cz) {
      const base = committed(cx, cz, STATUS_DECORATED);
      return base < 0 ? null : view(base, cx, cz, true);
    },

    neighborhood(cx, cz) {
      const check = (dx: number, dz: number): void => {
        if ((dx !== -1 && dx !== 0 && dx !== 1) || (dz !== -1 && dz !== 0 && dz !== 1)) {
          throw new RangeError(`store: neighbour (${dx}, ${dz}) outside the 3 × 3`);
        }
      };
      return {
        cx,
        cz,
        proto(dx, dz) {
          check(dx, dz);
          return store.proto(cx + dx, cz + dz);
        },
        final(dx, dz) {
          check(dx, dz);
          return store.final(cx + dx, cz + dz);
        },
        versions() {
          const out = new Int32Array(18);
          versionsInto(cx, cz, out);
          return out;
        },
        versionsInto(out) {
          versionsInto(cx, cz, out);
        },
      };
    },

    reopenProto(cx, cz) {
      const base = committed(cx, cz, STATUS_DECORATED);
      if (base < 0 || (Atomics.load(ints, base + REC_PROTO_FLAGS) & PROTO_ALIVE) !== 0) {
        throw new Error(`reopenProto: (${cx}, ${cz}) is not at status ≥ 2 with a freed proto`);
      }
      return protoWriter(base, cx, cz, foundGen);
    },

    versionsInto,

    lightAt(bx, by, bz) {
      if ((by | 0) !== by || by < -64 || by >= 16 * SECTIONS - 64) throw new RangeError(`store: lightAt y ${by} outside −64 … ${16 * SECTIONS - 65}`);
      const base = committed(bx >> 4, bz >> 4, STATUS_PUBLISHED);
      if (base < 0) return -1;
      const v = ((by + 64) << 8) | ((bz & 15) << 4) | (bx & 15);
      return byteAt(bytePool, ints[finalAt(base, v >> 12) + FINAL_LIGHT]!, v & 4095);
    },

    heightAt(kind, bx, bz) {
      const at = heightmapWords(kind);
      if (at < 0) throw new RangeError(`store: heightAt of an unknown heightmap ${String(kind)}`);
      const base = committed(bx >> 4, bz >> 4, STATUS_PUBLISHED);
      if (base < 0) return null;
      const slot = ints[base + REC_AUX_A]!;
      if (slot < 0) return null;
      // Read through the pool's length-tracking u16 view (no per-call view); `<< 16 >> 16` restores the Int16 sign.
      return (bytePool.words[slot * (AUX_BYTES >> 1) + at + (((bz & 15) << 4) | (bx & 15))]! << 16) >> 16;
    },

    holder(cx, cz) {
      if (table.find(cx, cz) >= 0) return 'self';
      return Atomics.load(ints, recordBase(cx, cz) + REC_CLAIMED) === 0 ? 'free' : 'other';
    },
  };
  return store;
}

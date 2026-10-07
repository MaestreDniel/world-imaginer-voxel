/**
 * The voxel store (SP3a spec §3, master §2.3): a block pool and a byte pool (`pool.ts`), the 64 × 64 column torus
 * (`columnTable.ts`), section descriptors (`section.ts`), aux slots (`aux.ts`) and the epoch cells (`epochs.ts`).
 * `createStore({shared})` builds it over growable `SharedArrayBuffer`s (several threads, through `handles()` and
 * `attachStore`) or over resizable `ArrayBuffer`s (one thread), with the same code.
 *
 * Column lifecycle: `claimColumn` takes the record and returns a `ColumnWriter`; `commit` publishes it (status last);
 * `proto`/`final` read it once its status allows; `freeProto` releases the proto set; `freeColumn` releases every
 * reference the record holds and frees the record. `gen` imports only the types of `api.ts`, never this file.
 */
import { PASS } from '../blocks/index';
import type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, NeighborhoodReader } from './api';
import { allocAux, auxBView, auxView } from './aux';
import {
  attachColumnTable, createColumnTable, finalAt, protoAt, REC_AUX_A, REC_AUX_B, REC_CLAIMED, REC_CX, REC_CZ,
  SECTIONS, STATUS_ABSENT, STATUS_DECORATED, STATUS_PROTO, type ColumnTable,
} from './columnTable';
import { attachEpochCells, createEpochCells, type EpochCells } from './epochs';
import {
  attachPool, BLOCK_SLOT_BYTES, BYTE_SLOT_BYTES, createPool, DEFAULT_MAX_BLOCK_BYTES, DEFAULT_MAX_BYTE_BYTES,
  type PoolHandles, type SlabPool,
} from './pool';
import {
  byteAt, computeMeta, FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT, FINAL_META, PROTO_BLOCKS, PROTO_FLUID, releaseEntry,
  sectionBytes, sectionWords, SECTION_VOXELS, shareEntry, storeBytes, storeWords, wordAt,
} from './section';

export { SlotBusy } from './columnTable';
export { StoreFull } from './pool';
export type { AuxBView, AuxView, ColumnView, ColumnWriter, CommitStatus, NeighborhoodReader } from './api';

/** Entries of a per-state table (the registry's `MAX_STATES`). */
const STATE_TABLE_SIZE = 4096;

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
  readonly pass: Uint8Array;
}

export interface VoxelStore {
  readonly shared: boolean;
  readonly blockPool: SlabPool;
  readonly bytePool: SlabPool;
  readonly table: ColumnTable;
  readonly epochs: EpochCells;
  handles(): StoreHandles;
  /** Takes the record of (cx, cz) (`SlotBusy` if held) and returns its writer. */
  claimColumn(cx: number, cz: number, epoch: number): ColumnWriter;
  /** Releases every reference the record holds and frees it; nothing unless the record holds (cx, cz). */
  freeColumn(cx: number, cz: number): void;
  /** Releases the proto entries only (resets them to −1); nothing unless the record holds (cx, cz). */
  freeProto(cx: number, cz: number): void;
  /** The proto set, or null unless the record holds (cx, cz) at status ≥ Proto. */
  proto(cx: number, cz: number): ColumnView | null;
  /** The final set, or null unless the record holds (cx, cz) at status ≥ Decorated. */
  final(cx: number, cz: number): ColumnView | null;
  neighborhood(cx: number, cz: number): NeighborhoodReader;
}

function checkSy(sy: number): void {
  if ((sy | 0) !== sy || sy < 0 || sy >= SECTIONS) throw new RangeError(`store: section ${sy} outside 0 … ${SECTIONS - 1}`);
}

function checkLength(a: Uint16Array | Uint8Array, what: string): void {
  if (a.length !== SECTION_VOXELS) throw new RangeError(`store: ${what} has ${a.length} entries, expected ${SECTION_VOXELS}`);
}

/** Voxel index in its section of (lx, y, lz), y absolute; the section is `index >> 12`. */
function voxelOf(lx: number, y: number, lz: number): number {
  const yy = y + 64;
  if ((lx & 15) !== lx || (lz & 15) !== lz || (yy | 0) !== yy || yy < 0 || yy >= 16 * SECTIONS) {
    throw new RangeError(`store: voxel (${lx}, ${y}, ${lz}) outside the column`);
  }
  return (yy << 8) | (lz << 4) | lx;
}

export function createStore(opts: StoreOptions): VoxelStore {
  const { shared } = opts;
  const pass = opts.pass ?? DEFAULT_PASS;
  if (pass.length !== STATE_TABLE_SIZE) throw new RangeError(`store: pass table of ${pass.length} entries, expected ${STATE_TABLE_SIZE}`);
  const blocks = createPool({ shared, slotBytes: BLOCK_SLOT_BYTES, maxBytes: opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES });
  const bytes = createPool({ shared, slotBytes: BYTE_SLOT_BYTES, maxBytes: opts.maxByteBytes ?? DEFAULT_MAX_BYTE_BYTES });
  return attachStore({
    shared,
    blocks: blocks.handles(),
    bytes: bytes.handles(),
    table: createColumnTable(shared).buffer,
    epochs: createEpochCells(shared).buffer,
    pass: pass.slice(),
  });
}

/** The store over existing handles (`store.handles()`, possibly from another thread). */
export function attachStore(h: StoreHandles): VoxelStore {
  const blockPool = attachPool(h.blocks);
  const bytePool = attachPool(h.bytes);
  const table = attachColumnTable(h.table);
  const epochs = attachEpochCells(h.epochs);
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

  /** The record base of (cx, cz) when it holds that column at status ≥ `min`, else −1. */
  function committed(cx: number, cz: number, min: number): number {
    const base = table.find(cx, cz);
    return base >= 0 && table.status(base) >= min ? base : -1;
  }

  function releaseProto(base: number): void {
    for (let sy = 0; sy < SECTIONS; sy++) {
      const p = protoAt(base, sy);
      releaseEntry(blockPool, ints, p + PROTO_BLOCKS);
      releaseEntry(bytePool, ints, p + PROTO_FLUID);
    }
  }

  const store: VoxelStore = {
    shared: h.shared,
    blockPool,
    bytePool,
    table,
    epochs,
    handles: () => h,

    claimColumn(cx, cz, epoch) {
      const base = table.claim(cx, cz, epoch);
      let auxA: AuxView | null = null;
      let auxB: AuxBView | null = null;
      /** The record still holds this writer's column (it has not been freed, nor taken by another column). */
      const check = (): void => {
        if (Atomics.load(ints, base + REC_CLAIMED) !== 1 || Atomics.load(ints, base + REC_CX) !== cx || Atomics.load(ints, base + REC_CZ) !== cz) {
          throw new Error(`store: the record no longer holds column (${cx}, ${cz})`);
        }
      };
      const setMeta = (sy: number): void => {
        const f = finalAt(base, sy);
        ints[f + FINAL_META] = computeMeta(sectionWords(blockPool, ints[f + FINAL_BLOCKS]!), sectionBytes(bytePool, ints[f + FINAL_FLUID]!), pass);
      };
      return {
        cx,
        cz,
        setProto(sy, blocks, fluid) {
          check();
          checkSy(sy);
          checkLength(blocks, 'blocks');
          checkLength(fluid, 'fluid');
          const p = protoAt(base, sy);
          storeWords(blockPool, ints, p + PROTO_BLOCKS, blocks);
          storeBytes(bytePool, ints, p + PROTO_FLUID, fluid);
        },
        setFinal(sy, blocks, light, fluid) {
          check();
          checkSy(sy);
          checkLength(blocks, 'blocks');
          checkLength(light, 'light');
          checkLength(fluid, 'fluid');
          const f = finalAt(base, sy);
          storeWords(blockPool, ints, f + FINAL_BLOCKS, blocks);
          storeBytes(bytePool, ints, f + FINAL_LIGHT, light);
          storeBytes(bytePool, ints, f + FINAL_FLUID, fluid);
          setMeta(sy);
        },
        shareFinal(sy, light) {
          check();
          checkSy(sy);
          checkLength(light, 'light');
          const p = protoAt(base, sy);
          const f = finalAt(base, sy);
          shareEntry(blockPool, ints, p + PROTO_BLOCKS, f + FINAL_BLOCKS);
          shareEntry(bytePool, ints, p + PROTO_FLUID, f + FINAL_FLUID);
          storeBytes(bytePool, ints, f + FINAL_LIGHT, light);
          setMeta(sy);
        },
        aux() {
          check();
          if (auxA === null) {
            const slot = allocAux(bytePool);
            ints[base + REC_AUX_A] = slot;
            auxA = auxView(bytePool, slot);
          }
          return auxA;
        },
        auxB() {
          check();
          if (auxB === null) {
            const slot = allocAux(bytePool);
            ints[base + REC_AUX_B] = slot;
            auxB = auxBView(bytePool, slot);
          }
          return auxB;
        },
        commit(status: CommitStatus) {
          check();
          if (status !== 1 && status !== 2 && status !== 3) throw new RangeError(`store: commit status ${String(status)}`);
          table.bumpBlockVersion(base);
          table.setStatus(base, status);
        },
      };
    },

    freeColumn(cx, cz) {
      const base = table.find(cx, cz);
      if (base < 0) return;
      table.setStatus(base, STATUS_ABSENT);
      releaseProto(base);
      for (let sy = 0; sy < SECTIONS; sy++) {
        const f = finalAt(base, sy);
        releaseEntry(blockPool, ints, f + FINAL_BLOCKS);
        releaseEntry(bytePool, ints, f + FINAL_LIGHT);
        releaseEntry(bytePool, ints, f + FINAL_FLUID);
      }
      for (const at of [base + REC_AUX_A, base + REC_AUX_B]) releaseEntry(bytePool, ints, at);
      table.clear(base);
      table.unclaim(base);
    },

    freeProto(cx, cz) {
      const base = table.find(cx, cz);
      if (base >= 0) releaseProto(base);
    },

    proto(cx, cz) {
      const base = committed(cx, cz, STATUS_PROTO);
      return base < 0 ? null : view(base, cx, cz, false);
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
          const out = new Int32Array(18).fill(-1);
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const base = committed(cx + dx, cz + dz, STATUS_PROTO);
              if (base < 0) continue;
              const k = 2 * (3 * (dz + 1) + (dx + 1));
              out[k] = table.blockVersion(base);
              out[k + 1] = table.lightVersion(base);
            }
          }
          return out;
        },
      };
    },
  };
  return store;
}

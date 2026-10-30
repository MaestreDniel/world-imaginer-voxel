/**
 * The session's in-memory DiffStore (SP5a spec §2.4, D20; master §2.7), owned by the sim worker:
 * `Map<colKey, Map<sy, Map<voxelIdx, u32>>>` of absolute final values, `state << 8 | fluid`. It holds the edited
 * value only; the rule that an edit equal to the generated value removes its entry is the caller's (`edits.ts` reads
 * the generated value from the retained proto). The store never drops entries on its own: they stay at their
 * coordinates after an Apply (D14). Emptied maps are deleted, so a column with no entries is absent.
 *
 * **The dirty-column set** (SP5b spec §3.2): `set` and an effective `remove` mark their column, so both an edit's
 * writes and a refused batch's restores reach the next flush; `takeDirty` hands the set over and clears it, and
 * `markDirty` merges an aborted flush's columns back. `setColumn` (the world's load) marks nothing.
 */
import { colKey } from '../core/coords';
import type { ColumnDiff } from '../world/store/api';

/** `get`'s answer for a voxel without an entry (no `state << 8 | fluid` reaches it: states are u16). */
export const NO_ENTRY = 0xFFFFFFFF;

export interface DiffStore {
  /** The entry of voxel `idx` (0 … 4095) of section `sy` (0 … 23) of column (cx, cz), or `NO_ENTRY`. */
  get(cx: number, cz: number, sy: number, idx: number): number;
  /** Sets the entry (adding or replacing it). */
  set(cx: number, cz: number, sy: number, idx: number, value: number): void;
  /** Removes the entry, if any; a section or column left empty is removed with it. */
  remove(cx: number, cz: number, sy: number, idx: number): void;
  /** Whether column (cx, cz) holds an entry. */
  has(cx: number, cz: number): boolean;
  /** The column's entries in canonical order, in fresh arrays (transferable), or null when it holds none. */
  columnDiff(cx: number, cz: number): ColumnDiff | null;
  /**
   * The column's sections by `sy`, each its entries by `idx`, both unordered: read-only views of the store's own maps,
   * valid until its next write, or null when it holds none. The flush encodes from them (`encodeColumnSections`).
   */
  columnSections(cx: number, cz: number): ReadonlyMap<number, ReadonlyMap<number, number>> | null;
  /** The `colKey`s of the columns holding entries. */
  columns(): IterableIterator<number>;
  /** The number of entries over every column. */
  readonly size: number;
  /** The `colKey`s of the columns whose entries changed since the last take, in a fresh array (transferable); clears the set. */
  takeDirty(): Float64Array;
  /** Marks the columns `keys` dirty (an aborted flush's merge-back, SP5b spec §3.2). */
  markDirty(keys: Iterable<number>): void;
  /** Replaces column (cx, cz)'s entries with `d`'s (none when it is empty); marks nothing dirty (the world's load). */
  setColumn(cx: number, cz: number, d: ColumnDiff): void;
}

export function createDiffStore(): DiffStore {
  const cols = new Map<number, Map<number, Map<number, number>>>();
  const dirty = new Set<number>();
  let size = 0;

  return {
    get(cx, cz, sy, idx) {
      return cols.get(colKey(cx, cz))?.get(sy)?.get(idx) ?? NO_ENTRY;
    },
    set(cx, cz, sy, idx, value) {
      const key = colKey(cx, cz);
      let col = cols.get(key);
      if (col === undefined) cols.set(key, (col = new Map()));
      let sec = col.get(sy);
      if (sec === undefined) col.set(sy, (sec = new Map()));
      if (!sec.has(idx)) size++;
      sec.set(idx, value);
      dirty.add(key);
    },
    remove(cx, cz, sy, idx) {
      const key = colKey(cx, cz);
      const col = cols.get(key);
      const sec = col?.get(sy);
      if (col === undefined || sec === undefined || !sec.delete(idx)) return;
      size--;
      dirty.add(key);
      if (sec.size === 0) col.delete(sy);
      if (col.size === 0) cols.delete(key);
    },
    has(cx, cz) {
      return cols.has(colKey(cx, cz));
    },
    columnDiff(cx, cz) {
      const col = cols.get(colKey(cx, cz));
      if (col === undefined) return null;
      let n = 0;
      for (const sec of col.values()) n += sec.size;
      const sy = new Uint8Array(n);
      const idx = new Uint16Array(n);
      const value = new Uint32Array(n);
      let k = 0;
      for (const s of [...col.keys()].sort((a, b) => a - b)) {
        const sec = col.get(s)!;
        for (const i of [...sec.keys()].sort((a, b) => a - b)) {
          sy[k] = s;
          idx[k] = i;
          value[k] = sec.get(i)!;
          k++;
        }
      }
      return { sy, idx, value };
    },
    columnSections(cx, cz) {
      return cols.get(colKey(cx, cz)) ?? null;
    },
    columns() {
      return cols.keys();
    },
    get size() {
      return size;
    },
    takeDirty() {
      const keys = Float64Array.from(dirty);
      dirty.clear();
      return keys;
    },
    markDirty(keys) {
      for (const key of keys) dirty.add(key);
    },
    setColumn(cx, cz, d) {
      const key = colKey(cx, cz);
      const old = cols.get(key);
      if (old !== undefined) {
        for (const sec of old.values()) size -= sec.size;
        cols.delete(key);
      }
      if (d.sy.length === 0) return;
      const col = new Map<number, Map<number, number>>();
      for (let k = 0; k < d.sy.length; k++) {
        const s = d.sy[k]!;
        let sec = col.get(s);
        if (sec === undefined) col.set(s, (sec = new Map()));
        if (!sec.has(d.idx[k]!)) size++;
        sec.set(d.idx[k]!, d.value[k]!);
      }
      cols.set(key, col);
    },
  };
}

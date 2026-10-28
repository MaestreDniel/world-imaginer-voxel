/**
 * The session's in-memory DiffStore (SP5a spec §2.4, D20; master §2.7), owned by the sim worker:
 * `Map<colKey, Map<sy, Map<voxelIdx, u32>>>` of absolute final values, `state << 8 | fluid`. It holds the edited
 * value only; the rule that an edit equal to the generated value removes its entry is the caller's (`edits.ts` reads
 * the generated value from the retained proto). The store never drops entries on its own: they stay at their
 * coordinates after an Apply (D14). Emptied maps are deleted, so a column with no entries is absent.
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
  /** The `colKey`s of the columns holding entries. */
  columns(): IterableIterator<number>;
  /** The number of entries over every column. */
  readonly size: number;
}

export function createDiffStore(): DiffStore {
  const cols = new Map<number, Map<number, Map<number, number>>>();
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
    },
    remove(cx, cz, sy, idx) {
      const key = colKey(cx, cz);
      const col = cols.get(key);
      const sec = col?.get(sy);
      if (col === undefined || sec === undefined || !sec.delete(idx)) return;
      size--;
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
    columns() {
      return cols.keys();
    },
    get size() {
      return size;
    },
  };
}

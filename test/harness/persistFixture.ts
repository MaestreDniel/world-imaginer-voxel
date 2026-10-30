/**
 * The `persist.flush` bench row's DiffStore (SP5b spec §6.2): 64 columns (8 × 8 around the origin), 4 of them holding
 * one full dense section (4096 entries, fmt 1) at a random `sy`, the other 60 holding 200-600 sparse entries at distinct
 * voxels of random sections, each entry a random state with fluid 0; seeded (`Xoshiro128(11)`), each column loaded
 * through `setColumn` in the drawn order (so the store's maps hold it unsorted) and nothing marked dirty. Shared by
 * `noise.bench.ts`'s row and the codec test that pins the flush's encoding against `encodeColumnDiff` over it.
 */
import { colKey } from '../../src/core/coords';
import { Xoshiro128 } from '../../src/core/rng';
import { createDiffStore, type DiffStore } from '../../src/sim/diffStore';
import { REGISTRY } from '../../src/world/blocks/index';
import type { ColumnDiff } from '../../src/world/store/api';

export interface PersistFlushFixture {
  readonly diffs: DiffStore;
  /** The 64 columns' `colKey`s, in fill order. */
  readonly keys: readonly number[];
  /** The indices into `keys` of the 4 dense columns. */
  readonly denseAt: readonly number[];
  /** The entries over every column. */
  readonly entries: number;
}

export function persistFlushFixture(): PersistFlushFixture {
  const rng = new Xoshiro128(11);
  const diffs = createDiffStore();
  const keys: number[] = [];
  const denseAt = [0, 21, 42, 63];
  let entries = 0;
  const state = (): number => (1 + (rng.nextU32() % (REGISTRY.stateCount - 1))) << 8;
  for (let i = 0; i < 64; i++) {
    const cx = (i & 7) - 4;
    const cz = (i >> 3) - 4;
    let d: ColumnDiff;
    if (denseAt.includes(i)) {
      const sy = rng.nextU32() % 24;
      d = { sy: new Uint8Array(4096).fill(sy), idx: Uint16Array.from({ length: 4096 }, (_, k) => k), value: Uint32Array.from({ length: 4096 }, state) };
    } else {
      const n = 200 + (rng.nextU32() % 401);
      const at = new Set<number>();
      while (at.size < n) at.add(rng.nextU32() % (24 * 4096));
      const voxels = [...at];
      d = { sy: Uint8Array.from(voxels, (v) => v >> 12), idx: Uint16Array.from(voxels, (v) => v & 4095), value: Uint32Array.from(voxels, state) };
    }
    diffs.setColumn(cx, cz, d);
    keys.push(colKey(cx, cz));
    entries += d.sy.length;
  }
  return { diffs, keys, denseAt, entries };
}

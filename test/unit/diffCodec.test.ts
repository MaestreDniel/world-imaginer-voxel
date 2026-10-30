/**
 * The `ColumnDiffV1` codec (SP5b spec §2.2, D21; master §2.7): seeded round trips over random columns (Spec E1's shape:
 * 1-3 sections at random `sy`, counts from {1, 2559, 2560, 4096}, state ids ≥ 256, fluid 0 and 127, 0, 1 and 40 ticks
 * with `packedPos` near 2^32 − 1), canonical bytes, the size arithmetic, one test per reject of §2.2, and the committed
 * hex fixture that pins the byte layout.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Hash64 } from '../../src/core/hash';
import {
  decodeColumnDiff, DENSE_MIN, DiffDecodeError, encodeColumnDiff, encodedSize, type FluidTick,
} from '../../src/persist/diffCodec';
import { createDiffStore, type DiffStore } from '../../src/sim/diffStore';
import type { ColumnDiff } from '../../src/world/store/api';
import { testRng } from '../harness/stats';

const SEED = 0x5b02;
const COLUMNS = 2000;
const COUNTS = [1, 2559, 2560, 4096] as const;
const TICK_COUNTS = [0, 1, 40] as const;
/** Every u16 state id is valid (`stateCount` the stored table's length). */
const STATE_COUNT = 65536;

interface Column {
  readonly diff: ColumnDiff;
  readonly genKey: Hash64;
  readonly ticks: readonly FluidTick[];
}

const pick = <T>(next: () => number, xs: readonly T[]): T => xs[next() % xs.length]!;

/** `k` distinct values of 0 … n − 1, ascending (a partial Fisher-Yates). */
function distinct(next: () => number, n: number, k: number): Uint16Array {
  const a = new Uint16Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = 0; i < k; i++) {
    const j = i + (next() % (n - i));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a.slice(0, k).sort();
}

/** A random column in canonical order; `sys` collects the drawn `sy`. */
function randomColumn(next: () => number, sys: Set<number>): Column {
  const secs = distinct(next, 24, 1 + (next() % 3));
  const sy: number[] = [];
  const idx: number[] = [];
  const value: number[] = [];
  for (const s of secs) {
    sys.add(s);
    for (const i of distinct(next, 4096, pick(next, COUNTS))) {
      sy.push(s);
      idx.push(i);
      value.push(((256 + (next() % (STATE_COUNT - 256))) << 8 | (next() & 1 ? 127 : 0)) >>> 0);
    }
  }
  const pos = distinct(next, 1000, pick(next, TICK_COUNTS));
  return {
    diff: { sy: Uint8Array.from(sy), idx: Uint16Array.from(idx), value: Uint32Array.from(value) },
    genKey: [next(), next()],
    ticks: Array.from(pos, (p) => ({ packedPos: 2 ** 32 - 1000 + p, dueOffset: next() & 0xFFFF })),
  };
}

/** A random permutation of 0 … n − 1 (Fisher-Yates). */
function permutation(next: () => number, n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

const shuffled = <T>(next: () => number, xs: readonly T[]): T[] => Array.from(permutation(next, xs.length), (i) => xs[i]!);

/** The column's entries in a shuffled order. */
function shuffledDiff(next: () => number, d: ColumnDiff): ColumnDiff {
  const order = permutation(next, d.sy.length);
  const n = order.length;
  const sy = new Uint8Array(n);
  const idx = new Uint16Array(n);
  const value = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    sy[k] = d.sy[i]!;
    idx[k] = d.idx[i]!;
    value[k] = d.value[i]!;
  }
  return { sy, idx, value };
}

const sameArray = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const sameDiff = (a: ColumnDiff, b: ColumnDiff): boolean =>
  sameArray(a.sy, b.sy) && sameArray(a.idx, b.idx) && sameArray(a.value, b.value);
const sameTicks = (a: readonly FluidTick[], b: readonly FluidTick[]): boolean =>
  a.length === b.length && a.every((t, i) => t.packedPos === b[i]!.packedPos && t.dueOffset === b[i]!.dueOffset);

function storeOf(d: ColumnDiff): DiffStore {
  const s = createDiffStore();
  for (let i = 0; i < d.sy.length; i++) s.set(0, 0, d.sy[i]!, d.idx[i]!, d.value[i]!);
  return s;
}

/** The first voxel of the column where the two stores read differently, or null. */
function storeMismatch(a: DiffStore, b: DiffStore): string | null {
  for (let sy = 0; sy < 24; sy++) {
    for (let idx = 0; idx < 4096; idx++) {
      if (a.get(0, 0, sy, idx) !== b.get(0, 0, sy, idx)) return `sy ${sy} idx ${idx}`;
    }
  }
  return null;
}

/** Every column of the run, generated once (the tests below share them). */
function columns(): { cols: Column[]; sys: Set<number> } {
  const next = testRng(SEED);
  const sys = new Set<number>();
  const cols = Array.from({ length: COLUMNS }, () => randomColumn(next, sys));
  return { cols, sys };
}
const RUN = columns();

const hex = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));

describe('ColumnDiffV1 round trips (SP5b spec §2.2, §6.1 E1)', () => {
  test('every `sy` 0-23 is drawn over the run', () => {
    expect([...RUN.sys].sort((a, b) => a - b), `seed ${SEED}`).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  test('decode(encode(d)) equals d over 2,000 random columns, each with 1-3 sections at random `sy` (every `sy` 0-23 drawn over the run) and each section\'s count from {1, 2559, 2560, 4096}, state ids ≥ 256, fluid 0 and 127, 0, 1 and 40 ticks with `packedPos` near 2^32 − 1', () => {
    const failures: string[] = [];
    RUN.cols.forEach((c, i) => {
      const got = decodeColumnDiff(encodeColumnDiff(c.diff, c.genKey, c.ticks), STATE_COUNT);
      if (!sameDiff(got.diff, c.diff)) failures.push(`seed ${SEED} column ${i}: diff`);
      if (got.genKey[0] !== c.genKey[0] || got.genKey[1] !== c.genKey[1]) failures.push(`seed ${SEED} column ${i}: genKey`);
      if (!sameTicks(got.ticks, c.ticks)) failures.push(`seed ${SEED} column ${i}: ticks`);
    });
    expect(failures).toEqual([]);
  });

  test('a DiffStore rebuilt from a decoded column reads every voxel as the source (every 10th column)', () => {
    const failures: string[] = [];
    for (let i = 0; i < COLUMNS; i += 10) {
      const c = RUN.cols[i]!;
      const got = decodeColumnDiff(encodeColumnDiff(c.diff, c.genKey, c.ticks), STATE_COUNT);
      const at = storeMismatch(storeOf(c.diff), storeOf(got.diff));
      if (at !== null) failures.push(`seed ${SEED} column ${i}: ${at}`);
    }
    expect(failures).toEqual([]);
  });

  test('encode(decode(b)) === b byte for byte', () => {
    const failures: string[] = [];
    RUN.cols.forEach((c, i) => {
      const b = encodeColumnDiff(c.diff, c.genKey, c.ticks);
      const d = decodeColumnDiff(b, STATE_COUNT);
      if (!sameArray(encodeColumnDiff(d.diff, d.genKey, d.ticks), b)) failures.push(`seed ${SEED} column ${i}`);
    });
    expect(failures).toEqual([]);
  });

  test('input order does not change the bytes', () => {
    const next = testRng(SEED + 1);
    const failures: string[] = [];
    RUN.cols.forEach((c, i) => {
      const b = encodeColumnDiff(c.diff, c.genKey, c.ticks);
      const s = encodeColumnDiff(shuffledDiff(next, c.diff), c.genKey, shuffled(next, c.ticks));
      if (!sameArray(s, b)) failures.push(`seed ${SEED} column ${i}`);
    });
    expect(failures).toEqual([]);
  });

  test('the size equals `encodedSize`, and `byteLength === buffer.byteLength`', () => {
    const failures: string[] = [];
    RUN.cols.forEach((c, i) => {
      const b = encodeColumnDiff(c.diff, c.genKey, c.ticks);
      if (b.byteLength !== encodedSize(c.diff, c.ticks.length)) failures.push(`seed ${SEED} column ${i}: size`);
      if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) failures.push(`seed ${SEED} column ${i}: a view`);
    });
    expect(failures).toEqual([]);
  });

  test('fmt is 1 exactly when n ≥ 2560: 12,800 B at n = 2560 equals sparse\'s 5 × 2560', () => {
    expect(DENSE_MIN).toBe(2560);
    const section = (n: number): ColumnDiff => ({
      sy: new Uint8Array(n).fill(7),
      idx: Uint16Array.from({ length: n }, (_, i) => i),
      value: new Uint32Array(n).fill(300 << 8),
    });
    const fmt = (b: Uint8Array): number => b[11]!;
    const sparse = encodeColumnDiff(section(2559), [1, 2]);
    const dense = encodeColumnDiff(section(2560), [1, 2]);
    expect([sparse[10], fmt(sparse), dense[10], fmt(dense)]).toEqual([7, 0, 7, 1]);
    expect(encodedSize(section(2559), 0)).toBe(10 + 4 + 5 * 2559 + 2);
    expect(encodedSize(section(2560), 0)).toBe(10 + 4 + 12800 + 2);
    expect(512 + 8192 + 4096).toBe(5 * 2560);
    expect(dense.byteLength).toBe(10 + 4 + 5 * 2560 + 2);
    expect(fmt(encodeColumnDiff(section(4096), [1, 2]))).toBe(1);
  });

  test('encode throws on a duplicate entry or tick', () => {
    const d: ColumnDiff = { sy: Uint8Array.of(3, 3), idx: Uint16Array.of(9, 9), value: Uint32Array.of(1 << 8, 2 << 8) };
    expect(() => encodeColumnDiff(d, [0, 0])).toThrow(/duplicate entry/);
    const one: ColumnDiff = { sy: Uint8Array.of(3), idx: Uint16Array.of(9), value: Uint32Array.of(1 << 8) };
    const ticks = [{ packedPos: 5, dueOffset: 1 }, { packedPos: 5, dueOffset: 2 }];
    expect(() => encodeColumnDiff(one, [0, 0], ticks)).toThrow(/duplicate tick/);
  });

  test('decoded ticks are returned', () => {
    const one: ColumnDiff = { sy: Uint8Array.of(0), idx: Uint16Array.of(0), value: Uint32Array.of(1 << 8) };
    const ticks = [{ packedPos: 2 ** 32 - 1, dueOffset: 0xFFFF }, { packedPos: 0, dueOffset: 0 }];
    expect(decodeColumnDiff(encodeColumnDiff(one, [0, 0], ticks), 2).ticks).toEqual([ticks[1], ticks[0]]);
  });
});

/** A little-endian byte writer for hand-built buffers. */
function bytes(write: (w: { u8(v: number): void; u16(v: number): void; u32(v: number): void }) => void): Uint8Array {
  const out: number[] = [];
  write({
    u8: (v) => out.push(v & 0xFF),
    u16: (v) => out.push(v & 0xFF, (v >>> 8) & 0xFF),
    u32: (v) => out.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF),
  });
  return Uint8Array.from(out);
}

/** A buffer whose one section is sparse, with `entries` as `[idx, state, fluid]`, and `ticks` as `[packedPos, dueOffset]`. */
const sparse = (sy: number, entries: Array<[number, number, number]>, ticks: Array<[number, number]> = []): Uint8Array =>
  bytes((w) => {
    w.u8(1); w.u32(0); w.u32(0); w.u8(1);
    w.u8(sy); w.u8(0); w.u16(entries.length);
    for (const [i, s, f] of entries) { w.u16(i); w.u16(s); w.u8(f); }
    w.u16(ticks.length);
    for (const [p, o] of ticks) { w.u32(p); w.u16(o); }
  });

/** A dense section (n = 2560: idx 0 … 2559, state 1, fluid 0) at sy 0, valid as built. */
const dense = (): Uint8Array =>
  encodeColumnDiff({
    sy: new Uint8Array(2560), idx: Uint16Array.from({ length: 2560 }, (_, i) => i), value: new Uint32Array(2560).fill(1 << 8),
  }, [0, 0]);
/** Offsets in `dense()`: the section header at 10, the mask at 14, the states at 526, the fluids at 8718. */
const MASK = 14;
const STATES = MASK + 512;
const FLUIDS = STATES + 8192;

/** Decodes `b`, expecting a `DiffDecodeError` whose message names `what`, and no result. */
function rejects(b: Uint8Array, what: string, stateCount = 16): void {
  let result: unknown;
  let error: unknown;
  try {
    result = decodeColumnDiff(b, stateCount);
  } catch (e) {
    error = e;
  }
  expect(result, `${what}: a result`).toBeUndefined();
  expect(error, `${what}: not a DiffDecodeError`).toBeInstanceOf(DiffDecodeError);
  expect((error as Error).message).toContain(what);
}

describe('ColumnDiffV1 rejects (SP5b spec §2.2), each a DiffDecodeError naming its case, never a partial diff', () => {
  test('the hand-built buffers are valid as built', () => {
    expect(decodeColumnDiff(sparse(2, [[1, 3, 0], [5, 4, 16]], [[7, 1], [9, 2]]), 16).diff.idx).toEqual(Uint16Array.of(1, 5));
    expect(decodeColumnDiff(dense(), 16).diff.idx.length).toBe(2560);
  });

  test('`v` ≠ 1', () => {
    const b = sparse(2, [[1, 3, 0]]);
    b[0] = 2;
    rejects(b, 'version 2');
    b[0] = 0;
    rejects(b, 'version 0');
  });

  test('`fmt` ∉ {0, 1}', () => {
    const b = sparse(2, [[1, 3, 0]]);
    b[11] = 2;
    rejects(b, 'fmt 2');
  });

  test('more than 24 sections', () => {
    const b = sparse(2, [[1, 3, 0]]);
    b[9] = 25;
    rejects(b, 'more than 24 sections');
  });

  test('`sy` ≥ 24', () => {
    rejects(sparse(24, [[1, 3, 0]]), 'sy 24 ≥ 24');
  });

  test('sections out of order (descending or repeated `sy`)', () => {
    const two = (a: number, c: number): Uint8Array => bytes((w) => {
      w.u8(1); w.u32(0); w.u32(0); w.u8(2);
      w.u8(a); w.u8(0); w.u16(1); w.u16(1); w.u16(3); w.u8(0);
      w.u8(c); w.u8(0); w.u16(1); w.u16(1); w.u16(3); w.u8(0);
      w.u16(0);
    });
    expect(decodeColumnDiff(two(3, 5), 16).diff.sy).toEqual(Uint8Array.of(3, 5));
    rejects(two(5, 3), 'sections out of order');
    rejects(two(5, 5), 'sections out of order');
  });

  test('a section with n = 0', () => {
    rejects(sparse(2, []), 'n = 0');
  });

  test('a sparse section with n ≥ 2560', () => {
    const entries = Array.from({ length: 2560 }, (_, i): [number, number, number] => [i, 1, 0]);
    rejects(sparse(0, entries), 'sparse section with n 2560 ≥ 2560');
  });

  test('a dense section whose mask\'s popcount ≠ n', () => {
    const b = dense();
    b[MASK + 400] = 0x01; // idx 3200 joins the mask: popcount 2561, n 2560
    rejects(b, 'mask popcount 2561 ≠ n 2560');
    const c = dense();
    c[12] = 0x01; c[13] = 0x0A; // n 2561 over a 2560-bit mask
    rejects(c, 'mask popcount 2560 ≠ n 2561');
  });

  test('a dense section with n < 2560 (fmt 1 is used exactly when n ≥ 2560)', () => {
    const b = dense();
    b[MASK + 319] = 0x7F; // idx 2559 leaves the mask
    b[12] = 0xFF; b[13] = 0x09; // n 2559
    rejects(b, 'dense section with n 2559 < 2560');
  });

  test('a dense section with a non-zero state or fluid outside its mask', () => {
    const b = dense();
    b[STATES + 2 * 3000] = 1;
    rejects(b, 'unmasked voxel 3000');
    const c = dense();
    c[FLUIDS + 4095] = 16;
    rejects(c, 'unmasked voxel 4095');
  });

  test('`idx` ≥ 4096', () => {
    rejects(sparse(2, [[4096, 3, 0]]), 'idx 4096 ≥ 4096');
  });

  test('unsorted or duplicate entries', () => {
    rejects(sparse(2, [[5, 3, 0], [1, 3, 0]]), 'entries out of order');
    rejects(sparse(2, [[5, 3, 0], [5, 4, 0]]), 'entries out of order');
  });

  test('unsorted or duplicate ticks', () => {
    rejects(sparse(2, [[1, 3, 0]], [[9, 0], [7, 0]]), 'ticks out of order');
    rejects(sparse(2, [[1, 3, 0]], [[9, 0], [9, 1]]), 'ticks out of order');
  });

  test('a state ≥ `stateCount` (the stored `stateTable`\'s length), sparse and dense', () => {
    rejects(sparse(2, [[1, 16, 0]]), 'state 16 ≥ 16');
    expect(decodeColumnDiff(sparse(2, [[1, 16, 0]]), 17).diff.value).toEqual(Uint32Array.of(16 << 8));
    rejects(dense(), 'state 1 ≥ 1', 1);
  });

  test('a fluid byte with its reserved bit 7 set (255 among them), sparse and dense', () => {
    rejects(sparse(2, [[1, 3, 255]]), 'fluid 255 has bit 7 set');
    rejects(sparse(2, [[1, 3, 128]]), 'fluid 128 has bit 7 set');
    const b = dense();
    b[FLUIDS + 17] = 0xFF;
    rejects(b, 'fluid 255 has bit 7 set');
  });

  test('a short buffer: every proper prefix of a valid one', () => {
    for (const b of [sparse(2, [[1, 3, 0], [5, 4, 16]], [[7, 1]]), dense()]) {
      for (let n = 0; n < b.length; n += b.length > 100 ? 97 : 1) rejects(b.slice(0, n), 'short');
      rejects(b.slice(0, b.length - 1), 'short');
    }
  });

  test('an over-long buffer', () => {
    const b = sparse(2, [[1, 3, 0]]);
    const longer = new Uint8Array(b.length + 1);
    longer.set(b);
    rejects(longer, 'over-long');
  });

  test('a view over a larger buffer decodes its own bytes only', () => {
    const b = sparse(2, [[1, 3, 0]]);
    const big = new Uint8Array(b.length + 8);
    big.set(b, 4);
    expect(decodeColumnDiff(big.subarray(4, 4 + b.length), 16).diff.value).toEqual(Uint32Array.of(3 << 8));
  });
});

interface FixtureCase {
  readonly name: string;
  readonly sy: number[];
  readonly idx: number[];
  readonly value: number[];
  readonly genKey: [number, number];
  readonly ticks: FluidTick[];
  readonly hex: string;
}
const FIXTURE = new URL('../fixtures/columnDiffV1.json', import.meta.url);

describe('the committed hex fixture (SP5b spec §6.1 E1: `test/fixtures/columnDiffV1.json`)', () => {
  const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: FixtureCase[] };

  test('the fixture\'s three cases encode to their committed hex', () => {
    expect(cases.map((c) => c.name)).toEqual(['two sparse entries', 'a dense section beside a sparse one', 'one tick']);
    for (const c of cases) {
      const diff: ColumnDiff = { sy: Uint8Array.from(c.sy), idx: Uint16Array.from(c.idx), value: Uint32Array.from(c.value) };
      expect(hex(encodeColumnDiff(diff, c.genKey, c.ticks)), c.name).toBe(c.hex);
      const back = decodeColumnDiff(unhex(c.hex), STATE_COUNT);
      expect(sameDiff(back.diff, diff), c.name).toBe(true);
      expect([...back.genKey], c.name).toEqual(c.genKey);
      expect(back.ticks, c.name).toEqual(c.ticks);
    }
  });

  test('"two sparse entries" reads field by field as the layout', () => {
    // v 1 · genKey lo 0x04030201, hi 0x08070605 · 1 section · sy 5, fmt 0, n 2 ·
    // idx 3, state 0x0102, fluid 0x10 · idx 4095, state 300, fluid 0 · 0 ticks
    expect(cases[0]!.hex).toBe(
      '01' + '01020304' + '05060708' + '01' + '05' + '00' + '0200'
      + '0300' + '0201' + '10' + 'ff0f' + '2c01' + '00' + '0000',
    );
  });
});

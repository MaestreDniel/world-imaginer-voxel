import { describe, expect, test } from 'vitest';
import { colKey, torusSlot } from '../../src/core/coords';
import { CROSS_SECTION_POINTS, segmentPointAt, type Segment } from '../../src/metrics/crossSection';
import { fillColumnT, genRegionInProcess } from '../../src/metrics/region';
import { AIR, BEDROCK, STONE } from '../../src/world/blocks/index';
import { fluidLevel, fluidType, FLUID_WATER } from '../../src/world/blocks/fluid';
import { REC_EPOCH } from '../../src/world/store/columnTable';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, sliceIndex, slicePartIndex, sliceRangeProblem } from '../../src/workers/protocol';
import { createSliceJob, SLICE_LRU_COLUMNS, SLICE_MAX_BLOCK_BYTES, SLICE_MAX_BYTE_BYTES, type SliceData } from '../../src/workers/sliceJob';
import { ctxFor } from '../harness/gen';
import { regionView } from '../harness/region';

const MiB = 1 << 20;
const NEVER = () => false;
const ctx = ctxFor('42');
const seg = (ax: number, az: number, bx: number, bz: number): Segment => ({ ax, az, bx, bz });
/** Slots in use in each pool: [block, byte]. */
const live = (s: VoxelStore) => [s.blockPool.slotCount() - s.blockPool.freeCount(), s.bytePool.slotCount() - s.bytePool.freeCount()];
/** The live slots of a fresh store holding just these columns. */
const liveOf = (cols: ReadonlyArray<readonly [number, number]>) => {
  const ref = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  for (const [cx, cz] of cols) fillColumnT(ref, ctx, cx, cz, NEVER);
  return live(ref);
};
/** A slice that is not stopped. */
const runOk = (job: ReturnType<typeof createSliceJob>, s: Segment, epoch = 0): SliceData => {
  const r = job.run(ctx, epoch, s, NEVER);
  if (r === null) throw new Error('slice stopped');
  return r;
};
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
/** The columns a segment's samples fall in, in sample order, each once. */
const columnsOf = (s: Segment, from = 0, to = SLICE_POINTS): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = from; i < to; i++) {
    const [x, z] = segmentPointAt(s, i);
    const c: [number, number] = [Math.floor(x) >> 4, Math.floor(z) >> 4];
    const last = out[out.length - 1];
    if (last === undefined || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
  }
  return out;
};

/** A coast west of (−1963, −2000) for seed '42' (sea at (−2000, −2000), land at (−1963, −2000): Task 9's columns). */
const COAST = seg(-2030.5, -2007.25, -1950.75, -1990.5);

describe('slice layout (SP3a spec §5.1)', () => {
  test('512 samples along the line × 384 rows; row 0 is y 319, index (319 − y)·512 + i', () => {
    expect([SLICE_POINTS, SLICE_ROWS, SLICE_SAMPLES, CROSS_SECTION_POINTS]).toEqual([512, 384, 196608, 512]);
    expect([sliceIndex(0, 319), sliceIndex(511, 319), sliceIndex(0, 318), sliceIndex(7, -64), sliceIndex(511, -64)]).toEqual([0, 511, 512, 383 * 512 + 7, SLICE_SAMPLES - 1]);
  });
  test('a part [from, to) holds sample (i, y) at (319 − y)·(to − from) + (i − from) (SP3b spec §6)', () => {
    expect([slicePartIndex(0, 319, 0, 512), slicePartIndex(511, -64, 0, 512), slicePartIndex(7, -64, 0, 512)]).toEqual([0, SLICE_SAMPLES - 1, sliceIndex(7, -64)]);
    expect([slicePartIndex(170, 319, 170, 341), slicePartIndex(340, 319, 170, 341), slicePartIndex(170, 318, 170, 341), slicePartIndex(340, -64, 170, 341)]).toEqual([0, 170, 171, 384 * 171 - 1]);
    expect([slicePartIndex(511, 319, 511, 512), slicePartIndex(511, 0, 511, 512), slicePartIndex(511, -64, 511, 512)]).toEqual([0, 319, 383]);
  });
  test('a range is integers with 0 ≤ from < to ≤ 512 (SP3b spec §6)', () => {
    for (const [from, to] of [[0, 512], [0, 1], [511, 512], [170, 341]]) expect(sliceRangeProblem(from!, to!)).toBeNull();
    for (const [from, to] of [[-1, 10], [0, 513], [5, 5], [6, 5], [1.5, 10], [0, 10.5], [Number.NaN, 10], [0, Number.POSITIVE_INFINITY], [-0.5, 0.5]]) {
      expect(sliceRangeProblem(from!, to!)).toBe(`points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 512`);
    }
  });
  test('the slice store: 32 MiB of blocks, 16 MiB of bytes, an LRU of 64 columns', () => {
    expect([SLICE_MAX_BLOCK_BYTES, SLICE_MAX_BYTE_BYTES, SLICE_LRU_COLUMNS]).toEqual([32 * MiB, 16 * MiB, 64]);
    const job = createSliceJob();
    expect(job.store).toBeNull();
    runOk(job, seg(0, 0, 15, 0));
    expect([job.store!.shared, job.store!.blockPool.maxSlots, job.store!.bytePool.maxSlots]).toEqual([false, 4096, 4096]);
  });
});

describe('slice job: samples (SP3a spec §5.1)', () => {
  test.each<[string, Segment]>([
    ['a coast, west to east', COAST],
    ['the same coast, east to west', seg(COAST.bx, COAST.bz, COAST.ax, COAST.az)],
    ['a short steep line across column boundaries', seg(-1999.9, -2003.2, -2001.1, -1985.6)],
    ['from the window\'s negative corner (−524288, −524288), column (−32768, −32768)', seg(-524288, -524288, -524000, -524100)],
    ['from the window\'s last block (524287, 524287), column (32767, 32767), towards negative x and z', seg(524287, 524287, 523900, 524000)],
    ['along the window\'s last row z = 524287 from its first block x = −524288', seg(-524288, 524287, -523800, 524287)],
  ])('%s: sample (i, y) is the voxel (⌊xᵢ⌋, y, ⌊zᵢ⌋) of a region generated in process, byte for byte', (_n, s) => {
    const cols = columnsOf(s);
    const cx0 = Math.min(...cols.map((c) => c[0]));
    const cz0 = Math.min(...cols.map((c) => c[1]));
    const w = Math.max(...cols.map((c) => c[0])) - cx0 + 1;
    const h = Math.max(...cols.map((c) => c[1])) - cz0 + 1;
    const store = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
    genRegionInProcess(store, ctx, cx0, cz0, w, h);
    const view = regionView(store, cx0, cz0, w, h);
    const job = createSliceJob();
    const r = runOk(job, s);
    expect([r.blocks.length, r.fluid.length, r.blocks.buffer.byteLength, r.fluid.buffer.byteLength]).toEqual([SLICE_SAMPLES, SLICE_SAMPLES, 2 * SLICE_SAMPLES, SLICE_SAMPLES]);
    const wantB = new Uint16Array(SLICE_SAMPLES);
    const wantF = new Uint8Array(SLICE_SAMPLES);
    for (let i = 0; i < SLICE_POINTS; i++) {
      const [x, z] = segmentPointAt(s, i);
      for (let y = -64; y <= 319; y++) {
        wantB[(319 - y) * 512 + i] = view.block(Math.floor(x), y, Math.floor(z));
        wantF[(319 - y) * 512 + i] = view.fluid(Math.floor(x), y, Math.floor(z));
      }
    }
    expect(sameBytes(r.blocks, wantB)).toBe(true);
    expect(sameBytes(r.fluid, wantF)).toBe(true);
    // Every column is generated once (the samples of a column are contiguous) and stays resident.
    expect(job.misses).toBe(cols.length);
    expect(job.resident()).toEqual(cols);
  });
  test('the coast slice holds bedrock at row 383, air at row 0, stone, and water sources at and below y 63', () => {
    const r = runOk(createSliceJob(), COAST);
    for (let i = 0; i < SLICE_POINTS; i++) {
      expect([r.blocks[sliceIndex(i, -64)], r.blocks[sliceIndex(i, 319)], r.fluid[sliceIndex(i, 319)]]).toEqual([BEDROCK, AIR, 0]);
    }
    const water = new Set<number>();
    let stone = 0;
    for (let k = 0; k < SLICE_SAMPLES; k++) {
      if (r.blocks[k] === STONE) stone++;
      if (r.fluid[k] !== 0) {
        expect([r.blocks[k], fluidType(r.fluid[k]!), fluidLevel(r.fluid[k]!)]).toEqual([AIR, FLUID_WATER, 0]);
        water.add(319 - Math.floor(k / 512));
      }
    }
    expect(stone).toBeGreaterThan(0);
    expect(Math.max(...water)).toBe(63);
  });
  test('a segment with a problem throws RangeError (the handler answers BAD_ARGS first)', () => {
    const job = createSliceJob();
    expect(() => job.run(ctx, 0, seg(524288, 0, 0, 0), NEVER)).toThrow(RangeError);
    expect(() => job.run(ctx, 0, seg(5, 5, 5, 5), NEVER)).toThrow(/same point/);
  });
});

describe('slice job: a range of the samples (SP3b spec §6)', () => {
  let full: SliceData | null = null;
  const fullCoast = () => (full ??= runOk(createSliceJob(), COAST));
  test.each<[number, number]>([[0, 512], [0, 170], [170, 341], [341, 512], [100, 101], [511, 512], [0, 1]])('[%i, %i): the part holds the full slice\'s samples i ∈ [from, to), row by row; only the range\'s columns are generated', (from, to) => {
    const job = createSliceJob();
    const r = job.run(ctx, 0, COAST, NEVER, from, to);
    if (r === null) throw new Error('slice stopped');
    const w = to - from;
    expect([r.blocks.length, r.fluid.length, r.blocks.buffer.byteLength, r.fluid.buffer.byteLength]).toEqual([w * SLICE_ROWS, w * SLICE_ROWS, 2 * w * SLICE_ROWS, w * SLICE_ROWS]);
    const f = fullCoast();
    for (let y = -64; y <= 319; y++) {
      const at = sliceIndex(from, y);
      expect(sameBytes(r.blocks.subarray(slicePartIndex(from, y, from, to), slicePartIndex(from, y, from, to) + w), f.blocks.subarray(at, at + w)), `blocks y ${y}`).toBe(true);
      expect(sameBytes(r.fluid.subarray(slicePartIndex(from, y, from, to), slicePartIndex(from, y, from, to) + w), f.fluid.subarray(at, at + w)), `fluid y ${y}`).toBe(true);
    }
    const cols = columnsOf(COAST, from, to);
    expect([job.misses, job.resident()]).toEqual([cols.length, cols]);
  });
  test('two ranges that share a column both generate it', () => {
    const cols = columnsOf(COAST);
    // A split point inside a column: samples k − 1 and k fall in the same column.
    let k = 1;
    while (k < SLICE_POINTS && String(columnsOf(COAST, k - 1, k)) !== String(columnsOf(COAST, k, k + 1))) k++;
    expect(k).toBeLessThan(SLICE_POINTS);
    const left = createSliceJob();
    const right = createSliceJob();
    expect(left.run(ctx, 0, COAST, NEVER, 0, k)).not.toBeNull();
    expect(right.run(ctx, 0, COAST, NEVER, k, SLICE_POINTS)).not.toBeNull();
    expect(left.resident().at(-1)).toEqual(right.resident()[0]);
    expect([...left.resident(), ...right.resident().slice(1)]).toEqual(cols);
    expect(left.misses + right.misses).toBe(cols.length + 1);
  });
  test('a bad range throws RangeError (the handler answers BAD_ARGS first)', () => {
    const job = createSliceJob();
    for (const [from, to] of [[-1, 10], [0, 513], [7, 7], [1.5, 10]]) {
      expect(() => job.run(ctx, 0, COAST, NEVER, from!, to!)).toThrow(new RangeError(`slice: points [${from}, ${to}) are not integers with 0 ≤ from < to ≤ 512`));
    }
    expect(job.store).toBeNull();
  });
});

describe('slice job: the LRU (SP3a spec §5.1)', () => {
  test('a second run of the same line generates nothing; the columns move to the most recent end', () => {
    const job = createSliceJob();
    const a = runOk(job, COAST);
    const misses = job.misses;
    const b = runOk(job, COAST);
    expect([job.misses, job.hits]).toEqual([misses, misses]);
    expect(sameBytes(a.blocks, b.blocks) && sameBytes(a.fluid, b.fluid)).toBe(true);
  });
  test('at 64 resident columns a miss frees the least recently used one', () => {
    const job = createSliceJob();
    // cx 0 … 63 at cz 0: 64 columns on 64 different torus records.
    runOk(job, seg(0, 0, 1023, 0));
    expect(job.resident()).toEqual(Array.from({ length: 64 }, (_, cx) => [cx, 0]));
    const store = job.store!;
    const full = live(store);
    // Touch cx 0 … 4 again (they become the most recent), then 10 new columns at cz 1.
    runOk(job, seg(0, 0, 79, 0));
    runOk(job, seg(0, 16, 159, 16));
    const want = [...Array.from({ length: 49 }, (_, k) => [k + 15, 0]), ...Array.from({ length: 5 }, (_, cx) => [cx, 0]), ...Array.from({ length: 10 }, (_, cx) => [cx, 1])];
    expect(job.resident()).toEqual(want);
    for (let cx = 5; cx < 15; cx++) expect(store.proto(cx, 0)).toBeNull();
    // Nothing leaks: the live slots are those of the 64 resident columns.
    expect(live(store)).toEqual(liveOf(want as Array<[number, number]>));
    expect(full).toEqual(liveOf(Array.from({ length: 64 }, (_, cx) => [cx, 0])));
  });
  test('a miss frees the resident column on the same torus record first, even below 64 columns', () => {
    const job = createSliceJob();
    runOk(job, seg(0, 0, 15, 0));
    const store = job.store!;
    const one = liveOf([[0, 0]]);
    expect(live(store)).toEqual(one);
    expect(torusSlot(64, 0)).toBe(torusSlot(0, 0));
    runOk(job, seg(1024, 0, 1039, 0));
    expect(job.resident()).toEqual([[64, 0]]);
    expect([store.proto(0, 0), store.table.find(0, 0)]).toEqual([null, -1]);
    expect(store.proto(64, 0)).not.toBeNull();
    expect(live(store)).toEqual(liveOf([[64, 0]]));
  });
  test('reset frees every resident column and empties the LRU; a run of another epoch resets first', () => {
    const job = createSliceJob();
    runOk(job, COAST, 3);
    const store = job.store!;
    expect(live(store).every((n) => n > 0)).toBe(true);
    job.reset();
    expect([job.resident(), live(store)]).toEqual([[], [0, 0]]);
    runOk(job, COAST, 3);
    const cols = job.resident();
    runOk(job, seg(0, 0, 15, 0), 4);
    expect(job.resident()).toEqual([[0, 0]]);
    for (const [cx, cz] of cols) expect(store.proto(cx, cz)).toBeNull();
    // The column was claimed with the job's epoch.
    expect(Atomics.load(store.table.ints, store.table.find(0, 0) + REC_EPOCH)).toBe(4);
    expect(store).toBe(job.store);
  });
});

describe('slice job: abort (SP3a spec §5.1)', () => {
  test('stop is read before each column; a column stopped half-way is freed by fillColumnT and not inserted', () => {
    const job = createSliceJob();
    const cols = columnsOf(COAST);
    expect(cols.length).toBeGreaterThanOrEqual(3);
    // Column 0: 1 job poll + 6 density polls + 1 surface-pass poll + 24 section polls; column 1: 1 + 31; column 2: its
    // job poll, then the stage's polls: stop at the 5th (in the density phase) …
    let calls = 0;
    expect(job.run(ctx, 0, COAST, () => ++calls > 2 * 32 + 1 + 4)).toBeNull();
    const store = job.store!;
    expect(job.resident()).toEqual(cols.slice(0, 2));
    expect(store.table.find(cols[2]![0], cols[2]![1])).toBe(-1);
    // Live slots are those of the two resident columns: the same as a store holding just them.
    expect(live(store)).toEqual(liveOf(cols.slice(0, 2)));
    // … or in its section phase (before its 5th section): the same.
    const late = createSliceJob();
    let lateCalls = 0;
    expect(late.run(ctx, 0, COAST, () => ++lateCalls > 2 * 32 + 1 + 7 + 4)).toBeNull();
    expect(late.resident()).toEqual(cols.slice(0, 2));
    expect(live(late.store!)).toEqual(liveOf(cols.slice(0, 2)));
    // A stop before the first column generates nothing.
    const fresh = createSliceJob();
    expect(fresh.run(ctx, 0, COAST, () => true)).toBeNull();
    expect([fresh.misses, fresh.resident()]).toEqual([0, []]);
    // The stopped job's resident columns are reused by the next run.
    runOk(job, COAST);
    expect([job.hits, job.misses]).toEqual([2, cols.length]);
    // Every column resident: stop is still read once per column, and a stop on a hit stops the run.
    let polls = 0;
    expect(job.run(ctx, 0, COAST, () => { polls++; return false; })).not.toBeNull();
    expect(polls).toBe(cols.length);
    expect(job.run(ctx, 0, COAST, () => true)).toBeNull();
  });
});

describe('slice job: a line whose columns all share torus record 0 (SP3a spec §8)', () => {
  test('A = (0, 0), B = (523264, 0) refreshed 10 times: byte-equal results and flat live-slot counts', () => {
    const s = seg(0, 0, 523264, 0);
    const cols = columnsOf(s);
    expect(cols.length).toBe(512);
    expect(new Set(cols.map(([cx, cz]) => torusSlot(cx, cz)))).toEqual(new Set([0]));
    const job = createSliceJob();
    const first = runOk(job, s);
    const store = job.store!;
    const after = [...live(store), store.blockPool.slotCount(), store.bytePool.slotCount()];
    expect(job.resident()).toEqual([[32704, 0]]);
    for (let k = 1; k < 10; k++) {
      const r = runOk(job, s);
      expect(sameBytes(r.blocks, first.blocks) && sameBytes(r.fluid, first.fluid), `refresh ${k}`).toBe(true);
      expect([...live(store), store.blockPool.slotCount(), store.bytePool.slotCount()], `refresh ${k}`).toEqual(after);
    }
    expect([job.misses, job.hits, job.resident()]).toEqual([5120, 0, [[32704, 0]]]);
    // The last column equals a fresh in-process fill of (32704, 0).
    const ref = createStore({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
    fillColumnT(ref, ctx, 32704, 0, NEVER);
    const v = ref.proto(32704, 0)!;
    for (let y = -64; y <= 319; y++) expect(first.blocks[sliceIndex(511, y)]).toBe(v.block(0, y, 0));
    expect(colKey(32704, 0)).toBe(colKey(cols[511]![0], cols[511]![1]));
    // 5,120 columns generated: ≈ 6 s alone, several times that while the whole suite loads the CPU.
  }, 120_000);
});

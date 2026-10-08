/**
 * The surface metric's per-column analysis moved into its region worker (SP3c spec §5.1-§5.2; Task 14): each worker
 * accumulates a `SurfaceAcc` of plain counts and the main thread only merges them. The merge must be an exact sum of
 * every field (so the threaded pass equals one pass over every column in any order), the record must survive
 * `postMessage`'s structured clone, and the worker's handler must give the analyser's own record.
 */
import { describe, expect, test } from 'vitest';
import { fillColumnT } from '../../src/metrics/region';
import { seedFromInput } from '../../src/core/seed';
import { AIR, DEEPSLATE, SAND, STONE } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore } from '../../src/world/store/store';
import { paramsWith } from '../harness/gen';
import { createGenContext } from '../../src/gen/context';
import { createSurfaceColumnAnalyser, mergeSurfaceAcc, newSurfaceAcc, type SurfaceAcc } from '../harness/surfaceScatter';
import { createTaskHandler, type SurfaceScatterReply } from '../harness/surfaceScatterWorker';

type Field = number | Float64Array;
const fields = (a: SurfaceAcc): Record<string, Field> => a as unknown as Record<string, Field>;

/** An accumulator whose every number and every array element holds a distinct value derived from `k`. */
function filled(k: number): SurfaceAcc {
  const a = newSurfaceAcc();
  let v = k;
  for (const [name, f] of Object.entries(fields(a))) {
    if (typeof f === 'number') fields(a)[name] = (v += 7);
    else for (let i = 0; i < f.length; i++) f[i] = (v += 3);
  }
  return a;
}

describe('SurfaceAcc', () => {
  test('a new accumulator holds only zeros: numbers and Float64Arrays', () => {
    const a = newSurfaceAcc();
    const entries = Object.entries(fields(a));
    expect(entries.length).toBeGreaterThan(40);
    for (const [name, f] of entries) {
      if (typeof f === 'number') expect(f, name).toBe(0);
      else {
        expect(f, name).toBeInstanceOf(Float64Array);
        expect(f.every((x) => x === 0), name).toBe(true);
      }
    }
  });

  test('mergeSurfaceAcc adds every number and every array element into `into` and leaves `from` alone', () => {
    const x = filled(1);
    const y = filled(1000);
    const xs = structuredClone(x);
    const ys = structuredClone(y);
    const r = mergeSurfaceAcc(x, y);
    expect(r).toBe(x);
    expect(y).toEqual(ys);
    for (const [name, f] of Object.entries(fields(x))) {
      const a = fields(xs)[name]!;
      const b = fields(ys)[name]!;
      if (typeof f === 'number') expect(f, name).toBe((a as number) + (b as number));
      else for (let i = 0; i < f.length; i++) expect(f[i], `${name}[${i}]`).toBe((a as Float64Array)[i]! + (b as Float64Array)[i]!);
    }
  });

  test('merging into a new accumulator copies; the merge is order-independent on counts', () => {
    const parts = [filled(3), filled(50), filled(900)];
    const fwd = parts.reduce((acc, p) => mergeSurfaceAcc(acc, p), newSurfaceAcc());
    const rev = [...parts].reverse().reduce((acc, p) => mergeSurfaceAcc(acc, p), newSurfaceAcc());
    expect(fwd).toEqual(rev);
    expect(mergeSurfaceAcc(newSurfaceAcc(), parts[0]!)).toEqual(parts[0]);
  });

  test('a structured clone (postMessage) keeps the record: same fields, Float64Arrays, values', () => {
    const a = filled(11);
    const c = structuredClone(a);
    expect(c).toEqual(a);
    for (const [name, f] of Object.entries(fields(c))) if (typeof f !== 'number') expect(f, name).toBeInstanceOf(Float64Array);
    expect(mergeSurfaceAcc(newSurfaceAcc(), c)).toEqual(a);
  });

  test('mergeSurfaceAcc rejects records of another shape', () => {
    const missing = fields(newSurfaceAcc());
    delete missing['buried'];
    expect(() => mergeSurfaceAcc(newSurfaceAcc(), missing as unknown as SurfaceAcc)).toThrow(/buried/);
    const extra = { ...newSurfaceAcc(), bogus: 1 };
    expect(() => mergeSurfaceAcc(newSurfaceAcc(), extra)).toThrow(/bogus/);
    const short = newSurfaceAcc();
    fields(short)['blocks'] = new Float64Array(3);
    expect(() => mergeSurfaceAcc(newSurfaceAcc(), short)).toThrow(/blocks/);
    const kind = newSurfaceAcc();
    fields(kind)['buried'] = new Float64Array(1);
    expect(() => mergeSurfaceAcc(newSurfaceAcc(), kind)).toThrow(/buried/);
  });
});

describe('the analyser and the worker handler on real columns', () => {
  const SEED = '42';
  const params = paramsWith();
  const COLS: ReadonlyArray<readonly [number, number]> = [[0, 0], [-124, 7], [-125, -125]];

  /** One accumulator per column, analysed in process. */
  const perColumn = (): SurfaceAcc[] => {
    const ctx = createGenContext(seedFromInput(SEED), params);
    const analyse = createSurfaceColumnAnalyser(SEED, ctx);
    const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
    return COLS.map(([cx, cz]) => {
      const a = newSurfaceAcc();
      expect(fillColumnT(store, ctx, cx, cz, () => false)).toBe(true);
      analyse(store.proto(cx, cz)!, cx, cz, a);
      store.freeColumn(cx, cz);
      return a;
    });
  };

  test('one accumulator over the columns equals the merge of per-column accumulators, in any order', () => {
    const ctx = createGenContext(seedFromInput(SEED), params);
    const analyse = createSurfaceColumnAnalyser(SEED, ctx);
    const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
    const whole = newSurfaceAcc();
    for (const [cx, cz] of [...COLS].reverse()) {
      fillColumnT(store, ctx, cx, cz, () => false);
      analyse(store.proto(cx, cz)!, cx, cz, whole);
      store.freeColumn(cx, cz);
    }
    const parts = perColumn();
    expect(whole.columns).toBe(3);
    expect(whole.positions).toBe(768);
    expect(whole.landTops + whole.wetTops).toBe(768);
    expect(parts.reduce((acc, p) => mergeSurfaceAcc(acc, p), newSurfaceAcc())).toEqual(whole);
  }, 30_000);

  test('a uniform section counts as its 4096 voxels: the store view and a dense copy of it give the same record', () => {
    const ctx = createGenContext(seedFromInput(SEED), params);
    const analyse = createSurfaceColumnAnalyser(SEED, ctx);
    const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
    const uniform = new Set<number>();
    for (const [cx, cz] of COLS) {
      fillColumnT(store, ctx, cx, cz, () => false);
      const view = store.proto(cx, cz)!;
      const dense: ColumnView = {
        cx, cz,
        block: (lx, y, lz) => view.block(lx, y, lz),
        fluid: (lx, y, lz) => view.fluid(lx, y, lz),
        light: (lx, y, lz) => view.light(lx, y, lz),
        sectionBlocks: (sy) => { const b = view.sectionBlocks(sy); return typeof b === 'number' ? new Uint16Array(4096).fill(b) : b; },
        sectionFluid: (sy) => view.sectionFluid(sy),
        aux: () => view.aux(),
        auxB: () => view.auxB(),
      };
      for (let sy = 0; sy < 24; sy++) { const b = view.sectionBlocks(sy); if (typeof b === 'number') uniform.add(b); }
      const a = newSurfaceAcc();
      const d = newSurfaceAcc();
      analyse(view, cx, cz, a);
      analyse(dense, cx, cz, d);
      expect(a).toEqual(d);
      store.freeColumn(cx, cz);
    }
    // The columns hold uniform air, stone and deepslate sections (the counted-whole path is exercised).
    expect([...uniform].sort((x, y) => x - y)).toEqual(expect.arrayContaining([AIR, STONE, DEEPSLATE]));
  }, 30_000);

  test('uniform sections at every height, y 0 … 8 included: counted whole = counted voxel by voxel', () => {
    const ctx = createGenContext(seedFromInput(SEED), params);
    const analyse = createSurfaceColumnAnalyser(SEED, ctx);
    const store = createStore({ shared: false, maxBlockBytes: 8 << 20, maxByteBytes: 8 << 20 });
    fillColumnT(store, ctx, 0, 0, () => false);
    const real = store.proto(0, 0)!;
    // Every section uniform: stone and deepslate alternating up to y 255 (section 4 is y 0 … 15), sand, then air.
    const stateOf = (sy: number): number => (sy < 20 ? (sy % 2 === 0 ? STONE : DEEPSLATE) : sy === 20 ? SAND : AIR);
    const view = (dense: boolean, shift: number): ColumnView => ({
      cx: 0, cz: 0,
      block: (lx, y, lz) => real.block(lx, y, lz),
      fluid: () => 0,
      light: () => 0,
      sectionBlocks: (sy) => (dense ? new Uint16Array(4096).fill(stateOf(sy + shift)) : stateOf(sy + shift)),
      sectionFluid: () => 0,
      aux: () => real.aux(),
      auxB: () => real.auxB(),
    });
    for (const shift of [0, 1]) {
      const a = newSurfaceAcc();
      const d = newSurfaceAcc();
      analyse(view(false, shift), 0, 0, a);
      analyse(view(true, shift), 0, 0, d);
      expect(a).toEqual(d);
      expect(a.stoneAbove8 + a.stoneBelow0).toBe(256 * (16 * (20 - shift) - 9));
    }
    store.freeColumn(0, 0);
  }, 30_000);

  test("the worker handler ('attach', 'column' ×n, 'take') returns the analyser's record and starts a new one", () => {
    const h = createTaskHandler();
    const send = (m: unknown): SurfaceScatterReply => h.handle(m).msg;
    expect(send({ type: 'column', cx: 0, cz: 0 })).toMatchObject({ type: 'error', message: expect.stringMatching(/before 'attach'/) });
    expect(send({ type: 'attach', seedText: SEED, params })).toEqual({ type: 'ready' });
    for (const [cx, cz] of COLS) expect(send({ type: 'column', cx, cz })).toMatchObject({ type: 'done', cx, cz });
    const r = send({ type: 'take' });
    if (r.type !== 'acc') throw new Error(`expected an acc reply, got ${r.type}`);
    expect(r.acc).toEqual(perColumn().reduce((acc, p) => mergeSurfaceAcc(acc, p), newSurfaceAcc()));
    const again = send({ type: 'take' });
    expect(again.type === 'acc' ? again.acc : null).toEqual(newSurfaceAcc());
    expect(send({ type: 'nope' })).toMatchObject({ type: 'error', message: expect.stringMatching(/unknown message 'nope'/) });
  }, 30_000);
});

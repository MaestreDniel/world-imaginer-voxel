/**
 * The zero-allocation harness (SP4b spec §8.5, D25; the method is described in `zeroAlloc.test.ts`' header) and the
 * coordinator at rest it measures, shared by `zeroAlloc.test.ts` and `zeroAllocNoInline.test.ts` (SP6a Task 52d).
 */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect } from 'vitest';
import {
  createCoordinator, createCoordinatorCounts, type Coordinator, type CoordinatorJobs, type StreamStore,
} from '../../../src/engine/coordinator';
import type { Stage } from '../../../src/engine/rings';
import { createThrottle } from '../../../src/engine/throttle';
import type { ColumnMeshPayload } from '../../../src/mesh/column';

v8.setFlagsFromString('--expose-gc');
export const gc = runInNewContext('gc') as (o?: { type: 'major' | 'minor' }) => void;
/** V8's spaces for compiled code and its metadata: not counted (`terrainHeap.test.ts`). */
const JIT_SPACE = /^(code|trusted|shared_trusted)_/;

/** The heap's used bytes without the JIT spaces, read as it is (no gc here). */
export function heapUsed(): number {
  let n = 0;
  for (const s of v8.getHeapSpaceStatistics()) if (!JIT_SPACE.test(s.space_name)) n += s.space_used_size;
  return n;
}

/** The young generation's size now (`new_space`: its two semi-spaces), which a chunk's calls must fill to see a scavenge. */
function youngBytes(): number {
  for (const s of v8.getHeapSpaceStatistics()) if (s.space_name === 'new_space') return s.space_size;
  return 0;
}

/** The growth bound over N calls: under 26 B per call (SP4b spec §8.5). */
export const ZERO_ALLOC_MAX = 256 * 1024;
export const N = 10_000;
export const ATTEMPTS = 3;
/**
 * The measured calls run in chunks of N / CHUNKS, each read on its own: under the full suite's load V8 shrinks the
 * young generation to 1 MB of usable space (its allocation rate per second is low), so the frame step's 1.6-1.9 MB over
 * N ticks forced a scavenge in every attempt; a chunk of 1,000 ticks allocates under 260 KB.
 */
export const CHUNKS = 10;

export interface Growth {
  /** The last attempt's growth over `n` calls; NaN when one of its chunks saw a GC on every try. */
  readonly bytes: number;
  /** Each attempt's growth (NaN as above). */
  readonly readings: readonly number[];
  /** The GCs each attempt's chunks saw (each such chunk was run again). */
  readonly gcs: readonly number[];
  /** Each attempt's GCs by V8's type (`statistics[].gcType`: a scavenge points to allocation in the loop, a mark-sweep to heap pressure). */
  readonly gcTypes: readonly string[];
  /** The calls each reading covers. */
  readonly n: number;
  /** The young generation's size after the last attempt (bytes). */
  readonly young: number;
  /** The calls made, warm-up included. */
  readonly calls: number;
}

/**
 * The growth over `n` calls with no GC in between: a reading, the profiler started, the calls, a reading, the profiler
 * stopped. Taken again, up to `ATTEMPTS` tries, while the profiler saw a GC; NaN when every try saw one. The first try
 * empties only the young generation; a try after one that saw a GC runs a full `gc()` first, which ends any marking in
 * progress (Task 52, minors-7). The GCs seen are counted by type in `types`.
 */
function chunkGrowth(call: () => void, n: number, types: Map<string, number>): { bytes: number; gcs: number; calls: number } {
  let gcs = 0;
  for (let t = 1; t <= ATTEMPTS; t++) {
    // A scavenge (a few milliseconds) on the first try; a full GC after a try that saw one.
    if (t === 1) gc({ type: 'minor' });
    else gc();
    const before = heapUsed();
    const profiler = new v8.GCProfiler();
    profiler.start();
    for (let i = 0; i < n; i++) call();
    const after = heapUsed();
    const stats = profiler.stop()?.statistics ?? [];
    if (stats.length === 0) return { bytes: after - before, gcs, calls: t * n };
    gcs += stats.length;
    for (const s of stats) types.set(s.gcType, (types.get(s.gcType) ?? 0) + 1);
  }
  return { bytes: Number.NaN, gcs, calls: ATTEMPTS * n };
}

/** A count of GCs by type, as the failure message prints it: `Scavenge × 3 MarkSweepCompact × 1`, or `none`. */
const typesText = (types: ReadonlyMap<string, number>): string =>
  types.size === 0 ? 'none' : [...types].map(([t, k]) => `${t} × ${k}`).join(' ');

/**
 * Warms `call` up with `warmUp` calls, then measures the heap growth over `n` (N by default) more with no GC inside a
 * reading: after a double `gc()`, the calls run as `CHUNKS` chunks, each read on its own (`chunkGrowth`), and the
 * growths are summed. An attempt that read `max` or more is followed by another, up to `ATTEMPTS`.
 */
export function allocationOver(call: () => void, warmUp: number, max: number, n = N): Growth {
  for (let i = 0; i < warmUp; i++) call();
  let calls = warmUp;
  const readings: number[] = [];
  const gcs: number[] = [];
  const gcTypes: string[] = [];
  let bytes = Number.NaN;
  for (let a = 0; a < ATTEMPTS; a++) {
    gc();
    gc();
    bytes = 0;
    let seen = 0;
    const types = new Map<string, number>();
    for (let c = 0; c < CHUNKS; c++) {
      const g = chunkGrowth(call, n / CHUNKS, types);
      bytes += g.bytes;
      seen += g.gcs;
      calls += g.calls;
    }
    readings.push(bytes);
    gcs.push(seen);
    gcTypes.push(typesText(types));
    if (bytes < max) break;
  }
  return { bytes, readings, gcs, gcTypes, n, young: youngBytes(), calls };
}

/**
 * The growth is under `max`. NaN (a chunk's growth could not be read) fails with what happened: every try of a chunk
 * saw a GC, which a chunk of calls at rest cannot cause unless it allocates about the young generation's size.
 */
export function expectAtRest(g: Growth, max = ZERO_ALLOC_MAX): void {
  expect(g.bytes, `no reading: in the last attempt a chunk of ${g.n / CHUNKS} calls saw a GC on each of its ${ATTEMPTS} tries, so `
    + `its growth could not be read. A scavenge on every try means those calls allocate about the young generation's `
    + `${g.young} B, far over the bound of ${max} B per ${g.n} calls; a mark-sweep points to heap pressure instead `
    + `(GCs per attempt: ${g.gcs.join(', ')}; by type: ${g.gcTypes.join('; ')})`).not.toBeNaN();
  expect(g.bytes, `heap growth ${g.bytes} bytes over ${g.n} calls (attempts: ${g.readings.join(', ')})`).toBeLessThan(max);
}

/**
 * A store model and jobs that settle at once (the replies arrive in the next microtask): T commits a record at Proto,
 * D at Decorated (block version + 1), L at Published (light version + 1), MESH stages a payload; L and MESH carry the
 * versions they read at their start, as the workers do. Every proto stays alive (`retainAllProtos`).
 */
export function fakeWorld() {
  const slotOf = (cx: number, cz: number): number => (cx & 63) + 64 * (cz & 63);
  const records = new Map<number, { cx: number; cz: number; status: number; block: number; light: number }>();
  const held = (cx: number, cz: number) => {
    const r = records.get(slotOf(cx, cz));
    return r !== undefined && r.cx === cx && r.cz === cz ? r : undefined;
  };
  let staged = 0;
  const store: StreamStore = {
    versionsInto(cx, cz, out) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = 2 * (3 * (dz + 1) + (dx + 1));
          const r = held(cx + dx, cz + dz);
          out[k] = r?.block ?? -1;
          out[k + 1] = r?.light ?? -1;
        }
      }
    },
    holder(cx, cz) {
      const r = records.get(slotOf(cx, cz));
      return r === undefined ? 'free' : r.cx === cx && r.cz === cz ? 'self' : 'other';
    },
    freeColumn(cx, cz) {
      if (held(cx, cz) !== undefined) records.delete(slotOf(cx, cz));
    },
    freeProto() {},
  };
  const jobs: CoordinatorJobs = {
    run(stage: Stage, cx, cz) {
      const versions = new Int32Array(18);
      store.versionsInto(cx, cz, versions);
      if (stage === 'T') records.set(slotOf(cx, cz), { cx, cz, status: 1, block: 1, light: 0 });
      else if (stage === 'D') { const r = held(cx, cz)!; r.status = 2; r.block++; }
      else if (stage === 'L') { const r = held(cx, cz)!; r.status = 3; r.light++; }
      const payload = stage === 'MESH' ? ({ cx, cz, versions } as unknown as ColumnMeshPayload) : null;
      return Promise.resolve({ versions: stage === 'L' || stage === 'MESH' ? versions : null, payload, generation: 0 });
    },
    cancel() {},
    liveWorkers: () => 4,
    generation: () => 0,
  };
  return { store, jobs, sink: { stage() { staged++; }, unstage: () => false, remove() {} }, staged: () => staged };
}

export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A coordinator at RD 12 (the page's default) filled around the camera, with every set done and nothing in flight. */
export async function filledCoordinator(cam: { x: number; z: number; yawDeg: number }): Promise<Coordinator> {
  const w = fakeWorld();
  const c = createCoordinator({
    jobs: w.jobs, store: w.store, sink: w.sink, throttle: createThrottle({ max: 3 }), rd: 12, rdMax: 16,
    retainAllProtos: true, strict: true, generation: 0, epoch: 1, onEvent: (e) => { throw new Error(`unexpected event ${e.kind}`); },
  });
  for (let i = 0; i < 100 && !c.firstFill(); i++) {
    c.update(cam);
    await flush();
  }
  c.update(cam);
  await flush();
  const counts = c.counts(createCoordinatorCounts());
  expect(c.firstFill()).toBe(true);
  for (const s of ['T', 'D', 'L', 'MESH'] as const) {
    expect(counts[s], s).toEqual({ needed: counts[s].needed, done: counts[s].needed, inFlight: 0, queued: 0 });
  }
  expect(w.staged()).toBe(counts.MESH.needed);
  expect([counts.dropped, counts.failed]).toEqual([0, 0]);
  return c;
}

/**
 * The Apply test's loop (SP4c spec §4.10): `apply` alternating epochs 2 and 3 under generation 1 (the fake pool's is 0,
 * so the world holds: no job is issued), each followed by one `update` at the camera.
 */
export function applyLoop(c: Coordinator, cam: { x: number; z: number; yawDeg: number }): () => void {
  // The arguments are made once: the call under test is `apply`, not the caller's literal.
  const to2 = { epoch: 2, generation: 1, from: 'T' } as const;
  const to3 = { epoch: 3, generation: 1, from: 'T' } as const;
  let odd = false;
  return () => {
    c.apply(odd ? to3 : to2);
    odd = !odd;
    c.update(cam);
  };
}

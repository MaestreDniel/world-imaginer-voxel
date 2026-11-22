/**
 * The real streaming coordinator and the real pool against `genRegion` (SP4b spec §8.5, §3.5, §3.7, §2.5): two Node
 * workers (`buildNodeTaskWorker('worldJobs')`, whose `node-worker.mjs` drains its limbo after each reply) on one shared
 * store, seed '42', the default profile, RD 4 around seed 42's spawn column (0, 0) (`uiSmoke.ts`'s `PARITY_VIEW`),
 * proto retention on (`retainAllProtos: false`), strict until the first fill and `setStrict(false)` after it (as the
 * page), a recording sink. A frame is one `update`, the main thread's drain (§2.5: once per frame, after the
 * coordinator's unloads) and one turn of the event loop.
 *
 * - After the first fill, the 7 × 7 window centred on the spawn column (inside the RD 4 MESH disc) has the
 *   `litRegionHash` of `genRegion` at upTo 'L' over the same window.
 * - The camera flies 24 columns east (the start unloads: 24 > RD + 5.5) and back, one column at a time, each step held
 *   until the coordinator's fill around it (so the D set moves under freed protos and `T(protoOnly)` runs); the
 *   window's hash is equal again. A wrapper around the jobs checks, at each D's issue, that its nine columns have live
 *   protos, and, at each `T(protoOnly)`'s result, that the regenerated proto's blocks and fluid equal its final set's
 *   section by section (the final set still shares the original proto's slots, D11, so this compares with the original).
 * - After `dispose()` and every job settled, every thread's limbo drains to 0 (bounded, 5 s) and every pool slot is
 *   free: no slot leaked through a free, a claim collision or the deferred reclamation.
 * - SP7a: the `T(protoOnly)` check skips the fluid of the sections D's settle changed (their final fluid is the settled
 *   one); Review Focus 5's flight (shuffled steps, a teleport, RD 4 → 6 → 4) over DT1's first settle window (settled
 *   sections and a water spring, Task 19) equals `genRegion` on its inner 6 × 6, with no D issued while a column of its
 *   3 × 3 was below Proto.
 */
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { DEFAULTS } from '../../src/core/params/defaults';
import { createCoordinator, worldJobsOf, type CoordinatorJobs, type StreamCamera, type StreamEvent } from '../../src/engine/coordinator';
import { stageOffsets } from '../../src/engine/rings';
import { createThrottle } from '../../src/engine/throttle';
import { createWorkerPool, type WorkerLike, type WorkerPool } from '../../src/engine/workerPool';
import { payloadProblem } from '../../src/mesh/column';
import type { ColumnView } from '../../src/world/store/api';
import { REC_GEN_FLUID_MASK } from '../../src/world/store/columnTable';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { buildNodeTaskWorker } from '../harness/nodeWorker';
import { genRegion, litRegionHash } from '../harness/region';
import { SETTLE_WINDOWS } from '../harness/settleWindows';
import { interiorSprings, settleWindowAt } from '../harness/windowScans';

const MiB = 1 << 20;
const RD = 4;
/** The 7 × 7 window centred on the spawn column (0, 0): its corners (±3, ±3) lie inside the RD 4 MESH disc (18 ≤ 20.25). */
const WIN = { cx0: -3, cz0: -3, w: 7, h: 7 } as const;
/** Columns flown east and back: the start's columns then lie beyond keepVoxels (RD + 5.5). */
const FLIGHT = 24;
/** One frame's turn of the event loop, in ms. */
const FRAME_MS = 2;
/** Every reclaim thread the buffer counts (spec §2.5: 0 … 15). */
const THREADS = 16;

const workers: Worker[] = [];
let script = '';

beforeAll(async () => {
  script = await buildNodeTaskWorker('streaming');
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

/** A worker_threads Worker behind the browser Worker's surface that the pool uses (as `worldJobs.test.ts`). */
function spawnNode(): WorkerLike {
  const w = new Worker(script);
  workers.push(w);
  const like: WorkerLike = {
    postMessage: (msg, transfer) => { w.postMessage(msg, transfer as never); },
    onmessage: null,
    onerror: null,
    terminate: () => { void w.terminate(); },
  };
  w.on('message', (data: unknown) => like.onmessage?.({ data }));
  w.on('error', (e: unknown) => like.onerror?.(e));
  return like;
}

/** What the jobs wrapper saw. */
interface Probe {
  /** D jobs issued, and the D jobs issued with a column of their 3 × 3 without a live proto. */
  d: number;
  deadProtos: string[];
  /** `T(protoOnly)` results, and the regenerated columns whose proto differs from their final set. */
  protoOnly: number;
  mismatches: string[];
  /** Jobs issued and not yet settled. */
  inFlight: number;
}

/** Section sy's blocks or fluid as an array (a uniform section expanded). */
function sectionArray(v: ColumnView, sy: number, what: 'blocks' | 'fluid'): Uint16Array | Uint8Array {
  if (what === 'blocks') {
    const b = v.sectionBlocks(sy);
    return typeof b === 'number' ? new Uint16Array(4096).fill(b) : b.slice();
  }
  const f = v.sectionFluid(sy);
  return typeof f === 'number' ? new Uint8Array(4096).fill(f) : f.slice();
}

/**
 * The first section where column (cx, cz)'s proto and final set differ, or null when they are equal; the fluid of a
 * section D's settle changed (the generated-fluid mask, SP7a D23) is the settled one, so only its blocks are compared.
 */
function protoVersusFinal(store: VoxelStore, cx: number, cz: number): string | null {
  store.enterRead();
  try {
    const p = store.proto(cx, cz);
    const f = store.final(cx, cz);
    if (p === null || f === null) return `(${cx}, ${cz}): proto ${p === null ? 'absent' : 'live'}, final ${f === null ? 'absent' : 'live'}`;
    const mask = store.table.ints[store.table.find(cx, cz) + REC_GEN_FLUID_MASK]!;
    for (let sy = 0; sy < 24; sy++) {
      for (const what of ['blocks', 'fluid'] as const) {
        if (what === 'fluid' && ((mask >>> sy) & 1) !== 0) continue;
        if (!Buffer.from(sectionArray(p, sy, what).buffer).equals(Buffer.from(sectionArray(f, sy, what).buffer))) return `(${cx}, ${cz}): ${what} of section ${sy}`;
      }
    }
    return null;
  } finally {
    store.exitRead();
  }
}

/**
 * The coordinator's jobs, watched: at each D's issue the nine protos it reads are checked live (spec §3.7), and at each
 * `T(protoOnly)`'s result the regenerated proto is compared with its final set (before the coordinator's settle sees
 * it, so nothing has freed it yet).
 */
function watched(inner: CoordinatorJobs, store: VoxelStore, probe: Probe): CoordinatorJobs {
  return {
    run(stage, cx, cz, protoOnly, edit) {
      if (stage === 'D') {
        probe.d++;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (store.proto(cx + dx, cz + dz) === null) probe.deadProtos.push(`D (${cx}, ${cz}): (${cx + dx}, ${cz + dz})`);
          }
        }
      }
      probe.inFlight++;
      const job = inner.run(stage, cx, cz, protoOnly, edit).then((out) => {
        if (stage === 'T' && protoOnly) {
          probe.protoOnly++;
          const diff = protoVersusFinal(store, cx, cz);
          if (diff !== null) probe.mismatches.push(diff);
        }
        return out;
      });
      job.then(() => { probe.inFlight--; }, () => { probe.inFlight--; });
      return job;
    },
    cancel: (pred) => inner.cancel(pred),
    liveWorkers: () => inner.liveWorkers(),
    generation: () => inner.generation(),
  };
}

test('the real coordinator and pool equal genRegion after the first fill, a flight away and back, with no slot leaked', async () => {
  const ref = await genRegion({ seed: '42', params: DEFAULTS, ...WIN, upTo: 'L', order: 'spiral', threads: 1 });
  const expected = ref.view.litHash();

  const store = createStore({ shared: true, maxBlockBytes: 256 * MiB, maxByteBytes: 256 * MiB });
  const pool: WorkerPool = createWorkerPool(2, spawnNode, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  try {
    await pool.attachStore(store.handles());
    expect((await pool.configure('42', DEFAULTS)).type).toBe('ready');

    const probe: Probe = { d: 0, deadProtos: [], protoOnly: 0, mismatches: [], inFlight: 0 };
    const events: StreamEvent[] = [];
    /** The recording sink: the live meshes by colKey (staged, not removed), each payload checked. */
    const live = new Map<number, number>();
    const problems: string[] = [];
    let staged = 0;
    let removed = 0;
    const coordinator = createCoordinator({
      jobs: watched(worldJobsOf(pool), store, probe),
      store,
      sink: {
        stage(p, seq) {
          staged++;
          const problem = payloadProblem(p);
          if (problem !== null) problems.push(`(${p.cx}, ${p.cz}): ${problem}`);
          if (live.has(colKey(p.cx, p.cz))) problems.push(`(${p.cx}, ${p.cz}) staged twice`);
          live.set(colKey(p.cx, p.cz), seq);
        },
        // No renderer and no Apply here: nothing is ever pending to drop (SP4c spec §4.4).
        unstage: () => false,
        remove(cx, cz) {
          removed++;
          if (!live.delete(colKey(cx, cz))) problems.push(`(${cx}, ${cz}) removed while not live`);
        },
      },
      // Two workers: max(1, N − 1) = 1 (spec §3.8); nothing feeds it, so the cap stays at its maximum, as on the page.
      throttle: createThrottle({ max: 1 }),
      rd: RD,
      rdMax: RD,
      retainAllProtos: false,
      strict: true,
      generation: pool.epoch,
      epoch: 1,
      onEvent: (e) => { events.push(e); },
    });
    const fatal = (): string | null => {
      const f = events.find((e) => e.kind === 'fatal');
      return f === undefined || f.kind !== 'fatal' ? null : f.message;
    };

    const frame = async (cam: StreamCamera): Promise<void> => {
      coordinator.update(cam);
      store.drain();
      await new Promise((r) => setTimeout(r, FRAME_MS));
    };
    /** Frames at `cam` until `done()`, failing on a fatal event or after `ms`. */
    const until = async (cam: StreamCamera, done: () => boolean, ms: number, what: string): Promise<void> => {
      const end = Date.now() + ms;
      for (;;) {
        await frame(cam);
        const f = fatal();
        if (f !== null) throw new Error(`${what}: fatal: ${f}`);
        if (done()) return;
        if (Date.now() > end) throw new Error(`${what}: not done after ${ms} ms`);
      }
    };
    const at = (cx: number, yawDeg: number): StreamCamera => ({ x: cx * 16, z: 0, yawDeg });
    /** The live meshes cover the MESH disc around (cx, 0) and lie inside keepMesh (RD + 1.5). */
    const meshesAround = (cx: number): void => {
      for (const [dx, dz] of stageOffsets(RD).MESH) expect(live.has(colKey(cx + dx, dz)), `mesh (${cx + dx}, ${dz})`).toBe(true);
      const keep = (RD + 1.5) * (RD + 1.5);
      const far = [...live.keys()].map((k) => [colKeyCx(k), colKeyCz(k)]).filter(([x, z]) => (x! - cx) ** 2 + z! ** 2 > keep);
      expect(far).toEqual([]);
    };
    const windowHash = (): string => {
      store.enterRead();
      try {
        return litRegionHash(store, WIN.cx0, WIN.cz0, WIN.w, WIN.h);
      } finally {
        store.exitRead();
      }
    };

    // The first entry: strict, the camera held at the spawn (PARITY_VIEW: x 0, z 0, yaw 45).
    await until(at(0, 45), () => coordinator.firstFill(), 60_000, 'the first fill');
    coordinator.setStrict(false);
    expect(windowHash()).toBe(expected);
    meshesAround(0);

    // 24 columns east, one at a time, each step filled; then the start's voxels unload.
    for (let cx = 1; cx <= FLIGHT; cx++) await until(at(cx, 90), () => coordinator.firstFill(), 30_000, `the fill at (${cx}, 0)`);
    const startHeld = (): boolean => {
      for (let cz = WIN.cz0; cz < WIN.cz0 + WIN.h; cz++) for (let cx = WIN.cx0; cx < WIN.cx0 + WIN.w; cx++) if (store.holder(cx, cz) !== 'free') return true;
      return false;
    };
    await until(at(FLIGHT, 90), () => !startHeld(), 10_000, 'the start unload');

    // And back.
    for (let cx = FLIGHT - 1; cx >= 0; cx--) await until(at(cx, 270), () => coordinator.firstFill(), 30_000, `the fill at (${cx}, 0)`);
    expect(windowHash()).toBe(expected);
    meshesAround(0);

    expect(probe.d).toBeGreaterThan(0);
    expect(probe.deadProtos).toEqual([]);
    expect(probe.protoOnly).toBeGreaterThan(0);
    expect(probe.mismatches).toEqual([]);
    expect(problems).toEqual([]);
    expect(events).toEqual([]);

    // Dispose; every job settles, every thread's limbo drains, and every pool slot is free.
    coordinator.dispose();
    const settleEnd = Date.now() + 30_000;
    while (probe.inFlight > 0 && Date.now() < settleEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(probe.inFlight).toBe(0);
    const limbo = (): number[] => Array.from({ length: THREADS }, (_, t) => store.limboCount(t));
    const limboEnd = Date.now() + 5000;
    while (limbo().some((n) => n > 0) && Date.now() < limboEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(limbo()).toEqual(new Array(THREADS).fill(0));
    expect([store.blockPool.freeCount(), store.bytePool.freeCount()]).toEqual([store.blockPool.slotCount(), store.bytePool.slotCount()]);
  } finally {
    pool.terminate();
  }
}, 120_000);

/**
 * Review Focus 5 (SP7a): DT1's first settle window (`SETTLE_WINDOWS[0]`, `settleWindowAt`: 10 × 10 chunks whose inner
 * 6 × 6 holds a coast's spills, a flooded cave border and a water spring, Task 19's re-scan of seed '42'); the camera
 * over its centre.
 */
const SETTLE_AT = settleWindowAt(SETTLE_WINDOWS[0]!.a, SETTLE_WINDOWS[0]!.b);
const SETTLE_WIN = { cx0: SETTLE_AT.cx0, cz0: SETTLE_AT.cz0, w: SETTLE_AT.size, h: SETTLE_AT.size } as const;
const SETTLE_INNER = { cx0: SETTLE_WIN.cx0 + 2, cz0: SETTLE_WIN.cz0 + 2, w: 6, h: 6 } as const;
/** The camera positions of the flight inside the window (columns from its origin), in a shuffled order, each held a few frames. */
const FLIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [[7, 7], [1, 1], [4, 9], [8, 0], [0, 5], [5, 4], [2, 8], [6, 2]]
  .map(([dx, dz]) => [SETTLE_WIN.cx0 + dx!, SETTLE_WIN.cz0 + dz!] as const);
/** The window's centre column, where the camera ends. */
const SETTLE_HOME = [SETTLE_WIN.cx0 + 4, SETTLE_WIN.cz0 + 4] as const;

test('Review Focus 5 (SP7a): a flight in shuffled order with a teleport and RD 4 → 6 → 4 over SETTLE_WINDOWS[0] (settled spills and a water spring) equals genRegion on its inner 6 × 6, and no D was issued while a column of its 3 × 3 was below Proto', async () => {
  const ref = await genRegion({ seed: '42', params: DEFAULTS, ...SETTLE_INNER, upTo: 'L', order: 'spiral', threads: 1 });
  const expected = ref.view.litHash();
  // The inner window holds settled sections (the test is not vacuous).
  const refStore = ref.view.store;
  let settled = 0;
  for (let cz = SETTLE_INNER.cz0; cz < SETTLE_INNER.cz0 + SETTLE_INNER.h; cz++) {
    for (let cx = SETTLE_INNER.cx0; cx < SETTLE_INNER.cx0 + SETTLE_INNER.w; cx++) {
      if (refStore.table.ints[refStore.table.find(cx, cz) + REC_GEN_FLUID_MASK] !== 0) settled++;
    }
  }
  expect(settled, 'columns of the inner 6 × 6 with a settled section').toBeGreaterThan(0);
  // The inner 6 × 6 holds a water spring (Task 19: the settle reads its stream).
  expect(interiorSprings('42', SETTLE_WINDOWS[0]!.a, SETTLE_WINDOWS[0]!.b), 'water springs in the inner 6 × 6').toBeGreaterThan(0);

  const store = createStore({ shared: true, maxBlockBytes: 384 * MiB, maxByteBytes: 384 * MiB });
  const pool: WorkerPool = createWorkerPool(2, spawnNode, { epochCells: store.epochs.cells, onWorkerDead: (t) => store.markDead(t) });
  try {
    await pool.attachStore(store.handles());
    expect((await pool.configure('42', DEFAULTS)).type).toBe('ready');
    const probe: Probe = { d: 0, deadProtos: [], protoOnly: 0, mismatches: [], inFlight: 0 };
    const events: StreamEvent[] = [];
    const live = new Set<number>();
    const coordinator = createCoordinator({
      jobs: watched(worldJobsOf(pool), store, probe),
      store,
      sink: {
        stage(p) { live.add(colKey(p.cx, p.cz)); },
        unstage: () => false,
        remove(cx, cz) { live.delete(colKey(cx, cz)); },
      },
      throttle: createThrottle({ max: 1 }),
      rd: 4,
      rdMax: 6,
      retainAllProtos: false,
      strict: true,
      generation: pool.epoch,
      epoch: 1,
      onEvent: (e) => { events.push(e); },
    });
    const at = (cx: number, cz: number): StreamCamera => ({ x: cx * 16 + 8, z: cz * 16 + 8, yawDeg: 0 });
    const frames = async (cam: StreamCamera, n: number): Promise<void> => {
      for (let k = 0; k < n; k++) {
        coordinator.update(cam);
        store.drain();
        await new Promise((r) => setTimeout(r, FRAME_MS));
        const f = events.find((e) => e.kind === 'fatal');
        if (f !== undefined) throw new Error(`fatal: ${JSON.stringify(f)}`);
      }
    };
    const until = async (cam: StreamCamera, done: () => boolean, ms: number, what: string): Promise<void> => {
      const end = Date.now() + ms;
      for (;;) {
        await frames(cam, 1);
        if (done()) return;
        if (Date.now() > end) throw new Error(`${what}: not done after ${ms} ms`);
      }
    };

    // The first entry, strict, as the page; then non-strict (dropped results are expected under a teleport).
    await until(at(SETTLE_HOME[0], SETTLE_HOME[1]), () => coordinator.firstFill(), 90_000, 'the first fill');
    coordinator.setStrict(false);
    // The flight: each step held a few frames only, so streams cross column borders in a shuffled order mid-fill.
    for (const [cx, cz] of FLIGHT_STEPS) await frames(at(cx, cz), 25);
    // A teleport mid-stream, far away and back.
    await frames(at(SETTLE_HOME[0] + 40, SETTLE_HOME[1] - 30), 25);
    await frames(at(SETTLE_HOME[0], SETTLE_HOME[1]), 10);
    // RD 4 → 6 → 4.
    coordinator.setRenderDistance(6);
    await frames(at(SETTLE_HOME[0], SETTLE_HOME[1]), 40);
    coordinator.setRenderDistance(4);
    await until(at(SETTLE_HOME[0], SETTLE_HOME[1]), () => coordinator.firstFill(), 90_000, 'the fill at home');

    store.enterRead();
    let hash: string;
    try {
      hash = litRegionHash(store, SETTLE_INNER.cx0, SETTLE_INNER.cz0, SETTLE_INNER.w, SETTLE_INNER.h);
    } finally {
      store.exitRead();
    }
    expect(hash).toBe(expected);
    expect(probe.d).toBeGreaterThan(0);
    expect(probe.deadProtos).toEqual([]);
    expect(probe.mismatches).toEqual([]);
    expect(events).toEqual([]);

    coordinator.dispose();
    const settleEnd = Date.now() + 30_000;
    while (probe.inFlight > 0 && Date.now() < settleEnd) {
      store.drain();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(probe.inFlight).toBe(0);
  } finally {
    pool.terminate();
  }
}, 240_000);

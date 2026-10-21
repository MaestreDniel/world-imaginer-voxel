/**
 * The four world jobs through real worker threads (SP4a spec §2.3, §9.7 "Integration"): the task handler bundled by
 * `buildNodeTaskWorker`, two workers behind `createWorkerPool`, on one shared store created here. Attach, configure
 * seed '42', then T on the 7 × 7 around (0, 0), D on the 5 × 5, L on the 3 × 3 and MESH_COLUMN on (0, 0). The payload is
 * valid and equals the in-process mesh of the same store, its versions are the store's, and the light of (0, 0) equals
 * `fillColumnL` run in process on a copy of the world (a second store filled to Decorated in this thread).
 */
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { createWorkerPool, type ColumnDone, type WorkerLike, type WorkerPool } from '../../src/engine/workerPool';
import { createLightScratch } from '../../src/light/initial';
import { fillColumnT } from '../../src/metrics/region';
import { createMeshScratch, payloadProblem } from '../../src/mesh/column';
import { STATUS_PUBLISHED } from '../../src/world/store/columnTable';
import { createStore, type VoxelStore } from '../../src/world/store/store';
import { fillColumnD, fillColumnL, meshColumnJob } from '../../src/workers/worldJobs';
import { ctxFor } from '../harness/gen';
import { buildNodeTaskWorker } from '../harness/nodeWorker';

const MiB = 1 << 20;
const NEVER = () => false;
const workers: Worker[] = [];
let script = '';

beforeAll(async () => {
  script = await buildNodeTaskWorker('worldJobs');
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

/** A worker_threads Worker behind the browser Worker's surface that the pool uses. */
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

/** The (cx, cz) of the (2r + 1)² square around (0, 0). */
const square = (r: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let cz = -r; cz <= r; cz++) for (let cx = -r; cx <= r; cx++) out.push([cx, cz]);
  return out;
};

/** Runs `job` on every column of the square of radius r, and checks each result names its column. */
async function stage(r: number, job: (cx: number, cz: number) => Promise<ColumnDone>): Promise<ColumnDone[]> {
  const cols = square(r);
  const done = await Promise.all(cols.map(([cx, cz]) => job(cx, cz)));
  done.forEach((d, i) => expect([d.cx, d.cz]).toEqual(cols[i]));
  return done;
}

/** Section sy's light, 4096 bytes (a uniform section expanded). */
function lightOf(s: VoxelStore, sy: number): Uint8Array {
  const l = s.final(0, 0)!.sectionLight(sy);
  return typeof l === 'number' ? new Uint8Array(4096).fill(l) : l.slice();
}

test('attach, configure, then T, D, L and MESH_COLUMN through two workers on the shared store', async () => {
  const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
  const pool: WorkerPool = createWorkerPool(2, spawnNode, { abortCell: new Int32Array(new SharedArrayBuffer(4)) });
  try {
    await pool.attachStore(store.handles());
    expect((await pool.configure('42', DEFAULTS)).type).toBe('ready');
    const t = await stage(3, (cx, cz) => pool.terrain(cx, cz));
    const d = await stage(2, (cx, cz) => pool.decorate(cx, cz));
    const l = await stage(1, (cx, cz) => pool.light(cx, cz));
    expect([t.length, d.length, l.length]).toEqual([49, 25, 9]);
    expect([...t, ...d].every((x) => x.versions === null && x.ms >= 0)).toBe(true);
    expect(l.every((x) => x.versions !== null && x.versions.length === 18)).toBe(true);
    for (const [cx, cz] of square(1)) expect(store.table.status(store.table.find(cx, cz))).toBe(STATUS_PUBLISHED);

    const p = await pool.meshColumn(0, 0);
    expect(payloadProblem(p)).toBeNull();
    expect([p.cx, p.cz]).toEqual([0, 0]);
    expect(p.rows.length).toBeGreaterThan(0);
    expect(Array.from(p.versions)).toEqual(Array.from(store.neighborhood(0, 0).versions()));
    // The worker's mesh equals the in-process mesh of the same (Published, never rewritten) store.
    const here = meshColumnJob(store, 0, 0, createMeshScratch(), { ao: MEDIUM.ao, smoothLight: MEDIUM.smoothLight });
    for (const k of ['versions', 'connectivity', 'position', 'data', 'index', 'rows', 'spheres'] as const) {
      expect(Buffer.from(p[k].buffer).equals(Buffer.from(here[k].buffer)), k).toBe(true);
    }

    // The light of (0, 0) equals fillColumnL run in this thread on a copy of the world filled to Decorated.
    const copy = createStore({ shared: false, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
    const ctx = ctxFor('42');
    for (const [cx, cz] of square(2)) expect(fillColumnT(copy, ctx, cx, cz, NEVER)).toBe(true);
    for (const [cx, cz] of square(1)) expect(fillColumnD(copy, ctx, cx, cz, NEVER)).toBe(true);
    expect(fillColumnL(copy, 0, 0, createLightScratch(), NEVER)).not.toBeNull();
    for (let sy = 0; sy < 24; sy++) expect(Buffer.from(lightOf(store, sy)).equals(Buffer.from(lightOf(copy, sy))), `sy ${sy}`).toBe(true);
  } finally {
    pool.terminate();
  }
}, 120_000);

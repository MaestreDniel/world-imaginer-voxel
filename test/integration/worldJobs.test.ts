/**
 * The four world jobs through real worker threads (SP4a spec §2.3, §9.7 "Integration"): the task handler bundled by
 * `buildNodeTaskWorker`, two workers behind `createWorkerPool`, on one shared store created here. Attach, configure
 * seed '42', then T on the 7 × 7 around (0, 0), D on the 5 × 5, L on the 3 × 3 and MESH_COLUMN on (0, 0). The payload is
 * valid and equals the in-process mesh of the same store, its versions are the store's, and the light of (0, 0) equals
 * `fillColumnL` run in process on a copy of the world (a second store filled to Decorated in this thread).
 * SP4b (spec §2.5, §2.8, §3.7): a second attach of the same store succeeds; `T(protoOnly)` through a worker restores
 * the freed proto of the Published (0, 0) (its region hash, versions and status unchanged); an L retried after a partial
 * write releases its old light slots into the worker's limbo while this thread reads, and the wrapper's retry timer
 * drains them once this thread leaves its read section.
 * SP5a (spec §1.2, D23): L's block-light scan runs only when a column of its 3 × 3 has the diff flag (or the region
 * holds lava), shown in process with a torch written into a neighbour's final set as D's overlay writes it.
 * SP5a (spec §2.5, D21): a D whose message carries a diff overlays it through the worker; the L that follows lights the
 * overlaid finals, its light equal to `lightRegion` run here over the same finals.
 */
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEFAULTS } from '../../src/core/params/defaults';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { createWorkerPool, type ColumnDone, type WorkerLike, type WorkerPool } from '../../src/engine/workerPool';
import { decorateStage } from '../../src/gen/pipeline/decorateStage';
import { centreSection, createLightScratch, DEFAULT_LIGHT_TABLES, lightRegion } from '../../src/light/initial';
import { fillColumnT, regionHash } from '../../src/metrics/region';
import { createMeshScratch, payloadProblem } from '../../src/mesh/column';
import { NO_FLUID } from '../../src/world/blocks/fluid';
import { AIR, GLASS, STONE, TORCH } from '../../src/world/blocks/index';
import type { ColumnDiff } from '../../src/world/store/api';
import { STATUS_DECORATED, STATUS_PUBLISHED } from '../../src/world/store/columnTable';
import { copyLightRegion } from '../../src/world/store/padded';
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
  const pool: WorkerPool = createWorkerPool(2, spawnNode, { epochCells: new Int32Array(new SharedArrayBuffer(16)) });
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

    const { payload: p, generation } = await pool.meshColumn(0, 0);
    expect(generation).toBe(0);
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

    // SP4b: the attach is idempotent per worker; T(protoOnly) regenerates (0, 0)'s freed proto as it was.
    await pool.attachStore(store.handles());
    const base = store.table.find(0, 0);
    const record = () => [store.table.blockVersion(base), store.table.lightVersion(base), store.table.status(base)];
    const r0 = record();
    const hash0 = regionHash(store, 0, 0, 1, 1);
    store.freeProto(0, 0);
    expect(store.proto(0, 0)).toBeNull();
    expect(await pool.terrain(0, 0, true)).toMatchObject({ cx: 0, cz: 0, versions: null });
    expect([regionHash(store, 0, 0, 1, 1), record()]).toEqual([hash0, r0]);
    for (const t of [1, 2]) expect(store.limboCount(t), `thread ${t}`).toBe(0);

    // SP4b: (2, 0) at Decorated with its 3 × 3 decorated, then a partial L in this thread (12 setLight, then a throw).
    for (let cz = -2; cz <= 2; cz++) expect(fillColumnT(store, ctx, 4, cz, NEVER)).toBe(true);
    for (let cz = -1; cz <= 1; cz++) expect(fillColumnD(store, ctx, 3, cz, NEVER)).toBe(true);
    let calls = 0;
    const partial: VoxelStore = {
      ...store,
      reopenColumn(cx, cz, from) {
        const w = store.reopenColumn(cx, cz, from);
        return { ...w, setLight(sy, light) { if (calls++ === 12) throw new Error('injected'); w.setLight(sy, light); } };
      },
    };
    expect(() => fillColumnL(partial, 2, 0, createLightScratch(), NEVER)).toThrow('injected');
    // The worker's L resets the partial light while this thread reads: the released slots wait in its limbo...
    const limbo = () => store.limboCount(1) + store.limboCount(2);
    store.enterRead();
    expect((await pool.light(2, 0)).versions).not.toBeNull();
    expect(limbo()).toBeGreaterThan(0);
    store.exitRead();
    // ...until the wrapper's retry (every 16 ms) drains them.
    const until = Date.now() + 2000;
    while (limbo() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    expect(limbo()).toBe(0);
  } finally {
    pool.terminate();
  }
}, 120_000);

/**
 * A store with the 3 × 3 around (0, 0) at Decorated (seed '42', T on the 5 × 5), (1, 0)'s D followed by a torch written
 * into its final set at (lx 0, the first voxel above its motion-blocking top, lz 8) through `replaceBlocks`, as D's
 * diff overlay writes it, and its diff flag set when `flag`. Returns the store and the torch's y.
 */
function decoratedWithTorch(flag: boolean): { store: VoxelStore; y: number } {
  const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
  const ctx = ctxFor('42');
  for (const [cx, cz] of square(2)) expect(fillColumnT(store, ctx, cx, cz, NEVER)).toBe(true);
  let y = 0;
  for (const [cx, cz] of square(1)) {
    if (cx !== 1 || cz !== 0) {
      expect(fillColumnD(store, ctx, cx, cz, NEVER)).toBe(true);
      continue;
    }
    const w = store.reopenColumn(1, 0, 1);
    expect(decorateStage(ctx, store.neighborhood(1, 0), w, NEVER)).toBe(true);
    y = w.aux().motionBlocking[8 * 16]!;
    const sy = (y + 64) >> 4;
    const proto = store.proto(1, 0)!;
    const b = proto.sectionBlocks(sy);
    const f = proto.sectionFluid(sy);
    const blocks = typeof b === 'number' ? new Uint16Array(4096).fill(b) : b.slice();
    const fluid = typeof f === 'number' ? new Uint8Array(4096).fill(f) : f.slice();
    const i = (((y + 64) & 15) << 8) | (8 << 4);
    expect([blocks[i], fluid[i]], 'the torch goes into air').toEqual([AIR, NO_FLUID]);
    blocks[i] = TORCH;
    w.replaceBlocks(sy, blocks, fluid);
    if (flag) w.setDiffFlag();
    w.commit(2);
  }
  return { store, y };
}

test('an L whose 3 × 3 has no flag skips the scan (a torch written into a neighbour\'s final set stays unlit); with the neighbour\'s REC_DIFF_FLAG set, the torch\'s light enters the L\'s column', () => {
  for (const flag of [false, true]) {
    const { store, y } = decoratedWithTorch(flag);
    expect(store.final(1, 0)!.block(0, y, 8)).toBe(TORCH);
    for (const [cx, cz] of square(1)) expect(store.diffFlag(cx, cz), `flag of (${cx}, ${cz})`).toBe(flag && cx === 1 && cz === 0);
    expect(fillColumnL(store, 0, 0, createLightScratch(), NEVER)).not.toBeNull();
    const v = store.final(0, 0)!;
    // (0, 0)'s lx 15 is the torch's west neighbour: 13 with the scan, 0 without; two west, 12.
    expect([v.light(15, y, 8) & 15, v.light(14, y, 8) & 15], `flag ${flag}`).toEqual(flag ? [13, 12] : [0, 0]);
    let lit = 0;
    for (let yy = -64; yy <= 319; yy++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) if ((v.light(lx, yy, lz) & 15) !== 0) lit++;
    if (flag) expect(lit).toBeGreaterThan(0);
    else expect(lit, 'block light in (0, 0) without a flag').toBe(0);
  }
});

test('a D with a diff, then L: the column\'s light equals `lightRegion` over the overlaid finals', async () => {
  const store = createStore({ shared: true, maxBlockBytes: 64 * MiB, maxByteBytes: 64 * MiB });
  const pool: WorkerPool = createWorkerPool(2, spawnNode, { epochCells: new Int32Array(new SharedArrayBuffer(16)) });
  try {
    await pool.attachStore(store.handles());
    expect((await pool.configure('42', DEFAULTS)).type).toBe('ready');
    await stage(2, (cx, cz) => pool.terrain(cx, cz));
    // (0, 0)'s top at (8, 8): the torch goes into the air above it, glass beside it, and the top voxel is dug out to air.
    const proto = store.proto(0, 0)!;
    let top = 319;
    while (proto.block(8, top, 8) === AIR && proto.fluid(8, top, 8) === NO_FLUID) top--;
    const voxel = (lx: number, y: number, lz: number, value: number): [number, number, number] =>
      [(y + 64) >> 4, (((y + 64) & 15) << 8) | (lz << 4) | lx, value];
    const entries = [voxel(8, top, 8, AIR << 8), voxel(8, top + 1, 8, TORCH << 8), voxel(9, top + 1, 8, GLASS << 8), voxel(8, top + 3, 9, STONE << 8)]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const diff: ColumnDiff = {
      sy: Uint8Array.from(entries.map((e) => e[0])), idx: Uint16Array.from(entries.map((e) => e[1])), value: Uint32Array.from(entries.map((e) => e[2])),
    };
    await stage(1, (cx, cz) => (cx === 0 && cz === 0 ? pool.decorate(0, 0, diff) : pool.decorate(cx, cz)));
    expect(store.table.status(store.table.find(0, 0))).toBe(STATUS_DECORATED);
    expect(store.diffFlag(0, 0)).toBe(true);
    const f = store.final(0, 0)!;
    expect([f.block(8, top, 8), f.block(8, top + 1, 8), f.block(9, top + 1, 8), f.block(8, top + 3, 9)]).toEqual([AIR, TORCH, GLASS, STONE]);
    expect(store.proto(0, 0)!.block(8, top + 1, 8), 'the proto stays generated').toBe(AIR);

    expect((await pool.light(0, 0)).versions).not.toBeNull();
    expect(store.table.status(store.table.find(0, 0))).toBe(STATUS_PUBLISHED);
    const s = createLightScratch();
    copyLightRegion(store.neighborhood(0, 0), s.region);
    lightRegion(s, DEFAULT_LIGHT_TABLES, true);
    for (let sy = 0; sy < 24; sy++) expect(Buffer.from(lightOf(store, sy)).equals(Buffer.from(centreSection(s, sy))), `sy ${sy}`).toBe(true);
    expect(store.final(0, 0)!.light(8, top + 1, 8) & 15, 'the torch\'s block light').toBe(14);
  } finally {
    pool.terminate();
  }
}, 120_000);

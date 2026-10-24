/**
 * The pool's world methods (SP4a spec §2.3; rulings P28, P30) with scripted fake workers: `attachStore` and its own
 * barrier, `terrain`/`decorate`/`light` resolving `ColumnDone`, `meshColumn` rebuilding the payload's typed views
 * over the transferred buffers, STORE_FULL as `StoreFullError`, and a reply of an old epoch as `JobCancelled`.
 * SP4b (spec §2.6, §2.8, §3.7): each worker attaches as thread w + 1 and a retried attach succeeds; `cancelWorld`,
 * `liveWorkers`, `onWorkerDead`, `terminate` settling its barriers and busy jobs, STORE_CORRUPT as `StoreCorruptError`,
 * and `terrain(cx, cz, true)`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Stage } from '../../src/engine/rings';
import {
  createBrowserPool, createWorkerPool, JobCancelled, StoreCorruptError, StoreFullError, WorkerFailed, type WorkerLike,
} from '../../src/engine/workerPool';
import type { ToWorker } from '../../src/workers/protocol';
import { createStore, type StoreHandles } from '../../src/world/store/store';
import { fakePayload } from './fixtures/payloads';

const MiB = 1 << 20;
const handles = (): StoreHandles => createStore({ shared: true, maxBlockBytes: 4 * MiB, maxByteBytes: 4 * MiB }).handles();

/** What a scripted worker does with a message: the reply to send, or 'hold' (kept until `release`). */
type Script = (msg: ToWorker) => unknown;

interface ScriptedWorker extends WorkerLike {
  readonly log: ToWorker[];
  /** Sends the held replies of the messages `pick` selects (all by default), in order. */
  release(pick?: (msg: ToWorker) => boolean): void;
  fire(event: unknown): void;
}

const ready = (msg: ToWorker) => ({ type: 'ready', epoch: (msg as { epoch: number }).epoch, stageHashes: {}, genKey: '0000000000000000' });

/**
 * A worker that answers configure with ready, attach with attached, and every other message with `script(msg)`, all
 * asynchronously; `holdAttach` keeps its attached reply until `release`.
 */
function scripted(script: Script, opts: { holdAttach?: boolean; holdJobs?: boolean } = {}): ScriptedWorker {
  const held: Array<{ msg: ToWorker; reply: unknown }> = [];
  const send = (data: unknown) => setTimeout(() => w.onmessage?.({ data }), 0);
  const w: ScriptedWorker = {
    log: [],
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      w.log.push(msg);
      const reply = msg.type === 'configure' ? ready(msg) : msg.type === 'attach' ? { type: 'attached' } : script(msg);
      const hold = msg.type === 'attach' ? opts.holdAttach === true : msg.type !== 'configure' && opts.holdJobs === true;
      if (hold) held.push({ msg, reply });
      else send(reply);
    },
    release(pick = () => true) {
      for (let i = 0; i < held.length;) {
        if (pick(held[i]!.msg)) send(held.splice(i, 1)[0]!.reply);
        else i++;
      }
    },
    fire(event) { w.onerror?.(event); },
    terminate() {},
  };
  return w;
}

/** The world job fields of a message (the script's input). */
const jobOf = (msg: ToWorker) => msg as unknown as { type: string; jobId: number; epoch: number; cx: number; cz: number };
const done = (msg: ToWorker, versions: ArrayBuffer | null = null) => {
  const m = jobOf(msg);
  return { type: 'columnDone', jobId: m.jobId, epoch: m.epoch, job: m.type, cx: m.cx, cz: m.cz, ms: 2.5, versions };
};
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = <T>(p: Promise<T>): Promise<T | Error> => p.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));

describe('attachStore (ruling P28)', () => {
  test('posts attach to every worker and resolves only once each has answered', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(3, () => { const w = scripted(done, { holdAttach: true }); workers.push(w); return w; });
    const h = handles();
    let resolved = false;
    const p = pool.attachStore(h).then(() => { resolved = true; });
    expect(workers.map((w) => w.log.map((m) => m.type))).toEqual([['attach'], ['attach'], ['attach']]);
    expect(workers.every((w) => w.log[0]!.type === 'attach' && w.log[0]!.handles === h)).toBe(true);
    workers[0]!.release();
    workers[2]!.release();
    await tick();
    expect(resolved).toBe(false);
    workers[1]!.release();
    await p;
    expect(resolved).toBe(true);
  });
  test('jobs wait for the attach barrier', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(1, () => { const w = scripted(done, { holdAttach: true }); workers.push(w); return w; });
    await pool.configure('42', {});
    const attached = pool.attachStore(handles());
    const t = pool.terrain(1, 2);
    await tick();
    expect(workers[0]!.log.map((m) => m.type)).toEqual(['configure', 'attach']);
    workers[0]!.release();
    await attached;
    expect(await t).toEqual({ cx: 1, cz: 2, ms: 2.5, versions: null });
    expect(workers[0]!.log.map((m) => m.type)).toEqual(['configure', 'attach', 'terrain']);
  });
  test('an attach answered by an error rejects attachStore', async () => {
    const pool = createWorkerPool(2, () => {
      const w = scripted(done);
      const post = w.postMessage.bind(w);
      w.postMessage = (msg, t) => {
        if (msg.type !== 'attach') { post(msg, t); return; }
        w.log.push(msg);
        setTimeout(() => w.onmessage?.({ data: { type: 'error', jobId: null, epoch: null, code: 'BAD_MESSAGE', message: 'x' } }), 0);
      };
      return w;
    });
    const e = await settle(pool.attachStore(handles()));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message.startsWith('BAD_MESSAGE')).toBe(true);
  });
  test('a worker failing during the attach rejects it with WorkerFailed; an attached reply with no attach pending is ignored', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(2, () => { const w = scripted(done, { holdAttach: true }); workers.push(w); return w; });
    const p = settle(pool.attachStore(handles()));
    workers[0]!.fire({ message: 'boom' });
    expect(await p).toBeInstanceOf(WorkerFailed);
    workers[1]!.release();
    await tick();
    await pool.configure('42', {});
    expect(await pool.terrain(0, 0)).toEqual({ cx: 0, cz: 0, ms: 2.5, versions: null });
  });
});

describe('the world jobs (SP4a spec §2.3, ruling P30)', () => {
  test('terrain, decorate and light resolve ColumnDone; light carries its 18 versions', async () => {
    const sent = Int32Array.from({ length: 18 }, (_, i) => i * 3 - 1);
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(1, () => {
      const w = scripted((msg) => (msg.type === 'light' ? done(msg, sent.slice().buffer) : done(msg)));
      workers.push(w);
      return w;
    });
    await pool.configure('42', {});
    await pool.attachStore(handles());
    expect(await pool.terrain(3, -4)).toEqual({ cx: 3, cz: -4, ms: 2.5, versions: null });
    expect(await pool.decorate(3, -4)).toEqual({ cx: 3, cz: -4, ms: 2.5, versions: null });
    const l = await pool.light(3, -4);
    expect([l.cx, l.cz, l.ms]).toEqual([3, -4, 2.5]);
    expect(l.versions).toBeInstanceOf(Int32Array);
    expect(Array.from(l.versions!)).toEqual(Array.from(sent));
    expect(workers[0]!.log.map((m) => m.type)).toEqual(['configure', 'attach', 'terrain', 'decorate', 'light']);
  });
  test('the world jobs run at priority 0 in queue order: a point (priority −1) queued after them runs first', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(1, () => {
      const w = scripted((msg) => (msg.type === 'point' ? { type: 'pointResult', jobId: jobOf(msg).jobId, epoch: jobOf(msg).epoch, fields: {} }
        : done(msg, msg.type === 'light' ? new ArrayBuffer(72) : null)), { holdJobs: true });
      workers.push(w);
      return w;
    });
    await pool.configure('42', {});
    const first = pool.terrain(0, 0);
    const jobs = [pool.decorate(1, 0), pool.light(2, 0)];
    const point = pool.point(5, 5);
    workers[0]!.release();
    await first;
    workers[0]!.release();
    await point;
    workers[0]!.release();
    await jobs[0];
    workers[0]!.release();
    await jobs[1];
    expect(workers[0]!.log.map((m) => m.type)).toEqual(['configure', 'terrain', 'point', 'decorate', 'light']);
  });
  test('meshColumn rebuilds the typed views over the transferred buffers', async () => {
    const p = fakePayload(7, 8, [{ sy: 3, pass: 0, quads: 4 }, { sy: 9, pass: 2, quads: 2 }]);
    p.versions.set(Array.from({ length: 18 }, (_, i) => i + 1));
    p.connectivity.set(Array.from({ length: 24 }, (_, i) => i * 100));
    const bufs = [p.versions, p.connectivity, p.position, p.data, p.index, p.rows, p.spheres].map((a) => a.buffer);
    const pool = createWorkerPool(1, () => scripted((msg) => {
      const m = jobOf(msg);
      const [versions, connectivity, position, data, index, rows, spheres] = bufs;
      return { type: 'meshColumnResult', jobId: m.jobId, epoch: m.epoch, cx: m.cx, cz: m.cz, ms: 4, versions, connectivity, position, data, index, rows, spheres };
    }));
    await pool.configure('42', {});
    const r = await pool.meshColumn(7, 8);
    expect([r.cx, r.cz]).toEqual([7, 8]);
    const views = [r.versions, r.connectivity, r.position, r.data, r.index, r.rows, r.spheres];
    const types = [Int32Array, Uint16Array, Uint8Array, Uint32Array, Uint32Array, Int32Array, Float32Array];
    views.forEach((v, i) => {
      expect(v).toBeInstanceOf(types[i]!);
      expect(v.buffer).toBe(bufs[i]);
      expect([v.byteOffset, v.byteLength]).toEqual([0, bufs[i]!.byteLength]);
    });
    expect(Array.from(r.versions)).toEqual(Array.from(p.versions));
    expect(Array.from(r.connectivity)).toEqual(Array.from(p.connectivity));
    expect(Array.from(r.rows)).toEqual(Array.from(p.rows));
    expect(Array.from(r.spheres)).toEqual(Array.from(p.spheres));
  });
  test('STORE_FULL rejects with StoreFullError; other codes with a plain Error', async () => {
    const pool = createWorkerPool(1, () => scripted((msg) => {
      const m = jobOf(msg);
      return { type: 'error', jobId: m.jobId, epoch: m.epoch, code: m.cx === 0 ? 'STORE_FULL' : 'INTERNAL', message: 'pool of 8192-byte slots is full' };
    }));
    await pool.configure('42', {});
    const full = await settle(pool.terrain(0, 0));
    expect(full).toBeInstanceOf(StoreFullError);
    expect((full as Error).message).toMatch(/^STORE_FULL: pool of 8192-byte slots is full/);
    const other = await settle(pool.decorate(1, 0));
    expect(other).not.toBeInstanceOf(StoreFullError);
    expect((other as Error).message).toMatch(/^INTERNAL/);
  });
  test('a reply naming another column or job rejects', async () => {
    const pool = createWorkerPool(1, () => scripted((msg) => ({ ...done(msg), cx: jobOf(msg).cx + 1 })));
    await pool.configure('42', {});
    await expect(pool.terrain(0, 0)).rejects.toThrow(/column \(1, 0\).*expected terrain \(0, 0\)/);
  });
  test('a reply of an old epoch is JobCancelled', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(1, () => { const w = scripted(done, { holdJobs: true }); workers.push(w); return w; });
    await pool.configure('42', {});
    const t = settle(pool.terrain(0, 0));
    const m = settle(pool.meshColumn(0, 0));
    await tick();
    const next = pool.configure('42', {});
    workers[0]!.release();
    expect(await t).toBeInstanceOf(JobCancelled);
    expect(await m).toBeInstanceOf(JobCancelled);
    expect((await next).epoch).toBe(1);
  });
});

describe('SP4b: the pool\'s own fixes (SP4b spec §2.6, §2.8, §3.7)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('each worker attaches as thread w + 1', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(3, () => { const w = scripted(done); workers.push(w); return w; });
    await pool.attachStore(handles());
    expect(workers.map((w) => (w.log[0] as { thread?: number }).thread)).toEqual([1, 2, 3]);
  });

  test('terrain(cx, cz, true) posts protoOnly: true; the default posts no protoOnly', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(1, () => { const w = scripted(done); workers.push(w); return w; });
    await pool.configure('42', {});
    expect(await pool.terrain(1, 2, true)).toEqual({ cx: 1, cz: 2, ms: 2.5, versions: null });
    expect(await pool.terrain(3, 4)).toEqual({ cx: 3, cz: 4, ms: 2.5, versions: null });
    const [a, b] = workers[0]!.log.filter((m) => m.type === 'terrain');
    expect(a).toMatchObject({ cx: 1, cz: 2, protoOnly: true });
    expect(b).not.toHaveProperty('protoOnly');
  });

  test('cancelWorld drops matching queued world jobs only', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(1, () => {
      const w = scripted((msg) => (msg.type === 'point' ? { type: 'pointResult', jobId: jobOf(msg).jobId, epoch: jobOf(msg).epoch, fields: {} }
        : msg.type === 'meshColumn' ? { type: 'error', jobId: jobOf(msg).jobId, epoch: jobOf(msg).epoch, code: 'INTERNAL', message: 'unused' }
          : done(msg, msg.type === 'light' ? new ArrayBuffer(72) : null)), { holdJobs: true });
      workers.push(w);
      return w;
    });
    await pool.configure('42', {});
    const running = settle(pool.terrain(1, 0));
    const queued = [settle(pool.terrain(1, 1)), settle(pool.decorate(1, 0)), settle(pool.light(2, 0)), settle(pool.meshColumn(3, 0)), settle(pool.decorate(5, 0))];
    const point = settle(pool.point(1, 0));
    expect(pool.queued).toBe(6);
    const seen: Array<[Stage, number, number]> = [];
    pool.cancelWorld((stage, cx, cz) => { seen.push([stage, cx, cz]); return cx === 1 || stage === 'MESH'; });
    // The predicate sees each queued world job once (not the running one, nor the point).
    expect(seen).toEqual([['T', 1, 1], ['D', 1, 0], ['L', 2, 0], ['MESH', 3, 0], ['D', 5, 0]]);
    expect(pool.queued).toBe(3);
    for (const i of [0, 1, 3]) expect(await queued[i]!).toBeInstanceOf(JobCancelled);
    for (let k = 0; k < 4; k++) { workers[0]!.release(); await tick(); }
    expect(await running).toEqual({ cx: 1, cz: 0, ms: 2.5, versions: null });
    expect(await point).toEqual({});
    expect(await queued[2]!).toMatchObject({ cx: 2, cz: 0 });
    expect(await queued[4]!).toMatchObject({ cx: 5, cz: 0 });
  });

  test('liveWorkers counts down on a failure and onWorkerDead receives thread w + 1 (also when given through createBrowserPool\'s options, which forwards it)', async () => {
    const dead: number[] = [];
    const order: string[] = [];
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(3, () => { const w = scripted(done, { holdJobs: true }); workers.push(w); return w; }, {
      onWorkerDead: (t) => { dead.push(t); order.push(`dead ${t}`); },
      onFailure: () => order.push('failure'),
    });
    await pool.configure('42', {});
    const jobs = [0, 1, 2].map((cx) => settle(pool.terrain(cx, 0)).then((r) => { order.push(r instanceof Error ? `rejected ${cx}` : `done ${cx}`); return r; }));
    expect(pool.liveWorkers()).toBe(3);
    workers[1]!.fire({ message: 'boom' });
    expect([pool.liveWorkers(), dead]).toEqual([2, [2]]);
    expect(await jobs[1]!).toBeInstanceOf(WorkerFailed);
    // Called before the failed worker's rejections settle.
    expect(order.slice(0, 2)).toEqual(['dead 2', 'failure']);
    workers[2]!.fire({ message: 'boom' });
    expect([pool.liveWorkers(), dead]).toEqual([1, [2, 3]]);
    workers[0]!.release();
    expect(await jobs[0]!).toMatchObject({ cx: 0 });

    // createBrowserPool forwards onWorkerDead to the pool.
    const spawned: ScriptedWorker[] = [];
    vi.stubGlobal('Worker', function FakeWorker() { const w = scripted(done); spawned.push(w); return w; });
    const viaBrowser: number[] = [];
    const browser = createBrowserPool(2, { epochCells: null, onWorkerDead: (t) => viaBrowser.push(t) });
    expect(browser.liveWorkers()).toBe(2);
    spawned[0]!.fire({ message: 'boom' });
    expect([browser.liveWorkers(), viaBrowser]).toEqual([1, [1]]);
    browser.terminate();
  });

  test('terminate during an attach rejects attachStore and every busy job with WorkerFailed(\'terminated\')', async () => {
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(2, () => { const w = scripted(done, { holdAttach: true, holdJobs: true }); workers.push(w); return w; });
    await pool.configure('42', {});
    const busy = [settle(pool.terrain(0, 0)), settle(pool.decorate(1, 0))];
    const queued = settle(pool.light(2, 0));
    expect(pool.probe().busy).toBe(2);
    const attach = settle(pool.attachStore(handles()));
    const configure = settle(pool.configure('42', {}));
    pool.terminate();
    for (const p of [attach, configure, ...busy]) {
      const e = await p;
      expect(e).toBeInstanceOf(WorkerFailed);
      expect((e as Error).message).toBe('terminated');
    }
    // The queue rejects as before: the configure had already emptied it (JobCancelled).
    expect(await queued).toBeInstanceOf(JobCancelled);
    // Late replies of terminated workers change nothing.
    for (const w of workers) w.release();
    await tick();
    expect(pool.probe().busy).toBe(0);
  });

  test('terminate calls onWorkerDead for every worker it silences (thread w + 1), not again for one that already failed, before its busy jobs settle (rulings R15, ENG-2)', async () => {
    const dead: number[] = [];
    const order: string[] = [];
    const workers: ScriptedWorker[] = [];
    const pool = createWorkerPool(3, () => { const w = scripted(done, { holdJobs: true }); workers.push(w); return w; }, {
      onWorkerDead: (t) => { dead.push(t); order.push(`dead ${t}`); },
    });
    await pool.configure('42', {});
    const jobs = [0, 1, 2].map((cx) => settle(pool.terrain(cx, 0)).then((r) => { order.push(r instanceof Error ? `rejected ${cx}` : `done ${cx}`); return r; }));
    workers[1]!.fire({ message: 'boom' });
    expect(dead).toEqual([2]);
    await jobs[1];
    order.length = 0;
    pool.terminate();
    expect(dead).toEqual([2, 1, 3]);
    for (const p of [jobs[0]!, jobs[2]!]) expect(((await p) as Error).message).toBe('terminated');
    // The dead marks come first: a settle's free on the main thread meets a lock a terminated worker held as dead.
    expect(order).toEqual(['dead 1', 'dead 3', 'rejected 0', 'rejected 2']);
    pool.terminate();
    expect(dead).toEqual([2, 1, 3]);
  });

  test('a retried attachStore after one worker answered BAD_MESSAGE resolves once each live worker answered attached', async () => {
    const workers: ScriptedWorker[] = [];
    let n = 0;
    const pool = createWorkerPool(2, () => {
      const first = n++ === 0;
      const w = scripted(done, { holdAttach: !first });
      if (first) {
        // Worker 1 refuses its first attach, then accepts.
        let attaches = 0;
        const post = w.postMessage.bind(w);
        w.postMessage = (msg, t) => {
          if (msg.type !== 'attach' || attaches++ > 0) { post(msg, t); return; }
          w.log.push(msg);
          setTimeout(() => w.onmessage?.({ data: { type: 'error', jobId: null, epoch: null, code: 'BAD_MESSAGE', message: 'malformed message' } }), 0);
        };
      }
      workers.push(w);
      return w;
    });
    const h = handles();
    const first = await settle(pool.attachStore(h));
    expect((first as Error).message).toBe('BAD_MESSAGE: malformed message');
    let resolved = false;
    const retry = pool.attachStore(h).then(() => { resolved = true; });
    await tick();
    // Worker 1 answered the retry; worker 2's answer to the first attach arrives now and must not count for the retry.
    workers[1]!.release((m) => m === workers[1]!.log[0]);
    await tick();
    expect(resolved).toBe(false);
    workers[1]!.release();
    await retry;
    expect(resolved).toBe(true);
    expect(workers.map((w) => w.log.filter((m) => m.type === 'attach').map((m) => (m as { thread: number }).thread))).toEqual([[1, 1], [2, 2]]);
  });

  test('STORE_CORRUPT rejects with StoreCorruptError', async () => {
    const pool = createWorkerPool(1, () => scripted((msg) => {
      const m = jobOf(msg);
      return { type: 'error', jobId: m.jobId, epoch: m.epoch, code: 'STORE_CORRUPT', message: 'pool lock held by failed thread 2' };
    }));
    await pool.configure('42', {});
    const e = await settle(pool.decorate(0, 0));
    expect(e).toBeInstanceOf(StoreCorruptError);
    expect([(e as Error).name, (e as Error).message]).toEqual(['StoreCorruptError', 'STORE_CORRUPT: pool lock held by failed thread 2']);
  });
});

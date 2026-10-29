/**
 * The page's edit path (SP5a spec §2.1, §2.6, §2.7): the gate, the sim pins around a post, `markEdited` with the
 * reply's dirty set in the reply's task, the latency sample, the refusals, and the sim's failure (with a real
 * coordinator over a small fake world for the pins' release).
 */
import { describe, expect, test, vi } from 'vitest';
import { colKey } from '../../src/core/coords';
import {
  createCoordinator, type Coordinator, type CoordinatorJobs, type JobOutcome, type StreamCamera, type StreamStore,
} from '../../src/engine/coordinator';
import { KEEP_VOXELS_EXTRA, M_KEEP_VOXELS, membershipTable } from '../../src/engine/rings';
import { createSimClient, SimFailed, type SimWorkerLike } from '../../src/engine/simClient';
import { createThrottle } from '../../src/engine/throttle';
import type { ColumnMeshPayload } from '../../src/mesh/column';
import type { Edit, EditedMsg } from '../../src/workers/protocol';
import { SIM_THREAD } from '../../src/world/store/reclaim';
import { createEditLatency, type EditLatency } from '../../src/ui/world/editLatency';
import { createEditPath } from '../../src/ui/world/editPath';
import { onSimFailure } from '../../src/ui/world/worldPage';

const STONE = 1 << 8;
const at = (x: number, z: number): Edit => ({ x, y: 70, z, op: 'set', value: STONE, expect: 0 });
const reply = (n: number, o: Partial<EditedMsg> = {}): EditedMsg => ({
  type: 'edited', id: 1, prev: new Uint32Array(n).fill(0xFFFFFFFF), next: new Uint32Array(n).fill(STONE),
  dirty: new Float64Array([colKey(0, 0), colKey(1, 0)]), entryCols: new Float64Array([colKey(0, 0)]), refused: null,
  relightMs: 0.75, editMs: 1.5, ...o,
});

/** A sim whose `edits` the test answers by hand, and a coordinator that logs the calls the path makes. */
function fakes(states: (cx: number, cz: number) => 0 | 1 | 2 = () => 0) {
  const log: string[] = [];
  const answers: Array<{ resolve(m: EditedMsg): void; reject(e: Error): void }> = [];
  const sim = {
    failed: false,
    edits: vi.fn((e: readonly Edit[]) => {
      log.push(`edits ${e.length}`);
      return new Promise<EditedMsg>((resolve, reject) => { answers.push({ resolve, reject }); });
    }),
  };
  const coordinator = {
    editState: (cx: number, cz: number) => states(cx, cz),
    simPin: vi.fn((cx: number, cz: number) => { log.push(`pin ${cx},${cz}`); }),
    simUnpin: vi.fn((cx: number, cz: number) => { log.push(`unpin ${cx},${cz}`); }),
    markEdited: vi.fn((keys: ArrayLike<number>) => { log.push(`markEdited ${keys.length}`); }),
  };
  const latency: EditLatency = createEditLatency();
  const posted = vi.spyOn(latency, 'posted');
  const notices = { show: vi.fn<(text: string, ms: number) => void>() };
  let t = 0;
  const path = createEditPath({ sim, coordinator, latency, now: () => t, notices });
  return { log, answers, sim, coordinator, latency, posted, notices, path, setNow: (v: number) => { t = v; } };
}

describe('createEditPath (SP5a spec §2.1, §2.6, §2.7)', () => {
  test('a post pins each edited column\'s 3 × 3 once, unpins at the reply, calls `markEdited` with `dirty` in the reply\'s task', async () => {
    const f = fakes();
    // Two edits in column (0, 0), one in (1, 0): two pins, one batch.
    const p = f.path.post([at(3, 4), at(5, 6), at(17, 4)]);
    expect(f.log).toEqual(['pin 0,0', 'pin 1,0', 'edits 3']);
    expect(f.path.pending()).toBe(true);
    const r = reply(3);
    f.answers[0]!.resolve(r);
    // In the reply's task: done once the promise jobs run, with no timer or frame between (a macrotask would come after).
    let macrotask: string[] | null = null;
    setTimeout(() => { macrotask = [...f.log]; }, 0);
    const out = await p;
    expect(macrotask).toBeNull();
    expect(out).toEqual({ ok: true, prev: r.prev, next: r.next });
    expect(f.log).toEqual(['pin 0,0', 'pin 1,0', 'edits 3', 'unpin 0,0', 'unpin 1,0', 'markEdited 2']);
    expect(f.coordinator.markEdited).toHaveBeenCalledWith(r.dirty);
    expect(f.path.pending()).toBe(false);
  });

  test('`editState` 2 → `{ ok: false, why: \'regenerating\' }` and nothing posted', async () => {
    const f = fakes((cx) => (cx === 1 ? 2 : 0));
    expect(await f.path.post([at(3, 4), at(17, 4)])).toEqual({ ok: false, why: 'regenerating' });
    expect(f.sim.edits).not.toHaveBeenCalled();
    expect(f.coordinator.simPin).not.toHaveBeenCalled();
    const g = fakes(() => 1);
    expect(await g.path.post([at(3, 4)])).toEqual({ ok: false, why: 'unloaded' });
    expect(g.sim.edits).not.toHaveBeenCalled();
    expect(g.log).toEqual([]);
  });

  test('a sim rejection (`SimFailed`) → `failed`, and the post calls no `simUnpin`', async () => {
    const f = fakes();
    const p = f.path.post([at(3, 4)]);
    f.answers[0]!.reject(new SimFailed('the sim failed: an error event'));
    expect(await p).toEqual({ ok: false, why: 'failed' });
    expect(f.coordinator.simUnpin).not.toHaveBeenCalled();
    expect(f.coordinator.markEdited).not.toHaveBeenCalled();
    expect(f.posted).not.toHaveBeenCalled();
    expect(f.path.pending()).toBe(false);
  });

  test('after `disable`, a `post` resolves `failed` with nothing posted', async () => {
    const f = fakes();
    expect(f.path.enabled).toBe(true);
    f.path.disable();
    expect(f.path.enabled).toBe(false);
    expect(await f.path.post([at(3, 4)])).toEqual({ ok: false, why: 'failed' });
    expect(f.log).toEqual([]);
    // A failed sim closes the path too.
    const g = fakes();
    g.sim.failed = true;
    expect(g.path.enabled).toBe(false);
    expect(await g.path.post([at(3, 4)])).toEqual({ ok: false, why: 'failed' });
    expect(g.log).toEqual([]);
  });

  test('`full` shows the notice', async () => {
    const f = fakes();
    const p = f.path.post([at(3, 4)]);
    // A rolled-back batch still names the columns to remesh (their versions moved, §2.2).
    const r = reply(1, { refused: 'full', prev: new Uint32Array([0xFFFFFFFF]), next: new Uint32Array([0xFFFFFFFF]) });
    f.answers[0]!.resolve(r);
    expect(await p).toEqual({ ok: false, why: 'full' });
    expect(f.notices.show).toHaveBeenCalledTimes(1);
    expect(f.notices.show).toHaveBeenCalledWith('Could not edit: memory full', 4000);
    expect(f.coordinator.markEdited).toHaveBeenCalledWith(r.dirty);
    expect(f.log.filter((l) => l.startsWith('unpin'))).toEqual(['unpin 0,0']);
    // A refusal is no edit: no latency sample.
    expect(f.posted).not.toHaveBeenCalled();
    // Other refusals show nothing here (the block history words them, D13).
    const g = fakes();
    const q = g.path.post([at(3, 4)]);
    g.answers[0]!.resolve(reply(1, { refused: 'changed', dirty: new Float64Array(0) }));
    expect(await q).toEqual({ ok: false, why: 'changed' });
    expect(g.notices.show).not.toHaveBeenCalled();
  });

  test('`settled` resolves after the pending replies and their continuations', async () => {
    const f = fakes();
    const log: string[] = [];
    // Nothing pending: at once.
    await f.path.settled();
    const p1 = f.path.post([at(3, 4)]);
    void p1.then(() => { log.push('continuation 1'); });
    const p2 = f.path.post([at(5, 6)]);
    void p2.then(() => { log.push('continuation 2'); });
    void f.path.settled().then(() => { log.push(`settled (pending: ${f.path.pending()})`); });
    f.answers[0]!.resolve(reply(1));
    await p1;
    await Promise.resolve();
    expect(log).toEqual(['continuation 1']);
    f.answers[1]!.resolve(reply(1));
    await p2;
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['continuation 1', 'continuation 2', 'settled (pending: false)']);
    // A post made while waiting is waited for too.
    const p3 = f.path.post([at(3, 4)]);
    void p3.then(() => { log.push('continuation 3'); });
    const waited = f.path.settled().then(() => { log.push('settled again'); });
    const p4 = f.path.post([at(5, 6)]);
    void p4.then(() => { log.push('continuation 4'); });
    f.answers[2]!.resolve(reply(1));
    await p3;
    await new Promise((r) => setTimeout(r, 0));
    expect(log.slice(3)).toEqual(['continuation 3']);
    f.answers[3]!.resolve(reply(1));
    await waited;
    expect(log.slice(3)).toEqual(['continuation 3', 'continuation 4', 'settled again']);
  });

  test('the reply\'s `relightMs` and `editMs` reach `latency.posted`', async () => {
    const f = fakes();
    f.setNow(100);
    const p = f.path.post([at(17, 4), at(3, 4)]);
    f.setNow(104);
    const r = reply(2, { relightMs: 2.25, editMs: 3.5 });
    f.answers[0]!.resolve(r);
    await p;
    // The edited column is the first edit's.
    expect(f.posted).toHaveBeenCalledTimes(1);
    expect(f.posted).toHaveBeenCalledWith(100, 104, colKey(1, 0), r.dirty, 2.25, 3.5, 100);
  });

  test('a click\'s time starts its latency sample: a click at 100, its frame\'s post at 120, the reply at 125, the reveal at 150 give visible 50 (spec §4.6; final review UI-3)', async () => {
    const f = fakes();
    f.setNow(120);
    const p = f.path.post([at(3, 4)], 100);
    f.setNow(125);
    f.answers[0]!.resolve(reply(1, { dirty: new Float64Array([colKey(0, 0)]) }));
    await p;
    expect(f.posted).toHaveBeenCalledWith(120, 125, colKey(0, 0), expect.anything(), 0.75, 1.5, 100);
    f.latency.staged(0, 0, 130);
    f.latency.revealed(0, 0, 150);
    expect(f.latency.visibleP95()).toBe(50);
    expect(Array.from(f.latency.samples().reply)).toEqual([5]);
  });
});

// ---------------------------------------------------------------- a real coordinator over a small fake world

const slotOf = (cx: number, cz: number): number => (cx & 63) + 64 * (cz & 63);

/** Records per torus slot (column, status 1 … 3, block and light versions), jobs settled by hand, a sink that keeps nothing. */
function fakeWorld() {
  const records = new Map<number, { cx: number; cz: number; status: number; block: number; light: number }>();
  const frees: Array<readonly [number, number]> = [];
  const pending: Array<() => void> = [];
  const held = (cx: number, cz: number) => {
    const r = records.get(slotOf(cx, cz));
    return r !== undefined && r.cx === cx && r.cz === cz ? r : null;
  };
  const store: StreamStore = {
    versionsInto(cx, cz, out) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = 2 * (3 * (dz + 1) + (dx + 1));
          const r = held(cx + dx, cz + dz);
          out[k] = r === null ? -1 : r.block;
          out[k + 1] = r === null ? -1 : r.light;
        }
      }
    },
    holder(cx, cz) {
      const r = records.get(slotOf(cx, cz));
      return r === undefined ? 'free' : r.cx === cx && r.cz === cz ? 'self' : 'other';
    },
    freeColumn(cx, cz) {
      if (held(cx, cz) === null) return;
      records.delete(slotOf(cx, cz));
      frees.push([cx, cz]);
    },
    freeProto() {},
  };
  const jobs: CoordinatorJobs = {
    run(stage, cx, cz) {
      const versions = new Int32Array(18);
      store.versionsInto(cx, cz, versions);
      return new Promise<JobOutcome>((resolve) => {
        pending.push(() => {
          if (stage === 'T') records.set(slotOf(cx, cz), { cx, cz, status: 1, block: 1, light: 0 });
          else if (stage === 'D') { const r = held(cx, cz)!; r.status = 2; r.block++; }
          else if (stage === 'L') { const r = held(cx, cz)!; r.status = 3; r.light++; }
          const payload = stage === 'MESH' ? ({ cx, cz, versions } as unknown as ColumnMeshPayload) : null;
          resolve({ versions: stage === 'L' || stage === 'MESH' ? versions : null, payload, generation: 0 });
        });
      });
    },
    cancel() {},
    liveWorkers: () => 4,
    generation: () => 0,
  };
  const sink = { stage() {}, unstage: () => false, remove() {} };
  return { store, jobs, sink, frees, pending };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const cam = (cx: number, cz: number): StreamCamera => ({ x: cx * 16 + 8, z: cz * 16 + 8, yawDeg: 0 });

describe('the sim\'s failure with posts pending (SP5a spec §2.1, §2.7)', () => {
  test('a failure with 2 posts pending (`onSimFailure`, then both rejections) leaves every `simPins` at 0 and the frees follow in the next update', async () => {
    const rd = 4;
    const w = fakeWorld();
    const c: Coordinator = createCoordinator({
      jobs: w.jobs, store: w.store, sink: w.sink, throttle: createThrottle({ max: 3 }), rd, rdMax: 16,
      retainAllProtos: true, strict: false, generation: 0, epoch: 1, onEvent: () => {},
    });
    const fill = async (at: StreamCamera): Promise<void> => {
      c.update(at);
      await flush();
      while (w.pending.length > 0) {
        w.pending.shift()!();
        await flush();
      }
    };
    await fill(cam(0, 0));
    expect(c.firstFill()).toBe(true);
    // A sim that never answers an edit.
    const worker: SimWorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
    const dead: number[] = [];
    const shown: Array<{ text: string; timeoutMs: number | undefined }> = [];
    const notices = { show: (text: string, o?: { timeoutMs?: number }) => { shown.push({ text, timeoutMs: o?.timeoutMs }); } };
    const unpins: Array<readonly [number, number]> = [];
    const coordinator = {
      editState: (cx: number, cz: number) => c.editState(cx, cz),
      simPin: (cx: number, cz: number) => c.simPin(cx, cz),
      simUnpin: (cx: number, cz: number) => { unpins.push([cx, cz]); c.simUnpin(cx, cz); },
      markEdited: (keys: ArrayLike<number>) => c.markEdited(keys),
      simUnpinAll: () => c.simUnpinAll(),
    };
    let path: ReturnType<typeof createEditPath> | null = null;
    const sim = createSimClient(() => worker, {
      onFailure: () => onSimFailure({ store: { markDead: (t) => { dead.push(t); } }, coordinator, editPath: path!, notices }),
    });
    path = createEditPath({ sim, coordinator, latency: createEditLatency(), now: () => 0, notices: { show: () => {} } });
    // Two posts on the west edge: their 3 × 3s overlap, two pins on the shared columns.
    const pinned = [[-4, 0], [-4, 1]] as const;
    const posts = pinned.map(([cx, cz]) => {
      expect(c.editState(cx, cz)).toBe(0);
      return path!.post([at(cx * 16 + 2, cz * 16 + 2)]);
    });
    expect(path.pending()).toBe(true);
    const R = rd + KEEP_VOXELS_EXTRA;
    const kept = (cx: number, cz: number, ccx: number, ccz: number): boolean => {
      const dx = cx - ccx;
      const dz = cz - ccz;
      return Math.abs(dx) <= R && Math.abs(dz) <= R && (membershipTable(rd)[(dz + R) * (2 * R + 1) + dx + R]! & M_KEEP_VOXELS) !== 0;
    };
    const beyond = new Map<number, readonly [number, number]>();
    for (const [px, pz] of pinned) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!kept(px + dx, pz + dz, 6, 0)) beyond.set(colKey(px + dx, pz + dz), [px + dx, pz + dz]);
    }
    expect(beyond.size).toBeGreaterThan(0);
    const freed = (list: ReadonlyArray<readonly [number, number]>, x: number, z: number): boolean => list.some(([a, b]) => a === x && b === z);
    for (let u = 0; u < 50; u++) await fill(cam(6, 0));
    for (const [x, z] of beyond.values()) expect(freed(w.frees, x, z), `(${x}, ${z}) freed while pinned`).toBe(false);
    worker.onerror!(new Error('the sim died'));
    expect(await Promise.all(posts)).toEqual([{ ok: false, why: 'failed' }, { ok: false, why: 'failed' }]);
    expect(dead).toEqual([SIM_THREAD]);
    expect(unpins).toEqual([]);
    expect(shown).toEqual([{ text: 'Editing stopped: the edit worker failed; this session\'s edits are lost', timeoutMs: undefined }]);
    expect(path.enabled).toBe(false);
    expect(path.pending()).toBe(false);
    const f0 = w.frees.length;
    c.update(cam(6, 0));
    const frees = w.frees.slice(f0);
    for (const [x, z] of beyond.values()) expect(freed(frees, x, z), `(${x}, ${z}) freed after the failure`).toBe(true);
    expect(frees.length).toBe(beyond.size);
    c.dispose();
  });
});

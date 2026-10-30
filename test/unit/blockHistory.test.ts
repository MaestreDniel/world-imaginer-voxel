/**
 * The block history (SP5a spec §4.5, D13; Review Focus 2): 100 steps, the redo side cleared by a new step, each undo
 * and redo posted through the real edit path to a fake sim that checks every `expect` against its own voxels, the
 * value read now when a side has no entry, a press held while a post is pending, and the refusals' notices. SP5b
 * (spec §3.4 step 6, D6, D32): `snapshot` and `restore` (each side the newest 100), `version`, and a step refused as
 * `'changed'` dropped.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { colKey } from '../../src/core/coords';
import { NO_ENTRY } from '../../src/sim/diffStore';
import type { Edit, EditedMsg } from '../../src/workers/protocol';
import { AIR, DIRT, STONE } from '../../src/world/blocks/index';
import { BLOCK_HISTORY_STEPS, createActionPost, createBlockHistory } from '../../src/ui/world/blockHistory';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createEditPath } from '../../src/ui/world/editPath';

const val = (state: number): number => (state << 8) >>> 0;
const AIR_V = val(AIR);
const STONE_V = val(STONE);
const DIRT_V = val(DIRT);
const Y = 70;
const set = (x: number, value: number, expectV: number, z = 0): Edit => ({ x, y: Y, z, op: 'set', value, expect: expectV });

/**
 * A fake sim over its own voxels: the generated values (`gen`, air unless set) and the DiffStore's entries. It checks
 * each edit's `expect` as the sim does (§2.1: an earlier edit of the voxel in the batch, else the voxel's value),
 * answers `delayMs` after the post, and keeps entries as §2.4 (a revert, or a set equal to the generated value,
 * removes the entry). In front of it, the real edit path (its gate reads `states`, 0 unless set) and the history,
 * whose `read` is the voxel's value now; the page's action post records each accepted action.
 */
function rig(delayMs = 0) {
  const gen = new Map<string, number>();
  const entries = new Map<string, number>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const generated = (x: number, y: number, z: number): number => gen.get(key(x, y, z)) ?? AIR_V;
  const value = (x: number, y: number, z: number): number => entries.get(key(x, y, z)) ?? generated(x, y, z);
  const states = new Map<number, 0 | 1 | 2>();
  const posts: Edit[][] = [];
  /** The posts sent while another was still waiting for its reply (none expected). */
  const overlaps: number[] = [];
  let inFlight = 0;
  const answer = (edits: readonly Edit[]): EditedMsg => {
    const n = edits.length;
    const prev = new Uint32Array(n);
    const next = new Uint32Array(n);
    const reply = (refused: EditedMsg['refused']): EditedMsg => ({
      type: 'edited', id: 1, prev, next, dirty: new Float64Array(0), entryAdded: new Float64Array(0), entryRemoved: new Float64Array(0), refused, relightMs: 0, editMs: 0,
    });
    const batch = new Map<string, number>();
    for (const e of edits) {
      const k = key(e.x, e.y, e.z);
      if ((batch.get(k) ?? value(e.x, e.y, e.z)) !== e.expect) {
        edits.forEach((f, i) => { prev[i] = next[i] = entries.get(key(f.x, f.y, f.z)) ?? NO_ENTRY; });
        return reply('changed');
      }
      batch.set(k, e.op === 'revert' ? generated(e.x, e.y, e.z) : e.value);
    }
    edits.forEach((e, i) => {
      const k = key(e.x, e.y, e.z);
      prev[i] = entries.get(k) ?? NO_ENTRY;
      const v = e.op === 'revert' ? generated(e.x, e.y, e.z) : e.value;
      if (e.op === 'revert' || v === generated(e.x, e.y, e.z)) entries.delete(k);
      else entries.set(k, v);
      next[i] = entries.get(k) ?? NO_ENTRY;
    });
    return reply(null);
  };
  const sim = {
    failed: false,
    edits: (edits: readonly Edit[]): Promise<EditedMsg> => {
      posts.push([...edits]);
      if (inFlight > 0) overlaps.push(posts.length);
      inFlight++;
      return new Promise<EditedMsg>((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(answer(edits));
        }, delayMs);
      });
    },
  };
  const coordinator = {
    editState: (cx: number, cz: number) => states.get(colKey(cx, cz)) ?? 0,
    simPin() {},
    simUnpin() {},
    markEdited() {},
  };
  const path = createEditPath({ sim, coordinator, latency: createEditLatency(), now: () => 0, notices: { show() {} } });
  const shown: Array<[string, number]> = [];
  const history = createBlockHistory({
    post: path.post,
    read: value,
    pending: path.pending,
    settled: path.settled,
    notices: { show: (text, ms) => { shown.push([text, ms]); } },
  });
  const act = createActionPost({ post: path.post, record: history.record });
  /** Another history over the same edit path and voxels (the page's after a reload). */
  const fresh = () => createBlockHistory({
    post: path.post,
    read: value,
    pending: path.pending,
    settled: path.settled,
    notices: { show: (text, ms) => { shown.push([text, ms]); } },
  });
  /** One action posted and answered: `delayMs` of fake time, then its outcome. */
  const action = async (edits: readonly Edit[]) => {
    const p = act(edits);
    await vi.advanceTimersByTimeAsync(delayMs);
    return p;
  };
  /** A press answered: the post, then `delayMs` of fake time. */
  const press = async (k: 'undo' | 'redo'): Promise<void> => {
    history[k]();
    await vi.advanceTimersByTimeAsync(delayMs);
  };
  return { gen, entries, value, states, posts, overlaps, path, history, shown, act, action, press, key, fresh };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createBlockHistory (SP5a spec §4.5, D13)', () => {
  test('101 steps keep the last 100', async () => {
    const r = rig();
    expect(BLOCK_HISTORY_STEPS).toBe(100);
    for (let x = 0; x <= 100; x++) expect(await r.action([set(x, STONE_V, AIR_V)])).toMatchObject({ ok: true });
    expect(r.history.size).toBe(100);
    for (let i = 0; i < 101; i++) await r.press('undo');
    // 100 reverts, x 100 down to 1; the 101st press finds nothing and posts nothing; x 0 keeps its stone.
    const undos = r.posts.slice(101);
    expect(undos.map((b) => b[0]!.x)).toEqual(Array.from({ length: 100 }, (_, i) => 100 - i));
    expect(undos.every((b) => b[0]!.op === 'revert')).toBe(true);
    expect(r.history.size).toBe(0);
    expect(r.history.redoSize).toBe(100);
    expect(r.value(0, Y, 0)).toBe(STONE_V);
  });

  test('undo then a new step clears redo', async () => {
    const r = rig();
    await r.action([set(1, STONE_V, AIR_V)]);
    await r.action([set(2, STONE_V, AIR_V)]);
    await r.press('undo');
    expect([r.history.size, r.history.redoSize]).toEqual([1, 1]);
    await r.action([set(3, STONE_V, AIR_V)]);
    expect([r.history.size, r.history.redoSize]).toEqual([2, 0]);
    // Nothing to redo: the press posts nothing.
    const n = r.posts.length;
    await r.press('redo');
    expect(r.posts.length).toBe(n);
  });

  test('undo of a place posts `revert` with `expect` the placed value; redo posts `set` with `expect` = the generated value read now', async () => {
    const r = rig();
    await r.action([set(5, STONE_V, AIR_V)]);
    await r.press('undo');
    expect(r.posts[1]).toEqual([{ x: 5, y: Y, z: 0, op: 'revert', value: 0, expect: STONE_V }]);
    // The generated value changes (an Apply): the redo's `expect` is the value read at the press.
    r.gen.set(r.key(5, Y, 0), DIRT_V);
    await r.press('redo');
    expect(r.posts[2]).toEqual([{ x: 5, y: Y, z: 0, op: 'set', value: STONE_V, expect: DIRT_V }]);
    expect(r.value(5, Y, 0)).toBe(STONE_V);
    expect([r.history.size, r.history.redoSize]).toEqual([1, 0]);
  });

  test('place, undo, redo: the redo is accepted', async () => {
    const r = rig();
    await r.action([set(5, STONE_V, AIR_V)]);
    await r.press('undo');
    expect(r.value(5, Y, 0)).toBe(AIR_V);
    expect(r.entries.size).toBe(0);
    await r.press('redo');
    expect(r.value(5, Y, 0)).toBe(STONE_V);
    expect([r.history.size, r.history.redoSize]).toEqual([1, 0]);
    expect(r.shown).toEqual([['Undo · blocks', 1500], ['Redo · blocks', 1500]]);
  });

  test('undo of a step whose after is `NO_ENTRY` is accepted', async () => {
    const r = rig();
    await r.action([set(5, STONE_V, AIR_V)]);
    // The break restores the generated air, which removes the entry: its after is NO_ENTRY.
    await r.action([set(5, AIR_V, STONE_V)]);
    expect(r.entries.size).toBe(0);
    await r.press('undo');
    expect(r.posts[2]).toEqual([{ x: 5, y: Y, z: 0, op: 'set', value: STONE_V, expect: AIR_V }]);
    expect(r.value(5, Y, 0)).toBe(STONE_V);
    expect([r.history.size, r.history.redoSize]).toEqual([1, 1]);
    expect(r.shown).toEqual([['Undo · blocks', 1500]]);
  });

  test('rulings R27: a break restoring the generated value (next NO_ENTRY), then a different value read (the generated value changed): the undo is accepted', async () => {
    const r = rig();
    await r.action([set(5, STONE_V, AIR_V)]);
    await r.action([set(5, AIR_V, STONE_V)]);
    expect(r.entries.size).toBe(0);
    // An Apply changes the voxel's generated value: the posted air is no longer what the voxel holds.
    r.gen.set(r.key(5, Y, 0), DIRT_V);
    expect(r.value(5, Y, 0)).toBe(DIRT_V);
    await r.press('undo');
    expect(r.posts[2]).toEqual([{ x: 5, y: Y, z: 0, op: 'set', value: STONE_V, expect: DIRT_V }]);
    expect(r.value(5, Y, 0)).toBe(STONE_V);
    expect(r.shown).toEqual([['Undo · blocks', 1500]]);
  });

  test('Ctrl+Z during a click\'s pending post undoes that click\'s step after its reply', async () => {
    const r = rig(50);
    await r.action([set(1, STONE_V, AIR_V)]);
    void r.act([set(2, STONE_V, AIR_V)]);
    expect(r.path.pending()).toBe(true);
    r.history.undo();
    // Held: nothing posted until the click's reply.
    expect(r.posts.length).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.posts[2]).toEqual([{ x: 2, y: Y, z: 0, op: 'revert', value: 0, expect: STONE_V }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.value(2, Y, 0)).toBe(AIR_V);
    expect(r.value(1, Y, 0)).toBe(STONE_V);
    expect([r.history.size, r.history.redoSize]).toEqual([1, 1]);
    expect(r.overlaps).toEqual([]);
  });

  test('`unloaded` keeps the step on top (SP5a), as does `regenerating`: each names its cause for 4 s, undo and redo', async () => {
    const r = rig();
    await r.action([set(17, STONE_V, AIR_V)]);
    r.states.set(colKey(1, 0), 1);
    await r.press('undo');
    r.states.set(colKey(1, 0), 2);
    await r.press('undo');
    expect([r.history.size, r.history.redoSize]).toEqual([1, 0]);
    r.states.delete(colKey(1, 0));
    await r.press('undo');
    r.states.set(colKey(1, 0), 1);
    await r.press('redo');
    r.states.set(colKey(1, 0), 2);
    await r.press('redo');
    expect([r.history.size, r.history.redoSize]).toEqual([0, 1]);
    expect(r.shown).toEqual([
      ['Can\'t undo there: not loaded', 4000],
      ['Can\'t undo there: regenerating', 4000],
      ['Undo · blocks', 1500],
      ['Can\'t redo there: not loaded', 4000],
      ['Can\'t redo there: regenerating', 4000],
    ]);
  });

  test('a `\'changed\'` refusal drops the step with its notice; the next press undoes the older step (SP5b D32)', async () => {
    const r = rig();
    await r.action([set(1, STONE_V, AIR_V)]);
    await r.action([set(2, STONE_V, AIR_V)]);
    // Someone else's change at x 2: the sim refuses its undo as `changed`, and the step is dropped.
    r.entries.set(r.key(2, Y, 0), DIRT_V);
    await r.press('undo');
    expect([r.history.size, r.history.redoSize]).toEqual([1, 0]);
    expect(r.value(2, Y, 0)).toBe(DIRT_V);
    await r.press('undo');
    expect(r.posts[3]).toEqual([{ x: 1, y: Y, z: 0, op: 'revert', value: 0, expect: STONE_V }]);
    expect(r.value(1, Y, 0)).toBe(AIR_V);
    expect([r.history.size, r.history.redoSize]).toEqual([0, 1]);
    // The same on the redo side: x 3's stone made dirt, that step undone, then x 3 broken since (its redo expects the
    // stone), so the redo is refused and dropped.
    await r.action([set(3, STONE_V, AIR_V)]);
    await r.action([set(3, DIRT_V, STONE_V)]);
    await r.press('undo');
    expect([r.history.size, r.history.redoSize]).toEqual([1, 1]);
    r.entries.set(r.key(3, Y, 0), AIR_V);
    await r.press('redo');
    expect([r.history.size, r.history.redoSize]).toEqual([1, 0]);
    expect(r.value(3, Y, 0)).toBe(AIR_V);
    expect(r.shown).toEqual([
      ['Can\'t undo there: the blocks changed', 4000],
      ['Undo · blocks', 1500],
      ['Undo · blocks', 1500],
      ['Can\'t redo there: the blocks changed', 4000],
    ]);
  });

  test('`snapshot` then `restore` into a fresh history gives the same sides and the same undo (SP5b spec §3.4 step 6)', async () => {
    const r = rig();
    await r.action([set(1, STONE_V, AIR_V)]);
    await r.action([set(2, STONE_V, AIR_V)]);
    await r.action([set(3, DIRT_V, AIR_V)]);
    await r.press('undo');
    const s = r.history.snapshot();
    expect(s.done.map((st) => st.edits[0]!.x)).toEqual([1, 2]);
    expect(s.undone.map((st) => st.edits[0]!.x)).toEqual([3]);
    // The snapshot is a copy: a later step does not reach it.
    await r.action([set(4, STONE_V, AIR_V)]);
    expect(s.done).toHaveLength(2);
    const h = r.fresh();
    h.restore(s.done, s.undone);
    expect(h.snapshot()).toEqual(s);
    expect([h.size, h.redoSize]).toEqual([2, 1]);
    // Its undo is the original's: x 2's revert, expecting the stone placed.
    const n = r.posts.length;
    h.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.posts.slice(n)).toEqual([[{ x: 2, y: Y, z: 0, op: 'revert', value: 0, expect: STONE_V }]]);
    expect(r.value(2, Y, 0)).toBe(AIR_V);
    expect([h.size, h.redoSize]).toEqual([1, 2]);
  });

  test('`restore` of 120 steps keeps the newest 100', () => {
    const r = rig();
    const steps = (z: number) => Array.from({ length: 120 }, (_, x) => ({ edits: [{ x, y: Y, z, before: NO_ENTRY, after: STONE_V }] }));
    const done = steps(0);
    const undone = steps(1);
    r.history.restore(done, undone);
    expect([r.history.size, r.history.redoSize]).toEqual([100, 100]);
    expect(r.history.snapshot()).toEqual({ done: done.slice(20), undone: undone.slice(20) });
  });

  test('`version` moves on record, undo, redo, drop and restore', async () => {
    const r = rig();
    const seen = [r.history.version];
    const moved = (): void => {
      expect(r.history.version, `after ${seen.length} changes`).not.toBe(seen[seen.length - 1]);
      seen.push(r.history.version);
    };
    await r.action([set(1, STONE_V, AIR_V)]);
    moved();
    await r.action([set(2, STONE_V, AIR_V)]);
    moved();
    await r.press('undo');
    moved();
    await r.press('redo');
    moved();
    // A refusal that keeps the step (`unloaded`) does not move it; one that drops it (`changed`) does.
    r.states.set(colKey(0, 0), 1);
    await r.press('undo');
    expect(r.history.version).toBe(seen[seen.length - 1]);
    r.states.delete(colKey(0, 0));
    r.entries.set(r.key(2, Y, 0), DIRT_V);
    await r.press('undo');
    expect(r.history.size).toBe(1);
    moved();
    r.history.restore([], []);
    moved();
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('Review Focus 2: 12 undos 33 ms apart, step 3\'s column regenerating until the 8th press', async () => {
    const r = rig(50);
    // Steps 1 … 12 in columns (0, 0) … (11, 0); undo takes them from column 11 down.
    for (let c = 0; c < 12; c++) await r.action([set(c * 16 + 3, STONE_V, AIR_V)]);
    const before = r.posts.length;
    const step3 = colKey(9, 0);
    r.states.set(step3, 2);
    const regenerating = (): number => r.shown.filter(([t]) => t === 'Can\'t undo there: regenerating').length;
    for (let press = 1; press <= 12; press++) {
      if (press === 8) {
        // Presses 3-7 each refused, step 3 still on top (steps 1-2 undone, nothing of column 9 posted).
        expect(regenerating()).toBe(5);
        expect([r.history.size, r.history.redoSize]).toEqual([10, 2]);
        expect(r.value(9 * 16 + 3, Y, 0)).toBe(STONE_V);
        expect(r.posts.slice(before).map((b) => b[0]!.x >> 4)).toEqual([11, 10]);
        r.states.delete(step3);
      }
      r.history.undo();
      await vi.advanceTimersByTimeAsync(33);
    }
    await vi.advanceTimersByTimeAsync(1000);
    // The 8th press undoes step 3, the 9th-12th the four below it.
    expect(r.posts.slice(before).map((b) => b[0]!.x >> 4)).toEqual([11, 10, 9, 8, 7, 6, 5]);
    expect(r.posts.slice(before).every((b) => b[0]!.op === 'revert')).toBe(true);
    expect(regenerating()).toBe(5);
    expect(r.shown.filter(([t]) => t === 'Undo · blocks')).toHaveLength(7);
    expect(r.shown.every(([t, ms]) => (t === 'Undo · blocks' ? ms === 1500 : ms === 4000))).toBe(true);
    expect([r.history.size, r.history.redoSize]).toEqual([5, 7]);
    // No press ran before the previous reply: no post while another waited.
    expect(r.overlaps).toEqual([]);
  });
});

describe('createActionPost (the page\'s recording post, SP5a spec §4.5; rulings R27)', () => {
  test('an accepted action records one step of the reply\'s entries before (`prev`) and after (`next`); a refused one records nothing', async () => {
    const steps: unknown[] = [];
    const replies = [
      { ok: true as const, prev: new Uint32Array([NO_ENTRY, STONE_V]), next: new Uint32Array([STONE_V, NO_ENTRY]) },
      { ok: false as const, why: 'changed' as const },
    ];
    const post = createActionPost({ post: () => Promise.resolve(replies.shift()!), record: (s) => { steps.push(s); } });
    expect(await post([set(1, STONE_V, AIR_V), set(2, AIR_V, STONE_V)])).toMatchObject({ ok: true });
    expect(await post([set(1, DIRT_V, STONE_V)])).toEqual({ ok: false, why: 'changed' });
    expect(steps).toEqual([{
      edits: [{ x: 1, y: Y, z: 0, before: NO_ENTRY, after: STONE_V }, { x: 2, y: Y, z: 0, before: STONE_V, after: NO_ENTRY }],
    }]);
  });

  test('a click\'s time reaches the edit path\'s post (its latency sample starts there, spec §4.6; final review UI-3)', async () => {
    const starts: Array<number | undefined> = [];
    const post = createActionPost({
      post: (_e, tClick) => { starts.push(tClick); return Promise.resolve({ ok: false as const, why: 'changed' as const }); },
      record: () => {},
    });
    await post([set(1, STONE_V, AIR_V)], 42.5);
    await post([set(1, STONE_V, AIR_V)]);
    expect(starts).toEqual([42.5, undefined]);
  });
});

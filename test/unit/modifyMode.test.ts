/**
 * The world-modification mode (SP5b spec §3.6, D10, D25) on the DOM shim, over a real `WorldSession`, a real apply control
 * on a fake driver, coordinator and clock, and a fake map tool that logs `setEditable` (the real tool mounts only in the
 * browser: its map view needs a 2D context, `mapView.ts:91`; each editor's own `setEditable` is tested in its file).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { hex64 } from '../../src/core/hash';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { appliedDraftOf, type WorldStage } from '../../src/engine/invalidation';
import { WorldSession, type SessionState } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import { draftOf, type Configured } from '../../src/ui/map/previewDriver';
import { createApplyControl, createEpochs } from '../../src/ui/world/applyControl';
import { createModifyMode, createModifySwitch, MODIFY_LABEL, type BackupDeps } from '../../src/ui/world/modifyMode';
import { appliedRecord, installUndoKeys, newWorldRecord, openOlderGenerator } from '../../src/ui/world/worldPage';
import { GENERATOR_VERSION } from '../../src/core/constants';
import { SCHEMA_VERSION } from '../../src/core/params/migrate';
import { paramsHash } from '../../src/core/stage/hash';
import type { HistoryRecord, StateRecord, WorldRecord } from '../../src/persist/saves';
import type { BackedUpMsg, BackupMsg } from '../../src/workers/protocol';
import { installDom } from './fixtures/domShim';

afterEach(() => { vi.unstubAllGlobals(); });

/** The ready reply the workers send for a session state: hex stage hashes and genKey (as `applyControl.test.ts`). */
function readyOf(s: SessionState): Configured['ready'] {
  const h = stageHashes(s.params);
  const hex: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) hex[k] = hex64(v!);
  return { stageHashes: hex, genKey: hex64(genKey(s.seed, h)) };
}

/** Backup deps for the cases that never reach a copy: no entries, so every change applies. */
const noBackup = (session: WorldSession): BackupDeps => ({
  sim: { hasAnyEntries: () => false, backup: () => Promise.reject(new Error('no backup expected')) },
  kept: () => newWorldRecord('w1', 'My world', session.state, 1),
  applied: () => session.snapshot,
  build: () => { throw new Error('no backup expected'); },
  newId: () => 'never',
  names: () => Promise.resolve([]),
  notices: { show() {} },
});

function rig() {
  installDom();
  const session = new WorldSession(() => [1, 2], { seedText: '42', validateParams: validateParamTrees });
  const sw = createModifySwitch();
  const editable: boolean[] = [];
  const tool = { setEditable: (on: boolean) => { editable.push(on); } };
  let mounted: typeof tool | null = tool;
  const mode = createModifyMode({ session, tool: () => mounted, checkbox: sw.checkbox, backup: noBackup(session) });
  return { session, sw, editable, mode, unmount: () => { mounted = null; } };
}

/** The user's click on the checkbox: its state flips, then 'change'. */
const click = (box: { checked: boolean; dispatchEvent(e: Event): boolean }) => {
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
};

describe('the switch `#map-modify` (SP5b spec §3.6, D10)', () => {
  test('a label "Modify terrain" holding the checkbox `#map-modify`, unchecked', () => {
    installDom();
    const sw = createModifySwitch();
    expect([sw.checkbox.id, sw.checkbox.type, sw.checkbox.checked === true, sw.element.textContent, MODIFY_LABEL]).toEqual(['map-modify', 'checkbox', false, 'Modify terrain', 'Modify terrain']);
    expect(sw.element.contains(sw.checkbox)).toBe(true);
  });
});

describe('createModifyMode (SP5b spec §3.6, D10, D25)', () => {
  test('off at the open; on → writable and every editor editable; off → not writable, a drag in progress ended, an edit already made still applies (its kept configure is not dropped)', () => {
    const { session, sw, editable, mode } = rig();
    // A fake driver that reports configures, a fake coordinator that logs its calls, a clock the test moves.
    let now = 0;
    const pool = { epoch: 0 };
    let report: ((c: Configured) => void) | null = null;
    const applied: Array<WorldStage | null> = [];
    const control = createApplyControl({
      coordinator: { apply: (a) => { applied.push(a.from); }, adopt: () => { applied.push(null); } },
      driver: { onConfigured: (fn) => { report = fn; return () => {}; }, status: { queued: false } as never },
      session,
      pool,
      clock: { now: () => now },
      epochs: createEpochs(),
      initial: appliedDraftOf(draftOf(session.state).seedKey, readyOf(session.state)),
      initialGeneration: 0,
      beforeApply: () => true,
      onApplied: () => {},
    });

    // Off at the open: the session refuses, the switch is unchecked, no switch-on yet.
    expect([mode.on, session.writable, sw.checkbox.checked, mode.sessionCount, editable]).toEqual([false, false, false, 0, []]);
    const opened = session.state;
    expect(session.set('climate.scaleMul', 2).ok && session.state).toBe(opened);

    // On: writable, every editor editable.
    click(sw.checkbox);
    expect([mode.on, session.writable, mode.sessionCount, editable]).toEqual([true, true, 1, [true]]);

    // A drag in progress has moved the biome size; its configure is reported (the driver configured the draft).
    session.beginGesture();
    session.set('climate.scaleMul', 2);
    pool.epoch = 1;
    report!({ poolEpoch: 1, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready: readyOf(session.state), gesture: true, urgent: false });
    now = 1000;
    control.tick();
    expect(applied).toEqual([]);

    // Off: the drag ends (its step recorded), the session refuses, the editors are disabled; no notice, nothing dropped.
    click(sw.checkbox);
    expect([mode.on, session.inGesture, session.writable, sw.checkbox.checked, editable]).toEqual([false, false, false, false, [true, false]]);
    const dragged = session.state;
    expect(dragged.params.climate.scaleMul).toBe(2);
    session.set('climate.scaleMul', 4);
    expect(session.state).toBe(dragged);
    // The edit already made applies once the quiet window has passed after the drag's end.
    now = 2000;
    control.tick();
    expect(applied).toHaveLength(1);
    expect(applied[0]).not.toBeNull();

    // On again: a second switch-on; `set` to the mode already in force changes nothing.
    mode.set(true);
    mode.set(true);
    expect([mode.on, session.writable, sw.checkbox.checked, mode.sessionCount, editable]).toEqual([true, true, true, 2, [true, false, true]]);
    control.dispose();
  });

  test('`set(on)` before the map is mounted reaches the session alone (the overlay tells the tool at its mount)', () => {
    const { session, editable, mode, unmount } = rig();
    unmount();
    mode.set(true);
    expect([session.writable, editable]).toEqual([true, []]);
  });

  test('`dispose` stops following the checkbox', () => {
    const { session, sw, mode } = rig();
    mode.dispose();
    click(sw.checkbox);
    expect([mode.on, session.writable]).toEqual([false, false]);
  });

  test('Ctrl+Z with the map owning does nothing while off', () => {
    const { session, mode } = rig();
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const blocks: string[] = [];
    const dispose = installUndoKeys({
      owner: () => 'map',
      blocks: { undo: () => { blocks.push('undo'); }, redo: () => { blocks.push('redo'); } },
      session,
    });
    const press = (key: string, mods: Record<string, boolean>) =>
      win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }));
    mode.set(true);
    session.set('rivers.widthMin', 6);
    mode.set(false);
    const edited = session.state;
    press('z', { ctrlKey: true });
    press('y', { ctrlKey: true });
    expect([session.state, blocks]).toEqual([edited, []]);
    // On, the same key undoes the step.
    mode.set(true);
    press('z', { ctrlKey: true });
    expect(session.state.params.rivers.widthMin).toBe(8);
    dispose();
  });
});

// ---------------------------------------------------------------- the automatic backup (SP5b spec §3.6, D11, D26)

const STATE: StateRecord = {
  worldId: 'w1', flushSeq: 0, updated: 1_700_000_000_000, player: null, time: { t: 0.25, speedIndex: 0 }, hotbar: { v: 1, active: 0, slots: [] }, places: [],
};
const HISTORY: HistoryRecord = { worldId: 'w1', done: [{ edits: [{ x: 1, y: 70, z: 2, before: 0xFFFFFFFF, after: 1 << 8 }] }], undone: [] };
const FIRST = 'My world (before the change)';
const SECOND = 'My world (before the change 2)';

/**
 * A saved world's mode with the backup over a real session and apply control (fake driver, coordinator and clock) and a
 * fake sim: `backup` resolves `writeMs` after it is posted, ok or with `fail` as its error; a committed copy's name joins
 * the names the KV holds. The page's kept record and applied snapshot follow `onApplied` (`appliedRecord`), as the
 * page's do. `start` is the clock's first time.
 */
function backupRig(o: { entries?: boolean; writeMs?: number; fail?: string | null; start?: number; kept?: (s: SessionState) => WorldRecord } = {}) {
  installDom();
  const session = new WorldSession(() => [1, 2], { seedText: '42', validateParams: validateParamTrees });
  const sw = createModifySwitch();
  let now = o.start ?? 0;
  const pool = { epoch: 0 };
  let report: ((c: Configured) => void) | null = null;
  const calls: Array<WorldStage | null> = [];
  let entries = o.entries ?? true;
  let fail = o.fail ?? null;
  const names = ['My world'];
  const copies: Array<Omit<BackupMsg, 'type' | 'id'>> = [];
  const writes: Array<{ due: number; m: Omit<BackupMsg, 'type' | 'id'>; resolve(r: BackedUpMsg): void }> = [];
  const shown: Array<{ text: string; kind: string | undefined; timeoutMs: number | undefined }> = [];
  let ids = 0;
  let kept = o.kept?.(session.state) ?? newWorldRecord('w1', 'My world', session.state, 1);
  let applied = session.snapshot;
  const deps: BackupDeps = {
    sim: {
      hasAnyEntries: () => entries,
      backup(m) {
        copies.push(m);
        return new Promise<BackedUpMsg>((resolve) => { writes.push({ due: now + (o.writeMs ?? 100), m, resolve }); });
      },
    },
    kept: () => kept,
    applied: () => applied,
    build: () => ({ state: STATE, history: HISTORY }),
    newId: () => `copy-${++ids}`,
    names: () => Promise.resolve([...names]),
    notices: { show: (text, opts) => { shown.push({ text, kind: opts?.kind, timeoutMs: opts?.timeoutMs }); } },
  };
  const mode = createModifyMode({ session, tool: () => null, checkbox: sw.checkbox, backup: deps });
  const first = readyOf(session.state);
  const control = createApplyControl({
    coordinator: { apply: (a) => { calls.push(a.from); }, adopt: () => { calls.push(null); } },
    driver: { onConfigured: (fn) => { report = fn; return () => {}; }, status: { queued: false } as never },
    session,
    pool,
    clock: { now: () => now },
    epochs: createEpochs(),
    initial: appliedDraftOf(draftOf(session.state).seedKey, first),
    initialGeneration: 0,
    beforeApply: (from) => mode.beforeApply(from),
    onApplied: () => {
      applied = session.snapshot;
      kept = appliedRecord(kept, session.state, control.applied.genKey);
    },
  });
  /** Settles every promise callback queued so far. */
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });
  return {
    session, sw, mode, control, calls, copies, shown, names, first,
    get kept() { return kept; },
    setEntries(on: boolean) { entries = on; },
    setFail(e: string | null) { fail = e; },
    /** Reports a resolved configure of the session's draft; `d`: its stage hashes differ from the applied draft's in `decorate` only (a 'D' change). */
    emit(d = false) {
      pool.epoch++;
      const ready = d
        ? { stageHashes: { ...control.applied.hashes, decorate: 'd'.repeat(16) } as Configured['ready']['stageHashes'], genKey: 'e'.repeat(16) }
        : readyOf(session.state);
      report!({ poolEpoch: pool.epoch, sessionEpoch: session.state.epoch, seedKey: draftOf(session.state).seedKey, ready, gesture: false, urgent: true });
    },
    /** Ticks at every ms up to `to`, settling each write when it is due (before that ms's tick). */
    async to(to: number) {
      for (let t = now + 1; t <= to; t++) {
        now = t;
        for (const w of writes.filter((x) => x.due <= t)) {
          writes.splice(writes.indexOf(w), 1);
          if (fail === null) names.push(w.m.newWorld.name);
          w.resolve(fail === null ? { type: 'backedUp', id: 0, ok: true, error: null } : { type: 'backedUp', id: 0, ok: false, error: fail });
          await settle();
        }
        control.tick();
        await settle();
      }
    },
  };
}
const texts = (r: { shown: ReadonlyArray<{ text: string }> }): string[] => r.shown.map((n) => n.text);

describe('the automatic backup: `beforeApply` (SP5b spec §3.6, D11, D26)', () => {
  test('a \'T\' change with entries posts one backup and holds until `backedUp`', async () => {
    const r = backupRig({ writeMs: 300 });
    r.mode.set(true);
    const before = r.kept;
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(200);
    // Posted at the first tick past the quiet window: the kept record as a copy, the state and history built now.
    expect(r.copies).toEqual([{ newWorld: { ...before, id: 'copy-1', name: FIRST, backupOf: 'w1' }, newId: 'copy-1', state: STATE, history: HISTORY }]);
    expect(r.calls).toEqual([]);
    await r.to(449);
    expect([r.calls, r.copies.length, r.shown]).toEqual([[], 1, []]);
    await r.to(460);
    expect(r.calls).toEqual(['T']);
    expect(r.shown).toEqual([{ text: `Backup saved as '${FIRST}'`, kind: 'info', timeoutMs: 6000 }]);
    expect([r.copies.length, r.kept.params]).toEqual([1, r.session.state.params]);
  });

  test('after an older-generator open, the backup\'s `newWorld` carries today\'s genKey (the kept record); the open itself posts no backup', async () => {
    const stored = (s: SessionState): WorldRecord => ({ ...newWorldRecord('w1', 'My world', s, 1), genKey: '0123456789abcdef', generatorVersion: GENERATOR_VERSION - 1 });
    const r = backupRig({ kept: (s) => openOlderGenerator({ kept: stored(s), readyGenKey: readyOf(s).genKey, sim: { record() {} } }).kept });
    r.mode.set(true);
    await r.to(300);
    expect(r.copies).toEqual([]);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(600);
    expect(r.copies).toHaveLength(1);
    expect([r.copies[0]!.newWorld.genKey, r.copies[0]!.newWorld.generatorVersion]).toEqual([r.first.genKey, GENERATOR_VERSION]);
    expect(r.copies[0]!.newWorld.genKey).not.toBe('0123456789abcdef');
  });

  test('no entries → no backup and the latch stays clear; a later change after building makes the copy (Point 1)', async () => {
    const r = backupRig({ entries: false });
    r.mode.set(true);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(200);
    expect([r.calls, r.copies]).toEqual([['T'], []]);
    // The player builds; the next terrain change of the same mode session makes the copy.
    r.setEntries(true);
    r.session.set('climate.scaleMul', 3);
    r.emit();
    await r.to(400);
    expect([r.calls, r.copies.length]).toEqual([['T'], 1]);
    // The copy holds the world before this change: the first change's parameters.
    expect((r.copies[0]!.newWorld.params as { climate: { scaleMul: number } }).climate.scaleMul).toBe(2);
    await r.to(600);
    expect([r.calls, r.copies.length]).toEqual([['T', 'T'], 1]);
  });

  test('\'L\', \'MESH\' and `null` never copy', async () => {
    const r = backupRig();
    r.mode.set(true);
    expect([r.mode.beforeApply('L'), r.mode.beforeApply('MESH'), r.mode.beforeApply(null)]).toEqual([true, true, true]);
    await r.to(10);
    expect(r.copies).toEqual([]);
    // The latch is still clear: a 'D' change copies.
    expect(r.mode.beforeApply('D')).toBe(false);
    await r.to(20);
    expect(r.copies).toHaveLength(1);
  });

  test('a second change in the same mode session makes none; off then on makes one more', async () => {
    const r = backupRig();
    r.mode.set(true);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(400);
    expect([r.calls, r.copies.length]).toEqual([['T'], 1]);
    r.session.set('climate.scaleMul', 3);
    r.emit();
    await r.to(600);
    expect([r.calls, r.copies.length]).toEqual([['T', 'T'], 1]);
    r.mode.set(false);
    r.mode.set(true);
    r.session.set('climate.scaleMul', 4);
    r.emit();
    await r.to(1000);
    expect([r.calls, r.copies.map((c) => c.newWorld.name)]).toEqual([['T', 'T', 'T'], [FIRST, SECOND]]);
    // The second copy holds the world before its change: the second change's parameters.
    expect((r.copies[1]!.newWorld.params as { climate: { scaleMul: number } }).climate.scaleMul).toBe(3);
  });

  test('a revert to the applied draft while the copy is written adopts at once, and the copy, once committed, is kept and spends the latch (D11)', async () => {
    const r = backupRig({ writeMs: 500 });
    r.mode.set(true);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(200);
    expect(r.copies).toHaveLength(1);
    // Ctrl+Z on the map: the draft is the applied one again; the control adopts it at once.
    r.session.undo();
    r.emit();
    await r.to(400);
    expect(r.calls).toEqual([null]);
    await r.to(700);
    expect(texts(r)).toEqual([`Backup saved as '${FIRST}'`]);
    expect([r.calls, r.names]).toEqual([[null], ['My world', FIRST]]);
    // The latch is spent: the next terrain change of this mode session applies with no copy.
    r.session.set('climate.scaleMul', 3);
    r.emit();
    await r.to(900);
    expect([r.calls, r.copies.length]).toEqual([[null, 'T'], 1]);
  });

  test('a failed copy reloads the applied snapshot with `force` and shows the failure', async () => {
    const r = backupRig({ writeMs: 300, fail: 'QuotaExceededError' });
    r.mode.set(true);
    const opened = r.session.state.params;
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(200);
    expect(r.copies).toHaveLength(1);
    // The mode switched off while the copy is written: the revert still applies (`force`).
    r.mode.set(false);
    await r.to(500);
    expect(r.session.state.params).toEqual(opened);
    expect(r.shown).toEqual([{ text: 'Could not save a backup copy (storage full): the terrain change was cancelled', kind: 'warn', timeoutMs: undefined }]);
    expect(r.calls).toEqual([]);
    // The driver reports the reverted draft: the same world, adopted.
    r.emit();
    await r.to(700);
    expect(r.calls).toEqual([null]);
    // No copy was kept: the next change, in the next mode session, makes one.
    r.setFail(null);
    r.mode.set(true);
    r.session.set('climate.scaleMul', 3);
    r.emit();
    await r.to(1200);
    expect([r.calls, r.copies.length, r.names]).toEqual([[null, 'T'], 2, ['My world', FIRST]]);
  });

  test('a failure other than a full disk names the error, a closed connection says so; a failed copy leaves the latch clear, so the next change of the same mode session tries again', async () => {
    const r = backupRig({ writeMs: 50, fail: 'closed' });
    r.mode.set(true);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(300);
    expect(texts(r)).toEqual(['Could not save a backup copy (storage closed): the terrain change was cancelled']);
    r.setFail('AbortError');
    r.session.set('climate.scaleMul', 3);
    r.emit();
    await r.to(600);
    expect(texts(r)).toEqual([
      'Could not save a backup copy (storage closed): the terrain change was cancelled',
      'Could not save a backup copy (AbortError): the terrain change was cancelled',
    ]);
  });

  test('Review Focus 4: mode on; change 1 (\'T\') held, its backup\'s write settling at 500 ms; at 100 ms the mode off (the open gesture ended), at 200 ms on again; change 1 applies only after its `backedUp`; at 800 ms, after that apply, change 2 (\'D\') posts a second copy `My world (before the change 2)` holding change 1\'s parameters; exactly two copies, and the world ends with change 2\'s parameters', async () => {
    // The change is made at −150 ms, so its copy is posted at 0 (the first tick past the quiet window).
    const r = backupRig({ start: -150, writeMs: 500 });
    r.mode.set(true);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(0);
    expect(r.copies.map((c) => c.newWorld.name)).toEqual([FIRST]);
    // At 50 ms the user drags on the map; at 100 ms the mode is switched off, which ends the drag (its step recorded).
    await r.to(50);
    r.session.beginGesture();
    r.session.set('climate.scaleMul', 3);
    await r.to(100);
    r.mode.set(false);
    expect([r.session.inGesture, r.session.state.params.climate.scaleMul]).toEqual([false, 3]);
    r.emit();
    await r.to(200);
    r.mode.set(true);
    expect([r.mode.sessionCount, r.calls]).toEqual([2, []]);
    await r.to(499);
    expect(r.calls).toEqual([]);
    // The copy committed at 500: change 1 (with the drag) applies once, with that one copy.
    await r.to(501);
    expect([r.calls, texts(r)]).toEqual([['T'], [`Backup saved as '${FIRST}'`]]);
    await r.to(800);
    expect([r.calls, r.copies.length]).toEqual([['T'], 1]);
    // Change 2, a 'D' change of the new mode session: a second copy, holding change 1's parameters.
    r.session.set('climate.scaleMul', 4);
    r.emit(true);
    await r.to(960);
    expect(r.copies.map((c) => c.newWorld.name)).toEqual([FIRST, SECOND]);
    expect((r.copies[1]!.newWorld.params as { climate: { scaleMul: number } }).climate.scaleMul).toBe(3);
    expect(r.calls).toEqual(['T']);
    await r.to(1500);
    expect([r.calls, r.copies.length]).toEqual([['T', 'D'], 2]);
    expect([(r.kept.params as { climate: { scaleMul: number } }).climate.scaleMul, r.kept.genKey, r.control.applied.genKey]).toEqual([4, 'e'.repeat(16), 'e'.repeat(16)]);
  });

  test('a change made while a copy is held supersedes the held draft; after `backedUp` the combined draft applies with that one copy', async () => {
    const r = backupRig({ writeMs: 500 });
    r.mode.set(true);
    r.session.set('climate.scaleMul', 2);
    r.emit();
    await r.to(300);
    expect(r.copies).toHaveLength(1);
    r.session.set('rivers.widthMin', 6);
    r.emit();
    await r.to(640);
    expect(r.calls).toEqual([]);
    await r.to(700);
    expect([r.calls, r.copies.length]).toEqual([['T'], 1]);
    const p = r.kept.params as { climate: { scaleMul: number }; rivers: { widthMin: number } };
    expect([p.climate.scaleMul, p.rivers.widthMin]).toEqual([2, 6]);
  });
});

describe('`appliedRecord` (SP5b spec §3.6; ruling P39)', () => {
  test('the kept record with the applied seed, preset, params, `paramsHash` and genKey, today\'s schema and generator; its id, name, created, table and `backupOf` kept', () => {
    const session = new WorldSession(() => [1, 2], { seedText: '42', validateParams: validateParamTrees });
    const kept: WorldRecord = { ...newWorldRecord('w1', 'My world', session.state, 7), schemaVersion: SCHEMA_VERSION - 1, generatorVersion: GENERATOR_VERSION - 1, backupOf: 'w0' };
    session.setSeedText('7');
    session.setProfile('amplified');
    session.set('climate.scaleMul', 2);
    const s = session.state;
    const got = appliedRecord(kept, s, 'fedcba9876543210');
    expect(got).toEqual({
      ...kept, seedText: '7', seed: [s.seed[0], s.seed[1]], profile: 'amplified', params: s.params, schemaVersion: SCHEMA_VERSION,
      paramsHash: hex64(paramsHash(s.params)), generatorVersion: GENERATOR_VERSION, genKey: 'fedcba9876543210',
    });
    expect([got.id, got.name, got.created, got.stateTable, got.backupOf]).toEqual(['w1', 'My world', 7, kept.stateTable, 'w0']);
  });
});

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
import { createModifyMode, createModifySwitch, MODIFY_LABEL } from '../../src/ui/world/modifyMode';
import { installUndoKeys } from '../../src/ui/world/worldPage';
import { installDom } from './fixtures/domShim';

afterEach(() => { vi.unstubAllGlobals(); });

/** The ready reply the workers send for a session state: hex stage hashes and genKey (as `applyControl.test.ts`). */
function readyOf(s: SessionState): Configured['ready'] {
  const h = stageHashes(s.params);
  const hex: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) hex[k] = hex64(v!);
  return { stageHashes: hex, genKey: hex64(genKey(s.seed, h)) };
}

function rig() {
  installDom();
  const session = new WorldSession(() => [1, 2], { seedText: '42', validateParams: validateParamTrees });
  const sw = createModifySwitch();
  const editable: boolean[] = [];
  const tool = { setEditable: (on: boolean) => { editable.push(on); } };
  let mounted: typeof tool | null = tool;
  const mode = createModifyMode({ session, tool: () => mounted, checkbox: sw.checkbox });
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

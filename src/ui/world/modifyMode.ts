/**
 * The world-modification mode (SP5b spec §3.6, D10, D25): the switch "Modify terrain" (`#map-modify`) in the map
 * overlay's header slot, before "Watch live", in a saved world only (an unsaved world and `?map` edit live, with no switch
 * and no `setWritable` call). Off whenever a world opens: the session refuses every value mutator (`setWritable(false)`,
 * one choke point for every editor and every direct call, the map's Ctrl+Z / Ctrl+Y included) and every editor's terrain
 * controls are shown disabled (`MapTool.setEditable`); looking, layers, the grid, the cut line, teleport and the pin work.
 * On, the map edits the world live as in SP4c. Switching off ends a drag in progress (the session records its step, so
 * the apply control still applies an edit already made) and stops new ones; neither switch shows a notice. The map tool
 * keeps the session it has (`MapToolDeps`); a tool mounted later is told the mode by the overlay at its mount.
 * `sessionCount` counts the switches on: the backup's latch is cleared at each (§3.6, Point 1).
 *
 * The automatic backup (§3.6, D11, D26) is the apply control's `beforeApply`, its rules in this order:
 * - while a copy is being written, every terrain change ('T' or 'D') is held (false), the mode off included: a change
 *   made meanwhile supersedes the held draft (the control keeps only the latest configure), and the draft held when the
 *   copy commits applies with that one copy;
 * - a terrain change made with the mode on (the mode may be off by its apply: D10 lets a change already made apply, and
 *   D11 copies it first), the latch clear and the world holding any placed or removed block (`sim.hasAnyEntries()`)
 *   sets the latch, reads every world's name and then posts `backup` (the page's kept record as the copy, named by
 *   `backupName` among those names, the state and whole history built at the post, a new id), and is held until
 *   `backedUp`;
 * - anything else applies (`from` null, 'L' or 'MESH', the latch set, no entries: a change with no entries leaves the
 *   latch clear). A world opened with the mode never on is in mode session 0, its latch set (`latchedIn` 0).
 * On `ok` the held change applies at the next tick and "Backup saved as '<name>'" shows for 6 s; a revert to the applied
 * draft meanwhile (`from` null) adopts at once, and the copy, once committed, is kept and spends the latch. On a failure
 * the session loads the applied snapshot in place of the cancelled step (`load(…, {force: true, record: false})`, the
 * mode off included), D11's failure notice stays until dismissed, and the latch is cleared: no copy was kept, so the
 * next terrain change tries again.
 */
import type { WorldStage } from '../../engine/invalidation';
import type { SessionSnapshot, WorldSession } from '../../engine/session';
import type { SimClient } from '../../engine/simClient';
import { backupName, type HistoryRecord, type StateRecord, type WorldRecord } from '../../persist/saves';
import { el } from '../common/dom';
import type { Notices } from '../common/notice';
import type { MapTool } from '../map/mapTool';

/** The switch's text (SP5b spec D10). */
export const MODIFY_LABEL = 'Modify terrain';

/** The switch: a label holding the checkbox `#map-modify` and `MODIFY_LABEL`. */
export interface ModifySwitch {
  readonly element: HTMLLabelElement;
  readonly checkbox: HTMLInputElement;
}

/** The switch's elements, unchecked; the overlay puts `element` in its header slot (`MapOverlayOptions.modify`). */
export function createModifySwitch(): ModifySwitch {
  const element = el('label', 'map-modify');
  element.title = 'Terrain changes from the map (seed, preset, parameters) need this on; it is off whenever the world opens';
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'map-modify';
  element.append(checkbox, MODIFY_LABEL);
  return { element, checkbox };
}

/** How long "Backup saved as …" shows (D11), ms. */
export const BACKUP_NOTICE_MS = 6000;

/** What the backup needs from the page (SP5b spec §3.6). */
export interface BackupDeps {
  readonly sim: Pick<SimClient, 'backup' | 'hasAnyEntries'>;
  /** The record the page keeps (its open's, a rewrite's, the older-generator open's, then each `onApplied`'s): the copy's. */
  kept(): WorldRecord;
  /** The applied draft's snapshot (at the open and each `onApplied`), which a failed copy loads back. */
  applied(): SessionSnapshot;
  /** The state and the whole history now (the autosave's `build`). */
  build(): { readonly state: StateRecord; readonly history: HistoryRecord };
  /** A new world id (`crypto.randomUUID()`). */
  newId(): string;
  /** Every saved world's name, which the copy's name avoids. */
  names(): Promise<readonly string[]>;
  readonly notices: Pick<Notices, 'show'>;
}

/** D11's failure reason: "storage full" for a full disk, "storage closed" for a closed connection, else the error's name. */
export function backupFailureReason(error: string): string {
  return error === 'QuotaExceededError' ? 'storage full' : error === 'closed' ? 'storage closed' : error;
}

export interface ModifyMode {
  /** Whether terrain changes are allowed now: false at the open. */
  readonly on: boolean;
  /** Puts the mode in force: the checkbox, the session's `setWritable(on)`, then the mounted tool's `setEditable(on)`. */
  set(on: boolean): void;
  /** How many times the mode was switched on (the backup latch's mode sessions). */
  readonly sessionCount: number;
  /** The apply control's `beforeApply` (D26): false holds the change while its backup copy is written (module comment). */
  beforeApply(from: WorldStage | null): boolean;
  /** Stops following the checkbox. */
  dispose(): void;
}

/**
 * The mode over a saved world's `session` (set not writable here, and already by `openSavedWorld`), `checkbox` (the
 * switch's), `tool` (the overlay's mounted tool, or null before the first M) and `backup` (the copy's sources).
 */
export function createModifyMode(o: {
  session: WorldSession;
  tool: () => Pick<MapTool, 'setEditable'> | null;
  checkbox: HTMLInputElement;
  backup: BackupDeps;
}): ModifyMode {
  let on = false;
  let sessionCount = 0;
  /** The mode session whose copy was posted (the latch is set while it is the current one); 0: none. */
  let latchedIn = 0;
  /** A copy is being written. */
  let writing = false;
  /** A terrain change is held for the copy being written (a change, an adopt or a non-terrain Apply meanwhile ends it). */
  let holding = false;
  /** The copy committed while a change was held: that change applies at its next `beforeApply`. */
  let approved = false;
  o.checkbox.checked = false;
  o.session.setWritable(false);
  const b = o.backup;

  /**
   * Holds the change, reads every world's name, then posts the copy of the world as it is then (D26): the kept record, the
   * state and history built, the new id and the post in one synchronous continuation, so an autosave flush posted while
   * the names were read reaches the sim first and the copy (with the original's pending flush) is never older than it.
   */
  const startBackup = (): void => {
    writing = true;
    holding = true;
    latchedIn = sessionCount;
    let name = '';
    const settle = (failure: string | null): void => {
      writing = false;
      if (failure === null) {
        approved = holding;
        holding = false;
        b.notices.show(`Backup saved as '${name}'`, { kind: 'info', timeoutMs: BACKUP_NOTICE_MS });
        return;
      }
      holding = false;
      approved = false;
      latchedIn = 0;
      // `record: false`: the revert replaces the cancelled step, so the map's undo never offers that change again (PAGE-2).
      o.session.load(b.applied(), { force: true, record: false });
      b.notices.show(`Could not save a backup copy (${failure}): the terrain change was cancelled`, { kind: 'warn' });
    };
    b.names().catch((): readonly string[] => []).then((names) => {
      const kept = b.kept();
      const { state, history } = b.build();
      const newId = b.newId();
      name = backupName(kept.name, names);
      return b.sim.backup({ newWorld: { ...kept, id: newId, name, backupOf: kept.id }, newId, state, history });
    }).then(
      (r) => settle(r.ok ? null : backupFailureReason(r.error ?? 'AbortError')),
      // The sim failed (its own notice shows) or the copy could not be built: nothing was copied, so the change does not happen.
      () => settle('the world stopped saving'),
    );
  };

  const set = (next: boolean): void => {
    o.checkbox.checked = next;
    if (next === on) return;
    on = next;
    if (on) sessionCount++;
    // Off: the session first ends a drag in progress, then the editors are disabled; on: writable before editable.
    o.session.setWritable(on);
    o.tool()?.setEditable(on);
  };
  const onChange = (): void => set(o.checkbox.checked);
  o.checkbox.addEventListener('change', onChange);

  return {
    get on() { return on; },
    set,
    get sessionCount() { return sessionCount; },
    beforeApply(from) {
      if (from !== 'T' && from !== 'D') {
        // The held change is gone: an adopt or a non-terrain Apply replaced it.
        holding = false;
        approved = false;
        return true;
      }
      if (approved) {
        approved = false;
        return true;
      }
      if (writing) {
        holding = true;
        return false;
      }
      // The mode off does not skip the copy: the session refuses changes then, so a terrain change here was made with the
      // mode on (D11), the mode switched off before it applied (D10); the latch covers it, as `sessionCount` stays put.
      if (latchedIn === sessionCount || !b.sim.hasAnyEntries()) return true;
      startBackup();
      return false;
    },
    dispose() {
      o.checkbox.removeEventListener('change', onChange);
    },
  };
}

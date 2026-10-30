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
 */
import type { WorldSession } from '../../engine/session';
import { el } from '../common/dom';
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

export interface ModifyMode {
  /** Whether terrain changes are allowed now: false at the open. */
  readonly on: boolean;
  /** Puts the mode in force: the checkbox, the session's `setWritable(on)`, then the mounted tool's `setEditable(on)`. */
  set(on: boolean): void;
  /** How many times the mode was switched on (the backup latch's mode sessions). */
  readonly sessionCount: number;
  /** Stops following the checkbox. */
  dispose(): void;
}

/**
 * The mode over a saved world's `session` (set not writable here, and already by `openSavedWorld`), `checkbox` (the
 * switch's) and `tool` (the overlay's mounted tool, or null before the first M).
 */
export function createModifyMode(o: {
  session: WorldSession;
  tool: () => Pick<MapTool, 'setEditable'> | null;
  checkbox: HTMLInputElement;
}): ModifyMode {
  let on = false;
  let sessionCount = 0;
  o.checkbox.checked = false;
  o.session.setWritable(false);

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
    dispose() {
      o.checkbox.removeEventListener('change', onChange);
    },
  };
}

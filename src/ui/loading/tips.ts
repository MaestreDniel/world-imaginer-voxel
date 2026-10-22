/**
 * The loading screen's tips (SP4a spec §8.3, §7.3): templates whose `{<action>}` placeholders are filled from the key
 * map with `bindingLabel`, so a tip never names a key the map does not bind. Together the templates name every
 * action of the map (spec §7.3 "the help and the tips name every action"; tips.test.ts checks it).
 */
import { bindingLabel, type KeyEntry } from '../../player/keymap';

/**
 * The spec's topics, in its order: move, rise and descend, sprint, change speed, time speed, help and HUD, load
 * around you at the edge, shape the world on `?map` and "Open in 3D", the presets on the map, click to look and Esc to
 * free the mouse.
 */
export const TIP_TEMPLATES: readonly string[] = [
  'Fly with {forward} {left} {back} {right}: forward follows your look, the strafe stays level.',
  '{up} rises and {down} descends, straight up and down whatever way you look.',
  'Hold {sprint} to fly four times faster.',
  'Change your flying speed with {speedUp} and {speedDown}; the HUD shows it.',
  '{timeSpeed} changes the speed of time: ×1, ×10, ×60, then paused.',
  '{help} opens the help, with every key and the settings; {hud} shows or hides the counts.',
  'At the edge of the loaded world, {loadHere} loads the world around you.',
  'Shape the world on the map (?map), then press "Open in 3D" to fly through it.',
  'The map\'s presets open other worlds: large biomes, an archipelago, amplified mountains, floating islands.',
  'Click the world to look around with the mouse; {releasePointer} frees the mouse.',
];

/** A binding list as the help shows it ("Wheel up / + / ="). */
function labelsOf(entry: KeyEntry): string {
  return entry.bindings.map(bindingLabel).join(' / ');
}

/**
 * The templates filled from `map`, one tip per template in `TIP_TEMPLATES`' order. A template naming an action the map
 * lacks (or binds to nothing) is left out, so no tip ever shows a `{` or `}`.
 */
export function tips(map: readonly KeyEntry[]): string[] {
  const labels = new Map<string, string>();
  for (const e of map) if (e.bindings.length > 0) labels.set(e.action, labelsOf(e));
  const out: string[] = [];
  for (const template of TIP_TEMPLATES) {
    let complete = true;
    const tip = template.replace(/\{(\w+)\}/g, (_, action: string) => {
      const label = labels.get(action);
      if (label === undefined) complete = false;
      return label ?? '';
    });
    if (complete) out.push(tip);
  }
  return out;
}

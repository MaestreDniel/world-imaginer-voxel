/**
 * The loading screen's tips (SP4a spec §8.3, §7.3): templates whose `{<action>}` placeholders are filled from the key
 * map with `bindingLabel`, so a tip never names a key the map does not bind. Together the templates name every
 * action of the map (spec §7.3 "the help and the tips name every action"; tips.test.ts checks it).
 */
import { bindingLabel, type KeyEntry } from '../../player/keymap';

/**
 * The spec's topics, in its order: flight (SP4b spec §6.1: at your height, rise and descend), sprint, change speed,
 * time speed, help and HUD, the world loading around you (SP4b spec §6.2, in place of SP4a's R at the edge), the map
 * over the world (SP4c spec §2.4: M, teleport and live editing), the standalone `?map` and its "Open in 3D", the presets
 * on the map, click to look and Esc to free the mouse; then SP5a's build keys (SP5a spec §4.1, §4.6): F, E, 1-9 and the
 * wheel, the flying speed having moved to Ctrl+wheel.
 */
export const TIP_TEMPLATES: readonly string[] = [
  '{forward} {back} fly forward and back at your height, {left} {right} strafe; {up} and {down} rise and descend.',
  'Hold {sprint} to fly four times faster.',
  'Change your flying speed with {speedUp} and {speedDown} while flying; the HUD shows it.',
  '{timeSpeed} changes the speed of time: ×1, ×10, ×60, then paused.',
  '{help} opens the help, with every key and the settings; {hud} shows or hides the counts.',
  'The world loads around you as you fly; change the render distance in Help ({help}) → Settings.',
  '{map} opens the map over the world: click to go there, edit the world live.',
  'The map also opens on its own page (?map); its "Open in 3D" flies you into the world you shaped there.',
  'The map\'s presets open other worlds: large biomes, an archipelago, amplified mountains, floating islands.',
  'Click the world to look around with the mouse; {releasePointer} frees the mouse.',
  '{toggleWalk} switches between flying and walking.',
  'Pick a hotbar slot with {slot1} {slot2} {slot3} {slot4} {slot5} {slot6} {slot7} {slot8} {slot9} or the wheel ({slotPrev}, {slotNext}); {palette} opens the block palette.',
];

/** A binding list as the help shows it ("Ctrl+Wheel up / + / ="). */
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

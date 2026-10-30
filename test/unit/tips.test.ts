import { describe, expect, test } from 'vitest';
import { bindingLabel, DEFAULT_KEYMAP, type Action } from '../../src/player/keymap';
import { TIP_TEMPLATES, tips } from '../../src/ui/loading/tips';

/** The `{action}` placeholders a template names, in order. */
const placeholders = (t: string): string[] => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

describe('loading-screen tips (SP4a spec §8.3, §7.3; ruling P45)', () => {
  test('every key-map action has a {placeholder} in at least one template', () => {
    const named = new Set(TIP_TEMPLATES.flatMap(placeholders));
    const missing = DEFAULT_KEYMAP.map((e) => e.action).filter((a) => !named.has(a));
    expect(missing).toEqual([]);
    expect(DEFAULT_KEYMAP.length).toBe(29);
    expect(named.has('map')).toBe(true);
    // SP5b's B and G (SP5b spec §3.7).
    expect(named.has('savePlace')).toBe(true);
    expect(named.has('settings')).toBe(true);
    // SP5a's build group (SP5a spec §4.1, §4.6): F, E, 1-9 and the wheel.
    for (const a of ['toggleWalk', 'palette', 'slot1', 'slot5', 'slot9', 'slotNext', 'slotPrev']) expect(named.has(a), a).toBe(true);
  });

  test('the sprint tip names R and the double-tapped W, not Ctrl (Task 45b: Ctrl+W closes the tab)', () => {
    const text = tips(DEFAULT_KEYMAP).join('\n');
    expect(text).toContain('Hold R, or double-tap W, to sprint: four times faster in flight.');
    expect(text).not.toMatch(/\bCtrl\b(?!\+Wheel)/);
  });

  test('the speed tip names Ctrl+wheel, and a build tip names F, E, 1-9 and the wheel (SP5a spec §4.1, §4.6)', () => {
    const text = tips(DEFAULT_KEYMAP).join('\n');
    expect(text).toContain('Ctrl+Wheel up / + / =');
    expect(text).toContain('Ctrl+Wheel down / -');
    expect(text).toContain('1 2 3 4 5 6 7 8 9');
    expect(text).toContain('Wheel up');
    expect(text).toMatch(/\bF switches between flying and walking/);
    expect(text).toMatch(/\bE opens the block palette/);
  });

  test('each filled tip contains a binding label of every action its template names', () => {
    const filled = tips(DEFAULT_KEYMAP);
    expect(filled.length).toBe(TIP_TEMPLATES.length);
    TIP_TEMPLATES.forEach((template, i) => {
      for (const action of placeholders(template)) {
        const entry = DEFAULT_KEYMAP.find((e) => e.action === (action as Action));
        expect(entry, action).toBeDefined();
        const labels = entry!.bindings.map(bindingLabel);
        expect(labels.some((l) => filled[i]!.includes(l)), `${action} in "${filled[i]}"`).toBe(true);
      }
    });
  });

  test('no tip has a { or } left', () => {
    for (const t of tips(DEFAULT_KEYMAP)) expect(t).not.toMatch(/[{}]/);
  });

  test('the templates cover the spec\'s topics, the map and its presets included', () => {
    const text = tips(DEFAULT_KEYMAP).join('\n');
    expect(text).toContain('?map');
    expect(text).toContain('Open in 3D');
    expect(text).toMatch(/preset/i);
    // SP4c spec §2.4: M opens the map over the world; the ?map tip no longer says it is the only way to shape the world.
    expect(text).toContain('M opens the map over the world: click to go there, edit the world live.');
    expect(TIP_TEMPLATES).not.toContain('Shape the world on the map (?map), then press "Open in 3D" to fly through it.');
    expect(text).toMatch(/click/i);
  });

  test('the flight and streaming tips are present, and no tip speaks of an edge (SP4b spec §6.1, §6.2)', () => {
    expect(TIP_TEMPLATES).toContain('{forward} {back} fly forward and back at your height, {left} {right} strafe; {up} and {down} rise and descend.');
    expect(TIP_TEMPLATES).toContain('The world loads around you as you fly; change the render distance in Settings ({settings}).');
    const text = tips(DEFAULT_KEYMAP).join('\n');
    expect(text).toContain('W S fly forward and back at your height, A D strafe; Space and Left Shift / Right Shift rise and descend.');
    expect(text).toContain('The world loads around you as you fly; change the render distance in Settings (G).');
    expect(text).not.toMatch(/edge/i);
    expect(TIP_TEMPLATES.join('\n')).not.toContain('loadHere');
  });

  test('B saves a place in a saved world, and G opens the Settings (SP5b spec §3.7, D12)', () => {
    const text = tips(DEFAULT_KEYMAP).join('\n');
    expect(TIP_TEMPLATES).toContain('In a saved world, {savePlace} saves this place with a name and a colour.');
    expect(text).toContain('In a saved world, B saves this place with a name and a colour.');
    expect(text).toContain('Settings (G)');
    expect(text).not.toContain('Help (H / F1) → Settings');
  });

  test('a template naming an action the map lacks is left out', () => {
    const map = DEFAULT_KEYMAP.filter((e) => e.action !== 'timeSpeed');
    const filled = tips(map);
    expect(filled.length).toBe(TIP_TEMPLATES.filter((t) => !placeholders(t).includes('timeSpeed')).length);
    for (const t of filled) expect(t).not.toMatch(/[{}]/);
  });
});

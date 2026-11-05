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
    expect(DEFAULT_KEYMAP.length).toBe(43);
    expect(named.has('map')).toBe(true);
    // SP5b's B and G (SP5b spec §3.7).
    expect(named.has('savePlace')).toBe(true);
    expect(named.has('settings')).toBe(true);
    // SP5a's build group (SP5a spec §4.1, §4.6): F, E, 1-9 and the wheel.
    for (const a of ['toggleWalk', 'palette', 'slot1', 'slot5', 'slot9', 'slotNext', 'slotPrev']) expect(named.has(a), a).toBe(true);
    // SP5c's selection tool (SP5c spec §1.1, D4).
    for (const a of ['selectTool', 'copy', 'cut', 'paste', 'move', 'turn', 'turnBack', 'raise', 'lower']) expect(named.has(a), a).toBe(true);
    // SP6a's view keys (SP6a spec §7.1, §7.5).
    for (const a of ['xray', 'xrayDown', 'xrayUp', 'xrayAll', 'nightVision']) expect(named.has(a), a).toBe(true);
  });

  test('one tip names the X-ray\'s keys and night vision (SP6a spec §7.5)', () => {
    expect(TIP_TEMPLATES).toContain('{xray} shows the caves through the rock; {xrayDown} and {xrayUp} move the depth band, {xrayAll} shows every depth; {nightVision} is night vision.');
    expect(tips(DEFAULT_KEYMAP)).toContain('X shows the caves through the rock; Page Down and Page Up move the depth band, Home shows every depth; L is night vision.');
  });

  test('two tips name the selection tool\'s keys (SP5c spec §1.1, D4)', () => {
    expect(TIP_TEMPLATES).toContain('Press {selectTool} for the selection tool: LMB and RMB mark two corners, {copy} copies, {cut} cuts, {move} moves.');
    expect(TIP_TEMPLATES).toContain('{paste} pastes: {turn} and {turnBack} turn the paste, {raise} and {lower} raise and lower it, RMB places it.');
    const text = tips(DEFAULT_KEYMAP);
    expect(text).toContain('Press Q for the selection tool: LMB and RMB mark two corners, Ctrl+C copies, Ctrl+X cuts, N moves.');
    expect(text).toContain('Ctrl+V pastes: Wheel down and Wheel up turn the paste, ↑ and ↓ raise and lower it, RMB places it.');
  });

  test('the sprint tip names R and the double-tapped W, not Ctrl (Task 45b: Ctrl+W closes the tab)', () => {
    const text = tips(DEFAULT_KEYMAP).join('\n');
    expect(text).toContain('Hold R, or double-tap W, to sprint: four times faster in flight.');
    // The selection tips name Ctrl+C, Ctrl+X and Ctrl+V (SP5c spec §1.1); the sprint tip still names no Ctrl.
    expect(text).not.toMatch(/\bCtrl\b(?!\+(Wheel|[CXV]\b))/);
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

  test('the help\'s tip names its keys only: the settings moved to the Settings screen (SP5b spec §1.4; ruling P32)', () => {
    expect(TIP_TEMPLATES).toContain('{help} opens the help, with every key; {hud} shows or hides the counts.');
    expect(tips(DEFAULT_KEYMAP)).toContain('H / F1 opens the help, with every key; F3 shows or hides the counts.');
    expect(TIP_TEMPLATES.join('\n')).not.toContain('with every key and the settings');
  });

  test('a template naming an action the map lacks is left out', () => {
    const map = DEFAULT_KEYMAP.filter((e) => e.action !== 'timeSpeed');
    const filled = tips(map);
    expect(filled.length).toBe(TIP_TEMPLATES.filter((t) => !placeholders(t).includes('timeSpeed')).length);
    for (const t of filled) expect(t).not.toMatch(/[{}]/);
  });
});

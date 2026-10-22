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
    expect(DEFAULT_KEYMAP.length).toBe(14);
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
    expect(text).toMatch(/click/i);
  });

  test('a template naming an action the map lacks is left out', () => {
    const map = DEFAULT_KEYMAP.filter((e) => e.action !== 'timeSpeed');
    const filled = tips(map);
    expect(filled.length).toBe(TIP_TEMPLATES.filter((t) => !placeholders(t).includes('timeSpeed')).length);
    for (const t of filled) expect(t).not.toMatch(/[{}]/);
  });
});

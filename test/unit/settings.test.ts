import { describe, expect, test } from 'vitest';
import { loadSettings, saveSettings, SETTINGS_DEFAULTS, SETTINGS_KEY, type WorldSettings } from '../../src/ui/settings';

/** A storage holding `text` under the settings key. */
const holding = (text: string | null) => ({ getItem: (k: string) => (k === SETTINGS_KEY ? text : null) });

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v); } };
}

describe('loadSettings (SP4a spec §7.4, D31)', () => {
  test('the key and the defaults', () => {
    expect(SETTINGS_KEY).toBe('wi.world.settings');
    expect(SETTINGS_DEFAULTS).toEqual({ rd: null, fpsCap: 0, fov: 70, sensitivity: 1, brightness: 0.3 });
  });

  test('defaults with a null storage, with a throwing storage and with bad JSON', () => {
    expect(loadSettings(null)).toEqual(SETTINGS_DEFAULTS);
    expect(loadSettings({ getItem: () => { throw new Error('SecurityError'); } })).toEqual(SETTINGS_DEFAULTS);
    expect(loadSettings(holding('{rd: 8'))).toEqual(SETTINGS_DEFAULTS);
    expect(loadSettings(holding(null))).toEqual(SETTINGS_DEFAULTS);
    for (const text of ['42', 'null', '"x"', '[8, 60]']) expect(loadSettings(holding(text)), text).toEqual(SETTINGS_DEFAULTS);
  });

  test('{rd: 99, fov: \'x\', brightness: 2, fpsCap: 75} → {rd: 16, fov: 70, brightness: 1, fpsCap: 0}', () => {
    expect(loadSettings(holding(JSON.stringify({ rd: 99, fov: 'x', brightness: 2, fpsCap: 75 }))))
      .toEqual({ rd: 16, fov: 70, sensitivity: 1, brightness: 1, fpsCap: 0 });
  });

  test('each field clamps to its range; a missing or wrong-typed field falls back to its default', () => {
    expect(loadSettings(holding(JSON.stringify({ rd: 1, fpsCap: 144, fov: 10, sensitivity: 0, brightness: -1 }))))
      .toEqual({ rd: 4, fpsCap: 144, fov: 50, sensitivity: 0.1, brightness: 0 });
    expect(loadSettings(holding(JSON.stringify({ fov: 120, sensitivity: 9 })))).toMatchObject({ fov: 100, sensitivity: 5 });
    expect(loadSettings(holding(JSON.stringify({ rd: 7.6 }))).rd).toBe(8);
    expect(loadSettings(holding(JSON.stringify({ rd: null }))).rd).toBeNull();
    expect(loadSettings(holding(JSON.stringify({ rd: '8', fpsCap: '60', sensitivity: true, brightness: null }))))
      .toEqual(SETTINGS_DEFAULTS);
    for (const cap of [0, 30, 60, 120, 144]) expect(loadSettings(holding(JSON.stringify({ fpsCap: cap }))).fpsCap).toBe(cap);
  });
});

describe('saveSettings', () => {
  test('a round-trip', () => {
    const storage = memoryStorage();
    const s: WorldSettings = { rd: 10, fpsCap: 60, fov: 85, sensitivity: 1.7, brightness: 0.55 };
    saveSettings(storage, s);
    expect([...storage.items.keys()]).toEqual(['wi.world.settings']);
    expect(loadSettings(storage)).toEqual(s);
    saveSettings(storage, SETTINGS_DEFAULTS);
    expect(loadSettings(storage)).toEqual(SETTINGS_DEFAULTS);
  });

  test('a throwing storage (quota, private mode) and a null storage are ignored', () => {
    expect(() => saveSettings({ setItem: () => { throw new Error('QuotaExceededError'); } }, SETTINGS_DEFAULTS)).not.toThrow();
    expect(() => saveSettings(null, SETTINGS_DEFAULTS)).not.toThrow();
  });
});

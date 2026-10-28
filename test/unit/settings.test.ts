import { describe, expect, test } from 'vitest';
import { loadSettings, normalizeSettings, saveSettings, SETTINGS_DEFAULTS, SETTINGS_KEY, type WorldSettings } from '../../src/ui/settings';

/** A storage holding `text` under the settings key. */
const holding = (text: string | null) => ({ getItem: (k: string) => (k === SETTINGS_KEY ? text : null) });

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v); } };
}

describe('loadSettings (SP4a spec §7.4, D31)', () => {
  test('the key and the defaults', () => {
    expect(SETTINGS_KEY).toBe('wi.world.settings');
    expect(SETTINGS_DEFAULTS).toEqual({ rd: null, fpsCap: 0, fov: 70, sensitivity: 1, brightness: 0.3, mapMode: 'full', watchLive: true, holdRepeat: false });
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
      .toEqual({ ...SETTINGS_DEFAULTS, rd: 16, fov: 70, sensitivity: 1, brightness: 1, fpsCap: 0 });
  });

  test('each field clamps to its range; a missing or wrong-typed field falls back to its default', () => {
    expect(loadSettings(holding(JSON.stringify({ rd: 1, fpsCap: 144, fov: 10, sensitivity: 0, brightness: -1 }))))
      .toEqual({ ...SETTINGS_DEFAULTS, rd: 4, fpsCap: 144, fov: 50, sensitivity: 0.1, brightness: 0 });
    expect(loadSettings(holding(JSON.stringify({ fov: 120, sensitivity: 9 })))).toMatchObject({ fov: 100, sensitivity: 5 });
    expect(loadSettings(holding(JSON.stringify({ rd: 7.6 }))).rd).toBe(8);
    expect(loadSettings(holding(JSON.stringify({ rd: null }))).rd).toBeNull();
    expect(loadSettings(holding(JSON.stringify({ rd: '8', fpsCap: '60', sensitivity: true, brightness: null }))))
      .toEqual(SETTINGS_DEFAULTS);
    for (const cap of [0, 30, 60, 120, 144]) expect(loadSettings(holding(JSON.stringify({ fpsCap: cap }))).fpsCap).toBe(cap);
  });

  test('mapMode and watchLive kept through normalizeSettings; a bad value (\'half\', 1) defaults; an old stored object without them gets the defaults (SP4c spec §2.5)', () => {
    expect(normalizeSettings({ ...SETTINGS_DEFAULTS, mapMode: 'split', watchLive: false })).toEqual({ ...SETTINGS_DEFAULTS, mapMode: 'split', watchLive: false });
    expect(normalizeSettings({ mapMode: 'full', watchLive: true })).toMatchObject({ mapMode: 'full', watchLive: true });
    for (const bad of ['half', 1]) {
      const s = normalizeSettings({ mapMode: bad, watchLive: bad });
      expect(s.mapMode, String(bad)).toBe('full');
      expect(s.watchLive, String(bad)).toBe(true);
    }
    // SP4b's stored object (no mapMode, no watchLive): its fields kept, the two new ones at their defaults.
    const old = { rd: 8, fpsCap: 60, fov: 85, sensitivity: 1.7, brightness: 0.55 };
    expect(loadSettings(holding(JSON.stringify(old)))).toEqual({ ...old, mapMode: 'full', watchLive: true, holdRepeat: false });
  });

  test('`holdRepeat` false for a missing or non-boolean value; a boolean kept (SP5a spec §4.1, D6)', () => {
    expect(normalizeSettings({}).holdRepeat).toBe(false);
    for (const bad of [undefined, null, 1, 'true', {}]) expect(normalizeSettings({ holdRepeat: bad }).holdRepeat, String(bad)).toBe(false);
    expect(normalizeSettings({ ...SETTINGS_DEFAULTS, holdRepeat: true })).toEqual({ ...SETTINGS_DEFAULTS, holdRepeat: true });
    expect(normalizeSettings({ holdRepeat: false }).holdRepeat).toBe(false);
    // SP4c's stored object (no holdRepeat): its fields kept, the setting off.
    const sp4c = { rd: 8, fpsCap: 60, fov: 85, sensitivity: 1.7, brightness: 0.55, mapMode: 'split', watchLive: false };
    expect(loadSettings(holding(JSON.stringify(sp4c)))).toEqual({ ...sp4c, holdRepeat: false });
  });
});

describe('saveSettings', () => {
  test('a round-trip', () => {
    const storage = memoryStorage();
    const s: WorldSettings = { rd: 10, fpsCap: 60, fov: 85, sensitivity: 1.7, brightness: 0.55, mapMode: 'split', watchLive: false, holdRepeat: true };
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

/**
 * The world's small settings block (SP4a spec §7.4, D31): render distance, FPS cap, field of view, mouse sensitivity
 * and brightness, persisted in `localStorage` behind try/catch (master §4.16). SP5b's graphics settings screen replaces it.
 */
import { RD_MAX, RD_MIN } from '../engine/renderDistance';

export interface WorldSettings {
  /** null: the default (`defaultRenderDistance`); the page resolves it once under the reservation's cap (ruling P36). */
  rd: number | null;
  /** 0: no cap (the display's rate). */
  fpsCap: 0 | 30 | 60 | 120 | 144;
  /** Vertical field of view, degrees. */
  fov: number;
  sensitivity: number;
  brightness: number;
  /** The map's mode in the world (SP4c spec §2.2, §2.5, D16): full screen, or side by side with the 3D. */
  mapMode: 'full' | 'split';
  /** Mode A's "Watch live" (SP4c spec §2.1, §2.5): an Apply that rebuilds the world hides the map to show it. */
  watchLive: boolean;
}

/** The `localStorage` key. */
export const SETTINGS_KEY = 'wi.world.settings';

export const SETTINGS_DEFAULTS: Readonly<WorldSettings> = Object.freeze({
  rd: null, fpsCap: 0, fov: 70, sensitivity: 1, brightness: 0.3, mapMode: 'full', watchLive: true,
});

/** The FPS caps offered, in order (spec §6.8). */
export const FPS_CAPS: readonly WorldSettings['fpsCap'][] = [0, 30, 60, 120, 144];

/** The ranges of the continuous settings (spec §7.4: field of view 50-100°). */
export const SETTING_RANGES = Object.freeze({
  fov: { min: 50, max: 100, step: 1 },
  sensitivity: { min: 0.1, max: 5, step: 0.1 },
  brightness: { min: 0, max: 1, step: 0.05 },
});

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Settings from any value: each field clamped to its range (rd an integer in 4-16, the cap one of `FPS_CAPS`, the map's
 * mode 'full' or 'split', Watch live a boolean); a field that is missing, non-numeric or of the wrong type takes its
 * default (so an object stored before SP4c gets the map's defaults), and a non-object gives the defaults.
 */
export function normalizeSettings(raw: unknown): WorldSettings {
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const range = (key: keyof typeof SETTING_RANGES): number => {
    const v = o[key];
    return isNumber(v) ? clamp(v, SETTING_RANGES[key].min, SETTING_RANGES[key].max) : SETTINGS_DEFAULTS[key];
  };
  const cap = FPS_CAPS.find((c) => c === o.fpsCap);
  return {
    rd: isNumber(o.rd) ? clamp(Math.round(o.rd), RD_MIN, RD_MAX) : null,
    fpsCap: cap ?? SETTINGS_DEFAULTS.fpsCap,
    fov: range('fov'),
    sensitivity: range('sensitivity'),
    brightness: range('brightness'),
    mapMode: o.mapMode === 'split' || o.mapMode === 'full' ? o.mapMode : SETTINGS_DEFAULTS.mapMode,
    watchLive: typeof o.watchLive === 'boolean' ? o.watchLive : SETTINGS_DEFAULTS.watchLive,
  };
}

/** The saved settings; the defaults when the storage is null or throws (private mode, blocked site data) or the JSON is bad. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null): WorldSettings {
  if (storage === null) return { ...SETTINGS_DEFAULTS };
  try {
    const text = storage.getItem(SETTINGS_KEY);
    return normalizeSettings(text === null ? null : JSON.parse(text));
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

/** Saves the settings; anything the storage throws (quota, private mode) is ignored. */
export function saveSettings(storage: Pick<Storage, 'setItem'> | null, s: WorldSettings): void {
  if (storage === null) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // The settings only last for this page then; nothing else depends on them being stored.
  }
}

/**
 * The loading screen's background (SP4a spec §8.3, D22; ruling P46): a panorama picked at random from
 * `public/panoramas/manifest.json`, shown with `object-fit: cover` and faded in once decoded; until then, and whenever
 * the manifest, its entries or the image fail, the neutral gradient from the day sky's zenith to its horizon colour
 * (§6.5's DAY_ZENITH and DAY_HORIZON). The start screen shows the same background (§8.1).
 */
import { el } from '../common/dom';

/** One manifest entry, as `test/tools/panoramas.ts` writes it (spec §8.3). */
export interface PanoramaEntry {
  id: string;
  file: string;
  seed: string;
  profile: string;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  time: number;
  commit: string;
  renderer: string;
}

/** The day sky's zenith and horizon (src/daynight/dayNight.ts, spec §6.5), top to bottom. */
export const BACKGROUND_GRADIENT = 'linear-gradient(to bottom, #3D78D6, #A8CCF5)';
/** Where the manifest's files are served (Vite's `public/`, same origin, so COEP is satisfied). */
export const PANORAMA_DIR = '/panoramas/';
/** A plain file name under PANORAMA_DIR: no path separator, no leading dot. */
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const STRING_KEYS = ['id', 'file', 'seed', 'profile', 'commit', 'renderer'] as const;
const NUMBER_KEYS = ['x', 'z', 'yaw', 'pitch', 'time'] as const;

function entryOf(v: unknown): PanoramaEntry | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of STRING_KEYS) if (typeof o[k] !== 'string') return null;
  for (const k of NUMBER_KEYS) if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) return null;
  const file = o['file'] as string;
  if (o['id'] === '' || !FILE_NAME.test(file)) return null;
  return {
    id: o['id'] as string, file, seed: o['seed'] as string, profile: o['profile'] as string,
    x: o['x'] as number, z: o['z'] as number, yaw: o['yaw'] as number, pitch: o['pitch'] as number, time: o['time'] as number,
    commit: o['commit'] as string, renderer: o['renderer'] as string,
  };
}

/** The manifest's valid entries, copied field by field; anything but an array gives []. */
export function parseManifest(json: unknown): PanoramaEntry[] {
  if (!Array.isArray(json)) return [];
  const out: PanoramaEntry[] = [];
  for (const v of json) {
    const e = entryOf(v);
    if (e !== null) out.push(e);
  }
  return out;
}

/** One entry chosen by `rand()` in [0, 1) (a 1 picks the last), or null when there is none. */
export function pickPanorama(entries: PanoramaEntry[], rand: () => number): PanoramaEntry | null {
  if (entries.length === 0) return null;
  const i = Math.min(entries.length - 1, Math.max(0, Math.floor(rand() * entries.length)));
  return entries[i]!;
}

export interface BackdropOptions {
  /** Reads the manifest (`fetch('/panoramas/manifest.json')`, the JSON or null); a rejection keeps the gradient. */
  loadManifest: () => Promise<unknown>;
  rand: () => number;
}

/**
 * Mounts the background as the first child of `host` (id `<host.id>-backdrop`): the gradient at once, then the picked
 * panorama faded in on decode. Every failure keeps the gradient; nothing throws and no rejection is left unhandled.
 * `dispose()` stops a pending load from adding the image.
 */
export function mountBackdrop(host: HTMLElement, o: BackdropOptions): { readonly element: HTMLElement; dispose(): void } {
  const backdrop = el('div', 'screen-backdrop');
  backdrop.id = `${host.id}-backdrop`;
  backdrop.style.background = BACKGROUND_GRADIENT;
  host.append(backdrop);
  let live = true;

  const show = (entry: PanoramaEntry): void => {
    const img = el('img', 'screen-panorama');
    img.alt = '';
    img.style.objectFit = 'cover';
    img.style.opacity = '0';
    img.src = `${PANORAMA_DIR}${entry.file}`;
    img.dataset.id = entry.id;
    backdrop.append(img);
    img.decode().then(
      () => {
        if (!live) return;
        img.style.opacity = '1';
        img.dataset.state = 'shown';
      },
      () => img.remove(),
    );
  };

  let load: Promise<unknown>;
  try {
    load = o.loadManifest();
  } catch (e) {
    load = Promise.reject(e);
  }
  load.then(
    (json) => {
      if (!live) return;
      const entry = pickPanorama(parseManifest(json), o.rand);
      if (entry !== null) show(entry);
    },
    () => {},
  ).catch(() => {});

  return {
    element: backdrop,
    dispose() {
      live = false;
    },
  };
}

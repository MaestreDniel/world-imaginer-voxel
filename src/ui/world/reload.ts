/**
 * The world page's own navigations (SP4a spec §7.1, §7.5; rulings P42, P50): the URL that reloads the world around the
 * camera, a reloader that navigates at most once, and the `beforeunload` guard against Ctrl+W, which the reloader
 * disarms first so that the page's own reloads never ask "Leave site?".
 */

/** The camera's position and view; yaw and pitch in degrees (ruling P42), copied unchanged. */
export interface HereState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface Reloader {
  /** Disarms the leave guard and navigates to `url`; every call after the first does nothing (Review Focus 3). */
  reload(url: string): void;
}

/** A rounded integer without −0 (`+ 0` turns −0 into +0). */
const int = (v: number): number => Math.round(v) + 0;

/** Degrees to one decimal, without "-0.0". */
function deg(v: number): string {
  const s = v.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

/**
 * `/?at=<round x>,<round z>&y=<round y>&yaw=<deg, 1 dp>&pitch=<deg, 1 dp>[&rd=<rd>]#<hash>` (spec §7.5). `hash` may
 * carry its leading '#'; an empty one adds none. Without `rd` the reload resolves its render distance from the setting.
 */
export function hereUrl(s: HereState, rd: number | null, hash: string): string {
  const h = hash.replace(/^#/, '');
  return `/?at=${int(s.x)},${int(s.z)}&y=${int(s.y)}&yaw=${deg(s.yaw)}&pitch=${deg(s.pitch)}${rd === null ? '' : `&rd=${rd}`}${h === '' ? '' : `#${h}`}`;
}

/**
 * Calls `disarm()` and then `navigate(url)` on the first `reload`, and nothing on any later one: R pressed twice, or a
 * link clicked while a reload is under way, never stacks a second navigation (Review Focus 3; ruling P50).
 */
export function createReloader(navigate: (url: string) => void, disarm: () => void): Reloader {
  let done = false;
  return {
    reload(url) {
      if (done) return;
      done = true;
      disarm();
      navigate(url);
    },
  };
}

/**
 * Navigates the page to `url` (the reloader's `navigate`). A URL that resolves to the current one is reloaded: with a
 * `#` hash, `location.assign` of the same URL is a fragment navigation and loads nothing, so R, the RD setting or the
 * context-loss Reload pressed before the camera moved would do nothing and spend the reloader (final review C-I1).
 */
export function navigateTo(url: string, loc: Pick<Location, 'href' | 'assign' | 'reload'>): void {
  if (new URL(url, loc.href).href === loc.href) loc.reload();
  else loc.assign(url);
}

/**
 * Installs the Ctrl+W guard (spec §7.1): a `beforeunload` listener that asks before the tab closes (Ctrl+W, Ctrl+T and
 * Ctrl+N cannot be prevented by a key handler). Returns its disarm, which removes the listener (idempotent).
 */
export function installLeaveGuard(win: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const onBeforeUnload = (e: Event): void => {
    e.preventDefault();
    // The legacy way some browsers still read.
    (e as { returnValue?: unknown }).returnValue = '';
  };
  win.addEventListener('beforeunload', onBeforeUnload);
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    win.removeEventListener('beforeunload', onBeforeUnload);
  };
}

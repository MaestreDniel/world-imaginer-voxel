/**
 * The world page's own navigations (SP4a spec §7.1, §7.5; rulings P42, P50): the URL that reloads the world around the
 * camera, a reloader that navigates at most once, and the `beforeunload` guard against Ctrl+W, which the reloader
 * disarms first so that the page's own reloads never ask "Leave site?". Since SP4c (spec §1.6, D20) the address bar
 * follows the session and the last teleport (`createWorldUrl`), and every Reload reads the live session. In a saved
 * world (SP5b spec §3.4 step 7, D4) the address stays `/?world=<id>` and every Reload is `savedWorldUrl`.
 */
import type { WorldSession } from '../../engine/session';
import { encodeMapState, type MapView } from '../map/mapState';

/** The camera's position and view; yaw and pitch in degrees (ruling P42), copied unchanged. */
export interface HereState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface Reloader {
  /**
   * Disarms the leave guard and navigates to `url`; every call after the first does nothing (Review Focus 3), unless the
   * page asked and the user stayed.
   */
  reload(url: string): void;
}

/** A rounded integer without −0 (`+ 0` turns −0 into +0). */
const int = (v: number): number => Math.round(v) + 0;

/** Degrees to one decimal, without "-0.0". */
function deg(v: number): string {
  const s = v.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

/** The four parameters that place the camera, in `hereUrl`'s order and formats (spec §7.5). */
function placeParams(s: HereState): ReadonlyArray<readonly [key: string, value: string]> {
  return [['at', `${int(s.x)},${int(s.z)}`], ['y', String(int(s.y))], ['yaw', deg(s.yaw)], ['pitch', deg(s.pitch)]];
}

/**
 * `/?at=<round x>,<round z>&y=<round y>&yaw=<deg, 1 dp>&pitch=<deg, 1 dp>[&rd=<rd>]#<hash>` (spec §7.5). `hash` may
 * carry its leading '#'; an empty one adds none. Without `rd` the reload resolves its render distance from the setting.
 */
export function hereUrl(s: HereState, rd: number | null, hash: string): string {
  const h = hash.replace(/^#/, '');
  const place = placeParams(s).map(([k, v]) => `${k}=${v}`).join('&');
  return `/?${place}${rd === null ? '' : `&rd=${rd}`}${h === '' ? '' : `#${h}`}`;
}

/**
 * A saved world's Reload (SP5b spec §3.4 step 7, D4): `/?world=<id>[&rd=<rd>]`, the id URI-encoded. It reopens the
 * saved world at its last save; `hereUrl`'s `/?at=…#<hash>` would open an unsaved copy.
 */
export function savedWorldUrl(id: string, rd: number | null): string {
  return `/?world=${encodeURIComponent(id)}${rd === null ? '' : `&rd=${rd}`}`;
}

/**
 * The search after a teleport (SP4c spec §1.6, D20): `search` (with or without its '?') with `at`, `y`, `yaw` and
 * `pitch` set to `s` in `hereUrl`'s formats. Each is written where it first appears (a repeat is dropped) or, when
 * absent, appended in that order; every other parameter is kept as written and in place. The text is edited as is, not
 * through `URLSearchParams`, which would re-encode the other parameters and write `at`'s comma as `%2C`.
 */
export function withArrival(search: string, s: HereState): string {
  const place = new Map(placeParams(s));
  const written = new Set<string>();
  const parts: string[] = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = place.get(key);
    if (value === undefined) parts.push(part);
    else if (!written.has(key)) {
      written.add(key);
      parts.push(`${key}=${value}`);
    }
  }
  for (const [key, value] of place) if (!written.has(key)) parts.push(`${key}=${value}`);
  return `?${parts.join('&')}`;
}

/**
 * The world's hash (without '#', SP4c spec §1.6): the session's seed, profile and patch, and `view`, in `?map`'s
 * encoding, so a reload or a copied URL reopens the edited world.
 */
export function worldHash(session: Pick<WorldSession, 'state'>, view: MapView): string {
  const s = session.state;
  return encodeMapState({ v: 1, seed: s.seedText, profile: s.profile, patch: s.patch, view });
}

/** The world page's URL (SP4c spec §1.6, D20); see `createWorldUrl`. */
export interface WorldUrl {
  /** After every Apply (the apply control's `onApplied`): the URL is written with the session's hash. */
  applied(): void;
  /** After every view change of the map tool (its `onView`): the URL is written with the new view. */
  viewChanged(): void;
  /**
   * A teleport's `onArrive`, with the camera where it arrived: the search's `at`, `y`, `yaw` and `pitch` become the
   * arrival's (`withArrival`), then the URL is written. Nothing else changes the search: flight never does.
   */
  arrived(s: HereState): void;
  /**
   * The failure panel's and the context loss's Reload (`hereUrl`): the camera now, the live session and view, never the
   * hash the page was loaded with.
   */
  here(rd: number | null): string;
}

/**
 * The world page's URL rules (SP4c spec §1.6, D20): after every Apply and every view change of the map tool,
 * `pathname + search + '#' + worldHash(session, view())` goes to `writer` (the page's `createUrlWriter`: a 200 ms
 * debounce, `history.replaceState`, a hash over 64 KiB dropped with `oversizeNotice`); never `?map`. `view()` is the
 * tool's view, or the camera-centred one before the first M (`MapOverlay.view`). The search is the page's at
 * creation; only `arrived` rewrites it, kept here rather than read back from `loc`, so a write still waiting in the
 * writer's debounce cannot be undone by a later one. No `hashchange` listener: the world never reads its hash again.
 */
export function createWorldUrl(o: {
  readonly session: Pick<WorldSession, 'state'>;
  view(): MapView;
  /** The live camera, read by `here`. */
  readonly camera: HereState;
  readonly writer: { set(url: string): void };
  readonly loc: Pick<Location, 'pathname' | 'search'>;
}): WorldUrl {
  let search = o.loc.search;
  const write = (): void => o.writer.set(`${o.loc.pathname}${search}#${worldHash(o.session, o.view())}`);
  return {
    applied: write,
    viewChanged: write,
    arrived(s) {
      search = withArrival(search, s);
      write();
    },
    here: (rd) => hereUrl(o.camera, rd, worldHash(o.session, o.view())),
  };
}

/**
 * Calls `disarm()` and then `navigate(url)` on the first `reload`, and nothing on any later one: a link clicked twice, or
 * another clicked while a reload is under way, never stacks a second navigation (Review Focus 3; ruling P50). A
 * `navigate` whose promise resolves false did not leave after all (the page asked, and the user stayed: final review
 * MENU-1), and the next `reload` runs again.
 */
export function createReloader(navigate: (url: string) => void | Promise<boolean>, disarm: () => void): Reloader {
  let done = false;
  return {
    reload(url) {
      if (done) return;
      done = true;
      disarm();
      void navigate(url)?.then((left) => { if (!left) done = false; });
    },
  };
}

/**
 * Navigates the page to `url` (the reloader's `navigate`). A URL that resolves to the current one is reloaded: with a
 * `#` hash, `location.assign` of the same URL is a fragment navigation and loads nothing, so the RD setting or the
 * context-loss Reload used before the camera moved would do nothing and spend the reloader (final review C-I1).
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

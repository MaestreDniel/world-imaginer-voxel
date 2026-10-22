/**
 * The minimal start screen of `/` (SP4a spec §8.1, D21; rulings P44, P46): on the loading screen's background, the
 * title, the seed and the profile the world will use, "Enter the world" and "Open the map" (`?map#<the same hash>`).
 * Nothing is probed, generated or allocated while it shows: the session is only built, through `openMapSession` (tier 2
 * of the trees included), so the screen names exactly the world that loads. A decode error shows the message and only
 * "Open the map"; a tier-2 refusal shows the session's notice as a warning and keeps both buttons (the default profile,
 * shown, is then the one that loads). The full start and worlds menu is SP5's (§13.2).
 */
import type { Seed64 } from '../../core/hash';
import { el } from '../common/dom';
import { mountBackdrop } from '../loading/panoramas';
import { decodeMapState, openMapSession } from '../map/mapState';

/** `?at`, `?rd` or `?workers` skips the start screen (they come from a link, a reload or a tool; spec §8.1). */
const WORLD_KEYS = ['at', 'rd', 'workers'] as const;

/** 'world' iff any of `at`, `rd` or `workers` is in the query; a `#` hash or `?renderer` alone keeps 'start'. */
export function startModeOf(query: URLSearchParams): 'start' | 'world' {
  return WORLD_KEYS.some((k) => query.has(k)) ? 'world' : 'start';
}

export interface StartScreenOptions {
  /** The page's `#` hash in `?map`'s encoding, with or without its '#'; empty means `?map`'s defaults. */
  readonly hash: string;
  /** Called once, on the first "Enter the world"; the page then disposes this screen and starts the load (§8.4). */
  onEnter(): void;
  /** The session's random seed source (`cryptoSeed`); a decoded state always has a seed text, so it is not called. */
  random: () => Seed64;
  /** The panorama manifest's reader and the pick (the loading screen's background, ruling P46). */
  loadManifest: () => Promise<unknown>;
  rand: () => number;
}

export function mountStartScreen(root: HTMLElement, o: StartScreenOptions): { dispose(): void } {
  const text = o.hash.replace(/^#/, '');
  const mapHref = text === '' ? '?map' : `?map#${text}`;

  const screen = el('div', 'start-screen');
  screen.id = 'start-screen';
  root.append(screen);
  const backdrop = mountBackdrop(screen, { loadManifest: o.loadManifest, rand: o.rand });

  const card = el('section', 'start-card');
  const title = el('h1', 'start-title', 'world-imaginer-voxel');
  title.id = 'start-title';
  const error = el('p', 'start-error bad');
  error.id = 'start-error';
  error.hidden = true;
  const notice = el('p', 'start-notice warn');
  notice.id = 'start-notice';
  notice.hidden = true;
  const map = el('a', 'start-button', 'Open the map');
  map.id = 'start-map';
  map.href = mapHref;
  const actions = el('nav', 'start-actions');
  card.append(title);

  const d = decodeMapState(o.hash);
  if (d.error !== null) {
    error.textContent = d.error;
    error.hidden = false;
    actions.append(map);
    card.append(error, notice, actions);
  } else {
    const session = openMapSession(d.state, o.random);
    const seed = el('p', 'start-seed', `Seed: ${session.state.seedText}`);
    seed.id = 'start-seed';
    const profile = el('p', 'start-profile', `Profile: ${session.state.profile}`);
    profile.id = 'start-profile';
    if (session.initNotice !== null) {
      notice.textContent = session.initNotice;
      notice.hidden = false;
    }
    const enter = el('button', 'start-button start-enter', 'Enter the world');
    enter.id = 'start-enter';
    enter.type = 'button';
    let entered = false;
    enter.addEventListener('click', () => {
      // Review Focus 3: a double-click must not start a second pool and store; only the first click counts.
      if (entered) return;
      entered = true;
      enter.disabled = true;
      map.removeAttribute('href');
      map.setAttribute('aria-disabled', 'true');
      o.onEnter();
    });
    map.addEventListener('click', (e) => {
      if (entered) e.preventDefault();
    });
    actions.append(enter, map);
    card.append(seed, profile, error, notice, actions);
  }
  screen.append(card);

  return {
    dispose() {
      backdrop.dispose();
      screen.remove();
    },
  };
}

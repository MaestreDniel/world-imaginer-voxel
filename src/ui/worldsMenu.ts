/**
 * The start screen and the worlds menu of `/` (SP5b spec §1.1, §1.2, D1, D2; replaces SP4a's `ui/world/startScreen.ts`),
 * on the loading screen's background (`mountBackdrop`).
 * - Start (D1): the title, New world, Load world and Settings, then the small links Map (`?map`) and Selftest
 *   (`?selftest=1`), and the screen's notice row (`#start-notice`), which shows the world page's refusal carried here
 *   as `?notice=<code>` (`noticeOfQuery`). A `#` hash is ignored. Load world is Task 21's and Settings Task 28's: until
 *   then their buttons do nothing.
 * - New world (D2): Name (proposed "New world N", which a cleared name takes at Create; at most `MAX_NAME` characters),
 *   Preset (the ready profiles in code order, as the map's select), Seed (a random 64-bit decimal; the dice puts another;
 *   any text, `resolveSeedText`), Create and Back. Create writes the `worlds` record and a new `state` in one write
 *   (`saves.create`), asks the browser once to keep this site's storage (`persistStorage`, remembered under
 *   `PERSIST_ASKED_KEY`), then navigates to `/?world=<id>`; under the enter bench (`benchDb`, SP5b spec §6.2) the world
 *   is written to that database and its URL carries `&enterBench=1&db=<name>`. Without storage (`saves` null, D14)
 *   Create shows "Saving is not available in this browser window" until Task 29 opens the unsaved world instead.
 * Ids and the wall clock come in through the options (`newId`, `now`); text goes through `textContent` only.
 */
import { hex64, type Seed64 } from '../core/hash';
import { SCHEMA_VERSION, type JsonObject } from '../core/params/migrate';
import { resolveProfile, type ProfileId } from '../core/params/profiles';
import { seedToText } from '../core/seed';
import { genKey, paramsHash, stageHashes } from '../core/stage/hash';
import { GENERATOR_VERSION } from '../core/constants';
import { loadParams, MAX_NAME, newState, newWorldName, todayStateTable, type Saves, type WorldRecord } from '../persist/saves';
import { el } from './common/dom';
import { createNotices } from './common/notice';
import { mountBackdrop } from './loading/panoramas';
import { profileOptions } from './map/toolbar';
import { resolveSeedText } from './seedBox';
import { STATE_BOUNDS } from './world/stateBounds';
import { LOCKED_NOTICE, type LockManagerLike } from './world/worldLock';
import type { WorldQuery } from './world/query';

/**
 * `?at`, `?rd` or `?workers` skips the start screen (they come from a link, a reload or a tool; SP4a spec §8.1), and so
 * does a saved world's `?world` (SP5b spec §1.1).
 */
const WORLD_KEYS = ['at', 'rd', 'workers', 'world'] as const;

/** 'world' iff any of `at`, `rd`, `workers` or `world` is in the query; a `#` hash or `?renderer` alone keeps 'start'. */
export function startModeOf(query: URLSearchParams): 'start' | 'world' {
  return WORLD_KEYS.some((k) => query.has(k)) ? 'world' : 'start';
}

/**
 * The saved worlds' database the menu opens: the enter bench's `?db=` (only with `enterBench=1`, `parseWorldQuery`),
 * else `wi10`, the world page's `SAVES_DB` (a mirror: the menu does not import the world page's module, which `/` would
 * then load; `worldsMenu.test.ts` pins them equal).
 */
export function savesDbOf(q: Pick<WorldQuery, 'db'>): string {
  return q.db ?? 'wi10';
}

/** The `localStorage` flag set at the first Create's `navigator.storage.persist()` request (D2, master §4.13). */
export const PERSIST_ASKED_KEY = 'wi.persistAsked';
/** The `sessionStorage` key that carries an `unreadable` refusal's reason from the world page to the menu. */
export const REFUSAL_REASON_KEY = 'wi.openRefusal';

/** Why the world page did not open a saved world (SP5b spec §3.4 steps 1-2): held by another tab, or unreadable. */
export type OpenRefusal = { readonly notice: 'locked' } | { readonly notice: 'unreadable'; readonly reason: string };

/** A refusal's notice: D7's `LOCKED_NOTICE`, or "This world could not be opened: <reason>" (D14). */
export function refusalText(r: OpenRefusal): string {
  return r.notice === 'locked' ? LOCKED_NOTICE : `This world could not be opened: ${r.reason}`;
}

/** The part of `Storage` the refusal's reason and the persist flag use. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `sessionStorage`, or null when reading it throws (blocked site data). */
export function sessionStorageOrNull(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function localStorageOrNull(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The menu's URL for a refusal (`/?notice=locked` or `/?notice=unreadable`); an `unreadable` refusal's reason goes to
 * `storage` under `REFUSAL_REASON_KEY` (a URL would keep it across a reload or a shared link). Never throws.
 */
export function refusalUrl(r: OpenRefusal, storage: StorageLike | null): string {
  if (r.notice === 'unreadable') {
    try {
      storage?.setItem(REFUSAL_REASON_KEY, r.reason);
    } catch { /* the menu then names no reason */ }
  }
  return `/?notice=${r.notice}`;
}

/**
 * The start screen's notice for `?notice=<code>` (the world page's refusal), or null: `locked` → D7's text, `unreadable`
 * → "This world could not be opened: <reason>", the reason read from `storage` and removed (unknown when absent). Any
 * other code is ignored. Never throws.
 */
export function noticeOfQuery(query: URLSearchParams, storage: StorageLike | null): string | null {
  const code = query.get('notice');
  if (code === 'locked') return refusalText({ notice: 'locked' });
  if (code !== 'unreadable') return null;
  let reason: string | null = null;
  try {
    reason = storage?.getItem(REFUSAL_REASON_KEY) ?? null;
    storage?.removeItem(REFUSAL_REASON_KEY);
  } catch { /* unknown reason */ }
  return refusalText({ notice: 'unreadable', reason: reason ?? 'the reason was not kept' });
}

export interface WorldsMenuOptions {
  /** The saved worlds (`savesDbOf`'s database); null when storage cannot open (D14, Task 29). */
  readonly saves: Saves | null;
  /** The worlds' locks, for Load world's Rename and Delete (D7, D24; Task 21). */
  readonly locks: LockManagerLike;
  /** A new world's random seed (`cryptoSeed`): the seed field's first value, each dice, and an empty seed at Create. */
  random: () => Seed64;
  /** A new world's id (`crypto.randomUUID()`). */
  newId(): string;
  /** The wall clock (`Date.now()`), the record's `created`. */
  now(): number;
  /** Leaves the menu for `url` (`location.assign`). */
  navigate(url: string): void;
  /** `navigator.storage.persist()`; asked once, at the first Create (D2). */
  persistStorage(): Promise<boolean>;
  /** Mounts the unsaved world in place with the `#` hash and the page's `unsavedNotice` (D14, Task 29). */
  enterUnsaved(hash: string, notice: string): void;
  /** The panorama manifest's reader and the pick (the loading screen's background). */
  loadManifest: () => Promise<unknown>;
  rand: () => number;
  /** The world page's refusal (`noticeOfQuery`), shown in the start screen's notice row until dismissed; or null. */
  readonly notice: string | null;
  /** The enter bench's database (`?enterBench=1&db=`, SP5b spec §6.2), which Create's URL carries; null otherwise. */
  readonly benchDb: string | null;
}

/** "Saving is not available in this browser window" (D14): Create's notice while `saves` is null. */
const NO_STORAGE = 'Saving is not available in this browser window';

/**
 * A new world's `worlds` record (§1.2): the preset's resolved parameters as stored (`params`) and as loaded
 * (`loadParams`, which the world page's open reads them through, so the stored genKey is the one it computes).
 */
function createdRecord(id: string, name: string, seed: { text: string; seed: Seed64 }, profile: ProfileId, created: number): WorldRecord {
  const stored = resolveProfile(profile) as unknown as JsonObject;
  const loaded = loadParams({ params: stored, schemaVersion: SCHEMA_VERSION, profile });
  if (!loaded.ok) throw new Error(`the ${profile} preset's parameters do not load: ${loaded.issues[0]?.message ?? 'no issue'}`);
  return {
    id, name, seedText: seed.text, seed: [seed.seed[0], seed.seed[1]], profile, params: stored, schemaVersion: SCHEMA_VERSION,
    paramsHash: hex64(paramsHash(loaded.value)), generatorVersion: GENERATOR_VERSION, genKey: hex64(genKey(seed.seed, stageHashes(loaded.value))),
    stateTable: todayStateTable(), created, backupOf: null,
  };
}

const button = (id: string, text: string): HTMLButtonElement => {
  const b = el('button', 'start-button', text);
  b.id = id;
  b.type = 'button';
  return b;
};

const field = (label: string, control: HTMLElement): HTMLLabelElement => {
  const l = el('label', '', label);
  l.append(control);
  return l;
};

export function mountWorldsMenu(root: HTMLElement, o: WorldsMenuOptions): { dispose(): void } {
  const screen = el('div', 'start-screen');
  screen.id = 'start-screen';
  root.append(screen);
  const backdrop = mountBackdrop(screen, { loadManifest: o.loadManifest, rand: o.rand });
  let disposed = false;

  // Start (D1).
  const start = el('section', 'start-card');
  start.id = 'start-card';
  const title = el('h1', 'start-title', 'world-imaginer-voxel');
  title.id = 'start-title';
  const newButton = button('start-new', 'New world');
  const loadButton = button('start-load', 'Load world');
  const settingsButton = button('start-settings', 'Settings');
  const actions = el('nav', 'start-actions');
  actions.append(newButton, loadButton, settingsButton);
  const map = el('a', '', 'Map');
  map.id = 'start-map';
  map.href = '?map';
  const selftest = el('a', '', 'Selftest');
  selftest.id = 'start-selftest';
  selftest.href = '?selftest=1';
  const links = el('nav', 'loading-links');
  links.append(map, selftest);
  const startNoticeRow = el('div');
  startNoticeRow.id = 'start-notice';
  start.append(title, actions, links, startNoticeRow);
  const startNotices = createNotices(startNoticeRow);
  if (o.notice !== null) startNotices.show(o.notice, { kind: 'warn' });

  // New world (D2).
  const create = el('section', 'start-card');
  create.id = 'new-world';
  create.hidden = true;
  const heading = el('h1', 'start-title', 'New world');
  const name = el('input');
  name.id = 'new-name';
  name.type = 'text';
  const preset = el('select');
  preset.id = 'new-preset';
  for (const p of profileOptions()) preset.append(new Option(p, p));
  const seed = el('input');
  seed.id = 'new-seed';
  seed.type = 'text';
  const dice = button('new-dice', 'Dice');
  dice.title = 'Another random seed';
  const seedRow = el('div', 'start-actions');
  seedRow.append(seed, dice);
  const createButton = button('new-create', 'Create');
  const back = button('new-back', 'Back');
  const createActions = el('nav', 'start-actions');
  createActions.append(createButton, back);
  const newNoticeRow = el('div');
  newNoticeRow.id = 'new-notice';
  create.append(heading, field('Name', name), field('Preset', preset), field('Seed', seedRow), createActions, newNoticeRow);
  const newNotices = createNotices(newNoticeRow);

  screen.append(start, create);

  /** The name a cleared field takes at Create: "New world N", N the smallest no saved world uses. */
  let proposal = newWorldName([]);
  let creating = false;

  const show = (which: 'start' | 'new'): void => {
    start.hidden = which !== 'start';
    create.hidden = which !== 'new';
  };

  newButton.addEventListener('click', () => {
    newNotices.clear();
    seed.value = seedToText(o.random());
    preset.value = profileOptions()[0]!;
    proposal = newWorldName([]);
    name.value = proposal;
    show('new');
    if (o.saves === null) return;
    const names = o.saves.list().then(
      (rows) => rows.flatMap((r) => (r.broken ? [] : [r.world.name])),
      () => [] as string[],
    );
    void names.then((taken) => {
      if (disposed) return;
      const was = proposal;
      proposal = newWorldName(taken);
      // A name the player typed meanwhile stays.
      if (name.value === was) name.value = proposal;
    });
  });

  dice.addEventListener('click', () => {
    seed.value = seedToText(o.random());
  });

  back.addEventListener('click', () => {
    if (creating) return;
    show('start');
  });

  createButton.addEventListener('click', () => {
    if (creating) return;
    if (o.saves === null) {
      newNotices.show(NO_STORAGE, { kind: 'error' });
      return;
    }
    const saves = o.saves;
    creating = true;
    createButton.disabled = true;
    const typed = Array.from(name.value.trim()).slice(0, MAX_NAME).join('');
    const id = o.newId();
    const world = createdRecord(id, typed === '' ? proposal : typed, resolveSeedText(seed.value, o.random), preset.value as ProfileId, o.now());
    void (async () => {
      const w = await saves.create(world, newState(id, STATE_BOUNDS));
      if (disposed) return;
      if (w.status !== 'complete') {
        creating = false;
        createButton.disabled = false;
        newNotices.show(`The world could not be created (${w.status}${w.errorName === null ? '' : `: ${w.errorName}`})`, { kind: 'error' });
        return;
      }
      await askPersistOnce(o.persistStorage);
      if (disposed) return;
      const bench = o.benchDb === null ? '' : `&enterBench=1&db=${encodeURIComponent(o.benchDb)}`;
      o.navigate(`/?world=${encodeURIComponent(id)}${bench}`);
    })();
  });

  return {
    dispose() {
      disposed = true;
      startNotices.dispose();
      newNotices.dispose();
      backdrop.dispose();
      screen.remove();
    },
  };
}

/**
 * `navigator.storage.persist()` at the first Create only (D2): skipped when `PERSIST_ASKED_KEY` is set, which is set
 * before asking (without `localStorage` every Create asks); awaited, since Firefox's prompt belongs to this page, and
 * its answer and any failure ignored.
 */
async function askPersistOnce(persist: () => Promise<boolean>): Promise<void> {
  const storage = localStorageOrNull();
  try {
    if (storage?.getItem(PERSIST_ASKED_KEY) === '1') return;
    storage?.setItem(PERSIST_ASKED_KEY, '1');
  } catch { /* asked at every Create instead */ }
  try {
    await persist();
  } catch { /* either answer works (D2) */ }
}

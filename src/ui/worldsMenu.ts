/**
 * The start screen and the worlds menu of `/` (SP5b spec §1.1, §1.2, D1, D2; replaces SP4a's `ui/world/startScreen.ts`),
 * on the loading screen's background (`mountBackdrop`).
 * - Start (D1): the title, New world, Load world and Settings, then the small links Map (`?map`) and Selftest
 *   (`?selftest=1`), and the screen's notice row (`#start-notice`), which shows the world page's refusal carried here
 *   as `?notice=<code>` (`noticeOfQuery`). A `#` hash is ignored. Settings opens the Settings screen over the start
 *   screen (§1.4, D9; `mountSettingsPanel`), its render distance "Default" naming no number and its choices 4 … 16 (no
 *   capability probe runs here), every change kept in `wi.world.settings` as the world page keeps it.
 * - New world (D2): Name (proposed "New world N", which a cleared name takes at Create; at most `MAX_NAME` characters),
 *   Preset (the ready profiles in code order, as the map's select), Seed (a random 64-bit decimal; the dice puts another;
 *   any text, `resolveSeedText`), Create and Back. Create writes the `worlds` record and a new `state` in one write
 *   (`saves.create`), asks the browser once to keep this site's storage (`persistStorage`, remembered under
 *   `PERSIST_ASKED_KEY`, its answer awaited at most `PERSIST_WAIT_MS`), then navigates to `/?world=<id>`; under the
 *   enter bench (`benchDb`, SP5b spec §6.2) the world is written to that database and its URL carries
 *   `&enterBench=1&db=<name>`. Without storage (`saves` null, §3.8, D14) Create mounts the unsaved world in place instead (`enterUnsaved`, as SP4a's "Enter the world"): the seed and
 *   preset as its `#` hash in `?map`'s encoding, no `?rd`, with `UNSAVED_NO_STORAGE_NOTICE` in place of Point 2's.
 * - Load world (§1.3, D3): one row per world of `saves.list()`, the most recently modified first ("name · preset · seed
 *   N", "Modified YYYY-MM-DD HH:MM" in local time with "· n places" when it has any, "automatic copy" for a backup,
 *   "older generator" when its stored genKey is not today's, D8), with Play (`/?world=<id>`), Rename (the name becomes a
 *   text field: Enter keeps, Esc cancels), Export and Delete (asked in the screen's notice row, `notices.confirm`, never
 *   a browser dialog); a broken row (D14: a record `parseWorldRecord` refuses, or params `loadParams` refuses) shows why
 *   with Delete only. Rename and Delete write under the world's lock taken only if it is free (`withWorldIfFree`, D7,
 *   D24), and a held lock refuses them with `LOCKED_NOTICE`. The list is read again when the tab becomes visible
 *   (§1.1), and each read's time, through the rows' build, is recorded on `window.__wiMenuListMs` for the smoke's
 *   `menus` step.
 * - Export and Import .wiworld (§2.4, D15): Export reads the world's last committed save in one read (`saves.readAll`,
 *   no lock: a world open in another tab is read at one `flushSeq`, D7) and downloads it as `exportFileName(name)`.
 *   Import .wiworld opens a file picker (`#load-import-file`), reads the file (`readWiworld`, under a new id), writes it
 *   in one write (`saves.writeAll`) and says "Imported 'name'", with "n columns of this world could not be read" and
 *   "n blocks of unknown types became air" when there are any; a refusal writes nothing and shows its reason.
 * - Storage (§3.8, D14): without it (`saves` null) Load world and Import say `NO_STORAGE`; a `versionchange` on the
 *   menu's connection shows `RELOAD_NOTICE` and the menu writes nothing more (Create, Rename, Delete and Import show it
 *   instead).
 * Ids and the wall clock come in through the options (`newId`, `now`); text goes through `textContent` only.
 */
import { hex64, type Seed64 } from '../core/hash';
import type { Issue } from '../core/params/kit';
import { SCHEMA_VERSION, type JsonObject } from '../core/params/migrate';
import { resolveProfile, type ProfileId } from '../core/params/profiles';
import { seedToText } from '../core/seed';
import { genKey, paramsHash, stageHashes } from '../core/stage/hash';
import { GENERATOR_VERSION } from '../core/constants';
import type { WriteResult } from '../persist/kv';
import {
  exportFileName, loadParams, MAX_NAME, newState, newWorldName, olderGenerator, todayStateTable, type Saves, type WorldRecord, type WorldRow,
} from '../persist/saves';
import { readWiworld, writeWiworld } from '../persist/wiworld';
import { el } from './common/dom';
import { downloadBlob, readBinaryFile } from './common/files';
import { createNotices, type Notices } from './common/notice';
import { mountBackdrop } from './loading/panoramas';
import { DEFAULT_MAP_STATE, encodeMapState } from './map/mapState';
import { profileOptions } from './map/toolbar';
import { resolveSeedText } from './seedBox';
import { loadSettings, saveSettings } from './settings';
import { mountSettingsPanel } from './settingsPanel';
import { STATE_BOUNDS } from './world/stateBounds';
import { LOCKED_NOTICE, withWorldIfFree, type LockManagerLike } from './world/worldLock';
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
/** How long Create waits for the `navigator.storage.persist()` answer before it opens the world anyway (D2). */
export const PERSIST_WAIT_MS = 3000;
/** The `sessionStorage` key that carries an `unreadable` refusal's reason from the world page to the menu. */
export const REFUSAL_REASON_KEY = 'wi.openRefusal';

/** Why the world page did not open a saved world (SP5b spec §3.4 steps 1-2): held by another tab, or unreadable. */
export type OpenRefusal = { readonly notice: 'locked' } | { readonly notice: 'unreadable'; readonly reason: string };

/** A refusal's notice: D7's `LOCKED_NOTICE`, or "This world could not be opened: <reason>" (D14). */
export function refusalText(r: OpenRefusal): string {
  return r.notice === 'locked' ? LOCKED_NOTICE : `This world could not be opened: ${r.reason}`;
}

/** Why params `loadParams` refuses do not open, as the world page and the list's broken row say it (D14). */
export function invalidParamsReason(issues: readonly Issue[]): string {
  const i = issues[0];
  return i === undefined ? 'invalid params' : `invalid params (${i.path === '' ? '<root>' : i.path} ${i.code})`;
}

/** The second line of an older generator's row, under its badge (D3, D8). */
const OLDER_GENERATOR_LINE = 'opens with today\'s terrain; your blocks stay at their coordinates';

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
  /** The saved worlds (`savesDbOf`'s database); null when storage cannot open (`openSaves`, §3.8, D14). */
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
  /** Mounts the unsaved world in place with the `#` hash and the page's `unsavedNotice` (§3.8, D14). */
  enterUnsaved(hash: string, notice: string): void;
  /** The panorama manifest's reader and the pick (the loading screen's background). */
  loadManifest: () => Promise<unknown>;
  rand: () => number;
  /** The world page's refusal (`noticeOfQuery`), shown in the start screen's notice row until dismissed; or null. */
  readonly notice: string | null;
  /** The enter bench's database (`?enterBench=1&db=`, SP5b spec §6.2), which Create's URL carries; null otherwise. */
  readonly benchDb: string | null;
}

/** D14: Load world's notice while `saves` is null, and the world page's reason when its connection cannot open. */
export const NO_STORAGE = 'Saving is not available in this browser window';
/** D14: the unsaved world New world opens without storage shows this in place of Point 2's notice. */
export const UNSAVED_NO_STORAGE_NOTICE = 'This world is not saved: this browser window cannot store data.';
/** D14: a `versionchange` on a connection (a newer version of the database opens elsewhere); it closed itself. */
export const RELOAD_NOTICE = 'Reload to continue';
/** D14: `blocked` while a connection opens (another tab holds an older version of the database). */
export const BLOCKED_NOTICE = 'Close other tabs of world-imaginer-voxel';

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

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "Modified YYYY-MM-DD HH:MM" in local time (D3). */
function modifiedText(ms: number): string {
  const d = new Date(ms);
  return `Modified ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A write's failure, as Create's notice words it: "abort: QuotaExceededError". */
const writeFailure = (w: WriteResult): string => `${w.status}${w.errorName === null ? '' : `: ${w.errorName}`}`;

/** The name of a failure that rejected (a lock request, a read; a `DOMException` included). */
const errorName = (e: unknown): string => {
  const n = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return typeof n === 'string' ? n : String(e);
};

/** Records a list read's time for the smoke's `menus` step (`window.__wiMenuListMs`). */
function recordListMs(ms: number): void {
  (globalThis as { __wiMenuListMs?: number }).__wiMenuListMs = ms;
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

  // Load world (D3).
  const load = el('section', 'start-card');
  load.id = 'load-world';
  load.hidden = true;
  const loadHeading = el('h1', 'start-title', 'Load world');
  const list = el('ul', 'world-list');
  list.id = 'load-list';
  const importButton = button('load-import', 'Import .wiworld');
  const importFile = el('input');
  importFile.id = 'load-import-file';
  importFile.type = 'file';
  importFile.accept = '.wiworld';
  importFile.hidden = true;
  const loadBack = button('load-back', 'Back');
  const loadActions = el('nav', 'start-actions');
  loadActions.append(importButton, importFile, loadBack);
  const loadNoticeRow = el('div');
  loadNoticeRow.id = 'load-notice';
  load.append(loadHeading, list, loadActions, loadNoticeRow);
  const loadNotices = createNotices(loadNoticeRow);

  screen.append(start, create, load);

  // Settings (D9): over the start screen, kept in this browser as the world page keeps them.
  const settingsStorage = localStorageOrNull();
  const settingsPanel = mountSettingsPanel(screen, {
    settings: loadSettings(settingsStorage),
    onSettings: (s) => saveSettings(settingsStorage, s),
    rdMax: null,
    defaultRd: null,
    onClose: () => {},
  });
  settingsButton.addEventListener('click', () => settingsPanel.open());

  /** The name a cleared field takes at Create: "New world N", N the smallest no saved world uses. */
  let proposal = newWorldName([]);
  let creating = false;
  /** The latest list read; an older one that settles later draws nothing. */
  let listRead = 0;
  /** A row's name is a text field (Rename): a visibility re-read waits, so the typed name stays. */
  let renaming = false;
  /** Set by a `versionchange` (D14): the connection closed itself, and the menu writes nothing more. */
  let reloadNeeded = false;

  const offEvent = o.saves?.kv.onEvent((e) => {
    if (e !== 'versionchange' || disposed) return;
    reloadNeeded = true;
    for (const n of [startNotices, newNotices, loadNotices]) n.show(RELOAD_NOTICE, { kind: 'error' });
  }) ?? null;

  /** True, with `RELOAD_NOTICE` in `notices`, when a `versionchange` stopped the menu's writes. */
  const writesStopped = (notices: Notices): boolean => {
    if (reloadNeeded) notices.show(RELOAD_NOTICE, { kind: 'error' });
    return reloadNeeded;
  };

  const show = (which: 'start' | 'new' | 'load'): void => {
    start.hidden = which !== 'start';
    create.hidden = which !== 'new';
    load.hidden = which !== 'load';
  };

  /** The world page's URL for `id`; under the enter bench it carries the bench's database (Spec correction 7). */
  const worldUrl = (id: string): string => {
    const bench = o.benchDb === null ? '' : `&enterBench=1&db=${encodeURIComponent(o.benchDb)}`;
    return `/?world=${encodeURIComponent(id)}${bench}`;
  };

  /** Reads `saves.list()` and draws its rows; without storage (D14) says so. */
  async function readList(): Promise<void> {
    if (o.saves === null) {
      list.replaceChildren();
      loadNotices.show(NO_STORAGE, { kind: 'error' });
      return;
    }
    const read = ++listRead;
    const t0 = performance.now();
    let rows: WorldRow[];
    try {
      rows = await o.saves.list();
    } catch (e) {
      if (!disposed && read === listRead) loadNotices.show(`The saved worlds could not be read (${errorName(e)})`, { kind: 'error' });
      return;
    }
    if (disposed || read !== listRead) return;
    renaming = false;
    list.replaceChildren(...(rows.length === 0 ? [el('li', 'world-empty', 'No saved worlds yet.')] : rows.map(rowElement)));
    recordListMs(performance.now() - t0);
  }

  /**
   * Runs `write` under the world's lock if it is free (D24); a held lock shows `LOCKED_NOTICE` and calls nothing, and a
   * write that does not complete shows why. The list is read again after it.
   */
  async function underLock(id: string, what: 'renamed' | 'deleted', write: () => Promise<WriteResult>): Promise<void> {
    if (writesStopped(loadNotices)) return;
    try {
      const r = await withWorldIfFree(o.locks, id, write);
      if (disposed) return;
      if (r.held) loadNotices.show(LOCKED_NOTICE, { kind: 'warn' });
      else if (r.value.status !== 'complete') loadNotices.show(`The world could not be ${what} (${writeFailure(r.value)})`, { kind: 'error' });
    } catch (e) {
      if (disposed) return;
      loadNotices.show(`The world could not be ${what} (${errorName(e)})`, { kind: 'error' });
    }
    await readList();
  }

  /** Delete (D3): asked in the notice row, then `saves.remove` under the lock (E7: every key of the world). */
  async function deleteWorld(saves: Saves, id: string, label: string): Promise<void> {
    if (!(await loadNotices.confirm(`Delete '${label}'? This cannot be undone.`, 'Delete')) || disposed) return;
    await underLock(id, 'deleted', () => saves.remove(id));
  }

  /** Rename (D3): the name becomes a text field; Enter keeps a changed, non-empty name, Esc cancels. */
  function startRename(saves: Saves, world: WorldRecord, nameEl: HTMLElement): void {
    if (renaming) return;
    renaming = true;
    const input = el('input', 'world-name-input');
    input.type = 'text';
    input.value = world.name;
    nameEl.hidden = true;
    nameEl.parentElement?.insertBefore(input, nameEl);
    input.focus();
    const cancel = (): void => {
      input.remove();
      nameEl.hidden = false;
      renaming = false;
    };
    input.addEventListener('keydown', (e) => {
      if (input.disabled) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const typed = input.value.trim();
        if (typed === '' || typed === world.name || writesStopped(loadNotices)) {
          cancel();
          return;
        }
        input.disabled = true;
        void underLock(world.id, 'renamed', () => saves.rename(world.id, typed));
      }
    });
  }

  /** Export (D15): the last committed save in one read, downloaded as `exportFileName(name)`; no lock (D7). */
  async function exportWorld(saves: Saves, id: string): Promise<void> {
    try {
      const dump = await saves.readAll(id);
      if (disposed) return;
      if (dump === null) {
        loadNotices.show('The world could not be exported (its records could not be read)', { kind: 'error' });
        return;
      }
      const blob = await writeWiworld(dump);
      if (disposed) return;
      downloadBlob(exportFileName(dump.world.name), blob);
    } catch (e) {
      if (!disposed) loadNotices.show(`The world could not be exported (${errorName(e)})`, { kind: 'error' });
    }
  }

  /** Import (D15): the picked file read under a new id and written in one write; a refusal writes nothing. */
  async function importWorld(saves: Saves, file: Blob): Promise<void> {
    if (writesStopped(loadNotices)) return;
    try {
      // Every saved name, which an empty imported name's proposal avoids (D2).
      const taken = await saves.list().then((rows) => rows.flatMap((w) => (w.broken ? [] : [w.world.name])), () => []);
      if (disposed) return;
      const r = await readWiworld(await readBinaryFile(file), STATE_BOUNDS, o.newId(), o.now(), taken);
      if (disposed) return;
      if (!r.ok) {
        loadNotices.show(r.reason, { kind: 'error' });
        return;
      }
      const w = await saves.writeAll(r.dump);
      if (disposed) return;
      if (w.status !== 'complete') {
        loadNotices.show(`The world could not be imported (${writeFailure(w)})`, { kind: 'error' });
        return;
      }
      loadNotices.show(`Imported '${r.dump.world.name}'`, { kind: 'info' });
      if (r.skippedColumns > 0) loadNotices.show(`${r.skippedColumns} columns of this world could not be read`, { kind: 'warn' });
      if (r.unknownStates > 0) loadNotices.show(`${r.unknownStates} blocks of unknown types became air`, { kind: 'warn' });
    } catch (e) {
      if (!disposed) loadNotices.show(`The file could not be read (${errorName(e)})`, { kind: 'error' });
      return;
    }
    await readList();
  }

  const rowButton = (cls: string, text: string, run: () => void): HTMLButtonElement => {
    const b = el('button', `start-button ${cls}`, text);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  };

  /**
   * One `.world-row[data-id]`: the world's lines and its buttons, with D8's badge when its stored genKey is not today's
   * (`olderGenerator` over `loadParams`' params, as the world page's open computes it); a broken record's reason, or
   * params `loadParams` refuses, with Delete only (D14).
   */
  function rowElement(row: WorldRow): HTMLLIElement {
    if (row.broken) return brokenRow(row.id, row.id, row.reason);
    const w = row.world;
    const params = loadParams(w);
    if (!params.ok) return brokenRow(w.id, w.name, invalidParamsReason(params.issues));
    const saves = o.saves!;
    const li = el('li', 'world-row');
    const actions = el('div', 'start-actions world-actions');
    li.dataset['id'] = w.id;
    const title = el('div', 'world-title');
    const nameEl = el('span', 'world-name', w.name);
    title.append(nameEl, ` · ${w.profile} · seed ${w.seedText}`);
    const info = el('div', 'world-info', `${modifiedText(row.updated || w.created)}${row.places > 0 ? ` · ${row.places} places` : ''}`);
    li.append(title, info);
    if (w.backupOf !== null) li.append(el('div', 'world-badge', 'automatic copy'));
    if (olderGenerator(w, params.value)) li.append(el('div', 'world-badge', 'older generator'), el('div', 'world-info', OLDER_GENERATOR_LINE));
    actions.append(
      rowButton('world-play', 'Play', () => o.navigate(worldUrl(w.id))),
      rowButton('world-rename', 'Rename', () => startRename(saves, w, nameEl)),
      rowButton('world-export', 'Export', () => void exportWorld(saves, w.id)),
      rowButton('world-delete', 'Delete', () => void deleteWorld(saves, w.id, w.name)),
    );
    li.append(actions);
    return li;
  }

  /** A broken row (D14): "This world could not be opened: <reason>" and Delete only, asked as `label`. */
  function brokenRow(id: string, label: string, reason: string): HTMLLIElement {
    const saves = o.saves!;
    const li = el('li', 'world-row');
    li.dataset['id'] = id;
    const actions = el('div', 'start-actions world-actions');
    actions.append(rowButton('world-delete', 'Delete', () => void deleteWorld(saves, id, label)));
    li.append(el('div', 'world-broken', refusalText({ notice: 'unreadable', reason })), actions);
    return li;
  }

  loadButton.addEventListener('click', () => {
    loadNotices.clear();
    writesStopped(loadNotices);
    list.replaceChildren();
    renaming = false;
    show('load');
    void readList();
  });

  loadBack.addEventListener('click', () => {
    show('start');
  });

  importButton.addEventListener('click', () => {
    if (o.saves === null) {
      loadNotices.show(NO_STORAGE, { kind: 'error' });
      return;
    }
    if (writesStopped(loadNotices)) return;
    importFile.click();
  });

  // The input is cleared after the pick, so that choosing the same file again fires `change`.
  importFile.addEventListener('change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (file === undefined || o.saves === null) return;
    loadNotices.clear();
    void importWorld(o.saves, file);
  });

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible' && !load.hidden && !renaming) void readList();
  };
  document.addEventListener('visibilitychange', onVisibility);

  newButton.addEventListener('click', () => {
    newNotices.clear();
    writesStopped(newNotices);
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
    const seedText = resolveSeedText(seed.value, o.random);
    const profile = preset.value as ProfileId;
    if (o.saves === null) {
      // No storage (§3.8, D14): the unsaved world in place, with the seed and the preset as its hash.
      creating = true;
      o.enterUnsaved(`#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: seedText.text, profile })}`, UNSAVED_NO_STORAGE_NOTICE);
      return;
    }
    if (writesStopped(newNotices)) return;
    const saves = o.saves;
    creating = true;
    createButton.disabled = true;
    const typed = Array.from(name.value.trim()).slice(0, MAX_NAME).join('');
    const id = o.newId();
    const world = createdRecord(id, typed === '' ? proposal : typed, seedText, profile, o.now());
    void (async () => {
      const w = await saves.create(world, newState(id, STATE_BOUNDS));
      if (disposed) return;
      if (w.status !== 'complete') {
        creating = false;
        createButton.disabled = false;
        newNotices.show(`The world could not be created (${writeFailure(w)})`, { kind: 'error' });
        return;
      }
      await askPersistOnce(o.persistStorage);
      if (disposed) return;
      o.navigate(worldUrl(id));
    })();
  });

  return {
    dispose() {
      disposed = true;
      offEvent?.();
      document.removeEventListener('visibilitychange', onVisibility);
      startNotices.dispose();
      newNotices.dispose();
      loadNotices.dispose();
      settingsPanel.dispose();
      backdrop.dispose();
      screen.remove();
    },
  };
}

/**
 * `navigator.storage.persist()` at the first Create only (D2): skipped when `PERSIST_ASKED_KEY` is set, which is set
 * before asking (without `localStorage` every Create asks); awaited, since Firefox's prompt belongs to this page, for at
 * most `PERSIST_WAIT_MS` (a prompt dismissed by clicking away can stay unanswered; navigating cancels it), and its
 * answer and any failure ignored.
 */
async function askPersistOnce(persist: () => Promise<boolean>): Promise<void> {
  const storage = localStorageOrNull();
  try {
    if (storage?.getItem(PERSIST_ASKED_KEY) === '1') return;
    storage?.setItem(PERSIST_ASKED_KEY, '1');
  } catch { /* asked at every Create instead */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([persist(), new Promise<void>((resolve) => { timer = setTimeout(resolve, PERSIST_WAIT_MS); })]);
  } catch { /* either answer works (D2) */ } finally {
    clearTimeout(timer);
  }
}

import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { colKey } from '../../src/core/coords';
import { hex64, type Seed64 } from '../../src/core/hash';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import { seedFromInput, seedToText } from '../../src/core/seed';
import { encodeColumnDiff } from '../../src/persist/diffCodec';
import type { KV, KvEvent } from '../../src/persist/kv';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import {
  createSaves, exportFileName, loadParams, newState, olderGenerator, parseWorldRecord, todayStateTable, type HistoryRecord, type WorldRecord,
} from '../../src/persist/saves';
import { readWiworld, wiworldHash, writeWiworld } from '../../src/persist/wiworld';
import { decodeMapState, DEFAULT_MAP_STATE, encodeMapState } from '../../src/ui/map/mapState';
import { SETTINGS_DEFAULTS, SETTINGS_KEY } from '../../src/ui/settings';
import { profileOptions } from '../../src/ui/map/toolbar';
import { parseWorldQuery } from '../../src/ui/world/query';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { holdWorld, type LockManagerLike } from '../../src/ui/world/worldLock';
import { olderGeneratorRecord, openRequest, SAVES_DB } from '../../src/ui/world/worldPage';
import { createSimClient } from '../../src/engine/simClient';
import { createSimHandler } from '../../src/workers/simHandler';
import { inProcessSimWorker } from '../harness/inProcessSim';
import {
  mountWorldsMenu, noticeOfQuery, PERSIST_ASKED_KEY, REFUSAL_REASON_KEY, refusalText, refusalUrl, savesDbOf, startModeOf,
  type StorageLike, type WorldsMenuOptions,
} from '../../src/ui/worldsMenu';
import { REGISTRY } from '../../src/world/blocks';
import type { ColumnDiff } from '../../src/world/store/api';
import { installDom, FakeElement } from './fixtures/domShim';

const S = (key: string): number => REGISTRY.parseStateKey(key);
/** One entry of state `state` at sy 0, idx 0. */
const oneVoxel = (state: number): ColumnDiff => ({ sy: Uint8Array.of(0), idx: Uint16Array.of(0), value: Uint32Array.of(state << 8) });

const query = (url: string) => new URL(url, 'http://localhost/').searchParams;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A `Storage` over a Map (`localStorage`, `sessionStorage`). */
function fakeStorage(): StorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

describe('startModeOf (SP5b spec §1.1; moved from startScreen.ts)', () => {
  test('a bare / and a # hash alone give the start screen', () => {
    expect(startModeOf(query('/'))).toBe('start');
    expect(startModeOf(new URLSearchParams(''))).toBe('start');
    expect(startModeOf(query(`/#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: '7' })}`))).toBe('start');
  });

  test('?at, ?rd or ?workers goes straight to the world', () => {
    expect(startModeOf(query('/?at=1,2'))).toBe('world');
    expect(startModeOf(query('/?rd=8'))).toBe('world');
    expect(startModeOf(query('/?workers=4'))).toBe('world');
    expect(startModeOf(query('/?renderer=mesh&rd=8'))).toBe('world');
  });

  test('?world=abc → \'world\' (a saved world, SP5b spec §3.4)', () => {
    expect(startModeOf(query('/?world=abc'))).toBe('world');
  });

  test('?renderer=mesh alone keeps the start screen, as do the enter bench\'s menu keys and a refusal\'s notice', () => {
    expect(startModeOf(query('/?renderer=mesh'))).toBe('start');
    expect(startModeOf(query('/?enterBench=1&db=wi10-bench'))).toBe('start');
    expect(startModeOf(query('/?notice=locked'))).toBe('start');
  });
});

describe('the world page\'s refusals carried to the menu (SP5b spec §3.4 steps 1-2, D7, D14)', () => {
  test('`locked` → `/?notice=locked` and D7\'s text; `unreadable` → `/?notice=unreadable`, its reason through sessionStorage, read once', () => {
    const storage = fakeStorage();
    expect(refusalUrl({ notice: 'locked' }, storage)).toBe('/?notice=locked');
    expect(storage.map.size).toBe(0);
    expect(noticeOfQuery(query('/?notice=locked'), storage)).toBe('This world is open in another tab');
    expect(refusalUrl({ notice: 'unreadable', reason: 'no saved world has this id' }, storage)).toBe('/?notice=unreadable');
    expect(storage.map.get(REFUSAL_REASON_KEY)).toBe('no saved world has this id');
    expect(noticeOfQuery(query('/?notice=unreadable'), storage)).toBe('This world could not be opened: no saved world has this id');
    expect(storage.map.has(REFUSAL_REASON_KEY)).toBe(false);
    // A reload of the menu's URL no longer has the reason.
    expect(noticeOfQuery(query('/?notice=unreadable'), storage)).toBe('This world could not be opened: the reason was not kept');
    expect(noticeOfQuery(query('/?notice=unreadable'), null)).toBe('This world could not be opened: the reason was not kept');
    expect(noticeOfQuery(query('/?notice=other'), storage)).toBeNull();
    expect(noticeOfQuery(query('/'), storage)).toBeNull();
    expect(refusalText({ notice: 'unreadable', reason: 'x' })).toBe('This world could not be opened: x');
  });

  test('a storage that throws never makes them throw', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    expect(refusalUrl({ notice: 'unreadable', reason: 'r' }, throwing)).toBe('/?notice=unreadable');
    expect(noticeOfQuery(query('/?notice=unreadable'), throwing)).toBe('This world could not be opened: the reason was not kept');
  });
});

describe('the menu\'s database (SP5b spec §6.2; Spec correction 7)', () => {
  test('`wi10` (the world page\'s `SAVES_DB`), or `?db=` only with `enterBench=1`', () => {
    expect(savesDbOf(parseWorldQuery(query('/')))).toBe(SAVES_DB);
    expect(savesDbOf(parseWorldQuery(query('/?enterBench=1&db=x')))).toBe('x');
    expect(savesDbOf(parseWorldQuery(query('/?db=x')))).toBe('wi10');
  });
});

describe('mountWorldsMenu: the start screen and New world (SP5b spec §1.1, §1.2, D1, D2)', () => {
  let dom: ReturnType<typeof installDom>;
  let local: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    dom = installDom();
    local = fakeStorage();
    vi.stubGlobal('localStorage', local);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Seeds 1, 2, 3, … from `random`. */
  function seeds(): () => Seed64 {
    let n = 0;
    return () => [++n, 0];
  }

  function mount(over: Partial<WorldsMenuOptions> = {}, kv: MemoryKV = createMemoryKV()) {
    const navigate = vi.fn<(url: string) => void>();
    const persistStorage = vi.fn(() => Promise.resolve(true));
    const enterUnsaved = vi.fn<(hash: string, notice: string) => void>();
    const loadManifest = vi.fn(() => Promise.resolve<unknown>([]));
    let ids = 0;
    const o: WorldsMenuOptions = {
      saves: createSaves(kv),
      locks: { request: () => Promise.reject(new Error('no lock in this test')) },
      random: seeds(),
      newId: () => `w${++ids}`,
      now: () => 1_700_000_000_000,
      navigate,
      persistStorage,
      enterUnsaved,
      loadManifest,
      rand: () => 0,
      notice: null,
      benchDb: null,
      ...over,
    };
    const menu = mountWorldsMenu(dom.body as unknown as HTMLElement, o);
    return { menu, kv, navigate, persistStorage, enterUnsaved, loadManifest };
  }

  /** Whether `#id` and every ancestor are not hidden. */
  const shown = (id: string) => {
    for (let e: FakeElement | null = dom.el(id); e !== null; e = e.parentElement) if (e.hidden) return false;
    return true;
  };

  /** Clicks New world and lets the saved names' read settle. */
  async function openNew(): Promise<void> {
    dom.el('start-new').click();
    await flush();
  }

  /** Clicks Create and waits for its navigation. */
  async function create(navigate: ReturnType<typeof vi.fn>): Promise<void> {
    const before = navigate.mock.calls.length;
    dom.el('new-create').click();
    await vi.waitFor(() => expect(navigate.mock.calls.length).toBe(before + 1));
  }

  const worlds = (kv: MemoryKV) => kv.dump('worlds').map(([, v]) => v as WorldRecord);

  test('the start screen shows the three buttons and the two links, and ignores a `#` hash', async () => {
    const { loadManifest } = mount();
    expect(dom.el('start-title').textContent).toBe('world-imaginer-voxel');
    expect(['start-new', 'start-load', 'start-settings'].map((id) => dom.el(id).textContent)).toEqual(['New world', 'Load world', 'Settings']);
    expect(['start-new', 'start-load', 'start-settings'].map((id) => dom.el(id).tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect([dom.el('start-map').textContent, dom.el('start-map').href]).toEqual(['Map', '?map']);
    expect([dom.el('start-selftest').textContent, dom.el('start-selftest').href]).toEqual(['Selftest', '?selftest=1']);
    expect(shown('start-new')).toBe(true);
    expect(shown('new-create')).toBe(false);
    expect(dom.el('start-notice').textContent).toBe('');
    // SP4a's seed and profile lines and "Enter the world" are gone; a hash names no world (the menu is given none).
    for (const gone of ['start-enter', 'start-seed', 'start-profile', 'start-error']) expect(dom.body.querySelector(`#${gone}`)).toBeNull();
    expect(startModeOf(query(`/#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: '7' })}`))).toBe('start');
    // The loading screen's background.
    expect(dom.el('start-screen-backdrop').style.background).toContain('#3D78D6');
    await flush();
    expect(loadManifest).toHaveBeenCalledTimes(1);
  });

  test('`#start-settings` opens the panel over the start screen (SP5b spec §1.4, D9; ruling P23)', async () => {
    // The settings this browser keeps (`wi.world.settings`), read at mount as the world page reads them.
    local.setItem(SETTINGS_KEY, JSON.stringify({ ...SETTINGS_DEFAULTS, fov: 85, mapMode: 'split' }));
    mount();
    const panel = dom.el('settings-panel');
    expect(panel.hidden).toBe(true);
    dom.el('start-settings').click();
    expect(panel.hidden).toBe(false);
    // Over the start screen: inside it, after its cards, the start card still there beneath.
    const screen = dom.el('start-screen');
    expect(panel.parentElement).toBe(screen);
    expect(screen.children.at(-1)).toBe(panel);
    expect(shown('start-new')).toBe(true);
    // No capability probe runs here: "Default" with no number, then 4 … 16.
    const rd = dom.el('setting-rd');
    expect(rd.options.map((op) => op.textContent)).toEqual(['Default', ...Array.from({ length: 13 }, (_, i) => String(4 + i))]);
    expect(dom.el('setting-fov').value).toBe('85');
    // A change is kept at once, the map's mode with it.
    rd.value = '10';
    rd.dispatchEvent(new Event('change'));
    expect(JSON.parse(local.map.get(SETTINGS_KEY)!)).toEqual({ ...SETTINGS_DEFAULTS, fov: 85, mapMode: 'split', rd: 10 });
    dom.el('settings-tab-controls').click();
    const hold = dom.el('setting-hold-repeat') as FakeElement & { checked: boolean };
    hold.checked = true;
    hold.dispatchEvent(new Event('change'));
    expect(JSON.parse(local.map.get(SETTINGS_KEY)!)).toMatchObject({ rd: 10, holdRepeat: true });
    // Esc closes it, and the start screen is as it was.
    const esc = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape', key: 'Escape' });
    dom.document.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(shown('start-new')).toBe(true);
    await flush();
  });

  test('a refusal\'s notice appears in `#start-notice`', async () => {
    mount({ notice: 'This world is open in another tab' });
    expect(dom.el('start-notice').textContent).toContain('This world is open in another tab');
    await flush();
  });

  test('New world proposes `New world 2` when `New world 1` exists; a cleared name takes it at Create', async () => {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    const first: WorldRecord = {
      id: 'old', name: 'New world 1', seedText: '1', seed: [1, 0], profile: 'default', params: {}, schemaVersion: 2, paramsHash: '0'.repeat(16),
      generatorVersion: 5, genKey: '0'.repeat(16), stateTable: todayStateTable(), created: 1, backupOf: null,
    };
    expect((await saves.create(first, newState('old', STATE_BOUNDS))).status).toBe('complete');
    const { navigate } = mount({}, kv);
    await openNew();
    expect(shown('new-create')).toBe(true);
    expect(shown('start-new')).toBe(false);
    expect(dom.el('new-name').value).toBe('New world 2');
    dom.el('new-name').value = '   ';
    await create(navigate);
    expect(worlds(kv).find((w) => w.id === 'w1')?.name).toBe('New world 2');
  });

  test('the preset select lists the five ready profiles in code order', () => {
    mount();
    const opts = dom.el('new-preset').options.map((o) => o.value);
    expect(opts).toEqual(['default', 'large_biomes', 'archipelago', 'amplified', 'floating_islands']);
    expect(opts).toEqual(profileOptions());
  });

  test('the dice changes the seed text; a typed seed `hello` resolves as `seedFromInput`', async () => {
    const { kv, navigate } = mount();
    await openNew();
    expect(dom.el('new-seed').value).toBe(seedToText([1, 0]));
    dom.el('new-dice').click();
    expect(dom.el('new-seed').value).toBe(seedToText([2, 0]));
    dom.el('new-seed').value = 'hello';
    await create(navigate);
    const [w] = worlds(kv);
    expect([w!.seedText, w!.seed]).toEqual(['hello', seedFromInput('hello')]);
  });

  test('Create writes `worlds` and `state` in one write and navigates to `/?world=<id>`; `persistStorage` is called at the first create only', async () => {
    const { kv, navigate, persistStorage } = mount();
    await openNew();
    dom.el('new-name').value = 'My world';
    dom.el('new-preset').value = 'amplified';
    dom.el('new-seed').value = '1234';
    const write = vi.spyOn(kv, 'write');
    await create(navigate);
    // One write of the two records.
    expect(write.mock.calls.map(([batch]) => batch.map((op) => `${op.op} ${op.store}`))).toEqual([['put worlds', 'put state']]);
    expect(navigate).toHaveBeenLastCalledWith('/?world=w1');
    const [w] = worlds(kv);
    // The record as the world page opens it: the preset's resolved parameters, today's generator, genKey and table.
    expect(w).toMatchObject({ id: 'w1', name: 'My world', seedText: '1234', seed: seedFromInput('1234'), profile: 'amplified', generatorVersion: 5, created: 1_700_000_000_000, backupOf: null });
    expect(w!.stateTable).toEqual(todayStateTable());
    expect(w!.paramsHash).toMatch(/^[0-9a-f]{16}$/);
    const p = loadParams(w!);
    expect(p.ok).toBe(true);
    if (p.ok) expect(olderGenerator(w!, p.value)).toBe(false);
    expect(kv.dump('state')).toEqual([['w1', newState('w1', STATE_BOUNDS)]]);
    expect(kv.dump('history')).toEqual([]);
    expect(persistStorage).toHaveBeenCalledTimes(1);
    expect(local.map.get(PERSIST_ASKED_KEY)).toBe('1');
    // A second Create (another menu, the same browser) does not ask again.
    dom.body.replaceChildren();
    const second = mount({ newId: () => 'w2' }, kv);
    await openNew();
    await create(second.navigate);
    expect(second.navigate).toHaveBeenLastCalledWith('/?world=w2');
    expect(second.persistStorage).not.toHaveBeenCalled();
  });

  test('Create waits for the persist request before it navigates, and a double click creates one world', async () => {
    let answer: (v: boolean) => void = () => {};
    const persistStorage = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
    const { kv, navigate } = mount({ persistStorage });
    await openNew();
    dom.el('new-create').click();
    dom.el('new-create').click();
    await vi.waitFor(() => expect(persistStorage).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
    answer(false);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(worlds(kv).length).toBe(1);
  });

  test('a Create whose write does not complete shows why, navigates nowhere and can be retried', async () => {
    const { kv, navigate } = mount();
    await openNew();
    kv.failAt(0, 'QuotaExceededError');
    dom.el('new-create').click();
    await vi.waitFor(() => expect(dom.el('new-notice').textContent).toContain('The world could not be created (abort: QuotaExceededError)'));
    expect(navigate).not.toHaveBeenCalled();
    expect(dom.el('new-create').disabled).toBe(false);
    await create(navigate);
    expect(worlds(kv).length).toBe(1);
  });

  test('a 70-character name is cut to 64', async () => {
    const { kv, navigate } = mount();
    await openNew();
    dom.el('new-name').value = 'x'.repeat(70);
    await create(navigate);
    expect(worlds(kv)[0]!.name).toBe('x'.repeat(64));
  });

  test('Back returns to the start', async () => {
    mount();
    await openNew();
    expect(shown('new-back')).toBe(true);
    dom.el('new-back').click();
    expect(shown('start-new')).toBe(true);
    expect(shown('new-create')).toBe(false);
  });

  test('Create under `?enterBench=1&db=x` writes to x and navigates to `/?world=<id>&enterBench=1&db=x`; `db` without `enterBench=1` is ignored', async () => {
    // main.ts opens `savesDbOf(q)` and passes `q.db` as `benchDb`.
    const bench = parseWorldQuery(query('/?enterBench=1&db=x'));
    expect([savesDbOf(bench), bench.db]).toEqual(['x', 'x']);
    const dbs = new Map<string, MemoryKV>([['x', createMemoryKV()], ['wi10', createMemoryKV()]]);
    const a = mount({ saves: createSaves(dbs.get(savesDbOf(bench))!), benchDb: bench.db });
    await openNew();
    await create(a.navigate);
    expect(a.navigate).toHaveBeenLastCalledWith('/?world=w1&enterBench=1&db=x');
    expect([worlds(dbs.get('x')!).length, worlds(dbs.get('wi10')!).length]).toEqual([1, 0]);
    dom.body.replaceChildren();
    const plain = parseWorldQuery(query('/?db=x'));
    const b = mount({ saves: createSaves(dbs.get(savesDbOf(plain))!), benchDb: plain.db });
    await openNew();
    await create(b.navigate);
    expect(b.navigate).toHaveBeenLastCalledWith('/?world=w1');
    expect([worlds(dbs.get('x')!).length, worlds(dbs.get('wi10')!).length]).toEqual([1, 1]);
  });

  test('with `saves` null, Load world says `Saving is not available in this browser window`, and New world calls `enterUnsaved` with the hash and `This world is not saved: this browser window cannot store data.` (SP5b spec §1.1, §3.8, D14)', async () => {
    const { navigate, persistStorage, enterUnsaved } = mount({ saves: null });
    dom.el('start-load').click();
    await flush();
    expect(dom.el('load-notice').textContent).toContain('Saving is not available in this browser window');
    dom.el('load-back').click();
    await openNew();
    expect(shown('new-create')).toBe(true);
    dom.el('new-preset').value = 'amplified';
    dom.el('new-seed').value = '1234';
    dom.el('new-create').click();
    dom.el('new-create').click();
    await flush();
    // The unsaved world in place: the seed and preset as its `#` hash in `?map`'s encoding (no `?rd`), once.
    const hash = `#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: '1234', profile: 'amplified' })}`;
    expect(enterUnsaved.mock.calls).toEqual([[hash, 'This world is not saved: this browser window cannot store data.']]);
    expect(decodeMapState(hash)).toEqual({ state: { ...DEFAULT_MAP_STATE, seed: '1234', profile: 'amplified' }, error: null });
    expect(navigate).not.toHaveBeenCalled();
    expect(persistStorage).not.toHaveBeenCalled();
    expect(dom.el('new-notice').textContent).toBe('');
  });

  test('a `versionchange` on the menu\'s connection shows `Reload to continue`, and the menu then writes nothing (D14)', async () => {
    const kv = createMemoryKV();
    const listeners: Array<(e: KvEvent) => void> = [];
    const watched: KV = {
      read: (r) => kv.read(r),
      write: (ops) => kv.write(ops),
      onEvent: (f) => { listeners.push(f); return () => { listeners.splice(listeners.indexOf(f), 1); }; },
      close: () => kv.close(),
    };
    const { navigate, menu } = mount({ saves: createSaves(watched) });
    expect(listeners).toHaveLength(1);
    for (const f of [...listeners]) f('versionchange');
    expect(dom.el('start-notice').textContent).toContain('Reload to continue');
    await openNew();
    expect(dom.el('new-notice').textContent).toContain('Reload to continue');
    const write = vi.spyOn(kv, 'write');
    dom.el('new-create').click();
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(kv.dump('worlds')).toEqual([]);
    menu.dispose();
    expect(listeners).toHaveLength(0);
  });

  test('dispose removes the screen', async () => {
    const { menu } = mount();
    menu.dispose();
    expect(dom.body.querySelector('#start-screen')).toBeNull();
    await flush();
  });
});

describe('mountWorldsMenu: Load world (SP5b spec §1.1, §1.3, D3, D7, D14, D24)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal('__wiMenuListMs', undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** Node's own Web Locks (24.21), as the browser's; each test's world ids are fresh, so no other test holds them. */
  const NODE_LOCKS = navigator.locks as unknown as LockManagerLike;

  function mount(kv: MemoryKV, over: Partial<WorldsMenuOptions> = {}) {
    const navigate = vi.fn<(url: string) => void>();
    const saves = createSaves(kv);
    const o: WorldsMenuOptions = {
      saves,
      locks: NODE_LOCKS,
      random: () => [1, 0],
      newId: () => crypto.randomUUID(),
      now: () => 1_700_000_000_000,
      navigate,
      persistStorage: () => Promise.resolve(true),
      enterUnsaved: () => {},
      loadManifest: () => Promise.resolve<unknown>([]),
      rand: () => 0,
      notice: null,
      benchDb: null,
      ...over,
    };
    const menu = mountWorldsMenu(dom.body as unknown as HTMLElement, o);
    return { menu, saves, navigate };
  }

  /** Every descendant of `root` carrying the class `cls`, depth-first (the shim's `querySelector` knows ids and tags only). */
  function byClass(root: FakeElement, cls: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  }

  const rows = () => byClass(dom.el('load-list'), 'world-row');
  const row = (id: string): FakeElement => {
    const r = rows().find((e) => e.dataset['id'] === id);
    if (r === undefined) throw new Error(`no row for ${id}`);
    return r;
  };
  const one = (root: FakeElement, cls: string): FakeElement => {
    const [e] = byClass(root, cls);
    if (e === undefined) throw new Error(`no .${cls}`);
    return e;
  };
  /** The row's buttons by class, in order. */
  const buttons = (r: FakeElement) => r.querySelectorAll('button').map((b) => b.className.split(' ').find((c) => c.startsWith('world-')));

  /** "Modified YYYY-MM-DD HH:MM" in local time, through an independent formatter (Swedish dates are ISO-shaped). */
  const modified = (ms: number) => `Modified ${new Date(ms).toLocaleString('sv-SE').slice(0, 16)}`;

  const key = (code: string) => Object.assign(new Event('keydown', { cancelable: true }), { key: code, code });

  /** Today's genKey of a `saved` world's seed and its profile's params (`saved`'s default: no "older generator" badge). */
  function todayKey(profile: WorldRecord['profile']): string {
    const p = loadParams({ params: {}, schemaVersion: 2, profile });
    if (!p.ok) throw new Error(`${profile} does not load`);
    return hex64(genKey([7, 0], stageHashes(p.value)));
  }

  /** A saved world with a state `updated` at `updated` (0: never saved) and `places` places; its genKey today's unless given. */
  async function saved(
    kv: MemoryKV, name: string,
    o: { updated?: number; places?: number; backupOf?: string | null; created?: number; profile?: WorldRecord['profile']; seedText?: string; genKey?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    const profile = o.profile ?? 'default';
    const world: WorldRecord = {
      id, name, seedText: o.seedText ?? '7', seed: [7, 0], profile, params: {}, schemaVersion: 2,
      paramsHash: '0'.repeat(16), generatorVersion: 5, genKey: o.genKey ?? todayKey(profile), stateTable: todayStateTable(), created: o.created ?? 1_600_000_000_000,
      backupOf: o.backupOf ?? null,
    };
    const places = Array.from({ length: o.places ?? 0 }, (_, i) => ({ id: `p${i}`, name: `Place ${i}`, colour: 0, x: i, y: 70, z: 0, yaw: 0, pitch: 0 }));
    const state = { ...newState(id, STATE_BOUNDS), updated: o.updated ?? 0, places };
    expect((await createSaves(kv).create(world, state)).status).toBe('complete');
    return id;
  }

  /** Clicks Load world and waits for the list's first read. */
  async function openLoad(): Promise<void> {
    dom.el('start-load').click();
    await vi.waitFor(() => expect(globalThis.__wiMenuListMs).toBeTypeOf('number'));
  }

  const names = (kv: MemoryKV) => kv.dump('worlds').map(([, v]) => (v as WorldRecord).name);

  test('rows newest first, each with its text; a backup row says `automatic copy`; a world with 3 places `· 3 places`; Play opens `/?world=<id>`', async () => {
    const kv = createMemoryKV();
    const alpha = await saved(kv, 'Alpha', { updated: 1_700_000_000_000, seedText: '11' });
    const beta = await saved(kv, 'Beta', { updated: 1_700_000_900_000, places: 3, profile: 'amplified', seedText: 'hello' });
    const copy = await saved(kv, 'Alpha (before the change 1)', { updated: 1_700_000_500_000, backupOf: alpha, seedText: '11' });
    const { navigate } = mount(kv);
    expect(shown(dom, 'load-list')).toBe(false);
    await openLoad();
    expect(shown(dom, 'load-list')).toBe(true);
    expect(shown(dom, 'start-new')).toBe(false);
    expect(rows().map((r) => r.dataset['id'])).toEqual([beta, copy, alpha]);
    const b = row(beta).textContent;
    expect(b).toContain('Beta · amplified · seed hello');
    expect(b).toContain(`${modified(1_700_000_900_000)} · 3 places`);
    expect(b).not.toContain('automatic copy');
    expect(row(copy).textContent).toContain('Alpha (before the change 1) · default · seed 11');
    expect(row(copy).textContent).toContain('automatic copy');
    const a = row(alpha).textContent;
    expect(a).toContain(modified(1_700_000_000_000));
    for (const absent of ['places', 'automatic copy', 'older generator']) expect(a).not.toContain(absent);
    for (const r of rows()) expect(buttons(r)).toEqual(['world-play', 'world-rename', 'world-export', 'world-delete']);
    expect([dom.el('load-import').tagName, dom.el('load-back').tagName]).toEqual(['BUTTON', 'BUTTON']);
    // The list's time for the smoke's `menus` step.
    expect(Number.isFinite(globalThis.__wiMenuListMs) && globalThis.__wiMenuListMs! >= 0).toBe(true);
    one(row(beta), 'world-play').click();
    expect(navigate).toHaveBeenLastCalledWith(`/?world=${beta}`);
    dom.el('load-back').click();
    expect(shown(dom, 'start-new')).toBe(true);
    expect(shown(dom, 'load-list')).toBe(false);
  });

  test('a never-saved world\'s row shows its `created` time (P24)', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Fresh', { updated: 0, created: 1_650_000_000_000 });
    mount(kv);
    await openLoad();
    expect(row(id).textContent).toContain(modified(1_650_000_000_000));
  });

  test('the empty list says `No saved worlds yet.`', async () => {
    mount(createMemoryKV());
    await openLoad();
    expect(rows()).toEqual([]);
    expect(dom.el('load-list').textContent).toBe('No saved worlds yet.');
  });

  test('a `worlds` record `parseWorldRecord` refuses shows its reason with Delete only, and Delete removes it (D14, P24)', async () => {
    const kv = createMemoryKV();
    const raw = { id: 'bad', seedText: '1' };
    const p = parseWorldRecord(raw);
    expect(p.ok).toBe(false);
    expect((await kv.write([{ op: 'put', store: 'worlds', key: 'bad', value: raw }])).status).toBe('complete');
    const fine = await saved(kv, 'Fine', { updated: 5 });
    mount(kv);
    await openLoad();
    expect(rows().map((r) => r.dataset['id'])).toEqual([fine, 'bad']);
    expect(row('bad').textContent).toContain(`This world could not be opened: ${p.ok ? '' : p.reason}`);
    expect(buttons(row('bad'))).toEqual(['world-delete']);
    one(row('bad'), 'world-delete').click();
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Delete \'bad\'? This cannot be undone.'));
    one(dom.el('load-notice'), 'notice-confirm').click();
    await vi.waitFor(() => expect(rows().map((r) => r.dataset['id'])).toEqual([fine]));
    expect(kv.dump('worlds').map(([k]) => k)).toEqual([fine]);
  });

  const OLDER = 'older generator';
  const OLDER_LINE = 'opens with today\'s terrain; your blocks stay at their coordinates';

  test('the badge shows on that world until its open\'s `record` is written, then not (D8)', async () => {
    const kv = createMemoryKV();
    const stale = await saved(kv, 'Old', { updated: 5, genKey: 'f'.repeat(16) });
    const fresh = await saved(kv, 'New', { updated: 6 });
    mount(kv);
    await openLoad();
    expect(row(stale).textContent).toContain(OLDER);
    expect(row(stale).textContent).toContain(OLDER_LINE);
    expect(row(fresh).textContent).not.toContain(OLDER);
    expect(buttons(row(stale))).toEqual(['world-play', 'world-rename', 'world-export', 'world-delete']);
    // The world's open: today's genKey sent as its `record` (§3.4 step 4), which the next flush writes.
    const read = await createSaves(kv).readOpen(stale);
    const parsed = parseWorldRecord(read.world);
    if (!parsed.ok) throw new Error(parsed.reason);
    const sim = createSimClient(() => inProcessSimWorker(createSimHandler({ openKV: async () => kv }), () => 0), { onFailure() {} });
    const state = newState(stale, STATE_BOUNDS);
    expect((await sim.load(openRequest(SAVES_DB, parsed.world, state, { worldId: stale, done: [], undone: [] }).load)).type).toBe('loaded');
    const sent = olderGeneratorRecord(parsed.world, todayKey('default'));
    expect(sent).not.toBeNull();
    sim.record(sent!);
    // Before the flush the stored genKey is still the old one: a re-read still shows the badge.
    dom.document.visibilityState = 'visible';
    dom.document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(row(stale).textContent).toContain(OLDER);
    expect(await sim.flush({ ...state, updated: 7 }, null)).toMatchObject({ ok: true });
    sim.dispose();
    dom.document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(row(stale).textContent).not.toContain(OLDER));
    expect(row(stale).textContent).not.toContain(OLDER_LINE);
  });

  test('an imported older-generator file\'s row shows `older generator`', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha', { updated: 5 });
    const source = (await createSaves(kv).readAll(id))!;
    const file = await writeWiworld({ ...source, world: { ...source.world, genKey: 'f'.repeat(16) } });
    mount(kv);
    await openLoad();
    expect(row(id).textContent).not.toContain(OLDER);
    pick(new File([file], 'old.wiworld'));
    await vi.waitFor(() => expect(rows().length).toBe(2));
    const added = rows().map((r) => r.dataset['id']!).find((r) => r !== id)!;
    expect(row(added).textContent).toContain(OLDER);
    expect(row(added).textContent).toContain(OLDER_LINE);
    expect(row(id).textContent).not.toContain(OLDER);
  });

  test('a record whose `loadParams` is refused shows a broken row: its reason, Delete only', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Fine', { updated: 5 });
    const raw = { ...(await createSaves(kv).readAll(id))!.world, id: 'bad', schemaVersion: 99 };
    expect(parseWorldRecord(raw).ok).toBe(true);
    expect(loadParams(raw).ok).toBe(false);
    expect((await kv.write([{ op: 'put', store: 'worlds', key: 'bad', value: raw }, { op: 'put', store: 'state', key: 'bad', value: { ...newState('bad', STATE_BOUNDS), updated: 1 } }])).status).toBe('complete');
    mount(kv);
    await openLoad();
    expect(rows().map((r) => r.dataset['id'])).toEqual([id, 'bad']);
    expect(row('bad').textContent).toContain('This world could not be opened: invalid params (<root> MIGRATION_FAILED)');
    expect(row('bad').textContent).not.toContain(OLDER);
    expect(buttons(row('bad'))).toEqual(['world-delete']);
  });

  test('Rename: Enter keeps (the record renamed), Esc cancels (nothing written)', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha', { updated: 5 });
    mount(kv);
    await openLoad();
    one(row(id), 'world-rename').click();
    const field = one(row(id), 'world-name-input');
    expect([field.tagName, field.value]).toEqual(['INPUT', 'Alpha']);
    expect(dom.document.activeElement).toBe(field);
    field.value = '  Gamma ';
    field.dispatchEvent(key('Enter'));
    await vi.waitFor(() => expect(names(kv)).toEqual(['Gamma']));
    await vi.waitFor(() => expect(byClass(row(id), 'world-name-input')).toEqual([]));
    expect(row(id).textContent).toContain('Gamma · default · seed 7');
    const write = vi.spyOn(kv, 'write');
    one(row(id), 'world-rename').click();
    const again = one(row(id), 'world-name-input');
    again.value = 'Delta';
    again.dispatchEvent(key('Escape'));
    expect(byClass(row(id), 'world-name-input')).toEqual([]);
    expect(row(id).textContent).toContain('Gamma · default · seed 7');
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(names(kv)).toEqual(['Gamma']);
  });

  test('Review Focus 2: Rename and Delete of a world whose lock is held are refused with `This world is open in another tab` and write nothing', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha', { updated: 5 });
    // Another tab's world page holds the world.
    const holder = await holdWorld(NODE_LOCKS, id);
    expect(holder).not.toBeNull();
    try {
      mount(kv);
      await openLoad();
      const write = vi.spyOn(kv, 'write');
      one(row(id), 'world-rename').click();
      const field = one(row(id), 'world-name-input');
      field.value = 'Gamma';
      field.dispatchEvent(key('Enter'));
      await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('This world is open in another tab'));
      one(dom.el('load-notice'), 'notice-close').click();
      expect(dom.el('load-notice').textContent).toBe('');
      one(row(id), 'world-delete').click();
      await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Delete \'Alpha\'? This cannot be undone.'));
      one(dom.el('load-notice'), 'notice-confirm').click();
      await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('This world is open in another tab'));
      await flush();
      expect(write).not.toHaveBeenCalled();
      expect(names(kv)).toEqual(['Alpha']);
      expect(kv.dump('state').map(([k]) => k)).toEqual([id]);
    } finally {
      holder?.release();
    }
  });

  test('Delete asks in the notice row; Cancel writes nothing; Delete removes every key', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha', { updated: 5 });
    const keep = await saved(kv, 'Keep', { updated: 4 });
    const history: HistoryRecord = { worldId: id, done: [], undone: [] };
    expect((await kv.write([
      { op: 'put', store: 'history', key: id, value: history },
      { op: 'put', store: 'diffs', key: [id, 0], value: new Uint8Array([1]) },
      { op: 'put', store: 'diffs', key: [id, 2 ** 32 - 1], value: new Uint8Array([2]) },
      { op: 'put', store: 'history', key: keep, value: { ...history, worldId: keep } },
      { op: 'put', store: 'diffs', key: [keep, 3], value: new Uint8Array([3]) },
    ])).status).toBe('complete');
    mount(kv);
    await openLoad();
    const write = vi.spyOn(kv, 'write');
    one(row(id), 'world-delete').click();
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Delete \'Alpha\'? This cannot be undone.'));
    expect(byClass(dom.el('load-notice'), 'notice-action').map((b) => b.textContent)).toEqual(['Delete', 'Cancel']);
    byClass(dom.el('load-notice'), 'notice-action')[1]!.click();
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(rows().map((r) => r.dataset['id'])).toEqual([id, keep]);
    one(row(id), 'world-delete').click();
    await vi.waitFor(() => expect(byClass(dom.el('load-notice'), 'notice-confirm').length).toBe(1));
    one(dom.el('load-notice'), 'notice-confirm').click();
    await vi.waitFor(() => expect(rows().map((r) => r.dataset['id'])).toEqual([keep]));
    expect(write).toHaveBeenCalledTimes(1);
    for (const store of ['worlds', 'state', 'history'] as const) expect(kv.dump(store).map(([k]) => k)).toEqual([keep]);
    expect(kv.dump('diffs').map(([k]) => k)).toEqual([[keep, 3]]);
  });

  test('a hidden → visible switch reads the list again', async () => {
    const kv = createMemoryKV();
    await saved(kv, 'Alpha', { updated: 5 });
    const { saves } = mount(kv);
    const list = vi.spyOn(saves, 'list');
    await openLoad();
    expect(list).toHaveBeenCalledTimes(1);
    // Another tab creates a world.
    const other = await saved(kv, 'Beta', { updated: 6 });
    dom.document.visibilityState = 'hidden';
    dom.document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    dom.document.visibilityState = 'visible';
    dom.document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(rows().map((r) => r.dataset['id'])[0]).toBe(other));
    expect(list).toHaveBeenCalledTimes(2);
  });

  test('no `confirm(` anywhere: Rename and Delete never open a browser dialog (the arch\'s uiDialogs rule scans the source)', async () => {
    const dialogs = { confirm: vi.fn(() => true), alert: vi.fn(), prompt: vi.fn(() => null) };
    for (const [k, f] of Object.entries(dialogs)) vi.stubGlobal(k, f);
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha', { updated: 5 });
    mount(kv);
    await openLoad();
    one(row(id), 'world-rename').click();
    const field = one(row(id), 'world-name-input');
    field.value = 'Gamma';
    field.dispatchEvent(key('Enter'));
    await vi.waitFor(() => expect(names(kv)).toEqual(['Gamma']));
    await vi.waitFor(() => expect(byClass(row(id), 'world-delete').length).toBe(1));
    one(row(id), 'world-delete').click();
    await vi.waitFor(() => expect(byClass(dom.el('load-notice'), 'notice-confirm').length).toBe(1));
    one(dom.el('load-notice'), 'notice-confirm').click();
    await vi.waitFor(() => expect(kv.dump('worlds')).toEqual([]));
    for (const f of Object.values(dialogs)) expect(f).not.toHaveBeenCalled();
  });

  /** Every object URL's blob and every link clicked meanwhile (`downloadBlob`'s), from now on. */
  function downloads() {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob);
      return `blob:${blobs.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(FakeElement.prototype, 'click');
    const links = () => (click.mock.contexts as FakeElement[])
      .filter((e) => e.tagName === 'A')
      .map((a) => ({ name: (a as unknown as HTMLAnchorElement).download, href: a.href }));
    return { blobs, links };
  }

  /** Picks `file` in Load world's hidden file input. */
  function pick(file: File): void {
    const input = dom.el('load-import-file');
    let opened = 0;
    const onClick = () => { opened++; };
    input.addEventListener('click', onClick);
    dom.el('load-import').click();
    input.removeEventListener('click', onClick);
    expect(opened).toBe(1);
    Object.assign(input, { files: [file] });
    input.dispatchEvent(new Event('change'));
  }

  test('Export names the file `exportFileName`; Import adds the world with `Imported \'name\'`', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha/Beta?', { updated: 5, places: 2 });
    expect((await kv.write([{ op: 'put', store: 'diffs', key: [id, colKey(1, 2)], value: encodeColumnDiff(oneVoxel(S('stone')), [1, 2]) }])).status).toBe('complete');
    mount(kv);
    await openLoad();
    const d = downloads();
    const write = vi.spyOn(kv, 'write');
    one(row(id), 'world-export').click();
    await vi.waitFor(() => expect(d.links()).toEqual([{ name: exportFileName('Alpha/Beta?'), href: 'blob:1' }]));
    expect(exportFileName('Alpha/Beta?')).toBe('Alpha_Beta_.wiworld');
    expect(write).not.toHaveBeenCalled();
    const source = await createSaves(kv).readAll(id);
    const exported = await readWiworld(d.blobs[0]!, STATE_BOUNDS, 'x', 0);
    expect(exported.ok && wiworldHash(exported.dump)).toBe(wiworldHash(source!));

    pick(new File([d.blobs[0]!], 'Alpha_Beta_.wiworld'));
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Imported \'Alpha/Beta?\''));
    expect(write).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(rows().length).toBe(2));
    const added = rows().map((r) => r.dataset['id']!).find((r) => r !== id)!;
    expect(row(added).textContent).toContain('Alpha/Beta? · default · seed 7');
    expect(row(added).textContent).toContain('· 2 places');
    expect(wiworldHash((await createSaves(kv).readAll(added))!)).toBe(wiworldHash(source!));
    expect(dom.el('load-notice').textContent).not.toContain('could not be read');
  });

  test('Review Focus 3 (P25): an imported file from another `stateTable` says `3 blocks of unknown types became air`; an undecodable column says `1 columns of this world could not be read`', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Old', { updated: 5 });
    const source = (await createSaves(kv).readAll(id))!;
    const table = [...[...todayStateTable()].reverse().slice(0, 55), 'nope[x=1]'];
    const unknown = oneVoxel(table.indexOf('nope[x=1]'));
    const three: ColumnDiff = { sy: Uint8Array.of(0, 0, 0), idx: Uint16Array.of(1, 2, 3), value: Uint32Array.from([1, 2, 3], () => unknown.value[0]!) };
    const broken = encodeColumnDiff(oneVoxel(1), [0, 0]);
    broken[0] = 2;
    const file = await writeWiworld({
      ...source, world: { ...source.world, stateTable: table },
      cols: [{ key: colKey(0, 0), bytes: encodeColumnDiff(three, [0, 0]) }, { key: colKey(0, 1), bytes: broken }],
    });
    mount(kv);
    await openLoad();
    pick(new File([file], 'old.wiworld'));
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Imported \'Old\''));
    expect(dom.el('load-notice').textContent).toContain('3 blocks of unknown types became air');
    expect(dom.el('load-notice').textContent).toContain('1 columns of this world could not be read');
    await vi.waitFor(() => expect(rows().length).toBe(2));
  });

  test('an imported empty name becomes `newWorldName`\'s proposal among the saved names; a long one is cut to 64 (D2, MENU-5)', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'New world 1', { updated: 5 });
    const source = (await createSaves(kv).readAll(id))!;
    mount(kv);
    await openLoad();
    pick(new File([await writeWiworld({ ...source, world: { ...source.world, name: '' } })], 'empty.wiworld'));
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Imported \'New world 2\''));
    await vi.waitFor(() => expect(rows().length).toBe(2));
    pick(new File([await writeWiworld({ ...source, world: { ...source.world, name: 'y'.repeat(70) } })], 'long.wiworld'));
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain(`Imported '${'y'.repeat(64)}'`));
    await vi.waitFor(() => expect(rows().length).toBe(3));
    expect(kv.dump('worlds').map(([, w]) => (w as { name: string }).name).sort()).toEqual(['New world 1', 'New world 2', 'y'.repeat(64)]);
  });

  test('an Import refusal shows its reason and writes nothing', async () => {
    const kv = createMemoryKV();
    const id = await saved(kv, 'Alpha', { updated: 5 });
    const raw = new Uint8Array(gunzipSync(new Uint8Array(await (await writeWiworld((await createSaves(kv).readAll(id))!)).arrayBuffer())));
    new DataView(raw.buffer, raw.byteOffset).setUint32(4, 2, true);
    mount(kv);
    await openLoad();
    const write = vi.spyOn(kv, 'write');
    pick(new File([gzipSync(raw)], 'newer.wiworld'));
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Made by a newer version of world-imaginer-voxel'));
    pick(new File([new Uint8Array([1, 2, 3])], 'junk.wiworld'));
    await vi.waitFor(() => expect(dom.el('load-notice').textContent).toContain('Not a .wiworld file'));
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(kv.dump('worlds').map(([k]) => k)).toEqual([id]);
  });

  test('dispose stops the list\'s re-read', async () => {
    const kv = createMemoryKV();
    const { menu, saves } = mount(kv);
    const list = vi.spyOn(saves, 'list');
    await openLoad();
    menu.dispose();
    dom.document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
  });
});

/** Whether `#id` and every ancestor are not hidden. */
function shown(dom: ReturnType<typeof installDom>, id: string): boolean {
  for (let e: FakeElement | null = dom.el(id); e !== null; e = e.parentElement) if (e.hidden) return false;
  return true;
}

declare global {
  // The worlds menu's list time (`window.__wiMenuListMs`), read here through `globalThis`.
  var __wiMenuListMs: number | undefined;
}

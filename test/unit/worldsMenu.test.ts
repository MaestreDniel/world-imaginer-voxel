import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { seedFromInput, seedToText } from '../../src/core/seed';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import {
  createSaves, loadParams, newState, olderGenerator, parseWorldRecord, todayStateTable, type HistoryRecord, type WorldRecord,
} from '../../src/persist/saves';
import { DEFAULT_MAP_STATE, encodeMapState } from '../../src/ui/map/mapState';
import { profileOptions } from '../../src/ui/map/toolbar';
import { parseWorldQuery } from '../../src/ui/world/query';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { holdWorld, type LockManagerLike } from '../../src/ui/world/worldLock';
import { SAVES_DB } from '../../src/ui/world/worldPage';
import {
  mountWorldsMenu, noticeOfQuery, PERSIST_ASKED_KEY, REFUSAL_REASON_KEY, refusalText, refusalUrl, savesDbOf, startModeOf,
  type StorageLike, type WorldsMenuOptions,
} from '../../src/ui/worldsMenu';
import { installDom, type FakeElement } from './fixtures/domShim';

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
  afterEach(() => { vi.unstubAllGlobals(); });

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

  /** A saved world with a state `updated` at `updated` (0: never saved) and `places` places. */
  async function saved(
    kv: MemoryKV, name: string, o: { updated?: number; places?: number; backupOf?: string | null; created?: number; profile?: WorldRecord['profile']; seedText?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    const world: WorldRecord = {
      id, name, seedText: o.seedText ?? '7', seed: [7, 0], profile: o.profile ?? 'default', params: {}, schemaVersion: 2,
      paramsHash: '0'.repeat(16), generatorVersion: 5, genKey: '0'.repeat(16), stateTable: todayStateTable(), created: o.created ?? 1_600_000_000_000,
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

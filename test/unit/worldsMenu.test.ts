import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { seedFromInput, seedToText } from '../../src/core/seed';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import { createSaves, loadParams, newState, olderGenerator, todayStateTable, type WorldRecord } from '../../src/persist/saves';
import { DEFAULT_MAP_STATE, encodeMapState } from '../../src/ui/map/mapState';
import { profileOptions } from '../../src/ui/map/toolbar';
import { parseWorldQuery } from '../../src/ui/world/query';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
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

import './ui/styles.css';
import type { LockManagerLike } from './ui/world/worldLock';

/**
 * The routes (SP4a spec §8.1, D21): `?lab=noise`, `?map`, `?selftest=1` and `?spike=batch` are their own pages;
 * everything else is `/`, the 3D world. `startModeOf` decides whether the worlds menu shows first (`ui/worldsMenu.ts`,
 * SP5b spec §1.1: none of `?world`, `?at`, `?rd`, `?workers`; a `#` hash is ignored), over the saved worlds' database
 * (`savesDbOf`: `wi10`, or the enter bench's `?enterBench=1&db=`), with the world page's refusal (`?notice=`, removed
 * from the address once read); its Create navigates to `/?world=<id>`, and without storage it mounts the unsaved world
 * in place (`enterUnsaved`, with the page's `unsavedNotice`). `?world=<id>` opens a saved world; `?at`, `?rd` or
 * `?workers` an unsaved one, as in SP5a. `?shot=1` is the capture mode (no HUD, no overlay, the clock fixed at
 * `?time` or 08:00; ruling P48). `?flight=sp4a` is the flight route (spec §9.5, `ui/world/flight.ts`): the world page at
 * seed 42, the default profile and RD 12, then a 60 s scripted flight whose JSON measureChrome reads. `?pano=<id>` is
 * the panorama capture route (spec §8.3, `ui/world/panoramaRoute.ts`): the world page at one of the six viewpoints,
 * read by `test/tools/panoramas.ts`. `?bench=medium` is the streaming bench (SP4b spec §8.3, `ui/world/bench.ts`): the
 * world page at seed 42 and RD 12, then a 95 s scripted flight through the page's own streaming frame, honouring
 * `?workers` and `?renderer`; its JSON is read by measureChrome (`&shot=<name>` freezes it for a review shot).
 * `?bench=enter` is the enter bench's setup page (SP5b spec §6.2, `mountEnterBench`; `&phase=end` its end): a world
 * load with `?enterBench=1` publishes its figures at the reveal, `{ error }` when it does not reveal, and under
 * `&auto=1` loads the self-driving run's next page (`enterLoaded`).
 * `?wiTest=1` (the browser smoke, SP4c spec §8.6) installs `window.__wiTest` on the world route before anything mounts:
 * the pending-timer counters first, then the world page attaches its parts after the reveal; absent without the flag.
 */

const root = document.getElementById('app');
if (root === null) throw new Error('#app element missing from index.html');
const app: HTMLElement = root;

function showBootFailure(error: unknown): void {
  const pre = document.createElement('pre');
  pre.textContent = `Boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  app.replaceChildren(pre);
}

/** The panorama manifest, or null when it is not served (the loading screen keeps its gradient; ruling P46). */
const loadManifest = (): Promise<unknown> => fetch('/panoramas/manifest.json').then((r) => (r.ok ? r.json() : null));

/** Web Locks for the menu where `navigator.locks` is missing: never used, since the menu then has no saved worlds. */
const NO_LOCKS: LockManagerLike = { request: () => Promise.reject(new DOMException('Web Locks are not available', 'NotSupportedError')) };

async function world(query: URLSearchParams): Promise<void> {
  // Before the page or the menu sets a timer, so the smoke's pending-timer count sees every one.
  const wiTest = query.get('wiTest') === '1' ? (await import('./ui/world/worldPage')).installWiTest(window) : null;
  const [{ parseWorldQuery }, menu, { cryptoSeed }] = await Promise.all([
    import('./ui/world/query'),
    import('./ui/worldsMenu'),
    import('./ui/seedBox'),
  ]);
  const q = parseWorldQuery(query);
  // Without `shot`, `time` is ignored (ruling P48).
  const capture = q.shot ? { hud: false, overlay: false, timeHours: q.time ?? 8 } : {};
  const opts = wiTest === null ? capture : { ...capture, wiTest };
  const enter = async (hash: string, unsavedNotice?: string): Promise<void> => {
    const { mountWorldPage } = await import('./ui/world/worldPage');
    const page = await mountWorldPage(app, q, hash, unsavedNotice === undefined ? opts : { ...opts, unsavedNotice });
    if (q.enterBench) (await import('./ui/world/bench')).enterLoaded(page.state === 'revealed', query.get('auto') === '1');
  };
  if (menu.startModeOf(query) === 'world') return enter(location.hash);

  // The menu's saved worlds; none without Web Locks (no world could be opened) or when the database cannot open (D14).
  const locks = (navigator as { locks?: LockManagerLike }).locks ?? null;
  const [{ openIdbKV }, { createSaves }] = await Promise.all([import('./persist/idb'), import('./persist/saves')]);
  const saves = locks === null ? null : await openIdbKV(menu.savesDbOf(q)).then(createSaves, () => null);
  const notice = menu.noticeOfQuery(query, menu.sessionStorageOrNull());
  if (query.has('notice')) {
    const rest = new URLSearchParams(query);
    rest.delete('notice');
    const search = rest.toString();
    history.replaceState(history.state, '', `${location.pathname}${search === '' ? '' : `?${search}`}`);
  }
  const m = menu.mountWorldsMenu(app, {
    saves,
    locks: locks ?? NO_LOCKS,
    random: cryptoSeed,
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    navigate: (url) => location.assign(url),
    persistStorage: () => navigator.storage?.persist?.() ?? Promise.resolve(false),
    enterUnsaved: (hash, text) => {
      m.dispose();
      saves?.kv.close();
      enter(hash, text).catch(showBootFailure);
    },
    loadManifest,
    rand: Math.random,
    notice,
    benchDb: q.db,
  });
}

const query = new URLSearchParams(location.search);
const started: Promise<void> = query.get('lab') === 'noise'
  ? import('./ui/lab/noiseLab').then((m) => m.mountNoiseLab(app))
  : query.has('map')
    ? import('./ui/map/mapPage').then((m) => m.mountMapPage(app))
    : query.get('selftest') === '1'
      ? import('./ui/selftest/selftestPage').then((m) => m.mountSelftestPage(app))
      : query.get('spike') === 'batch'
        ? import('./ui/spike/spikePage').then((m) => m.mountSpikePage(app))
        : query.get('flight') === 'sp4a'
          ? import('./ui/world/flight').then((m) => m.mountFlightRoute(app, query))
          : query.get('bench') === 'medium'
            ? import('./ui/world/bench').then((m) => m.mountBenchRoute(app, query))
            : query.get('bench') === 'enter'
              ? import('./ui/world/bench').then((m) => m.mountEnterBench(app, query))
              : query.has('pano')
                ? import('./ui/world/panoramaRoute').then((m) => m.mountPanoramaRoute(app, query.get('pano') ?? ''))
                : world(query);
started.catch(showBootFailure);

import './ui/styles.css';
import type { Seed64 } from './core/hash';

/**
 * The routes (SP4a spec §8.1, D21): `?lab=noise`, `?map`, `?selftest=1` and `?spike=batch` are their own pages;
 * everything else is `/`, the 3D world. `startModeOf` decides whether the start screen shows first (a bare `/` or a `#`
 * hash alone); "Enter the world" then mounts the world page in the same page, with no navigation. `?at`, `?rd` or
 * `?workers` go straight to the loading screen. `?shot=1` is the capture mode (no HUD, no overlay, the clock fixed at
 * `?time` or 08:00; ruling P48). `?flight=sp4a` is the flight route (spec §9.5, `ui/world/flight.ts`): the world page at
 * seed 42, the default profile and RD 12, then a 60 s scripted flight whose JSON measureChrome reads. `?pano=<id>` is
 * the panorama capture route (spec §8.3, `ui/world/panoramaRoute.ts`): the world page at one of the six viewpoints,
 * read by `test/tools/panoramas.ts`. `?bench=medium` is the streaming bench (SP4b spec §8.3, `ui/world/bench.ts`): the
 * world page at seed 42 and RD 12, then a 95 s scripted flight through the page's own streaming frame, honouring
 * `?workers` and `?renderer`; its JSON is read by measureChrome (`&shot=<name>` freezes it for a review shot).
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

async function world(query: URLSearchParams): Promise<void> {
  const [{ parseWorldQuery }, { startModeOf, mountStartScreen }, { cryptoSeed }] = await Promise.all([
    import('./ui/world/query'),
    import('./ui/world/startScreen'),
    import('./ui/seedBox'),
  ]);
  const q = parseWorldQuery(query);
  // Without `shot`, `time` is ignored (ruling P48).
  const opts = q.shot ? { hud: false, overlay: false, timeHours: q.time ?? 8 } : {};
  const enter = async (): Promise<void> => {
    const { mountWorldPage } = await import('./ui/world/worldPage');
    await mountWorldPage(app, q, location.hash, opts);
  };
  if (startModeOf(query) === 'world') return enter();
  const start = mountStartScreen(app, {
    hash: location.hash,
    onEnter: () => {
      start.dispose();
      enter().catch(showBootFailure);
    },
    random: (): Seed64 => cryptoSeed(),
    loadManifest,
    rand: Math.random,
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
            : query.has('pano')
              ? import('./ui/world/panoramaRoute').then((m) => m.mountPanoramaRoute(app, query.get('pano') ?? ''))
              : world(query);
started.catch(showBootFailure);

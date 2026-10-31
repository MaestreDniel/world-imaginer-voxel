import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSaves } from '../../src/persist/saves';
import { createMemoryKV } from '../../src/persist/memory';
import { mountSelftestPage } from '../../src/ui/selftest/selftestPage';
import { mountWorldsMenu } from '../../src/ui/worldsMenu';
import { installDom } from './fixtures/domShim';

// The selftest page's pool, never answering: the page's markup is what these tests read, not its run.
vi.mock('../../src/engine/workerPool', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/engine/workerPool')>(),
  createBrowserPool: () => ({ selftest: () => new Promise(() => {}), terminate: () => {} }),
}));

const CSS = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

/**
 * The declarations styles.css gives an element `selector` names exactly (one of a rule's comma-separated selectors), in
 * source order, later ones winning; `overflow`'s shorthand is spread into `overflow-x` and `overflow-y`.
 */
function declared(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      const value = d.slice(i + 1).trim();
      if (prop === 'overflow') {
        const [x, y = x] = value.split(/\s+/);
        out['overflow-x'] = x!;
        out['overflow-y'] = y!;
      } else {
        out[prop] = value;
      }
    }
  }
  return out;
}

describe('the menus and the selftest page scroll when taller than the window; the world page does not (ruling R14)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('the start screen scrolls vertically inside itself, centred while its card fits (`safe center`); never sideways', () => {
    const screen = declared('.start-screen');
    expect(screen['overflow-y']).toBe('auto');
    expect(screen['overflow-x']).toBe('hidden');
    expect(screen['align-content']).toBe('safe center');
    expect(screen['place-items']).toBe('center');
    expect(screen['position']).toBe('fixed');
    expect(screen['inset']).toBe('0');
  });

  test('the backdrop and the Settings panel over the start screen stay on the window while the menu scrolls', () => {
    expect(declared('.start-screen > .screen-backdrop')['position']).toBe('fixed');
    expect(declared('.start-screen > .settings-panel')['position']).toBe('fixed');
  });

  test('the loading screen keeps its own layout (no scrolling)', () => {
    expect(declared('.loading-screen')['overflow-y']).toBe('hidden');
  });

  test('the selftest page is its own scroll box over the page\'s height', () => {
    const page = declared('.selftest-page');
    expect(page['height']).toBe('100%');
    expect(page['overflow-y']).toBe('auto');
  });

  test('the world page stays non-scrolling: the body and the world host hide their overflow', () => {
    expect(declared('body')['overflow-y']).toBe('hidden');
    expect(declared('.world-host')['overflow-y']).toBe('hidden');
  });

  test('the worlds menu mounts the screen with the backdrop and the Settings panel as its direct children', async () => {
    const dom = installDom();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const menu = mountWorldsMenu(dom.body as unknown as HTMLElement, {
      saves: createSaves(createMemoryKV()),
      locks: { request: () => Promise.reject(new Error('no lock in this test')) },
      random: () => [1, 0],
      newId: () => 'w1',
      now: () => 1_700_000_000_000,
      navigate: () => {},
      persistStorage: () => Promise.resolve(true),
      enterUnsaved: () => {},
      loadManifest: () => Promise.resolve<unknown>([]),
      rand: () => 0,
      notice: null,
      benchDb: null,
    });
    const screen = dom.el('start-screen');
    expect(screen.className).toBe('start-screen');
    expect(screen.parentElement).toBe(dom.body);
    expect(dom.el('start-screen-backdrop').className).toBe('screen-backdrop');
    expect(dom.el('start-screen-backdrop').parentElement).toBe(screen);
    expect(dom.el('settings-panel').classList.contains('settings-panel')).toBe(true);
    expect(dom.el('settings-panel').parentElement).toBe(screen);
    await new Promise<void>((r) => setTimeout(r, 0));
    menu.dispose();
  });

  test('the selftest page\'s root element is `.selftest-page`', () => {
    const dom = installDom();
    const root = dom.document.createElement('div');
    mountSelftestPage(root as unknown as HTMLElement);
    expect(root.children.length).toBe(1);
    expect(root.children[0]!.className).toBe('selftest-page');
  });
});

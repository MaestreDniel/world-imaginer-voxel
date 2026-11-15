import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OPENING_T } from '../../src/daynight/dayNight';
import { mountWorldHud, type HudData } from '../../src/ui/hud';
import { mountWorldTop } from '../../src/ui/world/worldPage';
import { createXrayStrip, XRAY_ALL } from '../../src/ui/world/xrayStrip';
import { installDom } from './fixtures/domShim';

const DATA: HudData = {
  frame: { fps: 60, p50: 16.7, p95: 17.2, count: 120 },
  stages: {
    T: { done: 825, needed: 825, inFlight: 0, queued: 0 },
    D: { done: 705, needed: 705, inFlight: 0, queued: 0 },
    L: { done: 593, needed: 593, inFlight: 0, queued: 0 },
    MESH: { done: 489, needed: 489, inFlight: 0, queued: 0 },
  },
  stale: 0,
  needed: 489,
  sections: 3512,
  revealed: 489,
  genCap: 5,
  dropped: 0,
  failed: 0,
  drawCalls: 640,
  triangles: 1_420_000,
  position: { x: 12.3, y: 80, z: -40.5 },
  mode: 'fly',
  speed: 12,
  time: OPENING_T,
  timeSpeed: 10,
  rdTarget: 12,
  rdFog: 12,
  workers: 6,
  liveWorkers: 6,
  regions: 20,
  gpuMB: 92.44,
  sectionRenderer: 'batch',
  renderer: null,
  edit: null,
  xray: { band: XRAY_ALL, mode: 1 },
};

const SRC = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
const CSS = (): string => readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

/** A rule's declarations in `styles.css` (the line starting with `sel {`), as property → value. */
function decls(sel: string): Map<string, string> {
  const css = CSS();
  const at = css.indexOf(`\n${sel} {`);
  if (at < 0) throw new Error(`no rule ${sel}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return new Map(body.split(';').map((d) => d.trim()).filter((d) => d !== '').map((d) => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string];
  }));
}

describe('the strip and the F3 HUD in one top container (SP6b spec §9.5, D8)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('the host holds one `.world-top` whose children are the HUD then the strip', () => {
    const host = dom.body as unknown as HTMLElement;
    // The page's order: the container, the strip (its page X-ray feeds the HUD's line), then the HUD.
    const top = mountWorldTop(host);
    const strip = createXrayStrip(top);
    const hud = mountWorldHud(top, () => DATA);
    expect(dom.body.children).toHaveLength(1);
    expect(dom.body.querySelectorAll('div').filter((e) => e.className === 'world-top')).toHaveLength(1);
    expect(dom.body.children[0]!.className).toBe('world-top');
    expect(dom.body.children[0]!.children.map((c) => c.className)).toEqual(['world-hud', 'world-xray-strip']);
    expect(dom.body.children[0]!.children[1]!.id).toBe('world-xray-strip');
    // Disposing each takes it out of the container.
    hud.dispose();
    strip.dispose();
    expect(dom.body.children[0]!.children).toEqual([]);
    // The page makes one container per host and mounts the HUD and the strip into it, never into the host.
    const s = SRC();
    expect(s.match(/const worldTop = mountWorldTop\(host\);/g)).toHaveLength(1);
    expect(s).toMatch(/const xrayStrip = createXrayStrip\(worldTop\);/);
    expect(s).toMatch(/\? mountWorldHud\(worldTop, \(\) => \{/);
    expect(s).not.toMatch(/createXrayStrip\(host\)/);
    expect(s).not.toMatch(/mountWorldHud\(host/);
  });

  test('styles.css: the container\'s flex rules; the HUD and the strip are static flex items', () => {
    expect(Object.fromEntries(decls('.world-top'))).toEqual({
      position: 'absolute',
      top: '.5rem',
      left: '.5rem',
      right: '.5rem',
      display: 'flex',
      'flex-wrap': 'wrap',
      'align-items': 'flex-start',
      gap: '.5rem',
      'pointer-events': 'none',
      'z-index': '2',
    });
    const hud = decls('.world-hud');
    for (const p of ['position', 'top', 'left', 'z-index']) expect(hud.has(p), `.world-hud ${p}`).toBe(false);
    expect(hud.get('white-space')).toBe('pre');
    const strip = decls('.world-xray-strip');
    for (const p of ['position', 'left', 'top', 'transform']) expect(strip.has(p), `.world-xray-strip ${p}`).toBe(false);
    expect(strip.get('margin-inline')).toBe('auto');
    expect(strip.get('max-width')).toBe('40rem');
    // A hidden HUD or strip takes no room in the row.
    expect(CSS()).toMatch(/(^|, )\.world-hud\[hidden\](, [^{]*)? \{ display: none; \}/m);
    expect(CSS()).toMatch(/(^|, )\.world-xray-strip\[hidden\](, [^{]*)? \{ display: none; \}/m);
  });

  test('with the HUD hidden the strip is the container\'s only visible child', () => {
    const top = mountWorldTop(dom.body as unknown as HTMLElement);
    const strip = createXrayStrip(top);
    const hud = mountWorldHud(top, () => DATA);
    strip.set(true, XRAY_ALL, 1);
    const visible = (): string[] => dom.body.children[0]!.children.filter((c) => !c.hidden).map((c) => c.className);
    expect(visible()).toEqual(['world-hud', 'world-xray-strip']);
    hud.toggle();
    expect(visible()).toEqual(['world-xray-strip']);
    hud.toggle();
    expect(visible()).toEqual(['world-hud', 'world-xray-strip']);
    strip.set(false, XRAY_ALL, 1);
    expect(visible()).toEqual(['world-hud']);
    hud.dispose();
    strip.dispose();
  });

  test('the bench page uses the same container for its strip', () => {
    const s = SRC();
    const bench = s.slice(s.indexOf('if (opts.bench !== undefined) {'), s.indexOf('const worldTop = mountWorldTop(host);'));
    expect(bench).toMatch(/const benchTop = mountWorldTop\(host\);\n\s+teardown\.push\(\(\) => benchTop\.remove\(\)\);\n\s+const benchStrip = createXrayStrip\(benchTop\);/);
    expect(s).toMatch(/const worldTop = mountWorldTop\(host\);\n\s+teardown\.push\(\(\) => worldTop\.remove\(\)\);/);
  });
});

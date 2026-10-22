import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mountLoadingScreen, type LoadingScreen } from '../../src/ui/loading/loadingScreen';
import { parseManifest, pickPanorama, type PanoramaEntry } from '../../src/ui/loading/panoramas';
import { installDom } from './fixtures/domShim';

const ENTRY: PanoramaEntry = {
  id: 'coast', file: 'coast.webp', seed: '42', profile: 'default', x: -26624, z: -31992, yaw: 90, pitch: -10, time: 8,
  commit: 'abc1234', renderer: 'SwiftShader',
};

/** The injected document of the watchdog cases: only `hidden` and the event methods (spec §8.3, Review Focus 2). */
class FakeVisibility extends EventTarget {
  hidden = false;
}

describe('the loading screen (SP4a spec §8.3, D22)', () => {
  let dom: ReturnType<typeof installDom>;
  let t = 0;
  let doc: FakeVisibility;
  let onWatchdog: ReturnType<typeof vi.fn<() => void>>;
  let screen: LoadingScreen | null = null;

  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
    t = 0;
    doc = new FakeVisibility();
    onWatchdog = vi.fn<() => void>();
  });
  afterEach(() => {
    screen?.dispose();
    screen = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(over: { tips?: string[]; loadManifest?: () => Promise<unknown>; rand?: () => number } = {}): LoadingScreen {
    screen = mountLoadingScreen(dom.body as unknown as HTMLElement, {
      tips: over.tips ?? ['one', 'two', 'three'],
      now: () => t,
      doc: doc as unknown as Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>,
      onWatchdog,
      loadManifest: over.loadManifest ?? (() => Promise.resolve([])),
      rand: over.rand ?? (() => 0),
    });
    return screen;
  }

  /** Advances the injected clock and the fake timers together, in 100 ms steps. */
  function advance(ms: number): void {
    for (let left = ms; left > 0; left -= 100) {
      const step = Math.min(100, left);
      t += step;
      vi.advanceTimersByTime(step);
    }
  }

  /** Lets the manifest and decode promises settle (the fake timers do not drive microtasks). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  describe('watchdog', () => {
    test('fires at 30 s without progress, once', () => {
      mount();
      advance(29_900);
      expect(onWatchdog).not.toHaveBeenCalled();
      advance(100);
      expect(onWatchdog).toHaveBeenCalledTimes(1);
      advance(60_000);
      expect(onWatchdog).toHaveBeenCalledTimes(1);
    });

    test('does not fire when the progress rises at 29 s; a progress that does not rise does not restart it', () => {
      const s = mount();
      s.progress(0.1, 'Generating');
      advance(29_000);
      s.progress(0.2, 'Generating');
      advance(29_000);
      expect(onWatchdog).not.toHaveBeenCalled();
      // The same fraction again, or a lower one, is no progress.
      s.progress(0.2, 'Generating');
      s.progress(0.15, 'Lighting');
      advance(1_000);
      expect(onWatchdog).toHaveBeenCalledTimes(1);
    });

    test('time while document.hidden does not count toward the 30 s watchdog, and the watchdog restarts its window on visibilitychange', () => {
      mount();
      advance(20_000);
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      advance(120_000); // a background tab: rAF stops, the workers go on
      expect(onWatchdog).not.toHaveBeenCalled();
      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      advance(29_900);
      expect(onWatchdog).not.toHaveBeenCalled();
      advance(100);
      expect(onWatchdog).toHaveBeenCalledTimes(1);
    });

    test('a visibilitychange restarts the window even while visible, and hidden time counts nothing even without the event', () => {
      mount();
      advance(25_000);
      doc.dispatchEvent(new Event('visibilitychange'));
      advance(29_900);
      expect(onWatchdog).not.toHaveBeenCalled();
      doc.hidden = true; // no event (a missed one must not count the hidden time either)
      advance(60_000);
      doc.hidden = false;
      advance(29_000);
      expect(onWatchdog).not.toHaveBeenCalled();
      advance(1_100);
      expect(onWatchdog).toHaveBeenCalledTimes(1);
    });

    test('fail, fadeOut and dispose stop the watchdog and remove the visibility listener', async () => {
      const remove = vi.spyOn(doc, 'removeEventListener');
      const s = mount();
      s.fail('x', 'y', { map: '?map', lowerRd: null });
      advance(60_000);
      expect(onWatchdog).not.toHaveBeenCalled();
      s.dispose();
      expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      const s2 = mount();
      const done = s2.fadeOut(300);
      advance(300);
      await done;
      advance(60_000);
      expect(onWatchdog).not.toHaveBeenCalled();
      expect(dom.body.querySelector('#loading-screen')).toBeNull();
    });
  });

  test('progress: one bar and a phase line; the bar never moves back', () => {
    const s = mount();
    s.progress(0.4, 'Lighting');
    expect(dom.el('loading-bar-fill').style.width).toBe('40%');
    expect(dom.el('loading-phase').textContent).toBe('Lighting');
    s.progress(0.3, 'Meshing');
    expect(dom.el('loading-bar-fill').style.width).toBe('40%');
    expect(dom.el('loading-phase').textContent).toBe('Meshing');
    s.progress(2, 'Preparing the view');
    expect(dom.el('loading-bar-fill').style.width).toBe('100%');
  });

  test('tips rotate every 7 s, starting at a random one', () => {
    mount({ tips: ['one', 'two', 'three'], rand: () => 0.5 });
    expect(dom.el('loading-tip').textContent).toBe('two');
    advance(6_900);
    expect(dom.el('loading-tip').textContent).toBe('two');
    advance(100);
    expect(dom.el('loading-tip').textContent).toBe('three');
    advance(7_000);
    expect(dom.el('loading-tip').textContent).toBe('one');
  });

  test('fail shows the cause, "Copy details" and both links', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const s = mount();
    s.fail('Generating failed at column (3, -4)', 'Error: boom\n  at x', { map: '?map#abc', lowerRd: '/?rd=10&at=0,0#abc' });
    const panel = dom.el('loading-fail');
    expect(panel.hidden).toBe(false);
    expect(dom.el('loading-cause').textContent).toBe('Generating failed at column (3, -4)');
    expect(dom.el('loading-details').textContent).toBe('Error: boom\n  at x');
    const copy = dom.el('loading-copy');
    expect(copy.textContent).toBe('Copy details');
    copy.click();
    expect(writeText).toHaveBeenCalledWith('Error: boom\n  at x');
    expect(dom.el('loading-map').href).toBe('?map#abc');
    expect(dom.el('loading-lower-rd').href).toBe('/?rd=10&at=0,0#abc');
    expect(dom.el('loading-lower-rd').hidden).toBe(false);
    await settle();
  });

  test('fail without a lower RD shows only the map link', async () => {
    vi.stubGlobal('navigator', {});
    const s = mount();
    s.fail('No progress for 30 s', 'details', { map: '?map', lowerRd: null });
    expect(dom.el('loading-map').href).toBe('?map');
    expect(dom.el('loading-lower-rd').hidden).toBe(true);
    // No clipboard: the button says so, and nothing throws.
    dom.el('loading-copy').click();
    await settle();
    expect(dom.el('loading-copy').textContent).toBe('Copy failed');
  });

  describe('background (ruling P46)', () => {
    const backdrop = () => dom.el('loading-screen-backdrop');
    const GRADIENT = /#3D78D6.*#A8CCF5/;

    test('a manifest entry is picked, set as /panoramas/<file>, and faded in on decode with object-fit: cover', async () => {
      let decoded!: () => void;
      dom.document.decodeImage = () => new Promise<void>((r) => { decoded = r; });
      mount({ loadManifest: () => Promise.resolve([ENTRY]) });
      expect(backdrop().style.background).toMatch(GRADIENT);
      await settle();
      const img = backdrop().querySelector('img')!;
      expect(img.src).toBe('/panoramas/coast.webp');
      expect(img.style.objectFit).toBe('cover');
      expect(img.style.opacity).toBe('0');
      decoded();
      await settle();
      expect(img.style.opacity).toBe('1');
      expect(img.dataset.state).toBe('shown');
    });

    test.each<[string, () => Promise<unknown>]>([
      ['the loader rejects (a 404 or a network error)', () => Promise.reject(new Error('404'))],
      ['the body is not JSON (vite preview serves index.html with status 200)', () => Promise.reject(new SyntaxError('Unexpected token <'))],
      ['the parse has no entries', () => Promise.resolve([{ id: 'x' }])],
    ])('%s: the gradient stays, with no throw', async (_, loadManifest) => {
      mount({ loadManifest });
      await settle();
      expect(backdrop().style.background).toMatch(GRADIENT);
      expect(backdrop().querySelector('img')).toBeNull();
    });

    test('the image fails to decode: the gradient stays, with no throw', async () => {
      dom.document.decodeImage = () => Promise.reject(new Error('EncodingError'));
      mount({ loadManifest: () => Promise.resolve([ENTRY]) });
      await settle();
      expect(backdrop().style.background).toMatch(GRADIENT);
      expect(backdrop().querySelector('img')).toBeNull();
    });
  });
});

describe('the panorama manifest (SP4a spec §8.3)', () => {
  test('parseManifest keeps valid entries and drops one without file', () => {
    const { file: _drop, ...noFile } = ENTRY;
    expect(parseManifest([ENTRY, noFile, { ...ENTRY, id: 'b', x: 'far' }, { ...ENTRY, id: 'c', file: '../x.webp' }, null])).toEqual([ENTRY]);
    expect(parseManifest({ entries: [ENTRY] })).toEqual([]);
    expect(parseManifest(null)).toEqual([]);
    expect(parseManifest('<!doctype html>')).toEqual([]);
  });

  test('parseManifest copies only the known fields', () => {
    expect(parseManifest([{ ...ENTRY, extra: 1 }])).toEqual([ENTRY]);
  });

  test('pickPanorama([]) is null; otherwise rand picks the entry', () => {
    expect(pickPanorama([], () => 0.5)).toBeNull();
    const b = { ...ENTRY, id: 'b' };
    expect(pickPanorama([ENTRY, b], () => 0)).toBe(ENTRY);
    expect(pickPanorama([ENTRY, b], () => 0.5)).toBe(b);
    expect(pickPanorama([ENTRY, b], () => 0.999999)).toBe(b);
    expect(pickPanorama([ENTRY, b], () => 1)).toBe(b);
  });
});

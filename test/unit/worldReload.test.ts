import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseWorldQuery } from '../../src/ui/world/query';
import { createReloader, hereUrl, installLeaveGuard, navigateTo } from '../../src/ui/world/reload';
import { createWorldNotices, enterFullscreen, handleContextLoss } from '../../src/ui/world/worldPage';
import { installDom, type FakeElement } from './fixtures/domShim';

describe('hereUrl (SP4a spec §7.5)', () => {
  test('rounds the position, gives the angles to 1 dp and keeps the hash', () => {
    expect(hereUrl({ x: 10.6, y: 80.2, z: -3.4, yaw: 45.04, pitch: -10 }, null, '#abc')).toBe('/?at=11,-3&y=80&yaw=45.0&pitch=-10.0#abc');
  });

  test('adds &rd= when given; a hash without # or an empty hash', () => {
    const s = { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 };
    expect(hereUrl(s, 10, '#abc')).toBe('/?at=0,0&y=70&yaw=0.0&pitch=0.0&rd=10#abc');
    expect(hereUrl(s, null, 'abc')).toBe('/?at=0,0&y=70&yaw=0.0&pitch=0.0#abc');
    expect(hereUrl(s, null, '')).toBe('/?at=0,0&y=70&yaw=0.0&pitch=0.0');
  });

  test('never writes −0, and parseWorldQuery reads back the same view (ruling P42: degrees unchanged)', () => {
    const url = hereUrl({ x: -0.4, y: -0.2, z: 0.3, yaw: 359.96, pitch: -0.04 }, 6, '#h');
    expect(url).toBe('/?at=0,0&y=0&yaw=360.0&pitch=0.0&rd=6#h');
    const q = parseWorldQuery(new URLSearchParams(hereUrl({ x: 1234.5, y: 99.6, z: -987.2, yaw: 271.25, pitch: 12.34 }, 8, '#h').slice(2, -2)));
    expect(q.at).toEqual({ x: 1235, z: -987 });
    expect([q.y, q.yaw, q.pitch, q.rd]).toEqual([100, 271.3, 12.3, 8]);
  });
});

describe('createReloader (Review Focus 3; ruling P50)', () => {
  test('R twice within the reload calls navigate once', () => {
    const navigate = vi.fn<(url: string) => void>();
    const reloader = createReloader(navigate, () => {});
    reloader.reload('/?at=1,2#a');
    reloader.reload('/?at=3,4#a');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/?at=1,2#a');
  });

  test('reload calls disarm before navigate', () => {
    const order: string[] = [];
    const disarm = vi.fn(() => { order.push('disarm'); });
    const navigate = vi.fn((url: string) => { order.push(`navigate ${url}`); });
    const reloader = createReloader(navigate, disarm);
    reloader.reload('/?at=0,0');
    expect(order).toEqual(['disarm', 'navigate /?at=0,0']);
    reloader.reload('/?at=9,9');
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe('navigateTo (final review C-I1)', () => {
  function fakeLocation(href: string) {
    return { href, assign: vi.fn<(url: string) => void>(), reload: vi.fn<() => void>() };
  }

  test('a URL that resolves to the current one reloads (assign would only jump to the fragment)', () => {
    const loc = fakeLocation('http://127.0.0.1:4173/?at=1,2&y=80&yaw=0.0&pitch=0.0#v1.abc');
    navigateTo('/?at=1,2&y=80&yaw=0.0&pitch=0.0#v1.abc', loc);
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(loc.assign).not.toHaveBeenCalled();
  });

  test('any other URL is assigned', () => {
    const loc = fakeLocation('http://127.0.0.1:4173/?at=1,2&y=80&yaw=0.0&pitch=0.0#v1.abc');
    navigateTo('/?at=1,3&y=80&yaw=0.0&pitch=0.0#v1.abc', loc);
    navigateTo('?map#v1.abc', loc);
    expect(loc.assign.mock.calls).toEqual([['/?at=1,3&y=80&yaw=0.0&pitch=0.0#v1.abc'], ['?map#v1.abc']]);
    expect(loc.reload).not.toHaveBeenCalled();
  });
});

describe('the Ctrl+W guard (SP4a spec §7.1)', () => {
  test('beforeunload is prevented while armed; disarm removes the listener', () => {
    const win = new EventTarget();
    const disarm = installLeaveGuard(win as unknown as Window);
    const first = new Event('beforeunload', { cancelable: true });
    win.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    disarm();
    disarm();
    const second = new Event('beforeunload', { cancelable: true });
    win.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  test('"Fullscreen" requests fullscreen, then locks the keyboard when navigator.keyboard exists', async () => {
    const order: string[] = [];
    const doc = { documentElement: { requestFullscreen: () => { order.push('fullscreen'); return Promise.resolve(); } } };
    let locked: readonly string[] | undefined;
    await enterFullscreen(doc, { keyboard: { lock: (keys) => { order.push('lock'); locked = keys; return Promise.resolve(); } } });
    expect(order).toEqual(['fullscreen', 'lock']);
    // Only Ctrl+W, Ctrl+T and Ctrl+N's keys: Esc stays the browser's, so a short Esc frees the mouse (spec §7.1).
    expect(locked).toEqual(['KeyW', 'KeyT', 'KeyN']);
    // Firefox: no Keyboard Lock; a refused fullscreen does not throw either.
    await expect(enterFullscreen(doc, {})).resolves.toBeUndefined();
    await expect(enterFullscreen({ documentElement: { requestFullscreen: () => Promise.reject(new Error('denied')) } }, {})).resolves.toBeUndefined();
  });
});

describe('the world notices (SP4a spec §7.5, §8.5; Review Focus 5)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup() {
    const navigate = vi.fn<(url: string) => void>();
    const disarm = vi.fn();
    const reloader = createReloader(navigate, disarm);
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, reloader);
    return { navigate, disarm, reloader, notices };
  }

  test('webglcontextlost stops the frame loop and shows \'The graphics context was lost\' with a Reload link carrying ?at, y, yaw and pitch of the camera', () => {
    const { navigate, disarm, notices } = setup();
    let lost: (() => void) | null = null;
    const renderer = { onContextLost: (fn: () => void) => { lost = fn; } };
    const camera = { x: 10.6, y: 80.2, z: -3.4, yaw: 45.04, pitch: -10 };
    const stop = vi.fn();
    handleContextLoss(renderer, { stop, notices, hereHref: () => hereUrl(camera, null, '#abc') });
    expect(lost).not.toBeNull();
    expect(() => dom.el('world-context-lost')).toThrow();
    // The camera moved on after the handler was installed: the link carries where it is at the loss.
    camera.x = 200.2;
    lost!();
    expect(stop).toHaveBeenCalledTimes(1);
    const panel = dom.el('world-context-lost');
    expect(panel.textContent).toContain('The graphics context was lost');
    const link = dom.el('world-context-reload');
    expect(link.tagName).toBe('A');
    expect(link.textContent).toBe('Reload');
    expect(link.href).toBe('/?at=200,-3&y=80&yaw=45.0&pitch=-10.0#abc');
    const q = new URLSearchParams(link.href.slice(2, link.href.indexOf('#')));
    expect([q.get('at'), q.get('y'), q.get('yaw'), q.get('pitch')]).toEqual(['200,-3', '80', '45.0', '-10.0']);
    // A second loss event neither stops twice nor adds a second panel.
    lost!();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dom.body.querySelectorAll('div').filter((d: FakeElement) => d.id === 'world-context-lost')).toHaveLength(1);
    // The link reloads through the reloader: the guard is disarmed first, and the default navigation is prevented.
    const click = new Event('click', { cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/?at=200,-3&y=80&yaw=45.0&pitch=-10.0#abc');
  });

  test('the slow-frame notice names the RDs, links to the reload with &rd=, and is dismissible', () => {
    const { navigate, notices } = setup();
    const camera = { x: 1, y: 70, z: 2, yaw: 90, pitch: 0 };
    notices.slow(12, 10, () => hereUrl(camera, 10, '#abc'));
    const panel = dom.el('world-slow-notice');
    expect(panel.textContent).toContain('Frames are slow at RD 12 — try RD 10');
    const link = dom.el('world-slow-link');
    expect(link.href).toBe('/?at=1,2&y=70&yaw=90.0&pitch=0.0&rd=10#abc');
    dom.el('world-slow-dismiss').click();
    expect(() => dom.el('world-slow-notice')).toThrow();
    notices.slow(12, 10, () => hereUrl(camera, 10, '#abc'));
    camera.x = 50;
    dom.el('world-slow-link').click();
    expect(navigate).toHaveBeenCalledWith('/?at=50,2&y=70&yaw=90.0&pitch=0.0&rd=10#abc');
  });
});

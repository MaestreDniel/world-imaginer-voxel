import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { utf8Bytes, type Seed64 } from '../../src/core/hash';
import { base64urlEncode } from '../../src/ui/common/base64url';
import { decodeMapState, DEFAULT_MAP_STATE, encodeMapState } from '../../src/ui/map/mapState';
import { mountStartScreen, startModeOf } from '../../src/ui/world/startScreen';
import { installDom } from './fixtures/domShim';

const query = (url: string) => new URL(url, 'http://localhost/').searchParams;
const random = (): Seed64 => [1, 2];
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('startModeOf (SP4a spec §8.1, D21)', () => {
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

  test('?renderer=mesh alone keeps the start screen', () => {
    expect(startModeOf(query('/?renderer=mesh'))).toBe('start');
  });
});

describe('mountStartScreen (SP4a spec §8.1; rulings P44, P46)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mount(hash: string) {
    const onEnter = vi.fn();
    const loadManifest = vi.fn(() => Promise.resolve<unknown>([]));
    const screen = mountStartScreen(dom.body as unknown as HTMLElement, { hash, onEnter, random, loadManifest, rand: () => 0 });
    return { screen, onEnter, loadManifest };
  }

  test('without a hash: seed 42 and the default profile, both buttons', async () => {
    mount('');
    expect(dom.el('start-title').textContent).not.toBe('');
    expect(dom.el('start-seed').textContent).toContain('42');
    expect(dom.el('start-profile').textContent).toContain('default');
    expect(dom.el('start-enter').textContent).toBe('Enter the world');
    expect(dom.el('start-map').textContent).toBe('Open the map');
    expect(dom.el('start-map').href).toBe('?map');
    expect(dom.el('start-error').hidden).toBe(true);
    expect(dom.el('start-notice').hidden).toBe(true);
    await flush();
  });

  test('with a hash: the hash\'s seed and profile, and the map link carries the hash', async () => {
    const hash = `#${encodeMapState({ ...DEFAULT_MAP_STATE, seed: '1234', profile: 'large_biomes' })}`;
    mount(hash);
    expect(dom.el('start-seed').textContent).toContain('1234');
    expect(dom.el('start-profile').textContent).toContain('large_biomes');
    expect(dom.el('start-map').href).toBe(`?map${hash}`);
    // The same hash given without its '#' (the page may pass location.hash or its text) makes the same link.
    dom.body.replaceChildren();
    mount(hash.slice(1));
    expect(dom.el('start-map').href).toBe(`?map${hash}`);
    await flush();
  });

  test('a bad hash shows the decode error and only "Open the map", which keeps the hash', async () => {
    const hash = '#***';
    mount(hash);
    const error = dom.el('start-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(decodeMapState(hash).error);
    expect(dom.body.querySelector('#start-enter')).toBeNull();
    expect(dom.el('start-map').href).toBe('?map#***');
    await flush();
  });

  test('a hash that passes tier 1 but fails tier 2: the default profile, the notice as a warning, both buttons (P44)', async () => {
    const cycle = { root: { op: 'ref', name: 'a' }, defs: { a: { op: 'ref', name: 'b' }, b: { op: 'ref', name: 'a' } } };
    const hash = `#${base64urlEncode(utf8Bytes(JSON.stringify({ ...DEFAULT_MAP_STATE, profile: 'large_biomes', patch: { density: { defs: cycle } } })))}`;
    expect(decodeMapState(hash).error).toBeNull();
    mount(hash);
    expect(dom.el('start-profile').textContent).toContain('default');
    expect(dom.el('start-profile').textContent).not.toContain('large_biomes');
    const notice = dom.el('start-notice');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toMatch(/^invalid patch \(.*\); opened the default profile with no changes$/);
    expect(dom.el('start-enter').textContent).toBe('Enter the world');
    expect(dom.el('start-map').href).toBe(`?map${hash}`);
    await flush();
  });

  test('a second click on Enter the world (or a double-click) calls onEnter once; the buttons are disabled after the first', async () => {
    const { onEnter } = mount('');
    const enter = dom.el('start-enter');
    const map = dom.el('start-map');
    enter.click();
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(enter.disabled).toBe(true);
    expect(map.getAttribute('aria-disabled')).toBe('true');
    expect(map.href).toBe('');
    // A second click, even one that reaches the listener (the second event of a double-click), does nothing.
    enter.click();
    enter.dispatchEvent(new Event('click'));
    enter.dispatchEvent(new Event('click'));
    expect(onEnter).toHaveBeenCalledTimes(1);
    // The map link no longer navigates.
    const e = new Event('click', { cancelable: true });
    map.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await flush();
  });

  test('the start screen shows the loading screen\'s background: the gradient, and the manifest is read once', async () => {
    const { loadManifest } = mount('');
    expect(dom.el('start-screen-backdrop').style.background).toContain('#3D78D6');
    await flush();
    expect(loadManifest).toHaveBeenCalledTimes(1);
  });

  test('dispose removes the screen', async () => {
    const { screen } = mount('');
    screen.dispose();
    expect(dom.body.querySelector('#start-screen')).toBeNull();
    await flush();
  });
});

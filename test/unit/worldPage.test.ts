import { readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../src/engine/capabilityRules';
import type { StreamEvent } from '../../src/engine/coordinator';
import { lowerRd } from '../../src/engine/renderDistance';
import { WorldSession, type SessionListener } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import { DEFAULT_KEYMAP } from '../../src/player/keymap';
import { applyRenderDistance, cameraFar } from '../../src/render/renderer';
import { mountHelp } from '../../src/ui/help';
import type { DriverStatus } from '../../src/ui/map/previewDriver';
import { SETTINGS_DEFAULTS, type WorldSettings } from '../../src/ui/settings';
import { StoreCorrupt } from '../../src/world/store/pool';
import { createBenchDriver } from '../../src/ui/world/bench';
import { createFogEase } from '../../src/ui/world/fogEase';
import { createNotices } from '../../src/ui/common/notice';
import { URL_HASH_MAX, URL_OVERSIZE_NOTICE, createUrlWriter, oversizeNotice } from '../../src/ui/common/urlWriter';
import { DEFAULT_MAP_STATE, decodeMapState, openMapSession, type MapView } from '../../src/ui/map/mapState';
import { WORLD_MAP_BPP, worldMapView } from '../../src/ui/world/mapOverlay';
import { createReloader, createWorldUrl, worldHash, type HereState } from '../../src/ui/world/reload';
import {
  countPendingTimers, countTileCalls, createRdControl, createUndoNotice, createWorldNotices, everyFrameUntil, failBeforeReveal, flushOnPageHide, handleContextLoss,
  handleStreamEvent, helpChange, installWiTest, offerLowerRd, onDriverStatus, rdShownOnLoad, releaseOnFailure, reloadRd, runTeardown, stopAfterFailure, UNDO_NOTICE_MS,
  type WiTest, type WiTestPage,
} from '../../src/ui/world/worldPage';
import { installDom, type FakeElement } from './fixtures/domShim';

/** A frame scheduler that queues callbacks; `flush` runs one frame. */
function frames() {
  const queue: Array<() => void> = [];
  return {
    request: (cb: () => void): void => { queue.push(cb); },
    pending: () => queue.length,
    flush: (): void => { queue.shift()?.(); },
  };
}

describe('everyFrameUntil (the load build loop, SP4a spec §8.3)', () => {
  test('calls the step once per frame and resolves when it returns true', async () => {
    const f = frames();
    let calls = 0;
    const done = everyFrameUntil(f.request, () => ++calls === 3);
    expect(calls).toBe(0);
    f.flush();
    f.flush();
    expect(calls).toBe(2);
    f.flush();
    await expect(done).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(f.pending()).toBe(0);
  });

  test('a throwing step rejects with its error and requests no further frame', async () => {
    const f = frames();
    const boom = new Error('addGeometry: the batch is full');
    let calls = 0;
    const done = everyFrameUntil(f.request, () => {
      calls++;
      if (calls === 2) throw boom;
      return false;
    });
    f.flush();
    f.flush();
    await expect(done).rejects.toBe(boom);
    expect(f.pending()).toBe(0);
  });
});

describe('releaseOnFailure (the failure panel frees the load, final review B-M4)', () => {
  test('disconnects the long-task observer, terminates the pool and disposes the renderer, each once', () => {
    const longTasks = { disconnect: vi.fn() };
    const pool = { terminate: vi.fn() };
    const renderer = { dispose: vi.fn() };
    releaseOnFailure({ longTasks, pool, renderer }, (e) => { throw e; });
    expect(longTasks.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.terminate).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  test('a failure before the pool or the renderer exists releases what there is', () => {
    expect(() => releaseOnFailure({ longTasks: null, pool: null, renderer: null }, (e) => { throw e; })).not.toThrow();
  });

  test('each release is guarded: a pool whose terminate throws still has the renderer disposed, and the error is reported (final review UI-6)', () => {
    const boom = new Error('terminate failed');
    const renderer = { dispose: vi.fn() };
    const onError = vi.fn<(e: unknown) => void>();
    releaseOnFailure({ longTasks: { disconnect: () => { throw new Error('observer'); } }, pool: { terminate: () => { throw boom; } }, renderer }, onError);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1]![0]).toBe(boom);
  });
});

describe('reloadRd (the reloads after the reveal: the failure panel\'s and the context loss\'s, final review UI-3)', () => {
  test('without a query rd the setting applies (null); a query rd is replaced by the RD in force', () => {
    expect(reloadRd(null, 10)).toBeNull();
    // The loading screen's "lower RD" link opened /?rd=6 after a StoreFull at 8: the Reload keeps 6, not the failed 8.
    expect(reloadRd(6, 6)).toBe(6);
    // Changed live to 10 since the load: the reload keeps 10.
    expect(reloadRd(6, 10)).toBe(10);
  });
});

describe('failBeforeReveal (a failure before the reveal, SP4a spec §8.3; final review UI-6)', () => {
  test('the loading screen\'s panel shows first, then the releases, then the page settles; a release that throws hides nothing', () => {
    const order: string[] = [];
    const onError = vi.fn<(e: unknown) => void>();
    const lost = new Error('the renderer\'s context is gone');
    failBeforeReveal({
      show: () => { order.push('panel'); },
      release: {
        longTasks: { disconnect: () => { order.push('longTasks'); } },
        pool: { terminate: () => { order.push('pool.terminate'); } },
        renderer: { dispose: () => { order.push('renderer.dispose'); throw lost; } },
      },
      settle: () => { order.push('settle'); },
      onError,
    });
    expect(order).toEqual(['panel', 'longTasks', 'pool.terminate', 'renderer.dispose', 'settle']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(lost);
  });

  test('a panel that throws still releases the load and settles', () => {
    const order: string[] = [];
    const onError = vi.fn<(e: unknown) => void>();
    failBeforeReveal({
      show: () => { throw new Error('no host'); },
      release: { longTasks: null, pool: { terminate: () => { order.push('pool'); } }, renderer: { dispose: () => { order.push('renderer'); } } },
      settle: () => { order.push('settle'); },
      onError,
    });
    expect(order).toEqual(['pool', 'renderer', 'settle']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('runTeardown (the page\'s dispose, rulings R5 (b))', () => {
  test('a StoreCorrupt from the coordinator\'s dispose skips none of the later steps; each error is reported', () => {
    const order: string[] = [];
    const corrupt = new StoreCorrupt('the pool lock is held by dead thread 2');
    const onError = vi.fn<(e: unknown) => void>();
    runTeardown([
      () => { order.push('input'); },
      () => { order.push('coordinator'); throw corrupt; },
      () => { order.push('loading.dispose'); },
      () => { order.push('renderer.dispose'); throw new Error('lost context'); },
      () => { order.push('pool.terminate'); },
      () => { order.push('root.replaceChildren'); },
    ], onError);
    expect(order).toEqual(['input', 'coordinator', 'loading.dispose', 'renderer.dispose', 'pool.terminate', 'root.replaceChildren']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![0]).toBe(corrupt);
  });
});

describe('stopAfterFailure (a failure after the reveal, SP4b spec §7.4; Task 21 review M2)', () => {
  test('the loop stops first, the panel shows next, then every release step runs; a release that throws hides nothing', () => {
    const order: string[] = [];
    const onError = vi.fn<(e: unknown) => void>();
    const lost = new Error('the renderer\'s context is gone');
    stopAfterFailure({
      stop: () => { order.push('stop'); },
      show: () => { order.push('panel'); },
      release: [
        () => { order.push('hud'); },
        () => { order.push('coordinator'); throw new StoreCorrupt('the pool lock is held by dead thread 2'); },
        () => { order.push('pool.terminate'); },
        () => { order.push('renderer.dispose'); throw lost; },
      ],
      onError,
    });
    expect(order).toEqual(['stop', 'panel', 'hud', 'coordinator', 'pool.terminate', 'renderer.dispose']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1]![0]).toBe(lost);
  });

  test('a panel that throws still releases the workers and the renderer', () => {
    const released: string[] = [];
    const onError = vi.fn<(e: unknown) => void>();
    stopAfterFailure({
      stop: () => {},
      show: () => { throw new Error('no host'); },
      release: [() => { released.push('pool'); }, () => { released.push('renderer'); }],
      onError,
    });
    expect(released).toEqual(['pool', 'renderer']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('the map overlay draws with the frame step\'s live state (SP4c spec §2.2; Task 16 review I1)', () => {
  // The page's post-reveal wiring cannot be mounted in the unit project, so its source is pinned: the warm-up helper
  // `frameState()` rewrites `frame.t` with the opening time and `eyeSky` with the raw sky light, so passing it to the
  // overlay would rewind the day/night clock at every mode-B layout change and bypass D13's eye light.
  test('createMapOverlay gets `frameState: () => frame`, not the pre-reveal helper', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    const start = src.indexOf('createMapOverlay({');
    expect(start).toBeGreaterThan(-1);
    const args = src.slice(start, src.indexOf('\n    });', start));
    expect(args).toMatch(/^\s*frameState: \(\) => frame,$/m);
    expect(args).not.toMatch(/^\s*frameState,$/m);
  });
});

describe('the map overlay on a fatal error or a context loss (SP4c spec §1.3, §2.1, D27)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** An open overlay whose dispose records whether a failure panel or the context-loss notice was already shown. */
  const openOverlay = (order: string[]) => ({
    shown: true,
    dispose: vi.fn(() => {
      order.push(`overlay.dispose (panel shown: ${dom.document.getElementById('world-failed') !== null || dom.document.getElementById('world-context-lost') !== null})`);
    }),
  });

  test('a fatal with the overlay open disposes it before the failure panel shows', () => {
    const order: string[] = [];
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const overlay = openOverlay(order);
    stopAfterFailure({
      stop: () => { order.push('stop'); },
      closeMap: () => overlay.dispose(),
      show: () => {
        notices.failed('Streaming stopped: x', 'details', '/?at=0,0');
        order.push('panel');
      },
      release: [() => { order.push('pool.terminate'); }],
      onError: () => {},
    });
    expect(order).toEqual(['stop', 'overlay.dispose (panel shown: false)', 'panel', 'pool.terminate']);
    expect(overlay.dispose).toHaveBeenCalledTimes(1);
  });

  test('an overlay whose dispose throws still lets the failure panel show and the releases run', () => {
    const order: string[] = [];
    const onError = vi.fn<(e: unknown) => void>();
    stopAfterFailure({
      stop: () => {},
      closeMap: () => { throw new Error('the tool\'s dispose failed'); },
      show: () => { order.push('panel'); },
      release: [() => { order.push('pool.terminate'); }],
      onError,
    });
    expect(order).toEqual(['panel', 'pool.terminate']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('the same for a context loss: the loop stops, the overlay is disposed, then the notice shows; a second loss does nothing', () => {
    const order: string[] = [];
    let lost: (() => void) | null = null;
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const overlay = openOverlay(order);
    const onError = vi.fn<(e: unknown) => void>();
    handleContextLoss({ onContextLost: (fn) => { lost = fn; } }, {
      stop: () => { order.push('stop'); },
      closeMap: () => overlay.dispose(),
      notices,
      hereHref: () => { order.push('href'); return '/?at=1,2'; },
      onError,
    });
    expect(order).toEqual([]);
    lost!();
    expect(order).toEqual(['stop', 'overlay.dispose (panel shown: false)', 'href']);
    expect(dom.el('world-context-lost').textContent).toContain('The graphics context was lost');
    lost!();
    expect(overlay.dispose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('a context loss whose overlay dispose throws still shows the notice', () => {
    let lost: (() => void) | null = null;
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const onError = vi.fn<(e: unknown) => void>();
    handleContextLoss({ onContextLost: (fn) => { lost = fn; } }, {
      stop: () => {},
      closeMap: () => { throw new Error('the tool\'s dispose failed'); },
      notices,
      hereHref: () => '/?at=1,2',
      onError,
    });
    lost!();
    expect(dom.el('world-context-lost').textContent).toContain('The graphics context was lost');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('handleStreamEvent (SP4b spec §3.6, §7.4, D12)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup() {
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const fail = vi.fn<(cause: string, e: unknown) => void>();
    const lower = vi.fn<(rd: number) => void>();
    return { notices, fail, lower, o: { notices, fail, lower } };
  }
  const byId = (id: string): FakeElement[] => dom.body.querySelectorAll('div').filter((d: FakeElement) => d.id === id);

  test('a fatal stream event calls fail with its message and cause', () => {
    const { fail, o } = setup();
    const cause = new StoreCorrupt('the pool lock is held by dead thread 2');
    handleStreamEvent({ kind: 'fatal', message: 'MESH at (3, 4) failed: StoreCorrupt', cause }, o);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]![0]).toContain('MESH at (3, 4) failed: StoreCorrupt');
    expect(fail.mock.calls[0]![1]).toBe(cause);
    expect(dom.body.textContent).toBe('');
  });

  test('a skipped event shows one dismissible notice with Copy details (a second skipped shows nothing new)', () => {
    const { fail, lower, o } = setup();
    const skipped: StreamEvent = { kind: 'skipped', cx: -7, cz: 12 };
    handleStreamEvent(skipped, o);
    const panel = dom.el('world-skipped-notice');
    expect(panel.textContent).toContain('Some terrain could not be generated');
    expect(dom.el('world-skipped-copy').textContent).toBe('Copy details');
    handleStreamEvent({ kind: 'skipped', cx: 1, cz: 1 }, o);
    expect(byId('world-skipped-notice')).toHaveLength(1);
    dom.el('world-skipped-dismiss').click();
    expect(byId('world-skipped-notice')).toHaveLength(0);
    // Shown once: a later skipped column after the dismissal shows nothing either.
    handleStreamEvent({ kind: 'skipped', cx: 2, cz: 2 }, o);
    expect(byId('world-skipped-notice')).toHaveLength(0);
    expect(fail).not.toHaveBeenCalled();
    expect(lower).not.toHaveBeenCalled();
  });

  test('the skipped notice\'s Copy details copies the column it names', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { o } = setup();
    handleStreamEvent({ kind: 'skipped', cx: -7, cz: 12 }, o);
    dom.el('world-skipped-copy').click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('(-7, 12)');
    await Promise.resolve();
    expect(dom.el('world-skipped-copy').textContent).toBe('Copied');
  });

  test('a storeFull event with lowerRd 10 shows the notice whose button calls lower(10); with lowerRd null, no button', () => {
    const { fail, lower, o } = setup();
    handleStreamEvent({ kind: 'storeFull', lowerRd: 10 }, o);
    const panel = dom.el('world-store-full');
    expect(panel.textContent).toContain('The world store is full');
    const button = dom.el('world-store-full-lower');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Lower to RD 10');
    button.click();
    expect(lower).toHaveBeenCalledTimes(1);
    expect(lower).toHaveBeenCalledWith(10);
    expect(fail).not.toHaveBeenCalled();
    // A second pause replaces the notice rather than stacking one more.
    handleStreamEvent({ kind: 'storeFull', lowerRd: null }, o);
    expect(byId('world-store-full')).toHaveLength(1);
    expect(() => dom.el('world-store-full-lower')).toThrow();
    expect(dom.el('world-store-full-dismiss').textContent).toBe('Dismiss');
    dom.el('world-store-full-dismiss').click();
    expect(byId('world-store-full')).toHaveLength(0);
  });
});

describe('createRdControl (SP4b spec §5, D18; Review Focus 5)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const MIB = 1 << 20;
  const REPORT: CapabilityReport = {
    secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
    growableSab: true, reservation: { blockBytes: 768 * MIB, byteBytes: 512 * MIB },
    webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
    renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
  };

  /**
   * The control over fakes at RD `rd`: the coordinator and the help record their calls, the world's
   * `setRenderDistance` is Task 18's `applyRenderDistance` on a real camera, the fog is the real easing, and `save`
   * records what the page would store. A navigation would go through `location.assign` (stubbed to record it).
   */
  function rig(rd = 8, help: { setRd(rd: number | null): void } = { setRd: vi.fn() }) {
    const coordinator = { setRenderDistance: vi.fn<(rd: number) => void>() };
    const camera = new PerspectiveCamera(70, 16 / 9, 0.1, cameraFar(rd));
    const world = { camera, setRenderDistance: vi.fn((r: number) => applyRenderDistance(camera, r)) };
    const fog = createFogEase(rd);
    const saved: Array<number | null> = [];
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: '/' });
    const control = createRdControl({ coordinator, world, fog, help, save: (r) => { saved.push(r); }, defaultRd: 12 });
    return { control, coordinator, world, camera, fog, saved, help, assign };
  }

  test('apply(10) applies live: coordinator.setRenderDistance(10), world.setRenderDistance(10), fog target 10, saved 10, no navigation, and camera.far 288', () => {
    const r = rig(8);
    r.control.apply(10);
    expect(r.coordinator.setRenderDistance).toHaveBeenCalledTimes(1);
    expect(r.coordinator.setRenderDistance).toHaveBeenLastCalledWith(10);
    expect(r.world.setRenderDistance).toHaveBeenCalledTimes(1);
    expect(r.world.setRenderDistance).toHaveBeenLastCalledWith(10);
    expect(r.fog.target).toBe(10);
    expect(r.saved).toEqual([10]);
    expect(r.help.setRd).toHaveBeenLastCalledWith(10);
    expect(r.assign).not.toHaveBeenCalled();
    expect(r.camera.far).toBe(288);
  });

  test('apply(null) after RD 8 applies the default 12 and saves null', () => {
    const r = rig(8);
    r.control.apply(null);
    expect(r.coordinator.setRenderDistance).toHaveBeenLastCalledWith(12);
    expect(r.world.setRenderDistance).toHaveBeenLastCalledWith(12);
    expect(r.fog.target).toBe(12);
    expect(r.saved).toEqual([null]);
    expect(r.help.setRd).toHaveBeenLastCalledWith(null);
    expect(r.camera.far).toBe(cameraFar(12));
  });

  test('apply(12) then apply(10) before the fog settles: the last setRenderDistance on the coordinator and the world is 10, and camera.far is 288', () => {
    const r = rig(8);
    r.control.apply(12);
    expect(r.camera.far).toBe(cameraFar(12));
    // 30 frames into the easing (the fog end at 128 of 176).
    let fogRd = 8;
    for (let i = 0; i < 30; i++) fogRd = r.fog.step(16.667, 12);
    expect((fogRd - 1) * 16).toBeCloseTo(128, 2);
    r.control.apply(10);
    expect(r.coordinator.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([12, 10]);
    expect(r.world.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([12, 10]);
    expect(r.fog.target).toBe(10);
    expect(r.camera.far).toBe(288);
    expect(r.saved).toEqual([12, 10]);
    // The fog stays where it is and eases on to the new end (fogEase.test.ts pins the frames).
    expect(r.fog.step(0, 12)).toBe(fogRd);
    for (let i = 0; i < 60; i++) fogRd = r.fog.step(16.667, 12);
    expect((fogRd - 1) * 16).toBe(144);
  });

  test('the bench under a reservation cap of 10: coordinator.setRenderDistance never sees an RD above 10 over the whole script (Task 26b, review M3)', () => {
    const r = rig(10);
    // The coordinator throws above its rdMax, as the real one does (`setRenderDistance`'s RangeError).
    r.coordinator.setRenderDistance.mockImplementation((rd) => {
      if (rd > 10) throw new RangeError(`rd ${rd} above rdMax 10`);
    });
    const driver = createBenchDriver({ shot: null, capacity: 64, publish: { result() {}, shotReady() {} } });
    // The live legs settle at once (L7-L9 run one frame each), at the cap like the timed script.
    driver.bind({ rdMax: 10, heightAt: () => null, live: { set() {}, undo() {}, teleport: () => Promise.resolve(true), settled: () => true } });
    // The page's loop: the script's RD applied through the control when it differs from the live one.
    let liveRd = 10;
    const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    for (let t = 0; ; t += 1 / 60) {
      const want = driver.pose(t, pose, liveRd);
      if (want === null) break;
      if (want !== liveRd) {
        r.control.apply(want);
        liveRd = want;
      }
    }
    expect(r.coordinator.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([8, 10]);
    expect(driver.rdClampedTo).toBe(10);
    expect(r.camera.far).toBe(cameraFar(10));
  });

  test('the slow notice\'s action lowers the RD live to lowerRd(rd)', () => {
    const navigate = vi.fn<(url: string) => void>();
    const disarm = vi.fn();
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(navigate, disarm));
    const r = rig(12);
    offerLowerRd(notices, 12, r.control);
    expect(dom.el('world-slow-notice').textContent).toContain('Frames are slow at RD 12');
    const button = dom.el('world-slow-lower');
    expect(button.textContent).toBe(`Lower to RD ${lowerRd(12)}`);
    // Never automatic: nothing applies before the click.
    expect(r.coordinator.setRenderDistance).not.toHaveBeenCalled();
    button.click();
    expect(r.coordinator.setRenderDistance).toHaveBeenCalledTimes(1);
    expect(r.coordinator.setRenderDistance).toHaveBeenLastCalledWith(10);
    expect(r.world.setRenderDistance).toHaveBeenLastCalledWith(10);
    expect(r.fog.target).toBe(10);
    expect(r.saved).toEqual([10]);
    expect(r.camera.far).toBe(288);
    expect(navigate).not.toHaveBeenCalled();
    expect(disarm).not.toHaveBeenCalled();
    // At RD 4 there is no lower RD: no notice.
    dom.body.replaceChildren();
    const at4 = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(navigate, disarm));
    offerLowerRd(at4, 4, r.control);
    expect(() => dom.el('world-slow-notice')).toThrow();
  });

  test('after the slow notice lowers 12 → 10, changing the FOV in the help keeps RD 10 (no setRenderDistance(12)) and #setting-rd shows 10', () => {
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    // The page's settings as it keeps them: `save` writes the rd, and its onSettings applies an rd that differs.
    let page: WorldSettings = { ...SETTINGS_DEFAULTS, rd: 12 };
    let control: { apply(rd: number | null): void } | null = null;
    const help = mountHelp(dom.body as unknown as HTMLElement, {
      map: DEFAULT_KEYMAP,
      settings: page,
      onSettings: (s) => {
        const rdChanged = s.rd !== page.rd;
        page = s;
        if (rdChanged) control!.apply(s.rd);
      },
      report: REPORT,
      evaluation: evaluateWorldCapabilities(REPORT),
      rdMax: 16,
      openMap: () => {},
      onFullscreen: () => {},
      onClose: () => {},
    });
    const r = rig(12, help);
    control = createRdControl({
      coordinator: r.coordinator, world: r.world, fog: r.fog, help,
      save: (rd) => { page = { ...page, rd }; }, defaultRd: 12,
    });
    expect(dom.el('setting-rd').value).toBe('12');
    offerLowerRd(notices, 12, control);
    dom.el('world-slow-lower').click();
    expect(r.coordinator.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([10]);
    expect(dom.el('setting-rd').value).toBe('10');
    const fov = dom.el('setting-fov');
    fov.value = '90';
    fov.dispatchEvent(new Event('input'));
    expect(page.fov).toBe(90);
    expect(page.rd).toBe(10);
    expect(r.coordinator.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([10]);
    expect(r.world.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([10]);
    expect(dom.el('setting-rd').value).toBe('10');
    expect(r.camera.far).toBe(288);
    // The help's select itself applies live too.
    const rd = dom.el('setting-rd');
    rd.value = '14';
    rd.dispatchEvent(new Event('change'));
    expect(r.coordinator.setRenderDistance).toHaveBeenLastCalledWith(14);
    expect(page.rd).toBe(14);
  });

  describe('the help\'s RD select shows the RD in force (rulings R8)', () => {
    test('on load: the URL\'s RD on a ?rd= load, else the saved setting (null: Default)', () => {
      expect(rdShownOnLoad(4, 4, 6)).toBe(4);
      expect(rdShownOnLoad(4, 4, null)).toBe(4);
      expect(rdShownOnLoad(null, 6, 6)).toBe(6);
      expect(rdShownOnLoad(null, 12, null)).toBeNull();
    });

    test('a help change keeps the saved rd unless the rd differs from the RD in force', () => {
      const saved: WorldSettings = { ...SETTINGS_DEFAULTS, rd: 6 };
      // A FOV change from a help showing RD 4: saved with rd 6 kept, no rd applied.
      expect(helpChange(saved, { ...saved, rd: 4, fov: 90 }, 4)).toEqual({ settings: { ...saved, fov: 90 }, applyRd: false });
      // The saved value, different from the RD in force, applies.
      expect(helpChange(saved, { ...saved, rd: 6 }, 4)).toEqual({ settings: saved, applyRd: true });
      expect(helpChange(saved, { ...saved, rd: null }, 4).applyRd).toBe(true);
      // The RD in force is a no-op.
      expect(helpChange(saved, { ...saved, rd: 4 }, 4)).toEqual({ settings: saved, applyRd: false });
    });

    test('?rd=4 with 6 saved: #setting-rd shows 4; a FOV change keeps 6 saved; choosing 4 is a no-op; choosing 6 applies RD 6 live and saves it', () => {
      // The page's wiring: the help gets the RD in force, its onSettings goes through helpChange, and the RD control's
      // help tracks what the select shows.
      let page: WorldSettings = { ...SETTINGS_DEFAULTS, rd: 6 };
      let shown = rdShownOnLoad(4, 4, page.rd);
      const stored: WorldSettings[] = [];
      let control: { apply(rd: number | null): void } | null = null;
      const help = mountHelp(dom.body as unknown as HTMLElement, {
        map: DEFAULT_KEYMAP,
        settings: { ...page, rd: shown },
        onSettings: (s) => {
          const c = helpChange(page, s, shown);
          page = c.settings;
          stored.push(page);
          if (c.applyRd) control!.apply(s.rd);
        },
        report: REPORT,
        evaluation: evaluateWorldCapabilities(REPORT),
        rdMax: 16,
        openMap: () => {},
        onFullscreen: () => {},
        onClose: () => {},
      });
      const r = rig(4);
      control = createRdControl({
        coordinator: r.coordinator, world: r.world, fog: r.fog,
        help: { setRd: (v) => { shown = v; help.setRd(v); } },
        save: (v) => { page = { ...page, rd: v }; stored.push(page); }, defaultRd: 12,
      });
      const select = dom.el('setting-rd');
      expect(select.value).toBe('4');
      const fov = dom.el('setting-fov');
      fov.value = '90';
      fov.dispatchEvent(new Event('input'));
      expect(stored.at(-1)).toEqual({ ...SETTINGS_DEFAULTS, rd: 6, fov: 90 });
      expect(select.value).toBe('4');
      select.value = '4';
      select.dispatchEvent(new Event('change'));
      expect(r.coordinator.setRenderDistance).not.toHaveBeenCalled();
      expect(stored.at(-1)!.rd).toBe(6);
      select.value = '6';
      select.dispatchEvent(new Event('change'));
      expect(r.coordinator.setRenderDistance.mock.calls.map((c) => c[0])).toEqual([6]);
      expect(r.world.setRenderDistance).toHaveBeenLastCalledWith(6);
      expect(r.fog.target).toBe(6);
      expect(stored.at(-1)).toEqual({ ...SETTINGS_DEFAULTS, rd: 6, fov: 90 });
      expect(select.value).toBe('6');
      expect(shown).toBe(6);
      expect(r.assign).not.toHaveBeenCalled();
    });

    test('after the mode switch to split, a FOV change from the help keeps mapMode: \'split\' and watchLive: false (SP4c spec §2.5)', () => {
      // The help's copy of the settings is the one it saw at mount (full, watching live); the map's header changes the
      // saved settings afterwards, and the help has no control for either field.
      let page: WorldSettings = { ...SETTINGS_DEFAULTS };
      const stored: WorldSettings[] = [];
      mountHelp(dom.body as unknown as HTMLElement, {
        map: DEFAULT_KEYMAP,
        settings: page,
        onSettings: (s) => {
          page = helpChange(page, s, null).settings;
          stored.push(page);
        },
        report: REPORT,
        evaluation: evaluateWorldCapabilities(REPORT),
        rdMax: 16,
        openMap: () => {},
        onFullscreen: () => {},
        onClose: () => {},
      });
      // The mode switch and the Watch live checkbox (the overlay's header) save at once.
      page = { ...page, mapMode: 'split', watchLive: false };
      const fov = dom.el('setting-fov');
      fov.value = '90';
      fov.dispatchEvent(new Event('input'));
      expect(stored.at(-1)).toEqual({ ...SETTINGS_DEFAULTS, fov: 90, mapMode: 'split', watchLive: false });
      expect(helpChange(page, { ...page, mapMode: 'full', watchLive: true, fov: 80 }, null).settings)
        .toEqual({ ...SETTINGS_DEFAULTS, fov: 80, mapMode: 'split', watchLive: false });
    });
  });
});

describe('onDriverStatus (the configure driver after the reveal, SP4c spec §4.3)', () => {
  const status = (error: string | null): DriverStatus => ({
    lastLatencyMs: null, pending: false, queued: false, settled: true, poolEpoch: 3, sessionEpoch: 2, error,
  });

  test('a status with an error calls fail (the failure panel with Copy details); a status without one calls nothing', () => {
    const failed: Array<[string, unknown]> = [];
    const fail = (cause: string, e: unknown): void => { failed.push([cause, e]); };
    onDriverStatus(status(null), fail);
    onDriverStatus({ ...status(null), pending: true, queued: true }, fail);
    expect(failed).toEqual([]);
    onDriverStatus(status('BAD_PARAMS: density.defs refused'), fail);
    expect(failed).toHaveLength(1);
    expect(failed[0]![0]).toContain('BAD_PARAMS: density.defs refused');
    expect(failed[0]![1]).toBeInstanceOf(Error);
    expect((failed[0]![1] as Error).message).toBe('BAD_PARAMS: density.defs refused');
  });

  test('rulings R3: a spawn error (the map\'s spawn-marker query) does not stop the world; a configure error, WorkerFailed included, still does', () => {
    const failed: Array<[string, unknown]> = [];
    const fail = (cause: string, e: unknown): void => { failed.push([cause, e]); };
    onDriverStatus(status('spawn: worker 2 died'), fail);
    onDriverStatus({ ...status('spawn: JOB_FAILED: no land'), pending: true }, fail);
    expect(failed).toEqual([]);
    onDriverStatus(status('worker 3 died'), fail);
    expect(failed).toHaveLength(1);
    expect(failed[0]![0]).toBe('Live editing stopped: worker 3 died');
  });
});

describe('the world\'s URL (createWorldUrl, SP4c spec §1.6, D20)', () => {
  /** The page's URL rules on fakes: a real session, the camera, a recording writer and a location. */
  function rig(search = '?rd=8&renderer=mesh') {
    const session = openMapSession(DEFAULT_MAP_STATE, () => [1, 2]);
    const camera: HereState & { x: number; y: number; z: number } = { x: 100.4, y: 90, z: -40.2, yaw: 30, pitch: -10 };
    let tool: { view: MapView } | null = null;
    const written: string[] = [];
    const url = createWorldUrl({
      session,
      // The page's view: the tool's, or camera-centred before the first M.
      view: () => worldMapView(tool, camera),
      camera,
      writer: { set: (u) => { written.push(u); } },
      loc: { pathname: '/', search },
    });
    const hashOf = (u: string) => decodeMapState(u.slice(u.indexOf('#')));
    const searchOf = (u: string) => u.slice(u.indexOf('?'), u.indexOf('#'));
    return { session, camera, written, url, hashOf, searchOf, mount: (v: MapView) => { tool = { view: v }; }, setView: (v: MapView) => { tool = { view: v }; } };
  }

  test('after an Apply of `density.detailAmpHi` 4.0, `here()` (the context-loss Reload\'s href) decodes to the edited patch', () => {
    const r = rig();
    // The hash the page was loaded with carries no patch.
    expect(r.hashOf(r.url.here(null)).state.patch).toEqual({});
    expect(r.session.set('density.detailAmpHi', 4.0).ok).toBe(true);
    r.url.applied();
    const href = r.url.here(null);
    const decoded = r.hashOf(href);
    expect(decoded.error).toBeNull();
    expect(decoded.state.patch).toEqual({ density: { detailAmpHi: 4 } });
    expect(decoded.state.seed).toBe('42');
    // Around the camera now, in hereUrl's format, with the RD the Reload passes.
    expect(href.slice(0, href.indexOf('#'))).toBe('/?at=100,-40&y=90&yaw=30.0&pitch=-10.0');
    r.camera.x = 600;
    expect(r.url.here(10).slice(0, r.url.here(10).indexOf('#'))).toBe('/?at=600,-40&y=90&yaw=30.0&pitch=-10.0&rd=10');
  });

  test('the URL written after the Apply is `pathname + search + \'#\' + hash`, never `?map`', () => {
    const r = rig();
    r.session.set('density.detailAmpHi', 4.0);
    r.url.applied();
    expect(r.written).toEqual([`/?rd=8&renderer=mesh#${worldHash(r.session, worldMapView(null, r.camera))}`]);
    expect(r.written[0]).not.toContain('map#');
    expect(new URLSearchParams(r.searchOf(r.written[0]!)).has('map')).toBe(false);
    // No search at all (entered from the start screen): the path and the hash.
    const bare = rig('');
    bare.url.applied();
    expect(bare.written[0]).toBe(`/#${worldHash(bare.session, worldMapView(null, bare.camera))}`);
  });

  test('`viewChanged` writes the new view in the hash', () => {
    const r = rig();
    const v: MapView = { x: 2048, z: -512, bpp: 16, layer: 'relief' };
    r.mount(v);
    r.url.viewChanged();
    expect(r.hashOf(r.written.at(-1)!).state.view).toEqual(v);
    r.setView({ ...v, x: 4096, bpp: 0.5 });
    r.url.viewChanged();
    expect(r.hashOf(r.written.at(-1)!).state.view).toEqual({ ...v, x: 4096, bpp: 0.5 });
    expect(r.written).toHaveLength(2);
  });

  test('before the first M the hash\'s view is centred on the camera at 4 blocks/px', () => {
    const r = rig();
    r.camera.x = 300;
    r.camera.z = -75;
    r.url.applied();
    expect(WORLD_MAP_BPP).toBe(4);
    expect(r.hashOf(r.written[0]!).state.view).toEqual({ x: 300, z: -75, bpp: 4, layer: DEFAULT_MAP_STATE.view.layer });
    // A camera past the hash's window (±524,288) is clamped to ±500,000, so the reload still decodes.
    r.camera.x = 600_000;
    r.camera.z = -600_000;
    r.url.applied();
    const far = r.hashOf(r.written[1]!);
    expect(far.error).toBeNull();
    expect([far.state.view.x, far.state.view.z]).toEqual([500_000, -500_000]);
  });

  test('`arrived` rewrites the search\'s `at` to the arrival, and nothing else does (a flight of 500 blocks does not)', () => {
    const r = rig('?at=0,0&y=80&yaw=0.0&pitch=0.0&rd=8');
    // A flight of 500 blocks, then an Apply and a view change: the search is the one the page was loaded with.
    r.camera.x += 500;
    r.url.applied();
    r.url.viewChanged();
    expect(r.written.map(r.searchOf)).toEqual(['?at=0,0&y=80&yaw=0.0&pitch=0.0&rd=8', '?at=0,0&y=80&yaw=0.0&pitch=0.0&rd=8']);
    // A teleport arrives: the URL is written with the arrival's place, rd kept in place.
    r.url.arrived({ x: 1000.5, y: 110, z: -2000.5, yaw: 45, pitch: -5 });
    expect(r.searchOf(r.written.at(-1)!)).toBe('?at=1001,-2000&y=110&yaw=45.0&pitch=-5.0&rd=8');
    // Flying on and applying again keeps the teleport's place, so F5 returns there.
    r.camera.x += 500;
    r.url.applied();
    expect(r.searchOf(r.written.at(-1)!)).toBe('?at=1001,-2000&y=110&yaw=45.0&pitch=-5.0&rd=8');
    expect(r.written).toHaveLength(4);
  });

  describe('the URL-oversize notice in the world', () => {
    let dom: ReturnType<typeof installDom>;
    beforeEach(() => { dom = installDom(); });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    const rows = () => dom.el('world-notices').querySelectorAll('div');

    test('`oversizeNotice(worldNotices)` shows and hides its notice in `.world-notices`', () => {
      const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
      expect(dom.el('world-notices').className).toBe('world-notices');
      const onOversize = oversizeNotice(notices);
      onOversize(true);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.textContent).toContain(URL_OVERSIZE_NOTICE);
      // Shown again with the same text: replaced, not repeated.
      onOversize(true);
      expect(rows()).toHaveLength(1);
      onOversize(false);
      expect(rows()).toHaveLength(0);
      // Through the page's writer: a hash over 64 KiB is not written and shows the notice; one that fits hides it.
      vi.useFakeTimers();
      const write = vi.fn<(u: string) => void>();
      const writer = createUrlWriter(write, 200, 1000, oversizeNotice(notices));
      writer.set(`/#${'a'.repeat(URL_HASH_MAX + 1)}`);
      vi.advanceTimersByTime(200);
      expect(write).not.toHaveBeenCalled();
      expect(rows().map((d) => d.textContent)).toEqual([expect.stringContaining(URL_OVERSIZE_NOTICE)]);
      writer.set('/#short');
      vi.advanceTimersByTime(200);
      expect(write).toHaveBeenCalledWith('/#short');
      expect(rows()).toHaveLength(0);
    });

    test('show is Notices-shaped: kind, actions, a dismiss button and a timeout; dispose clears its timers', () => {
      vi.useFakeTimers();
      const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
      const run = vi.fn();
      notices.show('Could not teleport', { kind: 'error', actions: [{ label: 'Retry', run }] });
      const row = rows()[0]!;
      expect(row.className).toBe('world-notice world-notice-error');
      const [retry, dismiss] = row.querySelectorAll('button');
      expect(retry!.textContent).toBe('Retry');
      retry!.click();
      expect(run).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(0);
      notices.show('Undo', { timeoutMs: 1500 });
      expect(rows()[0]!.className).toBe('world-notice');
      vi.advanceTimersByTime(1499);
      expect(rows()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(rows()).toHaveLength(0);
      notices.show('Undo', { timeoutMs: 1500 });
      rows()[0]!.querySelectorAll('button')[0]!.click();
      expect(rows()).toHaveLength(0);
      expect(dismiss!.textContent).toBe('Dismiss');
      notices.show('Redo', { timeoutMs: 1500 });
      notices.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  test('the page wires it: the overlay\'s `viewChanged`, the teleport\'s `onArrive`, the writer\'s dispose; no `hashchange` and no mount-time hash in the Reloads', () => {
    // The page's post-reveal wiring cannot be mounted in the unit project, so its source is pinned.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/['"]hashchange['"]/);
    expect(src).not.toMatch(/hereUrl\(fly, [^)]*, hash\)/);
    expect(src).toMatch(/viewChanged: \(\) => worldUrl\.viewChanged\(\)/);
    expect(src).toMatch(/onArrive: \(_x, _z, landing\) => \{\s*worldUrl\.arrived\(fly\);/);
    expect(src).toMatch(/teardown\.push\(\(\) => urlWriter\.dispose\(\)\)/);
  });

  test('Task 20b: `flushOnPageHide` flushes the writer on every pagehide until its remover runs; the page wires it to the world\'s writer and its teardown', () => {
    const listeners = new Map<string, Set<() => void>>();
    const win = {
      addEventListener: (type: string, fn: () => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
      removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    };
    const fire = (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); };
    let flushes = 0;
    const remove = flushOnPageHide(win, { flush: () => { flushes++; } });
    expect([...listeners.keys()]).toEqual(['pagehide']);
    fire('pagehide');
    fire('pagehide');
    expect(flushes).toBe(2);
    remove();
    expect(listeners.get('pagehide')!.size).toBe(0);
    fire('pagehide');
    expect(flushes).toBe(2);
    // A debounced write pending at pagehide (F5 within 200 ms of an Apply) reaches the URL.
    vi.useFakeTimers();
    try {
      const write = vi.fn<(u: string) => void>();
      const writer = createUrlWriter(write, 200, 1000, () => {});
      const off = flushOnPageHide(win, writer);
      writer.set('/?rd=8#applied');
      fire('pagehide');
      expect(write.mock.calls).toEqual([['/?rd=8#applied']]);
      off();
      writer.dispose();
    } finally {
      vi.useRealTimers();
    }
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/teardown\.push\(flushOnPageHide\(window, urlWriter\)\)/);
  });

  test('Task 20b: the teleport is disposed in the page\'s teardown (a landing pending at teardown settles silently)', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/teardown\.push\(\(\) => teleporter\.dispose\(\)\)/);
  });

  test('ruling R5: a failure after the reveal also disposes the teleport, before the pool is terminated (no "Could not teleport" beside the failure panel)', () => {
    // pool.terminate rejects a landing in flight with WorkerFailed, which would call onFail; a disposed teleport settles
    // it silently (Task 20b). The page's post-reveal wiring cannot be mounted in the unit project, so its source is pinned.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    // The streaming route's (the bench's own, earlier, has no map and no teleport).
    const start = src.indexOf('\n    failAfterReveal = (cause, shown) => {');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n    };', start + 1));
    expect(block).toMatch(/closeMap: \(\) => mapRef\?\.dispose\(\)/);
    const release = block.slice(block.indexOf('release: ['));
    expect(release).toMatch(/^\s*\(\) => teleport\?\.dispose\(\),$/m);
    expect(release.indexOf('teleport?.dispose()')).toBeLessThan(release.indexOf('pool?.terminate()'));
    // The page's one teleport is the one the release list reaches.
    expect(src).toMatch(/^\s*let teleport: Teleport \| null = null;$/m);
    expect(src).toMatch(/^\s*teleport = teleporter;$/m);
  });
});

describe('the smoke\'s test hook, window.__wiTest under ?wiTest=1 (SP4c spec §8.6)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A window's four timer functions, over the fake clock. */
  const timerWindow = () => ({
    setTimeout: ((fn: () => void, ms?: number, ...args: unknown[]) => globalThis.setTimeout(fn, ms, ...args)) as unknown as Window['setTimeout'],
    clearTimeout: ((id?: number) => globalThis.clearTimeout(id)) as Window['clearTimeout'],
    setInterval: ((fn: () => void, ms?: number, ...args: unknown[]) => globalThis.setInterval(fn, ms, ...args)) as unknown as Window['setInterval'],
    clearInterval: ((id?: number) => globalThis.clearInterval(id)) as Window['clearInterval'],
  });

  test('countPendingTimers counts the timeouts not yet fired or cleared and the intervals not yet cleared', () => {
    const win = timerWindow();
    const pending = countPendingTimers(win);
    expect(pending()).toBe(0);
    const fired = vi.fn();
    const a = win.setTimeout(fired, 100, 'x', 2);
    const b = win.setTimeout(() => {}, 300);
    const i = win.setInterval(() => {}, 50);
    expect(pending()).toBe(3);
    vi.advanceTimersByTime(100);
    // The handler runs with its arguments, and the timer is no longer pending.
    expect(fired).toHaveBeenCalledWith('x', 2);
    expect(pending()).toBe(2);
    win.clearTimeout(b);
    win.clearTimeout(a);
    expect(pending()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(pending()).toBe(1);
    win.clearInterval(i);
    expect(pending()).toBe(0);
    // The ids are the real ones: a cleared timer never fires.
    const never = vi.fn();
    win.clearTimeout(win.setTimeout(never, 10));
    vi.advanceTimersByTime(20);
    expect(never).not.toHaveBeenCalled();
    expect(pending()).toBe(0);
  });

  test('countTileCalls counts the pool\'s tile calls and passes everything else through, getters included', async () => {
    let epoch = 3;
    const pool = {
      get epoch() { return epoch; },
      size: 4,
      tile: vi.fn(async (req: { tx: number }, priority: number) => ({ req, priority })),
      point: vi.fn(async (x: number) => x * 2),
    };
    let n = 0;
    const counted = countTileCalls(pool, () => { n++; });
    expect(await counted.tile({ tx: 1 }, 5)).toEqual({ req: { tx: 1 }, priority: 5 });
    await counted.tile({ tx: 2 }, 6);
    expect(n).toBe(2);
    expect(pool.tile).toHaveBeenCalledTimes(2);
    expect(await counted.point(4)).toBe(8);
    expect(n).toBe(2);
    expect(counted.size).toBe(4);
    epoch = 7;
    expect(counted.epoch).toBe(7);
  });

  test('installWiTest puts the hook on the window: timers at once; the page\'s parts after attach (throwing before); lastLanding with null water for −∞', async () => {
    const win: ReturnType<typeof timerWindow> & { __wiTest?: WiTest } = timerWindow();
    const install = installWiTest(win);
    const hook = install.hook;
    expect(win.__wiTest).toBe(hook);
    win.setTimeout(() => {}, 100);
    expect(hook.timers()).toBe(1);
    expect(() => hook.owner()).toThrow(/not attached/);
    expect(hook.tileRequests()).toBe(0);
    expect(hook.lastLanding()).toBeNull();
    const page: WiTestPage = {
      listenerCount: () => 2,
      closeOverlay: vi.fn(),
      disposeTool: vi.fn(),
      forceFatal: vi.fn(),
      owner: () => 'map',
      stale: () => 17,
    };
    install.attach(page);
    expect([hook.listenerCount(), hook.owner(), hook.stale()]).toEqual([2, 'map', 17]);
    hook.closeOverlay();
    hook.disposeTool();
    hook.forceFatal();
    expect([page.closeOverlay, page.disposeTool, page.forceFatal].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1]);
    const pool = install.countTiles({ tile: async () => 1 });
    await pool.tile();
    expect(hook.tileRequests()).toBe(1);
    install.landed({ surface: 66, water: Number.NEGATIVE_INFINITY, y: 90 });
    expect(hook.lastLanding()).toEqual({ surface: 66, water: null, y: 90 });
    install.landed({ surface: 40, water: 63, y: 87 });
    expect(hook.lastLanding()).toEqual({ surface: 40, water: 63, y: 87 });
  });

  test('the page wires the hook only when given one: the overlay\'s pool counted, the landing recorded, the page\'s parts attached', () => {
    // The page's post-reveal wiring cannot be mounted in the unit project, so its source is pinned.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    // The page itself never reads the window's hook: without the flag there is none, and with it main.ts hands it over.
    expect(src.slice(src.indexOf('export function mountWorldPage('))).not.toMatch(/__wiTest/);
    expect(src).toMatch(/pool: opts\.wiTest\?\.countTiles\(workers\) \?\? workers,/);
    expect(src).toMatch(/opts\.wiTest\?\.landed\(landing\);/);
    expect(src).toMatch(/opts\.wiTest\?\.attach\(\{/);
    const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/query\.get\('wiTest'\) === '1'/);
    expect(main).toMatch(/installWiTest\(window\)/);
  });
});

describe('the world\'s notices over the map (SP4c spec §2.1, D27)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  /** The world's notices in `.world-notices`, and a tool's notice row (`createNotices`, as the map tool's). */
  function setup() {
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const toolRow = dom.document.createElement('div');
    dom.body.append(toolRow);
    const tool = createNotices(toolRow as unknown as HTMLElement);
    const world = () => dom.el('world-notices').children.map((d) => d.textContent);
    const row = () => toolRow.children.map((d) => d.textContent);
    return { notices, tool, world, row };
  }
  /** The page's three transient notices: StoreFull, the URL oversize, "Could not teleport" (as the page's `onFail`). */
  const showAll = (notices: ReturnType<typeof createWorldNotices>, apply: () => void): void => {
    notices.storeFull(6, apply);
    oversizeNotice(notices)(true);
    notices.show('Could not teleport', { kind: 'warn', timeoutMs: 4000 });
  };

  test('while routed, storeFull, the URL-oversize notice and `Could not teleport` show in the tool\'s row and not in `.world-notices`; unrouted, the reverse', () => {
    vi.useFakeTimers();
    const s = setup();
    const apply = vi.fn();
    s.notices.route(s.tool);
    showAll(s.notices, apply);
    expect(s.world()).toEqual([]);
    expect(s.row()).toHaveLength(3);
    expect(s.row()[0]).toContain('The world store is full: new terrain is paused.');
    expect(s.row()[1]).toContain(URL_OVERSIZE_NOTICE);
    expect(s.row()[2]).toContain('Could not teleport');
    // StoreFull's "Lower to RD 6" works from the tool's row.
    const lower = dom.body.querySelectorAll('button').find((b: FakeElement) => b.textContent === 'Lower to RD 6');
    lower!.click();
    expect(apply).toHaveBeenCalledTimes(1);
    // "Could not teleport" goes after 4 s; the oversize notice is hidden when the hash fits again.
    vi.advanceTimersByTime(4000);
    oversizeNotice(s.notices)(false);
    expect(s.row()).toEqual([]);

    s.notices.route(null);
    showAll(s.notices, apply);
    expect(s.row()).toEqual([]);
    expect(s.world()).toHaveLength(3);
    expect(s.world()[0]).toContain('The world store is full: new terrain is paused.');
    expect(s.world()[1]).toContain(URL_OVERSIZE_NOTICE);
    expect(s.world()[2]).toContain('Could not teleport');
  });

  test('a notice shown before the route is still hidden by its condition\'s end while routed (and the reverse)', () => {
    const s = setup();
    oversizeNotice(s.notices)(true);
    s.notices.route(s.tool);
    oversizeNotice(s.notices)(false);
    expect(s.world()).toEqual([]);
    oversizeNotice(s.notices)(true);
    s.notices.route(null);
    oversizeNotice(s.notices)(false);
    expect(s.row()).toEqual([]);
  });

  test('the failure panel and the context-loss notice never route', () => {
    const s = setup();
    s.notices.route(s.tool);
    s.notices.failed('Streaming stopped: x', 'details', '/?at=0,0');
    s.notices.contextLost('/?at=0,0');
    expect(s.row()).toEqual([]);
    expect(dom.el('world-failed').textContent).toContain('The world stopped.');
    expect(dom.el('world-context-lost').textContent).toContain('The graphics context was lost');
  });

  test('the page wires them: "Could not teleport" as a 4 s warning, the overlay gets the notices, `onApplied` calls the undo notice', () => {
    // The page's post-reveal wiring cannot be mounted in the unit project, so its source is pinned.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/onFail: \(\) => notices\.show\('Could not teleport', \{ kind: 'warn', timeoutMs: 4000 \}\)/);
    const start = src.indexOf('createMapOverlay({');
    expect(src.slice(start, src.indexOf('\n    });', start))).toMatch(/^\s*notices,$/m);
    expect(src).toMatch(/undoNotice\.applied\(from\)/);
    expect(src).toMatch(/stale: c\.stale,/);
    expect(src).toMatch(/needed: c\.MESH\.needed,/);
  });
});

describe('createUndoNotice (SP4c spec §2.4, §4.3; D15, D26)', () => {
  /** A real session, the map's visibility and the notices' `show` as a spy. */
  function setup(shown = false) {
    const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    let mapShown = shown;
    const show = vi.fn<(text: string, ms: number) => void>();
    const notice = createUndoNotice({ subscribe: (l: SessionListener) => session.subscribe(l), mapShown: () => mapShown, show });
    return { session, show, notice, setShown: (v: boolean) => { mapShown = v; } };
  }
  const edit = (session: WorldSession, v: number): void => {
    const r = session.set('climate.scaleMul', v);
    if (!r.ok) throw new Error(`the edit was refused: ${JSON.stringify(r.issues)}`);
  };

  test('an undo with the map hidden shows `Undo` from its Apply for 1,500 ms, a redo `Redo`; with the map shown, nothing; a typed edit\'s Apply shows nothing', () => {
    expect(UNDO_NOTICE_MS).toBe(1500);
    const s = setup();
    edit(s.session, 2);
    s.notice.applied('T');
    expect(s.show).not.toHaveBeenCalled();
    s.session.undo();
    // Nothing before its Apply.
    expect(s.show).not.toHaveBeenCalled();
    s.notice.applied('T');
    expect(s.show.mock.calls).toEqual([['Undo', 1500]]);
    s.session.redo();
    s.notice.applied('T');
    expect(s.show.mock.calls).toEqual([['Undo', 1500], ['Redo', 1500]]);
    // An undo that rebuilds nothing (from null) shows it too.
    s.session.undo();
    s.notice.applied(null);
    expect(s.show.mock.calls.at(-1)).toEqual(['Undo', 1500]);
    // A later Apply with no new change does not repeat it.
    s.notice.applied(null);
    expect(s.show).toHaveBeenCalledTimes(3);

    const shown = setup(true);
    edit(shown.session, 2);
    shown.notice.applied('T');
    shown.session.undo();
    shown.notice.applied('T');
    shown.session.redo();
    shown.notice.applied('T');
    expect(shown.show).not.toHaveBeenCalled();
  });
});

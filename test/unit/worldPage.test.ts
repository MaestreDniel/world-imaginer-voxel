import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../src/engine/capabilityRules';
import type { StreamEvent } from '../../src/engine/coordinator';
import { lowerRd } from '../../src/engine/renderDistance';
import { DEFAULT_KEYMAP } from '../../src/player/keymap';
import { applyRenderDistance, cameraFar } from '../../src/render/renderer';
import { mountHelp } from '../../src/ui/help';
import { SETTINGS_DEFAULTS, type WorldSettings } from '../../src/ui/settings';
import { StoreCorrupt } from '../../src/world/store/pool';
import { createBenchDriver } from '../../src/ui/world/bench';
import { createFogEase } from '../../src/ui/world/fogEase';
import { createReloader } from '../../src/ui/world/reload';
import {
  createRdControl, createWorldNotices, everyFrameUntil, failBeforeReveal, handleContextLoss, handleStreamEvent, helpChange, offerLowerRd,
  rdShownOnLoad, releaseOnFailure, reloadRd, runTeardown, stopAfterFailure,
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
    driver.bind({ rdMax: 10, heightAt: () => null });
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
      mapHereHref: () => '?map',
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
        mapHereHref: () => '?map',
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
        mapHereHref: () => '?map',
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

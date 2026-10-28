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
import { AIR, REGISTRY, STONE } from '../../src/world/blocks/index';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { createHotbar } from '../../src/player/hotbar';
import { SPEED_DEFAULT, type FlyState } from '../../src/player/fly';
import { attachInput } from '../../src/player/input';
import { EYE, createWalkState } from '../../src/player/walk';
import { NEAR_FLY, NEAR_WALK } from '../../src/render/renderer';
import { createReloader, createWorldUrl, worldHash, type HereState } from '../../src/ui/world/reload';
import {
  countPendingTimers, countTileCalls, createAim, createClickQueue, createHookEdit, createRdControl, createUndoNotice, createWorldNotices, everyFrameUntil, failBeforeReveal, flushOnPageHide, handleContextLoss,
  handleStreamEvent, helpChange, installRepeatStop, installUndoKeys, installWiTest, mapKey, offerLowerRd, paletteFirst, onDriverStatus, onSimFailure, rdShownOnLoad, releaseOnFailure, reloadRd, runTeardown, speedKey, stopAfterFailure, switchMode,
  UNDO_NOTICE_MS, type WiTest, type WiTestPage,
} from '../../src/ui/world/worldPage';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createEditPath, type EditOutcome } from '../../src/ui/world/editPath';
import { createActionPost, createBlockHistory, type BlockStep } from '../../src/ui/world/blockHistory';
import { createHoldRepeat } from '../../src/ui/world/holdRepeat';
import { mountPalette } from '../../src/ui/palette';
import { NO_ENTRY } from '../../src/sim/diffStore';
import type { Edit } from '../../src/workers/protocol';
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
  test('disconnects the long-task observer, disposes the sim, terminates the pool and disposes the renderer, each once', () => {
    const longTasks = { disconnect: vi.fn() };
    const sim = { dispose: vi.fn() };
    const pool = { terminate: vi.fn() };
    const renderer = { dispose: vi.fn() };
    releaseOnFailure({ longTasks, sim, pool, renderer }, (e) => { throw e; });
    expect(longTasks.disconnect).toHaveBeenCalledTimes(1);
    expect(sim.dispose).toHaveBeenCalledTimes(1);
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
    // The live legs settle at once (L7-L9 run one frame each), at the cap like the timed script; L10 finds no surface
    // (heightAt null), so it posts nothing and flies on.
    driver.bind({
      rdMax: 10,
      heightAt: () => null,
      live: { set() {}, undo() {}, teleport: () => Promise.resolve(true), settled: () => true },
      edit: { post: () => Promise.resolve({ ok: true, prev: new Uint32Array(0), next: new Uint32Array(0) }), editState: () => 0 },
    });
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

  test('installWiTest puts the hook on the window: timers at once; the page\'s parts after attach (throwing before, edit and blockAt included, and the build and walk steps\' reads); lastLanding with null water for −∞', async () => {
    const win: ReturnType<typeof timerWindow> & { __wiTest?: WiTest } = timerWindow();
    const install = installWiTest(win);
    const hook = install.hook;
    expect(win.__wiTest).toBe(hook);
    win.setTimeout(() => {}, 100);
    expect(hook.timers()).toBe(1);
    expect(() => hook.owner()).toThrow(/not attached/);
    expect(() => hook.blockAt(0, 0, 0)).toThrow(/not attached/);
    expect(() => hook.feet()).toThrow(/not attached/);
    expect(hook.tileRequests()).toBe(0);
    expect(hook.lastLanding()).toBeNull();
    const page: WiTestPage = {
      listenerCount: () => 2,
      closeOverlay: vi.fn(),
      disposeTool: vi.fn(),
      forceFatal: vi.fn(),
      owner: () => 'map',
      stale: () => 17,
      edit: vi.fn(async (x: number, y: number, z: number, state: number, fluid: number) => `${x} ${y} ${z} ${state} ${fluid}`),
      blockAt: (x, y, z) => x + y + z,
      mode: () => 'walk',
      aim: () => ({ hit: true, x: 4, y: 69, z: -2, face: 4, outline: false }),
      hotbar: () => ({ active: 2, slots: ['Stone', 'Dirt', 'Bricks'] }),
      blockHistory: () => ({ size: 3, redo: 1 }),
      lightAt: (x, y, z) => x * 100 + y + z,
      feet: () => ({ x: 0.5, y: 70, z: -3.5, onGround: true, snapPending: false, snapY: null }),
      heightAt: (x, z) => (x === 0 ? null : x + z),
    };
    install.attach(page);
    expect([hook.listenerCount(), hook.owner(), hook.stale()]).toEqual([2, 'map', 17]);
    // The SP5a parts (spec §6.4): the edit and the read-back pass through to the page.
    expect(await hook.edit(1, 70, -3, 25, 0)).toBe('1 70 -3 25 0');
    expect(hook.blockAt(1, 2, 3)).toBe(6);
    // The build and walk steps' reads (spec §6.4) pass through to the page too.
    expect(hook.mode()).toBe('walk');
    expect(hook.aim()).toEqual({ hit: true, x: 4, y: 69, z: -2, face: 4, outline: false });
    expect(hook.hotbar()).toEqual({ active: 2, slots: ['Stone', 'Dirt', 'Bricks'] });
    expect(hook.blockHistory()).toEqual({ size: 3, redo: 1 });
    expect(hook.lightAt(1, 2, 3)).toBe(105);
    expect(hook.feet()).toEqual({ x: 0.5, y: 70, z: -3.5, onGround: true, snapPending: false, snapY: null });
    expect([hook.heightAt(0, 5), hook.heightAt(2, 5)]).toEqual([null, 7]);
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

  test('a notice that stays (StoreFull, the URL oversize) moves with every route change, both ways, shown once (final review WLD-2)', () => {
    vi.useFakeTimers();
    const s = setup();
    const apply = vi.fn();
    // Mode A covers the 3D: StoreFull and the oversize notice go to the tool's row, "Could not teleport" too (4 s).
    s.notices.route(s.tool);
    showAll(s.notices, apply);
    expect(s.row()).toHaveLength(3);
    // The map closes: the two that stay come back to `.world-notices` (StoreFull with its own ids and its Lower button)
    // and leave the hidden row; the timed one ends where it was shown.
    s.notices.route(null);
    expect(s.world()).toHaveLength(2);
    expect(s.world()[0]).toContain('The world store is full: new terrain is paused.');
    expect(s.world()[1]).toContain(URL_OVERSIZE_NOTICE);
    expect(s.row()).toEqual(['Could not teleport×']);
    vi.advanceTimersByTime(4000);
    expect(s.row()).toEqual([]);
    // M again: both go to the row, none stays under the opaque overlay.
    s.notices.route(s.tool);
    expect(s.world()).toEqual([]);
    expect(s.row()).toHaveLength(2);
    s.notices.route(null);
    expect(s.row()).toEqual([]);
    expect(s.world()).toHaveLength(2);
    dom.el('world-store-full-lower').click();
    expect(apply).toHaveBeenCalledTimes(1);
    // The condition's end takes the oversize notice down wherever it is; a dismissed StoreFull does not come back.
    oversizeNotice(s.notices)(false);
    s.notices.route(s.tool);
    s.notices.route(null);
    expect(s.world()).toEqual([]);
    expect(s.row()).toEqual([]);
  });

  test('a notice shown in `.world-notices` before M moves to the tool\'s row; dismissed there, it does not come back', () => {
    const s = setup();
    s.notices.storeFull(6, vi.fn());
    oversizeNotice(s.notices)(true);
    s.notices.route(s.tool);
    expect(s.world()).toEqual([]);
    expect(s.row()).toHaveLength(2);
    // The user dismisses both in the tool's row (its ×).
    for (const b of dom.body.querySelectorAll('button').filter((x: FakeElement) => x.textContent === '×')) b.click();
    expect(s.row()).toEqual([]);
    s.notices.route(null);
    expect(s.world()).toEqual([]);
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

describe('mapKey: M with the help open (SP4c spec §1.6, §2.4; final review WLD-1)', () => {
  /** The help and the overlay as fakes that log their calls in order. */
  function setup(helpOpen: boolean, shown: boolean) {
    const log: string[] = [];
    const help = { isOpen: helpOpen, close: () => { help.isOpen = false; log.push('help.close'); } };
    const map = { shown, toggle: () => { map.shown = !map.shown; log.push(`map.toggle (help open: ${help.isOpen})`); } };
    return { help, map, log };
  }

  test('opening the map closes the help first, as the help\'s "Map (M)" does, so the overlay never covers an open help', () => {
    const s = setup(true, false);
    mapKey(s.help, s.map);
    expect(s.log).toEqual(['help.close', 'map.toggle (help open: false)']);
    expect(s.map.shown).toBe(true);
  });

  test('closing the map leaves the help as it is (mode B shows it on the 3D half); with the help closed M only toggles', () => {
    const b = setup(true, true);
    mapKey(b.help, b.map);
    expect(b.log).toEqual(['map.toggle (help open: true)']);
    const plain = setup(false, false);
    mapKey(plain.help, plain.map);
    expect(plain.log).toEqual(['map.toggle (help open: false)']);
  });

  test('before the overlay exists M does nothing, the help included', () => {
    const s = setup(true, false);
    mapKey(s.help, null);
    expect(s.log).toEqual([]);
    expect(s.help.isOpen).toBe(true);
  });

  test('the page\'s M goes through it', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    // Through the palette's close first since SP5a (spec §4.4).
    expect(src).toMatch(/case 'map': paletteFirst\(palette, \(\) => mapKey\(help, mapRef\)\); break;/);
  });
});

describe('paletteFirst: M and H with the palette open (SP5a spec §4.4, D10)', () => {
  /** The palette, the help and the map overlay as fakes that log their calls in order. */
  function setup(paletteOpen: boolean) {
    const log: string[] = [];
    const palette = { isOpen: paletteOpen, close: () => { palette.isOpen = false; log.push('palette.close'); } };
    const help = { isOpen: false, close: () => { help.isOpen = false; log.push('help.close'); } };
    const map = { shown: false, toggle: () => { map.shown = !map.shown; log.push(`map.toggle (palette open: ${palette.isOpen})`); } };
    return { palette, help, map, log };
  }

  test('M with the palette open closes it, then toggles the map', () => {
    const s = setup(true);
    paletteFirst(s.palette, () => mapKey(s.help, s.map));
    expect(s.log).toEqual(['palette.close', 'map.toggle (palette open: false)']);
    expect(s.map.shown).toBe(true);
    // With the palette closed M only toggles.
    const plain = setup(false);
    paletteFirst(plain.palette, () => mapKey(plain.help, plain.map));
    expect(plain.log).toEqual(['map.toggle (palette open: false)']);
  });

  test('H with the palette open closes it, then opens the help', () => {
    const s = setup(true);
    paletteFirst(s.palette, () => {
      s.help.isOpen = true;
      s.log.push(`help.open (palette open: ${s.palette.isOpen})`);
    });
    expect(s.log).toEqual(['palette.close', 'help.open (palette open: false)']);
    expect(s.help.isOpen).toBe(true);
  });

  test('the page\'s M and H go through it, E closes the help before opening the palette, and the frame step\'s `paused` includes `palette.isOpen`', () => {
    // The page's post-reveal wiring cannot be mounted in the unit project, so its source is pinned.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/case 'map': paletteFirst\(palette, \(\) => mapKey\(help, mapRef\)\); break;/);
    expect(src).toMatch(/case 'help':\s+paletteFirst\(palette, \(\) => \{/);
    expect(src).toMatch(/case 'palette':\s+if \(!palette\.isOpen\) \{\s+if \(help\.isOpen\) help\.close\(\);\s+palette\.open\(\);/);
    expect(src).toMatch(/paused: \(\) => help\.isOpen \|\| palette\.isOpen \|\| mapOverlay\.owner === 'map',/);
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

describe('onSimFailure (the sim\'s failure, SP5a spec §2.1)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  test('`onSimFailure` marks 15 dead, unpins all, shows the notice with no timeout, and a later `post` resolves `failed`', async () => {
    vi.useFakeTimers();
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const store = { markDead: vi.fn<(t: number) => void>() };
    const coordinator = {
      editState: () => 0 as const,
      simPin: vi.fn(),
      simUnpin: vi.fn(),
      markEdited: vi.fn(),
      simUnpinAll: vi.fn(),
    };
    const sim = { failed: false, edits: vi.fn(() => new Promise<never>(() => {})) };
    const editPath = createEditPath({ sim, coordinator, latency: createEditLatency(), now: () => 0, notices: { show: vi.fn() } });
    onSimFailure({ store, coordinator, editPath, notices });
    expect(store.markDead.mock.calls).toEqual([[15]]);
    expect(coordinator.simUnpinAll).toHaveBeenCalledTimes(1);
    const text = () => dom.el('world-notices').children.map((d: FakeElement) => d.textContent).join('\n');
    expect(text()).toContain('Editing stopped: the edit worker failed; this session\'s edits are lost');
    // No timeout: still shown a minute later.
    vi.advanceTimersByTime(60_000);
    expect(text()).toContain('Editing stopped: the edit worker failed; this session\'s edits are lost');
    expect(await editPath.post([{ x: 3, y: 70, z: 4, op: 'set', value: 1 << 8, expect: 0 }])).toEqual({ ok: false, why: 'failed' });
    expect(sim.edits).not.toHaveBeenCalled();
    expect(coordinator.simPin).not.toHaveBeenCalled();
  });
});

describe('createAim: the DDA and the outline (SP5a spec §3.5, §6.2; Task 23 review I1)', () => {
  /** Stone at (0, 68, 0) under an eye at (0.5, 70.5, 0.5) looking straight down; the floating origin at (16, 0, −32). */
  function rig(o: { hud: boolean; locked?: boolean; stone?: boolean }) {
    const calls: string[] = [];
    const world = {
      origin: { x: 16, y: 0, z: -32 },
      setOutline: (...b: number[]) => { calls.push(`set ${b.join(',')}`); },
      hideOutline: () => { calls.push('hide'); },
    };
    const fly = { x: 0.5, y: 70.5, z: 0.5, yaw: 0, pitch: -90, mode: 'fly' as const };
    const read = {
      blockAt: (x: number, y: number, z: number) => (o.stone !== false && x === 0 && y === 68 && z === 0 ? STONE : AIR),
      fluidAt: () => 0,
    };
    const aim = createAim({ fly, world: world as never, locked: () => o.locked ?? true, hud: o.hud });
    return { aim, calls, read };
  }
  /** The stone's cell relative to the origin. */
  const BOX = [-16, 68, 32, -15, 69, 33];

  test('with the HUD, the lock and a hit: the outline set to the hit\'s cell relative to the floating origin', () => {
    const r = rig({ hud: true });
    r.aim.aim(r.read, false);
    expect([r.aim.hit.hit, r.aim.hit.x, r.aim.hit.y, r.aim.hit.z]).toEqual([true, 0, 68, 0]);
    expect(r.calls).toEqual([`set ${BOX.join(',')}`]);
    expect([...r.aim.box]).toEqual(BOX);
    // The smoke's `aim().outline` (spec §6.4).
    expect(r.aim.outlined).toBe(true);
  });

  test('paused, the pointer free, no target, or no HUD: the outline hidden', () => {
    const cases = [rig({ hud: true }), rig({ hud: true, locked: false }), rig({ hud: true, stone: false }), rig({ hud: false })];
    cases[0]!.aim.aim(cases[0]!.read, true);
    for (const r of cases.slice(1)) r.aim.aim(r.read, false);
    expect(cases.map((r) => r.calls)).toEqual([['hide'], ['hide'], ['hide'], ['hide']]);
    expect(cases.map((r) => r.aim.outlined)).toEqual([false, false, false, false]);
    expect(cases[2]!.aim.hit.hit).toBe(false);
  });

  test('without the HUD (the bench) a hit still runs the outline update: the box is computed but not drawn', () => {
    const r = rig({ hud: false });
    r.aim.aim(r.read, false);
    expect(r.aim.hit.hit).toBe(true);
    expect([...r.aim.box]).toEqual(BOX);
    expect(r.calls).toEqual(['hide']);
    expect(r.aim.outlined).toBe(false);
  });
});

describe('createClickQueue: the queued clicks run in the aim (SP5a spec §4.1, §4.2)', () => {
  /**
   * The rig of the aim above: stone at (0, 68, 0) under an eye looking straight down from 4.5 blocks up (the body's feet
   * 1.12 above the voxel a place targets); `setStone(false)` removes it, `setWater(true)` puts water at (0, 69, 0).
   */
  function rig() {
    let stone = true;
    let water = false;
    let editable = true;
    const posted: unknown[] = [];
    const world = { origin: { x: 0, y: 0, z: 0 }, setOutline: () => {}, hideOutline: () => {} };
    const fly = { x: 0.5, y: 72.5, z: 0.5, yaw: 0, pitch: -90, mode: 'fly' as const };
    const read = {
      blockAt: (x: number, y: number, z: number) => (stone && x === 0 && y === 68 && z === 0 ? STONE : AIR),
      fluidAt: (x: number, y: number, z: number) => (water && x === 0 && y === 69 && z === 0 ? WATER_SOURCE : 0),
    };
    const hotbar = createHotbar(null);
    const clicks = createClickQueue({ post: (e) => { posted.push(e); }, hotbar, fly, walk: createWalkState(), editable: () => editable });
    const aim = createAim({ fly, world: world as never, locked: () => true, hud: true, clicks });
    return {
      aim, clicks, read, posted, hotbar,
      setStone: (on: boolean) => { stone = on; },
      setWater: (on: boolean) => { water = on; },
      setEditable: (on: boolean) => { editable = on; },
    };
  }
  const BREAK = { x: 0, y: 68, z: 0, op: 'set', value: AIR << 8, expect: STONE << 8 };
  const OAK_PLANKS = REGISTRY.stateOf(REGISTRY.typeId('oak_planks'));

  test('an LMB press posts one break of the voxel aimed at the next frame, `expect` read then; later frames post nothing', () => {
    const r = rig();
    r.clicks.push(0);
    expect(r.posted).toEqual([]);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([BREAK]);
    r.aim.aim(r.read, false);
    expect(r.posted).toHaveLength(1);
  });

  test('two presses in one frame post two breaks with the same `expect` (the sim refuses the second as changed)', () => {
    const r = rig();
    r.clicks.push(0);
    r.clicks.push(0);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([BREAK, BREAK]);
  });

  test('a paused frame drops the queue unrun; a miss empties it', () => {
    const r = rig();
    r.clicks.push(0);
    r.clicks.push(2);
    r.aim.aim(r.read, true);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([]);
    r.setStone(false);
    r.clicks.push(0);
    r.clicks.push(2);
    r.aim.aim(r.read, false);
    expect(r.aim.hit.hit).toBe(false);
    r.setStone(true);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([]);
  });

  test('RMB places the hotbar\'s active slot across the hit face; a column that is not editable refuses it', () => {
    const r = rig();
    r.clicks.push(2);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([{ x: 0, y: 69, z: 0, op: 'set', value: STONE << 8, expect: AIR << 8 }]);
    r.hotbar.select(3);
    r.setEditable(false);
    r.clicks.push(2);
    r.aim.aim(r.read, false);
    expect(r.posted).toHaveLength(1);
    r.setEditable(true);
    r.clicks.push(2);
    r.aim.aim(r.read, false);
    expect(r.posted[1]).toEqual({ x: 0, y: 69, z: 0, op: 'set', value: OAK_PLANKS << 8, expect: AIR << 8 });
  });

  test('RMB with a bucket: the water slot places a still source; the empty bucket drains the first fluid on the ray', () => {
    const r = rig();
    r.hotbar.select(7);
    r.clicks.push(2);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([{ x: 0, y: 69, z: 0, op: 'set', value: (AIR << 8) | WATER_SOURCE, expect: AIR << 8 }]);
    r.setWater(true);
    r.hotbar.assign({ tool: 'emptyBucket' });
    r.clicks.push(2);
    r.aim.aim(r.read, false);
    expect(r.posted[1]).toEqual({ x: 0, y: 69, z: 0, op: 'set', value: AIR << 8, expect: (AIR << 8) | WATER_SOURCE });
  });

  test('MMB picks the aimed type: the slot holding it becomes active, else the active slot takes it; nothing is posted', () => {
    const r = rig();
    r.hotbar.select(4);
    r.clicks.push(1);
    r.aim.aim(r.read, false);
    expect(r.hotbar.active).toBe(0);
    r.hotbar.assign({ type: 'dirt', pinned: {} });
    r.hotbar.select(5);
    r.clicks.push(1);
    r.aim.aim(r.read, false);
    expect([r.hotbar.active, r.hotbar.slots[5]]).toEqual([5, { type: 'stone', pinned: {} }]);
    expect(r.posted).toEqual([]);
  });
});

describe('block undo and redo by who has the controls (SP5a spec §4.5, D13)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const keydown = (key: string, mods: Record<string, boolean> = {}) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  const src = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');

  /**
   * A fake edit path that accepts every batch (a set leaves its value as the entry, a revert none), the real block
   * history and the page's recording post in front of it, and the undo keys on a stubbed window with the world owning.
   */
  function rig() {
    const posted: Edit[][] = [];
    const post = (edits: readonly Edit[]): Promise<EditOutcome> => {
      posted.push([...edits]);
      const next = Uint32Array.from(edits, (e) => (e.op === 'revert' ? NO_ENTRY : e.value));
      return Promise.resolve({ ok: true, prev: new Uint32Array(edits.length).fill(NO_ENTRY), next });
    };
    const history = createBlockHistory({
      post, read: () => AIR << 8, pending: () => false, settled: () => Promise.resolve(), notices: { show() {} },
    });
    const actions = createActionPost({ post, record: history.record });
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const session = { undo: vi.fn(() => true), redo: vi.fn(() => true) };
    const dispose = installUndoKeys({ owner: () => 'world', blocks: history, session });
    return { posted, history, actions, win, session, dispose };
  }

  test('the page: owner \'world\' → the block history, \'map\' → `session.undo()`', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    let owner: 'world' | 'map' = 'world';
    const log: string[] = [];
    const dispose = installUndoKeys({
      owner: () => owner,
      blocks: { undo: () => { log.push('blocks.undo'); }, redo: () => { log.push('blocks.redo'); } },
      session: { undo: () => { log.push('session.undo'); return true; }, redo: () => { log.push('session.redo'); return true; } },
    });
    const press = () => {
      for (const k of [keydown('z', { ctrlKey: true }), keydown('y', { ctrlKey: true }), keydown('Z', { ctrlKey: true, shiftKey: true })]) {
        win.dispatchEvent(k);
        expect(k.defaultPrevented).toBe(true);
      }
    };
    press();
    owner = 'map';
    press();
    expect(log).toEqual(['blocks.undo', 'blocks.redo', 'blocks.redo', 'session.undo', 'session.redo', 'session.redo']);
    dispose();
    win.dispatchEvent(keydown('z', { ctrlKey: true }));
    expect(log).toHaveLength(6);
    // The page installs it with the overlay's owner, its block history and the session.
    expect(src()).toMatch(/installUndoKeys\(\{ owner: \(\) => mapOverlay\.owner, blocks: blockHistory, session \}\)/);
  });

  test('a place, then Ctrl+Z with the world owning, posts its `revert`', async () => {
    const r = rig();
    // The click queue's place (stone under the eye, the hotbar's stone placed above it), posted through the recording post.
    const world = { origin: { x: 0, y: 0, z: 0 }, setOutline: () => {}, hideOutline: () => {} };
    const fly = { x: 0.5, y: 72.5, z: 0.5, yaw: 0, pitch: -90, mode: 'fly' as const };
    const read = {
      blockAt: (x: number, y: number, z: number) => (x === 0 && y === 68 && z === 0 ? STONE : AIR),
      fluidAt: () => 0,
    };
    const clicks = createClickQueue({ post: (edit) => { void r.actions([edit]); }, hotbar: createHotbar(null), fly, walk: createWalkState(), editable: () => true });
    const aim = createAim({ fly, world: world as never, locked: () => true, hud: true, clicks });
    clicks.push(2);
    aim.aim(read, false);
    await flushMicrotasks();
    expect(r.history.size).toBe(1);
    r.win.dispatchEvent(keydown('z', { ctrlKey: true }));
    await flushMicrotasks();
    expect(r.posted).toEqual([
      [{ x: 0, y: 69, z: 0, op: 'set', value: STONE << 8, expect: AIR << 8 }],
      [{ x: 0, y: 69, z: 0, op: 'revert', value: 0, expect: STONE << 8 }],
    ]);
    expect([r.history.size, r.history.redoSize]).toEqual([0, 1]);
    expect(r.session.undo).not.toHaveBeenCalled();
    r.dispose();
    // The page's clicks post through it.
    expect(src()).toMatch(/post: \(edit\) => \{ void actionPost\(\[edit\]\); \},/);
  });

  test('a hook edit (`WiTest.edit`) then Ctrl+Z posts the revert', async () => {
    const r = rig();
    const edit = createHookEdit(r.actions, () => AIR << 8);
    expect(await edit(3, 70, 4, STONE, 0)).toBe('ok');
    expect(r.history.size).toBe(1);
    r.win.dispatchEvent(keydown('z', { ctrlKey: true }));
    await flushMicrotasks();
    expect(r.posted).toEqual([
      [{ x: 3, y: 70, z: 4, op: 'set', value: STONE << 8, expect: AIR << 8 }],
      [{ x: 3, y: 70, z: 4, op: 'revert', value: 0, expect: STONE << 8 }],
    ]);
    r.dispose();
    // The page's hook edits through the recording post, and the history reads the voxel's value now.
    expect(src()).toMatch(/edit: createHookEdit\(actionPost, \(x, y, z\) => voxelValue\(store, x, y, z\)\),/);
    expect(src()).toMatch(/read: \(x, y, z\) => voxelValue\(store, x, y, z\),/);
  });
});

describe('hold to repeat in the page (SP5a spec §4.1, D6; Review Focus 1, rulings R18)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const src = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

  /**
   * The page's aim over a stone floor at y 68 (air above) under an eye 4.5 blocks up looking straight down, which moves
   * east 0.05 blocks a frame, so the aimed voxel moves each frame; frames every 10 ms. A fake edit path answers each
   * post `replyS` later, checking every `expect` against the voxels then as the sim does (a mismatch is `changed`) and
   * applying an accepted set; `pending()` is true until the reply. The page's recording post in front of it, with a
   * fake block history (`record`); the hold repeat queues into the real click queue, and the aim ticks it at the frame's
   * time before the queued clicks run. `paused` is the page's (the palette open, the map owning the controls).
   */
  function rig(o: { enabled: boolean; replyS?: number }) {
    const replyS = o.replyS ?? 0.05;
    let t = 0;
    const set = new Map<string, number>();
    const valueAt = (x: number, y: number, z: number): number => set.get(key(x, y, z)) ?? (y === 68 ? STONE << 8 : AIR << 8);
    const read = {
      blockAt: (x: number, y: number, z: number) => valueAt(x, y, z) >>> 8,
      fluidAt: (x: number, y: number, z: number) => valueAt(x, y, z) & 0xff,
    };
    const replies: { due: number; edits: readonly Edit[]; resolve(out: EditOutcome): void }[] = [];
    const posts: { t: number; edit: Edit }[] = [];
    const post = (edits: readonly Edit[]): Promise<EditOutcome> => {
      for (const edit of edits) posts.push({ t, edit });
      return new Promise((resolve) => { replies.push({ due: t + replyS, edits, resolve }); });
    };
    const deliver = (): void => {
      while (replies.length > 0 && replies[0]!.due <= t + 1e-9) {
        const r = replies.shift()!;
        if (r.edits.some((e) => valueAt(e.x, e.y, e.z) !== e.expect)) {
          r.resolve({ ok: false, why: 'changed' });
          continue;
        }
        const prev = Uint32Array.from(r.edits, () => NO_ENTRY);
        for (const e of r.edits) set.set(key(e.x, e.y, e.z), e.value);
        r.resolve({ ok: true, prev, next: Uint32Array.from(r.edits, (e) => e.value) });
      }
    };
    const record = vi.fn<(step: BlockStep) => void>();
    const actionPost = createActionPost({ post, record });
    const outcomes: EditOutcome[] = [];
    const clicks = createClickQueue({
      post: (edit) => { void actionPost([edit]).then((out) => { outcomes.push(out); }); },
      hotbar: createHotbar(null),
      fly: { x: 0, y: 0, z: 0, yaw: 0, pitch: -90, mode: 'fly' },
      walk: createWalkState(),
      editable: () => true,
    });
    const hold = createHoldRepeat({ enabled: () => o.enabled, pending: () => replies.length > 0, queue: (b) => clicks.push(b) });
    const fly = { x: 0.5, y: 72.5, z: 0.5, yaw: 0, pitch: -90, mode: 'fly' as const };
    const world = { origin: { x: 0, y: 0, z: 0 }, setOutline: () => {}, hideOutline: () => {} };
    const state = { paletteOpen: false, owner: 'world' as 'world' | 'map' };
    const aim = createAim({ fly, world: world as never, locked: () => true, hud: true, clicks, repeat: { hold, now: () => t } });
    /** Runs the frames from `fromMs` to `toMs` (10 ms apart): the replies due, their continuations, then the aim. */
    const frames = async (fromMs: number, toMs: number): Promise<void> => {
      for (let ms = fromMs; ms <= toMs; ms += 10) {
        t = ms / 1000;
        deliver();
        await flushMicrotasks();
        fly.x = 0.5 + ms * 0.005;
        aim.aim(read, state.paletteOpen || state.owner === 'map');
      }
    };
    const at = (ms: number): void => { t = ms / 1000; };
    return { hold, frames, at, posts, record, outcomes, state, now: () => t };
  }

  test('Review Focus 1: on, held LMB for 1.0 s with each reply 50 ms after its post: 4 breaks posted at 0, 0.3, 0.6 and 0.9 s, each after the previous reply, to 4 distinct voxels aimed that frame; 4 history steps; no `changed` refusal', async () => {
    const r = rig({ enabled: true });
    r.at(0);
    r.hold.down(0, 0);
    await r.frames(0, 1000);
    r.hold.up(0);
    await r.frames(1010, 1500);
    expect(r.posts.map((p) => p.t)).toEqual([0, 0.3, 0.6, 0.9]);
    // Each the voxel under the eye at its frame: x = floor(0.5 + 5 t), so the target moved between them.
    expect(r.posts.map((p) => [p.edit.x, p.edit.y, p.edit.z])).toEqual([[0, 68, 0], [2, 68, 0], [3, 68, 0], [5, 68, 0]]);
    expect(r.posts.every((p) => p.edit.op === 'set' && p.edit.value === AIR << 8 && p.edit.expect === STONE << 8)).toBe(true);
    expect(r.record).toHaveBeenCalledTimes(4);
    expect(r.record.mock.calls.map(([step]) => step.edits.map((e) => e.x))).toEqual([[0], [2], [3], [5]]);
    expect(r.outcomes.map((out) => out.ok)).toEqual([true, true, true, true]);
  });

  test('a slow reply holds the repeat: with each reply 350 ms after its post, the breaks go at 0, 0.35 and 0.7 s and none is refused', async () => {
    const r = rig({ enabled: true, replyS: 0.35 });
    r.at(0);
    r.hold.down(0, 0);
    await r.frames(0, 1000);
    r.hold.up(0);
    await r.frames(1010, 1500);
    expect(r.posts.map((p) => p.t)).toEqual([0, 0.35, 0.7]);
    expect(r.outcomes.map((out) => out.ok)).toEqual([true, true, true]);
    expect(r.record).toHaveBeenCalledTimes(3);
  });

  test('with the setting off, one LMB press posts one break', async () => {
    const r = rig({ enabled: false });
    r.at(0);
    r.hold.down(0, 0);
    await r.frames(0, 1000);
    r.hold.up(0);
    await r.frames(1010, 1500);
    expect(r.posts).toHaveLength(1);
    expect(r.record).toHaveBeenCalledTimes(1);
    // The page's mouse buttons go through the hold repeat: a press queues once, a release ends the hold.
    expect(src()).toMatch(/onButton: \(b, down\) => \{\s+if \(down\) holdRepeat\.down\(b, nowS\(\)\);\s+else holdRepeat\.up\(b\);\s+\},/);
    expect(src()).toMatch(/enabled: \(\) => settings\.holdRepeat,\s+pending: editPath\.pending,\s+queue: \(b\) => clicks\.push\(b\),/);
  });

  test('with the setting on and LMB held, opening the palette, releasing the lock (a `pointerlockchange` to none) and opening the map each call `stop`: no break is queued after them', async () => {
    const dom = installDom();
    const canvas = dom.document.createElement('canvas');
    const palette = mountPalette(dom.body as unknown as HTMLElement, { hotbar: createHotbar(null), requestLock: () => {}, onClose: () => {} });
    const cases: Record<string, (r: ReturnType<typeof rig>) => Promise<void>> = {
      // The palette releases the lock and pauses the frame; closed, a click on the canvas takes the lock back.
      palette: async (r) => {
        palette.open();
        r.state.paletteOpen = palette.isOpen;
        await r.frames(160, 200);
        palette.close();
        r.state.paletteOpen = palette.isOpen;
        void canvas.requestPointerLock();
      },
      // The lock released and taken back between two frames: only the `pointerlockchange` saw it.
      lock: async () => {
        dom.document.exitPointerLock();
        void canvas.requestPointerLock();
      },
      // The map owning the controls pauses the frame (here without touching the lock, as a paused frame alone).
      map: async (r) => {
        r.state.owner = 'map';
        await r.frames(160, 200);
        r.state.owner = 'world';
      },
    };
    for (const [name, open] of Object.entries(cases)) {
      const r = rig({ enabled: true });
      void canvas.requestPointerLock();
      const remove = installRepeatStop({ doc: dom.document as unknown as Document, canvas, repeat: r.hold });
      r.at(0);
      r.hold.down(0, 0);
      await r.frames(0, 150);
      await open(r);
      expect(dom.document.pointerLockElement, name).toBe(canvas);
      await r.frames(210, 2000);
      // Only the press's own break: the button is still physically held, but nothing repeats after the stop.
      expect(r.posts.map((p) => p.t), name).toEqual([0]);
      remove();
    }
    // Removed, a lock release no longer stops it.
    const r = rig({ enabled: true });
    const remove = installRepeatStop({ doc: dom.document as unknown as Document, canvas, repeat: r.hold });
    remove();
    r.at(0);
    r.hold.down(0, 0);
    dom.document.exitPointerLock();
    await r.frames(0, 300);
    expect(r.posts.map((p) => p.t)).toEqual([0, 0.3]);
    // The page installs it on the canvas, and F (a mode switch) stops it too.
    expect(src()).toMatch(/teardown\.push\(installRepeatStop\(\{ doc: document, canvas, repeat: holdRepeat \}\)\);/);
    expect(src()).toMatch(/case 'toggleWalk': switchMode\(\{ fly, walk, world, repeat: holdRepeat \}\); break;/);
    expect(src()).toMatch(/createAim\(\{\s+fly, world, locked: \(\) => document\.pointerLockElement === canvas, hud, clicks, repeat: \{ hold: holdRepeat, now: nowS \},\s+\}\)/);
  });
});

describe('modes in the page: F, the near plane, the reach, the wheel and + / − (SP5a spec §3.1, §3.3, §3.5, D1)', () => {
  const src = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
  const flyAt = (o: Partial<FlyState> = {}): FlyState => ({
    x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: -90, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT, mode: 'fly', ...o,
  });

  test('the near plane follows the mode: F sets 0.05 walking and 0.1 flying, and stops the held button\'s repeat', () => {
    const fly = flyAt({ y: 100 });
    const walk = createWalkState();
    const near: number[] = [];
    const repeat = { stop: vi.fn() };
    switchMode({ fly, walk, world: { setNear: (n) => { near.push(n); } }, repeat });
    expect([fly.mode, walk.y]).toEqual(['walk', 100 - EYE]);
    switchMode({ fly, walk, world: { setNear: (n) => { near.push(n); } }, repeat });
    expect(fly.mode).toBe('fly');
    expect(near).toEqual([NEAR_WALK, NEAR_FLY]);
    expect([NEAR_WALK, NEAR_FLY]).toEqual([0.05, 0.1]);
    expect(repeat.stop).toHaveBeenCalledTimes(2);
  });

  test('a load opens in flight: the page\'s camera starts with `mode: \'fly\'` and a fresh walk state (D1: the mode is not remembered)', () => {
    expect(src()).toMatch(/const fly: FlyState = \{ x: at\.x, y: clamp\(view\.y, Y_MIN, Y_MAX\), z: at\.z, yaw: view\.yaw, pitch: view\.pitch, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT, mode: 'fly' \};\s+const walk = createWalkState\(\);/);
    // Both frame steps (the streaming route's and the bench's) get the page's walk state.
    expect(src().match(/createFrameStep\(\{\s+fly,\s+walk,/g)).toHaveLength(2);
  });

  test('reach 6 walking, 10 flying', () => {
    // Stone straight below the eye at y 80.5, its top face 4.5 or 6.5 blocks down.
    const world = { origin: { x: 0, y: 0, z: 0 }, setOutline: () => {}, hideOutline: () => {} };
    const hits = (mode: FlyState['mode'], stoneY: number): boolean => {
      const fly = flyAt({ y: 80.5, mode });
      const read = { blockAt: (x: number, y: number, z: number) => (x === 0 && y === stoneY && z === 0 ? STONE : AIR), fluidAt: () => 0 };
      const aim = createAim({ fly, world: world as never, locked: () => true, hud: true });
      aim.aim(read, false);
      return aim.hit.hit;
    };
    expect([hits('walk', 75), hits('fly', 75)]).toEqual([true, true]);
    expect([hits('walk', 73), hits('fly', 73)]).toEqual([false, true]);
    // A place's body walking is the walk state's current tick (rulings R23): feet in the target voxel refuse it.
    const posted: unknown[] = [];
    const fly = flyAt({ y: 72.5, mode: 'walk' });
    const walk = createWalkState();
    walk.x = 0.5;
    walk.y = 69;
    walk.z = 0.5;
    const read = { blockAt: (x: number, y: number, z: number) => (x === 0 && y === 68 && z === 0 ? STONE : AIR), fluidAt: () => 0 };
    const clicks = createClickQueue({ post: (e) => { posted.push(e); }, hotbar: createHotbar(null), fly, walk, editable: () => true });
    const aim = createAim({ fly, world: world as never, locked: () => true, hud: true, clicks });
    clicks.push(2);
    aim.aim(read, false);
    expect(posted).toEqual([]);
    walk.y = 70.5;
    clicks.push(2);
    aim.aim(read, false);
    expect(posted).toEqual([{ x: 0, y: 69, z: 0, op: 'set', value: STONE << 8, expect: AIR << 8 }]);
  });

  test('Ctrl+wheel steps the slot while walking (Ctrl is sprint), the speed while flying', () => {
    const fly = flyAt();
    const walk = createWalkState();
    const hotbar = createHotbar(null);
    const target = Object.assign(new EventTarget(), { requestPointerLock: () => Promise.resolve() });
    const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown });
    const input = attachInput(target as unknown as HTMLElement, {
      onAction: (a) => {
        if (a === 'speedUp') speedKey(fly, 1);
        else if (a === 'slotPrev') hotbar.step(-1);
      },
      onLook: () => {},
      // The page's predicate.
      wheelCtrlAsSlot: () => fly.mode === 'walk',
      isTextFocus: () => false,
      active: () => true,
      doc: doc as unknown as Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>,
      win: new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    });
    const ctrlWheelUp = () => Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -100, deltaX: 0, deltaMode: 0, ctrlKey: true });
    target.dispatchEvent(ctrlWheelUp());
    expect([fly.speed, hotbar.active]).toEqual([SPEED_DEFAULT * 1.25, 0]);
    switchMode({ fly, walk, world: { setNear: () => {} }, repeat: { stop: () => {} } });
    target.dispatchEvent(ctrlWheelUp());
    expect([fly.speed, hotbar.active]).toEqual([SPEED_DEFAULT * 1.25, 8]);
    input.dispose();
    expect(src()).toMatch(/wheelCtrlAsSlot: \(\) => fly\.mode === 'walk',/);
  });

  test('`+` does nothing while walking; flying it steps the speed', () => {
    const fly = flyAt({ mode: 'walk' });
    speedKey(fly, 1);
    speedKey(fly, -1);
    speedKey(fly, -1);
    expect(fly.speed).toBe(SPEED_DEFAULT);
    fly.mode = 'fly';
    speedKey(fly, 1);
    expect(fly.speed).toBe(SPEED_DEFAULT * 1.25);
    speedKey(fly, -1);
    expect(fly.speed).toBe(SPEED_DEFAULT);
    expect(src()).toMatch(/case 'speedUp': speedKey\(fly, 1\); break;\s+case 'speedDown': speedKey\(fly, -1\); break;/);
  });
});

/** Lets every pending promise job run (a macrotask comes after them all). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

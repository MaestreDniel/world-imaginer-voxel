import { readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { evaluateWorldCapabilities, type CapabilityReport } from '../../src/engine/capabilityRules';
import type { StreamEvent } from '../../src/engine/coordinator';
import { defaultRenderDistance, lowerRd } from '../../src/engine/renderDistance';
import { WorldSession, type SessionListener } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import { DEFAULT_KEYMAP } from '../../src/player/keymap';
import { applyRenderDistance, cameraFar } from '../../src/render/renderer';
import { mountHelp } from '../../src/ui/help';
import type { DriverStatus } from '../../src/ui/map/previewDriver';
import { SETTINGS_DEFAULTS, type WorldSettings } from '../../src/ui/settings';
import { mountSettingsPanel } from '../../src/ui/settingsPanel';
import { StoreCorrupt } from '../../src/world/store/pool';
import { JobCancelled, WorkerFailed } from '../../src/engine/workerPool';
import { SIM_THREAD } from '../../src/world/store/reclaim';
import { createBenchDriver } from '../../src/ui/world/bench';
import { createFogEase } from '../../src/ui/world/fogEase';
import { createNotices } from '../../src/ui/common/notice';
import { URL_HASH_MAX, URL_OVERSIZE_NOTICE, createUrlWriter, oversizeNotice } from '../../src/ui/common/urlWriter';
import { DEFAULT_MAP_STATE, decodeMapState, openMapSession, type MapView } from '../../src/ui/map/mapState';
import { WORLD_MAP_BPP, worldMapView } from '../../src/ui/world/mapOverlay';
import { AIR, DIRT, GLASS, REGISTRY, STONE } from '../../src/world/blocks/index';
import { WATER_SOURCE } from '../../src/world/blocks/fluid';
import { createHotbar } from '../../src/player/hotbar';
import { SPEED_DEFAULT, type FlyState } from '../../src/player/fly';
import { attachInput } from '../../src/player/input';
import { advanceTime, clockHours } from '../../src/daynight/dayNight';
import { EYE, createWalkState } from '../../src/player/walk';
import { NEAR_FLY, NEAR_WALK } from '../../src/render/renderer';
import { createReloader, createWorldUrl, savedWorldUrl, worldHash, type HereState } from '../../src/ui/world/reload';
import {
  closeOverlays, countPendingTimers, countTileCalls, createAim, createClickQueue, createHookEdit, createRdControl, createUndoNotice, createWorldNotices, everyFrameUntil, failBeforeReveal, flushOnPageHide, handleContextLoss,
  benchSetTime, benchWalk, handleStreamEvent, settingsChange, installRepeatStop, installUndoKeys, installWiTest, mapKey, offerLowerRd, paletteFirst, onDriverStatus, onSimFailure, pushCoordinatorTeardown, rdShownOnLoad, releaseOnFailure, reloadRd, runTeardown, speedKey, stopAfterFailure, switchMode,
  UNDO_NOTICE_MS, type WiTest, type WiTestPage,
} from '../../src/ui/world/worldPage';
import { createEditLatency } from '../../src/ui/world/editLatency';
import { createEditPath, type EditOutcome } from '../../src/ui/world/editPath';
import { createActionPost, createBlockHistory, type BlockStep } from '../../src/ui/world/blockHistory';
import { createHoldRepeat } from '../../src/ui/world/holdRepeat';
import { mountPalette } from '../../src/ui/palette';
import { PLACE_SAVED_NOTICE, PLACES_FULL_NOTICE, createPlaces } from '../../src/ui/world/places';
import { mountPlaceDialog } from '../../src/ui/world/placeDialog';
import { TELEPORT_FAILED_MS, TELEPORT_FAILED_NOTICE } from '../../src/ui/world/teleport';
import { NO_ENTRY } from '../../src/sim/diffStore';
import type { Edit, FlushedMsg } from '../../src/workers/protocol';
import { hex64 } from '../../src/core/hash';
import type { JsonObject } from '../../src/core/params/migrate';
import { genKey, paramsHash, stageHashes } from '../../src/core/stage/hash';
import { GENERATOR_VERSION } from '../../src/core/constants';
import type { KV } from '../../src/persist/kv';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import {
  createSaves, loadParams, newState, NO_VALUE, parseWorldRecord, todayStateTable, type HistoryRecord, type HotbarRecord, type Place, type StateRecord, type WorldRecord,
} from '../../src/persist/saves';
import {
  EDIT_FAILED_NOTICE, HISTORY_RESET_NOTICE, SAVED_EDIT_FAILED_NOTICE, STATE_RESET_NOTICE, countAccepted, createPageAutosave, hotbarStorage, lastFlush, leaveAfterSave,
  installWorldLock, lowerRdHref, OLDER_GENERATOR_NOTICE, OLDER_GENERATOR_NOTICE_MS, olderGeneratorRecord, openOlderGenerator, openRequest, openSavedWorld,
  readSavedWorld, refuseOpen, restoreMode, restoredStart, revealOlderGenerator, savePlaceKey, savedWorldUrlRules, settingsKey, timeOfHours, addPlaceAt,
  worldIgnoresKeys,
  UNSAVED_NOTICE, unsavedNoticeOf, type WorldPageOptions,
} from '../../src/ui/world/worldPage';
import { noticeOfQuery, REFUSAL_REASON_KEY, type OpenRefusal, type StorageLike } from '../../src/ui/worldsMenu';
import type { LockManagerLike } from '../../src/ui/world/worldLock';
import { resolveProfile } from '../../src/core/params/profiles';
import { seedFromInput } from '../../src/core/seed';
import { createSimClient } from '../../src/engine/simClient';
import { findSpawn } from '../../src/gen/column/spawn';
import { createGenContext } from '../../src/gen/context';
import { createSimHandler } from '../../src/workers/simHandler';
import type { VoxelStore } from '../../src/world/store/store';
import { inProcessSimWorker } from '../harness/inProcessSim';
import { genRegion } from '../harness/region';
import { parseWorldQuery } from '../../src/ui/world/query';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { installDom, type FakeElement } from './fixtures/domShim';
import { densityTree } from './fixtures/editedTrees';

const MIB = 1 << 20;
/** A capability report of the dev laptop: the RD control's and the help's (rdMax 16, "Default (12)"). */
const REPORT: CapabilityReport = {
  secureContext: true, pageIsolated: true, workerProbe: 'ok', workerIsolated: true, sabShared: true,
  growableSab: true, reservation: { blockBytes: 768 * MIB, byteBytes: 512 * MIB },
  webgl2: true, multiDraw: true, timerQuery: true, maxArrayTextureLayers: 2048, maxTextureSize: 16384,
  renderer: 'Mesa Intel(R) Graphics (ADL GT2)', vendor: 'Intel', hardwareConcurrency: 20, deviceMemory: 8,
};

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

  test('the page\'s teardown stops the sim before the coordinator\'s dispose, whose sweep ignores the sim\'s pins (rulings R42)', () => {
    const order: string[] = [];
    const sim = { dispose: () => { order.push('sim.dispose'); } };
    const coordinator = { dispose: () => { order.push('coordinator.dispose'); } };
    // Thread 15 marked dead once the sim is stopped: a pool lock its terminated worker left held is a StoreCorrupt in
    // the coordinator's sweep (which its dispose swallows), not a spin that never ends (task 40b review I1).
    const store = { markDead: (t: number) => { order.push(`markDead(${t})`); } };
    // As the page: the sim's own step when it is created, others between, then the coordinator's.
    const teardown: Array<() => void> = [() => sim.dispose(), () => { order.push('between'); }];
    pushCoordinatorTeardown(teardown, coordinator, sim, store);
    teardown.push(() => { order.push('later'); });
    runTeardown(teardown.splice(0).reverse(), (e) => { throw e; });
    expect(order).toEqual(['later', 'sim.dispose', `markDead(${SIM_THREAD})`, 'coordinator.dispose', 'between', 'sim.dispose']);
    expect(SIM_THREAD).toBe(15);
    // Each its own guarded step: a sim whose dispose throws is still marked dead, and the coordinator still disposed.
    const failing: Array<() => void> = [];
    const onError = vi.fn<(e: unknown) => void>();
    order.length = 0;
    pushCoordinatorTeardown(failing, coordinator, { dispose: () => { throw new Error('sim'); } }, store);
    runTeardown(failing.splice(0).reverse(), onError);
    expect(order).toEqual([`markDead(${SIM_THREAD})`, 'coordinator.dispose']);
    expect(onError).toHaveBeenCalledTimes(1);
    // The flight route has no sim: only the coordinator's step, and no thread marked dead.
    order.length = 0;
    pushCoordinatorTeardown(failing, coordinator, null, store);
    runTeardown(failing.splice(0).reverse(), (e) => { throw e; });
    expect(order).toEqual(['coordinator.dispose']);
    // The page's dispose runs its teardown reversed, and the coordinator's step is pushed through the helper, with the
    // page's store.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^\s*\.\.\.teardown\.splice\(0\)\.reverse\(\),$/m);
    expect(src).toMatch(/^\s*pushCoordinatorTeardown\(teardown, coordinator, simClient, store\);$/m);
    expect(src.slice(src.indexOf('async function run(')).match(/coordinator\.dispose\(\)\)/g)).toBeNull();
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

  // Final review UI-2: the palette (inset 0, z-index 3) covers the notices (z-index 2), so a fatal or a context loss
  // with it open would leave the failure panel or the context-loss Reload under it.
  test('a fatal with the palette open closes it (without the lock) before the failure panel shows, then disposes the map overlay', () => {
    const order: string[] = [];
    const requestLock = vi.fn();
    const palette = mountPalette(dom.body as unknown as HTMLElement, { hotbar: createHotbar(null), requestLock, onClose: () => {} });
    palette.open();
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const overlay = openOverlay(order);
    stopAfterFailure({
      stop: () => {},
      closeMap: () => closeOverlays(palette, overlay),
      show: () => {
        order.push(`panel (palette open: ${palette.isOpen})`);
        notices.failed('Streaming stopped: x', 'details', '/?at=0,0');
      },
      release: [],
      onError: (e) => { throw e; },
    });
    expect(order).toEqual(['overlay.dispose (panel shown: false)', 'panel (palette open: false)']);
    expect(requestLock).not.toHaveBeenCalled();
    palette.dispose();
  });

  test('a context loss with the palette open closes it before the notice shows; a palette whose close throws still lets the map close', () => {
    let lost: (() => void) | null = null;
    const palette = mountPalette(dom.body as unknown as HTMLElement, { hotbar: createHotbar(null), requestLock: () => {}, onClose: () => {} });
    palette.open();
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const order: string[] = [];
    handleContextLoss({ onContextLost: (fn) => { lost = fn; } }, {
      stop: () => {},
      closeMap: () => closeOverlays(palette, null),
      notices,
      hereHref: () => { order.push(`href (palette open: ${palette.isOpen})`); return '/?at=1,2'; },
      onError: (e) => { throw e; },
    });
    lost!();
    expect(order).toEqual(['href (palette open: false)']);
    expect(dom.el('world-context-lost').textContent).toContain('The graphics context was lost');
    palette.dispose();
    const overlay = openOverlay(order);
    expect(() => closeOverlays({ isOpen: true, close: () => { throw new Error('no host'); } }, overlay)).toThrow('no host');
    expect(overlay.dispose).toHaveBeenCalledTimes(1);
    // A closed palette and no overlay (the map never opened): nothing to do.
    expect(() => closeOverlays({ isOpen: false, close: () => { throw new Error('closed twice'); } }, null)).not.toThrow();
  });

  test('both of the streaming route\'s paths close the palette, B\'s dialog, the Settings screen and the map through closeOverlays', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src.match(/^\s*closeMap: \(\) => closeOverlays\(paletteRef, mapRef, placeDialogRef, settingsRef\),$/gm)).toHaveLength(2);
    expect(src).not.toMatch(/closeMap: \(\) => mapRef\?\.dispose\(\)/);
    expect(src).toMatch(/^\s*let paletteRef: Palette \| null = null;$/m);
    expect(src).toMatch(/^\s*paletteRef = palette;$/m);
    expect(src).toMatch(/^\s*let placeDialogRef: PlaceDialog \| null = null;$/m);
    expect(src).toMatch(/^\s*placeDialogRef = placeDialog;$/m);
    expect(src).toMatch(/^\s*let settingsRef: SettingsPanel \| null = null;$/m);
    expect(src).toMatch(/^\s*settingsRef = settingsPanel;$/m);
  });

  test('the open Settings screen closes with the overlays, after B\'s dialog and before the map; a palette whose close throws still closes it (SP5b spec §1.4)', () => {
    const order: string[] = [];
    const panel = mountSettingsPanel(dom.body as unknown as HTMLElement, {
      settings: SETTINGS_DEFAULTS, onSettings: () => {}, rdMax: 16, defaultRd: 12, onClose: () => { order.push('settings.close'); },
    });
    panel.open();
    const dialog = { isOpen: true, close: () => { dialog.isOpen = false; order.push('dialog.close'); } };
    const overlay = openOverlay(order);
    closeOverlays({ isOpen: true, close: () => { order.push('palette.close'); } }, overlay, dialog, panel);
    expect(order).toEqual(['palette.close', 'dialog.close', 'settings.close', 'overlay.dispose (panel shown: false)']);
    expect(panel.isOpen).toBe(false);
    const second = openOverlay(order);
    panel.open();
    expect(() => closeOverlays({ isOpen: true, close: () => { throw new Error('no host'); } }, second, null, panel)).toThrow('no host');
    expect(panel.isOpen).toBe(false);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    panel.dispose();
  });

  test('B\'s open dialog closes with the palette, without requesting the lock, and before the map (SP5b spec §3.7, D12)', () => {
    const order: string[] = [];
    const requestLock = vi.fn();
    const dialog = mountPlaceDialog(dom.body as unknown as HTMLElement, { requestLock, onClose: () => { order.push('dialog.close'); } });
    const save = vi.fn();
    dialog.open('Place 1 (0, 70, 0)', save);
    const overlay = openOverlay(order);
    closeOverlays({ isOpen: true, close: () => { order.push('palette.close'); } }, overlay, dialog);
    expect(order).toEqual(['palette.close', 'dialog.close', 'overlay.dispose (panel shown: false)']);
    expect(dialog.isOpen).toBe(false);
    expect(requestLock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // A palette whose close throws still closes the dialog and the map; a closed dialog is left alone.
    const second = openOverlay(order);
    dialog.open('Place 1 (0, 70, 0)', save);
    expect(() => closeOverlays({ isOpen: true, close: () => { throw new Error('no host'); } }, second, dialog)).toThrow('no host');
    expect(dialog.isOpen).toBe(false);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(() => closeOverlays(null, null, dialog)).not.toThrow();
    dialog.dispose();
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

  /**
   * The control over fakes at RD `rd`: the coordinator and the Settings screen record their calls, the world's
   * `setRenderDistance` is Task 18's `applyRenderDistance` on a real camera, the fog is the real easing, and `save`
   * records what the page would store. A navigation would go through `location.assign` (stubbed to record it).
   */
  function rig(rd = 8, panel: { setRd(rd: number | null): void } = { setRd: vi.fn() }) {
    const coordinator = { setRenderDistance: vi.fn<(rd: number) => void>() };
    const camera = new PerspectiveCamera(70, 16 / 9, 0.1, cameraFar(rd));
    const world = { camera, setRenderDistance: vi.fn((r: number) => applyRenderDistance(camera, r)) };
    const fog = createFogEase(rd);
    const saved: Array<number | null> = [];
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: '/' });
    const control = createRdControl({ coordinator, world, fog, panel, save: (r) => { saved.push(r); }, defaultRd: 12 });
    return { control, coordinator, world, camera, fog, saved, panel, assign };
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
    expect(r.panel.setRd).toHaveBeenLastCalledWith(10);
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
    expect(r.panel.setRd).toHaveBeenLastCalledWith(null);
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
      edit: { post: () => Promise.resolve({ ok: true, prev: new Uint32Array(0), next: new Uint32Array(0) }), editState: () => 0, read: () => 0 },
      setTime() {},
      walk() {},
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

  test('after the slow notice lowers 12 → 10, changing the FOV in the Settings screen keeps RD 10 (no setRenderDistance(12)) and #setting-rd shows 10', () => {
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    // The page's settings as it keeps them: `save` writes the rd, and its onSettings applies an rd that differs.
    let page: WorldSettings = { ...SETTINGS_DEFAULTS, rd: 12 };
    let control: { apply(rd: number | null): void } | null = null;
    const panel = mountSettingsPanel(dom.body as unknown as HTMLElement, {
      settings: page,
      onSettings: (s) => {
        const rdChanged = s.rd !== page.rd;
        page = s;
        if (rdChanged) control!.apply(s.rd);
      },
      rdMax: 16,
      defaultRd: defaultRenderDistance(REPORT),
      onClose: () => {},
    });
    const r = rig(12, panel);
    control = createRdControl({
      coordinator: r.coordinator, world: r.world, fog: r.fog, panel,
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
    // The screen's select itself applies live too.
    const rd = dom.el('setting-rd');
    rd.value = '14';
    rd.dispatchEvent(new Event('change'));
    expect(r.coordinator.setRenderDistance).toHaveBeenLastCalledWith(14);
    expect(page.rd).toBe(14);
  });

  describe('the Settings screen\'s RD select shows the RD in force (rulings R8)', () => {
    test('on load: the URL\'s RD on a ?rd= load, else the saved setting (null: Default)', () => {
      expect(rdShownOnLoad(4, 4, 6)).toBe(4);
      expect(rdShownOnLoad(4, 4, null)).toBe(4);
      expect(rdShownOnLoad(null, 6, 6)).toBe(6);
      expect(rdShownOnLoad(null, 12, null)).toBeNull();
    });

    test('a change from the screen keeps the saved rd unless the rd differs from the RD in force', () => {
      const saved: WorldSettings = { ...SETTINGS_DEFAULTS, rd: 6 };
      // A FOV change from a screen showing RD 4: saved with rd 6 kept, no rd applied.
      expect(settingsChange(saved, { ...saved, rd: 4, fov: 90 }, 4)).toEqual({ settings: { ...saved, fov: 90 }, applyRd: false });
      // The saved value, different from the RD in force, applies.
      expect(settingsChange(saved, { ...saved, rd: 6 }, 4)).toEqual({ settings: saved, applyRd: true });
      expect(settingsChange(saved, { ...saved, rd: null }, 4).applyRd).toBe(true);
      // The RD in force is a no-op.
      expect(settingsChange(saved, { ...saved, rd: 4 }, 4)).toEqual({ settings: saved, applyRd: false });
    });

    test('?rd=4 with 6 saved: #setting-rd shows 4; a FOV change keeps 6 saved; choosing 4 is a no-op; choosing 6 applies RD 6 live and saves it', () => {
      // The page's wiring: the screen gets the RD in force, its onSettings goes through settingsChange, and the RD
      // control's panel tracks what the select shows.
      let page: WorldSettings = { ...SETTINGS_DEFAULTS, rd: 6 };
      let shown = rdShownOnLoad(4, 4, page.rd);
      const stored: WorldSettings[] = [];
      let control: { apply(rd: number | null): void } | null = null;
      const panel = mountSettingsPanel(dom.body as unknown as HTMLElement, {
        settings: { ...page, rd: shown },
        onSettings: (s) => {
          const c = settingsChange(page, s, shown);
          page = c.settings;
          stored.push(page);
          if (c.applyRd) control!.apply(s.rd);
        },
        rdMax: 16,
        defaultRd: defaultRenderDistance(REPORT),
        onClose: () => {},
      });
      const r = rig(4);
      control = createRdControl({
        coordinator: r.coordinator, world: r.world, fog: r.fog,
        panel: { setRd: (v) => { shown = v; panel.setRd(v); } },
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

    test('after the mode switch to split, a FOV change from the Settings screen keeps mapMode: \'split\' and watchLive: false (SP4c spec §2.5)', () => {
      // The screen's copy of the settings is the one it saw at mount (full, watching live); the map's header changes the
      // saved settings afterwards, and the screen has no control for either field.
      let page: WorldSettings = { ...SETTINGS_DEFAULTS };
      const stored: WorldSettings[] = [];
      mountSettingsPanel(dom.body as unknown as HTMLElement, {
        settings: page,
        onSettings: (s) => {
          page = settingsChange(page, s, null).settings;
          stored.push(page);
        },
        rdMax: 16,
        defaultRd: defaultRenderDistance(REPORT),
        onClose: () => {},
      });
      // The mode switch and the Watch live checkbox (the overlay's header) save at once.
      page = { ...page, mapMode: 'split', watchLive: false };
      const fov = dom.el('setting-fov');
      fov.value = '90';
      fov.dispatchEvent(new Event('input'));
      expect(stored.at(-1)).toEqual({ ...SETTINGS_DEFAULTS, fov: 90, mapMode: 'split', watchLive: false });
      expect(settingsChange(page, { ...page, mapMode: 'full', watchLive: true, fov: 80 }, null).settings)
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
    expect(block).toMatch(/closeMap: \(\) => closeOverlays\(paletteRef, mapRef, placeDialogRef, settingsRef\)/);
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
    expect(src).toMatch(/onFail: \(\) => notices\.show\(TELEPORT_FAILED_NOTICE, \{ kind: 'warn', timeoutMs: TELEPORT_FAILED_MS \}\)/);
    // "Could not teleport" for 4 s, shared with "+ Add at the pin"'s failed landing (SP5b spec §3.7).
    expect([TELEPORT_FAILED_NOTICE, TELEPORT_FAILED_MS]).toEqual(['Could not teleport', 4000]);
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
    // Through the palette's close first since SP5a (spec §4.4); the help and the Settings screen as one panel (SP5b
    // spec §1.4), so the map opens over neither.
    expect(src).toMatch(/get isOpen\(\): boolean \{\s+return help\.isOpen \|\| settingsPanel\.isOpen;\s+\},\s+close\(\): void \{\s+help\.close\(\);\s+settingsPanel\.close\(\);/);
    expect(src).toMatch(/case 'map': paletteFirst\(palette, \(\) => mapKey\(panels, mapRef\)\); break;/);
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
    expect(src).toMatch(/case 'map': paletteFirst\(palette, \(\) => mapKey\(panels, mapRef\)\); break;/);
    expect(src).toMatch(/case 'help':\s+paletteFirst\(palette, \(\) => \{/);
    expect(src).toMatch(/case 'palette':\s+if \(!palette\.isOpen\) \{\s+if \(help\.isOpen\) help\.close\(\);\s+settingsPanel\.close\(\);\s+palette\.open\(\);/);
    expect(src).toMatch(/paused: \(\) => help\.isOpen \|\| palette\.isOpen \|\| placeDialog\.isOpen \|\| settingsPanel\.isOpen \|\| mapOverlay\.owner === 'map',/);
  });
});

describe('B saves a place in a saved world (SP5b spec §3.7, D12; rulings P33, R9)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const camera = { x: 312.7, y: 88.2, z: -1540.1, yaw: 35, pitch: -12 };
  /** `n` places at (i, 70, 0). */
  const placesOf = (n: number): Place[] => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, name: `Q${i}`, colour: 0, x: i, y: 70, z: 0, yaw: 0, pitch: 0 }));

  /**
   * B as the page wires it: the palette, the help and the Settings screen as fakes, the real dialog, the places model
   * and the notices' log.
   */
  function setup(o: { paletteOpen?: boolean; helpOpen?: boolean; settingsOpen?: boolean; initial?: Place[]; saved?: boolean } = {}) {
    const log: string[] = [];
    const palette = { isOpen: o.paletteOpen ?? false, close: () => { palette.isOpen = false; log.push('palette.close'); } };
    const help = { isOpen: o.helpOpen ?? false };
    const settings = { isOpen: o.settingsOpen ?? false };
    const requestLock = vi.fn();
    const dialog = mountPlaceDialog(dom.body as unknown as HTMLElement, { requestLock, onClose: () => {} });
    let n = 0;
    const places = createPlaces(o.initial ?? [], () => `p${++n}`);
    const shown: Array<[string, number]> = [];
    const press = (): void => savePlaceKey({
      palette, help, settings, dialog, places: o.saved === false ? null : places, camera, notices: { show: (text, ms) => { shown.push([text, ms]); } },
    });
    return { log, palette, help, settings, dialog, places, shown, press, requestLock };
  }
  const enter = (): void => { dom.document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'Enter', key: 'Enter', repeat: false })); };

  test('B with the palette open closes it and opens the dialog; with the help open B does nothing; with nothing open it opens the dialog and pauses the world', () => {
    // The palette open: it closes first (without requesting the lock), then the dialog opens.
    const s = setup({ paletteOpen: true });
    s.press();
    expect(s.log).toEqual(['palette.close']);
    expect(s.palette.isOpen).toBe(false);
    expect(s.dialog.isOpen).toBe(true);
    s.dialog.dispose();
    // The help open: nothing, the help stays.
    const h = setup({ helpOpen: true });
    h.press();
    expect(h.dialog.isOpen).toBe(false);
    expect(h.help.isOpen).toBe(true);
    expect(h.shown).toEqual([]);
    h.dialog.dispose();
    // Nothing open: the dialog, the mouse released, with the camera's position rounded down as the proposal.
    const p = setup();
    const canvas = dom.document.createElement('canvas');
    dom.document.setPointerLock(canvas);
    p.press();
    expect(p.dialog.isOpen).toBe(true);
    expect(dom.document.pointerLockElement).toBe(null);
    expect(dom.el('place-name').value).toBe('Place 1 (312, 88, -1541)');
    // The frame step's `paused` includes the dialog (pinned below): the world pauses behind it.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/paused: \(\) => help\.isOpen \|\| palette\.isOpen \|\| placeDialog\.isOpen \|\| settingsPanel\.isOpen \|\| mapOverlay\.owner === 'map',/);
    // B again while it is open does nothing (the proposal stays as typed).
    dom.el('place-name').value = 'Lookout';
    p.press();
    expect(dom.el('place-name').value).toBe('Lookout');
    // Enter keeps the camera's exact position and look, red, and shows "Place saved" for 1.5 s.
    enter();
    expect(p.dialog.isOpen).toBe(false);
    expect(p.places.list).toEqual([{ id: 'p1', name: 'Lookout', colour: 0, x: 312.7, y: 88.2, z: -1540.1, yaw: 35, pitch: -12 }]);
    expect(p.shown).toEqual([[PLACE_SAVED_NOTICE, 1500]]);
    expect(PLACE_SAVED_NOTICE).toBe('Place saved');
    expect(p.requestLock).toHaveBeenCalledTimes(1);
    p.dialog.dispose();
    // An unsaved world keeps SP5a's world (D29): B does nothing.
    const u = setup({ saved: false });
    u.press();
    expect(u.dialog.isOpen).toBe(false);
    expect(u.shown).toEqual([]);
    u.dialog.dispose();
  });

  test('with the Settings open, B does nothing (ruling P33)', () => {
    const s = setup({ settingsOpen: true });
    s.press();
    expect(s.dialog.isOpen).toBe(false);
    expect(s.settings.isOpen).toBe(true);
    expect(s.shown).toEqual([]);
    expect(s.places.list).toEqual([]);
    s.dialog.dispose();
    // The page passes its Settings screen to B's guard.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/savePlaceKey\(\{\s+palette, help, settings: settingsPanel, dialog: placeDialog, places, camera: fly,/);
  });

  test('B with 256 places shows `A world holds at most 256 places` and no dialog', () => {
    const s = setup({ initial: placesOf(256) });
    s.press();
    expect(s.dialog.isOpen).toBe(false);
    expect(s.shown).toEqual([['A world holds at most 256 places', 4000]]);
    expect(s.shown[0]![0]).toBe(PLACES_FULL_NOTICE);
    expect(s.places.list).toHaveLength(256);
    s.dialog.dispose();
    // 255: the dialog opens, and the 256th is kept.
    const t = setup({ initial: placesOf(255) });
    t.press();
    expect(t.dialog.isOpen).toBe(true);
    enter();
    expect(t.places.list).toHaveLength(256);
    expect(t.places.list[255]!.name).toBe('Place 256 (312, 88, -1541)');
    t.dialog.dispose();
  });

  test('a place added is in the next post\'s state', async () => {
    const posted: StateRecord[] = [];
    let n = 0;
    const places = createPlaces(placesOf(1), () => `p${++n}`);
    const hotbarRecord = STATE_BOUNDS.normalizeHotbar(null);
    const autosave = createPageAutosave({
      worldId: 'w1', fly: { x: 1, y: 80, z: 2, yaw: 0, pitch: 0, mode: 'fly', speed: SPEED_DEFAULT }, frame: { t: 0.25 }, speedIndex: () => 0,
      storedTime: null, hotbar: () => hotbarRecord,
      blockHistory: { snapshot: () => ({ done: [], undone: [] }), version: 0 },
      places: () => places.list,
      sim: {
        flush(state) {
          posted.push(state);
          return Promise.resolve({ type: 'flushed', id: posted.length, ok: true, flushSeq: posted.length, columns: 0, bytes: 0, syncMs: 0, commitMs: 0 });
        },
      },
      settled: () => Promise.resolve(), editsSince: () => 0, now: () => 1_700_000_000_000,
      clock: {
        now: () => 0,
        setInterval: () => 0,
        clearInterval: () => {},
        setTimeout: (f, ms) => setTimeout(f, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id),
      },
      events: { on: () => () => {}, hidden: () => false }, onResult() {},
    });
    // The page's wiring: every change of the places marks the autosave changed.
    const off = places.subscribe(() => autosave.markChanged());
    await autosave.flushNow();
    expect(posted.at(-1)!.places).toEqual(placesOf(1));
    // Nothing changed: the tick posts nothing.
    await autosave.tick();
    expect(posted).toHaveLength(1);
    const added = places.add({ name: 'Camp', colour: 3, x: 10.5, y: 72, z: -4.25, yaw: 90, pitch: 5 });
    await autosave.tick();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.places).toEqual([...placesOf(1), added]);
    // An edit and a removal are posted the same way.
    places.edit('q0', 'Home', 1);
    await autosave.tick();
    expect(posted[2]!.places.map((p) => [p.name, p.colour])).toEqual([['Home', 1], ['Camp', 3]]);
    places.remove('q0');
    await autosave.tick();
    expect(posted[3]!.places).toEqual([added]);
    off();
    autosave.dispose();
    // The page wires it so: the model from the opened state, its changes marking the autosave.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const places = saved !== null \? createPlaces\(saved\.state\.places, \(\) => crypto\.randomUUID\(\)\) : null;/);
    expect(src).toMatch(/places: \(\) => worldPlaces\.list,/);
    expect(src).toMatch(/teardown\.push\(worldPlaces\.subscribe\(\(\) => a\.markChanged\(\)\)\);/);
    expect(src).toMatch(/case 'savePlace':\s+savePlaceKey\(\{/);
  });
});

describe('G and the Settings screen in the world (SP5b spec §1.4, D9; ruling P33)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const SRC = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
  const keydown = (code: string, key: string) => Object.assign(new Event('keydown', { cancelable: true }), { code, key, repeat: false });

  test('G opens the panel and pauses the world; a slider focused in it gets the arrow keys (the world handles none)', () => {
    const log: string[] = [];
    const panel = mountSettingsPanel(dom.body as unknown as HTMLElement, {
      settings: SETTINGS_DEFAULTS, onSettings: () => {}, rdMax: 16, defaultRd: 12, onClose: () => { log.push('panel.close'); },
    });
    // G with the palette and the help open: the palette closes first, then the help, then the screen opens, the mouse
    // released.
    const palette = { isOpen: true, close: () => { palette.isOpen = false; log.push('palette.close'); } };
    const help = { isOpen: true, close: () => { help.isOpen = false; log.push('help.close'); } };
    const dialog = { isOpen: false };
    const canvas = dom.document.createElement('canvas');
    dom.document.setPointerLock(canvas);
    const g = (): void => settingsKey({ palette, help, dialog, panel, releasePointer: () => dom.document.exitPointerLock() });
    g();
    expect(log).toEqual(['palette.close', 'help.close']);
    expect(panel.isOpen).toBe(true);
    expect(dom.el('settings-panel').hidden).toBe(false);
    expect(dom.document.pointerLockElement).toBe(null);
    // The frame step's `paused` includes the screen: the world pauses behind it.
    expect(SRC()).toMatch(/paused: \(\) => help\.isOpen \|\| palette\.isOpen \|\| placeDialog\.isOpen \|\| settingsPanel\.isOpen \|\| mapOverlay\.owner === 'map',/);
    // The world's input as the page attaches it: a slider focused in the screen keeps every key; the world handles none
    // (no action, nothing held, nothing default-prevented, so the browser moves the slider and presses the button).
    const actions: string[] = [];
    const input = attachInput(canvas as unknown as HTMLElement, {
      onAction: (a) => actions.push(a),
      onLook: () => {},
      isTextFocus: () => worldIgnoresKeys(dom.document.activeElement, [{ panel, root: dom.el('settings-panel') }]),
      active: () => true,
      doc: dom.document as unknown as Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>,
      win: new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    });
    dom.el('setting-fov').focus();
    for (const [code, key] of [['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'], ['Space', ' '], ['KeyW', 'w'], ['KeyG', 'g'], ['KeyH', 'h'], ['KeyE', 'e']] as const) {
      const e = keydown(code, key);
      dom.document.dispatchEvent(e);
      expect(e.defaultPrevented, code).toBe(false);
    }
    expect(actions).toEqual([]);
    expect(input.held.size).toBe(0);
    expect(panel.isOpen).toBe(true);
    // A focused select and a focused button (Space presses it) too.
    for (const id of ['setting-rd', 'settings-close']) {
      dom.el(id).focus();
      const space = keydown('Space', ' ');
      dom.document.dispatchEvent(space);
      expect(space.defaultPrevented, id).toBe(false);
    }
    expect(actions).toEqual([]);
    // With the focus back on the page, G reaches the world again and closes the screen.
    dom.el('settings-close').blur();
    const gKey = keydown('KeyG', 'g');
    dom.document.dispatchEvent(gKey);
    expect(gKey.defaultPrevented).toBe(true);
    expect(actions).toEqual(['settings']);
    g();
    expect(panel.isOpen).toBe(false);
    expect(log).toEqual(['palette.close', 'help.close', 'panel.close']);
    // Closed, a focused slider is no longer the screen's: H and F1 work there as before (final review C-I2).
    dom.el('setting-fov').focus();
    const h = keydown('KeyH', 'h');
    dom.document.dispatchEvent(h);
    expect(h.defaultPrevented).toBe(true);
    expect(actions).toEqual(['settings', 'help']);
    input.dispose();
    panel.dispose();
  });

  test('a control left focused in a closed panel, hidden, is no open panel\'s: after the Settings screen or the palette closes, H opens and closes the help and G reaches the world (review I1)', () => {
    // The page's panels and its H, G and E, as `worldPage.ts` wires them.
    const panel = mountSettingsPanel(dom.body as unknown as HTMLElement, {
      settings: SETTINGS_DEFAULTS, onSettings: () => {}, rdMax: 16, defaultRd: 12, onClose: () => {},
    });
    const help = mountHelp(dom.body as unknown as HTMLElement, {
      map: DEFAULT_KEYMAP, report: REPORT, evaluation: evaluateWorldCapabilities(REPORT), rdMax: 16,
      openMap: () => {}, openSettings: () => panel.open(), worldsMenu: () => {}, onFullscreen: () => {}, onClose: () => {},
    });
    const palette = mountPalette(dom.body as unknown as HTMLElement, { hotbar: createHotbar(null), requestLock: () => {}, onClose: () => {} });
    const actions: string[] = [];
    const canvas = dom.document.createElement('canvas');
    const input = attachInput(canvas as unknown as HTMLElement, {
      onAction: (a) => {
        actions.push(a);
        if (a === 'help') {
          paletteFirst(palette, () => {
            if (help.isOpen) help.close();
            else {
              panel.close();
              help.open();
            }
          });
        } else if (a === 'settings') {
          settingsKey({ palette, help, dialog: { isOpen: false }, panel, releasePointer: () => {} });
        } else if (a === 'palette' && !palette.isOpen) {
          if (help.isOpen) help.close();
          panel.close();
          palette.open();
        }
      },
      onLook: () => {},
      isTextFocus: () => worldIgnoresKeys(dom.document.activeElement, [
        { panel: help, root: dom.el('world-help') },
        { panel, root: dom.el('settings-panel') },
        { panel: palette, root: dom.el('world-palette') },
      ]),
      active: () => true,
      doc: dom.document as unknown as Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement'>,
      win: new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    });
    const press = (code: string, key: string): void => {
      dom.document.dispatchEvent(keydown(code, key));
    };
    // G, the FOV slider focused, Esc: the screen closes and the slider keeps the focus, hidden.
    press('KeyG', 'g');
    expect(panel.isOpen).toBe(true);
    dom.el('setting-fov').focus();
    press('Escape', 'Escape');
    expect(panel.isOpen).toBe(false);
    expect(dom.document.activeElement).toBe(dom.el('setting-fov'));
    // H opens the help, and H closes it again: the hidden slider is not the help's.
    press('KeyH', 'h');
    expect(help.isOpen).toBe(true);
    press('KeyH', 'h');
    expect(help.isOpen).toBe(false);
    // E, a swatch clicked (a button takes the focus), E: the palette closes from the keyboard, the swatch focused.
    press('KeyE', 'e');
    expect(palette.isOpen).toBe(true);
    dom.el('palette-slot-bricks').focus();
    dom.el('palette-slot-bricks').click();
    press('KeyE', 'e');
    expect(palette.isOpen).toBe(false);
    expect(dom.document.activeElement).toBe(dom.el('palette-slot-bricks'));
    // H opens the help; with it open, G reaches the world (the help closes, the screen opens), then H again.
    press('KeyH', 'h');
    expect(help.isOpen).toBe(true);
    press('KeyG', 'g');
    expect(help.isOpen).toBe(false);
    expect(panel.isOpen).toBe(true);
    press('Escape', 'Escape');
    press('KeyH', 'h');
    expect(help.isOpen).toBe(true);
    press('KeyH', 'h');
    expect(help.isOpen).toBe(false);
    expect(actions).toEqual(['settings', 'help', 'help', 'palette', 'help', 'settings', 'help', 'help']);
    input.dispose();
    help.close();
    palette.dispose();
    panel.dispose();
  });

  test('`worldIgnoresKeys`: a text-entry control always; a select, a slider, a checkbox or a button only inside a panel open now', () => {
    type T = { tagName: string; type?: string; isContentEditable?: boolean };
    const rootOf = (...inside: T[]) => ({ contains: (o: T | null) => o !== null && inside.includes(o) });
    for (const t of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }] as T[]) {
      expect(worldIgnoresKeys(t, []), JSON.stringify(t)).toBe(true);
      expect(worldIgnoresKeys(t, [{ panel: { isOpen: false }, root: rootOf(t) }]), JSON.stringify(t)).toBe(true);
    }
    for (const t of [{ tagName: 'INPUT', type: 'range' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'SELECT' }, { tagName: 'BUTTON' }] as T[]) {
      // No panel, or the control in a closed panel (hidden, still focused) while another panel is open: the world's.
      expect(worldIgnoresKeys(t, []), JSON.stringify(t)).toBe(false);
      expect(worldIgnoresKeys(t, [{ panel: { isOpen: false }, root: rootOf(t) }]), JSON.stringify(t)).toBe(false);
      expect(worldIgnoresKeys(t, [
        { panel: { isOpen: false }, root: rootOf(t) },
        { panel: { isOpen: true }, root: rootOf() },
      ]), JSON.stringify(t)).toBe(false);
      // Inside a panel open now: its own keys.
      expect(worldIgnoresKeys(t, [
        { panel: { isOpen: true }, root: rootOf() },
        { panel: { isOpen: true }, root: rootOf(t) },
      ]), JSON.stringify(t)).toBe(true);
      expect(worldIgnoresKeys(t, [{ panel: { isOpen: true }, root: null }]), JSON.stringify(t)).toBe(false);
    }
    for (const t of [{ tagName: 'BODY' }, { tagName: 'CANVAS' }, null] as (T | null)[]) {
      expect(worldIgnoresKeys(t, [{ panel: { isOpen: true }, root: rootOf(...(t === null ? [] : [t])) }]), JSON.stringify(t)).toBe(false);
    }
    // The page's input: every panel counts (the help, the Settings screen, the palette, B's dialog), each by its
    // root in the host.
    expect(SRC()).toMatch(/isTextFocus: \(\) => worldIgnoresKeys\(document\.activeElement as HTMLElement \| null, keyPanels\),/);
    expect(SRC()).toMatch(/const keyPanels: readonly KeyPanel<HTMLElement>\[\] = \[\s+\{ panel: help, root: host\.querySelector\('#world-help'\) \},\s+\{ panel: settingsPanel, root: host\.querySelector\('#settings-panel'\) \},\s+\{ panel: palette, root: host\.querySelector\('#world-palette'\) \},\s+\{ panel: placeDialog, root: host\.querySelector\('#place-dialog'\) \},\s+\];/);
  });

  test('G with the screen open closes it; with B\'s dialog open G does nothing; the page\'s G, the help\'s "Settings (G)" and the RD control go to the screen', () => {
    const order: string[] = [];
    const panel = { isOpen: true, open: () => { panel.isOpen = true; order.push('open'); }, close: () => { panel.isOpen = false; order.push('close'); } };
    const palette = { isOpen: false, close: () => {} };
    const help = { isOpen: false, close: () => { order.push('help.close'); } };
    settingsKey({ palette, help, dialog: { isOpen: false }, panel, releasePointer: () => { order.push('release'); } });
    expect(order).toEqual(['close']);
    settingsKey({ palette, help, dialog: { isOpen: true }, panel, releasePointer: () => { order.push('release'); } });
    expect(order).toEqual(['close']);
    expect(panel.isOpen).toBe(false);
    const src = SRC();
    expect(src).toMatch(/case 'settings':\s+settingsKey\(\{ palette, help, dialog: placeDialog, panel: settingsPanel, releasePointer: \(\) => document\.exitPointerLock\(\) \}\);/);
    expect(src).toMatch(/openSettings: \(\) => settingsPanel\.open\(\),/);
    expect(src).toMatch(/panel: \{\s+setRd\(r\) \{\s+shownRd = r;\s+settingsPanel\.setRd\(r\);/);
    expect(src).toMatch(/const settingsPanel: SettingsPanel = mountSettingsPanel\(host, \{\s+settings: \{ \.\.\.settings, rd: shownRd \},\s+onSettings: applySettings,\s+rdMax,\s+defaultRd: defaultRenderDistance\(caps\),/);
    expect(src).toMatch(/teardown\.push\(\(\) => settingsPanel\.dispose\(\)\);/);
  });
});

describe('"+ Add at the pin" opens B\'s dialog on the pin\'s ground (SP5b spec §3.7, D13; ruling P34)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const camera = { yaw: 140.5, pitch: -22.25 };
  /** The page's `addAt` over the real dialog and places model, a scripted landing and the notices' log. */
  function setup(o: { landing: () => Promise<{ surface: number; water: number }>; initial?: Place[] }) {
    const requestLock = vi.fn();
    const dialog = mountPlaceDialog(dom.body as unknown as HTMLElement, { requestLock, onClose: () => {} });
    let n = 0;
    const places = createPlaces(o.initial ?? [], () => `p${++n}`);
    const asked: Array<[number, number]> = [];
    const shown: Array<[string, unknown]> = [];
    const addAt = (x: number, z: number): Promise<boolean> => addPlaceAt({
      pool: { landing: (bx, bz) => { asked.push([bx, bz]); return o.landing(); } },
      dialog, places, camera, notices: { show: (text, opts) => { shown.push([text, opts]); } },
    }, x, z);
    return { dialog, places, asked, shown, addAt };
  }
  const enter = (): void => { dom.document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'Enter', key: 'Enter', repeat: false })); };

  test('the dialog for the pin\'s column standing on its ground, looking where the camera looks; Save keeps it', async () => {
    const s = setup({ landing: () => Promise.resolve({ surface: 70, water: -Infinity }) });
    await expect(s.addAt(100.3, -20.7)).resolves.toBe(true);
    // The landing at the pin's block, as the teleport asks it; the feet on its ground, the eye EYE above.
    expect(s.asked).toEqual([[100, -21]]);
    expect(s.dialog.isOpen).toBe(true);
    expect(dom.el('place-name').value).toBe('Place 1 (100, 72, -21)');
    enter();
    expect(s.places.list).toEqual([{ id: 'p1', name: 'Place 1 (100, 72, -21)', colour: 0, x: 100.5, y: 71 + EYE, z: -20.5, yaw: 140.5, pitch: -22.25 }]);
    expect(s.shown).toEqual([[PLACE_SAVED_NOTICE, { timeoutMs: 1500 }]]);
    s.dialog.dispose();
    // Over the sea, standing on the water as a walking teleport arrives (feet max(surface, water) + 1).
    const sea = setup({ landing: () => Promise.resolve({ surface: 40, water: 62 }) });
    await sea.addAt(-7, 9);
    enter();
    expect(sea.places.list[0]!.y).toBe(63 + EYE);
    sea.dialog.dispose();
  });

  test('the page\'s addAt with a rejecting `pool.landing` opens no dialog and shows the teleport\'s failure notice', async () => {
    const s = setup({ landing: () => Promise.reject(new WorkerFailed('boom')) });
    await expect(s.addAt(5, 6)).resolves.toBe(false);
    expect(s.dialog.isOpen).toBe(false);
    expect(s.places.list).toEqual([]);
    expect(s.shown).toEqual([['Could not teleport', { kind: 'warn', timeoutMs: 4000 }]]);
    s.dialog.dispose();
    // A cancel is asked again as the teleport asks it; a fourth fails the same way.
    let calls = 0;
    const c = setup({ landing: () => { calls++; return Promise.reject(new JobCancelled()); } });
    await expect(c.addAt(5, 6)).resolves.toBe(false);
    expect(calls).toBe(4);
    expect(c.dialog.isOpen).toBe(false);
    expect(c.shown).toEqual([['Could not teleport', { kind: 'warn', timeoutMs: 4000 }]]);
    c.dialog.dispose();
  });

  test('with 256 places, `A world holds at most 256 places` and no landing or dialog; with the dialog already open, nothing', async () => {
    const full = setup({ landing: () => Promise.resolve({ surface: 70, water: -Infinity }), initial: Array.from({ length: 256 }, (_, i) => ({ id: `q${i}`, name: `Q${i}`, colour: 0, x: i, y: 70, z: 0, yaw: 0, pitch: 0 })) });
    await expect(full.addAt(1, 2)).resolves.toBe(false);
    expect([full.asked, full.dialog.isOpen]).toEqual([[], false]);
    expect(full.shown).toEqual([[PLACES_FULL_NOTICE, { timeoutMs: 4000 }]]);
    full.dialog.dispose();
    const open = setup({ landing: () => Promise.resolve({ surface: 70, water: -Infinity }) });
    open.dialog.open('B\'s own', () => {});
    await expect(open.addAt(1, 2)).resolves.toBe(false);
    expect(dom.el('place-name').value).toBe('B\'s own');
    open.dialog.dispose();
  });

  test('the page hands the overlay its places: the model, the colours, the place teleport and `addAt`', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    const overlay = src.slice(src.indexOf('    const mapOverlay = createMapOverlay({'));
    expect(overlay.slice(0, overlay.indexOf('    });'))).toMatch(/places: places === null \? null : \{\s+places,\s+colours: PLACE_COLOURS,\s+toPlace: \(p\) => teleporter\.toPlace\(p\),\s+addAt: \(x, z\) => addPlaceAt\(\{/);
    expect(src).toContain('setFeet: (x, feetY, z) => setFeet(walk, x, feetY, z),');
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
    const times: Array<number | undefined> = [];
    const clicks = createClickQueue({ post: (e, t) => { posted.push(e); times.push(t); }, hotbar, fly, walk: createWalkState(), editable: () => editable });
    const aim = createAim({ fly, world: world as never, locked: () => true, hud: true, clicks });
    return {
      aim, clicks, read, posted, hotbar, times,
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

  test('each queued press posts with its own press time (the HUD\'s edit latency starts at the click, spec §4.6; final review UI-3)', () => {
    const r = rig();
    r.clicks.push(0, 1000.25);
    r.clicks.push(0);
    r.aim.aim(r.read, false);
    expect(r.posted).toEqual([BREAK, BREAK]);
    expect(r.times).toEqual([1000.25, undefined]);
    // The page stamps each queued press (a mousedown, a hold repeat) on the edit path's clock and passes it through.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^\s*post: \(edit, t\) => \{ void actionPost\(\[edit\], t\); \},$/m);
    expect(src).toMatch(/^\s*queue: \(b\) => clicks\.push\(b, performance\.now\(\)\),$/m);
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
    expect(src()).toMatch(/post: \(edit, t\) => \{ void actionPost\(\[edit\], t\); \},/);
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
    r.hold.up(0, r.now());
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
    r.hold.up(0, r.now());
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
    r.hold.up(0, r.now());
    await r.frames(1010, 1500);
    expect(r.posts).toHaveLength(1);
    expect(r.record).toHaveBeenCalledTimes(1);
    // The page's mouse buttons go through the hold repeat: a press queues once, a release ends the hold.
    expect(src()).toMatch(/onButton: \(b, down\) => \{\s+if \(down\) holdRepeat\.down\(b, nowS\(\)\);\s+else holdRepeat\.up\(b, nowS\(\)\);\s+\},/);
    expect(src()).toMatch(/enabled: \(\) => settings\.holdRepeat,\s+pending: editPath\.pending,\s+queue: \(b\) => clicks\.push\(b, performance\.now\(\)\),/);
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

  test('the bench\'s review scenes (SP5a spec §6.5): `benchSetTime` fixes the clock at the hour and pauses it; `benchWalk` takes F\'s path once', () => {
    const state = { t: 0.3 };
    const clock = { speed: 60 };
    benchSetTime(state, clock, 12);
    expect([state.t, clock.speed]).toEqual([0.25, 0]);
    expect(clockHours(state.t)).toBe(12);
    benchSetTime(state, clock, 0);
    expect([state.t, clockHours(state.t)]).toEqual([0.75, 0]);
    // A paused clock keeps the hour.
    expect(advanceTime(state.t, 1000, clock.speed)).toBe(0.75);

    const fly = flyAt({ y: 100 });
    const walk = createWalkState();
    const near: number[] = [];
    const repeat = { stop: vi.fn() };
    const o = { fly, walk, world: { setNear: (n: number) => { near.push(n); } }, repeat };
    benchWalk(o, true);
    expect([fly.mode, walk.y, near]).toEqual(['walk', 100 - EYE, [NEAR_WALK]]);
    // Already walking: nothing switches back.
    benchWalk(o, true);
    expect([fly.mode, near]).toEqual(['walk', [NEAR_WALK]]);
    benchWalk(o, false);
    expect([fly.mode, near]).toEqual(['fly', [NEAR_WALK, NEAR_FLY]]);
    expect(repeat.stop).toHaveBeenCalledTimes(2);
    // The bench's world hooks: the clock it steps the frame with, its walk through the page's mode switch.
    expect(src()).toMatch(/timeSpeed: \(\) => benchClock\.speed,/);
    expect(src()).toMatch(/setTime: \(hours\) => benchSetTime\(frame, benchClock, hours\),/);
    expect(src()).toMatch(/walk: \(on\) => benchWalk\(\{ fly, walk, world, repeat: NO_REPEAT \}, on\),/);
  });

  test('a load opens in flight: the page\'s camera starts with `mode: \'fly\'` and a fresh walk state (D1: an unsaved world\'s mode is not remembered; a saved world\'s speed is, its walk applied after the reveal, SP5b spec §3.4 step 5)', () => {
    expect(src()).toMatch(/const fly: FlyState = \{ x: at\.x, y: clamp\(view\.y, Y_MIN, Y_MAX\), z: at\.z, yaw: view\.yaw, pitch: view\.pitch, vx: 0, vy: 0, vz: 0, speed: restored\?\.speed \?\? SPEED_DEFAULT, mode: 'fly' \};\s+const walk = createWalkState\(\);/);
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

  test('Ctrl+wheel steps the slot while walking, the speed while flying', () => {
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

describe('opening a saved world (SP5b spec §3.4 steps 2-3, D14, D22)', () => {
  const FIXTURE = new URL('../fixtures/sp5bWorldParams.json', import.meta.url);
  const fixture = (): { schemaVersion: number; params: JsonObject } =>
    JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schemaVersion: number; params: JsonObject };
  const key = (() => {
    const p = loadParams({ ...fixture(), profile: 'default' });
    if (!p.ok) throw new Error('fixture');
    return hex64(genKey([1, 2], stageHashes(p.value)));
  })();
  const ID = 'w1';
  const record = (over: Partial<WorldRecord> = {}): WorldRecord => ({
    id: ID, name: 'My world', seedText: 'hello', seed: [1, 2], profile: 'default', params: fixture().params,
    schemaVersion: fixture().schemaVersion, paramsHash: '0123456789abcdef', generatorVersion: 5, genKey: key,
    stateTable: todayStateTable(), created: 1_000, backupOf: null, ...over,
  });
  /** A world created as the menu's Create writes it: `worlds` and `state`, no `history` (§1.2). */
  async function created(over: Partial<WorldRecord> = {}): Promise<{ kv: MemoryKV; saves: ReturnType<typeof createSaves> }> {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    expect((await saves.create(record(over), newState(ID, STATE_BOUNDS))).status).toBe('complete');
    return { kv, saves };
  }
  const put = (kv: KV, store: 'worlds' | 'state' | 'history', value: unknown) => kv.write([{ op: 'put', store, key: ID, value }]);
  const everything = (kv: MemoryKV) => (['worlds', 'state', 'history', 'diffs', 'meta'] as const).map((st) => [st, kv.dump(st)]);
  /** Today's table with ids 1 and 2 swapped: stored 1 is today's 2 and stored 2 today's 1. */
  const permuted = (): string[] => {
    const t = todayStateTable();
    [t[1], t[2]] = [t[2]!, t[1]!];
    return t;
  };
  const random = (): [number, number] => [7, 7];
  /** `unreadable` with `reason` (the menu shows "This world could not be opened: <reason>"). */
  const unreadable = (reason: string) => ({ ok: false, refusal: { notice: 'unreadable', reason } });
  /** A `sessionStorage` over a Map. */
  function sessionStore(): StorageLike & { readonly map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
  }
  /** The page's `refuseOpen` of an ordinary (not enter-bench) load: the URL it leaves for, and the session storage. */
  function refused(refusal: OpenRefusal) {
    const storage = sessionStore();
    const left: string[] = [];
    const failed: string[] = [];
    refuseOpen(refusal, { enterBench: false, storage, leave: (url) => left.push(url), fail: (t) => failed.push(t) });
    expect(failed).toEqual([]);
    return { left, storage };
  }
  /** A lock manager that grants every request at once; `held()` counts the holds not yet released. */
  function freeLocks() {
    let held = 0;
    const locks: LockManagerLike = {
      request(_name, _o, cb) {
        held++;
        return Promise.resolve().then(() => cb({})).finally(() => { held--; });
      },
    };
    return { locks, held: () => held };
  }
  let free = freeLocks();
  beforeEach(() => {
    free = freeLocks();
  });
  /** Lets the promise jobs queued so far run. */
  const jobs = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  test('Review Focus 2: with a lock manager that never grants, the page navigates to `/?notice=locked` (the menu shows `This world is open in another tab`), reads nothing, and the in-process sim receives no `load`', async () => {
    const { kv } = await created();
    const ops = kv.opCount;
    let opens = 0;
    const open = (): Promise<KV> => {
      opens++;
      return Promise.resolve(kv);
    };
    // Another tab keeps the world past the page's wait: the request ends with the wait's abort, never granted.
    const requests: Array<{ name: string; signal: boolean }> = [];
    const never: LockManagerLike = {
      request(name, o) {
        requests.push({ name, signal: o.signal instanceof AbortSignal });
        return Promise.reject(new DOMException('The lock request timed out', 'TimeoutError'));
      },
    };
    const types: string[] = [];
    const handler = createSimHandler({ openKV: async () => kv });
    const sim = createSimClient(() => inProcessSimWorker({
      ...handler,
      handle(msg, post) {
        types.push((msg as { type: string }).type);
        handler.handle(msg, post);
      },
    }, () => 0), { onFailure() {} });
    // The page's run(): the open first, the sim's `load` only from an opened world (`saved.load`), a refusal to the menu.
    const left: string[] = [];
    const storage = sessionStore();
    const page = async (locks: LockManagerLike) => {
      const r = await openSavedWorld({ locks, open, db: 'wi10', id: ID, bounds: STATE_BOUNDS, random });
      if (r.ok) void sim.load(r.opened.load).catch(() => {});
      else refuseOpen(r.refusal, { enterBench: false, storage, leave: (url) => left.push(url), fail: () => { throw new Error('not an enter bench load'); } });
      await jobs();
      return r;
    };
    expect(await page(never)).toEqual({ ok: false, refusal: { notice: 'locked' } });
    expect(left).toEqual(['/?notice=locked']);
    expect(noticeOfQuery(new URLSearchParams('notice=locked'), storage)).toBe('This world is open in another tab');
    expect(requests).toEqual([{ name: 'wi10.world.w1', signal: true }]);
    expect([opens, kv.opCount - ops]).toEqual([0, 0]);
    await vi.waitFor(() => expect(types).toEqual([]));
    // The same page with the lock granted reads the world and posts its `load`.
    const r = await page(free.locks);
    expect(r.ok).toBe(true);
    expect(opens).toBe(1);
    await vi.waitFor(() => expect(types).toEqual(['load']));
    if (r.ok) r.opened.lock.release();
    sim.dispose();
  });

  test('without Web Locks (an insecure context\'s `navigator.locks` undefined) the open is refused as storage not available, nothing read', async () => {
    const { kv } = await created();
    const ops = kv.opCount;
    const r = await openSavedWorld({ locks: null, open: () => Promise.resolve(kv), db: 'wi10', id: ID, bounds: STATE_BOUNDS, random });
    expect(r).toEqual(unreadable('storage is not available in this browser window'));
    expect(kv.opCount).toBe(ops);
  });

  test('`readSavedWorld` of a created world → ok with `newState`\'s defaults and `notices` `[]`', async () => {
    const { saves } = await created();
    const r = await readSavedWorld(saves, ID, STATE_BOUNDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.world).toEqual(record());
    expect(r.state).toEqual(newState(ID, STATE_BOUNDS));
    // A new world has no `history` record: none, and no notice (it is not an unreadable one).
    expect(r.history).toEqual({ worldId: ID, done: [], undone: [] });
    expect(r.notices).toEqual([]);
    const p = loadParams(record());
    expect(p.ok && r.params).toEqual(p.ok ? p.value : null);
  });

  test('a missing record → `{ok: false}`', async () => {
    const { saves } = await created();
    const r = await readSavedWorld(saves, 'nope', STATE_BOUNDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no saved world has this id');
  });

  test('a record `parseWorldRecord` refuses → `{ok: false}` with its reason', async () => {
    const { kv, saves } = await created();
    const bad = { ...record(), seed: [1] };
    await put(kv, 'worlds', bad);
    const r = await readSavedWorld(saves, ID, STATE_BOUNDS);
    const parsed = parseWorldRecord(bad);
    expect(parsed.ok).toBe(false);
    expect(r).toEqual({ ok: false, reason: parsed.ok ? '' : parsed.reason });
    expect(r.ok ? '' : r.reason).toContain('seed');
  });

  test('a state `\'garbage\'` → the reset notice and defaults; a history `7` → the history notice and none', async () => {
    const { kv, saves } = await created();
    await put(kv, 'state', 'garbage');
    await put(kv, 'history', 7);
    const r = await readSavedWorld(saves, ID, STATE_BOUNDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toEqual(newState(ID, STATE_BOUNDS));
    expect(r.history).toEqual({ worldId: ID, done: [], undone: [] });
    expect(r.notices).toEqual([STATE_RESET_NOTICE, HISTORY_RESET_NOTICE]);
    expect(STATE_RESET_NOTICE).toBe('This world\'s position, time, hotbar and places could not be read and were reset');
    expect(HISTORY_RESET_NOTICE).toBe('This world\'s undo history could not be read');
  });

  test('a permuted `stateTable`: the history\'s values remapped', async () => {
    const { kv, saves } = await created({ stateTable: permuted() });
    const history: HistoryRecord = {
      worldId: ID,
      done: [{ edits: [{ x: 1, y: 64, z: 2, before: NO_VALUE, after: 1 << 8 }, { x: 1, y: 65, z: 2, before: (2 << 8) | 3, after: 0 }] }],
      undone: [{ edits: [{ x: -5, y: 70, z: 9, before: 0, after: 2 << 8 }] }],
    };
    await put(kv, 'history', history);
    const r = await readSavedWorld(saves, ID, STATE_BOUNDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.history).toEqual({
      worldId: ID,
      done: [{ edits: [{ x: 1, y: 64, z: 2, before: NO_VALUE, after: 2 << 8 }, { x: 1, y: 65, z: 2, before: (1 << 8) | 3, after: 0 }] }],
      undone: [{ edits: [{ x: -5, y: 70, z: 9, before: 0, after: 1 << 8 }] }],
    });
    expect(r.notices).toEqual([]);
    // Today's table: the values as stored.
    await put(kv, 'worlds', record());
    const same = await readSavedWorld(saves, ID, STATE_BOUNDS);
    expect(same.ok && same.history).toEqual(history);
  });

  test('params a tree validator refuses (`openSavedSession(…).initNotice` set) → not opened: the reason in sessionStorage and `/?notice=unreadable`; nothing written, no `load` posted', async () => {
    const tree = densityTree();
    tree['root'].b.x = { op: 'bogus' };
    const params = fixture().params;
    const { kv } = await created({ params: { ...params, density: { ...(params['density'] as JsonObject), defs: tree } } });
    const before = everything(kv);
    const ops = kv.opCount;
    const r = await openSavedWorld({ locks: free.locks, open: () => Promise.resolve(kv), db: 'wi10', id: ID, bounds: STATE_BOUNDS, random });
    const reason = 'invalid patch (density.defs.root.b.x UNKNOWN_OP); opened the default profile with no changes';
    expect(r).toEqual(unreadable(reason));
    if (!r.ok) {
      const { left, storage } = refused(r.refusal);
      expect(left).toEqual(['/?notice=unreadable']);
      expect(storage.map.get(REFUSAL_REASON_KEY)).toBe(reason);
      expect(noticeOfQuery(new URLSearchParams('notice=unreadable'), storage)).toBe(`This world could not be opened: ${reason}`);
    }
    // Only an opened world carries the `load` the page posts after the attach.
    expect('opened' in r).toBe(false);
    expect(everything(kv)).toEqual(before);
    expect(kv.opCount).toBe(ops);
    // The refusal closed the page's connection and released the world's lock.
    expect((await put(kv, 'state', 'x')).status).toBe('closed');
    await jobs();
    expect(free.held()).toBe(0);
  });

  test('a missing or refused record and an opener that rejects or throws → not opened (`/?notice=unreadable` with the reason), nothing written (ruling P6)', async () => {
    const { kv } = await created();
    const before = everything(kv);
    const open = (id: string, o: () => Promise<KV>) => openSavedWorld({ locks: free.locks, open: o, db: 'wi10', id, bounds: STATE_BOUNDS, random });
    const missing = await open('nope', () => Promise.resolve(kv));
    expect(missing).toEqual(unreadable('no saved world has this id'));
    if (!missing.ok) {
      const { left, storage } = refused(missing.refusal);
      expect(left).toEqual(['/?notice=unreadable']);
      expect(storage.map.get(REFUSAL_REASON_KEY)).toBe('no saved world has this id');
    }
    expect(everything(kv)).toEqual(before);
    const storage = unreadable('storage is not available in this browser window');
    expect(await open(ID, () => Promise.reject(new Error('blocked')))).toEqual(storage);
    expect(await open(ID, () => { throw new ReferenceError('indexedDB is not defined'); })).toEqual(storage);
    // Each refusal released the world's lock.
    await jobs();
    expect(free.held()).toBe(0);
  });

  test('an opened world: its session from the record, the `load` the page posts and the kept record', async () => {
    const { kv } = await created();
    await put(kv, 'state', { ...newState(ID, STATE_BOUNDS), flushSeq: 4, updated: 9_000 });
    const r = await openSavedWorld({ locks: free.locks, open: () => Promise.resolve(kv), db: 'wi10', id: ID, bounds: STATE_BOUNDS, random });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.opened;
    expect(o.kv).toBe(kv);
    expect([o.session.initNotice, o.session.state.seedText, o.session.state.profile]).toEqual([null, 'hello', 'default']);
    // The session's params are the record's (`loadParams`): today's genKey for the record's seed is its stored one.
    const p = loadParams(record());
    expect(p.ok && o.session.state.params).toEqual(p.ok ? p.value : null);
    expect(hex64(genKey([1, 2], stageHashes(o.session.state.params)))).toBe(key);
    expect(o.load).toEqual({ db: 'wi10', worldId: ID, flushSeq: 4, genKey: key, updated: 9_000, stateTable: todayStateTable(), rewrite: null });
    expect(o.kept).toEqual(record());
    expect(o.notices).toEqual([]);
    // The opened world holds its lock until the page releases it (§3.5).
    await jobs();
    expect(free.held()).toBe(1);
    o.lock.release();
    await jobs();
    expect(free.held()).toBe(0);
  });

  test('a saved world\'s session is not writable after the open; an unsaved world\'s is (SP5b spec §3.6, D10, D25; ruling P29)', async () => {
    const { kv } = await created();
    const r = await openSavedWorld({ locks: free.locks, open: () => Promise.resolve(kv), db: 'wi10', id: ID, bounds: STATE_BOUNDS, random });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.opened.session;
    const opened = s.state;
    expect(s.writable).toBe(false);
    // The modification mode is off at the open: a terrain change changes nothing.
    s.setSeedText('77');
    expect(s.state).toBe(opened);
    r.opened.lock.release();
    // An unsaved world's session (run()'s `openMapSession`) edits live.
    const unsaved = openMapSession(DEFAULT_MAP_STATE, random);
    expect(unsaved.writable).toBe(true);
    expect(unsaved.setSeedText('77').seedText).toBe('77');
  });

  test('after a permuted-table open, the kept record\'s `stateTable` equals `todayStateTable()`', async () => {
    const { kv } = await created({ stateTable: permuted() });
    const history: HistoryRecord = { worldId: ID, done: [{ edits: [{ x: 0, y: 64, z: 0, before: NO_VALUE, after: 1 << 8 }] }], undone: [] };
    await put(kv, 'history', history);
    const r = await openSavedWorld({ locks: free.locks, open: () => Promise.resolve(kv), db: 'wi10', id: ID, bounds: STATE_BOUNDS, random });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { kept, load } = r.opened;
    expect(kept.stateTable).toEqual(todayStateTable());
    expect(kept).toEqual({ ...record(), stateTable: todayStateTable() });
    // The sim reads the stored ids through the stored table and writes today's record and the remapped history (D22).
    expect(load.stateTable).toEqual(permuted());
    expect(load.rewrite).toEqual({ world: kept, history: { worldId: ID, done: [{ edits: [{ x: 0, y: 64, z: 0, before: NO_VALUE, after: 2 << 8 }] }], undone: [] } });
    expect(r.opened.history).toEqual(load.rewrite!.history);
  });

  test('`openRequest`: an equal table → no rewrite; a prefix → today\'s record and no history; another → both', () => {
    const state = { ...newState(ID, STATE_BOUNDS), flushSeq: 2, updated: 5 };
    const history: HistoryRecord = { worldId: ID, done: [], undone: [] };
    const equal = openRequest('db', record(), state, history);
    expect(equal.load.rewrite).toBeNull();
    expect(equal.kept).toEqual(record());
    const prefix = openRequest('db', record({ stateTable: todayStateTable().slice(0, -1) }), state, history);
    expect(prefix.load.rewrite).toEqual({ world: record(), history: null });
    expect(prefix.kept).toEqual(record());
    const other = openRequest('db', record({ stateTable: permuted() }), state, history);
    expect(other.load.rewrite).toEqual({ world: record(), history });
    expect(other.load).toMatchObject({ db: 'db', worldId: ID, flushSeq: 2, updated: 5, genKey: key, stateTable: permuted() });
  });

  test('an enter bench\'s load (`?enterBench=1`) is refused in place, on the failure panel, so the bench records the error; the page hands every refusal to `refuseOpen` and leaves with `location.replace`', () => {
    const left: string[] = [];
    const failed: string[] = [];
    const storage = sessionStore();
    const o = { enterBench: true, storage, leave: (url: string) => left.push(url), fail: (t: string) => failed.push(t) };
    refuseOpen({ notice: 'locked' }, o);
    refuseOpen({ notice: 'unreadable', reason: 'no saved world has this id' }, o);
    expect(failed).toEqual(['This world is open in another tab', 'This world could not be opened: no saved world has this id']);
    expect([left, storage.map.size]).toEqual([[], 0]);
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    const run = src.slice(src.indexOf('const r = await openSavedWorld('), src.indexOf('saved = r.opened;'));
    expect(run).toMatch(/if \(!r\.ok\) \{\n\s+refuseOpen\(r\.refusal, \{\n\s+enterBench: q\.enterBench,\n\s+storage: sessionStorageOrNull\(\),/);
    expect(run).toMatch(/location\.replace\(url\);/);
    expect(run).toMatch(/fail: \(text\) => fail\(text, null\),/);
  });
});

describe('a world from an older generator (SP5b spec §3.4 step 4, §3.6, D8)', () => {
  const FIXTURE = new URL('../fixtures/sp5bWorldParams.json', import.meta.url);
  const fixture = (): { schemaVersion: number; params: JsonObject } =>
    JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schemaVersion: number; params: JsonObject };
  const loaded = (() => {
    const p = loadParams({ ...fixture(), profile: 'default' });
    if (!p.ok) throw new Error('fixture');
    return p.value;
  })();
  /** Today's genKey and paramsHash for the record's seed and params (what the first configure's `ReadyMsg` carries). */
  const today = hex64(genKey([1, 2], stageHashes(loaded)));
  const todayHash = hex64(paramsHash(loaded));
  const STALE = 'ffffffffffffffff';
  const ID = 'w1';
  const record = (over: Partial<WorldRecord> = {}): WorldRecord => ({
    id: ID, name: 'My world', seedText: 'hello', seed: [1, 2], profile: 'default', params: fixture().params,
    schemaVersion: fixture().schemaVersion, paramsHash: '0123456789abcdef', generatorVersion: 4, genKey: STALE,
    stateTable: todayStateTable(), created: 1_000, backupOf: null, ...over,
  });
  const locks: LockManagerLike = { request: (_name, _o, cb) => Promise.resolve().then(() => cb({})) };
  const SRC = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');

  /**
   * The saved world's page from the open to the reveal, as `run()` composes it: `openSavedWorld` over a MemoryKV holding
   * `world`, the sim (the real handler, in process) loaded, `openOlderGenerator` with today's genKey as the first
   * configure's `ReadyMsg` carries it, the autosave (its timer's tick driven by the test), and `revealOlderGenerator`.
   * `types` lists every message the sim receives.
   */
  async function openPage(world: WorldRecord) {
    const kv = createMemoryKV();
    expect((await createSaves(kv).create(world, newState(ID, STATE_BOUNDS))).status).toBe('complete');
    const r = await openSavedWorld({ locks, open: () => Promise.resolve(kv), db: 'wi10', id: ID, bounds: STATE_BOUNDS, random: () => [7, 7] });
    if (!r.ok) throw new Error('not opened');
    const opened = r.opened;
    const types: string[] = [];
    const handler = createSimHandler({ openKV: async () => kv });
    const failures: Error[] = [];
    const sim = createSimClient(() => inProcessSimWorker({
      ...handler,
      handle(msg, post) {
        types.push((msg as { type: string }).type);
        handler.handle(msg, post);
      },
    }, () => 0), { onFailure: (e) => { failures.push(e); } });
    expect((await sim.load(opened.load)).type).toBe('loaded');
    const generator = openOlderGenerator({ kept: opened.kept, readyGenKey: today, sim });
    const results: FlushedMsg[] = [];
    const autosave = createPageAutosave({
      worldId: ID,
      fly: { x: 0.5, y: 100, z: 0.5, yaw: 0, pitch: 0, mode: 'fly', speed: SPEED_DEFAULT },
      frame: { t: 0.5 },
      speedIndex: () => 0,
      storedTime: null,
      hotbar: () => opened.state.hotbar,
      blockHistory: { snapshot: () => ({ done: [], undone: [] }), version: 0 },
      sim,
      settled: () => Promise.resolve(),
      editsSince: () => 0,
      now: () => 1_700_000_000_000,
      clock: {
        now: () => performance.now(),
        setInterval: () => 0,
        clearInterval: () => {},
        setTimeout: (f, ms) => setTimeout(f, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id),
      },
      events: { on: () => () => {}, hidden: () => false },
      onResult: (res) => { results.push(res); },
    });
    const shown: Array<[string, unknown]> = [];
    revealOlderGenerator(generator, { notices: { show: (text, o) => { shown.push([text, o]); } }, autosave });
    return {
      kv, opened, generator, autosave, results, shown, types, failures,
      close() {
        autosave.dispose();
        sim.dispose();
        opened.lock.release();
      },
    };
  }

  test('D8\'s notice text and its 8 s', () => {
    expect(OLDER_GENERATOR_NOTICE).toBe('This world was made with an earlier generator version; it opens with today\'s terrain and your blocks stay at their coordinates.');
    expect(OLDER_GENERATOR_NOTICE_MS).toBe(8000);
  });

  test('`olderGeneratorRecord`: an equal genKey → null; another → the kept record with today\'s genKey, `GENERATOR_VERSION` and the params\' `paramsHash`', () => {
    expect(olderGeneratorRecord(record({ genKey: today }), today)).toBeNull();
    expect(olderGeneratorRecord(record(), today)).toEqual(record({ genKey: today, generatorVersion: GENERATOR_VERSION, paramsHash: todayHash }));
  });

  test('a stored genKey ≠ today\'s → the notice once (8 s), one `record` with today\'s genKey and version, posted with the next tick', async () => {
    const p = await openPage(record());
    expect(p.generator.older).toBe(true);
    expect(p.shown).toEqual([[OLDER_GENERATOR_NOTICE, { kind: 'info', timeoutMs: OLDER_GENERATOR_NOTICE_MS }]]);
    await vi.waitFor(() => expect(p.types.filter((t) => t === 'record')).toEqual(['record']));
    // Sent, not yet written: the stored record is the old one until a flush commits it.
    expect(p.kv.dump('worlds')).toEqual([[ID, record()]]);
    // The first tick after the reveal posts (the record counts as a change), and its flush writes the record.
    await p.autosave.tick();
    await vi.waitFor(() => expect(p.results.map((r) => r.ok)).toEqual([true]));
    expect(p.kv.dump('worlds')).toEqual([[ID, record({ genKey: today, generatorVersion: GENERATOR_VERSION, paramsHash: todayHash })]]);
    // Nothing else changed: the next tick posts nothing, and no second `record` or notice follows.
    await p.autosave.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(p.types.filter((t) => t === 'flush' || t === 'record')).toEqual(['record', 'flush']);
    expect(p.shown).toHaveLength(1);
    expect(p.failures).toEqual([]);
    p.close();
  });

  test('equal → no notice, no `record`', async () => {
    const p = await openPage(record({ genKey: today, generatorVersion: GENERATOR_VERSION }));
    expect(p.generator).toEqual({ older: false, kept: p.opened.kept });
    expect(p.shown).toEqual([]);
    await p.autosave.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(p.types).toEqual(['load']);
    expect(p.results).toEqual([]);
    p.close();
  });

  test('after an older-generator open, the page\'s kept record carries today\'s genKey (and today\'s table after a rewrite)', async () => {
    const p = await openPage(record());
    expect(p.generator.kept).toEqual(record({ genKey: today, generatorVersion: GENERATOR_VERSION, paramsHash: todayHash }));
    p.close();
    const t = todayStateTable();
    [t[1], t[2]] = [t[2]!, t[1]!];
    const q = await openPage(record({ stateTable: t }));
    expect(q.generator.kept).toEqual(record({ genKey: today, generatorVersion: GENERATOR_VERSION, paramsHash: todayHash, stateTable: todayStateTable() }));
    q.close();
  });

  test('the page wires it: the check after the load and the first configure, the notice and the change at the autosave\'s creation', () => {
    const src = SRC();
    expect(src).toMatch(/const firstReady = await workers\.configure\(session\.state\.seedText, session\.state\.params\);\n\s+await simAttached;\n\s+if \(state !== 'loading'\) return;\n(\s+\/\/.*\n)+\s+const generator = saved === null \? null : openOlderGenerator\(\{ kept: saved\.kept, readyGenKey: firstReady\.genKey, sim: simClient! \}\);/);
    expect(src).toMatch(/teardown\.push\(worldLock!\.onRelease\(\(\) => a\.dispose\(\)\)\);\n(\s+\/\/.*\n)*\s+revealOlderGenerator\(generator!, \{ notices, autosave: a \}\);/);
  });
});

describe('the unsaved world\'s notice (SP5b spec Point 2, §1.1, D14)', () => {
  const query = (s: string) => parseWorldQuery(new URLSearchParams(s));

  test('an unsaved `?at` world shows Point 2\'s notice; a saved world, the bench and an `?at=…&enterBench=1` load do not', () => {
    expect(UNSAVED_NOTICE).toBe('This world is not saved: it was opened from a link. Use New world on the start screen to keep one.');
    expect(unsavedNoticeOf(query('at=10,20'), {})).toBe(UNSAVED_NOTICE);
    expect(unsavedNoticeOf(query('rd=8'), {})).toBe(UNSAVED_NOTICE);
    expect(unsavedNoticeOf(query('workers=4'), {})).toBe(UNSAVED_NOTICE);
    expect(unsavedNoticeOf(query('world=w1'), {})).toBeNull();
    expect(unsavedNoticeOf(query('world=w1&rd=8'), {})).toBeNull();
    expect(unsavedNoticeOf(query('at=10,20&enterBench=1'), {})).toBeNull();
    expect(unsavedNoticeOf(query('at=10,20&shot=1'), {})).toBeNull();
    // The bench and the flight (their routes' options).
    const bench = { bench: {} as NonNullable<WorldPageOptions['bench']> };
    expect(unsavedNoticeOf(query('rd=12'), bench)).toBeNull();
    expect(unsavedNoticeOf(query('rd=12'), { flight: () => {} })).toBeNull();
    // The page shows it with the world's notices, until dismissed.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const unsaved = unsavedNoticeOf\(q, opts\);\n\s+if \(unsaved !== null\) notices\.show\(unsaved, \{ kind: 'warn' \}\);/);
  });

  test('an in-place unsaved world with `unsavedNotice` shows that text instead', () => {
    const text = 'This world is not saved: this browser window cannot store data.';
    expect(unsavedNoticeOf(query(''), { unsavedNotice: text })).toBe(text);
    expect(unsavedNoticeOf(query(''), { unsavedNotice: null })).toBeNull();
    // A saved world never shows it.
    expect(unsavedNoticeOf(query('world=w1'), { unsavedNotice: text })).toBeNull();
  });
});

describe('restoring the player in a saved world: pose, mode, flying speed, time (SP5b spec §3.4 step 5, D4)', () => {
  const ID = 'w1';
  const query = (s: string) => parseWorldQuery(new URLSearchParams(s));
  const player = { x: 100.5, y: 80.25, z: -40.75, yaw: 90, pitch: -20, mode: 'walk' as const, speed: 30 };
  const withPlayer = (): StateRecord => ({ ...newState(ID, STATE_BOUNDS), player: { ...player } });

  test('player `{x: 100.5, y: 80.25, z: -40.75, yaw: 90, pitch: -20, mode: \'walk\', speed: 30}` → centre (100.5, −40.75), view `{y: 80.25, yaw: 90, pitch: -20}`, speed 30, walk true', () => {
    const s = restoredStart(withPlayer(), query(`world=${ID}`), null);
    expect(s.centre).toEqual({ x: 100.5, z: -40.75 });
    expect(s.view).toEqual({ y: 80.25, yaw: 90, pitch: -20 });
    expect([s.speed, s.walk]).toEqual([30, true]);
    // Flying when left flying.
    expect(restoredStart({ ...withPlayer(), player: { ...player, mode: 'fly' } }, query(`world=${ID}`), null).walk).toBe(false);
  });

  test('`?at=1,2&y=5&yaw=10&pitch=3` beside `?world` is ignored', () => {
    const q = query(`world=${ID}&at=1,2&y=5&yaw=10&pitch=3`);
    expect([q.at, q.y, q.yaw, q.pitch]).toEqual([{ x: 1, z: 2 }, 5, 10, 3]);
    expect(restoredStart(withPlayer(), q, null)).toEqual(restoredStart(withPlayer(), query(`world=${ID}`), null));
    // With no saved pose: the spawn search and `firstView`'s own choices, not the query's.
    const fresh = restoredStart(newState(ID, STATE_BOUNDS), q, null);
    expect(fresh.centre).toBeNull();
    expect(fresh.view).toEqual({ y: null, yaw: null, pitch: null });
  });

  test('`player: null` → centre null, speed 12, flying, `t` 1/12, `speedIndex` 0', () => {
    const s = restoredStart(newState(ID, STATE_BOUNDS), query(`world=${ID}`), null);
    expect(s).toEqual({ centre: null, view: { y: null, yaw: null, pitch: null }, speed: 12, t: 1 / 12, speedIndex: 0, walk: false, saveClock: true });
    expect(s.speed).toBe(SPEED_DEFAULT);
  });

  test('`time {t: 0.5, speedIndex: 2}` → 0.5 and 2', () => {
    const s = restoredStart({ ...withPlayer(), time: { t: 0.5, speedIndex: 2 } }, query(`world=${ID}`), null);
    expect([s.t, s.speedIndex, s.saveClock]).toEqual([0.5, 2, true]);
  });

  test('a `?shot=1&time=12` capture (`fixedT` 0.25): `t` 0.25, `saveClock` false', () => {
    const q = query(`world=${ID}&shot=1&time=12`);
    expect([q.shot, q.time]).toEqual([true, 12]);
    const fixedT = timeOfHours(q.time!);
    expect(fixedT).toBe(0.25);
    const s = restoredStart({ ...withPlayer(), time: { t: 0.5, speedIndex: 2 } }, q, fixedT);
    expect([s.t, s.saveClock]).toEqual([0.25, false]);
    // The stored speed index is still restored; under `fixedT` the clock does not run (`timeSpeed` is 0).
    expect(s.speedIndex).toBe(2);
  });

  test('the page\'s helper that applies `walk` after the reveal calls `switchMode` exactly once', () => {
    const fake = vi.fn();
    restoreMode(restoredStart(withPlayer(), query(`world=${ID}`), null), fake);
    expect(fake).toHaveBeenCalledTimes(1);
    const flying = vi.fn();
    restoreMode(restoredStart(newState(ID, STATE_BOUNDS), query(`world=${ID}`), null), flying);
    expect(flying).not.toHaveBeenCalled();
    // Through F's path: the feet at the saved eye − EYE, with no snap (the pose exactly as left).
    const fly: FlyState = { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, vx: 0, vy: 0, vz: 0, speed: player.speed, mode: 'fly' };
    const walk = createWalkState();
    const near: number[] = [];
    restoreMode({ walk: true }, () => switchMode({ fly, walk, world: { setNear: (n) => { near.push(n); } }, repeat: { stop() {} } }));
    expect([fly.mode, walk.x, walk.y, walk.z, walk.snapPending, near]).toEqual(['walk', 100.5, 80.25 - EYE, -40.75, false, [NEAR_WALK]]);
    // The page applies it once, in the streaming route, after the hold repeat exists.
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src.match(/restoreMode\(/g)).toHaveLength(2);
    expect(src).toMatch(/if \(restored !== null\) restoreMode\(restored, \(\) => switchMode\(\{ fly, walk, world, repeat: holdRepeat \}\)\);/);
  });
});

/** Lets every pending promise job run (a macrotask comes after them all). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('autosave in the saved world: Reloads reopen /?world, navigations and failures save first (SP5b spec §3.2, §3.4 step 7, D4, D14)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const SRC = (): string => readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
  /** Lets the promise jobs queued so far (and the ones they queue) run, without moving the fake clock. */
  const jobs = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const OK = (id: number): FlushedMsg => ({ type: 'flushed', id, ok: true, flushSeq: id, columns: 0, bytes: 0, syncMs: 0, commitMs: 0 });

  /** The page's autosave over a fake sim whose `flush` replies the test settles by hand, on vi's fake timers. */
  function saving(o: { stored?: { t: number; speedIndex: number } | null } = {}) {
    const flushes: Array<{ state: StateRecord; history: HistoryRecord | null; resolve(m: FlushedMsg): void }> = [];
    const fly = { x: 100.5, y: 80.25, z: -40.75, yaw: 90, pitch: -20, mode: 'fly' as const, speed: 30 };
    const frame = { t: 0.5 };
    let hotbarRecord: HotbarRecord = STATE_BOUNDS.normalizeHotbar(null);
    const hotbar = createHotbar(hotbarStorage(() => hotbarRecord, (r) => { hotbarRecord = r; }));
    const history = createBlockHistory({
      post: (): Promise<EditOutcome> => Promise.resolve({ ok: false, why: 'failed' }),
      read: () => 0,
      pending: () => false,
      settled: () => Promise.resolve(),
      notices: { show() {} },
    });
    let edits = 0;
    const autosave = createPageAutosave({
      worldId: 'w 1',
      fly,
      frame,
      speedIndex: () => 2,
      storedTime: o.stored ?? null,
      hotbar: () => hotbarRecord,
      blockHistory: history,
      sim: { flush: (state, history) => new Promise<FlushedMsg>((resolve) => { flushes.push({ state, history, resolve }); }) },
      settled: () => Promise.resolve(),
      editsSince: () => edits,
      now: () => 1_700_000_000_000,
      clock: {
        now: () => Date.now(),
        setInterval: (f, ms) => setInterval(f, ms) as unknown as number,
        clearInterval: (id) => clearInterval(id),
        setTimeout: (f, ms) => setTimeout(f, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id),
      },
      events: { on: () => () => {}, hidden: () => false },
      onResult: () => {},
    });
    return { autosave, flushes, fly, frame, hotbar, history, edit: () => { edits++; } };
  }

  test('in a saved world the failure panel\'s Reload, the context loss\'s Reload and the lower-RD link are `savedWorldUrl`s, never `/?at=`', () => {
    const navigate = vi.fn<(url: string) => void>();
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(navigate, () => {}));
    // The page's URL rules in a saved world: `here` reopens the world, with the RD a Reload carries.
    const url = savedWorldUrlRules('w 1');
    expect(url.here(null)).toBe(savedWorldUrl('w 1', null));
    expect(url.here(10)).toBe('/?world=w%201&rd=10');
    // No writer: an Apply, a view change and a teleport's arrival write nothing (the address stays `/?world=<id>`).
    expect(() => { url.applied(); url.viewChanged(); url.arrived({ x: 1, y: 2, z: 3, yaw: 0, pitch: 0 }); }).not.toThrow();
    notices.failed('Streaming stopped: x', 'details', url.here(reloadRd(12, 8)));
    expect(dom.el('world-failed-reload').href).toBe('/?world=w%201&rd=8');
    let lost: (() => void) | null = null;
    handleContextLoss({ onContextLost: (fn) => { lost = fn; } }, {
      stop: () => {}, closeMap: () => {}, notices, hereHref: () => url.here(reloadRd(null, 8)), onError: (e) => { throw e; },
    });
    lost!();
    expect(dom.el('world-context-reload').href).toBe('/?world=w%201');
    dom.el('world-context-reload').click();
    expect(navigate.mock.calls).toEqual([['/?world=w%201']]);
    // The loading failure's lower-RD link: the saved world at the RD below; an unsaved world keeps `?rd`, `?at` and the hash.
    expect(lowerRdHref(12, { x: 5, z: -7 }, '#abc', 'w 1')).toBe('/?world=w%201&rd=10');
    expect(lowerRdHref(12, { x: 5, z: -7 }, '#abc', null)).toBe('/?rd=10&at=5,-7#abc');
    expect(lowerRdHref(4, { x: 5, z: -7 }, '', 'w 1')).toBeNull();
    expect(lowerRdHref(null, null, '', 'w 1')).toBeNull();
    // The page: the saved world's rules in place of `createWorldUrl` (whose writer is not created), `here` read from them,
    // and the loading screen's link with the query's world.
    const src = SRC();
    expect(src).toMatch(/worldUrl = savedWorldUrlRules\(q\.world\)/);
    const unsaved = src.slice(src.indexOf('if (q.world === null) {\n      const urlWriter'), src.indexOf('worldUrl = savedWorldUrlRules(q.world)'));
    expect(unsaved).toMatch(/createUrlWriter\(/);
    expect(unsaved).toMatch(/worldUrl = createWorldUrl\(\{/);
    expect(src.match(/createUrlWriter\(/g)).toHaveLength(1);
    expect(src).toMatch(/const here = \(rdOf: number \| null\): string => worldUrl\.here\(rdOf\);/);
    expect(src).toMatch(/show: \(\) => notices\.failed\(cause, shown, here\(reloadRd\(q\.rd, liveRd\)\)\),/);
    expect(src).toMatch(/hereHref: \(\) => here\(reloadRd\(q\.rd, liveRd\)\),/);
    expect(src).toMatch(/lowerRd: lowerRdHref\(rd, centre, hashPart, q\.world\)/);
  });

  test('a navigation waits for `beforeLeave`: the URL is set after `flushed`, or after 1,000 ms', async () => {
    const s = saving();
    const navigate = vi.fn<(url: string) => void>();
    const disarm = vi.fn();
    const reloader = createReloader(leaveAfterSave(() => s.autosave, navigate), disarm);
    reloader.reload('/?world=w%201');
    // The guard is disarmed and a flush posted at once; the URL waits for its `flushed`.
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(s.flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(navigate).not.toHaveBeenCalled();
    s.flushes[0]!.resolve(OK(1));
    await jobs();
    expect(navigate.mock.calls).toEqual([['/?world=w%201']]);
    // A reload whose flush is never answered navigates at 1,000 ms.
    const t = saving();
    const later = vi.fn<(url: string) => void>();
    createReloader(leaveAfterSave(() => t.autosave, later), () => {}).reload('/?world=w%201&rd=8');
    expect(t.flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(later).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(later.mock.calls).toEqual([['/?world=w%201&rd=8']]);
    // No autosave (an unsaved world): at once.
    const now = vi.fn<(url: string) => void>();
    createReloader(leaveAfterSave(() => null, now), () => {}).reload('/?at=1,2');
    expect(now.mock.calls).toEqual([['/?at=1,2']]);
    // The page's reloader goes through it, with the page's autosave.
    expect(SRC()).toMatch(/const reloader = createReloader\(leaveAfterSave\(\(\) => autosave, \(url\) => navigateTo\(url, location\)\), disarm\);/);
  });

  test('Worlds menu saves, then navigates to `/`, after `flushed` or 1,000 ms (SP5b spec D31)', async () => {
    // The help as the page mounts it: "Worlds menu" leaves through the page's reloader (`leaveAfterSave`).
    const helpWith = (reloader: ReturnType<typeof createReloader>) => mountHelp(dom.body as unknown as HTMLElement, {
      map: DEFAULT_KEYMAP, report: REPORT, evaluation: evaluateWorldCapabilities(REPORT), rdMax: 16,
      openMap: () => {}, openSettings: () => {}, worldsMenu: () => reloader.reload('/'), onFullscreen: () => {}, onClose: () => {},
    });
    const s = saving();
    const navigate = vi.fn<(url: string) => void>();
    const disarm = vi.fn();
    const help = helpWith(createReloader(leaveAfterSave(() => s.autosave, navigate), disarm));
    help.open();
    dom.el('help-worlds-menu').click();
    // The guard is disarmed and a flush posted at once; `/` waits for its `flushed`.
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(s.flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(navigate).not.toHaveBeenCalled();
    s.flushes[0]!.resolve(OK(1));
    await jobs();
    expect(navigate.mock.calls).toEqual([['/']]);
    // A second click navigates no second time (the reloader leaves once).
    dom.el('help-worlds-menu').click();
    await jobs();
    expect(navigate).toHaveBeenCalledTimes(1);
    help.close();
    dom.body.replaceChildren();
    // A flush that is never answered: `/` at 1,000 ms.
    const t = saving();
    const later = vi.fn<(url: string) => void>();
    helpWith(createReloader(leaveAfterSave(() => t.autosave, later), () => {}));
    dom.el('help-worlds-menu').click();
    expect(t.flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(later).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(later.mock.calls).toEqual([['/']]);
    dom.body.replaceChildren();
    // An unsaved world (no autosave): `/` at once.
    const now = vi.fn<(url: string) => void>();
    helpWith(createReloader(leaveAfterSave(() => null, now), () => {}));
    dom.el('help-worlds-menu').click();
    expect(now.mock.calls).toEqual([['/']]);
    // The page's help leaves through the page's reloader.
    expect(SRC()).toMatch(/worldsMenu: \(\) => reloader\.reload\('\/'\),/);
  });

  test('a failure after the reveal posts one flush and releases the sim only after `flushed` (or 1,000 ms); a failure of the sim itself posts none', async () => {
    const run = (s: ReturnType<typeof saving>, sim: { failed: boolean }) => {
      const order: string[] = [];
      stopAfterFailure({
        stop: () => { order.push('stop'); },
        closeMap: () => { order.push('closeMap'); },
        save: () => lastFlush(s.autosave, sim, { setTimeout: (f, ms) => setTimeout(f, ms) as unknown as number, clearTimeout: (id) => clearTimeout(id) }),
        show: () => { order.push('panel'); },
        release: [() => { order.push('autosave.dispose'); s.autosave.dispose(); }, () => { order.push('sim.dispose'); }],
        onError: (e) => { throw e; },
      });
      return order;
    };
    // `flushed` at 300 ms: the panel and the releases then, the sim's dispose after it.
    const a = saving();
    const order = run(a, { failed: false });
    expect(order).toEqual(['stop', 'closeMap']);
    await jobs();
    expect(a.flushes).toHaveLength(1);
    expect(a.flushes[0]!.state.player).toEqual({ x: 100.5, y: 80.25, z: -40.75, yaw: 90, pitch: -20, mode: 'fly', speed: 30 });
    await vi.advanceTimersByTimeAsync(300);
    expect(order).toEqual(['stop', 'closeMap']);
    a.flushes[0]!.resolve(OK(1));
    await jobs();
    expect(order).toEqual(['stop', 'closeMap', 'panel', 'autosave.dispose', 'sim.dispose']);
    expect(a.flushes).toHaveLength(1);
    // Never answered: released at 1,000 ms.
    const b = saving();
    const slow = run(b, { failed: false });
    await jobs();
    expect(b.flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(slow).toEqual(['stop', 'closeMap']);
    await vi.advanceTimersByTimeAsync(1);
    expect(slow).toEqual(['stop', 'closeMap', 'panel', 'autosave.dispose', 'sim.dispose']);
    // The sim itself failed: nothing posted, released at once.
    const c = saving();
    const dead = run(c, { failed: true });
    await jobs();
    expect(c.flushes).toHaveLength(0);
    expect(dead).toEqual(['stop', 'closeMap', 'panel', 'autosave.dispose', 'sim.dispose']);
    // Without `save` (an unsaved world) the release is synchronous, as SP4b's.
    const sync: string[] = [];
    stopAfterFailure({ stop: () => { sync.push('stop'); }, show: () => { sync.push('panel'); }, release: [() => { sync.push('sim.dispose'); }], onError: () => {} });
    expect(sync).toEqual(['stop', 'panel', 'sim.dispose']);
    // The page: the streaming route's failure saves through `lastFlush` in a saved world, and disposes the autosave
    // before the sim.
    const src = SRC();
    const start = src.indexOf('\n    failAfterReveal = (cause, shown) => {');
    const block = src.slice(start, src.indexOf('\n    };', start + 1));
    expect(block).toMatch(/save: saving === null \? undefined : \(\) => lastFlush\(saving, simClient!, window\),/);
    const release = block.slice(block.indexOf('release: ['));
    expect(release).toMatch(/^\s*\(\) => saving\?\.dispose\(\),$/m);
    expect(release.indexOf('saving?.dispose()')).toBeLessThan(release.indexOf('simClient?.dispose()'));
  });

  test('the saved world\'s sim notice is `SAVED_EDIT_FAILED_NOTICE`', () => {
    expect(SAVED_EDIT_FAILED_NOTICE).toBe('Editing stopped: the edit worker failed; changes after the last save (at most 2 s) are lost');
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const coordinator = { editState: () => 0 as const, simPin: vi.fn(), simUnpin: vi.fn(), markEdited: vi.fn(), simUnpinAll: vi.fn() };
    const editPath = createEditPath({ sim: { failed: false, edits: vi.fn() }, coordinator, latency: createEditLatency(), now: () => 0, notices: { show: vi.fn() } });
    onSimFailure({ store: { markDead: () => {} }, coordinator, editPath, notices, saved: true });
    const text = () => dom.el('world-notices').children.map((d: FakeElement) => d.textContent).join('\n');
    expect(text()).toContain(SAVED_EDIT_FAILED_NOTICE);
    expect(text()).not.toContain(EDIT_FAILED_NOTICE);
    // An unsaved world keeps SP5a's (D29).
    expect(EDIT_FAILED_NOTICE).toBe('Editing stopped: the edit worker failed; this session\'s edits are lost');
    expect(SRC()).toMatch(/simFailure = \(\) => onSimFailure\(\{ store, coordinator, editPath, notices, saved: saved !== null \}\);/);
  });

  test('the page\'s autosave: the pose, the running clock (the stored time while a capture fixes it), the hotbar, the block history, the edits counted from the accepted replies', async () => {
    const s = saving();
    s.frame.t = 0.75;
    s.fly.x = 200.5;
    s.hotbar.select(3);
    void s.autosave.flushNow();
    const posted = s.flushes[0]!;
    expect(posted.state.player).toMatchObject({ x: 200.5, mode: 'fly', speed: 30 });
    expect(posted.state.time).toEqual({ t: 0.75, speedIndex: 2 });
    expect(posted.state.hotbar).toMatchObject({ v: 1, active: 3 });
    expect([posted.state.worldId, posted.state.updated, posted.state.places]).toEqual(['w 1', 1_700_000_000_000, []]);
    // The history as opened is not posted; a recorded step moves its version, and the next post carries both sides.
    expect(posted.history).toBeNull();
    const step: BlockStep = { edits: [{ x: 1, y: 70, z: 2, before: NO_ENTRY, after: STONE << 8 }] };
    s.history.record(step);
    void s.autosave.flushNow();
    expect(s.flushes[1]!.history).toEqual({ worldId: 'w 1', done: [step], undone: [] });
    // A `?shot=1&time=` capture: the stored time is saved unchanged, whatever the frame's clock reads.
    const shot = saving({ stored: { t: 0.1, speedIndex: 1 } });
    void shot.autosave.flushNow();
    expect(shot.flushes[0]!.state.time).toEqual({ t: 0.1, speedIndex: 1 });
    // The edit path's post, counted: an accepted non-empty batch counts one; a refusal and an empty batch none; the
    // promise returned is the path's own.
    const replies: EditOutcome[] = [{ ok: true, prev: Uint32Array.of(0), next: Uint32Array.of(256) }, { ok: false, why: 'changed' }, { ok: true, prev: new Uint32Array(0), next: new Uint32Array(0) }];
    const results = replies.map((r) => Promise.resolve(r));
    let k = 0;
    const counted = countAccepted(() => results[k++]!);
    const edit: Edit = { x: 1, y: 70, z: 2, op: 'set', value: 256, expect: 0 };
    expect(counted.post([edit])).toBe(results[0]);
    void counted.post([edit]);
    void counted.post([]);
    await jobs();
    expect(counted.count()).toBe(1);
    expect(SRC()).toMatch(/const accepted = countAccepted\(editPath\.post\);/);
  });
});

describe('the block history kept across reloads (SP5b spec §3.2, §3.4 step 6, D6, D32)', () => {
  const FIXTURE = new URL('../fixtures/sp5bWorldParams.json', import.meta.url);
  const ID = 'w1';
  let store: VoxelStore;
  /** The centre column of the 3 × 3 region (its 3 × 3 Published). */
  let C: [number, number] = [0, 0];
  beforeAll(async () => {
    const params = resolveProfile('default');
    const sp = findSpawn(createGenContext(seedFromInput('42'), params));
    C = [sp.x >> 4, sp.z >> 4];
    store = (await genRegion({ seed: '42', params, cx0: C[0] - 1, cz0: C[1] - 1, w: 3, h: 3, upTo: 'L', order: 'spiral', threads: 1, shared: true })).view.store;
  }, 120_000);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const val = (state: number): number => (state << 8) >>> 0;
  const valueAt = (x: number, y: number, z: number): number => ((store.blockAt(x, y, z) << 8) | store.fluidAt(x, y, z)) >>> 0;
  const ctrlZ = () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
  /** Moves vi's fake clock 1 ms at a time until `p` settles. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 5000 && !done; i++) await vi.advanceTimersByTimeAsync(1);
    return p;
  }

  /** A world as the menu's Create writes it: `worlds` and `state`, no `history` (§1.2). */
  async function created(): Promise<MemoryKV> {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schemaVersion: number; params: JsonObject };
    const p = loadParams({ ...fixture, profile: 'default' });
    if (!p.ok) throw new Error('fixture');
    const record: WorldRecord = {
      id: ID, name: 'My world', seedText: 'hello', seed: [1, 2], profile: 'default', params: fixture.params, schemaVersion: fixture.schemaVersion,
      paramsHash: '0123456789abcdef', generatorVersion: 5, genKey: hex64(genKey([1, 2], stageHashes(p.value))), stateTable: todayStateTable(), created: 1_000,
      backupOf: null,
    };
    const kv = createMemoryKV();
    expect((await settle(createSaves(kv).create(record, newState(ID, STATE_BOUNDS)))).status).toBe('complete');
    return kv;
  }

  /**
   * The saved world's page as `run()` composes it from the open on: `readSavedWorld`, the sim (the real handler over
   * `kv`, in process, each message handled `delay()` ms after its post, so its reply comes then) attached to the region's
   * store and loaded, the edit path, the block history restored from the read and the recording post in front of it,
   * the autosave, and the undo keys with the world owning. `posted` holds every batch the edit path sends the sim.
   */
  async function openPage(kv: MemoryKV, delay: () => number) {
    const read = await settle(readSavedWorld(createSaves(kv), ID, STATE_BOUNDS));
    if (!read.ok) throw new Error(read.reason);
    const failures: Error[] = [];
    const sim = createSimClient(() => inProcessSimWorker(createSimHandler({ openKV: async () => kv }), delay), { onFailure: (e) => { failures.push(e); } });
    await settle(sim.attach(store.handles()));
    await settle(sim.load(openRequest('wi10', read.world, read.state, read.history).load));
    const posted: Edit[][] = [];
    const editPath = createEditPath({
      sim: { get failed() { return sim.failed; }, edits: (e) => { posted.push([...e]); return sim.edits(e); } },
      coordinator: { editState: () => 0, simPin() {}, simUnpin() {}, markEdited() {} },
      latency: createEditLatency(),
      now: () => performance.now(),
      notices: { show() {} },
    });
    const accepted = countAccepted(editPath.post);
    const shown: string[] = [];
    const blockHistory = createBlockHistory({
      post: accepted.post, read: valueAt, pending: editPath.pending, settled: editPath.settled, notices: { show: (text) => { shown.push(text); } },
    });
    blockHistory.restore(read.history.done, read.history.undone);
    const actionPost = createActionPost({ post: accepted.post, record: blockHistory.record });
    const flushes: Array<HistoryRecord | null> = [];
    const results: FlushedMsg[] = [];
    const events = new Map<string, () => void>();
    const autosave = createPageAutosave({
      worldId: ID,
      fly: { x: 0.5, y: 100, z: 0.5, yaw: 0, pitch: 0, mode: 'fly', speed: SPEED_DEFAULT },
      frame: { t: 0.5 },
      speedIndex: () => 0,
      storedTime: null,
      hotbar: () => read.state.hotbar,
      blockHistory,
      sim: { flush: (state, history) => { flushes.push(history); return sim.flush(state, history); } },
      settled: editPath.settled,
      editsSince: accepted.count,
      now: () => Date.now(),
      clock: {
        now: () => performance.now(),
        setInterval: (f, ms) => setInterval(f, ms) as unknown as number,
        clearInterval: (id) => clearInterval(id),
        setTimeout: (f, ms) => setTimeout(f, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id),
      },
      events: { on: (type, f) => { events.set(type, f); return () => { events.delete(type); }; }, hidden: () => false },
      onResult: (r) => { results.push(r); },
    });
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const undoKeys = installUndoKeys({ owner: () => 'world', blocks: blockHistory, session: { undo: () => false, redo: () => false } });
    return {
      editPath, blockHistory, actionPost, autosave, flushes, results, events, posted, shown, win, failures,
      /** The page's teardown: the keys, the autosave, the sim. */
      close() {
        undoKeys();
        autosave.dispose();
        sim.dispose();
      },
    };
  }

  test('Review Focus 1: one step on voxel A recorded and flushed first; then three steps on voxel B (distinct values) posted 50 ms apart, each reply 70 ms late; `pagehide` at 110 ms posts at once (no settled wait), its history holding A\'s step and B\'s first; after a reopen from the KV, Ctrl+Z ×3: B\'s first step dropped with `Can\'t undo there: the blocks changed`, A\'s step undone, and the third press finds nothing', async () => {
    vi.useFakeTimers();
    const kv = await created();
    let delay = 0;
    const one = await openPage(kv, () => delay);
    /** A voxel just above the surface of the centre column, at (lx, lz) in it. */
    const spot = (lx: number, lz: number) => {
      const x = 16 * C[0] + lx;
      const z = 16 * C[1] + lz;
      return { x, y: store.heightAt('worldSurface', x, z)! + 1, z };
    };
    const A = spot(3, 3);
    const B = spot(9, 12);
    const genA = valueAt(A.x, A.y, A.z);
    const genB = valueAt(B.x, B.y, B.z);
    const set = (v: { x: number; y: number; z: number }, value: number, expectV: number): Edit => ({ ...v, op: 'set', value, expect: expectV });
    // A: one step, recorded at its reply, then flushed with it.
    expect(await settle(one.actionPost([set(A, val(STONE), genA)]))).toMatchObject({ ok: true });
    expect(one.blockHistory.size).toBe(1);
    expect(await settle(one.autosave.flushNow())).toMatchObject({ ok: true });
    const stepA = { edits: [{ ...A, before: NO_ENTRY, after: val(STONE) }] };
    expect(one.flushes).toEqual([{ worldId: ID, done: [stepA], undone: [] }]);
    // B: three steps posted 50 ms apart, each reply 70 ms after its post (at 70, 120 and 170 ms).
    delay = 70;
    const values = [val(GLASS), val(DIRT), val(STONE)];
    const t0 = performance.now();
    const outs = [one.actionPost([set(B, values[0]!, genB)])];
    await vi.advanceTimersByTimeAsync(50);
    outs.push(one.actionPost([set(B, values[1]!, values[0]!)]));
    await vi.advanceTimersByTimeAsync(50);
    outs.push(one.actionPost([set(B, values[2]!, values[1]!)]));
    await vi.advanceTimersByTimeAsync(10);
    // 110 ms: B's first reply is in and its step recorded; the second and third are still out.
    expect(performance.now() - t0).toBe(110);
    expect([one.blockHistory.size, one.editPath.pending()]).toEqual([2, true]);
    one.events.get('pagehide')!();
    // Posted at once, with no settled wait: its history A's step and B's first.
    const stepB1 = { edits: [{ ...B, before: NO_ENTRY, after: values[0]! }] };
    expect(one.flushes).toHaveLength(2);
    expect(one.flushes[1]).toEqual({ worldId: ID, done: [stepA, stepB1], undone: [] });
    // The sim handles it after B's third edit (at 180 ms): the column with B's third value, the history as posted.
    await vi.advanceTimersByTimeAsync(100);
    expect((await Promise.all(outs)).map((o) => o.ok)).toEqual([true, true, true]);
    expect(one.results.map((r) => r.ok)).toEqual([true, true]);
    expect(kv.dump('history')).toEqual([[ID, { worldId: ID, done: [stepA, stepB1], undone: [] }]]);
    one.close();
    expect(valueAt(B.x, B.y, B.z)).toBe(values[2]);
    // Reopened from the KV: the two saved steps.
    delay = 0;
    const two = await openPage(kv, () => delay);
    expect([two.blockHistory.size, two.blockHistory.redoSize]).toEqual([2, 0]);
    for (let i = 0; i < 3; i++) two.win.dispatchEvent(ctrlZ());
    await vi.advanceTimersByTimeAsync(50);
    // B's first step expects its glass, which B's third edit replaced: refused as changed, dropped; A's step undone;
    // the third press finds nothing and posts nothing.
    expect(two.posted).toEqual([
      [{ ...B, op: 'revert', value: 0, expect: values[0] }],
      [{ ...A, op: 'revert', value: 0, expect: val(STONE) }],
    ]);
    expect(two.shown).toEqual(['Can\'t undo there: the blocks changed', 'Undo · blocks']);
    expect([two.blockHistory.size, two.blockHistory.redoSize]).toEqual([0, 1]);
    expect([valueAt(A.x, A.y, A.z), valueAt(B.x, B.y, B.z)]).toEqual([genA, values[2]]);
    expect([...one.failures, ...two.failures]).toEqual([]);
    two.close();
  });

  test('the page restores a saved world\'s history, and creates its hotbar over `hotbarStorage` of the world\'s record (an unsaved world\'s stays in this browser, D29), which the autosave saves', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(saved !== null\) blockHistory\.restore\(saved\.history\.done, saved\.history\.undone\);\n\s+const actionPost = createActionPost/);
    expect(src).toMatch(/let worldHotbar: HotbarRecord = saved !== null \? saved\.state\.hotbar : STATE_BOUNDS\.normalizeHotbar\(null\);/);
    expect(src).toMatch(/const hotbar = createHotbar\(saved !== null \? hotbarStorage\(\(\) => worldHotbar, \(h\) => \{ worldHotbar = h; \}\) : storage\);/);
    expect(src).toMatch(/hotbar: \(\) => worldHotbar,\n\s+blockHistory,\n\s+sim: simClient!,/);
  });
});

describe('the world\'s lock in the page (SP5b spec §3.5, D24)', () => {
  const pageEvent = (type: 'pagehide' | 'pageshow', persisted: boolean): Event => Object.assign(new Event(type), { persisted });

  /** The page's lock on `win` and its autosave, whose `pagehide` trigger goes through the lock's `onPageHide`. */
  function page() {
    const order: string[] = [];
    const cleared: number[] = [];
    const win = new EventTarget();
    let reloads = 0;
    const lock = installWorldLock(win, { release: () => { order.push('release'); } }, () => { reloads++; });
    const hotbar = STATE_BOUNDS.normalizeHotbar(null);
    const blockHistory = createBlockHistory({
      post: (): Promise<EditOutcome> => Promise.resolve({ ok: false, why: 'failed' }),
      read: () => 0,
      pending: () => false,
      settled: () => Promise.resolve(),
      notices: { show() {} },
    });
    const autosave = createPageAutosave({
      worldId: 'w1',
      fly: { x: 0.5, y: 100, z: 0.5, yaw: 0, pitch: 0, mode: 'fly', speed: SPEED_DEFAULT },
      frame: { t: 0.5 },
      speedIndex: () => 0,
      storedTime: null,
      hotbar: () => hotbar,
      blockHistory,
      sim: { flush: () => { order.push('flush'); return new Promise<FlushedMsg>(() => {}); } },
      settled: () => Promise.resolve(),
      editsSince: () => 0,
      now: () => 1_700_000_000_000,
      clock: { now: () => 0, setInterval: () => 7, clearInterval: (id) => { cleared.push(id); }, setTimeout: () => 0, clearTimeout() {} },
      events: {
        on(type, f) {
          if (type === 'pagehide') return lock.onPageHide(f);
          win.addEventListener(type, f);
          return () => win.removeEventListener(type, f);
        },
        hidden: () => false,
      },
      onResult: () => {},
    });
    // As the page: the autosave stops once the lock is released at a `pagehide`.
    lock.onRelease(() => autosave.dispose());
    return { order, win, lock, autosave, reloads: () => reloads, cleared };
  }

  test('`pagehide` posts the flush before `release`; with nothing changed it only releases', () => {
    const changed = page();
    changed.autosave.markChanged();
    changed.win.dispatchEvent(pageEvent('pagehide', false));
    expect(changed.order).toEqual(['flush', 'release']);
    const same = page();
    same.win.dispatchEvent(pageEvent('pagehide', true));
    expect(same.order).toEqual(['release']);
  });

  test('a save that throws on `pagehide` still releases the lock', () => {
    const order: string[] = [];
    const win = new EventTarget();
    const lock = installWorldLock(win, { release: () => { order.push('release'); } }, () => {});
    lock.onPageHide(() => { throw new Error('boom'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    win.dispatchEvent(pageEvent('pagehide', false));
    expect(order).toEqual(['release']);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  test('`pageshow` with `persisted` reloads; without it nothing', () => {
    const p = page();
    p.win.dispatchEvent(pageEvent('pageshow', false));
    expect(p.reloads()).toBe(0);
    p.win.dispatchEvent(pageEvent('pageshow', true));
    expect(p.reloads()).toBe(1);
  });

  test('a page restored from the back/forward cache posts nothing more: `pagehide` (persisted), `pageshow` (persisted), `markChanged`, `beforeunload` and `pagehide`', async () => {
    const p = page();
    p.autosave.markChanged();
    p.win.dispatchEvent(pageEvent('pagehide', true));
    expect(p.order).toEqual(['flush', 'release']);
    // The 2,000 ms timer stopped with the release, before the page is frozen.
    expect(p.cleared).toEqual([7]);
    p.win.dispatchEvent(pageEvent('pageshow', true));
    expect(p.reloads()).toBe(1);
    // The reload's unload: its `beforeunload` and second `pagehide`; the resumed timer's tick; a failure's flush.
    p.autosave.markChanged();
    p.win.dispatchEvent(new Event('beforeunload'));
    p.win.dispatchEvent(pageEvent('pagehide', false));
    await p.autosave.tick();
    expect(await p.autosave.flushNow()).toBeNull();
    expect(p.order).toEqual(['flush', 'release']);
  });

  test('the lock\'s saves and stops run once, at the first `pagehide`: a later one finds the lock released and runs nothing', () => {
    const order: string[] = [];
    const win = new EventTarget();
    const lock = installWorldLock(win, { release: () => { order.push('release'); } }, () => {});
    lock.onPageHide(() => { order.push('save'); });
    lock.onRelease(() => { order.push('stop'); });
    win.dispatchEvent(pageEvent('pagehide', true));
    expect(order).toEqual(['save', 'release', 'stop']);
    win.dispatchEvent(pageEvent('pagehide', false));
    expect(order).toEqual(['save', 'release', 'stop']);
  });

  test('the teardown releases and removes both listeners: a later `pagehide` posts nothing, a later `pageshow` reloads nothing', () => {
    const p = page();
    p.autosave.markChanged();
    p.lock.dispose();
    expect(p.order).toEqual(['release']);
    p.win.dispatchEvent(pageEvent('pagehide', false));
    p.win.dispatchEvent(pageEvent('pageshow', true));
    expect(p.order).toEqual(['release']);
    expect(p.reloads()).toBe(0);
  });

  test('the page wires it: the lock first in the open, before the sim exists; the autosave\'s `pagehide` through `onPageHide`; the teardown', () => {
    const src = readFileSync(new URL('../../src/ui/world/worldPage.ts', import.meta.url), 'utf8');
    const run = src.slice(src.indexOf('async function run(): Promise<void> {'));
    expect(run.indexOf('random: cryptoSeed, locks: navigatorLocks() });')).toBeGreaterThan(0);
    expect(run.indexOf('random: cryptoSeed, locks: navigatorLocks() });')).toBeLessThan(run.indexOf('createBrowserSim('));
    expect(run).toMatch(/const lock = installWorldLock\(window, saved\.lock, \(\) => location\.reload\(\)\);\n\s+worldLock = lock;\n\s+teardown\.push\(\(\) => lock\.dispose\(\)\);/);
    expect(run).toMatch(/if \(type === 'pagehide'\) return worldLock!\.onPageHide\(f\);/);
    expect(run).toMatch(/autosave = a;\n\s+teardown\.push\(\(\) => a\.dispose\(\)\);\n\s+\/\/[^\n]*\n\s+teardown\.push\(worldLock!\.onRelease\(\(\) => a\.dispose\(\)\)\);/);
    // A page disposed while it waited releases what the open took.
    expect(run).toMatch(/if \(state !== 'loading'\) \{\n\s+if \(r\.ok\) \{\n\s+r\.opened\.kv\.close\(\);\n\s+r\.opened\.lock\.release\(\);/);
  });
});

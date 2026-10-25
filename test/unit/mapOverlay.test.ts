/**
 * The map overlay in the world (SP4c spec §1.3, §2.3, §2.4; Review Focus 4), on the DOM shim with a fake pointer lock
 * and a fake tool module (the real tool mounts only in the browser smoke, spec §1.2, §9). The fake tool, as the real
 * one, subscribes to the session and calls `driver.change` (ruling R1), installs P and Escape through `installShortcuts`
 * with the overlay's predicate, and on dispose removes its subscribe before its toolbar ends an open drag.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCoordinatorCounts } from '../../src/engine/coordinator';
import { WorldSession, type SessionChange } from '../../src/engine/session';
import type { WorkerPool } from '../../src/engine/workerPool';
import { validateParamTrees } from '../../src/gen/trees';
import { SPEED_DEFAULT, stepFly, type FlyState } from '../../src/player/fly';
import { attachInput, isTextEntry } from '../../src/player/input';
import type { MapView } from '../../src/ui/map/mapState';
import type { MapTool, MapToolDeps } from '../../src/ui/map/mapTool';
import { createReplayingCanvas, type PreviewDriver } from '../../src/ui/map/previewDriver';
import type { FpsCap } from '../../src/render/fpsLimiter';
import type { FrameState } from '../../src/render/frameState';
import {
  createMapOverlay, followSession, frameCapFor, MAP_PRELOAD_MS, ownerOf, SPLIT_MIN_WIDTH, splitAvailable, WORLD_MAP_BPP,
  type MapMode, type MapOverlay,
} from '../../src/ui/world/mapOverlay';
import { installDom, type FakeDocument, type FakeElement } from './fixtures/domShim';

interface FakeTool {
  readonly tool: MapTool;
  readonly deps: MapToolDeps;
  readonly host: HTMLElement;
  readonly calls: { show: Array<{ x: number; z: number } | undefined>; hide: number; setPlayer: Array<[number, number, number]>; panel: number; drawer: number; disposed: number };
}

const fake = vi.hoisted(() => ({ tools: [] as unknown[] }));
vi.mock('../../src/ui/map/mapTool', async () => {
  const { installShortcuts } = await import('../../src/ui/common/keys');
  const { draftOf } = await import('../../src/ui/map/previewDriver');
  return {
    createMapTool(host: HTMLElement, deps: MapToolDeps): MapTool {
      const calls: FakeTool['calls'] = { show: [], hide: 0, setPlayer: [], panel: 0, drawer: 0, disposed: 0 };
      let view: MapView = deps.initialView;
      const unsubscribe = deps.session.subscribe((s, c) => deps.driver.change(draftOf(s), c, 0));
      const removeKeys = installShortcuts((a) => {
        if (a === 'togglePanel') calls.panel++;
        else if (a === 'closeDrawer') calls.drawer++;
      }, (a) => (a === 'togglePanel' || a === 'closeDrawer') && deps.shortcutsEnabled(a));
      const tool: MapTool = {
        show(c) {
          calls.show.push(c);
          if (c !== undefined) view = { ...view, x: c.x, z: c.z };
          deps.driver.setPreviewWanted(true);
        },
        hide() {
          calls.hide++;
          deps.driver.setPreviewWanted(false);
        },
        setPlayer(x, z, yaw) { calls.setPlayer.push([x, z, yaw]); },
        get view() { return view; },
        notices: {} as MapTool['notices'],
        setView(v) { view = v; },
        dispose() {
          calls.disposed++;
          // The real tool's disposers run in reverse order: its subscribe goes before its toolbar ends an open drag.
          unsubscribe();
          removeKeys();
          deps.session.endGesture();
        },
      };
      fake.tools.push({ tool, deps, host, calls } satisfies FakeTool);
      return tool;
    },
  };
});

const tools = (): FakeTool[] => fake.tools as FakeTool[];
/** Lets the dynamic import (the mocked module's async factory) and its `then` run: one macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const key = (type: 'keydown' | 'keyup', code: string, k: string) =>
  Object.assign(new Event(type, { cancelable: true }), { code, key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false });

/** A fake driver: every method a spy (the overlay never configures the pool itself). */
function fakeDriver() {
  return {
    change: vi.fn<PreviewDriver['change']>(),
    previewProgress: vi.fn(),
    onSettled: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    status: { lastLatencyMs: null, pending: false, queued: false, settled: true, poolEpoch: 0, sessionEpoch: 0, error: null },
    adopt: vi.fn(),
    setPreviewWanted: vi.fn<PreviewDriver['setPreviewWanted']>(),
    onConfigured: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
}

/**
 * The overlay's window: a timer queue standing for `setTimeout`, a settable `innerWidth`, and its listeners kept in a
 * map (so a test can count what `dispose` removed).
 */
function fakeTimers(width = 1920) {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let next = 1;
  return {
    pending,
    listeners,
    innerWidth: width,
    setTimeout: (fn: () => void, ms: number) => { pending.set(next, { fn, ms }); return next++; },
    clearTimeout: (id: number) => { pending.delete(id); },
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      let set = listeners.get(type);
      if (set === undefined) listeners.set(type, set = new Set());
      set.add(fn);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) { listeners.get(type)?.delete(fn); },
    /** Sets `innerWidth` and dispatches 'resize' to the listeners. */
    resizeTo(w: number): void {
      this.innerWidth = w;
      const e = new Event('resize');
      for (const fn of [...(listeners.get('resize') ?? [])]) {
        if (typeof fn === 'function') fn(e);
        else fn.handleEvent(e);
      }
    },
    runAll(): void {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}

/** The 3D renderer's `resize` and `frame`, logged in order, and the FPS limiter's cap. */
function fakeWorld() {
  const log: string[] = [];
  return {
    log,
    world: {
      resize: vi.fn(() => { log.push('resize'); }),
      frame: vi.fn((_s: FrameState) => { log.push('frame'); }),
    },
  };
}
function fakeLimiter(cap: FpsCap) {
  const l = { cap, setCap: vi.fn((c: FpsCap) => { l.cap = c; }) };
  return l;
}
const STATE: FrameState = { t: 0.25, brightness: 0.3, eyeSky: 15, rd: 8, fogBand: 0.1 };

const flyAt = (x: number, z: number, yaw = 0): FlyState => ({ x, y: 80, z, yaw, pitch: 0, vx: 0, vy: 0, vz: 0, speed: SPEED_DEFAULT });

let dom: ReturnType<typeof installDom>;
let keysWin: EventTarget;
beforeEach(() => {
  dom = installDom();
  keysWin = new EventTarget();
  vi.stubGlobal('window', keysWin);
  fake.tools.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

function setup(o: {
  mode?: MapMode; watchLive?: boolean; width?: number; userCap?: FpsCap; fly?: FlyState; input?: { clear(): void }; canvas?: FakeElement;
  teleport?: (x: number, z: number) => Promise<boolean>;
} = {}) {
  const doc: FakeDocument = dom.document;
  const app = doc.createElement('div');
  const worldHost = doc.createElement('div');
  const canvas = o.canvas ?? doc.createElement('canvas');
  worldHost.append(canvas);
  app.append(worldHost);
  doc.body.append(app);
  const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
  const driver = fakeDriver();
  const fly = o.fly ?? flyAt(100, -40, 30);
  const input = o.input ?? { clear: vi.fn() };
  const timers = fakeTimers(o.width);
  const world = fakeWorld();
  const userCap = o.userCap ?? 0;
  const limiter = fakeLimiter(userCap);
  const save = vi.fn();
  let now = 0;
  const overlay = createMapOverlay({
    app: app as unknown as HTMLElement,
    worldHost: worldHost as unknown as HTMLElement,
    canvas: canvas as unknown as HTMLCanvasElement,
    session,
    pool: {} as WorkerPool,
    driver: driver as unknown as PreviewDriver,
    relay: createReplayingCanvas(),
    storage: null,
    settings: { mapMode: o.mode ?? 'full', watchLive: o.watchLive ?? true },
    save,
    world: world.world,
    frameState: () => STATE,
    limiter,
    userCap: () => userCap,
    fly,
    input,
    doc: doc as unknown as Document,
    win: timers as unknown as Window,
    now: () => now,
    onTeleport: o.teleport ?? (() => Promise.resolve(false)),
  });
  return {
    doc, app, worldHost, canvas, session, driver, fly, input, timers, overlay, world, limiter, save,
    setNow: (t: number) => { now = t; },
    /** The overlay's host (`div.map-overlay`). */
    host: () => app.children.find((c) => c.className.split(' ').includes('map-overlay'))!,
  };
}

/** Opens the overlay and lets the first open's import mount the tool. */
async function openMounted(overlay: MapOverlay): Promise<FakeTool> {
  overlay.open();
  await settle();
  const t = tools().at(-1);
  if (t === undefined) throw new Error('the open mounted no tool');
  return t;
}

describe('ownerOf (SP4c spec §2.3)', () => {
  test('over the 8 combinations: hidden → world; full shown → map; split shown → world when locked, else map', () => {
    const rows: Array<[MapMode, boolean, boolean, 'world' | 'map']> = [
      ['full', false, false, 'world'], ['full', false, true, 'world'], ['full', true, false, 'map'], ['full', true, true, 'map'],
      ['split', false, false, 'world'], ['split', false, true, 'world'], ['split', true, false, 'map'], ['split', true, true, 'world'],
    ];
    for (const [mode, shown, locked, owner] of rows) expect(ownerOf(mode, shown, locked), `${mode} ${shown} ${locked}`).toBe(owner);
  });
});

describe('the overlay host and the tool (SP4c spec §1.3, §1.5)', () => {
  test('div.map-overlay is appended to #app beside #world-host, hidden until the first open', () => {
    const { app, worldHost } = setup();
    const host = app.children.find((c) => c.className === 'map-overlay');
    expect(host).toBeDefined();
    expect(app.children.indexOf(host!)).toBe(app.children.indexOf(worldHost) + 1);
    expect(worldHost.children.some((c) => c.className === 'map-overlay')).toBe(false);
    expect(host!.style['display']).toBe('none');
  });

  test('the first open imports and mounts once; close and open again do not remount; open re-centres on the camera at the last bpp', async () => {
    const { overlay, fly, app } = setup({ fly: flyAt(100, -40, 30) });
    const t = await openMounted(overlay);
    expect(tools()).toHaveLength(1);
    expect(overlay.tool).toBe(t.tool);
    expect(t.deps.host).toBe('world');
    expect(t.deps.urlSink).toBeNull();
    expect(t.deps.toolbarSlot).not.toBeNull();
    expect(t.deps.initialView).toEqual({ x: 100, z: -40, bpp: WORLD_MAP_BPP, layer: 'biome' });
    expect(t.calls.show).toEqual([{ x: 100, z: -40 }]);
    const host = app.children.find((c) => c.className === 'map-overlay')!;
    expect(t.host).toBe(host as unknown as HTMLElement);
    expect(host.style['display']).toBe('');
    // The user zooms in, closes, flies on, opens again.
    t.tool.setView({ ...t.tool.view, bpp: 0.5 });
    overlay.close();
    expect(t.calls.hide).toBe(1);
    expect(host.style['display']).toBe('none');
    fly.x = 900;
    fly.z = 64;
    overlay.open();
    await settle();
    expect(tools()).toHaveLength(1);
    expect(t.calls.show).toEqual([{ x: 100, z: -40 }, { x: 900, z: 64 }]);
    expect(t.tool.view).toEqual({ x: 900, z: 64, bpp: 0.5, layer: 'biome' });
  });

  test('the preload imports the chunk 2 s after the reveal without mounting; an open after it mounts at once', async () => {
    const { overlay, timers } = setup();
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([MAP_PRELOAD_MS]);
    expect(MAP_PRELOAD_MS).toBe(2000);
    timers.runAll();
    await settle();
    expect(tools()).toHaveLength(0);
    // The chunk is in: the open mounts synchronously, the map drawn on the M's own frame.
    overlay.open();
    expect(tools()).toHaveLength(1);
  });

  test('closed before the chunk arrived: nothing mounts until the next open', async () => {
    const { overlay } = setup();
    overlay.open();
    overlay.close();
    await settle();
    expect(tools()).toHaveLength(0);
    overlay.open();
    expect(tools()).toHaveLength(1);
  });

  test('before the first M the overlay sets nothing on the driver; the first open calls the tool\'s show, which wants the preview (Task 13)', async () => {
    const { overlay, driver, timers } = setup();
    timers.runAll();
    await settle();
    overlay.tick(createCoordinatorCounts());
    for (const spy of [driver.change, driver.adopt, driver.setPreviewWanted, driver.onConfigured, driver.dispose]) expect(spy).not.toHaveBeenCalled();
    const t = await openMounted(overlay);
    expect(t.calls.show).toHaveLength(1);
    expect(driver.setPreviewWanted.mock.calls).toEqual([[true]]);
    overlay.close();
    expect(driver.setPreviewWanted.mock.calls).toEqual([[true], [false]]);
  });

  test('shown: 30 rendered ticks while fly.x grows by 64 call setPlayer with the camera\'s x, z and yaw; hidden: none; open calls it once', async () => {
    const { overlay, fly } = setup({ fly: flyAt(10, 20, 45) });
    const counts = createCoordinatorCounts();
    const t = await openMounted(overlay);
    expect(t.calls.setPlayer).toEqual([[10, 20, 45]]);
    for (let i = 1; i <= 30; i++) {
      fly.x = 10 + (64 * i) / 30;
      overlay.tick(counts);
      expect(t.calls.setPlayer.at(-1)).toEqual([fly.x, 20, 45]);
    }
    expect(t.calls.setPlayer).toHaveLength(31);
    expect(fly.x).toBeCloseTo(74, 9);
    overlay.close();
    for (let i = 0; i < 30; i++) {
      fly.x += 2;
      overlay.tick(counts);
    }
    expect(t.calls.setPlayer).toHaveLength(31);
    overlay.open();
    expect(t.calls.setPlayer).toHaveLength(32);
    expect(t.calls.setPlayer.at(-1)).toEqual([fly.x, 20, 45]);
  });

  test('a teleport that resolves true closes the map in full; false keeps it open', async () => {
    let answer = true;
    const { overlay } = setup({ teleport: () => Promise.resolve(answer) });
    const t = await openMounted(overlay);
    answer = false;
    t.deps.onTeleport!(5, 6);
    await settle();
    expect(overlay.shown).toBe(true);
    answer = true;
    t.deps.onTeleport!(5, 6);
    await settle();
    expect([overlay.shown, overlay.owner]).toEqual([false, 'world']);
  });
});

describe('the controls owner (SP4c spec §2.3, §2.4)', () => {
  test('open in full while locked calls exitPointerLock; the map owns and the input is cleared; close gives the world back', async () => {
    const { overlay, doc, canvas, input } = setup({ mode: 'full' });
    doc.setPointerLock(canvas);
    expect(overlay.owner).toBe('world');
    overlay.open();
    expect(doc.exitPointerLockCalls).toBe(1);
    expect(overlay.owner).toBe('map');
    expect(input.clear).toHaveBeenCalledTimes(1);
    overlay.close();
    expect(overlay.owner).toBe('world');
    expect(input.clear).toHaveBeenCalledTimes(2);
    await settle();
  });

  test('P toggles the panel only while the map is shown and owns; with the map hidden, P does nothing', async () => {
    const { overlay, doc, canvas } = setup({ mode: 'split' });
    const t = await openMounted(overlay);
    const p = () => keysWin.dispatchEvent(key('keydown', 'KeyP', 'p'));
    p();
    expect(t.calls.panel).toBe(1);
    // Split and locked: the world owns.
    doc.setPointerLock(canvas);
    expect(overlay.owner).toBe('world');
    p();
    expect(t.calls.panel).toBe(1);
    doc.setPointerLock(null);
    p();
    expect(t.calls.panel).toBe(2);
    overlay.close();
    p();
    expect(t.calls.panel).toBe(2);
  });

  test('Esc closes the drawer only 150 ms after the lock is lost (the wiring of Review Focus 4\'s rule)', async () => {
    const { overlay, doc, canvas, setNow } = setup({ mode: 'split' });
    const t = await openMounted(overlay);
    const esc = () => keysWin.dispatchEvent(key('keydown', 'Escape', 'Escape'));
    doc.setPointerLock(canvas);
    setNow(1000);
    esc();
    doc.setPointerLock(null);
    esc();
    setNow(1100);
    esc();
    expect(t.calls.drawer).toBe(0);
    setNow(1200);
    esc();
    expect(t.calls.drawer).toBe(1);
  });

  /**
   * The world's input on the fake document (its `active` the overlay's owner, as the page's), the overlay over it, and
   * the frame step's fly step behind the page's `paused` (`help.isOpen || owner === 'map'`, the help closed).
   */
  function world(mode: MapMode) {
    let overlay: MapOverlay | null = null;
    // Yaw 90 faces +x: W moves fly.x.
    const fly = flyAt(0, 0, 90);
    const d = dom.document;
    const canvas = d.createElement('canvas');
    const input = attachInput(canvas as unknown as HTMLElement, {
      onAction: () => {},
      onLook: () => {},
      isTextFocus: () => isTextEntry(d.activeElement as unknown as HTMLElement),
      active: () => overlay === null || overlay.owner === 'world',
      doc: d as unknown as Document,
      win: new EventTarget() as unknown as Window,
    });
    const s = setup({ mode, fly, input, canvas });
    overlay = s.overlay;
    const o = s.overlay;
    const paused = (): boolean => o.owner === 'map';
    const step = (): void => { if (!paused()) stepFly(fly, input.held, 1 / 60, { yMin: -64, yMax: 400 }); };
    const w = () => d.dispatchEvent(key('keydown', 'KeyW', 'w'));
    return { ...s, input, canvas, paused, step, w };
  }

  test('Review Focus 4 (wiring): W held while locked in split, then the lock lost: held empty and paused() true from that tick; fly.x unchanged over the next 60 ticks', async () => {
    const w = world('split');
    await openMounted(w.overlay);
    expect([w.overlay.owner, w.paused()]).toEqual(['map', true]);
    // A click on the 3D half takes the lock: the world owns, W flies.
    w.canvas.click();
    expect(w.doc.pointerLockElement).toBe(w.canvas);
    expect([w.overlay.owner, w.paused()]).toEqual(['world', false]);
    w.w();
    expect(w.input.held.has('forward')).toBe(true);
    for (let i = 0; i < 10; i++) w.step();
    expect(w.fly.x).toBeGreaterThan(0);
    // Esc, a blur or H releases the lock while W is still down.
    w.doc.setPointerLock(null);
    expect(w.input.held.size).toBe(0);
    expect([w.overlay.owner, w.paused()]).toEqual(['map', true]);
    // The held key's repeats reach the world no more.
    w.w();
    expect(w.input.held.size).toBe(0);
    const x = w.fly.x;
    for (let i = 0; i < 60; i++) w.step();
    expect(w.fly.x).toBe(x);
    expect(w.overlay.shown).toBe(true);
  });

  test('a click on the 3D half that takes the lock blurs a focused seed field (document.activeElement is the body), so W moves the camera', async () => {
    const w = world('split');
    await openMounted(w.overlay);
    const seed = w.doc.createElement('input');
    seed.type = 'text';
    w.doc.body.append(seed);
    seed.focus();
    expect(w.doc.activeElement).toBe(seed);
    w.canvas.click();
    expect(w.doc.activeElement).toBe(w.doc.body);
    w.w();
    expect(w.input.held.has('forward')).toBe(true);
    for (let i = 0; i < 10; i++) w.step();
    expect(w.fly.x).toBeGreaterThan(0);
  });
});

describe('ruling R1 and the dispose mid-gesture (Task 12 review, minor 2)', () => {
  const kinds = (driver: ReturnType<typeof fakeDriver>): Array<[string, boolean]> =>
    driver.change.mock.calls.map((c) => [(c[1] as SessionChange).kind, (c[1] as SessionChange).urgent]);

  test('before the mount the page\'s subscribe calls driver.change; after a mount one session change gives exactly one call', async () => {
    const { overlay, session, driver } = setup();
    const off = followSession({ session, driver, toolMounted: () => overlay.tool !== null, now: () => 0 });
    session.set('climate.scaleMul', 2);
    expect(kinds(driver)).toEqual([['set', true]]);
    await openMounted(overlay);
    session.set('climate.scaleMul', 1.5);
    expect(kinds(driver)).toEqual([['set', true], ['set', true]]);
    // Hidden, the tool is still the caller.
    overlay.close();
    session.set('climate.scaleMul', 3);
    expect(driver.change).toHaveBeenCalledTimes(3);
    off();
  });

  test('dispose mid-gesture: the urgent gestureEnd reaches driver.change exactly once, while the tool\'s subscribe is live; later changes go through the page', async () => {
    const { overlay, session, driver } = setup();
    const off = followSession({ session, driver, toolMounted: () => overlay.tool !== null, now: () => 0 });
    const t = await openMounted(overlay);
    session.beginGesture();
    session.set('climate.scaleMul', 2);
    expect(kinds(driver)).toEqual([['gestureBegin', false], ['set', false]]);
    const listeners = session.listenerCount();
    overlay.dispose();
    expect(kinds(driver)).toEqual([['gestureBegin', false], ['set', false], ['gestureEnd', true]]);
    expect(session.inGesture).toBe(false);
    expect(t.calls.disposed).toBe(1);
    expect(session.listenerCount()).toBe(listeners - 1);
    expect(overlay.tool).toBeNull();
    session.set('climate.scaleMul', 3);
    expect(driver.change).toHaveBeenCalledTimes(4);
    overlay.dispose();
    expect(t.calls.disposed).toBe(1);
    off();
  });

  test('dispose removes the host and the lock listener and cancels the preload', () => {
    const { overlay, app, timers, doc, canvas, input } = setup({ mode: 'split' });
    overlay.dispose();
    expect(app.children.some((c) => c.className === 'map-overlay')).toBe(false);
    expect(timers.pending.size).toBe(0);
    doc.setPointerLock(canvas);
    expect(input.clear).not.toHaveBeenCalled();
    overlay.open();
    expect(overlay.shown).toBe(false);
  });
});


describe('modes A and B, the covered cap and Watch live (SP4c spec §2.1, §2.2, §2.6; D16, D18)', () => {
  /** The header's controls in the tool's toolbar slot (the fake tool renders no toolbar). */
  const controls = (t: FakeTool) => {
    const slot = t.deps.toolbarSlot as unknown as FakeElement;
    const get = (id: string): FakeElement => {
      const e = slot.querySelector(`#${id}`);
      if (e === null) throw new Error(`no #${id} in the slot`);
      return e;
    };
    return {
      slot,
      full: get('map-mode-full'),
      split: get('map-mode-split'),
      reason: get('map-mode-reason'),
      watchLive: get('map-watch-live'),
      watchLiveBox: get('map-watch-live').querySelector('input')!,
      centre: get('map-centre'),
      close: get('map-close'),
    };
  };
  const SPLIT_REASON = 'Side by side needs a window at least 1,000 px wide';

  test('splitAvailable(999) false, (1000) true; a stored split at 999 opens full and the switch shows the reason; at 1,000 it opens split', async () => {
    expect(SPLIT_MIN_WIDTH).toBe(1000);
    expect(splitAvailable(999)).toBe(false);
    expect(splitAvailable(1000)).toBe(true);

    const narrow = setup({ mode: 'split', width: 999 });
    const t = await openMounted(narrow.overlay);
    const c = controls(t);
    expect(narrow.overlay.mode).toBe('full');
    expect(narrow.worldHost.classList.contains('split')).toBe(false);
    expect(narrow.host().classList.contains('split')).toBe(false);
    expect(c.split.disabled).toBe(true);
    expect(c.split.title).toBe(SPLIT_REASON);
    expect([c.reason.hidden, c.reason.textContent]).toEqual([false, SPLIT_REASON]);
    expect(c.full.getAttribute('aria-pressed')).toBe('true');
    expect(narrow.world.world.resize).not.toHaveBeenCalled();
    // Opening as full saves nothing: the stored split comes back on a wider window.
    expect(narrow.save).not.toHaveBeenCalled();
    narrow.overlay.dispose();

    const wide = setup({ mode: 'split', width: 1000 });
    const w = await openMounted(wide.overlay);
    const cw = controls(w);
    expect(wide.overlay.mode).toBe('split');
    expect(wide.worldHost.classList.contains('split')).toBe(true);
    expect(wide.host().classList.contains('split')).toBe(true);
    expect([cw.split.disabled, cw.reason.hidden]).toEqual([false, true]);
    expect(cw.split.getAttribute('aria-pressed')).toBe('true');
    // The 3D moved to the right half: resized, then one frame drawn.
    expect(wide.world.log).toEqual(['resize', 'frame']);
    expect(wide.world.world.frame).toHaveBeenCalledWith(STATE);
    // Closing gives the 3D the whole window back, resized and drawn.
    wide.overlay.close();
    expect(wide.worldHost.classList.contains('split')).toBe(false);
    expect(wide.world.log).toEqual(['resize', 'frame', 'resize', 'frame']);
  });

  test('frameCapFor: full shown, user 0 → 60, user 30 → 30, user 144 → 60; split shown or hidden → the user\'s', () => {
    expect(frameCapFor('full', true, 0)).toBe(60);
    expect(frameCapFor('full', true, 30)).toBe(30);
    expect(frameCapFor('full', true, 60)).toBe(60);
    expect(frameCapFor('full', true, 120)).toBe(60);
    expect(frameCapFor('full', true, 144)).toBe(60);
    for (const cap of [0, 30, 60, 120, 144] as const) {
      expect(frameCapFor('split', true, cap)).toBe(cap);
      expect(frameCapFor('split', false, cap)).toBe(cap);
      expect(frameCapFor('full', false, cap)).toBe(cap);
    }
  });

  test('Review Focus 3: user cap 0, A shown → B shown → B locked → A shown → hidden gives limiter caps 60, 0, 0, 60, 0; owners map, map, world, map, world; exitPointerLock on the locked B → A switch; resize() then one frame on each A ↔ B switch', async () => {
    const s = setup({ mode: 'full', userCap: 0 });
    const t = await openMounted(s.overlay);
    const c = controls(t);
    const caps: FpsCap[] = [];
    const owners: string[] = [];
    const record = (): void => {
      caps.push(s.limiter.cap);
      owners.push(s.overlay.owner);
    };
    // A shown.
    record();
    expect(s.world.log).toEqual([]);
    // B shown: the 3D host moves to the right half, then resize and one drawn frame.
    c.split.click();
    record();
    expect(s.overlay.mode).toBe('split');
    expect(s.worldHost.classList.contains('split')).toBe(true);
    expect(s.world.log).toEqual(['resize', 'frame']);
    // B locked: a click on the 3D half takes the lock.
    s.doc.setPointerLock(s.canvas);
    record();
    expect(s.doc.exitPointerLockCalls).toBe(0);
    // A shown: the switch releases the lock; the 3D gets the whole window back.
    c.full.click();
    record();
    expect(s.doc.exitPointerLockCalls).toBe(1);
    expect(s.doc.pointerLockElement).toBeNull();
    expect(s.worldHost.classList.contains('split')).toBe(false);
    expect(s.world.log).toEqual(['resize', 'frame', 'resize', 'frame']);
    // Hidden.
    s.overlay.close();
    record();
    expect(caps).toEqual([60, 0, 0, 60, 0]);
    expect(owners).toEqual(['map', 'map', 'world', 'map', 'world']);
    expect(s.world.log).toEqual(['resize', 'frame', 'resize', 'frame']);
    expect(s.world.world.frame).toHaveBeenCalledTimes(2);
  });

  test('at 999 the switch shows B disabled with the reason; a resize event at 1,000 enables it; dispose removes the listener', async () => {
    const s = setup({ mode: 'full', width: 999 });
    const t = await openMounted(s.overlay);
    const c = controls(t);
    expect([c.split.disabled, c.reason.hidden]).toEqual([true, false]);
    // A disabled B does not switch.
    c.split.click();
    expect(s.overlay.mode).toBe('full');
    s.timers.resizeTo(1000);
    expect([c.split.disabled, c.split.title, c.reason.hidden]).toEqual([false, '', true]);
    c.split.click();
    expect(s.overlay.mode).toBe('split');
    s.timers.resizeTo(999);
    expect([c.split.disabled, c.reason.hidden]).toEqual([true, false]);
    expect(s.timers.listeners.get('resize')?.size).toBe(1);
    s.overlay.dispose();
    expect(s.timers.listeners.get('resize')?.size).toBe(0);
    expect(s.worldHost.classList.contains('split')).toBe(false);
  });

  test('applied(\'T\') with Watch live in full shown closes the map and the owner becomes world; with Watch live off, in split, or applied(null), the map stays', async () => {
    const live = setup({ mode: 'full', watchLive: true });
    await openMounted(live.overlay);
    live.overlay.applied(null);
    expect([live.overlay.shown, live.overlay.owner]).toEqual([true, 'map']);
    live.overlay.applied('T');
    expect([live.overlay.shown, live.overlay.owner]).toEqual([false, 'world']);
    // Hidden: nothing to close.
    live.overlay.applied('T');
    expect(live.overlay.shown).toBe(false);

    const off = setup({ mode: 'full', watchLive: false });
    await openMounted(off.overlay);
    off.overlay.applied('T');
    expect([off.overlay.shown, off.overlay.owner]).toEqual([true, 'map']);

    const split = setup({ mode: 'split', watchLive: true });
    await openMounted(split.overlay);
    split.overlay.applied('T');
    expect([split.overlay.shown, split.overlay.owner]).toEqual([true, 'map']);

    // Watch live turned off from the header: the next Apply leaves the map up.
    const toggled = setup({ mode: 'full', watchLive: true });
    const tt = await openMounted(toggled.overlay);
    const box = controls(tt).watchLiveBox as FakeElement & { checked: boolean };
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    toggled.overlay.applied('T');
    expect(toggled.overlay.shown).toBe(true);
  });

  test('the mode switch and Watch live are saved at once (save called with the new settings); Watch live shows in full only', async () => {
    const s = setup({ mode: 'full', watchLive: true });
    const t = await openMounted(s.overlay);
    const c = controls(t);
    const box = c.watchLiveBox as FakeElement & { checked: boolean };
    expect([box.checked, c.watchLive.hidden]).toEqual([true, false]);
    c.split.click();
    expect(s.save.mock.calls).toEqual([[{ mapMode: 'split', watchLive: true }]]);
    expect(c.watchLive.hidden).toBe(true);
    expect(c.split.getAttribute('aria-pressed')).toBe('true');
    expect(c.full.getAttribute('aria-pressed')).toBe('false');
    // The pressed mode again changes and saves nothing.
    c.split.click();
    expect(s.save).toHaveBeenCalledTimes(1);
    c.full.click();
    expect(s.save.mock.calls.at(-1)).toEqual([{ mapMode: 'full', watchLive: true }]);
    expect(c.watchLive.hidden).toBe(false);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(s.save.mock.calls.at(-1)).toEqual([{ mapMode: 'full', watchLive: false }]);
    expect(s.save).toHaveBeenCalledTimes(3);
  });

  test('a teleport from the tool whose onTeleport resolves true closes the map in full (owner world) and keeps it open in split; false keeps it open in both', async () => {
    for (const mode of ['full', 'split'] as const) {
      let answer = false;
      const s = setup({ mode, teleport: () => Promise.resolve(answer) });
      const t = await openMounted(s.overlay);
      // False: "Could not teleport", or superseded by a later click.
      t.deps.onTeleport!(5, 6);
      await settle();
      expect([s.overlay.shown, s.overlay.owner], `${mode} false`).toEqual([true, 'map']);
      answer = true;
      t.deps.onTeleport!(5, 6);
      await settle();
      expect([s.overlay.shown, s.overlay.owner], `${mode} true`).toEqual(mode === 'full' ? [false, 'world'] : [true, 'map']);
      s.overlay.dispose();
    }
  });

  test('Centre on me calls the tool\'s show with the camera\'s x and z (the fake tool\'s view keeps its bpp); ✕ Close (M) hides the map', async () => {
    const s = setup({ fly: flyAt(100, -40, 30) });
    const t = await openMounted(s.overlay);
    const c = controls(t);
    t.tool.setView({ ...t.tool.view, x: 5000, z: 7000, bpp: 0.5 });
    s.fly.x = 321;
    s.fly.z = -654;
    c.centre.click();
    expect(t.calls.show.at(-1)).toEqual({ x: 321, z: -654 });
    expect(t.tool.view).toEqual({ x: 321, z: -654, bpp: 0.5, layer: 'biome' });
    expect(c.close.textContent).toBe('✕ Close (M)');
    c.close.click();
    expect([s.overlay.shown, s.overlay.owner]).toEqual([false, 'world']);
    expect(t.calls.hide).toBe(1);
  });

  test('the header\'s controls: "Full screen | Side by side", "Watch live", "Centre on me", "✕ Close (M)" in the toolbar slot', async () => {
    const s = setup();
    const t = await openMounted(s.overlay);
    const c = controls(t);
    expect([c.full.textContent, c.split.textContent, c.watchLive.textContent, c.centre.textContent, c.close.textContent])
      .toEqual(['Full screen', 'Side by side', 'Watch live', 'Centre on me', '✕ Close (M)']);
    for (const b of [c.full, c.split, c.centre, c.close]) expect(b.type).toBe('button');
    expect(c.watchLiveBox.type).toBe('checkbox');
  });
});

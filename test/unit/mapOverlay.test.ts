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
import {
  createMapOverlay, followSession, MAP_PRELOAD_MS, ownerOf, WORLD_MAP_BPP, type MapMode, type MapOverlay,
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

/** A timer queue standing for the window's `setTimeout`. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => { pending.set(next, { fn, ms }); return next++; },
    clearTimeout: (id: number) => { pending.delete(id); },
    runAll(): void {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}

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

function setup(o: { mode?: MapMode; fly?: FlyState; input?: { clear(): void }; canvas?: FakeElement; teleport?: (x: number, z: number) => Promise<boolean> } = {}) {
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
  const timers = fakeTimers();
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
    settings: { mapMode: o.mode ?? 'full', watchLive: true },
    save: vi.fn(),
    fly,
    input,
    doc: doc as unknown as Document,
    win: timers as unknown as Window,
    now: () => now,
    onTeleport: o.teleport ?? (() => Promise.resolve(false)),
  });
  return { doc, app, worldHost, canvas, session, driver, fly, input, timers, overlay, setNow: (t: number) => { now = t; } };
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


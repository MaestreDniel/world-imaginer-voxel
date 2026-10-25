/**
 * The map overlay in the world (SP4c spec §1.3, §2.3, §2.4; D2, D15): a `div.map-overlay` appended to `#app` beside
 * `#world-host` (not inside it, so the 3D host can move in mode B), created at the reveal (nothing may configure the
 * pool before it, `coordinator.ts:59`), which owns the map tool, the mode and the controls owner.
 *
 * - **Preload:** `MAP_PRELOAD_MS` after the reveal, `import('../map/mapTool')` loads the chunk and its CSS without
 *   mounting; an M after it mounts at once.
 * - **The first `open`** mounts the tool (`host: 'world'`, no URL sink, the toolbar slot, its `onTeleport` wrapping the
 *   page's: true in full closes the map, split keeps it, false keeps it as it is), centred on the camera at
 *   `WORLD_MAP_BPP` blocks/px; the tool attaches its canvas to the driver's replaying sink, so it draws at once. Every
 *   `open` then calls `show` on the camera (keeping the zoom and layer) and `setPlayer` once, so the arrow is at the
 *   camera on opening; `close` calls `hide`, and the host is `display: none` while hidden.
 * - **`tick(counts)`**, called by the page on every rendered frame: while shown, the arrow follows the camera (scalars,
 *   allocation-free; the canvas redraws only when it moved, ≤ 30/s).
 * - **The modes** (§2.1, §2.2, D16): A (`'full'`) covers the window over the full-size 3D; B (`'split'`) puts the map on
 *   the left half and moves `#world-host` to the right one (the class `split` on both hosts), offered only from
 *   `SPLIT_MIN_WIDTH` CSS px (a stored B opens as A below it; the switch shows B disabled with the reason, re-evaluated
 *   on every window resize). Every change of the 3D host's size (a switch while shown, opening or closing in B) calls
 *   the renderer's `resize()` and draws one frame, so the frame painted at the switch is not three's cleared canvas. A
 *   switch to A while locked releases the lock. While A covers the 3D, the limiter's cap is `frameCapFor`'s 60 (or the
 *   user's lower cap, §2.6). The header's controls live in the tool's toolbar slot: "Full screen | Side by side",
 *   "Watch live" (A only), "Centre on me" and "✕ Close (M)"; a mode or Watch-live change is saved at once (D17).
 * - **Watch live** (§2.1, D18): `applied(from)`, called when a draft that changes the world is applied, closes the map
 *   in A with Watch live on, so the 3D shows the regeneration; a drag never reaches it mid-gesture (the Apply waits for
 *   the gesture's end).
 * - **The controls owner** (`ownerOf`, §2.3): hidden → world; full shown → map; split shown → world while the canvas
 *   holds the pointer lock, else map. Opening releases the pointer lock; every owner change calls `input.clear()`, so no
 *   key stays held across the hand-over; the lock taken by the canvas blurs the focused element (a canvas click does
 *   not move the focus, so a focused seed field would keep WASD dead). The page pauses the flight while the map owns
 *   and passes `owner === 'world'` as the input's `active`.
 * - **P and Esc** run through the tool's shortcuts, enabled while the map is shown and owns; Esc also only when
 *   `escapeAllowed` (not locked, and 150 ms after the last loss of the lock, Review Focus 4).
 * - **`dispose`** (the page's teardown; a fatal error or a context loss, before the failure panel or the notice, D27)
 *   ends a gesture still open while the tool's session subscribe is still the caller of `driver.change` (ruling R1;
 *   the tool's own disposers end their drags after its subscribe is gone), then disposes the tool and removes the host.
 *
 * Ruling R1: exactly one caller of `driver.change` per session change. The page's subscribe (`followSession`) runs
 * while no tool is mounted; once mounted, the tool's own subscribe is the caller, hidden or shown.
 */
import type { CoordinatorCounts } from '../../engine/coordinator';
import type { WorldStage } from '../../engine/invalidation';
import type { WorldSession } from '../../engine/session';
import type { WorkerPool } from '../../engine/workerPool';
import type { FlyState } from '../../player/fly';
import type { FpsCap, FpsLimiter } from '../../render/fpsLimiter';
import type { FrameState } from '../../render/frameState';
import type { WorldRenderer } from '../../render/renderer';
import { el } from '../common/dom';
import { escapeAllowed, type ShortcutAction } from '../common/keys';
import type { LayoutStorage } from '../map/layout';
import { DEFAULT_MAP_STATE } from '../map/mapState';
import type { createMapTool, MapTool } from '../map/mapTool';
import { draftOf, type createReplayingCanvas, type PreviewDriver } from '../map/previewDriver';
import type { WorldSettings } from '../settings';

/** The overlay's mode (SP4c spec §2.1, §2.2): A full screen, B side by side. */
export type MapMode = WorldSettings['mapMode'];
/** Who the keys, the wheel and the pointer act for (SP4c spec §2.3). */
export type ControlsOwner = 'world' | 'map';

/** How long after the reveal the map's chunk is loaded without mounting (SP4c spec §1.3). */
export const MAP_PRELOAD_MS = 2000;
/** The map's zoom at the first open, in blocks per pixel (SP4c spec §1.6); later opens keep the last zoom. */
export const WORLD_MAP_BPP = 4;

/** The narrowest window, in CSS px, that offers mode B: each half at least 500 px (SP4c spec §2.2, D16). */
export const SPLIT_MIN_WIDTH = 1000;
/** Why mode B is disabled below `SPLIT_MIN_WIDTH` (SP4c spec §2.2). */
export const SPLIT_UNAVAILABLE = 'Side by side needs a window at least 1,000 px wide';
/** The cap on rendered frames while mode A covers the 3D (SP4c spec §2.6). */
const COVERED_CAP = 60;

/** Whether a window `innerWidth` CSS px wide offers mode B (SP4c spec §2.2). */
export function splitAvailable(innerWidth: number): boolean {
  return innerWidth >= SPLIT_MIN_WIDTH;
}

/**
 * The FPS limiter's cap (SP4c spec §2.6): while mode A covers the 3D, 60, or the user's cap when lower and non-zero;
 * otherwise (mode B, or the map hidden) the user's cap.
 */
export function frameCapFor(mode: MapMode, shown: boolean, userCap: FpsCap): FpsCap {
  if (!shown || mode !== 'full') return userCap;
  return userCap !== 0 && userCap < COVERED_CAP ? userCap : COVERED_CAP;
}

/** The controls owner (SP4c spec §2.3): hidden → world; full shown → map; split shown → world while locked, else map. */
export function ownerOf(mode: MapMode, shown: boolean, locked: boolean): ControlsOwner {
  if (!shown) return 'world';
  if (mode === 'full') return 'map';
  return locked ? 'world' : 'map';
}

/**
 * The page's session subscribe (ruling R1): every session change goes to `driver.change` while no map tool is mounted;
 * once one is, the tool's own subscribe is the caller and this one does nothing. Returns the unsubscribe.
 */
export function followSession(o: {
  readonly session: Pick<WorldSession, 'subscribe'>;
  readonly driver: Pick<PreviewDriver, 'change'>;
  toolMounted(): boolean;
  now(): number;
}): () => void {
  return o.session.subscribe((s, change) => {
    if (!o.toolMounted()) o.driver.change(draftOf(s), change, o.now());
  });
}

export interface MapOverlayOptions {
  /** `#app`: the overlay's host is appended to it, beside `worldHost`. */
  readonly app: HTMLElement;
  /** `#world-host`: mode B gives it the class `split`, which moves it to the right half. */
  readonly worldHost: HTMLElement;
  /** The world's canvas: its pointer lock gives the controls to the world in mode B. */
  readonly canvas: HTMLCanvasElement;
  readonly session: WorldSession;
  readonly pool: WorkerPool;
  readonly driver: PreviewDriver;
  /** The driver's replaying sink, which the tool attaches its canvas to at mount (SP4c spec §4.2). */
  readonly relay: ReturnType<typeof createReplayingCanvas>;
  /** Where the tool's layout persists (`wi10.layout.v1`). */
  readonly storage: LayoutStorage | null;
  readonly settings: Pick<WorldSettings, 'mapMode' | 'watchLive'>;
  /** Saves a mode or Watch-live change at once (SP4c spec §2.5). */
  save(s: Pick<WorldSettings, 'mapMode' | 'watchLive'>): void;
  /** The 3D renderer: resized and drawn once whenever mode B changes its host's size (SP4c spec §2.2). */
  readonly world: Pick<WorldRenderer, 'resize' | 'frame'>;
  /** The page's frame state, for that one frame. */
  frameState(): FrameState;
  /** The page's FPS limiter: capped by `frameCapFor` while mode A covers the 3D (SP4c spec §2.6). */
  readonly limiter: Pick<FpsLimiter, 'setCap'>;
  /** The user's FPS cap in force (the saved setting). */
  userCap(): FpsCap;
  /** The camera: the map opens centred on it, and the arrow follows it. */
  readonly fly: FlyState;
  /** The world's input: cleared on every change of owner. */
  readonly input: { clear(): void };
  readonly doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement' | 'exitPointerLock' | 'activeElement'>;
  /** Its timers, and its width for mode B's availability, re-evaluated on 'resize'. */
  readonly win: Pick<Window, 'setTimeout' | 'clearTimeout' | 'innerWidth' | 'addEventListener' | 'removeEventListener'>;
  now(): number;
  /** A plain click in the map (SP4c spec §3.1): resolves true once the camera moved there, false when it did not. */
  onTeleport(x: number, z: number): Promise<boolean>;
}

export interface MapOverlay {
  readonly owner: ControlsOwner;
  readonly shown: boolean;
  readonly mode: MapMode;
  /** M: `close` while shown, else `open`. */
  toggle(): void;
  /** Shows the map (mounting the tool the first time), releasing the pointer lock; the map owns in mode A. */
  open(): void;
  /** Hides the map; the world owns. */
  close(): void;
  /** On every rendered frame, with the page's one counts object: the arrow follows the camera while shown. */
  tick(counts: CoordinatorCounts): void;
  /**
   * A draft was applied, `from` its first regenerated stage (null: the world is unchanged). Full, shown, Watch live on
   * and `from` non-null: the map closes and the 3D shows the regeneration (SP4c spec §2.1, D18); otherwise nothing.
   */
  applied(from: WorldStage | null): void;
  /** The mounted tool, or null before the first `open` mounted it and after `dispose`. */
  readonly tool: MapTool | null;
  /** Ends an open gesture while the tool still feeds the driver, disposes the tool and removes the host; once. */
  dispose(): void;
}

/** What the overlay reads of the map tool's chunk (`import('../map/mapTool')`). */
interface ToolModule { readonly createMapTool: typeof createMapTool }

export function createMapOverlay(o: MapOverlayOptions): MapOverlay {
  const host = el('div', 'map-overlay');
  host.id = 'map-overlay';
  host.style.display = 'none';
  o.app.append(host);

  // The stored mode (what the user chose last) and the mode in force (a stored B opens as A on a narrow window).
  let preferred: MapMode = o.settings.mapMode;
  const modeFor = (): MapMode => (preferred === 'split' && splitAvailable(o.win.innerWidth) ? 'split' : 'full');
  let mode: MapMode = modeFor();
  let watchLive = o.settings.watchLive;
  let shown = false;
  // Whether #world-host is on the right half (mode B shown).
  let worldSplit = false;
  let disposed = false;
  let tool: MapTool | null = null;
  let mod: ToolModule | null = null;
  let loading: Promise<ToolModule> | null = null;

  // The controls owner and the pointer lock's history (Esc after an unlock, Review Focus 4).
  const locked = (): boolean => o.doc.pointerLockElement === o.canvas;
  let owner: ControlsOwner = ownerOf(mode, shown, locked());
  let wasLocked = o.doc.pointerLockElement !== null;
  let unlockedAt = Number.NEGATIVE_INFINITY;
  const syncOwner = (): void => {
    const next = ownerOf(mode, shown, locked());
    if (next === owner) return;
    owner = next;
    o.input.clear();
  };
  const onLockChange = (): void => {
    const isLocked = o.doc.pointerLockElement !== null;
    if (wasLocked && !isLocked) unlockedAt = o.now();
    wasLocked = isLocked;
    // The lock gives the world the controls: a focused field would otherwise keep the world's keys dead (§2.2).
    if (locked()) (o.doc.activeElement as HTMLElement | null)?.blur();
    syncOwner();
  };
  o.doc.addEventListener('pointerlockchange', onLockChange);

  const load = (): Promise<ToolModule> => {
    loading ??= import('../map/mapTool').then((m) => {
      mod = m;
      return m;
    }, (e: unknown) => {
      // A later open retries the chunk.
      loading = null;
      throw e;
    });
    return loading;
  };
  const preload = o.win.setTimeout(() => { load().catch(() => {}); }, MAP_PRELOAD_MS);

  // The header's controls (SP4c spec §2.5), in the slot the tool's toolbar shows.
  const slot = el('span', 'map-overlay-slot');
  const modeSwitch = el('span', 'map-mode');
  modeSwitch.setAttribute('role', 'group');
  modeSwitch.setAttribute('aria-label', 'Map layout');
  const fullButton = button('map-mode-full', 'Full screen');
  const splitButton = button('map-mode-split', 'Side by side');
  const reason = el('span', 'map-mode-reason', SPLIT_UNAVAILABLE);
  reason.id = 'map-mode-reason';
  modeSwitch.append(fullButton, splitButton, reason);
  const watchLabel = el('label', 'map-watch-live');
  watchLabel.id = 'map-watch-live';
  const watchBox = el('input');
  watchBox.type = 'checkbox';
  watchLabel.append(watchBox, 'Watch live');
  const centreButton = button('map-centre', 'Centre on me');
  const closeButton = button('map-close', '✕ Close (M)');
  slot.append(modeSwitch, watchLabel, centreButton, closeButton);

  /** The controls' state from the mode, Watch live and the window's width. */
  const syncControls = (): void => {
    const available = splitAvailable(o.win.innerWidth);
    fullButton.setAttribute('aria-pressed', String(mode === 'full'));
    splitButton.setAttribute('aria-pressed', String(mode === 'split'));
    splitButton.disabled = !available;
    splitButton.title = available ? '' : SPLIT_UNAVAILABLE;
    reason.hidden = available;
    watchLabel.hidden = mode !== 'full';
    watchBox.checked = watchLive;
  };
  const onResize = (): void => syncControls();
  o.win.addEventListener('resize', onResize);

  /** The covered cap (SP4c spec §2.6), set on every change of mode or visibility. */
  const syncCap = (): void => o.limiter.setCap(frameCapFor(mode, shown, o.userCap()));

  /**
   * The hosts' classes for the mode; when #world-host changes size (mode B shown, or no longer), the renderer resizes
   * and draws one frame, so the frame painted at the switch is not three's cleared canvas (SP4c spec §2.2).
   */
  const syncLayout = (): void => {
    host.classList.toggle('split', mode === 'split');
    const split = shown && mode === 'split';
    if (split === worldSplit) return;
    worldSplit = split;
    o.worldHost.classList.toggle('split', split);
    o.world.resize();
    o.world.frame(o.frameState());
  };

  /** The mode switch (SP4c spec §2.1, §2.2): saved at once; a switch to A while locked releases the lock. */
  const setMode = (next: MapMode): void => {
    if (disposed || next === mode) return;
    if (next === 'split' && !splitAvailable(o.win.innerWidth)) return;
    preferred = next;
    mode = next;
    o.save({ mapMode: preferred, watchLive });
    if (shown) {
      syncLayout();
      if (mode === 'full' && o.doc.pointerLockElement !== null) o.doc.exitPointerLock();
    }
    syncOwner();
    syncCap();
    syncControls();
  };
  fullButton.addEventListener('click', () => setMode('full'));
  splitButton.addEventListener('click', () => setMode('split'));
  watchBox.addEventListener('change', () => {
    watchLive = watchBox.checked;
    o.save({ mapMode: preferred, watchLive });
  });
  centreButton.addEventListener('click', () => {
    if (shown && tool !== null) showOnCamera(tool);
  });
  closeButton.addEventListener('click', () => close());
  syncControls();

  const shortcutsEnabled = (a: ShortcutAction): boolean =>
    owner === 'map' && shown && (a !== 'closeDrawer' || escapeAllowed(o.now(), o.doc.pointerLockElement !== null, unlockedAt));

  /** Centres the shown tool on the camera at its zoom and draws the arrow there (SP4c spec §1.5). */
  const showOnCamera = (t: MapTool): void => {
    t.show({ x: o.fly.x, z: o.fly.z });
    t.setPlayer(o.fly.x, o.fly.z, o.fly.yaw);
  };

  const mount = (m: ToolModule): void => {
    // Closed or disposed while the chunk loaded: the next open mounts.
    if (disposed || tool !== null || !shown) return;
    tool = m.createMapTool(host, {
      session: o.session,
      pool: o.pool,
      driver: o.driver,
      relay: o.relay,
      storage: o.storage,
      initialView: { x: o.fly.x, z: o.fly.z, bpp: WORLD_MAP_BPP, layer: DEFAULT_MAP_STATE.view.layer },
      host: 'world',
      urlSink: null,
      onView: null,
      onTeleport: (x, z) => {
        o.onTeleport(x, z).then((ok) => {
          if (ok && !disposed && mode === 'full') close();
        }, (e: unknown) => console.error('The teleport failed:', e));
      },
      toolbarSlot: slot,
      shortcutsEnabled,
    });
    showOnCamera(tool);
  };

  function open(): void {
    if (disposed || shown) return;
    shown = true;
    // A stored B opens as A while the window is narrower than SPLIT_MIN_WIDTH (SP4c spec §2.2).
    mode = modeFor();
    host.style.display = '';
    syncLayout();
    if (o.doc.pointerLockElement !== null) o.doc.exitPointerLock();
    syncOwner();
    syncCap();
    syncControls();
    if (tool !== null) showOnCamera(tool);
    else if (mod !== null) mount(mod);
    else {
      load().then(mount, (e: unknown) => {
        // The chunk did not arrive (offline, a new deploy): the world comes back; the next M retries.
        console.error('The map could not load:', e);
        if (tool === null) close();
      });
    }
  }

  function close(): void {
    if (!shown) return;
    shown = false;
    host.style.display = 'none';
    tool?.hide();
    syncLayout();
    syncOwner();
    syncCap();
  }

  return {
    get owner() { return owner; },
    get shown() { return shown; },
    get mode() { return mode; },
    get tool() { return tool; },
    toggle() {
      if (shown) close();
      else open();
    },
    open,
    close,
    tick() {
      if (shown && tool !== null) tool.setPlayer(o.fly.x, o.fly.z, o.fly.yaw);
    },
    applied(from) {
      if (from !== null && shown && mode === 'full' && watchLive) close();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      o.win.clearTimeout(preload);
      o.doc.removeEventListener('pointerlockchange', onLockChange);
      o.win.removeEventListener('resize', onResize);
      const t = tool;
      if (t !== null) {
        try {
          // The tool's subscribe is still the caller of driver.change (R1): the gesture's urgent end reaches the driver.
          if (o.session.inGesture) o.session.endGesture();
        } finally {
          try {
            t.dispose();
          } finally {
            tool = null;
          }
        }
      }
      shown = false;
      host.remove();
      // The world gets the whole window back for the failure panel or the notice; its renderer may already be released,
      // so no resize or frame here (its ResizeObserver follows the host while it lives).
      if (worldSplit) {
        worldSplit = false;
        o.worldHost.classList.remove('split');
      }
      syncOwner();
    },
  };
}

/** A header button: `type="button"`, with its id. */
function button(id: string, text: string): HTMLButtonElement {
  const b = el('button', 'map-header-button', text);
  b.type = 'button';
  b.id = id;
  return b;
}

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
import type { WorldSession } from '../../engine/session';
import type { WorkerPool } from '../../engine/workerPool';
import type { FlyState } from '../../player/fly';
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
  /** `#world-host` (mode B moves it, Task 16). */
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
  /** Saves a mode or Watch-live change at once (Task 16). */
  save(s: Pick<WorldSettings, 'mapMode' | 'watchLive'>): void;
  /** The camera: the map opens centred on it, and the arrow follows it. */
  readonly fly: FlyState;
  /** The world's input: cleared on every change of owner. */
  readonly input: { clear(): void };
  readonly doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'pointerLockElement' | 'exitPointerLock' | 'activeElement'>;
  readonly win: Pick<Window, 'setTimeout' | 'clearTimeout'>;
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

  const mode: MapMode = o.settings.mapMode;
  let shown = false;
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
    const slot = el('span', 'map-overlay-slot');
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
    host.style.display = '';
    if (o.doc.pointerLockElement !== null) o.doc.exitPointerLock();
    syncOwner();
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
    syncOwner();
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
    dispose() {
      if (disposed) return;
      disposed = true;
      o.win.clearTimeout(preload);
      o.doc.removeEventListener('pointerlockchange', onLockChange);
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
      syncOwner();
    },
  };
}

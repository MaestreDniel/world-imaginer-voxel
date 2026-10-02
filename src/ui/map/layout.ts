/**
 * The editor page layout (SP2b spec §3.1): a CSS grid with the toolbar row, a notice strip, the main row
 * (the map, a splitter and the side panel with the tabs World, Parameters, Biomes and Presets) and the
 * drawer row under both, with its own splitter. The drawer is closed until an editor opens it. Panel width,
 * drawer height, active tab and open sections persist in localStorage under `wi10.layout.v1`: the parsing
 * and clamping are pure, and every storage access is behind try/catch, so a missing, invalid or unreachable
 * value gives the defaults. The map canvas follows its host through mapView's ResizeObserver.
 */
import { el } from '../common/dom';

export type TabId = 'world' | 'parameters' | 'biomes' | 'presets';
export const TAB_IDS: readonly TabId[] = Object.freeze(['world', 'parameters', 'biomes', 'presets']);
const TAB_LABELS: Readonly<Record<TabId, string>> = { world: 'World', parameters: 'Parameters', biomes: 'Biomes', presets: 'Presets' };

/** What the page remembers between visits. */
export interface Layout {
  /** Side panel width in CSS px, 280-520. */
  readonly panelWidth: number;
  /** Drawer height in CSS px, at least 160; it is shown at most 60 % of the viewport high. */
  readonly drawerHeight: number;
  readonly tab: TabId;
  /** Group paths of the open parameter-panel sections (Task 17), first opened first. */
  readonly openSections: readonly string[];
}

export const LAYOUT_KEY = 'wi10.layout.v1';
export const PANEL_MIN_PX = 280;
export const PANEL_MAX_PX = 520;
export const DRAWER_MIN_PX = 160;
export const DRAWER_MAX_FRACTION = 0.6;
export const DEFAULT_LAYOUT: Layout = Object.freeze({ panelWidth: 340, drawerHeight: 300, tab: 'world', openSections: Object.freeze([]) });

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTabId = (v: unknown): v is TabId => typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rounds into 280-520 px; a non-finite width gives the default. */
export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_LAYOUT.panelWidth;
  return Math.round(Math.min(PANEL_MAX_PX, Math.max(PANEL_MIN_PX, w)));
}

/** Rounds into [160, max(160, ⌊0.6 · viewportHeight⌋)] px; a non-finite height starts from the default. */
export function clampDrawerHeight(h: number, viewportHeight: number): number {
  const hi = Math.max(DRAWER_MIN_PX, Math.floor(DRAWER_MAX_FRACTION * viewportHeight));
  const v = Number.isFinite(h) ? h : DEFAULT_LAYOUT.drawerHeight;
  return Math.round(Math.min(hi, Math.max(DRAWER_MIN_PX, v)));
}

/** The stored text, field by field: a missing or invalid field gives its default; text that is not a JSON object gives the defaults. */
export function parseLayout(text: string | null): Layout {
  if (text === null) return DEFAULT_LAYOUT;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!isRecord(j)) return DEFAULT_LAYOUT;
  const sections = j['openSections'];
  const drawer = j['drawerHeight'];
  return {
    panelWidth: isFiniteNumber(j['panelWidth']) ? clampPanelWidth(j['panelWidth']) : DEFAULT_LAYOUT.panelWidth,
    drawerHeight: isFiniteNumber(drawer) ? Math.round(Math.max(DRAWER_MIN_PX, drawer)) : DEFAULT_LAYOUT.drawerHeight,
    tab: isTabId(j['tab']) ? j['tab'] : DEFAULT_LAYOUT.tab,
    openSections: Array.isArray(sections) && sections.every((s) => typeof s === 'string') ? [...new Set(sections as string[])] : [],
  };
}

export function serializeLayout(l: Layout): string {
  return JSON.stringify({ panelWidth: l.panelWidth, drawerHeight: l.drawerHeight, tab: l.tab, openSections: l.openSections });
}

/** `l` with the section at `path` open or closed. */
export function withSection(l: Layout, path: string, open: boolean): Layout {
  const rest = l.openSections.filter((p) => p !== path);
  return { ...l, openSections: open ? [...rest, path] : rest };
}

/** The part of Storage the layout uses. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The page's localStorage, or null where even reading the property throws (blocked site data). */
export function browserStorage(): LayoutStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadLayout(storage: LayoutStorage | null): Layout {
  if (storage === null) return DEFAULT_LAYOUT;
  try {
    return parseLayout(storage.getItem(LAYOUT_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** False when there is no storage or the write throws (quota, blocked); the page keeps working either way. */
export function saveLayout(storage: LayoutStorage | null, l: Layout): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(LAYOUT_KEY, serializeLayout(l));
    return true;
  } catch {
    return false;
  }
}

/** The page's regions and the layout actions (the P and Escape shortcuts, the editors' drawer and sections). */
export interface PageLayout {
  readonly toolbar: HTMLElement;
  /** The notice strip under the toolbar (visible from every tab and with the panel hidden). */
  readonly notices: HTMLElement;
  /** The map canvas host. */
  readonly map: HTMLElement;
  /** The host of each tab's content. */
  readonly tabs: Readonly<Record<TabId, HTMLElement>>;
  /** The drawer's content host (the spline editor, Task 18). */
  readonly drawer: HTMLElement;
  readonly tab: TabId;
  showTab(id: TabId): void;
  readonly panelVisible: boolean;
  togglePanel(): void;
  /** Calls `fn` after a tab is shown or the panel is shown or hidden; returns the unsubscribe function. */
  onPanelChange(fn: () => void): () => void;
  readonly drawerOpen: boolean;
  openDrawer(): void;
  closeDrawer(): void;
  sectionOpen(path: string): boolean;
  setSectionOpen(path: string, open: boolean): void;
}

/** Builds the page grid in `root` from the stored layout and keeps the stored layout up to date. */
export function createLayout(root: HTMLElement, storage: LayoutStorage | null): PageLayout {
  let layout = loadLayout(storage);
  const commit = (l: Layout) => { layout = l; saveLayout(storage, l); };

  const page = el('div', 'map');
  const toolbar = el('div', 'map-toolbar');
  const notices = el('div', 'map-notices');
  const map = el('div', 'map-view');
  const vsplit = el('div', 'map-split map-split-v');
  vsplit.setAttribute('role', 'separator');
  vsplit.setAttribute('aria-orientation', 'vertical');
  vsplit.title = 'Drag to resize the panel';
  const side = el('div', 'map-side');
  const tabBar = el('div', 'map-tabs');
  tabBar.setAttribute('role', 'tablist');
  const hsplit = el('div', 'map-split map-split-h');
  hsplit.setAttribute('role', 'separator');
  hsplit.setAttribute('aria-orientation', 'horizontal');
  hsplit.title = 'Drag to resize the drawer';
  const drawer = el('div', 'map-drawer');
  hsplit.hidden = true;
  drawer.hidden = true;

  const buttons = {} as Record<TabId, HTMLButtonElement>;
  const tabs = {} as Record<TabId, HTMLElement>;
  for (const id of TAB_IDS) {
    const b = el('button', '', TAB_LABELS[id]);
    b.type = 'button';
    b.id = `map-tab-${id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `map-tabpanel-${id}`);
    b.addEventListener('click', () => showTab(id));
    const host = el('div', 'map-tab');
    host.id = `map-tabpanel-${id}`;
    host.dataset['tab'] = id;
    host.setAttribute('role', 'tabpanel');
    host.setAttribute('aria-labelledby', b.id);
    buttons[id] = b;
    tabs[id] = host;
    tabBar.append(b);
  }
  side.append(tabBar, ...TAB_IDS.map((id) => tabs[id]));
  page.append(toolbar, notices, map, vsplit, side, hsplit, drawer);
  root.replaceChildren(page);

  const applySizes = () => {
    page.style.setProperty('--panel-w', `${layout.panelWidth}px`);
    page.style.setProperty('--drawer-h', `${layout.drawerHeight}px`);
  };
  const panelFns = new Set<() => void>();
  const panelChanged = () => { for (const fn of [...panelFns]) fn(); };
  function showTab(id: TabId): void {
    for (const t of TAB_IDS) {
      buttons[t].setAttribute('aria-selected', String(t === id));
      buttons[t].tabIndex = t === id ? 0 : -1;
      tabs[t].hidden = t !== id;
    }
    if (layout.tab !== id) commit({ ...layout, tab: id });
    panelChanged();
  }
  applySizes();
  showTab(layout.tab);

  /** A splitter drag: pointer capture, a size per move from the press point, the layout stored on release. */
  const splitter = (handle: HTMLElement, size: (from: Layout, dx: number, dy: number) => Partial<Layout>) => {
    let drag: { readonly x: number; readonly y: number; readonly from: Layout } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, from: layout };
      handle.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (drag === null) return;
      layout = { ...layout, ...size(drag.from, e.clientX - drag.x, e.clientY - drag.y) };
      applySizes();
    });
    const end = () => {
      if (drag === null) return;
      drag = null;
      handle.classList.remove('dragging');
      commit(layout);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };
  // The panel is right of its splitter and the drawer below its own: dragging left or up makes them larger.
  splitter(vsplit, (from, dx) => ({ panelWidth: clampPanelWidth(from.panelWidth - dx) }));
  splitter(hsplit, (from, _dx, dy) => ({ drawerHeight: clampDrawerHeight(clampDrawerHeight(from.drawerHeight, innerHeight) - dy, innerHeight) }));

  const setDrawer = (open: boolean) => { drawer.hidden = !open; hsplit.hidden = !open; };

  return {
    toolbar, notices, map, tabs, drawer,
    get tab() { return layout.tab; },
    showTab,
    get panelVisible() { return !page.classList.contains('panel-hidden'); },
    togglePanel() {
      page.classList.toggle('panel-hidden');
      panelChanged();
    },
    onPanelChange(fn) {
      panelFns.add(fn);
      return () => { panelFns.delete(fn); };
    },
    get drawerOpen() { return !drawer.hidden; },
    openDrawer() { setDrawer(true); },
    closeDrawer() { setDrawer(false); },
    sectionOpen(path) { return layout.openSections.includes(path); },
    setSectionOpen(path, open) {
      if (layout.openSections.includes(path) !== open) commit(withSection(layout, path, open));
    },
  };
}

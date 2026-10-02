/**
 * The editor page layout (SP2b spec §3.1): a CSS grid with the toolbar row, a notice strip, the main row
 * (the map, a splitter and the side panel with the tabs World, Parameters, Biomes and Presets) and the
 * drawer row under both, with its own splitter and the tabs Spline (§4.2) and Cross-section (§4.5). The
 * drawer is closed until an editor opens it on its tab. Panel width, drawer height, active tab and open
 * sections persist in localStorage under `wi10.layout.v1`: the parsing and clamping are pure, and every
 * storage access is behind try/catch, so a missing, invalid or unreachable value gives the defaults. The map
 * canvas follows its host through mapView's ResizeObserver.
 */
import { el } from '../common/dom';

export type TabId = 'world' | 'parameters' | 'biomes' | 'presets';
export const TAB_IDS: readonly TabId[] = Object.freeze(['world', 'parameters', 'biomes', 'presets']);
const TAB_LABELS: Readonly<Record<TabId, string>> = { world: 'World', parameters: 'Parameters', biomes: 'Biomes', presets: 'Presets' };
export type DrawerTabId = 'spline' | 'section';
export const DRAWER_TAB_IDS: readonly DrawerTabId[] = Object.freeze(['spline', 'section']);
const DRAWER_TAB_LABELS: Readonly<Record<DrawerTabId, string>> = { spline: 'Spline', section: 'Cross-section' };

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
  /** The host of each drawer tab: the spline editor (§4.2) and the cross-section (§4.5). */
  readonly drawerTabs: Readonly<Record<DrawerTabId, HTMLElement>>;
  readonly tab: TabId;
  showTab(id: TabId): void;
  readonly panelVisible: boolean;
  togglePanel(): void;
  /** Calls `fn` after a tab is shown or the panel is shown or hidden; returns the unsubscribe function. */
  onPanelChange(fn: () => void): () => void;
  readonly drawerOpen: boolean;
  /** The drawer tab shown while the drawer is open (not stored; Spline at first). */
  readonly drawerTab: DrawerTabId;
  /** Shows the drawer row on `tab`. */
  openDrawer(tab: DrawerTabId): void;
  closeDrawer(): void;
  /** Calls `fn` after the drawer opens or closes or, while open, shows another tab; returns the unsubscribe function. */
  onDrawerChange(fn: () => void): () => void;
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
  const drawerBar = el('div', 'map-drawer-tabs');
  drawerBar.setAttribute('role', 'tablist');
  drawerBar.setAttribute('aria-label', 'Drawer');

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
  const drawerButtons = {} as Record<DrawerTabId, HTMLButtonElement>;
  const drawerTabs = {} as Record<DrawerTabId, HTMLElement>;
  for (const id of DRAWER_TAB_IDS) {
    const b = el('button', '', DRAWER_TAB_LABELS[id]);
    b.type = 'button';
    b.id = `map-drawer-tab-${id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `map-drawer-tabpanel-${id}`);
    b.addEventListener('click', () => setDrawer(true, id));
    const host = el('div', 'map-drawer-tab');
    host.id = `map-drawer-tabpanel-${id}`;
    host.setAttribute('role', 'tabpanel');
    host.setAttribute('aria-labelledby', b.id);
    drawerButtons[id] = b;
    drawerTabs[id] = host;
    drawerBar.append(b);
  }
  drawer.append(drawerBar, ...DRAWER_TAB_IDS.map((id) => drawerTabs[id]));
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

  let drawerTab: DrawerTabId = 'spline';
  const drawerFns = new Set<() => void>();
  const setDrawer = (open: boolean, tab: DrawerTabId = drawerTab) => {
    const changed = open !== !drawer.hidden || (open && tab !== drawerTab);
    drawerTab = tab;
    drawer.hidden = !open;
    hsplit.hidden = !open;
    for (const t of DRAWER_TAB_IDS) {
      drawerButtons[t].setAttribute('aria-selected', String(t === tab));
      drawerButtons[t].tabIndex = t === tab ? 0 : -1;
      drawerTabs[t].hidden = t !== tab;
    }
    if (changed) for (const fn of [...drawerFns]) fn();
  };
  setDrawer(false);

  return {
    toolbar, notices, map, tabs, drawerTabs,
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
    get drawerTab() { return drawerTab; },
    openDrawer(tab) { setDrawer(true, tab); },
    closeDrawer() { setDrawer(false); },
    onDrawerChange(fn) {
      drawerFns.add(fn);
      return () => { drawerFns.delete(fn); };
    },
    sectionOpen(path) { return layout.openSections.includes(path); },
    setSectionOpen(path, open) {
      if (layout.openSections.includes(path) !== open) commit(withSection(layout, path, open));
    },
  };
}

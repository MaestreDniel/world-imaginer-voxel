/**
 * The creative palette (SP5a spec §4.4, D10): an overlay like the help, over the paused world and above the hotbar.
 * A search box (not focused at opening), then every placeable block in four groups, Building, Wool and Terrain (§1.1's categories, each type in registry order)
 * and Fluids (the water, lava and empty buckets); a click on a swatch writes the hotbar's active slot, and hovering one
 * names it in the line under the grid. The search keeps the swatches whose display name holds the typed text, ignoring
 * case, and hides the groups left empty. Text only through `textContent`; no `confirm` or `alert`.
 *
 * The page opens it on E and closes it first on M and H (`paletteFirst`). Opening releases the pointer lock. While it
 * is open, a click on the backdrop around its panel closes it and requests the lock back, and E closes it and requests the lock back (E's keydown is a user activation) unless the search box has the
 * focus, where E types (`isTextEntry`; the world's input ignores keys there too), and Esc closes it and is
 * consumed, as the help's Esc is (the map's window shortcut skips a default-prevented key). A held E's key repeat does
 * not close what its first press opened.
 */
import { slotName, type Hotbar } from '../player/hotbar';
import type { Slot } from '../player/interaction';
import { isTextEntry } from '../player/input';
import { resolveKey } from '../player/keymap';
import { REGISTRY } from '../world/blocks/index';
import { CATEGORY, CATEGORY_ORDER, CATEGORY_VALUES, PLACEABLE } from '../world/blocks/tags';
import { el } from './common/dom';
import { swatchColor } from './world/buildHud';

export type PaletteGroup = 'building' | 'wool' | 'terrain' | 'fluids';

export interface Palette {
  readonly isOpen: boolean;
  open(): void;
  /** Closes without requesting the lock (M and H, whose overlays want the pointer free). */
  close(): void;
  /** Removes the overlay and its key listener; `onClose` is not called. */
  dispose(): void;
}

const GROUP_TITLES: Readonly<Record<PaletteGroup, string>> = {
  building: 'Building', wool: 'Wool', terrain: 'Terrain', fluids: 'Fluids',
};

/** The Fluids group: the buckets, after the blocks. */
const BUCKETS: readonly Slot[] = Object.freeze([
  Object.freeze({ fluid: 'water' as const }), Object.freeze({ fluid: 'lava' as const }), Object.freeze({ tool: 'emptyBucket' as const }),
]);

/** Every group's items with no search, built once: the placeable types of each category in registry order, then the buckets. */
const ALL_GROUPS: ReadonlyArray<{ group: PaletteGroup; items: readonly Slot[] }> = [
  ...CATEGORY_ORDER.map((group) => {
    const items: Slot[] = [];
    for (let t = 0; t < REGISTRY.typeCount; t++) {
      if (PLACEABLE[t] === 1 && CATEGORY_VALUES[CATEGORY[t]!] === group) {
        items.push(Object.freeze({ type: REGISTRY.TYPE_NAMES[t]!, pinned: Object.freeze({}) }));
      }
    }
    return { group, items };
  }),
  { group: 'fluids', items: BUCKETS },
];

/**
 * The palette's groups in display order, each with the items whose display name ("Oak planks", "Water bucket") holds
 * `query` as a case-insensitive substring (registry order; Fluids: water, lava, empty bucket), empty groups dropped.
 * The empty query keeps every item.
 */
export function paletteGroups(query: string): { group: PaletteGroup; items: Slot[] }[] {
  const q = query.toLowerCase();
  return ALL_GROUPS.map((g) => ({ group: g.group, items: g.items.filter((s) => slotName(s).toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);
}

/** A swatch's key, in its id (`palette-slot-<key>`) and `data-slot`: the type name, `water_bucket`, `lava_bucket` or `empty_bucket`. */
function slotKey(slot: Slot): string {
  if ('type' in slot) return slot.type;
  if ('fluid' in slot) return `${slot.fluid}_bucket`;
  return 'empty_bucket';
}

export function mountPalette(host: HTMLElement, o: { hotbar: Hotbar; requestLock(): void; onClose(): void }): Palette {
  let isOpen = false;
  // The overlay covers the world as the help does, so no click reaches the canvas (whose click takes the lock); it
  // draws nothing itself, so the hotbar shows through around the panel, which holds the content.
  const overlay = el('div', 'world-palette');
  overlay.id = 'world-palette';
  overlay.hidden = true;
  const panel = el('div', 'palette-panel');
  panel.id = 'palette-panel';
  const search = el('input', 'palette-search');
  search.id = 'palette-search';
  search.type = 'search';
  search.placeholder = 'Search blocks';
  search.setAttribute('aria-label', 'Search blocks');
  const groups = el('div', 'palette-groups');
  groups.id = 'palette-groups';
  const name = el('div', 'palette-name');
  name.id = 'palette-name';

  const swatch = (slot: Slot): HTMLButtonElement => {
    const b = el('button', 'palette-swatch');
    const key = slotKey(slot);
    b.id = `palette-slot-${key}`;
    b.type = 'button';
    b.dataset.slot = key;
    b.style.background = swatchColor(slot);
    b.setAttribute('aria-label', slotName(slot));
    b.addEventListener('click', () => o.hotbar.assign(slot));
    b.addEventListener('mouseenter', () => {
      name.textContent = slotName(slot);
    });
    b.addEventListener('mouseleave', () => {
      name.textContent = '';
    });
    return b;
  };
  // The groups are rebuilt from the search's text on each input; the swatches are made once and reused.
  const swatches = new Map<Slot, HTMLButtonElement>();
  const swatchOf = (slot: Slot): HTMLButtonElement => {
    let b = swatches.get(slot);
    if (b === undefined) {
      b = swatch(slot);
      swatches.set(slot, b);
    }
    return b;
  };
  const render = (): void => {
    const sections: HTMLElement[] = [];
    for (const g of paletteGroups(search.value)) {
      const section = el('section', 'palette-group');
      const grid = el('div', 'palette-grid');
      for (const slot of g.items) grid.append(swatchOf(slot));
      section.append(el('h3', '', GROUP_TITLES[g.group]), grid);
      sections.push(section);
    }
    groups.replaceChildren(...sections);
    name.textContent = '';
  };
  search.addEventListener('input', render);
  render();
  panel.append(search, groups, name);
  overlay.append(panel);
  host.append(overlay);
  // A click on the backdrop around the panel returns to the world: it closes and requests the lock (the click is a user
  // activation). Only a press that started there: a drag from the search box released outside the panel sends its click
  // to the overlay too.
  let pressedBackdrop = false;
  overlay.addEventListener('mousedown', (e) => {
    pressedBackdrop = e.target === overlay;
  });
  overlay.addEventListener('click', (e) => {
    if (!isOpen || e.target !== overlay || !pressedBackdrop) return;
    close();
    o.requestLock();
  });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' || e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.repeat || resolveKey(e) !== 'palette') return;
    // In the search box E is a letter.
    if (isTextEntry(document.activeElement as HTMLElement | null)) return;
    e.preventDefault();
    close();
    o.requestLock();
  };

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    overlay.hidden = true;
    name.textContent = '';
    // A focused search box, hidden, would still take the world's keys (`isTextEntry`).
    if (document.activeElement === search) search.blur();
    document.removeEventListener('keydown', onKeyDown);
    o.onClose();
  }

  return {
    get isOpen() {
      return isOpen;
    },
    open() {
      if (isOpen) return;
      isOpen = true;
      overlay.hidden = false;
      document.exitPointerLock();
      document.addEventListener('keydown', onKeyDown);
    },
    close,
    dispose() {
      isOpen = false;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    },
  };
}

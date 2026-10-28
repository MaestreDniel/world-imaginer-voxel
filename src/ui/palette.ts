/**
 * The creative palette (SP5a spec §4.4, D10): an overlay like the help, over the paused world and above the hotbar.
 * Every placeable block in four groups, Building, Wool and Terrain (§1.1's categories, each type in registry order)
 * and Fluids (the water, lava and empty buckets); a click on a swatch writes the hotbar's active slot, and hovering one
 * names it in the line under the grid. Text only through `textContent`; no `confirm` or `alert`.
 *
 * The page opens it on E and closes it first on M and H (`paletteFirst`). Opening releases the pointer lock. While it
 * is open, E closes it and requests the lock back (E's keydown is a user activation), and Esc closes it and is
 * consumed, as the help's Esc is (the map's window shortcut skips a default-prevented key). A held E's key repeat does
 * not close what its first press opened.
 */
import { slotName, type Hotbar } from '../player/hotbar';
import type { Slot } from '../player/interaction';
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
 * The palette's groups in display order, each with its items (registry order; Fluids: water, lava, empty bucket),
 * empty groups dropped. The search's filter arrives with the search box: until then `query` is not read.
 */
export function paletteGroups(query: string): { group: PaletteGroup; items: Slot[] }[] {
  void query;
  return ALL_GROUPS.map((g) => ({ group: g.group, items: [...g.items] })).filter((g) => g.items.length > 0);
}

/** A swatch's key, in its id (`palette-slot-<key>`) and `data-slot`: the type name, `water_bucket`, `lava_bucket` or `empty_bucket`. */
function slotKey(slot: Slot): string {
  if ('type' in slot) return slot.type;
  if ('fluid' in slot) return `${slot.fluid}_bucket`;
  return 'empty_bucket';
}

export function mountPalette(host: HTMLElement, o: { hotbar: Hotbar; requestLock(): void; onClose(): void }): Palette {
  let isOpen = false;
  const overlay = el('div', 'world-palette');
  overlay.id = 'world-palette';
  overlay.hidden = true;
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
  for (const g of paletteGroups('')) {
    const section = el('section', 'palette-group');
    const grid = el('div', 'palette-grid');
    for (const slot of g.items) grid.append(swatch(slot));
    section.append(el('h3', '', GROUP_TITLES[g.group]), grid);
    groups.append(section);
  }
  overlay.append(groups, name);
  host.append(overlay);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' || e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.repeat || resolveKey(e) !== 'palette') return;
    e.preventDefault();
    close();
    o.requestLock();
  };

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    overlay.hidden = true;
    name.textContent = '';
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

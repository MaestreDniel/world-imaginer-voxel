import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHotbar } from '../../src/player/hotbar';
import type { Slot } from '../../src/player/interaction';
import { mountPalette, paletteGroups } from '../../src/ui/palette';
import { REGISTRY } from '../../src/world/blocks/index';
import { CATEGORY, CATEGORY_VALUES, PLACEABLE } from '../../src/world/blocks/tags';
import { installDom, type FakeElement } from './fixtures/domShim';

const BUCKETS: Slot[] = [{ fluid: 'water' }, { fluid: 'lava' }, { tool: 'emptyBucket' }];

/** The placeable type names, in registry (id) order. */
const PLACEABLE_NAMES = REGISTRY.TYPE_NAMES.filter((_, t) => PLACEABLE[t] === 1);

/** A block item's type name, or null for a bucket. */
const typeOf = (s: Slot): string | null => ('type' in s ? s.type : null);

describe('paletteGroups: the creative palette\'s content (SP5a spec §4.4, D10; master §6.3)', () => {
  test('every `PLACEABLE` type appears once, in its `CATEGORY` group, plus the three bucket items', () => {
    const groups = paletteGroups('');
    expect(groups.map((g) => g.group)).toEqual(['building', 'wool', 'terrain', 'fluids']);
    const all = groups.flatMap((g) => g.items.map((s) => ({ group: g.group, s })));
    expect(all).toHaveLength(PLACEABLE_NAMES.length + 3);
    for (const name of PLACEABLE_NAMES) {
      const found = all.filter((x) => typeOf(x.s) === name);
      expect(found, name).toHaveLength(1);
      expect(found[0]!.group, name).toBe(CATEGORY_VALUES[CATEGORY[REGISTRY.typeId(name)]!]);
      expect(found[0]!.s, name).toEqual({ type: name, pinned: {} });
    }
    // Air and the wall torch are never offered.
    expect(all.some((x) => typeOf(x.s) === 'air' || typeOf(x.s) === 'wall_torch')).toBe(false);
    // Registry order within a group; the buckets alone in Fluids, after the blocks.
    for (const g of groups.slice(0, 3)) {
      expect(g.items.map(typeOf), g.group).toEqual(PLACEABLE_NAMES.filter((n) => CATEGORY_VALUES[CATEGORY[REGISTRY.typeId(n)]!] === g.group));
    }
    expect(groups[0]!.items.map(typeOf)).toEqual(['oak_planks', 'oak_log', 'cobblestone', 'bricks', 'glass', 'torch', 'ladder']);
    expect(groups[1]!.items).toHaveLength(16);
    expect(groups[1]!.items.map(typeOf).at(0)).toBe('white_wool');
    expect(groups[1]!.items.map(typeOf).at(-1)).toBe('black_wool');
    expect(groups[2]!.items.map(typeOf).slice(0, 3)).toEqual(['stone', 'bedrock', 'grass_block']);
    expect(groups[2]!.items.map(typeOf)).toContain('ice');
    expect(groups[3]!.items).toEqual(BUCKETS);
  });

  test.skip('`\'wool\'` keeps only the Wool group; `\'oak\'` keeps Oak planks and Oak log; `\'zzz\'` nothing', () => {
    const wool = paletteGroups('wool');
    expect(wool.map((g) => g.group)).toEqual(['wool']);
    expect(wool[0]!.items).toHaveLength(16);
    const oak = paletteGroups('oak');
    expect(oak.map((g) => g.group)).toEqual(['building']);
    expect(oak[0]!.items.map(typeOf)).toEqual(['oak_planks', 'oak_log']);
    expect(paletteGroups('zzz')).toEqual([]);
    // Case-insensitive, over the display name ("Light blue wool", "Water bucket").
    expect(paletteGroups('OAK')).toEqual(oak);
    expect(paletteGroups('light blue').flatMap((g) => g.items.map(typeOf))).toEqual(['light_blue_wool']);
    expect(paletteGroups('bucket')).toEqual([{ group: 'fluids', items: BUCKETS }]);
  });
});

describe('mountPalette: the overlay (SP5a spec §4.4, D10)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const mount = () => {
    const hotbar = createHotbar(null);
    const requestLock = vi.fn();
    const onClose = vi.fn();
    const palette = mountPalette(dom.body as unknown as HTMLElement, { hotbar, requestLock, onClose });
    return { hotbar, requestLock, onClose, palette };
  };
  const key = (code: string, k: string, repeat = false) => {
    const e = Object.assign(new Event('keydown', { cancelable: true }), { code, key: k, repeat });
    dom.document.dispatchEvent(e);
    return e;
  };
  const swatches = (): FakeElement[] => dom.el('world-palette').querySelectorAll('button').filter((b) => b.classList.contains('palette-swatch'));

  test('hidden until opened; opening releases the lock and lists every placeable type and the three buckets, under the four headings', () => {
    const { palette } = mount();
    expect(dom.el('world-palette').hidden).toBe(true);
    expect(palette.isOpen).toBe(false);
    const canvas = dom.document.createElement('canvas');
    dom.document.setPointerLock(canvas);
    palette.open();
    expect(palette.isOpen).toBe(true);
    expect(dom.el('world-palette').hidden).toBe(false);
    expect(dom.document.pointerLockElement).toBe(null);
    expect(dom.document.exitPointerLockCalls).toBe(1);
    expect(dom.el('world-palette').querySelectorAll('h3').map((h) => h.textContent)).toEqual(['Building', 'Wool', 'Terrain', 'Fluids']);
    expect(swatches().map((b) => b.dataset.slot)).toEqual([...paletteGroups('').flatMap((g) => g.items.map((s) => typeOf(s) ?? ('fluid' in s ? `${s.fluid}_bucket` : 'empty_bucket')))]);
    expect(swatches()).toHaveLength(PLACEABLE_NAMES.length + 3);
    // Each swatch is the block's flat colour, as the hotbar draws it.
    expect(dom.el('palette-slot-bricks').style.background).toBe('rgb(168, 80, 70)');
  });

  test('a click on Bricks assigns it to the active slot', () => {
    const { hotbar, palette } = mount();
    palette.open();
    hotbar.select(3);
    dom.el('palette-slot-bricks').click();
    expect(hotbar.active).toBe(3);
    expect(hotbar.slots[3]).toEqual({ type: 'bricks', pinned: {} });
    // The palette stays open for the next choice; a bucket assigns the same way.
    expect(palette.isOpen).toBe(true);
    hotbar.select(0);
    dom.el('palette-slot-empty_bucket').click();
    expect(hotbar.slots[0]).toEqual({ tool: 'emptyBucket' });
  });

  test('hovering a swatch names it below the grid', () => {
    const { palette } = mount();
    palette.open();
    const name = dom.el('palette-name');
    expect(name.textContent).toBe('');
    dom.el('palette-slot-light_blue_wool').dispatchEvent(new Event('mouseenter'));
    expect(name.textContent).toBe('Light blue wool');
    dom.el('palette-slot-water_bucket').dispatchEvent(new Event('mouseenter'));
    expect(name.textContent).toBe('Water bucket');
    dom.el('palette-slot-water_bucket').dispatchEvent(new Event('mouseleave'));
    expect(name.textContent).toBe('');
    // The name line comes after the grid.
    const children = dom.el('world-palette').children;
    expect(children.indexOf(name)).toBeGreaterThan(children.indexOf(dom.el('palette-groups')));
  });

  test('E unfocused closes and requests the lock; Esc closes and is default-prevented; closed, neither acts', () => {
    const { palette, requestLock, onClose } = mount();
    // Closed: E and Esc are left alone (the world's input opens the palette on E; the map or the browser gets Esc).
    expect(key('KeyE', 'e').defaultPrevented).toBe(false);
    expect(key('Escape', 'Escape').defaultPrevented).toBe(false);
    expect(requestLock).not.toHaveBeenCalled();
    palette.open();
    // A held E's key repeat does not close what its first press opened.
    key('KeyE', 'e', true);
    expect(palette.isOpen).toBe(true);
    expect(key('KeyE', 'e').defaultPrevented).toBe(true);
    expect(palette.isOpen).toBe(false);
    expect(dom.el('world-palette').hidden).toBe(true);
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    palette.open();
    const esc = key('Escape', 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(palette.isOpen).toBe(false);
    // Esc only closes: the pointer stays free until a click on the canvas.
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
    // The listener goes with the overlay.
    expect(key('Escape', 'Escape').defaultPrevented).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test.skip('E with the search focused types (no close); the search box is not focused at opening', () => {
    const { palette, requestLock } = mount();
    palette.open();
    expect(dom.document.activeElement).toBe(dom.body);
    const search = dom.el('palette-search');
    search.focus();
    const e = key('KeyE', 'e');
    expect(e.defaultPrevented).toBe(false);
    expect(palette.isOpen).toBe(true);
    expect(requestLock).not.toHaveBeenCalled();
    // Esc still closes, and gives the focus back so the world's keys work again.
    key('Escape', 'Escape');
    expect(palette.isOpen).toBe(false);
    expect(dom.document.activeElement).toBe(dom.body);
  });

  test.skip('the search box filters the swatches by display name; groups with no match hide', () => {
    const { palette } = mount();
    palette.open();
    const search = dom.el('palette-search');
    expect(search.type).toBe('search');
    const type = (v: string): void => {
      search.value = v;
      search.dispatchEvent(new Event('input'));
    };
    type('Oak');
    expect(swatches().map((b) => b.dataset.slot)).toEqual(['oak_planks', 'oak_log']);
    expect(dom.el('world-palette').querySelectorAll('h3').map((h) => h.textContent)).toEqual(['Building']);
    type('zzz');
    expect(swatches()).toEqual([]);
    type('');
    expect(swatches()).toHaveLength(PLACEABLE_NAMES.length + 3);
  });

  test('close() closes without the lock; dispose removes the overlay and its key listener', () => {
    const { palette, requestLock, onClose } = mount();
    palette.open();
    palette.close();
    expect(palette.isOpen).toBe(false);
    expect(requestLock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing twice calls onClose once.
    palette.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    palette.open();
    palette.dispose();
    expect(() => dom.el('world-palette')).toThrow();
    expect(key('Escape', 'Escape').defaultPrevented).toBe(false);
  });
});

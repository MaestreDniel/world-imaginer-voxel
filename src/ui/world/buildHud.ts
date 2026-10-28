/**
 * The build HUD (SP5a spec §4.3, D9), in `#world-host`: the crosshair `+` at the centre, shown while the canvas holds
 * the pointer lock; the hotbar, nine 40 × 40 px swatches 10 px above the bottom centre, the active one with a 2 px
 * white border; and the slot's name 8 px above the bar for `SLOT_NAME_MS` after a change of the hotbar (a timer
 * `dispose` clears). Text only through `textContent`. Nothing is mounted when `hud` is false (captures, panoramas).
 *
 * The swatches follow the hotbar through its `subscribe`; `refresh`, which the page calls on every rendered frame,
 * only shows or hides the crosshair when the lock changed, and allocates nothing.
 */
import { slotName, type Hotbar } from '../../player/hotbar';
import type { Slot } from '../../player/interaction';
import { FLAT_COLORS } from '../../textures/flatColors';
import { el } from '../common/dom';
import { VOXEL_COLORS } from '../crossSection/voxels';

/** How long the slot's name shows after a change, ms. */
export const SLOT_NAME_MS = 1500;

/** The empty bucket's swatch: a bucket's metal grey (it is no block, so it has no flat colour). */
const EMPTY_BUCKET_RGB: readonly [number, number, number] = [170, 175, 182];

const css = (c: readonly [number, number, number]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/** A slot's swatch colour: the block's flat colour (`textures/flatColors.ts`), water's and lava's, the empty bucket's grey. */
export function swatchColor(slot: Slot): string {
  if ('type' in slot) return css(FLAT_COLORS.get(slot.type) ?? VOXEL_COLORS.unknown);
  if ('fluid' in slot) return css(slot.fluid === 'water' ? VOXEL_COLORS.water : VOXEL_COLORS.lava);
  return css(EMPTY_BUCKET_RGB);
}

export function mountBuildHud(host: HTMLElement, o: { hotbar: Hotbar; hud: boolean; locked(): boolean }): {
  refresh(): void;
  dispose(): void;
} {
  if (!o.hud) return { refresh() {}, dispose() {} };
  const { hotbar } = o;
  const cross = el('div', 'world-crosshair', '+');
  cross.id = 'world-crosshair';
  cross.hidden = true;
  const name = el('div', 'world-slot-name');
  name.id = 'world-slot-name';
  name.hidden = true;
  const bar = el('div', 'world-hotbar');
  bar.id = 'world-hotbar';
  const swatches: HTMLElement[] = [];
  for (let i = 0; i < hotbar.slots.length; i++) {
    const s = el('div', 'world-hotbar-slot');
    swatches.push(s);
    bar.append(s);
  }
  host.append(cross, name, bar);

  const draw = (): void => {
    for (let i = 0; i < swatches.length; i++) {
      const s = swatches[i]!;
      const slot = hotbar.slots[i]!;
      s.style.background = swatchColor(slot);
      s.title = slotName(slot);
      s.classList.toggle('active', i === hotbar.active);
    }
  };
  draw();

  let nameTimer: ReturnType<typeof setTimeout> | null = null;
  const clearNameTimer = (): void => {
    if (nameTimer !== null) clearTimeout(nameTimer);
    nameTimer = null;
  };
  const unsubscribe = hotbar.subscribe(() => {
    draw();
    name.textContent = slotName(hotbar.slots[hotbar.active]!);
    name.hidden = false;
    clearNameTimer();
    nameTimer = setTimeout(() => {
      nameTimer = null;
      name.hidden = true;
    }, SLOT_NAME_MS);
  });

  let shownLocked = false;
  return {
    refresh() {
      const locked = o.locked();
      if (locked === shownLocked) return;
      shownLocked = locked;
      cross.hidden = !locked;
    },
    dispose() {
      unsubscribe();
      clearNameTimer();
      cross.remove();
      name.remove();
      bar.remove();
    },
  };
}

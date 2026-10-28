import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHotbar } from '../../src/player/hotbar';
import { mountBuildHud, SLOT_NAME_MS } from '../../src/ui/world/buildHud';
import { installDom } from './fixtures/domShim';

describe('mountBuildHud: the crosshair, the hotbar and the slot name (SP5a spec §4.3, D9)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => {
    dom = installDom();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const mount = (o: { hud?: boolean; locked?: () => boolean } = {}) => {
    const hotbar = createHotbar(null);
    const hud = mountBuildHud(dom.body as unknown as HTMLElement, { hotbar, hud: o.hud ?? true, locked: o.locked ?? (() => false) });
    return { hotbar, hud };
  };

  test('nine swatches, the active framed', () => {
    const { hotbar } = mount();
    const bar = dom.el('world-hotbar');
    expect(bar.children).toHaveLength(9);
    const framed = () => bar.children.map((c) => c.classList.contains('active'));
    expect(framed()).toEqual([true, false, false, false, false, false, false, false, false]);
    // Each swatch is the slot's colour, named by its title: stone's flat colour, the water bucket's water.
    expect(bar.children[0]!.style.background).toBe('rgb(125, 125, 125)');
    expect(bar.children[0]!.title).toBe('Stone');
    expect(bar.children[7]!.title).toBe('Water bucket');
    hotbar.select(4);
    expect(framed()).toEqual([false, false, false, false, true, false, false, false, false]);
    hotbar.assign({ type: 'bricks', pinned: {} });
    expect(bar.children[4]!.style.background).toBe('rgb(168, 80, 70)');
    expect(bar.children[4]!.title).toBe('Bricks');
  });

  test('the crosshair shows once locked, on refresh', () => {
    let locked = false;
    const { hud } = mount({ locked: () => locked });
    const cross = dom.el('world-crosshair');
    expect(cross.textContent).toBe('+');
    expect(cross.hidden).toBe(true);
    locked = true;
    hud.refresh();
    expect(cross.hidden).toBe(false);
    locked = false;
    hud.refresh();
    expect(cross.hidden).toBe(true);
  });

  test('the name shows for 1.5 s after a change and its timer is cleared on dispose', () => {
    expect(SLOT_NAME_MS).toBe(1500);
    const { hotbar, hud } = mount();
    const name = dom.el('world-slot-name');
    expect(name.hidden).toBe(true);
    hotbar.select(2);
    expect([name.hidden, name.textContent]).toEqual([false, 'Grass block']);
    vi.advanceTimersByTime(1000);
    // A second change restarts the 1.5 s.
    hotbar.step(1);
    expect(name.textContent).toBe('Oak planks');
    vi.advanceTimersByTime(1499);
    expect(name.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(name.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    hotbar.step(-1);
    expect(vi.getTimerCount()).toBe(1);
    hud.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(dom.body.children).toHaveLength(0);
    // Disposed: a later change touches nothing.
    hotbar.select(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('`hud` false: nothing mounted', () => {
    const { hotbar, hud } = mount({ hud: false, locked: () => true });
    expect(dom.body.children).toHaveLength(0);
    hotbar.select(3);
    hud.refresh();
    expect(dom.body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    hud.dispose();
  });
});

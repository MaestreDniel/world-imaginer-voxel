/**
 * The map canvas created hidden (SP4c spec §1.3, final review MAP-2; SP6a Task 52, runtime-1): the world's premount
 * mounts the tool before its first open, and the driver's replaying sink hands the canvas its source at the mount
 * (`relay.attach`). Created hidden, the canvas sends no tile job until it is shown; created shown, the source plans its
 * tiles at once, as before. On the DOM shim with a pool spy (the real pool runs in the browser smoke).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorkerPool } from '../../src/engine/workerPool';
import { createMapCanvas } from '../../src/ui/map/mapView';
import { installDom } from './fixtures/domShim';

let dom: ReturnType<typeof installDom>;
beforeEach(() => {
  dom = installDom();
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A canvas over a pool spy at epoch 3, in a host laid out as the premount's (`clientWidth` 0: a 1 × 1 canvas). */
function mount(hidden?: boolean) {
  const make = dom.document.createElement.bind(dom.document);
  vi.spyOn(dom.document, 'createElement').mockImplementation((tag: string) => {
    const e = make(tag);
    // The canvas draws nothing here: no frame callback runs.
    if (tag === 'canvas') Object.assign(e, { width: 300, height: 150, getContext: () => ({}) });
    return e;
  });
  const host = Object.assign(dom.document.createElement('div'), { clientWidth: 0, clientHeight: 0 });
  dom.body.append(host);
  const pool = { epoch: 3, tile: vi.fn(() => new Promise<never>(() => {})), cancelTiles: vi.fn() };
  const canvas = createMapCanvas(host as unknown as HTMLElement, pool as unknown as WorkerPool, { x: 0, z: 0, bpp: 4, layer: 'biome' }, {
    onView() {}, onHover() {}, onClick() {}, onPreviewProgress() {}, hidden,
  });
  return { canvas, pool };
}

describe('the map canvas created hidden (SP6a Task 52: the premount requests nothing)', () => {
  test('created hidden, the source the replaying sink hands it plans no tile; shown, it requests its tiles', () => {
    const { canvas, pool } = mount(true);
    canvas.setSource(3, 'seed', { biome: 'h' });
    canvas.setInteractive(true);
    canvas.setView({ x: 64, z: 64, bpp: 4, layer: 'biome' });
    expect(pool.tile).not.toHaveBeenCalled();
    canvas.setHidden(false);
    expect(pool.tile).toHaveBeenCalled();
  });

  test('created shown (the default, `?map` and an open\'s mount), the source requests its tiles at once', () => {
    const { canvas, pool } = mount();
    canvas.setSource(3, 'seed', { biome: 'h' });
    expect(pool.tile).toHaveBeenCalled();
  });
});

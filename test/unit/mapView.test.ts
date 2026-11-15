/**
 * The map canvas created hidden (SP4c spec §1.3, final review MAP-2; SP6a Task 52, runtime-1): the world's premount
 * mounts the tool before its first open, and the driver's replaying sink hands the canvas its source at the mount
 * (`relay.attach`). Created hidden, the canvas sends no tile job until it is shown; created shown, the source plans its
 * tiles at once, as before. On the DOM shim with a pool spy (the real pool runs in the browser smoke).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TileRequest, TileResult, WorkerPool } from '../../src/engine/workerPool';
import { HIGHLIGHT_DIM_ALPHA } from '../../src/ui/map/highlight';
import type { MapView } from '../../src/ui/map/mapState';
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

describe('the caveBiome layer on the canvas (SP6b spec §9.1; rulings P50, P51)', () => {
  const flush = () => new Promise<void>((r) => setImmediate(r));
  /** The caveBiome view at the preview level, centred on its one visible tile (0, 0) at level 256 (the canvas is 1 × 1). */
  const cave = (caveY?: number): MapView => ({ x: 32768, z: 32768, bpp: 256, layer: 'caveBiome', ...(caveY === undefined ? {} : { caveY }) });

  /** A shown canvas whose frames run by hand, over a pool whose tiles resolve with `ids`, drawing into a recording 2D context. */
  function mountDrawn(ids: Uint8Array | null) {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal('ImageData', class { readonly data: Uint8ClampedArray; constructor(data: Uint8ClampedArray) { this.data = data; } });
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ close() {} }));
    /** The data of every highlight mask the canvas built. */
    const masks: Uint8ClampedArray[] = [];
    class Offscreen { getContext() { return { putImageData: (img: { data: Uint8ClampedArray }) => { masks.push(img.data); } }; } }
    vi.stubGlobal('OffscreenCanvas', Offscreen);
    const drawn: unknown[] = [];
    const ctx = { fillStyle: '', fillRect() {}, drawImage: (img: unknown) => { drawn.push(img); } };
    const make = dom.document.createElement.bind(dom.document);
    vi.spyOn(dom.document, 'createElement').mockImplementation((tag: string) => {
      const e = make(tag);
      if (tag === 'canvas') Object.assign(e, { width: 300, height: 150, getContext: () => ctx });
      return e;
    });
    const host = Object.assign(dom.document.createElement('div'), { clientWidth: 0, clientHeight: 0 });
    dom.body.append(host);
    const tile = vi.fn((_r: TileRequest, _p: number): Promise<TileResult> => Promise.resolve({ rgba: new ArrayBuffer(262144), ids: ids === null ? null : ids.slice().buffer }));
    const pool = { epoch: 3, tile, cancelTiles: vi.fn((_pred: (r: TileRequest) => boolean) => {}) };
    const canvas = createMapCanvas(host as unknown as HTMLElement, pool as unknown as WorkerPool, cave(0), { onView() {}, onHover() {}, onClick() {}, onPreviewProgress() {} });
    const run = () => { while (frames.length > 0) frames.shift()!(0); };
    /** The masks drawn since the last call. */
    const maskDraws = () => { const n = drawn.filter((d) => d instanceof Offscreen).length; drawn.length = 0; return n; };
    return { canvas, pool, masks, run, maskDraws };
  }

  test('a caveBiome request carries the view\'s y and another layer\'s none; two caveY values give two keys, and the cancel filter keys each request by its own y', () => {
    const { canvas, pool } = mountDrawn(null);
    canvas.setSource(3, 'seed', { biome: 'b', terrain: 't' });
    const sent = () => pool.tile.mock.calls.map((c) => c[0]);
    expect(sent()).toEqual([{ layer: 'caveBiome', level: 256, tx: 0, tz: 0, y: 0 }]);
    canvas.setView(cave(40));
    expect(sent().map((r) => r.y)).toEqual([0, 40]);
    // The view without caveY is the default y 0: its key is the first request's, still pending or cached, so nothing new.
    canvas.setView(cave());
    canvas.setView(cave(0));
    expect(sent()).toHaveLength(2);
    canvas.setView(cave(40));
    const cancels = pool.cancelTiles.mock.calls.at(-1)![0];
    expect([cancels(sent()[0]!), cancels(sent()[1]!)]).toEqual([true, false]);
    canvas.setView({ x: 32768, z: 32768, bpp: 256, layer: 'biome', caveY: 40 });
    expect(sent().at(-1)).toEqual({ layer: 'biome', level: 256, tx: 0, tz: 0 });
    expect('y' in sent().at(-1)!).toBe(false);
  });

  test('a cave-biome highlight dims every id but the chosen one on the caveBiome layer\'s tiles; the biome table\'s surface-biome highlight never masks them', async () => {
    const ids = new Uint8Array(65536).map((_v, i) => [0, 1, 2, 3, 255][i % 5]!);
    const { canvas, masks, run, maskDraws } = mountDrawn(ids);
    canvas.setSource(3, 'seed', { terrain: 't' });
    await flush();
    run();
    expect(maskDraws()).toBe(0);
    // The surface-biome highlight (the biome table's row under the pointer): no mask on a caveBiome tile.
    canvas.highlightBiome(1);
    run();
    expect([maskDraws(), masks.length]).toEqual([0, 0]);
    canvas.highlightCaveBiome(2);
    run();
    expect([maskDraws(), masks.length]).toEqual([1, 1]);
    const alpha = Array.from({ length: 5 }, (_v, i) => masks[0]![4 * i + 3]);
    expect(alpha).toEqual([HIGHLIGHT_DIM_ALPHA, HIGHLIGHT_DIM_ALPHA, 0, HIGHLIGHT_DIM_ALPHA, HIGHLIGHT_DIM_ALPHA]);
    for (let i = 0; i < ids.length; i++) if ((masks[0]![4 * i + 3] === 0) !== (ids[i] === 2)) throw new Error(`pixel ${i}`);
    canvas.highlightCaveBiome(null);
    run();
    expect(maskDraws()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StreamEvent } from '../../src/engine/coordinator';
import { StoreCorrupt } from '../../src/world/store/pool';
import { createReloader } from '../../src/ui/world/reload';
import { createWorldNotices, everyFrameUntil, handleStreamEvent, releaseOnFailure, runTeardown } from '../../src/ui/world/worldPage';
import { installDom, type FakeElement } from './fixtures/domShim';

/** A frame scheduler that queues callbacks; `flush` runs one frame. */
function frames() {
  const queue: Array<() => void> = [];
  return {
    request: (cb: () => void): void => { queue.push(cb); },
    pending: () => queue.length,
    flush: (): void => { queue.shift()?.(); },
  };
}

describe('everyFrameUntil (the load build loop, SP4a spec §8.3)', () => {
  test('calls the step once per frame and resolves when it returns true', async () => {
    const f = frames();
    let calls = 0;
    const done = everyFrameUntil(f.request, () => ++calls === 3);
    expect(calls).toBe(0);
    f.flush();
    f.flush();
    expect(calls).toBe(2);
    f.flush();
    await expect(done).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(f.pending()).toBe(0);
  });

  test('a throwing step rejects with its error and requests no further frame', async () => {
    const f = frames();
    const boom = new Error('addGeometry: the batch is full');
    let calls = 0;
    const done = everyFrameUntil(f.request, () => {
      calls++;
      if (calls === 2) throw boom;
      return false;
    });
    f.flush();
    f.flush();
    await expect(done).rejects.toBe(boom);
    expect(f.pending()).toBe(0);
  });
});

describe('releaseOnFailure (the failure panel frees the load, final review B-M4)', () => {
  test('disconnects the long-task observer, terminates the pool and disposes the renderer, each once', () => {
    const longTasks = { disconnect: vi.fn() };
    const pool = { terminate: vi.fn() };
    const renderer = { dispose: vi.fn() };
    releaseOnFailure({ longTasks, pool, renderer });
    expect(longTasks.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.terminate).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  test('a failure before the pool or the renderer exists releases what there is', () => {
    expect(() => releaseOnFailure({ longTasks: null, pool: null, renderer: null })).not.toThrow();
  });
});

describe('runTeardown (the page\'s dispose, rulings R5 (b))', () => {
  test('a StoreCorrupt from the coordinator\'s dispose skips none of the later steps; each error is reported', () => {
    const order: string[] = [];
    const corrupt = new StoreCorrupt('the pool lock is held by dead thread 2');
    const onError = vi.fn<(e: unknown) => void>();
    runTeardown([
      () => { order.push('input'); },
      () => { order.push('coordinator'); throw corrupt; },
      () => { order.push('loading.dispose'); },
      () => { order.push('renderer.dispose'); throw new Error('lost context'); },
      () => { order.push('pool.terminate'); },
      () => { order.push('root.replaceChildren'); },
    ], onError);
    expect(order).toEqual(['input', 'coordinator', 'loading.dispose', 'renderer.dispose', 'pool.terminate', 'root.replaceChildren']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![0]).toBe(corrupt);
  });
});

describe('handleStreamEvent (SP4b spec §3.6, §7.4, D12)', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup() {
    const notices = createWorldNotices(dom.body as unknown as HTMLElement, createReloader(vi.fn(), vi.fn()));
    const fail = vi.fn<(cause: string, e: unknown) => void>();
    const lower = vi.fn<(rd: number) => void>();
    return { notices, fail, lower, o: { notices, fail, lower } };
  }
  const byId = (id: string): FakeElement[] => dom.body.querySelectorAll('div').filter((d: FakeElement) => d.id === id);

  test('a fatal stream event calls fail with its message and cause', () => {
    const { fail, o } = setup();
    const cause = new StoreCorrupt('the pool lock is held by dead thread 2');
    handleStreamEvent({ kind: 'fatal', message: 'MESH at (3, 4) failed: StoreCorrupt', cause }, o);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]![0]).toContain('MESH at (3, 4) failed: StoreCorrupt');
    expect(fail.mock.calls[0]![1]).toBe(cause);
    expect(dom.body.textContent).toBe('');
  });

  test('a skipped event shows one dismissible notice with Copy details (a second skipped shows nothing new)', () => {
    const { fail, lower, o } = setup();
    const skipped: StreamEvent = { kind: 'skipped', cx: -7, cz: 12 };
    handleStreamEvent(skipped, o);
    const panel = dom.el('world-skipped-notice');
    expect(panel.textContent).toContain('Some terrain could not be generated');
    expect(dom.el('world-skipped-copy').textContent).toBe('Copy details');
    handleStreamEvent({ kind: 'skipped', cx: 1, cz: 1 }, o);
    expect(byId('world-skipped-notice')).toHaveLength(1);
    dom.el('world-skipped-dismiss').click();
    expect(byId('world-skipped-notice')).toHaveLength(0);
    // Shown once: a later skipped column after the dismissal shows nothing either.
    handleStreamEvent({ kind: 'skipped', cx: 2, cz: 2 }, o);
    expect(byId('world-skipped-notice')).toHaveLength(0);
    expect(fail).not.toHaveBeenCalled();
    expect(lower).not.toHaveBeenCalled();
  });

  test('the skipped notice\'s Copy details copies the column it names', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { o } = setup();
    handleStreamEvent({ kind: 'skipped', cx: -7, cz: 12 }, o);
    dom.el('world-skipped-copy').click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('(-7, 12)');
    await Promise.resolve();
    expect(dom.el('world-skipped-copy').textContent).toBe('Copied');
  });

  test('a storeFull event with lowerRd 10 shows the notice whose button calls lower(10); with lowerRd null, no button', () => {
    const { fail, lower, o } = setup();
    handleStreamEvent({ kind: 'storeFull', lowerRd: 10 }, o);
    const panel = dom.el('world-store-full');
    expect(panel.textContent).toContain('The world store is full');
    const button = dom.el('world-store-full-lower');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Lower to RD 10');
    button.click();
    expect(lower).toHaveBeenCalledTimes(1);
    expect(lower).toHaveBeenCalledWith(10);
    expect(fail).not.toHaveBeenCalled();
    // A second pause replaces the notice rather than stacking one more.
    handleStreamEvent({ kind: 'storeFull', lowerRd: null }, o);
    expect(byId('world-store-full')).toHaveLength(1);
    expect(() => dom.el('world-store-full-lower')).toThrow();
    expect(dom.el('world-store-full-dismiss').textContent).toBe('Dismiss');
    dom.el('world-store-full-dismiss').click();
    expect(byId('world-store-full')).toHaveLength(0);
  });
});

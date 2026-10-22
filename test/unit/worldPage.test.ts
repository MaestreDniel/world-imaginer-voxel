import { describe, expect, test, vi } from 'vitest';
import { everyFrameUntil, releaseOnFailure } from '../../src/ui/world/worldPage';

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

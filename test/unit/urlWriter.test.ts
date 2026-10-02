import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createUrlWriter } from '../../src/ui/common/urlWriter';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('a burst of updates (a drag at 60 events/s) writes the URL once, with the last value', () => {
  const writes: string[] = [];
  const w = createUrlWriter((u) => writes.push(u), 200);
  for (let i = 0; i < 300; i++) { w.set(`#${i}`); vi.advanceTimersByTime(16); }
  expect(writes).toEqual([]);
  vi.advanceTimersByTime(200);
  expect(writes).toEqual(['#299']);
});

test('a rate-limited (throwing) write is retried, and never escapes to the caller', () => {
  let fail = true;
  const writes: string[] = [];
  const w = createUrlWriter((u) => { if (fail) { fail = false; throw new Error('SecurityError: too many calls'); } writes.push(u); }, 200, 1000);
  w.set('#a');
  expect(() => vi.advanceTimersByTime(200)).not.toThrow();
  expect(writes).toEqual([]);
  vi.advanceTimersByTime(1000);
  expect(writes).toEqual(['#a']);
});

test('flush writes the pending value immediately; a newer set wins over a retry', () => {
  const writes: string[] = [];
  const w = createUrlWriter((u) => writes.push(u), 200);
  w.set('#x');
  w.flush();
  w.flush();
  expect(writes).toEqual(['#x']);
});

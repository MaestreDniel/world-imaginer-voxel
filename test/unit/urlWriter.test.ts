import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createUrlWriter, oversizeNotice, URL_HASH_MAX, URL_OVERSIZE_NOTICE, urlHashLength } from '../../src/ui/common/urlWriter';

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

describe('the 64 KiB hash cap (SP3d spec §1.12)', () => {
  const url = (hashChars: number) => `?map#${'A'.repeat(hashChars)}`;

  test('URL_HASH_MAX is 64 KiB of hash text; urlHashLength counts after the first #', () => {
    expect(URL_HASH_MAX).toBe(65536);
    expect([urlHashLength('?map'), urlHashLength('?map#'), urlHashLength('?map#abc'), urlHashLength('?lab=noise#a#b')]).toEqual([0, 0, 3, 3]);
    expect(URL_OVERSIZE_NOTICE).toBe('The edited trees are too large for the URL; export a preset to share them');
  });

  test('a hash above the cap is not written; the address bar keeps the last URL that fit', () => {
    const writes: string[] = [];
    const states: boolean[] = [];
    const w = createUrlWriter((u) => writes.push(u), 200, 1000, (o) => states.push(o));
    w.set(url(URL_HASH_MAX));
    vi.advanceTimersByTime(200);
    w.set(url(URL_HASH_MAX + 1));
    vi.advanceTimersByTime(200);
    w.flush();
    vi.advanceTimersByTime(5000);
    expect(writes.map((u) => u.length)).toEqual([URL_HASH_MAX + 5]);
    expect(states).toEqual([true]);
  });

  test('the callback reports transitions only: true while oversize, false once a URL fits again', () => {
    const writes: string[] = [];
    const states: boolean[] = [];
    const w = createUrlWriter((u) => writes.push(u), 200, 1000, (o) => states.push(o));
    for (const n of [10, 70000, 80000, 90000, 20, 30, 100000, 40]) {
      w.set(url(n));
      vi.advanceTimersByTime(200);
    }
    expect(states).toEqual([true, false, true, false]);
    expect(writes.map(urlHashLength)).toEqual([10, 20, 30, 40]);
  });

  test('an oversize value superseded within the debounce is never measured', () => {
    const states: boolean[] = [];
    const w = createUrlWriter(() => {}, 200, 1000, (o) => states.push(o));
    w.set(url(70000));
    vi.advanceTimersByTime(100);
    w.set(url(5));
    vi.advanceTimersByTime(200);
    expect(states).toEqual([]);
  });

  test('without a callback an oversize URL is still dropped (the lab writer)', () => {
    const writes: string[] = [];
    const w = createUrlWriter((u) => writes.push(u));
    w.set(url(70000));
    w.flush();
    expect(writes).toEqual([]);
  });

  test('the page\'s notice: shown as a warning without a timeout while oversize, hidden once a URL fits (SP3d Task 15)', () => {
    const log: string[] = [];
    const notices = {
      show: (text: string, opts?: { kind?: string; timeoutMs?: number }) => log.push(`show ${opts?.kind} ${opts?.timeoutMs} ${text}`),
      hide: (text: string) => log.push(`hide ${text}`),
    };
    const w = createUrlWriter(() => {}, 200, 1000, oversizeNotice(notices));
    for (const n of [10, 70000, 80000, 20]) {
      w.set(url(n));
      vi.advanceTimersByTime(200);
    }
    expect(log).toEqual([`show warn undefined ${URL_OVERSIZE_NOTICE}`, `hide ${URL_OVERSIZE_NOTICE}`]);
  });
});

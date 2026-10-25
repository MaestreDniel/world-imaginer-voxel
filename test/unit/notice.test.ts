import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createNotices } from '../../src/ui/common/notice';
import { installDom, type FakeElement } from './fixtures/domShim';

describe('createNotices (SP2b spec §1.5; SP4c spec §1.2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('dispose clears every row\'s timer', async () => {
    const { document } = installDom();
    const host = document.createElement('div');
    const notices = createNotices(host as unknown as HTMLElement);
    expect(host.classList.contains('notices')).toBe(true);
    notices.show('one', { timeoutMs: 1000 });
    notices.show('two', { kind: 'warn', timeoutMs: 4000 });
    notices.show('stays');
    const confirmed = notices.confirm('switch?', 'Switch');
    expect(host.children.map((r: FakeElement) => r.className)).toEqual(['notice notice-info', 'notice notice-warn', 'notice notice-info', 'notice notice-warn']);
    expect(vi.getTimerCount()).toBe(2);
    notices.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.children).toEqual([]);
    await expect(confirmed).resolves.toBe(false);
    // Nothing shows, and no timer starts, once disposed.
    notices.show('late', { timeoutMs: 1000 });
    expect(host.children).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

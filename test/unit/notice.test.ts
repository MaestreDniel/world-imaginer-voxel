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

  test('onDismiss runs when the user removes the notice (its × or an action), never on a timeout, hide, replacement or clear (final review WLD-2)', () => {
    const { document } = installDom();
    const host = document.createElement('div');
    const notices = createNotices(host as unknown as HTMLElement);
    const buttons = (): FakeElement[] => host.children[0]!.querySelectorAll('button');
    const onDismiss = vi.fn();
    const run = vi.fn();
    notices.show('full', { actions: [{ label: 'Lower', run }], onDismiss });
    buttons().find((b) => b.textContent === '×')!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    notices.show('full', { actions: [{ label: 'Lower', run }], onDismiss });
    buttons().find((b) => b.textContent === 'Lower')!.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(host.children).toEqual([]);
    // Taken down by the page, replaced, timed out or cleared: not a dismissal.
    notices.show('full', { onDismiss });
    notices.hide('full');
    notices.show('full', { onDismiss });
    notices.show('full', { onDismiss });
    notices.clear();
    notices.show('timed', { timeoutMs: 1000, onDismiss });
    vi.advanceTimersByTime(1000);
    expect(host.children).toEqual([]);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

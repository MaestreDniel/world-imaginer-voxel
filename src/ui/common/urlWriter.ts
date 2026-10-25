/**
 * Debounced, fail-safe URL writer. Browsers rate-limit history.replaceState (Firefox and Safari throw a
 * SecurityError, Chrome drops calls), so a drag or wheel burst writes once after `delayMs` of quiet; a write
 * that throws is retried after `retryMs` unless a newer value arrives first.
 *
 * Size cap (SP3d spec §1.12): a URL whose hash is longer than URL_HASH_MAX characters is not written (the
 * address bar keeps the last state that fit), and `onOversize` reports the transitions of that state:
 * true when a URL is first dropped for its size, false when one fits again. The page shows
 * URL_OVERSIZE_NOTICE while it is true (`oversizeNotice`).
 */
import type { Notices } from './notice';

/** 64 KiB of hash text (base64url is ASCII, so characters are bytes). */
export const URL_HASH_MAX = 65536;

export const URL_OVERSIZE_NOTICE = 'The edited trees are too large for the URL; export a preset to share them';

/** The length of the text after the first `#` (0 without one). */
export function urlHashLength(url: string): number {
  const i = url.indexOf('#');
  return i < 0 ? 0 : url.length - i - 1;
}

/**
 * The page's `onOversize` (SP3d spec §1.12): shows URL_OVERSIZE_NOTICE as a warning without a timeout when a URL is
 * first dropped for its size and hides it when one fits again (the viewer may dismiss it earlier).
 */
export function oversizeNotice(notices: Pick<Notices, 'show' | 'hide'>): (oversize: boolean) => void {
  return (oversize) => {
    if (oversize) notices.show(URL_OVERSIZE_NOTICE, { kind: 'warn' });
    else notices.hide(URL_OVERSIZE_NOTICE);
  };
}

export function createUrlWriter(
  write: (url: string) => void,
  delayMs = 200,
  retryMs = 1000,
  onOversize: (oversize: boolean) => void = () => {},
): { set(url: string): void; flush(): void; dispose(): void } {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let oversize = false;
  let disposed = false;
  const schedule = (ms: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  };
  function flush(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending === null) return;
    const url = pending;
    pending = null;
    const tooLong = urlHashLength(url) > URL_HASH_MAX;
    if (tooLong !== oversize) {
      oversize = tooLong;
      onOversize(tooLong);
    }
    if (tooLong) return;
    try {
      write(url);
    } catch {
      if (pending === null) { pending = url; schedule(retryMs); }
    }
  }
  return {
    set(url) {
      if (disposed) return;
      pending = url;
      schedule(delayMs);
    },
    flush,
    /** Writes a pending URL now, then drops any retry and ignores later calls (SP4c spec §1.2). */
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      pending = null;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
  };
}

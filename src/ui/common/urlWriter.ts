/**
 * Debounced, fail-safe URL writer. Browsers rate-limit history.replaceState (Firefox and Safari throw a
 * SecurityError, Chrome drops calls), so a drag or wheel burst writes once after `delayMs` of quiet; a write
 * that throws is retried after `retryMs` unless a newer value arrives first.
 */
export function createUrlWriter(write: (url: string) => void, delayMs = 200, retryMs = 1000): { set(url: string): void; flush(): void } {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  };
  function flush(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending === null) return;
    const url = pending;
    pending = null;
    try {
      write(url);
    } catch {
      if (pending === null) { pending = url; schedule(retryMs); }
    }
  }
  return {
    set(url) { pending = url; schedule(delayMs); },
    flush,
  };
}

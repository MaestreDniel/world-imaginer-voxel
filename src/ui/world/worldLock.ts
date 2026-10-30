/**
 * One tab per world (SP5b spec §3.5, D7, D24), over the Web Locks API (`navigator.locks` satisfies `LockManagerLike`;
 * injected, so unit tests drive it). The world page waits up to `LOCK_WAIT_MS` for the world's lock (`holdWorld`): a
 * reload's own previous document can hold it for a moment after it unloads, which an `ifAvailable` request would read
 * as another tab; the wait's abort means another tab holds the world. The page holds the lock until it releases it
 * (`pagehide`, after the last save is posted, or its teardown); the browser releases it when the tab closes or crashes.
 * The worlds menu's Rename and Delete take it only if it is free (`withWorldIfFree`) and write inside its callback, so
 * a page asking meanwhile is granted it only after the write settles.
 */

/** The part of `LockManager` the world's lock uses. */
export interface LockManagerLike {
  request<T>(name: string, o: { signal?: AbortSignal; ifAvailable?: boolean }, cb: (lock: unknown | null) => Promise<T> | T): Promise<T>;
}

/** How long the world page waits for the world's lock (D24). */
export const LOCK_WAIT_MS = 2000;

/** D7's notice: the world is held by another tab (the page's open, the menu's Rename and Delete). */
export const LOCKED_NOTICE = 'This world is open in another tab';

/** The world's lock name (D24). */
export const lockName = (id: string): string => `wi10.world.${id}`;

/** The page's hold on a world's lock; `release` is idempotent. */
export interface WorldHold {
  release(): void;
}

/** The wait's end: `AbortSignal.timeout`'s `TimeoutError`, or an `AbortError` from a browser that reports it so. */
const isAbort = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && ((e as { name?: unknown }).name === 'TimeoutError' || (e as { name?: unknown }).name === 'AbortError');

/**
 * The world page's request (§3.4 step 1): resolves to a holder once the lock is granted, the callback's promise kept
 * pending until `release`; null when `timeoutMs` passes first (another tab holds the world). Any other failure of the
 * request rejects.
 */
export function holdWorld(locks: LockManagerLike, id: string, timeoutMs: number = LOCK_WAIT_MS): Promise<WorldHold | null> {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  return new Promise<WorldHold | null>((resolve, reject) => {
    locks.request(lockName(id), { signal: AbortSignal.timeout(timeoutMs) }, () => {
      resolve({ release: () => release() });
      return released;
    }).catch((e: unknown) => {
      if (isAbort(e)) resolve(null);
      else reject(e);
    });
  });
}

/**
 * The menu's Rename and Delete (D24): `write` runs inside the lock's callback when the lock is free, and the lock is
 * released after its promise settles (a rejection rejects); `{held: true}` with nothing called when another tab holds it.
 */
export function withWorldIfFree<T>(
  locks: LockManagerLike,
  id: string,
  write: () => Promise<T>,
): Promise<{ held: true } | { held: false; value: T }> {
  return locks.request(lockName(id), { ifAvailable: true }, async (lock): Promise<{ held: true } | { held: false; value: T }> => {
    if (lock === null) return { held: true };
    return { held: false, value: await write() };
  });
}

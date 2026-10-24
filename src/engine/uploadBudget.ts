/**
 * The per-frame upload budget (SP4b spec §3.9, D13; SP4a spec §6.2): the page calls `start()` at the top of a frame
 * and the section renderer uploads rows while `exhausted()` is false, which it becomes once `ms` have passed or `rows`
 * section rows were spent. `structural()` grants one structural operation per frame (a region's batch or arena
 * created, grown, optimised or compacted), and only while no row was spent in this frame yet. While flying the page
 * uses 2 ms and 32 rows (`MEDIUM.uploadBudgetMs`, `uploadSections`); while the loading screen is up 12 ms and
 * `rows = Infinity`, which also lifts the structural cap: every `structural()` call is granted while the 12 ms last
 * (plan), so the first fill's region creations do not each take a frame. Before the first `start()` the budget reads
 * exhausted and grants nothing, so nothing uploads outside a frame's window.
 *
 * It satisfies render's `UploadGate` structurally (render may not import engine).
 */
export interface UploadBudget {
  /** Opens this frame's window at `now()`: the time, the rows spent and the structural grant restart. */
  start(): void;
  /** True once `ms` have passed since the last `start()` (and before any), or `rows` rows were spent in this frame. */
  exhausted(): boolean;
  /** Counts `rows` section rows uploaded or released in this frame. */
  spend(rows: number): void;
  /**
   * Asks for this frame's structural operation: true at most once per frame, only while no row was spent and the time
   * lasts; with `rows = Infinity`, true on every call while the time lasts.
   */
  structural(): boolean;
  /** The rows spent since the last `start()`. */
  rowsSpent(): number;
}

export function createUploadBudget(ms: number, rows: number, now: () => number): UploadBudget {
  const uncapped = rows === Number.POSITIVE_INFINITY;
  let t0 = Number.NEGATIVE_INFINITY;
  let spent = 0;
  let granted = false;
  const timeUp = (): boolean => now() - t0 >= ms;
  return {
    start() {
      t0 = now();
      spent = 0;
      granted = false;
    },
    exhausted() { return spent >= rows || timeUp(); },
    spend(n) { spent += n; },
    structural() {
      if (timeUp()) return false;
      if (uncapped) return true;
      if (granted || spent > 0) return false;
      granted = true;
      return true;
    },
    rowsSpent() { return spent; },
  };
}

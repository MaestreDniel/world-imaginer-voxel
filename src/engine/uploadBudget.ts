/**
 * The per-frame upload budget (SP4a spec §6.2): the page calls `start()` at the top of a frame and stages section
 * uploads while `exhausted()` is false. During loading the page uses 12 ms; `MEDIUM.uploadBudgetMs` (2 ms) is SP4b's
 * flight budget. Before the first `start()` the budget reads exhausted, so nothing uploads outside a frame's window.
 */
export interface UploadBudget {
  /** Opens this frame's window at `now()`. */
  start(): void;
  /** True once `budgetMs` have passed since the last `start()` (and before any). */
  exhausted(): boolean;
}

export function createUploadBudget(budgetMs: number, now: () => number): UploadBudget {
  let t0 = Number.NEGATIVE_INFINITY;
  return {
    start() { t0 = now(); },
    exhausted() { return now() - t0 >= budgetMs; },
  };
}

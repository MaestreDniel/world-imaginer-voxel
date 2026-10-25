/**
 * A registry of disposers (SP4c spec §1.2): a component adds the undo of each handle it takes (a listener, an observer,
 * a child's `dispose`) as it takes it, and `dispose()` runs them once, in reverse order of `add`. Each runs guarded: a
 * throw is reported (`console.error`) and the rest still run. An `add` after `dispose` runs its disposer at once, so a
 * handle taken late (a promise that resolved after the teardown) is not leaked.
 */
export interface Disposers {
  add(fn: () => void): void;
  dispose(): void;
}

const run = (fn: () => void): void => {
  try {
    fn();
  } catch (e) {
    console.error('a disposer threw', e);
  }
};

export function createDisposers(): Disposers {
  let fns: (() => void)[] | null = [];
  return {
    add(fn) {
      if (fns === null) run(fn);
      else fns.push(fn);
    },
    dispose() {
      const all = fns;
      if (all === null) return;
      fns = null;
      for (let i = all.length - 1; i >= 0; i--) run(all[i]!);
    },
  };
}

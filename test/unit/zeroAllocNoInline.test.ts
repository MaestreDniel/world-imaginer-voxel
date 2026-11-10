/**
 * `apply` allocates nothing whatever TurboFan inlines (SP4c spec §4.10, "`apply`, `adopt` and `update` allocate
 * nothing"; SP6a Task 52d). A double a function returns, or one passed to a call that is not inlined, is boxed as a
 * 16 B HeapNumber at that call. Under load, TurboFan has compiled `apply` with none of its callees inlined: in CI run
 * 42743417447 and locally, the Apply case of `zeroAlloc.test.ts` then read 19.27 MB over 1,000 calls on every attempt
 * (its rebuild's ~440 pushes each returned a score and a colKey), so a chunk of 100 calls filled the suite's 1 MB young
 * generation once per try ("Scavenge × 30"). The keys are now written in place (`streamScoreInto`, `colKeyInto`).
 *
 * This file runs in its own process (vitest isolates each file), with `--no-turbo-inlining` set before any of the
 * coordinator's code is hot: every call is a call, the worst case of TurboFan's inlining budget. `--no-maglev` is set
 * with it (SP6a Task 53): Maglev inlines small callees whatever TurboFan's flag says, so a closure still in Maglev read
 * 41,120 B locally (40,824 B in CI run 42758530442) in the first test's first attempt and the test flaked on tiering timing. Without Maglev a function runs in
 * Ignition or Sparkplug (every double a HeapNumber) until TurboFan, which inlines nothing here, so the first test boxes
 * on every tier (about 678 KB per attempt); and the Apply case's reading under 256 KB can only be TurboFan's, since the
 * interpreter boxes each of its ~440 scores per call (it read 165,960 B locally, against 27,560 B with Maglev on).
 * The first test shows the flags are in force (a returned double is boxed); the bound and the measurement are
 * `zeroAlloc.test.ts`' own. Both flags are restored after the file (Node's defaults are on).
 */
import v8 from 'node:v8';
import { afterAll, describe, expect, test } from 'vitest';
import { N, ZERO_ALLOC_MAX, allocationOver, applyLoop, expectAtRest, filledCoordinator } from './fixtures/heapGrowth';

v8.setFlagsFromString('--no-turbo-inlining');
v8.setFlagsFromString('--no-maglev');
afterAll(() => {
  v8.setFlagsFromString('--turbo-inlining');
  v8.setFlagsFromString('--maglev');
});

/** `apply` + `update` pairs measured and warmed up, as in `zeroAlloc.test.ts`. */
const APPLY_N = 1_000;
const TIMEOUT_MS = 120_000;

describe('zero allocation with no TurboFan inlining (SP4c spec §4.10, SP6a Task 52d)', () => {
  test('the flags are in force: four returned doubles per call box 64 B per call, on every tier', () => {
    const quarter = (x: number): number => x * 0.5 + 0.25;
    const sink = new Float64Array(1);
    let i = 0;
    const g = allocationOver(() => {
      sink[0] = quarter(i) + quarter(i + 1) + quarter(i + 2) + quarter(i + 3);
      i++;
    }, 10 * N, ZERO_ALLOC_MAX);
    expect(sink[0]).toBeGreaterThan(0);
    expect(g.readings.every((b) => b > ZERO_ALLOC_MAX), `${g.readings.join(', ')}`).toBe(true);
  }, TIMEOUT_MS);

  test(`${APPLY_N} × (coordinator.apply alternating epochs 2 and 3 under a held generation, then one update) grow the heap by less than 256 KB`, async () => {
    const cam = { x: 8.5, z: 8.5, yawDeg: 37.5 };
    const c = await filledCoordinator(cam);
    expectAtRest(allocationOver(applyLoop(c, cam), APPLY_N, ZERO_ALLOC_MAX, APPLY_N));
  }, TIMEOUT_MS);
});

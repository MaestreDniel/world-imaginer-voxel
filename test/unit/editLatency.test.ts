import { describe, expect, test } from 'vitest';
import { colKey } from '../../src/core/coords';
import { createEditLatency } from '../../src/ui/world/editLatency';

describe('createEditLatency (G2\'s edit latency, SP5a spec §4.6, §6.2)', () => {
  test('posted at 100 with the reply at 104, staged at 115, a reveal of the edited column at 130 and of the last dirty at 145: visible 30, all-visible 45, reply 4, issueToStaged 11, stagedToShown 15, and the sim\'s relight and edit figures kept', () => {
    const lat = createEditLatency();
    const dirty = [colKey(0, 0), colKey(1, 0), colKey(0, 1)];
    lat.posted(100, 104, colKey(0, 0), dirty, 1.25, 2.5);
    lat.staged(0, 0, 115);
    lat.staged(1, 0, 118);
    lat.revealed(0, 0, 130);
    expect(lat.count).toBe(1);
    expect(lat.visibleP95()).toBe(30);
    // The all-visible sample waits for every dirty column.
    expect(lat.allVisibleP95()).toBeNaN();
    lat.revealed(1, 0, 135);
    // Each dirty column's reveal counts only after its own staged (ruling R14).
    lat.staged(0, 1, 120);
    lat.revealed(0, 1, 145);
    expect(lat.allVisibleP95()).toBe(45);
    const s = lat.samples();
    expect(Array.from(s.visible)).toEqual([30]);
    expect(Array.from(s.allVisible)).toEqual([45]);
    expect(Array.from(s.reply)).toEqual([4]);
    expect(Array.from(s.issueToStaged)).toEqual([11]);
    expect(Array.from(s.stagedToShown)).toEqual([15]);
    expect(Array.from(s.relight)).toEqual([1.25]);
    expect(Array.from(s.edit)).toEqual([2.5]);
  });

  test('a reveal before staged does not count', () => {
    const lat = createEditLatency();
    lat.posted(100, 104, colKey(2, -3), [colKey(2, -3), colKey(3, -3)], 1, 1);
    // An older payload staged before the edit reveals now: no sample.
    lat.revealed(2, -3, 110);
    lat.revealed(3, -3, 111);
    expect(lat.count).toBe(0);
    expect(lat.visibleP95()).toBeNaN();
    lat.staged(2, -3, 120);
    lat.staged(3, -3, 121);
    lat.revealed(3, -3, 125);
    expect(lat.count).toBe(0);
    lat.revealed(2, -3, 140);
    expect(lat.count).toBe(1);
    expect(lat.visibleP95()).toBe(40);
    expect(lat.allVisibleP95()).toBe(40);
    // A later reveal of the same column adds nothing.
    lat.revealed(2, -3, 160);
    expect(lat.count).toBe(1);
    expect(Array.from(lat.samples().visible)).toEqual([40]);
  });

  test('the rings keep the last `capacity` samples in order; the p95 is the nearest rank over them', () => {
    const lat = createEditLatency(4);
    for (let i = 0; i < 6; i++) {
      const t = 1000 * i;
      lat.posted(t, t + 1, colKey(i, 0), [colKey(i, 0)], 0, 0);
      lat.staged(i, 0, t + 2);
      lat.revealed(i, 0, t + 10 + i);
    }
    expect(lat.count).toBe(6);
    expect(Array.from(lat.samples().visible)).toEqual([12, 13, 14, 15]);
    expect(lat.visibleP95()).toBe(15);
  });
});

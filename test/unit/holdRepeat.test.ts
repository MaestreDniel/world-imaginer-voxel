/**
 * Hold to repeat (SP5a spec §4.1, D6; Review Focus 1): `down` queues once for every button; with the setting on, a held
 * LMB or RMB queues again on the frame's `tick` once 0.3 s (break) or 0.2 s (place) have passed since the previous one
 * and the previous reply has arrived; `up` and `stop` end it, and MMB never repeats. The retargeting, the history steps
 * and the `changed` refusals are the page's aim (`worldPage.test.ts`, rulings R18); this file pins the timing.
 */
import { describe, expect, test } from 'vitest';
import { REPEAT_BREAK_S, REPEAT_PLACE_S, createHoldRepeat } from '../../src/ui/world/holdRepeat';

/** A frame's time in seconds from integer ms: `ms / 1000` is the double nearest the decimal, so 0.3 reads 0.3. */
const sec = (ms: number): number => ms / 1000;

/**
 * A hold repeat over a fake edit path: each queued button is posted at once and its reply arrives `replyS` later
 * (`pending()` true until then). `run(fromMs, toMs)` ticks every ms; `queued` holds each queue's (button, time).
 */
function rig(o: { enabled: boolean; replyS: number }) {
  let t = 0;
  let replyAt = -1;
  const queued: [b: number, t: number][] = [];
  const repeat = createHoldRepeat({
    enabled: () => o.enabled,
    pending: () => t < replyAt,
    queue: (b) => {
      // Each queue posts after the previous reply (a post while pending would be a `changed` refusal).
      expect(t >= replyAt, `queued at ${t} before the reply at ${replyAt}`).toBe(true);
      queued.push([b, t]);
      replyAt = t + o.replyS;
    },
  });
  const run = (fromMs: number, toMs: number): void => {
    for (let ms = fromMs; ms <= toMs; ms++) {
      t = sec(ms);
      repeat.tick(t);
    }
  };
  const at = (ms: number): void => { t = sec(ms); };
  return { repeat, queued, run, at };
}

describe('createHoldRepeat (SP5a spec §4.1, D6)', () => {
  test('the rates are Minecraft creative\'s: break every 0.3 s, place every 0.2 s', () => {
    expect([REPEAT_BREAK_S, REPEAT_PLACE_S]).toEqual([0.3, 0.2]);
  });

  test('off: one action per press however long held', () => {
    for (const b of [0, 1, 2] as const) {
      const r = rig({ enabled: false, replyS: 0.05 });
      r.at(0);
      r.repeat.down(b, 0);
      r.run(0, 3000);
      r.repeat.up(b);
      r.run(3001, 4000);
      expect(r.queued, `button ${b}`).toEqual([[b, 0]]);
    }
  });

  test('Review Focus 1: on, held LMB for 1.0 s with each reply 50 ms after its post: queued at 0, 0.3, 0.6, 0.9 s, each after the previous reply', () => {
    const r = rig({ enabled: true, replyS: 0.05 });
    r.at(0);
    r.repeat.down(0, 0);
    r.run(0, 1000);
    r.repeat.up(0);
    r.run(1001, 2000);
    expect(r.queued).toEqual([[0, 0], [0, 0.3], [0, 0.6], [0, 0.9]]);
  });

  test('RMB on: 0, 0.2, 0.4, … 1.0 s', () => {
    const r = rig({ enabled: true, replyS: 0.05 });
    r.at(0);
    r.repeat.down(2, 0);
    r.run(0, 1000);
    r.repeat.up(2);
    r.run(1001, 2000);
    expect(r.queued).toEqual([[2, 0], [2, 0.2], [2, 0.4], [2, 0.6], [2, 0.8], [2, 1]]);
  });

  test('RMB held with each reply 250 ms after its post: the second place is queued at 0.25 s (at the reply), not 0.2 s; LMB with each reply 350 ms after its post: the second break at 0.35 s', () => {
    const place = rig({ enabled: true, replyS: 0.25 });
    place.at(0);
    place.repeat.down(2, 0);
    place.run(0, 1000);
    expect(place.queued.map(([, t]) => t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const brk = rig({ enabled: true, replyS: 0.35 });
    brk.at(0);
    brk.repeat.down(0, 0);
    brk.run(0, 1000);
    expect(brk.queued.map(([, t]) => t)).toEqual([0, 0.35, 0.7]);
  });

  test('`up`, `stop` end it; MMB never repeats', () => {
    const up = rig({ enabled: true, replyS: 0.05 });
    up.at(0);
    up.repeat.down(0, 0);
    up.run(0, 500);
    up.repeat.up(0);
    up.run(501, 2000);
    expect(up.queued).toEqual([[0, 0], [0, 0.3]]);

    const stop = rig({ enabled: true, replyS: 0.05 });
    stop.at(0);
    stop.repeat.down(2, 0);
    stop.run(0, 300);
    stop.repeat.stop();
    stop.run(301, 2000);
    expect(stop.queued).toEqual([[2, 0], [2, 0.2]]);
    // The button's later release changes nothing; a new press starts again.
    stop.repeat.up(2);
    stop.at(2100);
    stop.repeat.down(2, 2.1);
    stop.run(2100, 2300);
    expect(stop.queued.slice(2)).toEqual([[2, 2.1], [2, 2.3]]);

    const mmb = rig({ enabled: true, replyS: 0.05 });
    mmb.at(0);
    mmb.repeat.down(1, 0);
    mmb.run(0, 2000);
    expect(mmb.queued).toEqual([[1, 0]]);
  });

  test('a release of the other button leaves the held one repeating; MMB pressed while LMB is held does not end it', () => {
    const r = rig({ enabled: true, replyS: 0.05 });
    r.at(0);
    r.repeat.down(0, 0);
    r.run(0, 100);
    r.repeat.down(1, 0.1);
    r.repeat.up(1);
    r.repeat.up(2);
    r.run(101, 700);
    expect(r.queued).toEqual([[0, 0], [1, 0.1], [0, 0.3], [0, 0.6]]);
  });
});

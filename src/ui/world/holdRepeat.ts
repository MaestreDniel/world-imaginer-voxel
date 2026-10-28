/**
 * Hold to repeat (SP5a spec §4.1, D6, Point 3): the "Hold mouse button to repeat" setting, off by default.
 *
 * - `down` queues its button's action once, whatever the setting: a press is one action.
 * - With the setting on, a held LMB or RMB is queued again by `tick` once `REPEAT_BREAK_S` (break) or `REPEAT_PLACE_S`
 *   (place) have passed since its previous queue and that one's reply has arrived: at max(previous + the rate, the
 *   reply's arrival), checked on the frame clock. While a reply is pending it waits, so a repeat never carries a stale
 *   `expect` (no `changed` refusals from repeats, §2.1).
 * - The page's aim ticks it after the frame's DDA and before the queued clicks run, so each repeat is aimed by that
 *   frame's DDA and is one history step like a click.
 * - `up` of the held button ends it; `stop` ends it too: the page calls it at the lock's release, the palette, the map
 *   and a mode switch, after which only a new press acts. MMB (1) never repeats, and pressing it leaves a held button
 *   repeating; pressing LMB or RMB makes it the held one.
 *
 * `tick` allocates nothing while idle or waiting for a reply.
 */

/** Minecraft creative's break rate while held (D6), seconds. */
export const REPEAT_BREAK_S = 0.3;
/** Minecraft creative's place rate while held (D6), seconds. */
export const REPEAT_PLACE_S = 0.2;

/**
 * How early a frame may be and still count as due: a sum of 0.2 s steps drifts by an ulp (0.4 + 0.2 reads
 * 0.6000000000000001), which would otherwise push a repeat a whole frame late.
 */
const DUE_EPS_S = 1e-6;

export interface HoldRepeat {
  /** A press at `t` (seconds, the frame clock): queues the button's action once; LMB and RMB become the held button. */
  down(b: 0 | 1 | 2, t: number): void;
  /** A release: ends the repeat when `b` is the held button. */
  up(b: 0 | 1 | 2): void;
  /** Ends the repeat (the lock's release, the palette, the map, a mode switch). */
  stop(): void;
  /** The frame's check at `t`: queues the held button again when the setting is on, it is due and no reply is pending. */
  tick(t: number): void;
}

export function createHoldRepeat(o: {
  /** The setting (`WorldSettings.holdRepeat`). */
  enabled(): boolean;
  /** Whether an edit's reply is still pending (the edit path's). */
  pending(): boolean;
  /** Queues the button's action for the frame's aim (the click queue's `push`). */
  queue(b: 0 | 1 | 2): void;
}): HoldRepeat {
  /** The held button, or −1. */
  let held: -1 | 0 | 2 = -1;
  /** When the held button was last queued. */
  let last = 0;
  return {
    down(b, t) {
      o.queue(b);
      if (b === 1) return;
      held = b;
      last = t;
    },
    up(b) {
      if (b === held) held = -1;
    },
    stop() {
      held = -1;
    },
    tick(t) {
      if (held === -1 || !o.enabled() || o.pending()) return;
      if (t < last + (held === 0 ? REPEAT_BREAK_S : REPEAT_PLACE_S) - DUE_EPS_S) return;
      o.queue(held);
      last = t;
    },
  };
}

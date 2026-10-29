/**
 * Sprint by a double-tapped forward key (Task 45b, the user's finding at SP5a's production check: Ctrl+W closes the tab
 * before the page sees it, so Ctrl no longer sprints; R held sprints too, through the key map). As Minecraft: a forward
 * keydown that is not an auto-repeat, within `SPRINT_DOUBLE_TAP_S` of the previous one, latches sprint until the forward
 * key is released. A held key's auto-repeat keydowns neither latch nor count as the previous tap. `clear` forgets the
 * latch and the last tap: the input calls it wherever it clears its held keys (blur, the lock's release, an owner
 * change).
 *
 * The caller passes each keydown's time in seconds (the event's `timeStamp / 1000`); nothing here reads a clock or
 * allocates.
 */

/** Minecraft's double-tap window, 7 ticks, seconds. */
export const SPRINT_DOUBLE_TAP_S = 0.35;

/**
 * How late a second tap may be and still count: millisecond timestamps divided by 1000 drift by an ulp (1.35 − 1 reads
 * 0.3500000000000001), which would otherwise refuse a tap exactly at the window's end.
 */
const TAP_EPS_S = 1e-6;

export interface SprintTap {
  /** A forward keydown at `t` seconds; `repeat` is the event's auto-repeat flag (an auto-repeat is ignored). */
  press(t: number, repeat: boolean): void;
  /** The forward key released: the latch ends. */
  release(): void;
  /** Ends the latch and forgets the last tap (the input's held keys cleared). */
  clear(): void;
  /** Whether the double tap holds sprint. */
  readonly latched: boolean;
}

export function createSprintTap(): SprintTap {
  /** The previous non-repeat press, or −∞. */
  let last = Number.NEGATIVE_INFINITY;
  let latched = false;
  return {
    press(t, repeat) {
      if (repeat) return;
      if (t - last <= SPRINT_DOUBLE_TAP_S + TAP_EPS_S) latched = true;
      last = t;
    },
    release() {
      latched = false;
    },
    clear() {
      latched = false;
      last = Number.NEGATIVE_INFINITY;
    },
    get latched() {
      return latched;
    },
  };
}

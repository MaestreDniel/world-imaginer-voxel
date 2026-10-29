/**
 * Sprint by a double-tapped forward key (Task 45b; the user's finding at the SP5a production check: Ctrl+W closes the
 * tab, so Ctrl no longer sprints): a forward keydown that is not an auto-repeat, within `SPRINT_DOUBLE_TAP_S` of the
 * previous one, latches sprint until the forward key is released; `clear` forgets the latch and the last tap. The
 * wiring into the held keys (R held, W's keyup, blur, the lock's release) is `input.test.ts`'s.
 */
import { describe, expect, test } from 'vitest';
import { SPRINT_DOUBLE_TAP_S, createSprintTap } from '../../src/player/sprintTap';

/** A key event's time in seconds from integer ms, as the input passes `timeStamp / 1000`. */
const sec = (ms: number): number => ms / 1000;

describe('sprint by a double-tapped forward key (Task 45b)', () => {
  test('the window is Minecraft\'s 7 ticks, 0.35 s', () => {
    expect(SPRINT_DOUBLE_TAP_S).toBe(0.35);
  });

  test('a second tap within 0.35 s latches; one tap does not', () => {
    const tap = createSprintTap();
    tap.press(sec(1000), false);
    expect(tap.latched).toBe(false);
    tap.release();
    tap.press(sec(1200), false);
    expect(tap.latched).toBe(true);
  });

  test('a second tap exactly 0.35 s later latches (from timeStamps of 1000 and 1350 ms), 0.351 s later does not', () => {
    const at = createSprintTap();
    at.press(sec(1000), false);
    at.release();
    at.press(sec(1350), false);
    expect(at.latched).toBe(true);
    const late = createSprintTap();
    late.press(sec(1000), false);
    late.release();
    late.press(sec(1351), false);
    expect(late.latched).toBe(false);
  });

  test('a second tap after 0.35 s does not latch, and becomes the first tap of the next pair', () => {
    const tap = createSprintTap();
    tap.press(sec(0), false);
    tap.release();
    tap.press(sec(400), false);
    expect(tap.latched).toBe(false);
    tap.release();
    tap.press(sec(600), false);
    expect(tap.latched).toBe(true);
  });

  test('a held key\'s auto-repeat keydowns never latch, and never count as the previous tap', () => {
    const tap = createSprintTap();
    tap.press(sec(0), false);
    for (let ms = 500; ms <= 2000; ms += 33) tap.press(sec(ms), true);
    expect(tap.latched).toBe(false);
    tap.release();
    // 0.1 s after the last repeat, but 2.1 s after the last real press.
    tap.press(sec(2100), false);
    expect(tap.latched).toBe(false);
  });

  test('release ends the latch; the next single tap far later does not latch again', () => {
    const tap = createSprintTap();
    tap.press(sec(0), false);
    tap.release();
    tap.press(sec(200), false);
    expect(tap.latched).toBe(true);
    tap.release();
    expect(tap.latched).toBe(false);
    tap.press(sec(5000), false);
    expect(tap.latched).toBe(false);
  });

  test('clear ends the latch and forgets the last tap', () => {
    const tap = createSprintTap();
    tap.press(sec(0), false);
    tap.release();
    tap.press(sec(200), false);
    expect(tap.latched).toBe(true);
    tap.clear();
    expect(tap.latched).toBe(false);
    // 0.1 s after the forgotten tap: a first tap again.
    tap.press(sec(300), false);
    expect(tap.latched).toBe(false);
  });
});

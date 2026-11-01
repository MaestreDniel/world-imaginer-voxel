/**
 * The saved state's bounds (SP5b spec §2.1): `persist/` cannot import the player's, the world's or the clock's modules,
 * so the UI builds `STATE_BOUNDS` from them and `saves.ts` mirrors three defaults as literals, each pinned here, and the
 * history's total cap (SP5c spec §5), beside the step cap it shares with the sim.
 */
import { describe, expect, test } from 'vitest';
import { WINDOW_HALF } from '../../src/core/coords';
import { OPENING_T, TIME_SPEEDS } from '../../src/daynight/dayNight';
import { DEFAULT_SPEED, DEFAULT_T, HISTORY_STEPS, MAX_HISTORY_EDITS as SAVES_MAX_HISTORY_EDITS } from '../../src/persist/saves';
import { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from '../../src/player/fly';
import { normalizeHotbar } from '../../src/player/hotbar';
import { MAX_STEP_EDITS } from '../../src/sim/edits';
import { BLOCK_HISTORY_STEPS, MAX_HISTORY_EDITS } from '../../src/ui/world/blockHistory';
import { Y_MAX, Y_MIN } from '../../src/ui/world/query';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';

describe('STATE_BOUNDS (SP5b spec §2.1)', () => {
  test('`STATE_BOUNDS` equals the player\'s, the world\'s and the clock\'s constants', () => {
    const { normalizeHotbar: hotbarOf, ...numbers } = STATE_BOUNDS;
    expect(numbers).toEqual({
      timeSpeedCount: TIME_SPEEDS.length, speedMin: SPEED_MIN, speedMax: SPEED_MAX, xzLimit: WINDOW_HALF, yMin: Y_MIN, yMax: Y_MAX,
    });
    expect(hotbarOf(null)).toEqual({ v: 1, ...normalizeHotbar(null) });
    // The record is what the hotbar stores: read back through `normalizeHotbar`, it is the same hotbar.
    const stored = { v: 1, active: 4, slots: [{ type: 'oak_planks' }, { fluid: 'water' }, { type: 'nope' }] };
    expect(hotbarOf(stored)).toEqual({ v: 1, ...normalizeHotbar(stored) });
    expect(normalizeHotbar(hotbarOf(stored))).toEqual(normalizeHotbar(stored));
    expect(hotbarOf(stored).active).toBe(4);
  });

  test('saves\' `HISTORY_STEPS` equals `BLOCK_HISTORY_STEPS`, `DEFAULT_SPEED` equals `SPEED_DEFAULT` and `DEFAULT_T` equals `OPENING_T`', () => {
    expect(HISTORY_STEPS).toBe(BLOCK_HISTORY_STEPS);
    expect(DEFAULT_SPEED).toBe(SPEED_DEFAULT);
    expect(DEFAULT_T).toBe(OPENING_T);
  });

  test('`MAX_HISTORY_EDITS` of `saves.ts` equals `blockHistory.ts`\'s, both 65,536; `MAX_STEP_EDITS` is 32,768', () => {
    expect(SAVES_MAX_HISTORY_EDITS).toBe(MAX_HISTORY_EDITS);
    expect(MAX_HISTORY_EDITS).toBe(65_536);
    expect(MAX_STEP_EDITS).toBe(32_768);
  });
});

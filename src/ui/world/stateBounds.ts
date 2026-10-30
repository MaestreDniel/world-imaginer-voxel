/**
 * The saved state's bounds (SP5b spec §2.1): `persist/` value-imports the L2 core only, so the normaliser's bounds that
 * live in the player's, the clock's and the page's modules come in as `StateBounds`, built here from them: the hotbar's
 * `normalizeHotbar` (as the record the hotbar stores), the time speeds' count, the flying speed's range, the world
 * window (flight has no horizontal limit, so a pose is bounded by `WINDOW_HALF`, not `?at`'s `AT_LIMIT`) and the
 * camera's y range. `stateBounds.test.ts` pins them, and `saves.ts`' literal defaults, equal to their sources.
 */
import { WINDOW_HALF } from '../../core/coords';
import { TIME_SPEEDS } from '../../daynight/dayNight';
import type { HotbarRecord, StateBounds } from '../../persist/saves';
import { SPEED_MAX, SPEED_MIN } from '../../player/fly';
import { normalizeHotbar } from '../../player/hotbar';
import { Y_MAX, Y_MIN } from './query';

/** The bounds the page's open (§3.4), the autosave's snapshot (§3.2) and the menu's Create (§1.2) normalise with. */
export const STATE_BOUNDS: StateBounds = Object.freeze({
  normalizeHotbar: (raw: unknown): HotbarRecord => ({ v: 1, ...normalizeHotbar(raw) }),
  timeSpeedCount: TIME_SPEEDS.length,
  speedMin: SPEED_MIN,
  speedMax: SPEED_MAX,
  xzLimit: WINDOW_HALF,
  yMin: Y_MIN,
  yMax: Y_MAX,
});

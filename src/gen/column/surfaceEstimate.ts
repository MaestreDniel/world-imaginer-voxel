/**
 * surfaceEst3 (SP3b spec §5, master §3.7): the 3D surface estimate, a search of the density's `terrain` tap
 * (interpolated, without `detail`) through the probe. Used for voxels and T5 only: the ColumnSample's `surfaceEst`
 * (map, biome picker, column stage) stays the 2D `offset`. Not cached (the quart-lattice cache comes with its first
 * consumer, SP4-SP7). Follows the gen determinism rules.
 */
import { inWindow } from '../../core/coords';
import type { DensityContext } from '../density/context';
import { probe } from '../density/probe';
import { readField } from './columnStage';

const IN_WINDOW = inWindow;
const PROBE = probe;
const READ = readField;

const TAP = 'terrain';

/**
 * The surface y at world (x, z) (integers in the world window; an integer result):
 * 1. y = ⌊offset(x, z)⌋ (the bilinear ColumnSample value), clamped to [−64, 319].
 * 2. If terrain(y) > 0, step up by 8 while the next step is > 0; otherwise step down by 8 while the next step is ≤ 0.
 *    A step is cut at 319 (up) or −64 (down). That gives a bracket [a, c] with terrain(a) > 0 ≥ terrain(c), c − a = 8
 *    unless cut.
 * 3. Bisection with midpoint a + ⌊(c − a) / 2⌋ until c − a = 1 (three steps for a bracket of 8); the result is a.
 * 4. Ends: terrain > 0 at 319 when stepping up returns 319; terrain ≤ 0 at −64 when stepping down returns −64.
 * An 8-step scan can cross a gap (and return the ground under an overhang, or an overhang's top). The DensityContext's
 * expression must have a `terrain` tap (the probe throws otherwise).
 */
export function surfaceEst3(dc: DensityContext, x: number, z: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(z) || !IN_WINDOW(x, z)) throw new RangeError(`surfaceEst3 (x, z) = (${x}, ${z}) is not an integer position in the world window`);
  const s = dc.column(x >> 4, z >> 4);
  let y = Math.floor(READ(s, 'offset', x, z));
  y = y < -64 ? -64 : y > 319 ? 319 : y;
  let a: number;
  let c: number;
  if (PROBE(dc, x, y, z, TAP) > 0) {
    a = y;
    for (;;) {
      if (a === 319) return 319;
      const n = Math.min(a + 8, 319);
      if (!(PROBE(dc, x, n, z, TAP) > 0)) { c = n; break; }
      a = n;
    }
  } else {
    c = y;
    for (;;) {
      if (c === -64) return -64;
      const n = Math.max(c - 8, -64);
      if (PROBE(dc, x, n, z, TAP) > 0) { a = n; break; }
      c = n;
    }
  }
  while (c - a > 1) {
    const m = a + ((c - a) >> 1);
    if (PROBE(dc, x, m, z, TAP) > 0) a = m;
    else c = m;
  }
  return a;
}

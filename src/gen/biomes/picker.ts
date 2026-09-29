/**
 * Surface-biome picker (SP2a spec §3.2): the river flag first; otherwise the box with the lowest summed
 * squared overshoot (0 inside), ties broken by the lower priority; boxes with a W sign skip the other sign.
 */
import type { GenContext } from '../context';
import { BOX_TO_BIOME, biomeId } from './registry';

const ID = biomeId;
const TO_BIOME = BOX_TO_BIOME;

export interface Pick {
  /** Winning box index (−1 for a river override), biome id, and the winner's and runner-up's fitness. */
  box: number; biome: number; fitness: number; runnerUp: number;
}

export const newPick = (): Pick => ({ box: -1, biome: 0, fitness: 0, runnerUp: Infinity });

const V = new Float64Array(5);

export function pickBox(ctx: GenContext, C: number, E: number, PV: number, T: number, H: number, W: number, out: Pick): Pick {
  pickPass(ctx, C, E, PV, T, H, W < 0 ? -1 : 1, out);
  // A table whose W filters exclude every box (e.g. all wSign +1 and W < 0) falls back to ignoring the filter.
  if (out.box < 0) pickPass(ctx, C, E, PV, T, H, 0, out);
  return out;
}

/** One pass over the boxes; sign 0 disables the W filter. */
function pickPass(ctx: GenContext, C: number, E: number, PV: number, T: number, H: number, sign: number, out: Pick): void {
  V[0] = C; V[1] = E; V[2] = PV; V[3] = T; V[4] = H;
  let best = -1;
  let bestF = Infinity;
  let bestP = Infinity;
  let second = Infinity;
  for (const b of ctx.boxes) {
    if (sign !== 0 && b.wSign !== 0 && b.wSign !== sign) continue;
    let f = 0;
    for (let k = 0; k < 5; k++) {
      const v = V[k]!;
      const lo = b.lo[k]!;
      const hi = b.hi[k]!;
      const o = v < lo ? lo - v : v > hi ? v - hi : 0;
      f += o * o;
    }
    if (f < bestF || (f === bestF && b.priority < bestP)) {
      if (best >= 0) second = Math.min(second, bestF);
      best = b.index; bestF = f; bestP = b.priority;
    } else if (f < second) {
      second = f;
    }
  }
  out.box = best;
  out.biome = best < 0 ? -1 : TO_BIOME[best]!;
  out.fitness = bestF;
  out.runnerUp = second;
}

const SCRATCH = newPick();

/** Biome id at a point: river override (frozen below T −0.6), else the best box. */
export function pickBiome(ctx: GenContext, C: number, E: number, PV: number, T: number, H: number, W: number, riverWet: boolean): number {
  if (riverWet) return T < -0.6 ? ID('frozen_river') : ID('river');
  return pickBox(ctx, C, E, PV, T, H, W, SCRATCH).biome;
}

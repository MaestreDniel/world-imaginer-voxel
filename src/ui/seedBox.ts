import type { Seed64 } from '../core/hash';
import { resolveSeedText as resolveCore } from '../core/seed';

export function cryptoSeed(): Seed64 {
  const w = crypto.getRandomValues(new Uint32Array(2));
  return [w[0]! >>> 0, w[1]! >>> 0];
}

/** The SP1 seed-box rule with a crypto random default (the rule itself lives in core/seed.ts). */
export function resolveSeedText(text: string, random: () => Seed64 = cryptoSeed): { text: string; seed: Seed64 } {
  return resolveCore(text, random);
}

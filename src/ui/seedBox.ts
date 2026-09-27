import type { Seed64 } from '../core/hash';
import { seedFromInput, seedToText } from '../core/seed';

export function cryptoSeed(): Seed64 {
  const w = crypto.getRandomValues(new Uint32Array(2));
  return [w[0]! >>> 0, w[1]! >>> 0];
}

/**
 * Seed-box rule (SP1 spec §1.4): non-empty text is trimmed and parsed; empty text draws a random seed and
 * returns its decimal text so the UI writes it back and the world stays reproducible from the box.
 */
export function resolveSeedText(text: string, random: () => Seed64 = cryptoSeed): { text: string; seed: Seed64 } {
  const t = text.trim();
  if (t.length > 0) return { text: t, seed: seedFromInput(t) };
  const drawn = seedToText(random());
  return { text: drawn, seed: seedFromInput(drawn) };
}

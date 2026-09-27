import { fnv1a64, type Seed64 } from './hash';

const DECIMAL = /^[+-]?[0-9]+$/;
const MIN_I64 = -(1n << 63n);
const LIMIT_U64 = 1n << 64n;

/**
 * Seed text → Seed64. Trim only (no Unicode normalisation; case-sensitive). An integer in
 * [−2^63, 2^64 − 1] is its value mod 2^64; anything else is fnv1a64 of the trimmed text.
 */
export function seedFromInput(text: string): Seed64 {
  const t = text.trim();
  if (DECIMAL.test(t)) {
    const v = BigInt(t);
    if (v >= MIN_I64 && v < LIMIT_U64) {
      const u = BigInt.asUintN(64, v);
      return [Number(u & 0xffffffffn) >>> 0, Number(u >> 32n) >>> 0];
    }
  }
  return fnv1a64(t);
}

/** Unsigned decimal of hi·2^32 + lo; seedFromInput(seedToText(s)) equals s. */
export function seedToText(seed: Seed64): string {
  return ((BigInt(seed[1]) << 32n) | BigInt(seed[0])).toString();
}

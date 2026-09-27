/** Deterministic test RNG (mulberry32). Tests never use Math.random. */
export function testRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Uniform double in [0, 1) from testRng. */
export function testFloat(next: () => number): number {
  return next() / 4294967296;
}

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

/** IEEE bits of x as 16 upper-case hex digits. */
export function f64Hex(x: number): string {
  F64[0] = x;
  return U64[0]!.toString(16).toUpperCase().padStart(16, '0');
}

/** Next representable double above x (finite x). */
export function nextUp(x: number): number {
  if (x !== x || x === Infinity) return x;
  if (x === 0) return 5e-324;
  F64[0] = x;
  U64[0] = x > 0 ? U64[0]! + 1n : U64[0]! - 1n;
  return F64[0]!;
}

/** Next representable double below x (finite x). */
export function nextDown(x: number): number {
  return -nextUp(-x);
}

/** Reference erf: Taylor series below 3, erfc continued fraction above (|error| < 1e-13). */
export function refErf(x: number): number {
  if (x !== x) return x;
  if (x < 0) return -refErf(-x);
  if (x < 3) {
    const x2 = x * x;
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n++) {
      term *= -x2 / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum;
  }
  let k = x;
  for (let n = 60; n >= 1; n--) k = x + n / 2 / k;
  return 1 - Math.exp(-x * x) / (Math.sqrt(Math.PI) * k);
}

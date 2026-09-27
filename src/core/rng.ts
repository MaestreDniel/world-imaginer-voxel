/** splitmix32 stream (u32 outputs). */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z >>> 0;
  };
}

/** xoshiro128** 1.1. Every draw consumes exactly one nextU32. */
export class Xoshiro128 {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.a = sm() | 0;
    this.b = sm() | 0;
    this.c = sm() | 0;
    this.d = sm() | 0;
  }

  static fromState(a: number, b: number, c: number, d: number): Xoshiro128 {
    const r = new Xoshiro128(0);
    r.a = a | 0;
    r.b = b | 0;
    r.c = c | 0;
    r.d = d | 0;
    return r;
  }

  nextU32(): number {
    let x = Math.imul(this.b, 5);
    x = (x << 7) | (x >>> 25);
    const r = Math.imul(x, 9) >>> 0;
    const t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = (this.d << 11) | (this.d >>> 21);
    return r;
  }

  /** [0, 1) with 2^-32 granularity (one draw). */
  nextFloat(): number {
    return this.nextU32() * 2.3283064365386963e-10;
  }

  /** Uniform integer in [0, n), 1 ≤ n ≤ 2^32, by threshold rejection (unbiased). */
  nextInt(n: number): number {
    const thr = 4294967296 % n;
    let u = this.nextU32();
    while (u < thr) u = this.nextU32();
    return u % n;
  }
}

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

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb);
}

export function sampleSd(a: ArrayLike<number>): number {
  const n = a.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += a[i]!;
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]! - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

/** ln Γ(x), Lanczos (g 7, 9 terms). */
export function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The regularized upper incomplete gamma Q(a, x) (series below a + 1, Lentz's continued fraction above). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 10000; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - gln));
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** The p-value of a χ² statistic with df degrees of freedom. */
export function chiSquareP(chi2: number, df: number): number {
  return gammaQ(df / 2, chi2 / 2);
}

/** S1.ymod16's soil-depth classes 0, 1, 2, 3, 4, 5+ (index 5). */
export const YMOD16_CLASSES = 6;
const CLASSES = YMOD16_CLASSES;
/** SP3c spec §5.2 S1.ymod16: a soil-depth class needs 80 positions, else it merges toward class 2. */
const MIN_CLASS = 80;
/** §5.2's merge order and each class's neighbour toward class 2. */
const MERGE_ORDER = [0, 1, 5, 4, 3] as const;
const MERGE_INTO: Readonly<Record<number, number>> = { 0: 1, 1: 2, 5: 4, 4: 3, 3: 2 };
/** Class 2's neighbours, nearest first (below before above), for a class 2 left below 80 positions. */
const ABSORB_ORDER = [1, 0, 3, 4, 5] as const;

export interface Ymod16Result {
  p: number;
  chi2: number;
  df: number;
  /** Classes left after merging, by their (target) names. */
  classes: number[];
  rows: number;
  n: number;
  degenerate: boolean;
}

/**
 * §5.2 S1.ymod16 on a 16 × 6 table (row y mod 16, class 0 … 5+; index 6·row + class): classes merge until every
 * remaining class has ≥ 80 positions (first in the order 0, 1, 5+, 4, 3 with fewer, into its neighbour toward 2; class 2
 * never merges, and if it still has fewer than 80 it absorbs its nearest remaining neighbours, 1, 0, 3, 4, 5+, keeping
 * its name), empty rows are dropped, then the χ² independence test of rows × classes. No remaining column is ever
 * below 80 positions, so no expected count is 0 and p is a number unless the table is degenerate.
 */
export function ymod16Test(table: ArrayLike<number>): Ymod16Result {
  const col = new Float64Array(CLASSES);
  for (let r = 0; r < 16; r++) for (let k = 0; k < CLASSES; k++) col[k]! += table[6 * r + k]!;
  const alive = [true, true, true, true, true, true];
  const owner = [0, 1, 2, 3, 4, 5];
  for (;;) {
    const c = MERGE_ORDER.find((k) => alive[k] && col[k]! < MIN_CLASS);
    if (c === undefined) break;
    let t = MERGE_INTO[c]!;
    while (!alive[t]) t = MERGE_INTO[t]!;
    col[t]! += col[c]!;
    col[c] = 0;
    alive[c] = false;
    for (let k = 0; k < CLASSES; k++) if (owner[k] === c) owner[k] = t;
  }
  // Class 2 never merges, so it can stay below 80 (even empty: an all-zero column would make every expected count 0
  // and χ² 0/0 = NaN). It absorbs its nearest remaining neighbour instead, below first (1, 0) then above (3, 4, 5+),
  // keeping its name, until it has 80 or nothing is left (a degenerate table).
  for (;;) {
    if (col[2]! >= MIN_CLASS) break;
    const t = ABSORB_ORDER.find((k) => alive[k]);
    if (t === undefined) break;
    col[2]! += col[t]!;
    col[t] = 0;
    alive[t] = false;
    for (let k = 0; k < CLASSES; k++) if (owner[k] === t) owner[k] = 2;
  }
  const classes = [0, 1, 2, 3, 4, 5].filter((k) => alive[k]);
  const merged: number[][] = [];
  for (let r = 0; r < 16; r++) {
    const row = classes.map(() => 0);
    for (let k = 0; k < CLASSES; k++) row[classes.indexOf(owner[k]!)]! += table[6 * r + k]!;
    if (row.some((v) => v > 0)) merged.push(row);
  }
  const n = merged.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  if (classes.length < 2 || merged.length < 2) return { p: NaN, chi2: NaN, df: 0, classes, rows: merged.length, n, degenerate: true };
  const rowSum = merged.map((row) => row.reduce((a, b) => a + b, 0));
  const colSum = classes.map((_, j) => merged.reduce((s, row) => s + row[j]!, 0));
  let chi2 = 0;
  for (let i = 0; i < merged.length; i++) {
    for (let j = 0; j < classes.length; j++) {
      const e = (rowSum[i]! * colSum[j]!) / n;
      const d = merged[i]![j]! - e;
      chi2 += (d * d) / e;
    }
  }
  const df = (merged.length - 1) * (classes.length - 1);
  return { p: chiSquareP(chi2, df), chi2, df, classes, rows: merged.length, n, degenerate: false };
}

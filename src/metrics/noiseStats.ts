/**
 * Statistics shared by the metric tests and the lab (SP1 spec §6, §7.3): one implementation, so the
 * lab shows the numbers CI gates on.
 */
import { fnv1a32 } from '../core/hash';
import type { NoiseDef } from '../core/noise/types';
import { Xoshiro128 } from '../core/rng';

const FNV32 = fnv1a32;
const Rng = Xoshiro128;

/** Half-width of the colKey window [−2^19, 2^19). */
export const WINDOW = 524288;

export interface Points {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
}

export type Field = (x: number, y: number, z: number) => number;

/** n points from new Xoshiro128(fnv1a32(id)); each point draws x, y, z in this order. */
export function samplePoints(id: string, n: number): Points {
  const r = new Rng(FNV32(id));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = -524288 + 1048576 * r.nextFloat();
    y[i] = -64 + 384 * r.nextFloat();
    z[i] = -524288 + 1048576 * r.nextFloat();
  }
  return { n, x, y, z };
}

/** Welford accumulator. */
export class Moments {
  n = 0;
  mean = 0;
  min = Infinity;
  max = -Infinity;
  private m2 = 0;

  add(v: number): void {
    this.n++;
    const d = v - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (v - this.mean);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  get sd(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }
}

/** Kolmogorov–Smirnov D of `u` against U(lo, hi). */
export function ksUniform(u: ArrayLike<number>, lo = -1, hi = 1): number {
  const a = Float64Array.from(u).sort();
  const n = a.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = (a[i]! - lo) / (hi - lo);
    d = Math.max(d, f - i / n, (i + 1) / n - f);
  }
  return d;
}

/** Counts over `bins` equal bins of [lo, hi]; values outside clamp into the end bins. */
export function histogram(values: ArrayLike<number>, lo: number, hi: number, bins: number): Uint32Array {
  const out = new Uint32Array(bins);
  for (let i = 0; i < values.length; i++) {
    let b = Math.floor(((values[i]! - lo) / (hi - lo)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    out[b]!++;
  }
  return out;
}

/** 16 bins centred on axes and diagonals: floor((θ + π + π/16)/(2π)·16) mod 16, θ = atan2(db, da). */
export function roseBin(da: number, db: number): number {
  const theta = Math.atan2(db, da);
  const b = Math.floor(((theta + Math.PI + Math.PI / 16) / (2 * Math.PI)) * 16);
  return b >= 16 ? b - 16 : b;
}

export class Rose {
  readonly counts = new Float64Array(16);

  add(da: number, db: number): void {
    this.counts[roseBin(da, db)]!++;
  }

  /** max/min bin count (Infinity while a bin is empty). */
  ratio(): number {
    let mx = 0;
    let mn = Infinity;
    for (const c of this.counts) {
      if (c > mx) mx = c;
      if (c < mn) mn = c;
    }
    return mn === 0 ? Infinity : mx / mn;
  }
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

export function lastOctaveWavelength(def: NoiseDef): number {
  let l = def.wavelength;
  for (let i = 1; i < def.octaves; i++) l = l / def.lacunarity;
  return l;
}

const snapX = (v: number, corners: boolean) => (corners ? 4 * Math.floor(v / 4) : v);
const snapY = (v: number, corners: boolean) => (corners ? 8 * Math.floor(v / 8) : v);

/** mean |f(a_i) − f(b_i)| over independent random pairs. */
export function meanAbsPairDiff(f: Field, a: Points, b: Points, corners: boolean): number {
  let s = 0;
  for (let i = 0; i < a.n; i++) {
    s += Math.abs(f(snapX(a.x[i]!, corners), snapY(a.y[i]!, corners), snapX(a.z[i]!, corners)) - f(snapX(b.x[i]!, corners), snapY(b.y[i]!, corners), snapX(b.z[i]!, corners)));
  }
  return s / a.n;
}

/** mean |f(p) − f(p + shift)| (shift components must keep corners on corners). */
export function meanAbsShiftDiff(f: Field, a: Points, shift: readonly [number, number, number], corners: boolean): number {
  let s = 0;
  for (let i = 0; i < a.n; i++) {
    const x = snapX(a.x[i]!, corners);
    const y = snapY(a.y[i]!, corners);
    const z = snapX(a.z[i]!, corners);
    s += Math.abs(f(x, y, z) - f(x + shift[0], y + shift[1], z + shift[2]));
  }
  return s / a.n;
}

/** P(|f| < 1e-6) at integer points (floor), or at 4×8×4 cell corners. */
export function zeroRate(f: Field, pts: Points, corners: boolean): number {
  let zeros = 0;
  for (let i = 0; i < pts.n; i++) {
    const x = corners ? 4 * Math.floor(pts.x[i]! / 4) : Math.floor(pts.x[i]!);
    const y = corners ? 8 * Math.floor(pts.y[i]! / 8) : Math.floor(pts.y[i]!);
    const z = corners ? 4 * Math.floor(pts.z[i]! / 4) : Math.floor(pts.z[i]!);
    if (Math.abs(f(x, y, z)) < 1e-6) zeros++;
  }
  return zeros / pts.n;
}

/**
 * Hashed-lattice gradient noise (SP1 spec §2.1): corner gradient = one of the 12 cube edges, index
 * ((hash3(s, X, Y, Z) & 0xffff) · 12) >>> 16; quintic fade; lerp along x, then y, then z. No table,
 * no period. This fused form is bit-identical to the literal 8-call form (unit-tested).
 */
const KX = 0x27d4eb2d;
const KY = 0x165667b1;
const KZ = 0x9e3779b1;
const M1 = 0x85ebca6b;
const M2 = 0xc2b2ae35;
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

/** Exact closed forms (E[A] = 181/231, E[B] = 535/9009, per-axis gradient energy 2/3). */
export const PERLIN3_SD = Math.sqrt(35054270 / 480729249);
/** 2D slice at frac(y) = ½. */
export const PERLIN2_SD = Math.sqrt(2052359 / 24972948);

export function lattice3(s: number, x: number, y: number, z: number): number {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  const fx = x - X;
  const fy = y - Y;
  const fz = z - Z;
  const gx0 = fx - 1;
  const gy0 = fy - 1;
  const gz0 = fz - 1;
  let t = Math.imul(X, KX);
  const ax0 = Math.imul(t ^ (t >>> 15), M1);
  t = (t + KX) | 0;
  const ax1 = Math.imul(t ^ (t >>> 15), M1);
  t = Math.imul(Y, KY);
  const ay0 = Math.imul(t ^ (t >>> 15), M1);
  t = (t + KY) | 0;
  const ay1 = Math.imul(t ^ (t >>> 15), M1);
  t = Math.imul(Z, KZ);
  const az0 = Math.imul(t ^ (t >>> 15), M1) ^ s;
  t = (t + KZ) | 0;
  const az1 = Math.imul(t ^ (t >>> 15), M1) ^ s;
  const b00 = ay0 ^ az0;
  const b10 = ay1 ^ az0;
  const b01 = ay0 ^ az1;
  const b11 = ay1 ^ az1;
  let h: number;
  h = ax0 ^ b00; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n000 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * fz;
  h = ax1 ^ b00; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n100 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * fz;
  h = ax0 ^ b10; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n010 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * fz;
  h = ax1 ^ b10; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n110 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * fz;
  h = ax0 ^ b01; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n001 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * gz0;
  h = ax1 ^ b01; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n101 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * gz0;
  h = ax0 ^ b11; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n011 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * gz0;
  h = ax1 ^ b11; h ^= h >>> 16; h = Math.imul(h, M1); h ^= h >>> 13; h = Math.imul(h, M2); h = (((h ^ (h >>> 16)) & 0xffff) * 12) >>> 16;
  const n111 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * gz0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

import { Xoshiro128 } from '../../src/core/rng';

const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

/** 512-entry permutation (256 shuffled by Fisher–Yates with xoshiro, then duplicated). Bench only. */
export function buildPerm(seed: number): Uint8Array {
  const P = new Uint8Array(512);
  for (let i = 0; i < 256; i++) P[i] = i;
  const r = new Xoshiro128(seed);
  for (let i = 255; i >= 1; i--) {
    const j = r.nextInt(i + 1);
    const t = P[i]!;
    P[i] = P[j]!;
    P[j] = t;
  }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i]!;
  return P;
}

/** Classic permutation-table gradient noise with lattice3's gradients, fade, lerp order and dot products. */
export function perm3(P: Uint8Array, x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z, gx0 = fx - 1, gy0 = fy - 1, gz0 = fz - 1;
  const x0 = X & 255, x1 = (X + 1) & 255, y0 = Y & 255, y1 = (Y + 1) & 255, z0 = Z & 255, z1 = (Z + 1) & 255;
  const a0 = P[x0]!, a1 = P[x1]!;
  const b00 = P[a0 + y0]!, b10 = P[a1 + y0]!, b01 = P[a0 + y1]!, b11 = P[a1 + y1]!;
  let h: number;
  h = P[b00 + z0]! % 12; const n000 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * fz;
  h = P[b10 + z0]! % 12; const n100 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * fz;
  h = P[b01 + z0]! % 12; const n010 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * fz;
  h = P[b11 + z0]! % 12; const n110 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * fz;
  h = P[b00 + z1]! % 12; const n001 = GX[h]! * fx + GY[h]! * fy + GZ[h]! * gz0;
  h = P[b10 + z1]! % 12; const n101 = GX[h]! * gx0 + GY[h]! * fy + GZ[h]! * gz0;
  h = P[b01 + z1]! % 12; const n011 = GX[h]! * fx + GY[h]! * gy0 + GZ[h]! * gz0;
  h = P[b11 + z1]! % 12; const n111 = GX[h]! * gx0 + GY[h]! * gy0 + GZ[h]! * gz0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const x00 = n000 + u * (n100 - n000), x10 = n010 + u * (n110 - n010), x01 = n001 + u * (n101 - n001), x11 = n011 + u * (n111 - n011);
  const yy0 = x00 + v * (x10 - x00), yy1 = x01 + v * (x11 - x01);
  return yy0 + w * (yy1 - yy0);
}

/** Two u32 words [lo, hi]; value = hi·2^32 + lo. Both words are normalised with >>> 0 wherever one is built. */
export type Seed64 = readonly [lo: number, hi: number];
export type Hash64 = Seed64;

const KX = 0x27d4eb2d;
const KY = 0x165667b1;
const KZ = 0x9e3779b1;
const KS = 0x85ebca77;
const M1 = 0x85ebca6b;
const M2 = 0xc2b2ae35;

/** murmur3 finaliser. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, M1);
  h ^= h >>> 13;
  h = Math.imul(h, M2);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Per-axis pre-mix: breaks the odd symmetry imul(−v, K) = imul(v, K) ^ (~0 << (tz(v) + 1)). */
function ax(v: number, k: number): number {
  const t = Math.imul(v, k);
  return Math.imul(t ^ (t >>> 15), M1);
}

export function hash2(s: number, x: number, z: number): number {
  return fmix32(s ^ ax(x, KX) ^ ax(z, KZ));
}

export function hash3(s: number, x: number, y: number, z: number): number {
  return fmix32(s ^ ax(x, KX) ^ ax(y, KY) ^ ax(z, KZ));
}

export function hash4(s: number, salt: number, x: number, z: number): number {
  return fmix32(s ^ ax(salt, KS) ^ ax(x, KX) ^ ax(z, KZ));
}

/** UTF-8 bytes of a string; a lone surrogate encodes as EF BF BD (as TextEncoder does). */
export function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  const n = str.length;
  for (let i = 0; i < n; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < n ? str.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function fnv1a32(str: string): number {
  const bytes = utf8Bytes(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

/** FNV-1a 64 as two u32 halves; prime = 2^40 + 0x1b3, and lo·0x1b3 < 2^41 is exact. */
export function fnv1a64Bytes(bytes: Uint8Array): Hash64 {
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]!) >>> 0;
    const p = lo * 0x1b3;
    const nlo = p >>> 0;
    hi = (Math.imul(hi, 0x1b3) + (p - nlo) / 4294967296 + (lo << 8)) >>> 0;
    lo = nlo;
  }
  return [lo, hi];
}

export function fnv1a64(str: string): Hash64 {
  return fnv1a64Bytes(utf8Bytes(str));
}

export function hex64(h: Hash64): string {
  return h[1].toString(16).padStart(8, '0') + h[0].toString(16).padStart(8, '0');
}

/** fnv1a64 over the little-endian bytes of each value; every NaN is written as 0x7FF8000000000000. */
export function hashF64(values: Float64Array): Hash64 {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v !== v) {
      view.setUint32(i * 8, 0, true);
      view.setUint32(i * 8 + 4, 0x7ff80000, true);
    } else {
      view.setFloat64(i * 8, v, true);
    }
  }
  return fnv1a64Bytes(bytes);
}

/** Per-noise (or per-feature) seed; a bijection of world[0] for a fixed name. */
export function deriveSeed(world: Seed64, name: string): number {
  return fmix32(world[0] ^ fmix32(world[1] ^ fnv1a32(name)));
}

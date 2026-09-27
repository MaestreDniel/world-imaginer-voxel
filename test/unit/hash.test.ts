import { describe, expect, test } from 'vitest';
import {
  deriveSeed, fmix32, fnv1a32, fnv1a64, fnv1a64Bytes, hash2, hash3, hash4, hashF64, hex64, utf8Bytes,
} from '../../src/core/hash';
import { testRng } from '../harness/stats';

describe('vectors', () => {
  test('fmix32', () => {
    expect(fmix32(1)).toBe(1364076727);
    expect(fmix32(0xdeadbeef)).toBe(233162409);
  });
  test('fnv1a32', () => {
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
  test('fnv1a64 returns [lo, hi] and hex64 prints hi first', () => {
    expect(hex64(fnv1a64(''))).toBe('cbf29ce484222325');
    expect(hex64(fnv1a64('a'))).toBe('af63dc4c8601ec8c');
    expect(hex64(fnv1a64('foobar'))).toBe('85944171f73967e8');
    expect(fnv1a64('')).toEqual([0x84222325, 0xcbf29ce4]);
  });
});

function bigFnv64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

test('fnv1a64 halves match a BigInt reference on 2000 random byte strings', () => {
  const next = testRng(11);
  for (let i = 0; i < 2000; i++) {
    const bytes = new Uint8Array(next() % 64);
    for (let k = 0; k < bytes.length; k++) bytes[k] = next() & 255;
    expect(hex64(fnv1a64Bytes(bytes))).toBe(bigFnv64(bytes));
  }
});

test('utf8Bytes equals TextEncoder on 20k random strings with lone surrogates', () => {
  const next = testRng(12);
  const enc = new TextEncoder();
  for (let i = 0; i < 20000; i++) {
    const n = next() % 12;
    let s = '';
    for (let k = 0; k < n; k++) {
      const r = next() % 5;
      if (r === 0) s += String.fromCharCode(0xd800 + (next() % 0x800));
      else if (r === 1) s += String.fromCodePoint(0x10000 + (next() % 0xfffff));
      else if (r === 2) s += String.fromCharCode(0x80 + (next() % 0x780));
      else s += String.fromCharCode(next() % 0x10000);
    }
    expect(Array.from(utf8Bytes(s))).toEqual(Array.from(enc.encode(s)));
  }
});

test('hashF64 writes every NaN as 0x7FF8000000000000', () => {
  const neg = new Float64Array(1);
  new DataView(neg.buffer).setUint32(4, 0xfff80000, true);
  const lit = hex64(hashF64(Float64Array.of(NaN)));
  expect(hex64(hashF64(neg))).toBe(lit);
  expect(hex64(hashF64(Float64Array.of(0 / 0)))).toBe(lit);
  expect(hex64(hashF64(Float64Array.of(-0)))).not.toBe(hex64(hashF64(Float64Array.of(0))));
});

/** Max |flip rate − 0.5| over every (input word, input bit, output bit). */
function avalanche(f: (w: Uint32Array) => number, words: number, n: number, seed: number): number {
  const next = testRng(seed);
  const w = new Uint32Array(words);
  let worst = 0;
  for (let word = 0; word < words; word++) {
    for (let bit = 0; bit < 32; bit++) {
      const counts = new Uint32Array(32);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < words; k++) w[k] = next();
        const a = f(w);
        w[word] = (w[word]! ^ (1 << bit)) >>> 0;
        const d = (f(w) ^ a) >>> 0;
        for (let o = 0; o < 32; o++) counts[o] += (d >>> o) & 1;
      }
      for (let o = 0; o < 32; o++) worst = Math.max(worst, Math.abs(counts[o]! / n - 0.5));
    }
  }
  return worst;
}

describe('avalanche 50 ± 2 %', () => {
  test('fmix32 (100k per bit)', () => {
    expect(avalanche((w) => fmix32(w[0]!), 1, 100000, 21)).toBeLessThanOrEqual(0.02);
  });
  test('hash2 (30k per word and bit)', () => {
    expect(avalanche((w) => hash2(w[0]!, w[1]! | 0, w[2]! | 0), 3, 30000, 22)).toBeLessThanOrEqual(0.02);
  });
  test('hash3 (30k per word and bit)', () => {
    expect(avalanche((w) => hash3(w[0]!, w[1]! | 0, w[2]! | 0, w[3]! | 0), 4, 30000, 23)).toBeLessThanOrEqual(0.02);
  });
  test('hash4 (30k per word and bit)', () => {
    expect(avalanche((w) => hash4(w[0]!, w[1]! | 0, w[2]! | 0, w[3]! | 0), 4, 30000, 24)).toBeLessThanOrEqual(0.02);
  });
});

test('hash2 is not mirrored through the origin (1 ≤ x, z < 2000, seeds 1-4)', () => {
  let equal = 0;
  for (let s = 1; s <= 4; s++) {
    for (let x = 1; x < 2000; x++) for (let z = 1; z < 2000; z++) if (hash2(s, x, z) === hash2(s, -x, -z)) equal++;
  }
  expect(equal).toBe(0);
});

test('corner hashes of [-128, 128)³ collide at the birthday rate', () => {
  const h = new Uint32Array(256 * 256 * 256);
  let i = 0;
  for (let x = -128; x < 128; x++) for (let y = -128; y < 128; y++) for (let z = -128; z < 128; z++) h[i++] = hash3(1, x, y, z);
  h.sort();
  let dup = 0;
  for (let k = 1; k < h.length; k++) if (h[k] === h[k - 1]) dup++;
  expect(Math.abs(dup - 32725)).toBeLessThanOrEqual(543);
});

test('any bit 12-31 of a coordinate changes hash3', () => {
  const next = testRng(31);
  for (let i = 0; i < 2000; i++) {
    const s = next(), c = [next() | 0, next() | 0, next() | 0];
    const base = hash3(s, c[0]!, c[1]!, c[2]!);
    for (let axis = 0; axis < 3; axis++) {
      for (let bit = 12; bit < 32; bit++) {
        const d = c.slice();
        d[axis] = d[axis]! ^ (1 << bit);
        expect(hash3(s, d[0]!, d[1]!, d[2]!)).not.toBe(base);
      }
    }
  }
});

test('deriveSeed is a bijection of world[0] for a fixed name', () => {
  const seen = new Set<number>();
  for (let s = 0; s < 100000; s++) seen.add(deriveSeed([s, 0], 'climate.T'));
  expect(seen.size).toBe(100000);
});

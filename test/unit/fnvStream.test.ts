import { expect, test } from 'vitest';
import { createFnv64, fnv1a64, fnv1a64Bytes, hex64 } from '../../src/core/hash';
import { testRng } from '../harness/stats';

function randomBytes(next: () => number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = next() & 255;
  return b;
}

test('an empty stream digests to the FNV-1a 64 offset basis', () => {
  expect(createFnv64().digest()).toEqual(fnv1a64(''));
  expect(hex64(createFnv64().digest())).toBe('cbf29ce484222325');
});

test('update over random splits equals fnv1a64Bytes over the concatenation (500 strings)', () => {
  const next = testRng(201);
  for (let i = 0; i < 500; i++) {
    const all = randomBytes(next, next() % 300);
    const h = createFnv64();
    let at = 0;
    while (at < all.length) {
      const len = Math.min(all.length - at, next() % 40);
      h.update(all.subarray(at, at + len));
      at += len;
    }
    expect(h.digest()).toEqual(fnv1a64Bytes(all));
  }
});

test('update hashes a subarray view only, not its whole buffer', () => {
  const buf = Uint8Array.of(9, 1, 2, 3, 9);
  const h = createFnv64();
  h.update(buf.subarray(1, 4));
  expect(h.digest()).toEqual(fnv1a64Bytes(Uint8Array.of(1, 2, 3)));
});

test('updateU8, updateU16LE and updateU32LE write little-endian bytes, masked to their width', () => {
  const h = createFnv64();
  h.updateU8(0x1ab);
  h.updateU16LE(0xbeef);
  h.updateU16LE(0x12345);
  h.updateU32LE(0xdeadbeef);
  h.updateU32LE(-1);
  h.updateU16LE(-2);
  const expected = Uint8Array.of(0xab, 0xef, 0xbe, 0x45, 0x23, 0xef, 0xbe, 0xad, 0xde, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff);
  expect(h.digest()).toEqual(fnv1a64Bytes(expected));
});

test('a Uint16Array hashed as bytes equals updateU16LE per value (typed arrays are little-endian)', () => {
  const next = testRng(202);
  const vals = new Uint16Array(4096);
  for (let i = 0; i < vals.length; i++) vals[i] = next() & 0xffff;
  const a = createFnv64();
  a.update(new Uint8Array(vals.buffer, vals.byteOffset, vals.byteLength));
  const b = createFnv64();
  for (let i = 0; i < vals.length; i++) b.updateU16LE(vals[i]!);
  expect(a.digest()).toEqual(b.digest());
});

test('updateRepeatU8 and updateRepeatU16LE equal the expanded bytes (a uniform section)', () => {
  const blocks = new Uint16Array(4096).fill(0x0102);
  const fluid = new Uint8Array(4096).fill(0x08);
  const concat = new Uint8Array(8192 + 4096 + 3);
  concat.set(new Uint8Array(blocks.buffer), 0);
  concat.set(fluid, 8192);
  const h = createFnv64();
  h.updateRepeatU16LE(0x0102, 4096);
  h.updateRepeatU8(0x108, 4096);
  h.updateRepeatU8(0, 3);
  h.updateRepeatU16LE(7, 0);
  expect(h.digest()).toEqual(fnv1a64Bytes(concat));
});

test('digest does not finish the stream: later updates continue it', () => {
  const next = testRng(203);
  const a = randomBytes(next, 100), b = randomBytes(next, 57);
  const h = createFnv64();
  h.update(a);
  const mid = h.digest();
  expect(mid).toEqual(fnv1a64Bytes(a));
  expect(h.digest()).toEqual(mid);
  h.update(b);
  const ab = new Uint8Array(157);
  ab.set(a, 0);
  ab.set(b, 100);
  expect(h.digest()).toEqual(fnv1a64Bytes(ab));
});

test('streams are independent', () => {
  const a = createFnv64(), b = createFnv64();
  a.updateU8(1);
  expect(b.digest()).toEqual(fnv1a64(''));
  expect(a.digest()).toEqual(fnv1a64Bytes(Uint8Array.of(1)));
});

test('updates are chainable', () => {
  const h = createFnv64().updateU8(1).updateU16LE(0x0302).update(Uint8Array.of(4));
  expect(h.digest()).toEqual(fnv1a64Bytes(Uint8Array.of(1, 2, 3, 4)));
});

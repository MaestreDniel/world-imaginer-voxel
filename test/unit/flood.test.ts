import { describe, expect, test } from 'vitest';
import { Xoshiro128 } from '../../src/core/rng';
import { components, components3d } from '../harness/flood';

test('8-connected components with sizes and bounding boxes', () => {
  const rows = ['1100.', '0.0..', '...11', '1...1'];
  const n = 5;
  const mask = new Uint8Array(n * n);
  rows.forEach((r, j) => [...r].forEach((ch, i) => { mask[j * n + i] = ch === '1' ? 1 : 0; }));
  const c = components(mask, n);
  expect(c.count).toBe(3);
  expect(Array.from(c.size).slice(1)).toEqual([2, 3, 1]);
  expect(Array.from(c.bbox.slice(8, 12))).toEqual([3, 2, 4, 3]);
});

test('4-connected components keep a diagonal one-cell strait apart (Z2); the default stays 8', () => {
  const rows = ['11..', '11..', '..11', '..11'];
  const n = 4;
  const mask = new Uint8Array(n * n);
  rows.forEach((r, j) => [...r].forEach((ch, i) => { mask[j * n + i] = ch === '1' ? 1 : 0; }));
  expect(components(mask, n, 4).count).toBe(2);
  expect(components(mask, n, 8).count).toBe(1);
  expect(components(mask, n).count).toBe(1);
});

/** A box of voxel classes, index ((y − yMin)·d + z)·w + x: 0 rock, 1 cave (tagged air), 2 open (untagged air). */
interface Box { readonly w: number; readonly d: number; readonly yMin: number; readonly yMax: number; readonly cls: Uint8Array }

const box = (w: number, d: number, yMin: number, yMax: number): Box => ({ w, d, yMin, yMax, cls: new Uint8Array(w * d * (yMax - yMin + 1)) });
const at = (b: Box, x: number, y: number, z: number): number => ((y - b.yMin) * b.d + z) * b.w + x;
const run3d = (b: Box) => components3d(
  (x, y, z) => b.cls[at(b, x, y, z)] === 1, (x, y, z) => b.cls[at(b, x, y, z)] === 2, b.w, b.d, b.yMin, b.yMax,
);

/** Brute force: a BFS per cave component over the whole box, numbered in index order; the sky flood a BFS from the top. */
function brute3d(b: Box): { label: Int32Array; size: Map<number, number>; sky: Set<number> } {
  const { w, d, cls } = b;
  const plane = w * d;
  const n = cls.length;
  const nbrs = (i: number): number[] => {
    const x = i % w;
    const z = Math.floor(i / w) % d;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < w - 1) out.push(i + 1);
    if (z > 0) out.push(i - w);
    if (z < d - 1) out.push(i + w);
    if (i >= plane) out.push(i - plane);
    if (i + plane < n) out.push(i + plane);
    return out;
  };
  const label = new Int32Array(n);
  const size = new Map<number, number>();
  let next = 1;
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 1 || label[i] !== 0) continue;
    const id = next++;
    label[i] = id;
    const stack = [i];
    let count = 0;
    while (stack.length > 0) {
      const q = stack.pop()!;
      count++;
      for (const t of nbrs(q)) if (cls[t] === 1 && label[t] === 0) { label[t] = id; stack.push(t); }
    }
    size.set(id, count);
  }
  const reached = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = n - plane; i < n; i++) if (cls[i] === 2) { reached[i] = 1; stack.push(i); }
  while (stack.length > 0) {
    const q = stack.pop()!;
    for (const t of nbrs(q)) if (cls[t] === 2 && reached[t] === 0) { reached[t] = 1; stack.push(t); }
  }
  const sky = new Set<number>();
  for (let i = 0; i < n; i++) if (label[i] !== 0 && nbrs(i).some((t) => reached[t] === 1)) sky.add(label[i]!);
  return { label, size, sky };
}

describe('components3d (SP6a spec §10.1, Spec correction 19)', () => {
  test.each([0.3, 0.5, 0.7])('equals a brute-force BFS on random 32 × 64 × 32 fixtures, cave density %f', (density) => {
    const rng = new Xoshiro128(Math.round(density * 1000));
    // y −8 … 55: 64 layers, four 16-block slabs from yMin.
    const b = box(32, 32, -8, 55);
    for (let i = 0; i < b.cls.length; i++) {
      const r = rng.nextFloat();
      b.cls[i] = r < density ? 1 : r < density + (1 - density) / 2 ? 2 : 0;
    }
    const got = run3d(b);
    const want = brute3d(b);
    expect(got.label).toEqual(want.label);
    expect(got.size).toEqual(want.size);
    expect(got.sky).toEqual(want.sky);
    expect(got.size.size).toBeGreaterThan(1);
    expect(got.sky.size).toBeGreaterThan(0);
  });

  test('a tube crossing three slab boundaries is one component; a U whose arms meet only in the top slab is one', () => {
    const b = box(8, 8, -56, 7);
    for (let y = -50; y <= 2; y++) b.cls[at(b, 1, y, 1)] = 1;
    // The U: two arms from y −55 joined at y 0 … 1 (slab 3) only.
    for (let y = -55; y <= 1; y++) { b.cls[at(b, 4, y, 6)] = 1; b.cls[at(b, 7, y, 6)] = 1; }
    for (let x = 4; x <= 7; x++) b.cls[at(b, x, 1, 6)] = 1;
    const c = run3d(b);
    expect(c.size.size).toBe(2);
    expect(c.label[at(b, 1, -50, 1)]).toBe(c.label[at(b, 1, 2, 1)]);
    expect(c.size.get(c.label[at(b, 1, -50, 1)]!)).toBe(53);
    expect(c.label[at(b, 4, -55, 6)]).toBe(c.label[at(b, 7, -55, 6)]);
    expect(c.label[at(b, 4, -55, 6)]).not.toBe(0);
    expect(c.sky.size).toBe(0);
    expect(c).toEqual(brute3d(b));
  });

  test('tagged tubes opening into untagged air above the pre-cave top: each its own sky-connected component (the atmosphere joins none)', () => {
    const b = box(16, 16, -56, 79);
    // Rock to y 40, open air above.
    for (let y = -56; y <= 79; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) b.cls[at(b, x, y, z)] = y > 40 ? 2 : 0;
    const one = (x: number, z: number) => { for (let y = 0; y <= 40; y++) b.cls[at(b, x, y, z)] = 1; };
    one(2, 2);
    let c = run3d(b);
    expect(c.size.size).toBe(1);
    expect([...c.sky]).toEqual([1]);
    one(12, 13);
    c = run3d(b);
    expect(c.size.size).toBe(2);
    expect(c.sky).toEqual(new Set([1, 2]));
    expect(c.label[at(b, 2, 0, 2)]).not.toBe(c.label[at(b, 12, 0, 13)]);
    expect(c).toEqual(brute3d(b));
  });

  test('a tagged pocket sealed by rock is not sky-connected, nor is one opening only into sealed open air', () => {
    const b = box(16, 16, -56, 79);
    for (let y = -56; y <= 79; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) b.cls[at(b, x, y, z)] = y > 40 ? 2 : 0;
    for (let y = -20; y <= -10; y++) for (let x = 3; x <= 6; x++) b.cls[at(b, x, y, 5)] = 1;
    // A second pocket beside an untagged air bubble, both sealed.
    for (let y = 10; y <= 12; y++) { b.cls[at(b, 10, y, 10)] = 1; b.cls[at(b, 11, y, 10)] = 2; }
    const c = run3d(b);
    expect(c.size.size).toBe(2);
    expect(c.sky.size).toBe(0);
    expect(c).toEqual(brute3d(b));
  });

  test('rejects an empty box or a reversed y range', () => {
    const f = () => false;
    expect(() => components3d(f, f, 0, 4, 0, 3)).toThrow(RangeError);
    expect(() => components3d(f, f, 4, 4, 3, 2)).toThrow(RangeError);
    expect(() => components3d(f, f, 4, 1.5, 0, 3)).toThrow(RangeError);
  });
});

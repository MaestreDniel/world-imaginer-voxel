import { expect, test } from 'vitest';
import { components } from '../harness/flood';

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

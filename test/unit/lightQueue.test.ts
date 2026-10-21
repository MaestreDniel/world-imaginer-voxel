/**
 * `light/queue.ts` (SP4a spec §4.2 step 3): the light job's Int32 ring of voxel indices — FIFO order through a wrap,
 * `length`, `clear`, and the overflow throw.
 */
import { describe, expect, test } from 'vitest';
import { createLightQueue } from '../../src/light/queue';

describe('createLightQueue (SP4a spec §4.2)', () => {
  test('FIFO order through a wrap, with length', () => {
    const q = createLightQueue(4);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.length).toBe(3);
    expect(q.pop()).toBe(1);
    expect(q.pop()).toBe(2);
    expect(q.length).toBe(1);
    // The ring's head is at slot 2 and its tail at slot 3: these pushes wrap past the end.
    q.push(4);
    q.push(5);
    q.push(6);
    expect(q.length).toBe(4);
    expect([q.pop(), q.pop(), q.pop(), q.pop()]).toEqual([3, 4, 5, 6]);
    expect(q.length).toBe(0);
  });

  test('holds Int32 voxel indices, the largest light-region index included', () => {
    const q = createLightQueue(2);
    q.push(812543);
    q.push(0);
    expect([q.pop(), q.pop()]).toEqual([812543, 0]);
  });

  test('push throws on overflow, and the queue is unchanged', () => {
    const q = createLightQueue(4);
    for (let i = 0; i < 4; i++) q.push(10 + i);
    expect(() => q.push(99)).toThrow(/overflow/);
    expect(q.length).toBe(4);
    expect([q.pop(), q.pop(), q.pop(), q.pop()]).toEqual([10, 11, 12, 13]);
  });

  test('pop on an empty queue throws', () => {
    expect(() => createLightQueue(4).pop()).toThrow(/empty/);
  });

  test('clear empties the queue, which is then reusable', () => {
    const q = createLightQueue(4);
    q.push(1);
    q.push(2);
    q.pop();
    q.clear();
    expect(q.length).toBe(0);
    for (let i = 0; i < 4; i++) q.push(i);
    expect([q.pop(), q.pop(), q.pop(), q.pop()]).toEqual([0, 1, 2, 3]);
  });

  test('the capacity must be a positive power of two', () => {
    for (const c of [0, 3, 6, -4, 2.5]) expect(() => createLightQueue(c), String(c)).toThrow(RangeError);
    expect(createLightQueue(1).length).toBe(0);
  });
});

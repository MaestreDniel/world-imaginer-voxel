import { describe, expect, test } from 'vitest';
import { createJobHeap } from '../../src/engine/jobHeap';

/** A 32-bit LCG in [0, 1) (Numerical Recipes constants), so every run draws the same sequences. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Item { readonly priority: number; readonly id: number }
const byKey = (a: Item, b: Item) => a.priority - b.priority || a.id - b.id;

describe('jobHeap (SP4c spec §6.1)', () => {
  test('pops in (priority, id) order over 200 randomised sequences of pushes and pops (LCG 4242)', () => {
    const rnd = lcg(4242);
    // The aux lane's priorities: points and probes −1, landing and spawn −2, tiles 0 … 1100, stats and slices 500, spawn 600.
    const priorities = [-2, -1, 0, 1, 2, 3, 7, 500, 600, 1000, 1003];
    for (let seq = 0; seq < 200; seq++) {
      const heap = createJobHeap<Item>(4);
      const model: Item[] = [];
      let nextId = 1;
      const steps = 20 + Math.floor(rnd() * 80);
      for (let k = 0; k < steps; k++) {
        if (rnd() < 0.6) {
          const item = { priority: priorities[Math.floor(rnd() * priorities.length)]!, id: nextId++ };
          heap.push(item, item.priority, item.id);
          model.push(item);
        } else {
          model.sort(byKey);
          const want = model.shift();
          expect(heap.peek()).toBe(want);
          expect(heap.pop()).toBe(want);
        }
        expect(heap.size).toBe(model.length);
      }
      model.sort(byKey);
      const rest: Item[] = [];
      for (let item = heap.pop(); item !== undefined; item = heap.pop()) rest.push(item);
      expect(rest).toEqual(model);
      expect([heap.size, heap.peek(), heap.pop()]).toEqual([0, undefined, undefined]);
    }
  });

  test('grows past its capacity', () => {
    const heap = createJobHeap<number>(2);
    // Pushed in reverse so every push sifts to the top.
    for (let i = 99; i >= 0; i--) heap.push(i, i % 10, i);
    expect(heap.size).toBe(100);
    const out: number[] = [];
    for (let v = heap.pop(); v !== undefined; v = heap.pop()) out.push(v);
    const want = Array.from({ length: 100 }, (_, i) => i).sort((a, b) => (a % 10) - (b % 10) || a - b);
    expect(out).toEqual(want);
    // The freed slots are reused.
    for (let i = 0; i < 300; i++) heap.push(i, -i, i);
    expect([heap.size, heap.peek()]).toEqual([300, 299]);
  });

  test('`removeWhere` returns the removed items and keeps the order of the rest', () => {
    const rnd = lcg(4242);
    const heap = createJobHeap<Item>(8);
    const all: Item[] = [];
    for (let id = 1; id <= 60; id++) {
      const item = { priority: Math.floor(rnd() * 12) - 2, id };
      heap.push(item, item.priority, item.id);
      all.push(item);
    }
    const drop = (it: Item) => it.id % 3 === 0 || it.priority === 4;
    const removed = heap.removeWhere(drop);
    // In (priority, id) order, as the pool rejects them.
    expect(removed).toEqual(all.filter(drop).sort(byKey));
    expect(heap.size).toBe(all.length - removed.length);
    expect(heap.removeWhere(() => false)).toEqual([]);
    const rest: Item[] = [];
    for (let item = heap.pop(); item !== undefined; item = heap.pop()) rest.push(item);
    expect(rest).toEqual(all.filter((it) => !drop(it)).sort(byKey));
  });

  test('a `removeWhere` predicate that throws leaves the heap whole', () => {
    const heap = createJobHeap<Item>(4);
    const all = Array.from({ length: 12 }, (_, i) => ({ priority: (i * 7) % 5, id: i }));
    for (const it of all) heap.push(it, it.priority, it.id);
    let seen = 0;
    expect(() => heap.removeWhere((it) => { if (++seen === 6) throw new Error('boom'); return it.id % 2 === 0; })).toThrow('boom');
    expect(heap.size).toBe(12);
    const rest: Item[] = [];
    for (let item = heap.pop(); item !== undefined; item = heap.pop()) rest.push(item);
    expect(rest).toEqual([...all].sort(byKey));
  });

  test('`clear` empties the heap and returns every item in (priority, id) order', () => {
    const heap = createJobHeap<Item>();
    const items = [{ priority: 3, id: 1 }, { priority: -1, id: 2 }, { priority: 3, id: 0 }, { priority: 500, id: 4 }];
    for (const it of items) heap.push(it, it.priority, it.id);
    expect(heap.clear()).toEqual([...items].sort(byKey));
    expect([heap.size, heap.pop(), heap.clear()]).toEqual([0, undefined, []]);
  });
});

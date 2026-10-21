import { describe, expect, test } from 'vitest';
import { createUploadBudget } from '../../src/engine/uploadBudget';

describe('createUploadBudget (SP4a spec §6.2)', () => {
  test('exhausted() is false before 12 ms and true at 12 ms', () => {
    let t = 1000;
    const b = createUploadBudget(12, () => t);
    b.start();
    expect(b.exhausted()).toBe(false);
    t += 11.99;
    expect(b.exhausted()).toBe(false);
    t = 1012;
    expect(b.exhausted()).toBe(true);
    t += 5;
    expect(b.exhausted()).toBe(true);
  });

  test('start() opens a new window each frame; before the first start nothing may run', () => {
    let t = 0;
    const b = createUploadBudget(12, () => t);
    expect(b.exhausted()).toBe(true);
    b.start();
    t = 20;
    expect(b.exhausted()).toBe(true);
    b.start();
    expect(b.exhausted()).toBe(false);
    t = 31;
    expect(b.exhausted()).toBe(false);
    t = 32;
    expect(b.exhausted()).toBe(true);
  });
});

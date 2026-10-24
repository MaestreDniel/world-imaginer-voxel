import { describe, expect, test } from 'vitest';
import { createUploadBudget } from '../../src/engine/uploadBudget';

describe('createUploadBudget (SP4b spec §3.9; SP4a spec §6.2)', () => {
  test('exhausted() is false before 12 ms and true at 12 ms', () => {
    let t = 1000;
    const b = createUploadBudget(12, Infinity, () => t);
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
    const b = createUploadBudget(12, Infinity, () => t);
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

  test('(2, 32): spend(31) is not exhausted, spend(1) is; the time exhausts it at 2 ms', () => {
    let t = 100;
    const b = createUploadBudget(2, 32, () => t);
    b.start();
    b.spend(31);
    expect(b.exhausted()).toBe(false);
    expect(b.rowsSpent()).toBe(31);
    b.spend(1);
    expect(b.exhausted()).toBe(true);
    expect(b.rowsSpent()).toBe(32);
    b.start();
    expect(b.rowsSpent()).toBe(0);
    expect(b.exhausted()).toBe(false);
    t = 101.99;
    expect(b.exhausted()).toBe(false);
    t = 102;
    expect(b.exhausted()).toBe(true);
  });

  test('(2, 32): structural() is granted once per frame and only while no row was spent; a new start() grants again', () => {
    let t = 0;
    const b = createUploadBudget(2, 32, () => t);
    expect(b.structural(), 'nothing before the first start').toBe(false);
    b.start();
    expect(b.structural()).toBe(true);
    expect(b.structural()).toBe(false);
    b.start();
    b.spend(1);
    expect(b.structural(), 'a row was spent this frame').toBe(false);
    b.start();
    expect(b.structural()).toBe(true);
    b.start();
    t = 2;
    expect(b.structural(), 'the time is up').toBe(false);
  });

  test('(12, Infinity), the loading screen\'s mode: never row-exhausted, structural() granted on every call while under 12 ms', () => {
    let t = 0;
    const b = createUploadBudget(12, Infinity, () => t);
    b.start();
    b.spend(1_000_000);
    expect(b.exhausted()).toBe(false);
    for (let i = 0; i < 100; i++) expect(b.structural()).toBe(true);
    t = 11.99;
    expect(b.structural()).toBe(true);
    t = 12;
    expect(b.exhausted()).toBe(true);
    expect(b.structural()).toBe(false);
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDisposers } from '../../src/ui/common/disposers';

describe('createDisposers (SP4c spec §1.2)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('runs every disposer once, in reverse order of `add`', () => {
    const d = createDisposers();
    const ran: string[] = [];
    d.add(() => ran.push('a'));
    d.add(() => ran.push('b'));
    d.add(() => ran.push('c'));
    expect(ran).toEqual([]);
    d.dispose();
    expect(ran).toEqual(['c', 'b', 'a']);
  });

  test('a second dispose runs nothing', () => {
    const d = createDisposers();
    let runs = 0;
    d.add(() => { runs++; });
    d.dispose();
    d.dispose();
    expect(runs).toBe(1);
  });

  test('a disposer that throws does not stop the others, and the throw is reported', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = createDisposers();
    const ran: string[] = [];
    const boom = new Error('boom');
    d.add(() => ran.push('a'));
    d.add(() => { throw boom; });
    d.add(() => ran.push('c'));
    expect(() => d.dispose()).not.toThrow();
    expect(ran).toEqual(['c', 'a']);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]).toContain(boom);
  });

  test('an `add` after dispose runs at once', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = createDisposers();
    d.dispose();
    const ran: string[] = [];
    d.add(() => ran.push('late'));
    expect(ran).toEqual(['late']);
    d.add(() => { throw new Error('late boom'); });
    expect(errors).toHaveBeenCalledTimes(1);
    d.dispose();
    expect(ran).toEqual(['late']);
  });
});

import { describe, expect, test } from 'vitest';
import { createFloatingOrigin, firstOrigin } from '../../src/render/floatingOrigin';

describe('floating origin (SP4a spec §6.8, master §2.1)', () => {
  test('a start at (500,000, 70, −500,000) snaps to (499,712, 0, −499,712)', () => {
    const o = createFloatingOrigin(500_000, 70, -500_000);
    expect([o.x, o.y, o.z]).toEqual([499_712, 0, -499_712]);
  });

  test('firstOrigin of spawn (1,100, −700) is (1,024, 0, −512) (SP4b spec §3.4)', () => {
    const o = firstOrigin({ x: 1100, z: -700 });
    expect([o.x, o.y, o.z]).toEqual([1024, 0, -512]);
    // It is a floating origin like any other: no rebase within 1,024 blocks of it.
    expect(o.update(2048, 70, -1536)).toBe(false);
    expect(o.update(2049, 70, -512)).toBe(true);
  });

  test('the snap rounds toward zero and never gives −0 (ruling P39)', () => {
    const o = createFloatingOrigin(0, -64, -100);
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
    expect(o.z).toBe(0);
    const n = createFloatingOrigin(-511, -513, 1023);
    expect([n.x, n.y, n.z]).toEqual([0, -512, 512]);
    expect(Object.is(n.x, -0)).toBe(false);
  });

  test('no rebase within 1,024 blocks on every axis', () => {
    const o = createFloatingOrigin(0, 0, 0);
    expect(o.update(1024, 0, 0)).toBe(false);
    expect(o.update(-1024, 1024, -1024)).toBe(false);
    expect(o.update(1000.5, -1023.9, 512)).toBe(false);
    expect([o.x, o.y, o.z]).toEqual([0, 0, 0]);
  });

  test('a rebase at 1,025 re-snaps every axis to the camera', () => {
    const o = createFloatingOrigin(0, 0, 0);
    expect(o.update(1025, 70, -300)).toBe(true);
    expect([o.x, o.y, o.z]).toEqual([1024, 0, 0]);
    // The new origin is the reference from now on.
    expect(o.update(2048, 70, -300)).toBe(false);
    expect(o.update(1024, 70, -1024)).toBe(false);
    expect(o.update(1024, 70, -1050)).toBe(true);
    expect([o.x, o.y, o.z]).toEqual([1024, 0, -1024]);
    const far = createFloatingOrigin(0, 0, 0);
    expect(far.update(500_000, 70, -500_000)).toBe(true);
    expect([far.x, far.y, far.z]).toEqual([499_712, 0, -499_712]);
  });

  test('two points 1 block apart at ±500,000 stay exactly 1 apart after rebasing (float32)', () => {
    for (const [cx, cz] of [[500_000.1, -500_000.1], [-500_000.1, 500_000.1]] as const) {
      const o = createFloatingOrigin(0, 0, 0);
      expect(o.update(cx, 70.3, cz)).toBe(true);
      // Positions relative to the origin, as the GPU sees them (float32).
      const rel = (v: number, origin: number): number => Math.fround(v - origin);
      expect(rel(cx + 1, o.x) - rel(cx, o.x)).toBe(1);
      expect(rel(cz + 1, o.z) - rel(cz, o.z)).toBe(1);
      expect(rel(71.3, o.y) - rel(70.3, o.y)).toBe(1);
      expect(Math.abs(rel(cx, o.x))).toBeLessThan(512);
      expect(Math.abs(rel(cz, o.z))).toBeLessThan(512);
    }
  });
});

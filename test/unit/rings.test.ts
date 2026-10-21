import { describe, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz, torusSlot } from '../../src/core/coords';
import { RING_EXTRA, assertTorusSafe, discOffsets, neededSets, type Stage } from '../../src/engine/rings';

const STAGES: readonly Stage[] = ['T', 'D', 'L', 'MESH'];

describe('discOffsets (SP4a spec §2.1)', () => {
  test('the integer discs hold 489 / 577 / 665 / 749 columns, within 1 % of π(r + 0.5)² (master 491 / 573 / 660 / 755)', () => {
    const exact: Record<number, number> = { 12: 489, 13: 577, 14: 665, 15: 749 };
    const master: Record<number, number> = { 12: 491, 13: 573, 14: 660, 15: 755 };
    for (const r of [12, 13, 14, 15]) {
      const n = discOffsets(r).length;
      expect(n).toBe(exact[r]);
      const area = Math.PI * (r + 0.5) ** 2;
      expect(Math.abs(n - area) / area).toBeLessThan(0.01);
      expect(Math.abs(n - master[r]!) / master[r]!).toBeLessThan(0.01);
    }
  });

  test('every offset satisfies dx² + dz² ≤ (r + 0.5)², each once, and the spiral order is non-decreasing in d²', () => {
    for (let r = 0; r <= 16; r++) {
      const offs = discOffsets(r);
      const seen = new Set<number>();
      let last = -1;
      for (const [dx, dz] of offs) {
        const d2 = dx * dx + dz * dz;
        expect(d2).toBeLessThanOrEqual((r + 0.5) ** 2);
        expect(d2).toBeGreaterThanOrEqual(last);
        last = d2;
        seen.add(colKey(dx, dz));
      }
      expect(seen.size).toBe(offs.length);
    }
    expect(discOffsets(12)[0]).toEqual([0, 0]);
    expect(discOffsets(12)).toBe(discOffsets(12));
  });
});

describe('neededSets (ruling P34)', () => {
  test('at rd 12 the sets hold MESH 489, L 593, D 705, T 825 columns; MESH is the disc', () => {
    const s = neededSets(0, 0, 12);
    expect({ T: s.T.size, D: s.D.size, L: s.L.size, MESH: s.MESH.size }).toEqual({ T: 825, D: 705, L: 593, MESH: 489 });
    expect([...s.MESH].sort()).toEqual(discOffsets(12).map(([dx, dz]) => colKey(dx, dz)).sort());
  });

  test('for every rd in 4..16 each MESH column\'s 3 × 3 lies in L, each L column\'s in D and each D column\'s in T', () => {
    for (let rd = 4; rd <= 16; rd++) {
      const s = neededSets(5, -7, rd);
      const pairs: ReadonlyArray<readonly [Stage, Stage]> = [['MESH', 'L'], ['L', 'D'], ['D', 'T']];
      for (const [inner, outer] of pairs) {
        for (const k of s[inner]) {
          const cx = colKeyCx(k);
          const cz = colKeyCz(k);
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) expect(s[outer].has(colKey(cx + dx, cz + dz))).toBe(true);
          }
        }
      }
    }
  });

  test('the T set\'s furthest |dx| or |dz| is rd + 3 (RING_EXTRA), and each stage reaches rd + its extra', () => {
    for (let rd = 4; rd <= 16; rd++) {
      const s = neededSets(0, 0, rd);
      for (const st of STAGES) {
        let far = 0;
        for (const k of s[st]) far = Math.max(far, Math.abs(colKeyCx(k)), Math.abs(colKeyCz(k)));
        expect(far).toBe(rd + RING_EXTRA[st]);
      }
    }
    expect(RING_EXTRA).toEqual({ T: 3, D: 2, L: 1, MESH: 0 });
  });

  test('the sets are around the centre column', () => {
    const a = neededSets(0, 0, 6);
    const b = neededSets(100, -40, 6);
    expect([...b.T].map((k) => colKey(colKeyCx(k) - 100, colKeyCz(k) + 40)).sort()).toEqual([...a.T].sort());
  });
});

describe('assertTorusSafe (SP4a spec §2.1, D3)', () => {
  test('rd 16 passes and rd 29 throws', () => {
    expect(() => assertTorusSafe(16)).not.toThrow();
    expect(() => assertTorusSafe(28)).not.toThrow();
    expect(() => assertTorusSafe(29)).toThrow(/torus/);
  });

  test('no two colKeys of the T set at rd 16 share a torus record', () => {
    for (const [cx, cz] of [[0, 0], [31, -33], [-1000, 517]] as const) {
      const slots = new Set<number>();
      const t = neededSets(cx, cz, 16).T;
      for (const k of t) slots.add(torusSlot(colKeyCx(k), colKeyCz(k)));
      expect(slots.size).toBe(t.size);
    }
  });
});

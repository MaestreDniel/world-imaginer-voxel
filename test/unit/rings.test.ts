import { describe, expect, test } from 'vitest';
import { colKey, colKeyCx, colKeyCz, torusSlot } from '../../src/core/coords';
import {
  KEEP_MESH_EXTRA, KEEP_VOXELS_EXTRA, M_D, M_KEEP_MESH, M_KEEP_VOXELS, M_L, M_MESH, M_PROTO_RING, M_T, RING_EXTRA, assertTorusSafe,
  discOffsets, membershipTable, neededSets, stageOffsets, type Stage,
} from '../../src/engine/rings';

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

/** The flag counts of a membership table, and its side. */
function tableCounts(rd: number): { side: number; counts: Record<number, number> } {
  const t = membershipTable(rd);
  const side = 2 * (rd + 5) + 1;
  const counts: Record<number, number> = {};
  for (const f of [M_MESH, M_L, M_D, M_T, M_KEEP_MESH, M_KEEP_VOXELS, M_PROTO_RING]) {
    let n = 0;
    for (const b of t) if ((b & f) !== 0) n++;
    counts[f] = n;
  }
  return { side, counts };
}

describe('membershipTable (SP4b spec §3.2)', () => {
  test('the flags and the retained extras', () => {
    expect([M_MESH, M_L, M_D, M_T, M_KEEP_MESH, M_KEEP_VOXELS, M_PROTO_RING]).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect([KEEP_MESH_EXTRA, KEEP_VOXELS_EXTRA]).toEqual([1, 5]);
  });

  test('for every rd in [4, 16] the stage counts equal stageOffsets\' and keepMesh / keepVoxels equal discOffsets(rd + 1) / (rd + 5)', () => {
    for (let rd = 4; rd <= 16; rd++) {
      const { side, counts } = tableCounts(rd);
      const offs = stageOffsets(rd);
      expect(membershipTable(rd).length).toBe(side * side);
      expect(counts[M_MESH], `rd ${rd} MESH`).toBe(offs.MESH.length);
      expect(counts[M_L], `rd ${rd} L`).toBe(offs.L.length);
      expect(counts[M_D], `rd ${rd} D`).toBe(offs.D.length);
      expect(counts[M_T], `rd ${rd} T`).toBe(offs.T.length);
      expect(counts[M_KEEP_MESH], `rd ${rd} keepMesh`).toBe(discOffsets(rd + 1).length);
      expect(counts[M_KEEP_VOXELS], `rd ${rd} keepVoxels`).toBe(discOffsets(rd + 5).length);
      expect(counts[M_PROTO_RING], `rd ${rd} protoRing`).toBe(offs.T.length - offs.L.length);
    }
  });

  test('each stage flag sits on its stage\'s offsets at (dz + R)·side + (dx + R); MESH ⊂ keepMesh, T ⊂ keepVoxels, protoRing = T and not L', () => {
    for (let rd = 4; rd <= 16; rd++) {
      const t = membershipTable(rd);
      const R = rd + 5;
      const side = 2 * R + 1;
      const offs = stageOffsets(rd);
      const pairs: ReadonlyArray<readonly [Stage, number]> = [['MESH', M_MESH], ['L', M_L], ['D', M_D], ['T', M_T]];
      for (const [st, f] of pairs) for (const [dx, dz] of offs[st]) expect(t[(dz + R) * side + (dx + R)]! & f).toBe(f);
      for (const b of t) {
        if ((b & M_MESH) !== 0) expect(b & M_KEEP_MESH).toBe(M_KEEP_MESH);
        if ((b & M_T) !== 0) expect(b & M_KEEP_VOXELS).toBe(M_KEEP_VOXELS);
        expect((b & M_PROTO_RING) !== 0).toBe((b & M_T) !== 0 && (b & M_L) === 0);
      }
    }
  });

  test('pinned: rd 4 keepMesh 97, keepVoxels 293, protoRing 104; rd 12 keepMesh 577, keepVoxels 973, protoRing 232; rd 16 keepVoxels 1,457 and side 43', () => {
    const r4 = tableCounts(4).counts;
    expect([r4[M_KEEP_MESH], r4[M_KEEP_VOXELS], r4[M_PROTO_RING]]).toEqual([97, 293, 104]);
    const r12 = tableCounts(12).counts;
    expect([r12[M_KEEP_MESH], r12[M_KEEP_VOXELS], r12[M_PROTO_RING]]).toEqual([577, 973, 232]);
    const r16 = tableCounts(16);
    expect(r16.counts[M_KEEP_VOXELS]).toBe(1457);
    expect(r16.side).toBe(43);
    expect(membershipTable(16).length).toBe(43 * 43);
  });

  test('cached per rd', () => {
    expect(membershipTable(12)).toBe(membershipTable(12));
    expect(membershipTable(12)).not.toBe(membershipTable(13));
  });
});

describe('assertTorusSafe (SP4b spec §3.2; SP4a spec §2.1, D3)', () => {
  test('rd 26 passes and rd 27 throws (2·(rd + 5) + 1 ≤ 64)', () => {
    expect(() => assertTorusSafe(16)).not.toThrow();
    expect(() => assertTorusSafe(26)).not.toThrow();
    expect(() => assertTorusSafe(27)).toThrow(/torus/);
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

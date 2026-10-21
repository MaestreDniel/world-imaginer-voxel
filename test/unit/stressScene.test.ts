import { describe, expect, test } from 'vitest';
import { MESH_PASS_OPAQUE, MESH_PASS_TRANSLUCENT, payloadProblem, ROW_INTS, type ColumnMeshPayload } from '../../src/mesh/column';
import { PACK_LAYOUT, unpackFluid, unpackSolid } from '../../src/mesh/packing';
import { stressPayloads } from '../../src/render/spike/stressScene';
import { REGISTRY } from '../../src/world/blocks/index';

const payloads = stressPayloads();
const quadsOf = (p: ColumnMeshPayload): number => p.index.length / 6;
const rowsOf = (p: ColumnMeshPayload): number[][] =>
  Array.from({ length: p.rows.length / ROW_INTS }, (_, r) => Array.from(p.rows.subarray(r * ROW_INTS, (r + 1) * ROW_INTS)));

describe('the stress scene (SP4a spec §1.1, ruling P21)', () => {
  test('489 columns, the RD12 disc around (0, 0), each payload valid', () => {
    expect(payloads).toHaveLength(489);
    const keys = new Set(payloads.map((p) => `${p.cx},${p.cz}`));
    expect(keys.size).toBe(489);
    for (const p of payloads) {
      expect(p.cx * p.cx + p.cz * p.cz).toBeLessThanOrEqual(12.5 * 12.5);
      expect(payloadProblem(p), `(${p.cx}, ${p.cz})`).toBeNull();
    }
  });

  test('instance count 3,000-4,000; total quads 0.70-0.80 M; column median 1,400-1,600', () => {
    const instances = payloads.reduce((n, p) => n + p.rows.length / ROW_INTS, 0);
    expect(instances).toBeGreaterThanOrEqual(3000);
    expect(instances).toBeLessThanOrEqual(4000);
    const quads = payloads.map(quadsOf);
    const total = quads.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(700_000);
    expect(total).toBeLessThanOrEqual(800_000);
    const sorted = [...quads].sort((a, b) => a - b);
    const median = (sorted[244]!);
    expect(median).toBeGreaterThanOrEqual(1400);
    expect(median).toBeLessThanOrEqual(1600);
  });

  test('every column has 6-8 distinct non-trivial sy within 3-10, one opaque row each', () => {
    for (const p of payloads) {
      const opaque = rowsOf(p).filter((r) => r[1] === MESH_PASS_OPAQUE).map((r) => r[0]!);
      expect(new Set(opaque).size).toBe(opaque.length);
      expect(opaque.length).toBeGreaterThanOrEqual(6);
      expect(opaque.length).toBeLessThanOrEqual(8);
      for (const sy of opaque) {
        expect(sy).toBeGreaterThanOrEqual(3);
        expect(sy).toBeLessThanOrEqual(10);
      }
    }
  });

  test('water rows (pass 2) on 25-35 % of the columns, inside one of the column\'s non-trivial sections', () => {
    let withWater = 0;
    for (const p of payloads) {
      const rows = rowsOf(p);
      const water = rows.filter((r) => r[1] === MESH_PASS_TRANSLUCENT);
      expect(water.length).toBeLessThanOrEqual(1);
      if (water.length === 0) continue;
      withWater++;
      expect(rows.some((r) => r[1] === MESH_PASS_OPAQUE && r[0] === water[0]![0])).toBe(true);
    }
    expect(withWater / payloads.length).toBeGreaterThanOrEqual(0.25);
    expect(withWater / payloads.length).toBeLessThanOrEqual(0.35);
  });

  test('quads of mixed sizes 1-16 blocks; every position within the section', () => {
    const sizes = new Set<number>();
    const bad: string[] = [];
    for (const p of payloads.slice(0, 40)) {
      for (let q = 0; q < p.position.length / 16; q++) {
        const xs: number[] = [];
        const ys: number[] = [];
        const zs: number[] = [];
        for (let k = 0; k < 4; k++) {
          xs.push(p.position[16 * q + 4 * k]!);
          ys.push(p.position[16 * q + 4 * k + 1]!);
          zs.push(p.position[16 * q + 4 * k + 2]!);
        }
        if (Math.max(...xs, ...ys, ...zs) > 128) bad.push(`(${p.cx}, ${p.cz}) quad ${q} leaves the section`);
        const extents = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)]
          .filter((e) => e > 0);
        if (extents.length !== 2 || extents.some((e) => e % 8 !== 0)) bad.push(`(${p.cx}, ${p.cz}) quad ${q} extents ${extents}`);
        for (const e of extents) sizes.add(e / 8);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(Math.min(...sizes)).toBe(1);
    expect(Math.max(...sizes)).toBe(16);
    expect(sizes.size).toBeGreaterThanOrEqual(12);
  });

  test('every packed field is exercised; layers are real non-air states', () => {
    const solid = new Map<string, Set<number>>();
    const fluid = new Map<string, Set<number>>();
    const note = (m: Map<string, Set<number>>, f: Record<string, number>) => {
      for (const [k, v] of Object.entries(f)) {
        if (!m.has(k)) m.set(k, new Set());
        m.get(k)!.add(v);
      }
    };
    for (const p of payloads) {
      for (const r of rowsOf(p)) {
        const [, pass, vs, vc] = r as [number, number, number, number];
        for (let v = vs; v < vs + vc; v++) {
          if (pass === MESH_PASS_TRANSLUCENT) note(fluid, { ...unpackFluid(p.data[v]!) });
          else note(solid, { ...unpackSolid(p.data[v]!) });
        }
      }
    }
    // Small fields take every value; layer spans many real states.
    for (const k of ['face', 'ao', 'sky', 'block', 'tint', 'flags'] as const) {
      const all = k === 'face' ? 6 : 2 ** PACK_LAYOUT.solid[k].bits;
      expect(solid.get(k)!.size, `solid ${k}`).toBe(all);
    }
    for (const k of ['face', 'sky', 'block', 'depth', 'tint'] as const) {
      const all = k === 'face' ? 6 : 2 ** PACK_LAYOUT.fluid[k].bits;
      expect(fluid.get(k)!.size, `fluid ${k}`).toBe(all);
    }
    expect([...fluid.get('cornerDrop')!].sort()).toEqual([0, 1]);
    const layers = [...solid.get('layer')!];
    expect(layers.length).toBeGreaterThanOrEqual(10);
    for (const l of layers) {
      expect(l).toBeGreaterThan(0);
      expect(l).toBeLessThan(REGISTRY.stateCount);
    }
  });

  test('each row\'s sphere contains its vertices', () => {
    // One assertion over the worst excess: 2.9 M vertices are too many for one expect each.
    let worst = Number.NEGATIVE_INFINITY;
    let where = '';
    for (const p of payloads) {
      rowsOf(p).forEach(([, , vs, vc], r) => {
        const [sx, sy, sz, sr] = Array.from(p.spheres.subarray(4 * r, 4 * r + 4)) as [number, number, number, number];
        for (let v = vs!; v < vs! + vc!; v++) {
          const excess = Math.hypot(p.position[4 * v]! / 8 - sx, p.position[4 * v + 1]! / 8 - sy, p.position[4 * v + 2]! / 8 - sz) - sr;
          if (excess > worst) {
            worst = excess;
            where = `(${p.cx}, ${p.cz}) row ${r} vertex ${v}`;
          }
        }
      });
    }
    expect(worst, where).toBeLessThanOrEqual(1e-6);
  });

  test('the same seed gives byte-equal payloads; another seed differs', () => {
    const again = stressPayloads();
    const other = stressPayloads(2);
    const bytes = (ps: readonly ColumnMeshPayload[]) =>
      ps.flatMap((p) => [p.versions, p.connectivity, p.position, p.data, p.index, p.rows, p.spheres]
        .map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
    const a = bytes(payloads);
    const b = bytes(again);
    expect(a.length).toBe(b.length);
    expect(a.every((x, i) => x.equals(b[i]!))).toBe(true);
    expect(payloads.map((p) => `${p.cx},${p.cz}`)).toEqual(again.map((p) => `${p.cx},${p.cz}`));
    const c = bytes(other);
    expect(a.every((x, i) => x.equals(c[i]!))).toBe(false);
  });
});

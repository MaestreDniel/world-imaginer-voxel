/**
 * `world/store/padded.ts` (SP4a spec §4.3, §5.1): the 18³ mesh section and the 46 × 384 × 46 light region, copied
 * from a hand-built shared store whose 3 × 3 columns mix uniform and dense sections in every channel, checked
 * against per-voxel `final()` reads.
 */
import { describe, expect, test } from 'vitest';
import { AIR, BEDROCK } from '../../src/world/blocks/index';
import { SECTIONS } from '../../src/world/store/columnTable';
import {
  copyLightRegion, copyPaddedSection, createLightRegion, createPaddedSection, LIGHT_H, LIGHT_LO, LIGHT_W, lightIndex, PAD,
  PAD_VOXELS, padIndex,
} from '../../src/world/store/padded';
import { createStore, type VoxelStore } from '../../src/world/store/store';

const MiB = 1 << 20;
const CX = 5;
const CZ = -3;
/** Neighbour k = (dz + 1)·3 + (dx + 1). */
const K = (dx: number, dz: number) => (dz + 1) * 3 + (dx + 1);

/** Section content per (column k, sy, channel): uniform on some, dense (a per-voxel pattern) on the others. */
function words(k: number, sy: number): Uint16Array {
  const a = new Uint16Array(4096);
  if ((k + sy) % 3 === 0) return a.fill((k * 7 + sy) % 25);
  for (let i = 0; i < 4096; i++) a[i] = (i * 13 + k * 5 + sy * 3) % 25;
  return a;
}
function lights(k: number, sy: number): Uint8Array {
  const a = new Uint8Array(4096);
  if ((k + sy) % 4 === 1) return a.fill(sy >= 20 ? 0xF0 : (k * 17 + sy) & 0xFF);
  for (let i = 0; i < 4096; i++) a[i] = (i * 7 + k * 11 + sy * 19) & 0xFF;
  return a;
}
function fluids(k: number, sy: number): Uint8Array {
  const a = new Uint8Array(4096);
  if ((k + sy) % 2 === 0) return a.fill((k + sy) % 5 === 0 ? 0x10 : 0);
  for (let i = 0; i < 4096; i++) a[i] = (i + k + sy) % 3 === 0 ? 0x10 + ((i + k) & 7) : 0;
  return a;
}

/** The 3 × 3 around (CX, CZ), each column Published with its final set and aux A's lightBlocking written. */
function buildStore(): VoxelStore {
  const s = createStore({ shared: true, maxBlockBytes: 32 * MiB, maxByteBytes: 32 * MiB });
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const k = K(dx, dz);
      const w = s.claimColumn(CX + dx, CZ + dz, 0);
      for (let sy = 0; sy < SECTIONS; sy++) w.setFinal(sy, words(k, sy), lights(k, sy), fluids(k, sy));
      const lb = w.aux().lightBlocking;
      for (let i = 0; i < 256; i++) lb[i] = ((k * 31 + i * 5) % 384) - 64;
      w.commit(3);
    }
  }
  return s;
}

/** The column offset and local coordinate of a coordinate relative to the centre column's origin. */
const split = (v: number): [number, number] => {
  const d = v < 0 ? -1 : v > 15 ? 1 : 0;
  return [d, v - 16 * d];
};

/** The expected (block, light, fluid) at column-local (x, y absolute, z) through per-voxel reads. */
function expectedAt(s: VoxelStore, x: number, y: number, z: number): [number, number, number] {
  if (y < -64) return [BEDROCK, 0, 0];
  if (y > 319) return [AIR, 0xF0, 0];
  const [dx, lx] = split(x);
  const [dz, lz] = split(z);
  const v = s.neighborhood(CX, CZ).final(dx, dz)!;
  return [v.block(lx, y, lz), v.light(lx, y, lz), v.fluid(lx, y, lz)];
}

describe('padded section layout (SP4a spec §5.1)', () => {
  test('PAD, PAD_VOXELS and padIndex', () => {
    expect(PAD).toBe(18);
    expect(PAD_VOXELS).toBe(5832);
    expect(padIndex(-1, -1, -1)).toBe(0);
    expect(padIndex(16, 16, 16)).toBe(5831);
    expect(padIndex(0, 0, 0)).toBe(324 + 18 + 1);
    expect(padIndex(3, 5, 7)).toBe(6 * 324 + 8 * 18 + 4);
  });

  test('createPaddedSection sizes', () => {
    const p = createPaddedSection();
    expect([p.blocks.length, p.light.length, p.fluid.length]).toEqual([5832, 5832, 5832]);
  });
});

describe('copyPaddedSection (SP4a spec §4.3, §5.1)', () => {
  const s = buildStore();
  const nb = s.neighborhood(CX, CZ);

  test('equals per-voxel final().block/light/fluid at every padded position, corners and edges included', () => {
    const out = createPaddedSection();
    for (let sy = 0; sy < SECTIONS; sy++) {
      copyPaddedSection(nb, sy, out);
      const eb = new Uint16Array(PAD_VOXELS);
      const el = new Uint8Array(PAD_VOXELS);
      const ef = new Uint8Array(PAD_VOXELS);
      for (let py = -1; py <= 16; py++) {
        for (let pz = -1; pz <= 16; pz++) {
          for (let px = -1; px <= 16; px++) {
            const i = padIndex(px, py, pz);
            [eb[i], el[i], ef[i]] = expectedAt(s, px, sy * 16 - 64 + py, pz);
          }
        }
      }
      expect(out.blocks, `blocks at sy ${sy}`).toEqual(eb);
      expect(out.light, `light at sy ${sy}`).toEqual(el);
      expect(out.fluid, `fluid at sy ${sy}`).toEqual(ef);
    }
  });

  test('below the world it reads BEDROCK with light 0; above it, air with light 0xF0', () => {
    const out = createPaddedSection();
    copyPaddedSection(nb, 0, out);
    for (const [x, z] of [[-1, -1], [0, 0], [7, 16], [16, 16]] as const) {
      const i = padIndex(x, -1, z);
      expect([out.blocks[i], out.light[i], out.fluid[i]]).toEqual([BEDROCK, 0, 0]);
    }
    copyPaddedSection(nb, 23, out);
    for (const [x, z] of [[-1, -1], [0, 0], [7, 16], [16, 16]] as const) {
      const i = padIndex(x, 16, z);
      expect([out.blocks[i], out.light[i], out.fluid[i]]).toEqual([AIR, 0xF0, 0]);
    }
  });

  test('an absent neighbour column throws', () => {
    const lone = createStore({ shared: true, maxBlockBytes: 8 * MiB, maxByteBytes: 8 * MiB });
    const w = lone.claimColumn(0, 0, 0);
    w.commit(3);
    expect(() => copyPaddedSection(lone.neighborhood(0, 0), 4, createPaddedSection())).toThrow(/no final set/);
    expect(() => copyLightRegion(lone.neighborhood(0, 0), createLightRegion())).toThrow(/no final set/);
  });
});

describe('light region (SP4a spec §4.2, §4.3)', () => {
  const s = buildStore();
  const nb = s.neighborhood(CX, CZ);
  const out = createLightRegion();
  copyLightRegion(nb, out);

  test('layout constants, lightIndex and sizes', () => {
    expect([LIGHT_W, LIGHT_H, LIGHT_LO]).toEqual([46, 384, -15]);
    expect(lightIndex(-15, -64, -15)).toBe(0);
    expect(lightIndex(30, 319, 30)).toBe(46 * 384 * 46 - 1);
    expect(lightIndex(-14, -64, -15)).toBe(1);
    expect(lightIndex(-15, -64, -14)).toBe(46);
    expect(lightIndex(-15, -63, -15)).toBe(46 * 46);
    expect([out.blocks.length, out.fluid.length, out.light.length, out.lightBlocking.length])
      .toEqual([46 * 384 * 46, 46 * 384 * 46, 46 * 384 * 46, 46 * 46]);
  });

  test('copyLightRegion equals per-voxel reads at 2,000 random positions and the corners', () => {
    const pts: Array<[number, number, number]> = [];
    for (const x of [-15, 30]) for (const y of [-64, 319]) for (const z of [-15, 30]) pts.push([x, y, z]);
    let r = 0x2545F491;
    const next = (n: number) => {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
      return r % n;
    };
    for (let n = 0; n < 2000; n++) pts.push([next(46) - 15, next(384) - 64, next(46) - 15]);
    for (const [x, y, z] of pts) {
      const [b, , f] = expectedAt(s, x, y, z);
      const i = lightIndex(x, y, z);
      expect([out.blocks[i], out.fluid[i]], `at (${x}, ${y}, ${z})`).toEqual([b, f]);
    }
  });

  test('every voxel of one row through all three columns matches (the seams included)', () => {
    for (const y of [-64, 0, 100, 319]) {
      for (const z of [-15, -1, 0, 15, 16, 30]) {
        for (let x = -15; x < 31; x++) {
          const [b, , f] = expectedAt(s, x, y, z);
          const i = lightIndex(x, y, z);
          expect([out.blocks[i], out.fluid[i]], `at (${x}, ${y}, ${z})`).toEqual([b, f]);
        }
      }
    }
  });

  test('lightBlocking equals the aux values at every one of the 46 × 46 positions', () => {
    const e = new Int16Array(46 * 46);
    for (let z = -15; z < 31; z++) {
      for (let x = -15; x < 31; x++) {
        const [dx, lx] = split(x);
        const [dz, lz] = split(z);
        e[(z + 15) * 46 + (x + 15)] = nb.final(dx, dz)!.aux()!.lightBlocking[lz * 16 + lx]!;
      }
    }
    expect(out.lightBlocking).toEqual(e);
  });
});

describe('ColumnView.sectionLight (SP4a spec §4.3)', () => {
  test('a dense light entry is its slot view, a uniform one its byte; a proto view reads 0', () => {
    const s = buildStore();
    const v = s.final(CX, CZ)!;
    const k = K(0, 0);
    for (let sy = 0; sy < SECTIONS; sy++) {
      const want = lights(k, sy);
      const got = v.sectionLight(sy);
      if ((k + sy) % 4 === 1) expect(got).toBe(want[0]);
      else expect(got).toEqual(want);
    }
    expect(s.proto(CX, CZ)!.sectionLight(3)).toBe(0);
    expect(() => v.sectionLight(24)).toThrow(RangeError);
  });
});

import { describe, expect, test } from 'vitest';
import { CAVE_BIOME } from '../../src/core/constants';
import { deriveSeed, hash3 } from '../../src/core/hash';
import { NormalNoise } from '../../src/core/noise/normal';
import { completeNoiseDef } from '../../src/core/noise/types';
import { pickCaveBiome, type CaveBiomeSettings } from '../../src/gen/biomes/caveRegistry';
import {
  caveBiomeAtPoint, caveBiomeInputsAt, caveBiomeOfPass, caveBiomePoint, caveBiomeUnjittered, caveJitter, caveJitterOffset,
  caveY0, fillCaveColumnPass, newCaveColumnPass, type CaveColumnPass, type CavePickerInputs,
} from '../../src/gen/biomes/cavePicker';
import {
  buildColumnSample, latticeIndex, newColumnSample, readFieldHalo, type ColumnSample,
} from '../../src/gen/column/columnStage';
import { ctxFor } from '../harness/gen';
import { testRng } from '../harness/stats';

/** §6.1's defaults, as `params.caves.biomes` minus its noises will hold them (Task 17). */
const SETTINGS: CaveBiomeSettings = {
  lush: { hMin: 0.4, depthMin: 0.2, depthMax: 0.9 },
  dripstone: { cMin: 0.6, depthMin: 0.2, depthMax: 0.9 },
  abyss: { eMax: -0.5, cMin: -0.1, depthMin: 1.0 },
  depthScale: 128,
  borderWarp: 0.05,
  depthWarp: 10,
  edgeJitter: 2,
};

const ctx = ctxFor();
/** §6.1's noises: border λ 64, depth λ 96, 2 octaves, 2D; the border ones named as Spec correction 11 names them. */
const BORDER = completeNoiseDef({ wavelength: 64, octaves: 2 });
const DEPTH = completeNoiseDef({ wavelength: 96, octaves: 2 });
const inputs = (settings: CaveBiomeSettings): CavePickerInputs => ({
  settings,
  borderC: new NormalNoise(ctx.seed, 'caveBiome.C', BORDER),
  borderE: new NormalNoise(ctx.seed, 'caveBiome.E', BORDER),
  borderH: new NormalNoise(ctx.seed, 'caveBiome.H', BORDER),
  depth: new NormalNoise(ctx.seed, 'caveBiome.D', DEPTH),
  jitterSeed: deriveSeed(ctx.seed, 'caveBiome.jitter'),
});
const withJ = (j: number): CaveBiomeSettings => ({ ...SETTINGS, edgeJitter: j });
/** §1.4's h = hash3(jitterSeed, x, y, z) >>> 0. */
const hashOf = (seed: number, x: number, y: number, z: number): number => hash3(seed, x, y, z) >>> 0;

/** Column pass index of world (x, z): stride 24, offset 4 (the plan's layout). */
const at = (p: CaveColumnPass, x: number, z: number): number => (z - 16 * p.cz + 4) * 24 + (x - 16 * p.cx + 4);

/** Heights spread over depths 0 … 1.6 below the position's surface estimate, so every box is reached. */
const yAt = (s: ColumnSample, x: number, z: number, u: number): number =>
  Math.round(readFieldHalo(s, 'surfaceEst', x, z) - 1.6 * 128 * u);

const columns = (n: number, seed: number): Array<readonly [number, number]> => {
  const next = testRng(seed);
  return Array.from({ length: n }, () => [(next() % 4096) - 2048, (next() % 4096) - 2048] as const);
};

describe('the boxes and the margin rule (§1.3)', () => {
  const pick = (c: number, e: number, h: number, depth: number, b = SETTINGS) => pickCaveBiome(b, c, e, h, depth);
  test('the boxes as the table, the largest margin wins, a tie to the lower id, none → plain', () => {
    // Margins 0.7 − 0.6 = 0.1 (in binary 0.09999999999999998) > 0.45 − 0.4 = 0.05.
    expect(pick(0.7, 0, 0.45, 0.5)).toBe(CAVE_BIOME.dripstone);
    // 0.5 − 0.4 and 0.7 − 0.6 are both 0.09999999999999998: a true tie, to id 1.
    expect(0.5 - 0.4).toBe(0.7 - 0.6);
    expect(pick(0.7, 0, 0.5, 0.5)).toBe(CAVE_BIOME.lush);
    // (C 0.65, H 0.45) is no tie in floating point: 0.050000000000000044 > 0.04999999999999999.
    expect(0.65 - 0.6).toBeGreaterThan(0.45 - 0.4);
    expect(pick(0.65, 0, 0.45, 0.5)).toBe(CAVE_BIOME.dripstone);
    expect(pick(0, -0.6, 0, 1.2)).toBe(CAVE_BIOME.abyss);
    // C′ > cMin is strict.
    expect(pick(-0.1, -0.6, 0, 1.2)).toBe(CAVE_BIOME.plain);
    // The 0.1 depth gap between lush's depthMax and the abyss's depthMin.
    expect(pick(0, 0, 0.5, 0.95)).toBe(CAVE_BIOME.plain);
    // Inclusive ends.
    expect(pick(0, 0, 0.5, 0.2)).toBe(CAVE_BIOME.lush);
    expect(pick(0, 0, 0.5, 0.9)).toBe(CAVE_BIOME.lush);
    // An edit that makes lush and the abyss overlap: lush margin 0.5 − 0.4, abyss min(−0.5 + 0.6, 0 + 0.1), equal.
    const wide: CaveBiomeSettings = { ...SETTINGS, lush: { ...SETTINGS.lush, depthMax: 1.5 } };
    expect(Math.min(-0.5 - -0.6, 0 - -0.1)).toBe(0.5 - 0.4);
    expect(pick(0, -0.6, 0.5, 1.2, wide)).toBe(CAVE_BIOME.lush);
  });
});

describe('the jitter\'s three 10-bit fields (§1.4)', () => {
  test('each field value maps into [−J, J], every offset ⌊1024/(2J + 1)⌋ or ⌈1024/(2J + 1)⌉ times, for J = 0 … 4', () => {
    for (let j = 0; j <= 4; j++) {
      const n = 2 * j + 1;
      const counts = new Map<number, number>();
      for (let f = 0; f < 1024; f++) {
        const o = caveJitterOffset(f, j);
        expect(Number.isInteger(o) && o >= -j && o <= j, `J ${j}, field ${f} → ${o}`).toBe(true);
        counts.set(o, (counts.get(o) ?? 0) + 1);
      }
      expect(counts.size, `J ${j}`).toBe(n);
      for (const c of counts.values()) expect([Math.floor(1024 / n), Math.ceil(1024 / n)], `J ${j}`).toContain(c);
    }
    // J = 2: 204 or 205 times each.
    const c2 = Array.from({ length: 5 }, (_, i) => Array.from({ length: 1024 }, (_, f) => f).filter((f) => caveJitterOffset(f, 2) === i - 2).length);
    for (const c of c2) expect([204, 205]).toContain(c);
  });

  test('caveJitter reads bits 0-9, 10-19 and 20-29 of the voxel\'s hash for jx, jy, jz', () => {
    const inp = inputs(SETTINGS);
    const out = new Int32Array(3);
    // The low bits of the three fields differ from voxel to voxel: each offset follows its own field.
    const next = testRng(5);
    for (let k = 0; k < 2000; k++) {
      const x = (next() % 100_000) - 50_000;
      const y = (next() % 384) - 64;
      const z = (next() % 100_000) - 50_000;
      caveJitter(inp.jitterSeed, 2, x, y, z, out);
      const h = hashOf(inp.jitterSeed, x, y, z);
      expect([out[0], out[1], out[2]]).toEqual([
        caveJitterOffset(h & 1023, 2), caveJitterOffset((h >>> 10) & 1023, 2), caveJitterOffset((h >>> 20) & 1023, 2),
      ]);
    }
  });

  test('with J = 0 every voxel\'s pick equals caveBiomeUnjittered', () => {
    const inp = inputs(withJ(0));
    const pass = newCaveColumnPass();
    const s = newColumnSample();
    const seen = new Set<number>();
    let mismatches = 0;
    for (const [cx, cz] of columns(24, 21)) {
      fillCaveColumnPass(inp, buildColumnSample(ctx, cx, cz, s), pass);
      for (let dz = 0; dz < 16; dz++) for (let dx = 0; dx < 16; dx++) {
        const x = 16 * cx + dx;
        const z = 16 * cz + dz;
        for (let y = -64; y < 320; y += 7) {
          const b = caveBiomeOfPass(inp, pass, x, y, z);
          seen.add(b);
          if (b !== caveBiomeUnjittered(inp, pass, x, y, z)) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(seen.size, 'the sample reaches more than one biome').toBeGreaterThan(1);
  });

  test('with J = 4 the 3D offsets of 100,000 voxels lie in [−4, 4]³, each value reached on each axis', () => {
    const seed = inputs(SETTINGS).jitterSeed;
    const out = new Int32Array(3);
    const seen = [new Set<number>(), new Set<number>(), new Set<number>()];
    const next = testRng(9);
    let outside = 0;
    for (let k = 0; k < 100_000; k++) {
      caveJitter(seed, 4, (next() % 200_000) - 100_000, (next() % 384) - 64, (next() % 200_000) - 100_000, out);
      for (let a = 0; a < 3; a++) {
        const o = out[a]!;
        if (o < -4 || o > 4) outside++;
        seen[a]!.add(o);
      }
    }
    expect(outside).toBe(0);
    for (const s of seen) expect(s.size).toBe(9);
  });
});

describe('pure in (seed, settings, x, y, z) (§1.4, DT1)', () => {
  test.each([2, 4])('J %i: two passes built in different column orders agree bit for bit; picks agree at 10,000 voxels', (j) => {
    const inp = inputs(withJ(j));
    const sample = (cx: number, cz: number) => buildColumnSample(ctx, cx, cz, newColumnSample());
    const pairs = columns(5, 30 + j);
    const next = testRng(40 + j);
    let picks = 0;
    let mismatches = 0;
    const seen = new Set<number>();
    for (const [cx, cz] of pairs) {
      // Order 1: (cx, cz), then its east neighbour; order 2: the neighbour first, with other columns between.
      const sa = sample(cx, cz);
      const a1 = fillCaveColumnPass(inp, sa, newCaveColumnPass());
      const b1 = fillCaveColumnPass(inp, sample(cx + 1, cz), newCaveColumnPass());
      const b2 = fillCaveColumnPass(inp, sample(cx + 1, cz), newCaveColumnPass());
      fillCaveColumnPass(inp, sample(cx - 7, cz + 3), newCaveColumnPass());
      const a2 = fillCaveColumnPass(inp, sample(cx, cz), newCaveColumnPass());
      expect([a1.cx, a1.cz, a1.j, b1.cx]).toEqual([cx, cz, j, cx + 1]);
      for (const [p, q] of [[a1, a2], [b1, b2]] as const) {
        for (let z = 16 * p.cz - j; z < 16 * p.cz + 16 + j; z++) for (let x = 16 * p.cx - j; x < 16 * p.cx + 16 + j; x++) {
          const k = at(p, x, z);
          for (const f of ['c', 'e', 'h', 'y0'] as const) if (!Object.is(p[f][k], q[f][k])) mismatches++;
        }
      }
      // The two neighbours at their shared positions (x within J of the seam, both columns' halos).
      for (let z = 16 * cz - j; z < 16 * cz + 16 + j; z++) for (let x = 16 * (cx + 1) - j; x < 16 * (cx + 1) + j; x++) {
        const ka = at(a1, x, z);
        const kb = at(b1, x, z);
        for (const f of ['c', 'e', 'h', 'y0'] as const) if (!Object.is(a1[f][ka], b1[f][kb])) mismatches++;
      }
      for (let n = 0; n < 2000; n++) {
        const x = 16 * cx + (next() % 16);
        const z = 16 * cz + (next() % 16);
        const y = yAt(sa, x, z, (next() % 1000) / 1000);
        const b = caveBiomeOfPass(inp, a1, x, y, z);
        seen.add(b);
        picks++;
        if (b !== caveBiomeOfPass(inp, a2, x, y, z)) mismatches++;
      }
    }
    expect(picks).toBe(10_000);
    expect(mismatches).toBe(0);
    expect(seen.size, 'the sample reaches more than one biome').toBeGreaterThan(1);
  });

  test.each([2, 4])('J %i: a voxel whose jittered position lies in column cx + 1 picks what cx + 1\'s pass gives there (the halo)', (j) => {
    const inp = inputs(withJ(j));
    const out = new Int32Array(3);
    let crossing = 0;
    let mismatches = 0;
    const seen = new Set<number>();
    for (const [cx, cz] of columns(8, 50 + j)) {
      const sa = buildColumnSample(ctx, cx, cz, newColumnSample());
      const a = fillCaveColumnPass(inp, sa, newCaveColumnPass());
      const b = fillCaveColumnPass(inp, buildColumnSample(ctx, cx + 1, cz, newColumnSample()), newCaveColumnPass());
      for (let dz = 0; dz < 16; dz++) for (let dx = 16 - j; dx < 16; dx++) {
        const x = 16 * cx + dx;
        const z = 16 * cz + dz;
        for (let u = 0; u < 1; u += 1 / 64) {
          const y = yAt(sa, x, z, u);
          caveJitter(inp.jitterSeed, j, x, y, z, out);
          if (x + out[0]! < 16 * (cx + 1)) continue;
          crossing++;
          const pick = caveBiomeOfPass(inp, a, x, y, z);
          seen.add(pick);
          if (pick !== caveBiomeUnjittered(inp, b, x + out[0]!, y + out[1]!, z + out[2]!)) mismatches++;
        }
      }
    }
    expect(crossing).toBeGreaterThan(1000);
    expect(mismatches).toBe(0);
    expect(seen.size, 'the sample reaches more than one biome').toBeGreaterThan(1);
  });
});

describe('the map\'s form agrees with the pass (§1.5)', () => {
  test('at 1,000 positions caveBiomePoint, fed caveBiomeInputsAt and readFieldHalo, gives caveBiomeUnjittered\'s biome and depth (Y0 − y)/D', () => {
    const inp = inputs(SETTINGS);
    const nb = new Float64Array(4);
    const next = testRng(77);
    const pass = newCaveColumnPass();
    const counts = [0, 0, 0, 0];
    let n = 0;
    let mismatches = 0;
    for (const [cx, cz] of columns(50, 61)) {
      const s = buildColumnSample(ctx, cx, cz, newColumnSample());
      fillCaveColumnPass(inp, s, pass);
      for (let k = 0; k < 20; k++, n++) {
        // Positions anywhere in the pass, halo included.
        const x = 16 * cx - 2 + (next() % 20);
        const z = 16 * cz - 2 + (next() % 20);
        const y = yAt(s, x, z, (next() % 1000) / 1000);
        const c = readFieldHalo(s, 'C', x, z);
        const e = readFieldHalo(s, 'E', x, z);
        const h = readFieldHalo(s, 'H', x, z);
        const se = readFieldHalo(s, 'surfaceEst', x, z);
        expect(caveBiomeInputsAt(inp, x, z, nb)).toBe(nb);
        const p = caveBiomePoint(SETTINGS, c, e, h, se, [nb[0]!, nb[1]!, nb[2]!], nb[3]!, y);
        const y0 = pass.y0[at(pass, x, z)]!;
        const want = caveBiomeUnjittered(inp, pass, x, y, z);
        counts[want]!++;
        if (p.biome !== want) mismatches++;
        if (!Object.is(p.depth, (y0 - y) / SETTINGS.depthScale)) mismatches++;
        if (!Object.is(caveY0(SETTINGS, se, nb[3]!), y0)) mismatches++;
        const q = caveBiomeAtPoint(inp, c, e, h, se, x, z, y);
        if (q.biome !== want || !Object.is(q.depth, p.depth) || !Object.is(q.y0, y0)) mismatches++;
      }
    }
    expect(n).toBe(1000);
    expect(mismatches).toBe(0);
    expect(counts.filter((c) => c > 0).length, `biomes reached ${counts.join(', ')}`).toBeGreaterThan(1);
  });

  test('the border and depth noises are each z2 / clamp clamped to [−1, 1]; Y0 = surfaceEst + depthWarp · Nd', () => {
    const inp = inputs(SETTINGS);
    const out = new Float64Array(4);
    const next = testRng(3);
    for (let k = 0; k < 500; k++) {
      const x = (next() % 100_000) - 50_000;
      const z = (next() % 100_000) - 50_000;
      caveBiomeInputsAt(inp, x, z, out);
      const want = [inp.borderC, inp.borderE, inp.borderH, inp.depth].map((nz) => Math.min(1, Math.max(-1, nz.z2(x, z) / nz.clamp)));
      expect(Array.from(out)).toEqual(want);
      expect(caveY0(SETTINGS, 70, out[3]!)).toBe(70 + 10 * out[3]!);
    }
  });
});

describe('the speckle (§1.4, D3)', () => {
  test('along a straight border of the unperturbed field, J = 2 changes the biome within ±2 blocks of it at ≥ 20 % of voxels and nowhere farther', () => {
    // A synthetic column (0, 0): H rises by 0.01 per block and crosses lush's hMin 0.4 at x = 8.5, every other field
    // flat (C 0, E 0, surfaceEst 64); borderWarp 0 and depthWarp 0 leave the border straight, at depths 0.27 … 0.83.
    const s = newColumnSample();
    for (let j = -1; j <= 5; j++) for (let i = -1; i <= 5; i++) {
      s.f.H[latticeIndex(i, j)] = 0.4 + (4 * i - 8.5) * 0.01;
      s.f.surfaceEst[latticeIndex(i, j)] = 64;
    }
    const flat: CaveBiomeSettings = { ...SETTINGS, borderWarp: 0, depthWarp: 0, edgeJitter: 2 };
    const inp = inputs(flat);
    const pass = fillCaveColumnPass(inp, s, newCaveColumnPass());
    let near = 0;
    let nearChanged = 0;
    let farChanged = 0;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) for (let y = -42; y <= 30; y++) {
      const plain = caveBiomeUnjittered(inp, pass, x, y, z);
      expect(plain).toBe(x >= 9 ? CAVE_BIOME.lush : CAVE_BIOME.plain);
      const changed = caveBiomeOfPass(inp, pass, x, y, z) !== plain;
      if (Math.abs(x - 8.5) <= 2) {
        near++;
        if (changed) nearChanged++;
      } else if (changed) farChanged++;
    }
    expect(near).toBe(4 * 16 * 73);
    expect(nearChanged / near).toBeGreaterThanOrEqual(0.2);
    expect(farChanged).toBe(0);
  });
});

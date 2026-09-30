import { describe, expect, test } from 'vitest';
import { BIOME_TABLE_DEFAULT, BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { BOX_AXES } from '../../src/core/params/kit';
import { newPick, pickBiome, pickBox } from '../../src/gen/biomes/picker';
import { biomeColor, biomeFamily, biomeId, biomeName, BOX_TO_BIOME, SURFACE_BIOMES } from '../../src/gen/biomes/registry';
import { zoomQuart } from '../../src/gen/biomes/zoom';
import { ctxFor } from '../harness/gen';

describe('registry', () => {
  test('28 biomes in master order, volcano last; ids round-trip', () => {
    expect(SURFACE_BIOMES.length).toBe(28);
    expect(SURFACE_BIOMES.slice(0, 9)).toEqual(['ocean', 'deep_ocean', 'warm_ocean', 'frozen_ocean', 'beach', 'snowy_beach', 'stony_shore', 'river', 'frozen_river']);
    expect(SURFACE_BIOMES[27]).toBe('volcano');
    for (const n of SURFACE_BIOMES) expect(biomeName(biomeId(n))).toBe(n);
    expect(() => biomeName(28)).toThrow(/unknown biome id 28/);
  });
  test('families and colours', () => {
    expect(SURFACE_BIOMES.map((_, i) => biomeFamily(i)).filter((f) => f === 'highland').length).toBe(7);
    expect(biomeFamily(biomeId('volcano'))).toBe('highland');
    expect(new Set(SURFACE_BIOMES.map((_, i) => biomeColor(i))).size).toBe(28);
  });
  test('every box maps to its biome id', () => {
    expect(BOX_TO_BIOME.map((id) => biomeName(id))).toEqual([...BOX_BIOMES]);
  });
});

describe('picker', () => {
  const ctx = ctxFor();
  const mid = (iv: readonly [number, number]) => (iv[0] + iv[1]) / 2;
  /** offset0 of a sea-floor column and of a land column. */
  const SEA = 40;
  const LAND = 80;
  test('the centre of every box picks that box with fitness 0 and no tie', () => {
    for (const name of BOX_BIOMES) {
      const r = BIOME_TABLE_DEFAULT[name];
      const [C, E, PV, T, H] = BOX_AXES.map((a) => mid(r[a]));
      const W = r.wSign === -1 ? -0.5 : 0.5;
      const offset0 = biomeFamily(biomeId(name)) === 'ocean' ? SEA : LAND;
      const p = pickBox(ctx, C!, E!, PV!, T!, H!, W, offset0, newPick());
      expect(biomeName(p.biome), name).toBe(name);
      expect(p.fitness).toBe(0);
      expect(p.runnerUp).toBeGreaterThan(0);
    }
  });
  test('the W sign selects jagged vs frozen peaks', () => {
    const at = (W: number) => biomeName(pickBiome(ctx, 0.5, -0.9, 0.9, -0.8, 0, W, LAND, false));
    expect([at(0.7), at(-0.7), at(0)]).toEqual(['jagged_peaks', 'frozen_peaks', 'jagged_peaks']);
  });
  test('river flag overrides boxes; frozen below T −0.6', () => {
    expect(biomeName(pickBiome(ctx, 0.5, 0, 0, 0, 0, 0, LAND, true))).toBe('river');
    expect(biomeName(pickBiome(ctx, 0.5, 0, 0, -0.7, 0, 0, LAND, true))).toBe('frozen_river');
  });
  test('outside every box the lowest overshoot wins (hot humid valley → jungle or swamp)', () => {
    const p = pickBox(ctx, 0.5, 0.5, -0.8, 0.8, 0.4, 0.5, LAND, newPick());
    expect(p.fitness).toBeGreaterThan(0);
    expect(['jungle', 'swamp']).toContain(biomeName(p.biome));
  });
  test('on a shared edge the lower priority wins and the tie is visible', () => {
    const p = pickBox(ctx, 0.5, 0.5, 0, -0.2, 0, 0.5, LAND, newPick());
    expect(biomeName(p.biome)).toBe('plains');
    expect(p.runnerUp).toBe(p.fitness);
  });
  test('volcano is the hot-peaks box', () => {
    expect(biomeName(pickBiome(ctx, 0.4, -0.8, 0.85, 0.8, 0, 0.3, LAND, false))).toBe('volcano');
    expect(biomeName(pickBiome(ctx, 0.4, -0.8, 0.5, 0.8, 0, 0.3, LAND, false))).toBe('badlands');
  });
  test('height filter: below sea level only ocean-family boxes, at or above it none', () => {
    const at = (C: number, E: number, T: number, offset0: number) => biomeName(pickBiome(ctx, C, E, 0, T, 0, 0.5, offset0, false));
    // The shore band, where the height decides between sea and shore.
    expect([at(-0.15, 0.5, 0, 62.9), at(-0.15, 0.5, 0, 63), at(-0.15, 0.5, -0.9, 50), at(-0.15, 0.5, -0.9, 70), at(-0.15, -0.8, 0, 70)])
      .toEqual(['ocean', 'beach', 'frozen_ocean', 'snowy_beach', 'stony_shore']);
    // Far from the band the filter still wins over the climate: an inland C below sea level is still sea, and vice versa.
    expect([at(0.5, 0.5, 0.8, 50), at(-0.7, 0.5, 0, 70)]).toEqual(['warm_ocean', 'beach']);
    for (let k = 0; k < 2000; k++) {
      const C = -1 + (2 * k) / 1999;
      expect(biomeFamily(pickBiome(ctx, C, 0.3, 0.1, 0.1, 0.1, 0.1, 62, false)), `C ${C} sea`).toBe('ocean');
      expect(biomeFamily(pickBiome(ctx, C, 0.3, 0.1, 0.1, 0.1, 0.1, 64, false)), `C ${C} land`).not.toBe('ocean');
    }
  });
});

describe('zoom', () => {
  test('returns one of the 4 surrounding quarts, deterministically', () => {
    const ctx = ctxFor();
    const out: [number, number] = [0, 0];
    for (let k = 0; k < 500; k++) {
      const px = k * 7.3 - 1800;
      const pz = k * -5.1 + 900;
      const [qx, qz] = zoomQuart(ctx, px, pz, out);
      expect(qx - Math.floor(px / 4)).toBeGreaterThanOrEqual(0);
      expect(qx - Math.floor(px / 4)).toBeLessThanOrEqual(1);
      expect(qz - Math.floor(pz / 4)).toBeGreaterThanOrEqual(0);
      expect(qz - Math.floor(pz / 4)).toBeLessThanOrEqual(1);
      expect(zoomQuart(ctxFor(), px, pz, [0, 0])).toEqual([qx, qz]);
    }
  });
  test('zero jitter is plain nearest-lattice-point, ties to the lower (qz, qx)', () => {
    const ctx = ctxFor('42', { biomes: { zoomJitter: 0 } });
    expect(zoomQuart(ctx, 5.9, 1.1, [0, 0])).toEqual([1, 0]);
    expect(zoomQuart(ctx, 6.1, 6.1, [0, 0])).toEqual([2, 2]);
    expect(zoomQuart(ctx, 2, 2, [0, 0])).toEqual([0, 0]);
  });
});

describe('W-sign filters that exclude every box (final review)', () => {
  test('a table whose boxes all have wSign +1 still picks a box for W < 0, identically on both paths', async () => {
    const { columnPoint } = await import('../../src/gen/column/columnPoint');
    const { buildColumnSample, latticeIndex, newColumnSample } = await import('../../src/gen/column/columnStage');
    const t = BIOME_TABLE_DEFAULT;
    const allPlus = Object.fromEntries(Object.entries(t).map(([k, r]) => [k, { ...r, wSign: 1 as const }]));
    const ctx = ctxFor('42', { biomes: { table: allPlus as typeof t } });
    const p = pickBox(ctx, 0.5, 0.5, 0, 0, 0, -0.5, 80, newPick());
    expect(pickBox(ctx, -0.3, 0.5, 0, 0, 0, -0.5, 40, newPick()).box).toBeGreaterThanOrEqual(0);
    expect(p.box).toBeGreaterThanOrEqual(0);
    expect(typeof p.biome).toBe('number');
    const s = buildColumnSample(ctx, 3, 4, newColumnSample());
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
      const cp = columnPoint(ctx, 48 + 4 * i, 64 + 4 * j);
      expect(typeof cp.biome).toBe('number');
      expect(s.biome[latticeIndex(i, j)]).toBe(cp.biome);
    }
  });
  test('the fallback stays in the column height class, also when only one class is W-excluded', () => {
    const t = BIOME_TABLE_DEFAULT;
    const fam = (ctx: ReturnType<typeof ctxFor>, C: number, offset0: number) => biomeFamily(pickBox(ctx, C, 0.5, 0, 0, 0, -0.5, offset0, newPick()).biome);
    const allPlus = Object.fromEntries(Object.entries(t).map(([k, r]) => [k, { ...r, wSign: 1 as const }]));
    const oceansPlus = Object.fromEntries(BOX_BIOMES.map((k) => [k, biomeFamily(biomeId(k)) === 'ocean' ? { ...t[k], wSign: 1 as const } : t[k]]));
    for (const table of [allPlus, oceansPlus]) {
      const ctx = ctxFor('42', { biomes: { table: table as typeof t } });
      // Sea floor on the shore band and inland C, land on the shore band and deep-sea C: the class wins over C.
      expect([fam(ctx, -0.13, 40), fam(ctx, 0.5, 40), fam(ctx, -0.13, 70), fam(ctx, -0.7, 70)]).toEqual(['ocean', 'ocean', 'coast', 'coast']);
    }
  });
});

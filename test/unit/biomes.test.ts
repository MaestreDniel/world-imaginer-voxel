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
  test('the centre of every box picks that box with fitness 0 and no tie', () => {
    for (const name of BOX_BIOMES) {
      const r = BIOME_TABLE_DEFAULT[name];
      const [C, E, PV, T, H] = BOX_AXES.map((a) => mid(r[a]));
      const W = r.wSign === -1 ? -0.5 : 0.5;
      const p = pickBox(ctx, C!, E!, PV!, T!, H!, W, newPick());
      expect(biomeName(p.biome), name).toBe(name);
      expect(p.fitness).toBe(0);
      expect(p.runnerUp).toBeGreaterThan(0);
    }
  });
  test('the W sign selects jagged vs frozen peaks', () => {
    const at = (W: number) => biomeName(pickBiome(ctx, 0.5, -0.9, 0.9, -0.8, 0, W, false));
    expect([at(0.7), at(-0.7), at(0)]).toEqual(['jagged_peaks', 'frozen_peaks', 'jagged_peaks']);
  });
  test('river flag overrides boxes; frozen below T −0.6', () => {
    expect(biomeName(pickBiome(ctx, 0.5, 0, 0, 0, 0, 0, true))).toBe('river');
    expect(biomeName(pickBiome(ctx, 0.5, 0, 0, -0.7, 0, 0, true))).toBe('frozen_river');
  });
  test('outside every box the lowest overshoot wins (hot humid valley → jungle or swamp)', () => {
    const p = pickBox(ctx, 0.5, 0.5, -0.8, 0.8, 0.4, 0.5, newPick());
    expect(p.fitness).toBeGreaterThan(0);
    expect(['jungle', 'swamp']).toContain(biomeName(p.biome));
  });
  test('on a shared edge the lower priority wins and the tie is visible', () => {
    const p = pickBox(ctx, 0.5, 0.5, 0, -0.2, 0, 0.5, newPick());
    expect(biomeName(p.biome)).toBe('plains');
    expect(p.runnerUp).toBe(p.fitness);
  });
  test('volcano is the hot-peaks box', () => {
    expect(biomeName(pickBiome(ctx, 0.4, -0.8, 0.85, 0.8, 0, 0.3, false))).toBe('volcano');
    expect(biomeName(pickBiome(ctx, 0.4, -0.8, 0.5, 0.8, 0, 0.3, false))).toBe('badlands');
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

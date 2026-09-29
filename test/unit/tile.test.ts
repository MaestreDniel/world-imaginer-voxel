import { describe, expect, test } from 'vitest';
import { biomeColor } from '../../src/gen/biomes/registry';
import { newPointRecord, sampleCoarse, samplePoint } from '../../src/gen/column/columnPoint';
import { isLayerId, layerColor, layerStage, LAYERS, slopeShade } from '../../src/gen/map/layers';
import { diverging, hypsometric, sequential } from '../../src/gen/map/palette';
import { isLevel, levelFor, paintTile, samplePixel } from '../../src/gen/map/tile';
import { ctxFor } from '../harness/gen';

const rgbAt = (t: Uint8ClampedArray, i: number, j: number) => {
  const o = 4 * (j * 256 + i);
  return (t[o]! << 16) | (t[o + 1]! << 8) | t[o + 2]!;
};
const newTile = () => new Uint8ClampedArray(256 * 256 * 4);
const PIX: ReadonlyArray<readonly [number, number]> = [[0, 0], [255, 255], [17, 200], [128, 3], [240, 99], [3, 251]];

describe('layers and palette', () => {
  test('layer ids and their invalidating stage', () => {
    expect(LAYERS.length).toBe(14);
    expect(isLayerId('relief')).toBe(true);
    expect(isLayerId('nope')).toBe(false);
    expect(['biome', 'relief', 'rivers', 'C', 'PV', 'offset'].map((l) => layerStage(l as never))).toEqual(['biome2d', 'shape', 'shape', 'climate', 'climate', 'shape']);
  });
  test('ramps hit their end colours', () => {
    expect([diverging(-1), diverging(1), hypsometric(63), hypsometric(263), sequential(0, 0, 1), sequential(1, 0, 1)])
      .toEqual([0x3b4cc0, 0xb40426, 0x3d7a3a, 0xf4f4f4, 0x0d0887, 0xf0f921]);
  });
  test('NW-lit slope shading is clamped to [0.55, 1.35]', () => {
    expect(slopeShade(70, 70, 70, 70, 16)).toBe(1);
    expect(slopeShade(80, 64, 70, 70, 16)).toBe(1.25);
    expect(slopeShade(200, 0, 200, 0, 4)).toBe(1.35);
    expect(slopeShade(0, 200, 0, 200, 4)).toBe(0.55);
  });
  test('levels: coarsest level at most twice the display scale, at least 4', () => {
    expect([levelFor(200), levelFor(64), levelFor(40), levelFor(16), levelFor(8), levelFor(1), levelFor(0.25)]).toEqual([256, 64, 64, 16, 16, 4, 4]);
    expect([isLevel(64), isLevel(32)]).toEqual([true, false]);
  });
});

describe('paintTile', () => {
  const ctx = ctxFor('42');
  test('unshaded layers paint layerColor of the pixel-centre point', () => {
    for (const layer of ['C', 'biome', 'offset'] as const) {
      const t = paintTile(ctx, layer, 64, 3, -2, newTile());
      const rec = newPointRecord();
      for (const [i, j] of PIX) {
        samplePoint(ctx, 256 * 64 * 3 + 64 * (i + 0.5), 256 * 64 * -2 + 64 * (j + 0.5), false, rec);
        expect(rgbAt(t, i, j)).toBe(layerColor(layer, rec, 1));
      }
      for (let o = 3; o < t.length; o += 4) if (t[o] !== 255) throw new Error('alpha');
    }
  });
  test('the preview level samples climate, shape and biome once per 2 × 2 pixel block', () => {
    const t = paintTile(ctx, 'biome', 256, 0, 0, newTile());
    const rec = newPointRecord();
    for (const [i, j] of PIX) {
      const bi = i >> 1;
      const bj = j >> 1;
      const expected = biomeColor(sampleCoarse(ctx, 256 * (2 * bi + 1), 256 * (2 * bj + 1), rec).biome);
      for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) expect(rgbAt(t, 2 * bi + di, 2 * bj + dj)).toBe(expected);
    }
  });
  test('preview relief is shaded from the neighbouring 2 × 2 blocks', () => {
    const t = paintTile(ctx, 'relief', 256, 1, 0, newTile());
    const rec = newPointRecord();
    const h = (bi: number, bj: number) => sampleCoarse(ctx, 65536 + 256 * (2 * bi + 1), 256 * (2 * bj + 1), rec).surfaceEst;
    for (const [bi, bj] of [[0, 0], [127, 127], [40, 3]]) {
      const k = slopeShade(h(bi - 1, bj), h(bi + 1, bj), h(bi, bj - 1), h(bi, bj + 1), 512);
      sampleCoarse(ctx, 65536 + 256 * (2 * bi + 1), 256 * (2 * bj + 1), rec);
      expect(rgbAt(t, 2 * bi + 1, 2 * bj)).toBe(layerColor('relief', rec, k));
    }
  });
  test('relief shading reads the neighbour tile across the edge (seamless)', () => {
    const t = paintTile(ctx, 'relief', 16, 5, 1, newTile());
    const rec = newPointRecord();
    const h = (i: number, j: number) => samplePixel(ctx, 16, 256 * 16 * 5 + 16 * (i + 0.5), 256 * 16 + 16 * (j + 0.5), rec).surfaceEst;
    for (const j of [0, 100, 255]) {
      const i = 255;
      const k = slopeShade(h(i - 1, j), h(i + 1, j), h(i, j - 1), h(i, j + 1), 16);
      samplePixel(ctx, 16, 256 * 16 * 5 + 16 * (i + 0.5), 256 * 16 + 16 * (j + 0.5), rec);
      expect(rgbAt(t, i, j)).toBe(layerColor('relief', rec, k));
    }
  });
  test('deterministic across contexts', () => {
    expect(paintTile(ctxFor('42'), 'rivers', 4, -7, 9, newTile())).toEqual(paintTile(ctx, 'rivers', 4, -7, 9, newTile()));
  });
});

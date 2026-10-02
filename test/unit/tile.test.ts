import { describe, expect, test } from 'vitest';
import { biomeColor } from '../../src/gen/biomes/registry';
import { newPointRecord, sampleCoarse, samplePoint } from '../../src/gen/column/columnPoint';
import type { GenContext } from '../../src/gen/context';
import { isLayerId, layerColor, layerStage, LAYERS, slopeShade, type LayerId } from '../../src/gen/map/layers';
import { diverging, hypsometric, sequential } from '../../src/gen/map/palette';
import { isLevel, levelFor, paintTile, paintTileAbortable, samplePixel } from '../../src/gen/map/tile';
import { ctxFor } from '../harness/gen';

const rgbAt = (t: Uint8ClampedArray, i: number, j: number) => {
  const o = 4 * (j * 256 + i);
  return (t[o]! << 16) | (t[o + 1]! << 8) | t[o + 2]!;
};
const newTile = () => new Uint8ClampedArray(256 * 256 * 4);
const PIX: ReadonlyArray<readonly [number, number]> = [[0, 0], [255, 255], [17, 200], [128, 3], [240, 99], [3, 251]];
const NEVER = () => false;
/** Index of the first differing byte, or −1 (vitest's deep equality is slow on 262 144-byte arrays). */
const firstDiff = (a: Uint8ClampedArray | null, b: Uint8ClampedArray) => {
  if (a === null || a.length !== b.length) return -2;
  for (let o = 0; o < b.length; o++) if (a[o] !== b[o]) return o;
  return -1;
};
/** A stop callback that counts its calls and fires on call `fireAt` (never when omitted). */
const counter = (fireAt = Infinity) => {
  const c = { calls: 0, stop: () => ++c.calls >= fireAt };
  return c;
};

/**
 * SP2a's preview of a shaded layer, which samples every block twice (heights, then colour): the
 * reference the single-sampled preview must reproduce byte for byte (SP2b spec §2.4).
 */
function previewSampledTwice(ctx: GenContext, layer: LayerId, tx: number, tz: number): Uint8ClampedArray {
  const out = newTile();
  const rec = newPointRecord();
  const at = (bi: number, bj: number) => sampleCoarse(ctx, 65536 * tx + 256 * (2 * bi + 1), 65536 * tz + 256 * (2 * bj + 1), rec);
  const h = new Float64Array(130 * 130);
  for (let bj = -1; bj <= 128; bj++) for (let bi = -1; bi <= 128; bi++) h[(bj + 1) * 130 + bi + 1] = at(bi, bj).surfaceEst;
  for (let bj = 0; bj < 128; bj++) for (let bi = 0; bi < 128; bi++) {
    const k0 = (bj + 1) * 130 + bi + 1;
    const rgb = layerColor(layer, at(bi, bj), slopeShade(h[k0 - 1]!, h[k0 + 1]!, h[k0 - 130]!, h[k0 + 130]!, 512));
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const o = 4 * ((2 * bj + dj) * 256 + 2 * bi + di);
      out[o] = (rgb >>> 16) & 255;
      out[o + 1] = (rgb >>> 8) & 255;
      out[o + 2] = rgb & 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

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
  test('the rivers layer tints river proximity on land and lakes only, never on the sea', () => {
    const tinted = (surfaceEst: number, surfaceWaterLevel: number, lakeMask: number) => {
      const rec = { ...newPointRecord(), riverDist: 10, surfaceEst, surfaceWaterLevel, lakeMask };
      return layerColor('rivers', rec, 1) !== layerColor('rivers', { ...rec, riverDist: 64 }, 1);
    };
    expect([tinted(80, 63, 0), tinted(63, 63, 0), tinted(90, 100, 1)]).toEqual([true, true, true]);
    expect([tinted(40, 63, 0), tinted(90, 100, 0.5)]).toEqual([false, false]);
  });
  test('NW-lit slope shading is clamped to [0.55, 1.35]', () => {
    expect(slopeShade(70, 70, 70, 70, 16)).toBe(1);
    expect(slopeShade(80, 64, 70, 70, 16)).toBe(1.25);
    expect(slopeShade(200, 0, 200, 0, 4)).toBe(1.35);
    expect(slopeShade(0, 200, 0, 200, 4)).toBe(0.55);
  });
  test('the lakes colour clamps the lake level to [63, 200] (SP2a minor 7)', () => {
    const lake = (lakeLevel: number) => layerColor('lakes', { ...newPointRecord(), lakeMask: 1, lakeLevel, surfaceWaterLevel: lakeLevel }, 1);
    expect([50, 63, 200, 300].map(lake)).toEqual([0x4aa0e0, 0x4aa0e0, 0x0c3a8a, 0x0c3a8a]);
    expect(lake(131.5)).toBe(0x2b6db5);
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

describe('paintTileAbortable (SP2b spec §2.2, §2.4, §5.3)', () => {
  const ctx = ctxFor('42');
  test('the single-sampled shaded preview equals a reference that samples every block twice', () => {
    for (const layer of ['relief', 'rivers', 'lakes'] as const) {
      for (const [tx, tz] of [[1, -1], [-2, 0]] as const) {
        expect([layer, tx, tz, firstDiff(paintTile(ctx, layer, 256, tx, tz, newTile()), previewSampledTwice(ctx, layer, tx, tz))]).toEqual([layer, tx, tz, -1]);
      }
    }
  });
  test('a stop that never fires paints what paintTile paints, polled once per block row of the sampling pass', () => {
    const rows: Record<string, number> = { biome: 128, C: 128, relief: 130, rivers: 130, lakes: 130 };
    for (const layer of ['biome', 'C', 'relief', 'rivers', 'lakes'] as const) {
      const c = counter();
      const t = paintTileAbortable(ctx, layer, 256, 1, -1, newTile(), c.stop);
      expect([layer, c.calls, firstDiff(t, paintTile(ctx, layer, 256, 1, -1, newTile()))]).toEqual([layer, rows[layer], -1]);
    }
  });
  test('fine tiles poll once per row (unshaded) or per row of the sampling pass (shaded)', () => {
    for (const [layer, rows] of [['offset', 256], ['relief', 258]] as const) {
      const c = counter();
      expect(paintTileAbortable(ctx, layer, 64, 0, 0, newTile(), c.stop)).not.toBeNull();
      expect([layer, c.calls]).toEqual([layer, rows]);
    }
  });
  test('returns null once stop fires; an unshaded tile keeps the rows painted before it', () => {
    for (const b of [256, 64, 4] as const) {
      for (const layer of ['biome', 'relief'] as const) {
        const c = counter(3);
        const t = newTile();
        expect(paintTileAbortable(ctx, layer, b, 2, 1, t, c.stop)).toBeNull();
        expect([b, layer, c.calls]).toEqual([b, layer, 3]);
        // Shaded tiles colour only after the sampling pass, so nothing is written; unshaded rows 0 and 1 are.
        const painted = t.filter((_, o) => o % 4 === 3 && t[o] === 255).length;
        const rowsDone = layer === 'relief' ? 0 : b === 256 ? 4 : 2;
        expect([b, layer, painted]).toEqual([b, layer, 256 * rowsDone]);
      }
    }
  });
  test('biome ids: each pixel gets its sample\'s biome at fine levels and its 2 × 2 block\'s sample at the preview', () => {
    const rec = newPointRecord();
    const ids = new Uint8Array(65536).fill(255);
    const t = paintTileAbortable(ctx, 'biome', 256, 0, 0, newTile(), NEVER, ids)!;
    for (let bj = 0; bj < 128; bj++) for (let bi = 0; bi < 128; bi++) {
      const biome = sampleCoarse(ctx, 256 * (2 * bi + 1), 256 * (2 * bj + 1), rec).biome;
      for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const k = (2 * bj + dj) * 256 + 2 * bi + di;
        if (ids[k] !== biome || rgbAt(t, 2 * bi + di, 2 * bj + dj) !== biomeColor(biome)) throw new Error(`preview pixel ${k}: id ${ids[k]}, biome ${biome}`);
      }
    }
    const fine = new Uint8Array(65536).fill(255);
    const tf = paintTileAbortable(ctx, 'biome', 64, 3, -2, newTile(), NEVER, fine)!;
    for (const [i, j] of PIX) {
      expect(fine[j * 256 + i]).toBe(samplePoint(ctx, 256 * 64 * 3 + 64 * (i + 0.5), 256 * 64 * -2 + 64 * (j + 0.5), false, rec).biome);
    }
    for (let k = 0; k < 65536; k++) if (rgbAt(tf, k & 255, k >> 8) !== biomeColor(fine[k]!)) throw new Error(`fine pixel ${k}`);
  });
  test('ids are left untouched on other layers', () => {
    for (const [layer, b] of [['relief', 256], ['C', 256], ['offset', 64]] as const) {
      const ids = new Uint8Array(65536).fill(200);
      paintTileAbortable(ctx, layer, b, 0, 0, newTile(), NEVER, ids);
      expect([layer, ids.every((v) => v === 200)]).toEqual([layer, true]);
    }
  });
});

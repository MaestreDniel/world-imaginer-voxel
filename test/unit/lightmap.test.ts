import { ClampToEdgeWrapping, LinearFilter, NoColorSpace } from 'three';
import { describe, expect, test } from 'vitest';
import { dayFactor, duskFactor } from '../../src/daynight/dayNight';
import { createLightmap, lightCurve, lightmapRgba } from '../../src/render/lightmap';

const TIMES = Array.from({ length: 96 }, (_, i) => i / 96);
const BRIGHTNESS = [0, 0.3, 1] as const;

/** The 1024 RGBA bytes at time t and brightness β. */
const at = (t: number, beta: number): Uint8Array => {
  const out = new Uint8Array(1024);
  lightmapRgba(dayFactor(t), duskFactor(t), beta, out);
  return out;
};
/** Texel (x = block, y = sky). */
const texel = (m: Uint8Array, block: number, sky: number): number[] => {
  const o = (sky * 16 + block) * 4;
  return [m[o]!, m[o + 1]!, m[o + 2]!, m[o + 3]!];
};
const luminance = ([r, g, b]: number[]): number => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

describe('the lightmap (SP4a spec §6.7, master §4.8)', () => {
  test('lightCurve is 0 at 0 and 1 at 15, increasing in between', () => {
    expect(lightCurve(0)).toBe(0);
    expect(lightCurve(15)).toBe(1);
    for (let l = 1; l <= 15; l++) expect(lightCurve(l)).toBeGreaterThan(lightCurve(l - 1));
    expect(lightCurve(7.5)).toBeCloseTo(0.5 / 2.5, 12);
  });

  test('(sky 0, block 0) has luminance ≤ 0.02·255 at every t and brightness', () => {
    for (const t of TIMES) {
      for (const beta of BRIGHTNESS) {
        expect(luminance(texel(at(t, beta), 0, 0)), `t ${t}, β ${beta}`).toBeLessThanOrEqual(0.02 * 255);
      }
    }
  });

  test('every block-only texel (sky 0) is identical at every t', () => {
    for (const beta of BRIGHTNESS) {
      const first = at(0, beta).subarray(0, 64);
      for (const t of TIMES) expect(at(t, beta).subarray(0, 64), `t ${t}, β ${beta}`).toEqual(first);
    }
  });

  test('the sky-15 texel is brighter at noon than at midnight', () => {
    for (const beta of BRIGHTNESS) {
      expect(luminance(texel(at(0.25, beta), 0, 15))).toBeGreaterThan(luminance(texel(at(0.75, beta), 0, 15)));
    }
  });

  test('the texel values: (15, 15) white at noon with β 0, block 15 warm, alpha 255 everywhere', () => {
    const noon = at(0.25, 0);
    expect(texel(noon, 15, 15)).toEqual([255, 255, 255, 255]);
    expect(texel(noon, 0, 15)).toEqual([255, 255, 255, 255]);
    expect(texel(noon, 15, 0)).toEqual([255, Math.round(255 * 0.85), Math.round(255 * 0.65), 255]);
    const midnight = at(0.75, 0);
    expect(texel(midnight, 0, 15)).toEqual([
      Math.round(255 * 0.15 * 0.45),
      Math.round(255 * 0.15 * 0.55),
      Math.round(255 * 0.15 * 0.85),
      255,
    ]);
    for (const m of [noon, midnight, at(0.5, 1)]) for (let i = 3; i < 1024; i += 4) expect(m[i]).toBe(255);
  });

  test('brightness lifts the mid levels and keeps 0 at 0: c′ = mix(c, 1 − (1 − c)⁴, β)', () => {
    const c = lightCurve(8);
    const lifted = 1 - (1 - c) ** 4;
    const row = (beta: number) => texel(at(0.25, beta), 0, 8)[0]!;
    expect(row(0)).toBe(Math.round(255 * c));
    expect(row(1)).toBe(Math.round(255 * lifted));
    expect(row(0.3)).toBe(Math.round(255 * (c + (lifted - c) * 0.3)));
  });
});

describe('createLightmap (SP4a spec §6.4, §6.7)', () => {
  test('a 16 × 16 RGBA8 DataTexture, NoColorSpace, linearly filtered, clamped, no mipmaps', () => {
    const { texture } = createLightmap();
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.minFilter).toBe(LinearFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.wrapS).toBe(ClampToEdgeWrapping);
    expect(texture.wrapT).toBe(ClampToEdgeWrapping);
    expect(texture.image.width).toBe(16);
    expect(texture.image.height).toBe(16);
    expect(texture.image.data).toBeInstanceOf(Uint8Array);
    expect((texture.image.data as Uint8Array).length).toBe(1024);
  });

  test('update rewrites the texture data and flags it for upload', () => {
    const lm = createLightmap();
    const before = lm.texture.version;
    lm.update(dayFactor(0.75), duskFactor(0.75), 0.3);
    expect(lm.texture.version).toBeGreaterThan(before);
    expect(lm.texture.image.data as Uint8Array).toEqual(at(0.75, 0.3));
  });

  test('two times whose day and dusk factors round to the same 1/512 rebuild nothing; a brightness change rebuilds (SP4b spec §3.10)', () => {
    const lm = createLightmap();
    // Noon and 13:00: the sun stands above 10°, so the day factor is 1 and the dusk bump 0 at both.
    const [a, b] = [0.25, 0.25 + 1 / 24];
    expect(Math.round(dayFactor(a) * 512)).toBe(Math.round(dayFactor(b) * 512));
    expect(Math.round(duskFactor(a) * 512)).toBe(Math.round(duskFactor(b) * 512));
    lm.update(dayFactor(a), duskFactor(a), 0.3);
    const v = lm.texture.version;
    lm.update(dayFactor(b), duskFactor(b), 0.3);
    expect(lm.texture.version).toBe(v);
    // Factors 1/2048 apart in the same 1/512 step: 0.5 · 512 = 256 and 256.25 round to 256, 0.25 · 512 = 128 and 128.25 to 128.
    lm.update(0.5, 0.25, 0.3);
    const w = lm.texture.version;
    lm.update(0.5 + 1 / 2048, 0.25 + 1 / 2048, 0.3);
    expect(lm.texture.version).toBe(w);
    lm.update(0.5 + 1 / 2048, 0.25 + 1 / 2048, 0.4);
    expect(lm.texture.version).toBeGreaterThan(w);
    expect(lm.texture.image.data as Uint8Array).toEqual((() => {
      const out = new Uint8Array(1024);
      lightmapRgba(0.5, 0.25, 0.4, out);
      return out;
    })());
  });

  test('a day-factor step of 1/512 rebuilds', () => {
    const lm = createLightmap();
    lm.update(0.5, 0, 0);
    const v = lm.texture.version;
    lm.update(0.5 + 1 / 512, 0, 0);
    expect(lm.texture.version).toBeGreaterThan(v);
  });
});

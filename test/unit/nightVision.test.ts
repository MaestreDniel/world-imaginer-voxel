/**
 * Night vision (SP6a spec §6.2, D15): the eased value the frame hands the lightmap, the lightmap's rebuilds while it
 * eases and after, and the fog's colour input. The frame's ease is `easeNightVision` (`frameStep.ts`), run here as the
 * frame step runs it on each rendered frame, over a real material system's `setFrameUniforms` (no GL context in Node).
 */
import { describe, expect, test } from 'vitest';
import { MEDIUM } from '../../src/core/params/graphicsPresets';
import { dayFactor, duskFactor } from '../../src/daynight/dayNight';
import type { FrameState } from '../../src/render/frameState';
import { lightmapRgba } from '../../src/render/lightmap';
import { FOG_GLSL } from '../../src/render/materials/glsl/common.glsl';
import { createMaterialSystem } from '../../src/render/materials/index';
import { createFlatColorArray } from '../../src/render/textureArray';
import { easeNightVision, NIGHT_VISION_EASE_S } from '../../src/ui/world/frameStep';

const HZ60 = 1000 / 60;
/** Frames of 1000/60 ms in the ease's 0.3 s, and in half of it. */
const EASE_FRAMES = 18;
const HALF_FRAMES = 9;

/** A material system and the page's one frame state at noon (the time fixed, so only nv and β move the lightmap). */
function rig(brightness = 0.3) {
  const materials = createMaterialSystem({ variant: 'batch', ao: true, smoothLight: true }, createFlatColorArray());
  const frame: { -readonly [K in keyof FrameState]: FrameState[K] } = {
    t: 0.25, brightness, eyeSky: 15, rd: 12, fogBand: MEDIUM.fogBand, nightVision: 0,
  };
  materials.setFrameUniforms(frame);
  const texture = materials.lightmap.texture;
  let on = false;
  /** One rendered frame of `dtMs`: the ease, then the frame uniforms; returns the lightmap's rebuilds in it. */
  const step = (dtMs = HZ60): number => {
    const v = texture.version;
    frame.nightVision = easeNightVision(frame.nightVision, on, dtMs);
    materials.setFrameUniforms(frame);
    return texture.version - v;
  };
  return {
    frame, texture, step,
    /** L: the setting flips (the frame eases toward it from the next frame on). */
    press: () => { on = !on; },
    bytes: () => (texture.image.data as Uint8Array).slice(),
  };
}

const expected = (t: number, beta: number, nv: number): Uint8Array => {
  const out = new Uint8Array(1024);
  lightmapRgba(dayFactor(t), duskFactor(t), beta, out, nv);
  return out;
};

describe('night vision (SP6a spec §6.2, D15)', () => {
  test('NIGHT_VISION_EASE_S is 0.3; the ease is linear toward the setting and clamped to [0, 1]', () => {
    expect(NIGHT_VISION_EASE_S).toBe(0.3);
    expect(easeNightVision(0, true, 150)).toBeCloseTo(0.5, 12);
    expect(easeNightVision(0, true, 300)).toBe(1);
    expect(easeNightVision(0.9, true, 1000)).toBe(1);
    expect(easeNightVision(1, true, 16)).toBe(1);
    expect(easeNightVision(1, false, 150)).toBeCloseTo(0.5, 12);
    expect(easeNightVision(0.1, false, 1000)).toBe(0);
    expect(easeNightVision(0, false, 16)).toBe(0);
    // No time, no change.
    expect(easeNightVision(0.25, true, 0)).toBe(0.25);
  });

  test('the eased value is 0, 0.5 and 1 at 0, 0.15 and 0.3 s after L, and back to 0 0.3 s after the second L', () => {
    const r = rig();
    r.press();
    expect(r.frame.nightVision).toBe(0);
    for (let i = 0; i < HALF_FRAMES; i++) r.step();
    expect(r.frame.nightVision).toBeCloseTo(0.5, 12);
    for (let i = HALF_FRAMES; i < EASE_FRAMES; i++) r.step();
    expect(r.frame.nightVision).toBe(1);
    r.step();
    expect(r.frame.nightVision).toBe(1);
    r.press();
    for (let i = 0; i < HALF_FRAMES; i++) r.step();
    expect(r.frame.nightVision).toBeCloseTo(0.5, 12);
    for (let i = HALF_FRAMES; i < EASE_FRAMES; i++) r.step();
    expect(r.frame.nightVision).toBe(0);
  });

  test('the lightmap rebuilds once on each eased frame and on no frame after; the bytes are the eased value\'s, and nv 0 restores the first bytes', () => {
    const r = rig();
    const first = r.bytes();
    // At rest before L: nothing rebuilds.
    for (let i = 0; i < 10; i++) expect(r.step(), `rest ${i}`).toBe(0);
    for (const target of [1, 0]) {
      r.press();
      for (let i = 0; i < EASE_FRAMES; i++) {
        expect(r.step(), `frame ${i} toward ${target}`).toBe(1);
        expect(r.bytes()).toEqual(expected(0.25, 0.3, Math.round(r.frame.nightVision * 512) / 512));
      }
      expect(r.frame.nightVision).toBe(target);
      for (let i = 0; i < 30; i++) expect(r.step(), `after the ease ${i}`).toBe(0);
    }
    expect(r.bytes()).toEqual(first);
  });

  test('a Brightness change mid-ease rides on that frame\'s one rebuild; one at rest after the ease rebuilds once more, then nothing', () => {
    const r = rig(0.3);
    r.press();
    let rebuilds = 0;
    for (let i = 0; i < EASE_FRAMES; i++) {
      // The page writes the frame's brightness when the setting changes (`applySettings`), between two frames.
      if (i === 5) r.frame.brightness = 0.6;
      const n = r.step();
      expect(n, `frame ${i}`).toBe(1);
      rebuilds += n;
      if (i === 5) expect(r.bytes()).toEqual(expected(0.25, 0.6, Math.round(r.frame.nightVision * 512) / 512));
    }
    expect(rebuilds).toBe(EASE_FRAMES);
    expect(r.step()).toBe(0);
    r.frame.brightness = 0.8;
    expect(r.step()).toBe(1);
    expect(r.bytes()).toEqual(expected(0.25, 0.8, 1));
    for (let i = 0; i < 10; i++) expect(r.step()).toBe(0);
  });

  test('the fog follows: its colour input lightmapAt(0, eyeSky) at nv 1 has its brightest channel 255 (eyeSky 0 under ground, at every t and β)', () => {
    expect(FOG_GLSL).toContain('skyGradient(horizonDir) * lightmapAt(0.0, eyeSky)');
    for (let i = 0; i < 24; i++) {
      for (const beta of [0, 0.3, 1]) {
        const m = expected(i / 24, beta, 1);
        for (let sky = 0; sky < 16; sky++) {
          const o = sky * 16 * 4;
          expect(Math.max(m[o]!, m[o + 1]!, m[o + 2]!), `t ${i / 24}, β ${beta}, eyeSky ${sky}`).toBe(255);
        }
        // Under ground (eyeSky 0) the fog's colour is the sky gradient at full strength: (0, 0) is neutral white.
        expect([...m.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
      }
    }
    // Off, (0, 0) is the light floor's grey (Task 22): the fog under ground stays dark.
    const off = expected(0.75, 0.3, 0);
    expect([...off.subarray(0, 4)]).toEqual([10, 10, 10, 255]);
  });
});

import { ClampToEdgeWrapping, DataTexture, LinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType } from 'three';

/**
 * The lightmap (SP4a spec §6.7, master §4.8): a 16 × 16 RGBA8 texture, texel (x = block light, y = sky light), rebuilt
 * on the CPU when the quantised time or the brightness changes (SP4b spec §3.10). The materials look it up per fragment
 * with the smooth light interpolated per vertex, so it is filtered linearly (ruling P10) and stored linear
 * (`NoColorSpace`, §6.4).
 */

const SIZE = 16;
const BYTES = SIZE * SIZE * 4;

/** Night sky tint, the warm dusk tint and the block-light colour (SP4a spec §6.7). */
const NIGHT_TINT = [0.45, 0.55, 0.85] as const;
const DUSK_TINT = [1, 0.8, 0.65] as const;
const BLOCK_TINT = [1, 0.85, 0.65] as const;
/** The sky term's floor at night: curve(s)·mix(0.15, 1, day). */
const NIGHT_SKY = 0.15;

const mix = (a: number, b: number, f: number): number => a + (b - a) * f;

/** The day factor and the dusk bump are quantised to 1/512 before a rebuild (SP4b spec §3.10). */
const STEPS = 512;

/** The light curve of level l ∈ [0, 15]: (l/15) / (3(1 − l/15) + 1); 0 at 0, 1 at 15. */
export function lightCurve(l: number): number {
  const x = l / 15;
  return x / (3 * (1 - x) + 1);
}

/** The sky tint of the current build and the light curve of each level: preallocated, so a rebuild allocates nothing. */
const TINT = new Float64Array(3);
const CURVE = Float64Array.from({ length: SIZE }, (_, l) => lightCurve(l));

/**
 * Fills `out` (1024 bytes) with the lightmap at day factor `day`, dusk bump `dusk` and brightness β. Each texel is the
 * per-channel max of the sky term curve(s)·mix(0.15, 1, day)·tint, tint = mix(mix(night, white, day), warm, dusk), and
 * the block term curve(b)·[1, 0.85, 0.65]; then c′ = mix(c, 1 − (1 − c)⁴, β), stored as round(255c′), alpha 255.
 * The block term does not depend on the time, and (0, 0) stays 0 for every β.
 */
export function lightmapRgba(day: number, dusk: number, brightness: number, out: Uint8Array): void {
  const skyScale = mix(NIGHT_SKY, 1, day);
  const tint = TINT;
  const curve = CURVE;
  for (let c = 0; c < 3; c++) tint[c] = mix(mix(NIGHT_TINT[c]!, 1, day), DUSK_TINT[c]!, dusk) * skyScale;
  for (let sky = 0; sky < SIZE; sky++) {
    for (let block = 0; block < SIZE; block++) {
      const o = (sky * SIZE + block) * 4;
      for (let c = 0; c < 3; c++) {
        const v = Math.max(curve[sky]! * tint[c]!, curve[block]! * BLOCK_TINT[c]!);
        const lifted = 1 - (1 - v) ** 4;
        out[o + c] = Math.round(255 * mix(v, lifted, brightness));
      }
      out[o + 3] = 255;
    }
  }
}

/**
 * The lightmap texture and its updater. It starts at full day with brightness 0 until the first `update`. `update`
 * quantises the day factor and the dusk bump to steps of 1/512 and rewrites the data in place, flagging the texture for
 * upload, only when a step or the brightness changed (SP4b spec §3.10): while time runs it rebuilds a few times a
 * second at most, not every frame. The data is built from the quantised values, so it depends on them alone.
 */
export function createLightmap(): { texture: DataTexture; update(day: number, dusk: number, brightness: number): void } {
  const data = new Uint8Array(BYTES);
  let lastDay = STEPS;
  let lastDusk = 0;
  let lastBrightness = 0;
  lightmapRgba(1, 0, 0, data);
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return {
    texture,
    update(day, dusk, brightness) {
      const qDay = Math.round(day * STEPS);
      const qDusk = Math.round(dusk * STEPS);
      if (qDay === lastDay && qDusk === lastDusk && brightness === lastBrightness) return;
      lastDay = qDay;
      lastDusk = qDusk;
      lastBrightness = brightness;
      lightmapRgba(qDay / STEPS, qDusk / STEPS, brightness, data);
      texture.needsUpdate = true;
    },
  };
}

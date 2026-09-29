/**
 * Rivers (master §3.4 as amended by SP2a spec §2.4). riverTerms is the pure formula; sampleRivers feeds
 * it from the climate: R_z and its ±2-block central-difference gradient in R-warped space, and the width
 * noise u2. Amendment: the valley fades with altitude too (strength s·s_alt), and on high ground the
 * channel becomes a dry gorge cut gorgeDepth below offset0 instead of a valley pulled down to sea level.
 */
import { SEA_LEVEL } from '../../core/constants';
import { detExp, detSmoothstep } from '../../core/detMath';
import { toUniform } from '../../core/noise/cdf';
import type { NormalNoise as NormalNoiseT } from '../../core/noise/normal';
import type { RiverParams } from '../../core/params/schema';
import { noiseFor, type GenContext } from '../context';
import { riverZ, type ClimateOut } from './climate';
import type { ShapeOut } from './shape';

const SEA = SEA_LEVEL;
const EXP = detExp;
const SMOOTH = detSmoothstep;
const U = toUniform;
const NOISE = noiseFor;
const RZ = riverZ;

export interface RiverInput {
  /** R's NormalNoise value and the length of its gradient per world block. */
  Rz: number; gradLen: number;
  /** Width noise mapped to [0, 1]. */
  u2: number;
  C: number; E: number;
  offset0: number; sigma0: number; jag0: number;
}

export interface RiverOut {
  riverDist: number; width: number;
  /** Coastal valley factor s times the altitude channel factor s_alt. */
  riverStrength: number;
  offset: number; sigma: number; jag: number;
  /** Wet channel (river biome, water at sea level) and dry gorge flags. */
  wet: boolean; gorge: boolean;
}

export const newRiver = (): RiverOut => ({ riverDist: 0, width: 0, riverStrength: 0, offset: 0, sigma: 0, jag: 0, wet: false, gorge: false });

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** smoothstep over [lo, hi]; a step at lo when the edges are not ordered (detSmoothstep needs lo < hi). */
const fade = (lo: number, hi: number, x: number): number => (lo < hi ? SMOOTH(lo, hi, x) : x >= lo ? 1 : 0);

export function riverTerms(i: RiverInput, p: RiverParams, out: RiverOut): RiverOut {
  const riverDist = Math.abs(i.Rz) / Math.max(i.gradLen, 1e-4);
  const w = p.widthMin + p.widthVar * i.u2;
  const half = w / 2;
  const valleyWidth = p.valleyBase + p.valleyPerE * (1 + i.E);
  const s = fade(p.coastFadeLo, p.coastFadeHi, i.C);
  const sAlt = 1 - fade(p.altFadeLo, p.altFadeHi, i.offset0);
  const beyond = Math.max(0, riverDist - half);
  // A zero valley width (valleyBase = valleyPerE = 0) is a step at the channel edge instead of 0/0.
  const q = valleyWidth > 0 ? beyond / valleyWidth : 0;
  const t = valleyWidth > 0 ? 1 - EXP(-(q * q)) : beyond > 0 ? 1 : 0;
  const valleyOffset = lerp(Math.min(i.offset0, p.valleyFloor + p.valleyRise * t), i.offset0, t);
  const sv = s * sAlt;
  const f = 1 - sv * (1 - t);
  let offset = lerp(i.offset0, valleyOffset, sv);
  let sigma = i.sigma0 * f;
  let jag = i.jag0 * f;
  const depth = p.depthMin + p.depthVar * i.u2;
  if (riverDist < half) {
    const r = (2 * riverDist) / w;
    const profile = 1 - r * r;
    const channelOffset = SEA - depth * profile;
    const gorgeOffset = i.offset0 - p.gorgeDepth * profile;
    offset = Math.min(offset, lerp(gorgeOffset, channelOffset, sAlt));
    sigma = 0.5;
    jag = 0;
  }
  const centre = lerp(i.offset0 - p.gorgeDepth, SEA - depth, sAlt);
  const wet = riverDist < half + p.wetMargin && centre <= SEA - 1;
  out.riverDist = riverDist;
  out.width = w;
  out.riverStrength = s * sAlt;
  out.offset = offset;
  out.sigma = sigma;
  out.jag = jag;
  out.wet = wet;
  out.gorge = riverDist < half && !wet;
  return out;
}

const INPUT: RiverInput = { Rz: 0, gradLen: 0, u2: 0, C: 0, E: 0, offset0: 0, sigma0: 0, jag0: 0 };
const WIDTH = new WeakMap<GenContext, NormalNoiseT>();

function widthNoise(ctx: GenContext): NormalNoiseT {
  let n = WIDTH.get(ctx);
  if (n === undefined) { n = NOISE(ctx, 'rivers.widthNoise'); WIDTH.set(ctx, n); }
  return n;
}

/** Rivers at a point whose climate and shape are already known. */
export function sampleRivers(ctx: GenContext, c: ClimateOut, s: ShapeOut, out: RiverOut): RiverOut {
  const h = 2 / ctx.scale;
  const gx = (RZ(ctx, c.xr + h, c.zr) - RZ(ctx, c.xr - h, c.zr)) / 4;
  const gz = (RZ(ctx, c.xr, c.zr + h) - RZ(ctx, c.xr, c.zr - h)) / 4;
  const input = INPUT;
  input.Rz = c.Rz;
  input.gradLen = Math.sqrt(gx * gx + gz * gz);
  input.u2 = (U(widthNoise(ctx).z2(c.xr, c.zr)) + 1) / 2;
  input.C = c.C;
  input.E = c.E;
  input.offset0 = s.offset0;
  input.sigma0 = s.sigma0;
  input.jag0 = s.jag0;
  return riverTerms(input, ctx.params.rivers, out);
}

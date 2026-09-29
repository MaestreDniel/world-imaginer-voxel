/**
 * GenContext (master §3.0, SP2a spec §2): everything a worker derives once per (seed, params) epoch.
 * Pure data plus prepared NormalNoises and compiled splines; no DOM, no worker APIs.
 */
import { deriveSeed, type Seed64 } from '../core/hash';
import { uMax as uMaxOf } from '../core/noise/cdf';
import { NormalNoise } from '../core/noise/normal';
import type { NormalNoise as NormalNoiseT } from '../core/noise/normal';
import { BOX_BIOMES } from '../core/params/biomeDefaults';
import { BOX_AXES } from '../core/params/kit';
import { noiseInstances } from '../core/params/noises';
import { SCHEMA, type Params } from '../core/params/schema';
import { compileSpline, type CompiledSpline } from '../core/spline/hermite';

const DERIVE = deriveSeed;
const U_MAX = uMaxOf;
const Normal = NormalNoise;
const NOISES = noiseInstances;
const COMPILE = compileSpline;
const AXES = BOX_AXES;
const BIOMES = BOX_BIOMES;
const SCHEMA_ = SCHEMA;

export interface GenContext {
  readonly seed: Seed64;
  readonly params: Params;
  /** climate.scaleMul (divides world coordinates before the climate stage). */
  readonly scale: number;
  /** Largest |u| of a clamped climate field (uMax(clampSigma) of climate.C). */
  readonly uLimit: number;
  readonly noise: ReadonlyMap<string, NormalNoiseT>;
  readonly offset: CompiledSpline;
  readonly sigma: CompiledSpline;
  readonly jag: CompiledSpline;
  /** Box-picked biomes in BOX_BIOMES order, compiled from params.biomes.table. */
  readonly boxes: readonly CompiledBox[];
  readonly lakeSeed: number;
  readonly zoomSeed: number;
}

/** A biome box with its axes in BOX_AXES order (C, E, PV, T, H). */
export interface CompiledBox {
  readonly index: number;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly wSign: number;
  readonly priority: number;
}

function noiseOf(ctx: { noise: ReadonlyMap<string, NormalNoiseT> }, name: string): NormalNoiseT {
  const n = ctx.noise.get(name);
  if (n === undefined) throw new Error(`no schema noise ${name}`);
  return n;
}

export function createGenContext(seed: Seed64, params: Params): GenContext {
  const noise = new Map<string, NormalNoiseT>();
  for (const inst of NOISES(SCHEMA_, params)) noise.set(inst.seedName, new Normal(seed, inst.seedName, inst.def));
  const table = params.biomes.table;
  const boxes: CompiledBox[] = BIOMES.map((name, index) => {
    const row = table[name];
    return { index, lo: Float64Array.from(AXES, (a) => row[a][0]), hi: Float64Array.from(AXES, (a) => row[a][1]), wSign: row.wSign, priority: row.priority };
  });
  const ctx: GenContext = {
    seed, params, scale: params.climate.scaleMul, uLimit: U_MAX(params.climate.C.clampSigma), noise,
    offset: COMPILE(params.shape.offset), sigma: COMPILE(params.shape.sigma), jag: COMPILE(params.shape.jag),
    boxes, lakeSeed: DERIVE(seed, 'lakes.cells'), zoomSeed: DERIVE(seed, 'biomes.zoom'),
  };
  noiseOf(ctx, 'climate.C');
  return ctx;
}

/** The prepared NormalNoise of a schema noise instance (throws on an unknown seed name). */
export const noiseFor = noiseOf;

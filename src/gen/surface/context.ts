/**
 * SurfaceContext (SP3c spec §3.6): what the surface rules of one GenContext need, built once per context.
 * - `density`: its own DensityContext (the T stage's memo becomes this one's in the surface-pass task);
 * - `noises`: the GenContext's schema noises `surface.noises.<id>` as a SurfaceNoiseSource keyed by schema path (the
 *   names a `noiseThreshold` uses), each a dims-2 NormalNoise with remap and clampSigma from its leaf;
 * - `settings`: the scan settings (`surfaceScanSettings(seed, params.surface, noises)`: the depth noise, the depth
 *   hash seed, depthMul, lapse, lapseBase, SD_MAX);
 * - `bands`: the badlands band table of the world seed (§3.3, bands.ts), built once and shared by both evaluators;
 * - `compiled` and `reference`: the tree (by default `defaultSurfaceRules(params.surface)`) compiled for those
 *   settings, and its reference evaluator (validated once each; a RuleValidationError otherwise);
 * - `probeColumn`: the one-column cache of the last column `surfaceProbe` rebuilt (probe.ts).
 * `surfaceContextOf(ctx)` memoises the default
 * SurfaceContext per GenContext (a WeakMap); `createSurfaceContext(ctx)` builds one apart (DT2 uses it, so a
 * shared-state bug cannot hide). Follows the gen determinism rules.
 */
import type { NormalNoise } from '../../core/noise/normal';
import { SCHEMA, type SurfaceParams } from '../../core/params/schema';
import { noiseFor, type GenContext } from '../context';
import { createDensityContext, type DensityContext } from '../density/context';
import { bandlandsTable } from './bands';
import { compileSurfaceRules, type CompiledSurfaceRules } from './compile';
import { defaultSurfaceRules } from './defaults';
import { createSurfaceReference, type SurfaceReference } from './reference';
import type { Rule, SurfaceNoise, SurfaceNoiseSource } from './rules';
import { newSurfaceScan, surfaceScanSettings, type SurfaceScan, type SurfaceScanSettings } from './scan';

const SCHEMA_ = SCHEMA;
const NOISE_FOR = noiseFor;
const CREATE_DC = createDensityContext;
const COMPILE = compileSurfaceRules;
const REFERENCE = createSurfaceReference;
const DEFAULT_RULES = defaultSurfaceRules;
const SETTINGS = surfaceScanSettings;
const NEW_SCAN = newSurfaceScan;
const BAND_TABLE = bandlandsTable;

/** The schema path prefix of the surface noises. */
const PREFIX = 'surface.noises.';

/**
 * One rebuilt column of the probe (§3.6): its solidity and water (98,304 entries each, index `256·(y + 64) + p`, the
 * T stage's density fill and water v0), its 256-entry surface biome buffer and its scan; `cx`, `cz` name it while
 * `valid` is true.
 */
export interface SurfaceProbeColumn {
  cx: number;
  cz: number;
  valid: boolean;
  readonly solid: Uint8Array;
  readonly water: Uint8Array;
  readonly biomes: Uint8Array;
  readonly scan: SurfaceScan;
}

export interface SurfaceContext {
  readonly ctx: GenContext;
  readonly params: SurfaceParams;
  readonly density: DensityContext;
  readonly noises: SurfaceNoiseSource;
  readonly settings: SurfaceScanSettings;
  /** The badlands band table (192 state ids, §3.3) of the context's seed. */
  readonly bands: Uint16Array;
  /** The validated rule tree. */
  readonly rules: Rule;
  readonly compiled: CompiledSurfaceRules;
  readonly reference: SurfaceReference;
  readonly probeColumn: SurfaceProbeColumn;
}

/** Wraps a NormalNoise as a SurfaceNoise of `dims` (z2 in [−clampSigma, clampSigma], unscaled coordinates). */
export function surfaceNoiseOf(n: NormalNoise, dims: 2 | 3): SurfaceNoise {
  return { dims, remap: n.def.remap, clampSigma: n.clamp, z2: (x, z) => n.z2(x, z) };
}

/**
 * The GenContext's surface noises: schema path `surface.noises.<id>` → its prepared NormalNoise with the leaf's dims
 * (validateRules and the scan refuse a 3D one); any other name gives undefined.
 */
export function surfaceNoiseSource(ctx: GenContext): SurfaceNoiseSource {
  const m = new Map<string, SurfaceNoise>();
  for (const { path, leaf } of SCHEMA_.leaves) {
    if (leaf.kind !== 'noise' || !path.startsWith(PREFIX)) continue;
    m.set(path, surfaceNoiseOf(NOISE_FOR(ctx, path), leaf.dims ?? 2));
  }
  return (name) => m.get(name);
}

/**
 * A SurfaceContext for `ctx` over `rules` (default: §4's tree from `ctx.params.surface`), with its own
 * DensityContext. Throws a RuleValidationError when `rules` is not a valid tree for the schema's surface noises.
 */
export function createSurfaceContext(ctx: GenContext, rules: unknown = DEFAULT_RULES(ctx.params.surface)): SurfaceContext {
  const params = ctx.params.surface;
  const noises = surfaceNoiseSource(ctx);
  const settings = SETTINGS(ctx.seed, params, noises);
  const bands = BAND_TABLE(ctx.seed);
  const compiled = COMPILE(ctx.seed, rules, noises, settings, bands);
  const reference = REFERENCE(ctx.seed, rules, noises, bands);
  return {
    ctx, params, density: CREATE_DC(ctx), noises, settings, bands, rules: compiled.rules, compiled, reference,
    probeColumn: {
      cx: 0, cz: 0, valid: false,
      solid: new Uint8Array(98304), water: new Uint8Array(98304), biomes: new Uint8Array(256), scan: NEW_SCAN(),
    },
  };
}

const SCS = new WeakMap<GenContext, SurfaceContext>();

/** The SurfaceContext of `ctx` over the default tree, built on first use and memoised per GenContext. */
export function surfaceContextOf(ctx: GenContext): SurfaceContext {
  let sc = SCS.get(ctx);
  if (sc === undefined) {
    sc = createSurfaceContext(ctx);
    SCS.set(ctx, sc);
  }
  return sc;
}

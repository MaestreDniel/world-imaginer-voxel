/**
 * U2, parameter liveness (SP2b spec §7, master §6.4): every leaf of the climate, shape, biome2d and terrain stages,
 * moved by its per-kind ±15 % perturbation, must change its home stage's output hash on one of the class columns or on
 * a witness (seed 42, default profile). SP2b's 16 class columns are chosen by the lattice conditions under which the
 * leaves act; lake-gate leaves (lakes.p, minC, offsetMin, offsetMax) get one threshold column each. SP3c's surface
 * class columns (SP3c spec §3.5: cliffY, cliffSteep, snowline, patch) are found by a third pass, after SP2b's two:
 * a corner prefilter on the ColumnSample, then an acceptance check on the generated column (every leaf the slot
 * serves changes the reference evaluator's state of a voxel near a sky-open top). A `terrain` leaf (SP3b spec §3.3:
 * the `density.*` group; SP3c: the `surface.*` group) is tried on the land, coast and surface class columns only (its
 * intended class first), with no witness search: its output is a whole generated column. Follows the core
 * determinism rules (DET_FILES in test/arch/rules/banned.ts).
 */
import { SEA_LEVEL } from '../core/constants';
import { hash4, hashF64, hex64 } from '../core/hash';
import type { NoiseDef } from '../core/noise/types';
import { canonicalJSON, q15 } from '../core/params/canonical';
import { applyPatch, BOX_AXES, getPath, patchAt, type BoxTable, type LeafInfo } from '../core/params/kit';
import { resolveProfile } from '../core/params/profiles';
import { SCHEMA, type LakeParams, type Params } from '../core/params/schema';
import { seedFromInput } from '../core/seed';
import type { NestedSpline } from '../core/spline/types';
import { createGenContext, noiseFor, type GenContext } from '../gen/context';
import { newClimate, sampleClimate } from '../gen/column/climate';
import { newPointRecord, samplePoint, waterLevel } from '../gen/column/columnPoint';
import { buildColumnSample, latticeIndex, newColumnSample, readBiome, type ColumnSample } from '../gen/column/columnStage';
import { cellEligible, lakeCell, lakeSpace, nearestCell, newLake, sampleLakes, type CellProbe, type LakeCell } from '../gen/column/lakes';
import { newRiver, sampleRivers } from '../gen/column/rivers';
import { newShape, sampleShape } from '../gen/column/shape';
import { biomeId, type SurfaceBiome } from '../gen/biomes/registry';
import { createSurfaceContext, surfaceContextOf, type SurfaceContext } from '../gen/surface/context';
import { surfaceProbeColumn } from '../gen/surface/probe';
import { newSurfaceScan, scanColumn, type SurfaceScan } from '../gen/surface/scan';
import { createStore } from '../world/store/store';
import { samplePoints } from './noiseStats';
import { fillColumnT, regionHash } from './region';

const SEA = SEA_LEVEL;
const H4 = hash4;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const CANON = canonicalJSON;
const Q15 = q15;
const APPLY = applyPatch;
const AXES = BOX_AXES;
const GET = getPath;
const PATCH_AT = patchAt;
const RESOLVE = resolveProfile;
const SCHEMA_ = SCHEMA;
const SEED = seedFromInput;
const CREATE = createGenContext;
const NOISE = noiseFor;
const CLIMATE = sampleClimate;
const NEW_CLIMATE = newClimate;
const POINT = samplePoint;
const NEW_POINT = newPointRecord;
const WATER = waterLevel;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const READ_BIOME = readBiome;
const ELIGIBLE = cellEligible;
const CELL = lakeCell;
const LAKE_SPACE = lakeSpace;
const NEAREST = nearestCell;
const NEW_LAKE = newLake;
const LAKES = sampleLakes;
const NEW_RIVER = newRiver;
const RIVERS = sampleRivers;
const NEW_SHAPE = newShape;
const SHAPE = sampleShape;
const POINTS = samplePoints;
const CREATE_STORE = createStore;
const FILL_T = fillColumnT;
const REGION_HASH = regionHash;
const LATTICE = latticeIndex;
const BIOME_ID = biomeId;
const SURFACE_CONTEXT = surfaceContextOf;
const CREATE_SURFACE = createSurfaceContext;
const PROBE_COLUMN = surfaceProbeColumn;
const NEW_SCAN = newSurfaceScan;
const SCAN_COLUMN = scanColumn;

/** SP3c's surface class slots (SP3c spec §3.5), in the order a third-pass column is offered to them. */
export const SURFACE_CLASSES = ['cliffY', 'cliffSteep', 'snowline', 'patch'] as const;
export type SurfaceClass = (typeof SURFACE_CLASSES)[number];

export type LivenessClass =
  | 'land' | 'coast' | 'channel' | 'gorge' | 'basin' | 'rim'
  | 'threshold:lakes.p' | 'threshold:lakes.minC' | 'threshold:lakes.offsetMin' | 'threshold:lakes.offsetMax'
  | SurfaceClass;

export interface LivenessColumn { readonly cx: number; readonly cz: number; readonly cls: LivenessClass }

/** The stages whose leaves U2 covers: the column scope, and the T stage (SP3b spec §3.3). */
export type OutputStage = 'climate' | 'shape' | 'biome2d' | 'terrain';

/**
 * One leaf's verdict. `via` names the deciding column (a class column or a witness); `cls` is that column's
 * class, null for a witness, and for a dead leaf the class meant to exercise it.
 */
export interface LivenessResult { readonly path: string; readonly live: boolean; readonly via: string | null; readonly cls: string | null }

const STREAM = 'sp2b.liveness';
const STREAM_N = 200000;
const WITNESS_CELLS = 16384;
const WITNESS_COLUMNS = 2048;
/** The ±15 % of master §6.4. */
const STEP = 0.15;
const TO_UNIT = 1 / 4294967296;
/** "No water within 64 blocks": a 16-block grid from 64 blocks before the column to 64 blocks after it. */
const LAND_REACH = 64;
const LAND_GRID = 16;
/** Largest distance from the column centre (x0 + 8) to a lattice point, per axis. */
const LATTICE_REACH = 12;
/** Coast columns: a lattice point with |offset0 − 63| ≤ 8. */
const COAST_BAND = 8;
const OUTPUT_STAGES: readonly string[] = ['climate', 'shape', 'biome2d', 'terrain'];
/** The class columns a `terrain` leaf is tried on (SP3b spec §3.3, SP3c spec §3.5). */
const TERRAIN_CLASSES: readonly LivenessClass[] = ['land', 'coast', ...SURFACE_CLASSES];
/** One column's store: ≤ 24 dense block sections (1 MiB holds 128) and ≤ 26 byte slots (1 MiB holds 256). */
const STORE_BYTES = 1 << 20;
const CLASS_ORDER: readonly LivenessClass[] = [
  'land', 'coast', 'channel', 'gorge', 'basin', 'rim',
  'threshold:lakes.p', 'threshold:lakes.minC', 'threshold:lakes.offsetMin', 'threshold:lakes.offsetMax',
  ...SURFACE_CLASSES,
];
const GATE_KEYS = ['p', 'minC', 'offsetMin', 'offsetMax'] as const;
type GateKey = (typeof GATE_KEYS)[number];

/** Leaves whose effect needs a particular class; every other leaf is meant for its group's class below. */
const LEAF_CLASS: ReadonlyMap<string, LivenessClass> = new Map<string, LivenessClass>([
  ['lakes.p', 'threshold:lakes.p'], ['lakes.minC', 'threshold:lakes.minC'],
  ['lakes.offsetMin', 'threshold:lakes.offsetMin'], ['lakes.offsetMax', 'threshold:lakes.offsetMax'],
  ['lakes.rimWidth', 'rim'], ['lakes.rimRise', 'rim'], ['lakes.rimSigma', 'rim'],
  ['rivers.gorgeDepth', 'gorge'], ['rivers.altFadeLo', 'gorge'], ['rivers.altFadeHi', 'gorge'],
  ['rivers.coastFadeLo', 'coast'], ['rivers.coastFadeHi', 'coast'],
  ['surface.cliffMinY', 'cliffY'], ['surface.cliffSteep', 'cliffSteep'],
  ['surface.snowline', 'snowline'], ['surface.lapse', 'snowline'], ['surface.lapseBase', 'snowline'],
  ['surface.noises.patch', 'patch'], ['surface.patchThreshold', 'patch'],
]);

/** The class whose columns are meant to exercise a leaf (named when the leaf is dead). */
export function intendedClass(path: string): LivenessClass {
  const c = LEAF_CLASS.get(path);
  if (c !== undefined) return c;
  if (path.startsWith('lakes.')) return 'basin';
  if (path.startsWith('rivers.')) return 'channel';
  return 'land';
}

const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function leafInfo(path: string): LeafInfo {
  const info = SCHEMA_.leaves.find((l) => l.path === path);
  if (info === undefined) throw new Error(`no schema leaf ${path}`);
  return info;
}

// ---------------------------------------------------------------- perturbations

function numberSteps(v: number, min: number, max: number, int: boolean): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('U2 needs a finite range for number leaves');
  const size = (s: number): number => (int ? Math.max(1, Math.round(s)) : s);
  const out: number[] = [];
  for (const dir of [-1, 1]) {
    let x = v + dir * size(STEP * Math.abs(v));
    if (v === 0 || x < min || x > max) x = v + dir * size(STEP * (max - min));
    out.push(clampTo(Q15(x), min, max));
  }
  return out;
}

function shiftKnots(s: NestedSpline, dy: number, lo: number, hi: number): NestedSpline {
  return {
    coord: s.coord,
    points: s.points.map((p) => ({ x: p.x, y: typeof p.y === 'number' ? clampTo(Q15(p.y + dy), lo, hi) : shiftKnots(p.y, dy, lo, hi), d: p.d })),
  };
}

/** dir −1 shrinks every interval by 15 % of its width towards its centre, +1 grows it (clamped to [−1, 1]). */
function scaleBoxes(t: BoxTable, dir: number): BoxTable {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(t)) {
    const row = t[name]!;
    const r: Record<string, unknown> = { wSign: row.wSign, priority: row.priority };
    for (const a of AXES) {
      const [lo, hi] = row[a];
      const d = (dir * STEP * (hi - lo)) / 2;
      r[a] = [clampTo(Q15(lo - d), -1, 1), clampTo(Q15(hi + d), -1, 1)];
    }
    out[name] = r;
  }
  return out as BoxTable;
}

/**
 * The perturbed values of a leaf (spec §7), each valid for the leaf; values equal to `value` or to each other
 * are dropped. number/int: v ± 15 % of |v|, or ± 15 % of the range span when v is 0 or the step leaves the
 * range (at least 1 for int), clamped; noise: wavelength × 0.85 and × 1.15 within its range; spline: every
 * numeric knot moved by ±15 % of the y span, clamped; boxTable: every interval shrunk and grown by 15 % of its width.
 */
export function perturbations(leaf: LeafInfo, value: unknown): unknown[] {
  const l = leaf.leaf;
  const lo = l.min ?? -Infinity;
  const hi = l.max ?? Infinity;
  let values: unknown[];
  switch (l.kind) {
    case 'number':
    case 'int':
      values = numberSteps(value as number, lo, hi, l.kind === 'int');
      break;
    case 'noise': {
      const d = value as NoiseDef;
      values = [1 - STEP, 1 + STEP].map((f) => ({ ...d, wavelength: clampTo(Q15(d.wavelength * f), lo, hi) }));
      break;
    }
    case 'spline':
      values = [-1, 1].map((dir) => shiftKnots(value as NestedSpline, dir * STEP * (hi - lo), lo, hi));
      break;
    case 'boxTable':
      values = [-1, 1].map((dir) => scaleBoxes(value as BoxTable, dir));
      break;
    default:
      throw new Error(`U2 has no perturbation for ${leaf.path} (kind ${l.kind})`);
  }
  const seen = new Set<string>([CANON(value)]);
  return values.filter((v) => {
    const k = CANON(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function withLeaf(params: Params, path: string, value: unknown): Params {
  const r = APPLY(SCHEMA_, params, PATCH_AT(path, value));
  if (!r.ok) throw new Error(`U2 perturbation of ${path} is invalid: ${r.issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
  return r.value;
}

function variantContexts(base: GenContext, info: LeafInfo): GenContext[] {
  return perturbations(info, GET(base.params, info.path)).map((v) => CREATE(base.seed, withLeaf(base.params, info.path, v)));
}

// ---------------------------------------------------------------- stage output hashes

const SAMPLE: ColumnSample = NEW_SAMPLE();

function digest(parts: readonly (Float64Array | Uint8Array)[]): string {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) for (let k = 0; k < p.length; k++) out[o++] = p[k]!;
  return HEX64(HASH_F64(out));
}

function hashSample(ctx: GenContext, stage: OutputStage, s: ColumnSample): string {
  const f = s.f;
  if (stage === 'climate') return digest([f.C, f.E, f.W, f.T, f.H, f.R, f.PV]);
  if (stage === 'shape') {
    return digest([f.offset0, f.sigma0, f.jag0, f.offset, f.sigma, f.jag, f.riverDist, f.riverStrength, s.flags,
      f.lakeMask, f.lakeLevel, f.lakeFloor, f.surfaceWaterLevel, f.surfaceEst]);
  }
  const blocks = new Uint8Array(256);
  for (let bz = 0; bz < 16; bz++) for (let bx = 0; bx < 16; bx++) blocks[16 * bz + bx] = READ_BIOME(s, ctx, 16 * s.cx + bx, 16 * s.cz + bz);
  return digest([s.biome, blocks]);
}

const NEVER = (): boolean => false;

/** SP3b spec §3.3: `regionHash` of the 1 × 1 window after `fillColumnT` on a fresh `ArrayBuffer` store. */
function terrainHash(ctx: GenContext, cx: number, cz: number): string {
  const store = CREATE_STORE({ shared: false, maxBlockBytes: STORE_BYTES, maxByteBytes: STORE_BYTES });
  if (!FILL_T(store, ctx, cx, cz, NEVER)) throw new Error(`U2: column (${cx}, ${cz}) was not generated`);
  return HEX64(REGION_HASH(store, cx, cz, 1, 1));
}

/**
 * Hex digest of a stage's own outputs on column (cx, cz) (spec §7): climate C, E, W, T, H, R, PV at the 49
 * lattice points; shape offset0 … surfaceEst and the river flags; biome2d the lattice biome ids plus the
 * zoomed biome of each of the column's 256 blocks (where biomes.zoomJitter acts); terrain the region hash of the
 * generated column (blocks, fluid, aux A and aux B; SP3b spec §3.3).
 */
export function stageOutputHash(ctx: GenContext, stage: OutputStage, cx: number, cz: number): string {
  if (stage === 'terrain') return terrainHash(ctx, cx, cz);
  return hashSample(ctx, stage, BUILD(ctx, cx, cz, SAMPLE));
}

// ---------------------------------------------------------------- lake cells

const cellRoll = (ctx: GenContext, i: number, j: number): number => H4(ctx.lakeSeed, 2, i, j) * TO_UNIT;
const PC = NEW_CLIMATE();
const PS = NEW_SHAPE();
const PR = NEW_RIVER();
const PCO = new Float64Array(6);

/** The eligibility probe of a lake cell, computed as lakeCell computes it (a unit test pins the equality). */
export function cellProbe(ctx: GenContext, cell: LakeCell): CellProbe {
  const c = CLIMATE(ctx, cell.cx, cell.cz, PC);
  const s = SHAPE(ctx, c, PCO, PS);
  const r = RIVERS(ctx, c, s, PR);
  const rp = ctx.params.rivers;
  return { C: c.C, offset0: s.offset0, riverDist: r.riverDist, valleyWidth: rp.valleyBase + rp.valleyPerE * (1 + c.E), wet: r.wet, roll: cellRoll(ctx, cell.i, cell.j) };
}

interface Gate {
  readonly cls: LivenessClass;
  readonly path: string;
  readonly values: readonly number[];
  readonly variants: readonly LakeParams[];
}

function gatesOf(params: Params): Gate[] {
  return GATE_KEYS.map((key: GateKey) => {
    const path = `lakes.${key}`;
    const values = perturbations(leafInfo(path), params.lakes[key]) as number[];
    return { cls: `threshold:${path}` as LivenessClass, path, values, variants: values.map((v) => ({ ...params.lakes, [key]: v })) };
  });
}

/** 1: eligible now and not under one of the gate's variants (the band a variant closes); 2: the reverse; 0: neither. */
function bandOf(g: Gate, probe: CellProbe, base: LakeParams): number {
  const now = ELIGIBLE(probe, base);
  for (const v of g.variants) if (ELIGIBLE(probe, v) !== now) return now ? 1 : 2;
  return 0;
}

/**
 * Visits every lake cell whose lake can reach a lattice point of column (cx, cz): a lake reaches lake-space
 * distance radius·(1 + rimWidth + roughness) at most, the lake warp moves a point by warpAmp·clamp per axis,
 * and a cell's jittered centre stays inside its cell. Stops at the first visit that returns true.
 */
function someReachableCell(ctx: GenContext, cx: number, cz: number, visit: (i: number, j: number) => boolean): boolean {
  const p = ctx.params.lakes;
  const clamp = Math.max(NOISE(ctx, 'lakes.warpNoise.x').clamp, NOISE(ctx, 'lakes.warpNoise.z').clamp);
  const reach = p.radius * (1 + p.rimWidth + p.roughness) + (p.warpAmp * clamp + LATTICE_REACH) * Math.SQRT2;
  const xc = 16 * cx + 8;
  const zc = 16 * cz + 8;
  const i1 = Math.floor((xc + reach) / p.cell);
  const j1 = Math.floor((zc + reach) / p.cell);
  for (let j = Math.floor((zc - reach) / p.cell); j <= j1; j++) {
    for (let i = Math.floor((xc - reach) / p.cell); i <= i1; i++) {
      const dx = Math.max(i * p.cell - xc, 0, xc - (i + 1) * p.cell);
      const dz = Math.max(j * p.cell - zc, 0, zc - (j + 1) * p.cell);
      if (dx * dx + dz * dz <= reach * reach && visit(i, j)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- class columns

interface Lattice {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly offset0: Float64Array;
  readonly riverDist: Float64Array;
  /** Channel half-width w/2 at the point. */
  readonly half: Float64Array;
  readonly strength: Float64Array;
  /** Offset after rivers, before the lake step. */
  readonly pre: Float64Array;
  readonly mask: Float64Array;
  /** 1 where the surface holds water (sea, river or lake). */
  readonly water: Uint8Array;
}

const newLattice = (): Lattice => ({
  x: new Float64Array(49), z: new Float64Array(49), offset0: new Float64Array(49), riverDist: new Float64Array(49), half: new Float64Array(49),
  strength: new Float64Array(49), pre: new Float64Array(49), mask: new Float64Array(49), water: new Uint8Array(49),
});

const LC = NEW_CLIMATE();
const LS = NEW_SHAPE();
const LR = NEW_RIVER();
const LL = NEW_LAKE();
const LCO = new Float64Array(6);
const REC = NEW_POINT();

/** The 7 × 7 lattice of ColumnSample (same functions, same order), with the channel width and the pre-lake offset. */
function evalLattice(ctx: GenContext, cx: number, cz: number, out: Lattice): Lattice {
  let k = 0;
  for (let j = -1; j <= 5; j++) {
    for (let i = -1; i <= 5; i++, k++) {
      const x = 16 * cx + 4 * i;
      const z = 16 * cz + 4 * j;
      const c = CLIMATE(ctx, x, z, LC);
      const s = SHAPE(ctx, c, LCO, LS);
      const r = RIVERS(ctx, c, s, LR);
      const l = LAKES(ctx, x, z, r.offset, r.sigma, r.jag, LL);
      out.x[k] = x;
      out.z[k] = z;
      out.offset0[k] = s.offset0;
      out.riverDist[k] = r.riverDist;
      out.half[k] = r.width / 2;
      out.strength[k] = r.riverStrength;
      out.pre[k] = r.offset;
      out.mask[k] = l.lakeMask;
      out.water[k] = WATER(l.offset, r.wet, l.lakeMask, l.lakeLevel) > -Infinity ? 1 : 0;
    }
  }
  return out;
}

function f1Cell(ctx: GenContext, L: Lattice, k: number): LakeCell {
  const [xl, zl] = LAKE_SPACE(ctx, L.x[k]!, L.z[k]!);
  return NEAREST(ctx, xl, zl).cell;
}

const hasCoast = (L: Lattice): boolean => L.offset0.some((o) => Math.abs(o - SEA) <= COAST_BAND);

function hasChannel(ctx: GenContext, L: Lattice): boolean {
  const lo = ctx.params.rivers.altFadeLo;
  for (let k = 0; k < 49; k++) {
    const o = L.offset0[k]!;
    if (L.riverDist[k]! < L.half[k]! && L.strength[k]! > 0 && o >= SEA && o < lo) return true;
  }
  return false;
}

/** A land lattice point in the band where ±15 % of wetMargin flips the wet flag. */
function hasWetBand(ctx: GenContext, L: Lattice): boolean {
  const m = ctx.params.rivers.wetMargin;
  for (let k = 0; k < 49; k++) {
    const d = L.riverDist[k]!;
    const h = L.half[k]!;
    if (L.offset0[k]! >= SEA && d >= h + (1 - STEP) * m && d < h + (1 + STEP) * m) return true;
  }
  return false;
}

function hasGorge(ctx: GenContext, L: Lattice): boolean {
  const p = ctx.params.rivers;
  for (let k = 0; k < 49; k++) {
    const o = L.offset0[k]!;
    if (L.riverDist[k]! < L.half[k]! && o > p.altFadeLo && o < p.altFadeHi) return true;
  }
  return false;
}

const hasBasin = (L: Lattice): boolean => L.mask.some((m) => m === 1);

/** A rim point on the downhill side, where rimRise acts: pre-lake offset below Lw + 0.85·rimRise + 3·rimSigma. */
function hasRim(ctx: GenContext, L: Lattice): boolean {
  const p = ctx.params.lakes;
  for (let k = 0; k < 49; k++) {
    const m = L.mask[k]!;
    if (m > 0 && m < 1 && L.pre[k]! < f1Cell(ctx, L, k).Lw + (1 - STEP) * p.rimRise + 3 * p.rimSigma) return true;
  }
  return false;
}

/** Band 1: a lake point whose F1 cell a variant disables. Band 2: a point that a variant's newly enabled F1 cell reaches. */
function hasGate(ctx: GenContext, L: Lattice, g: Gate, band: number, variantCtx: (v: number) => GenContext): boolean {
  const base = ctx.params.lakes;
  for (let k = 0; k < 49; k++) {
    if (band === 1 && !(L.mask[k]! > 0)) continue;
    const probe = cellProbe(ctx, f1Cell(ctx, L, k));
    if (bandOf(g, probe, base) !== band) continue;
    if (band === 1) return true;
    for (let v = 0; v < g.variants.length; v++) {
      if (ELIGIBLE(probe, g.variants[v]!) && LAKES(variantCtx(v), L.x[k]!, L.z[k]!, L.pre[k]!, 0, 0, LL).lakeMask > 0) return true;
    }
  }
  return false;
}

/** No water within 64 blocks: dry lattice, and every point of the 16-block grid dry and clear of the widest wet channel. */
function isLand(ctx: GenContext, L: Lattice, cx: number, cz: number): boolean {
  if (L.water.some((w) => w === 1)) return false;
  const rv = ctx.params.rivers;
  const clear = (rv.widthMin + rv.widthVar) / 2 + rv.wetMargin + (LAND_GRID / 2) * Math.SQRT2;
  const n = (2 * LAND_REACH + 16) / LAND_GRID;
  for (let b = 0; b <= n; b++) {
    for (let a = 0; a <= n; a++) {
      const p = POINT(ctx, 16 * cx - LAND_REACH + LAND_GRID * a, 16 * cz - LAND_REACH + LAND_GRID * b, false, REC);
      if (p.surfaceWaterLevel > -Infinity || p.riverDist < clear) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- SP3c surface class columns

/** The leaves each surface slot serves (SP3c spec §3.5); its acceptance check requires every one of them to act. */
const SURFACE_SLOT_LEAVES: Readonly<Record<SurfaceClass, readonly string[]>> = {
  cliffY: ['surface.cliffMinY'],
  cliffSteep: ['surface.cliffSteep'],
  snowline: ['surface.snowline', 'surface.lapse', 'surface.lapseBase'],
  patch: ['surface.noises.patch', 'surface.patchThreshold'],
};
/** The 2D biomes whose tops have patches in the default tree (SP3c spec §3.5 `patch` prefilter). */
const PATCH_BIOMES: readonly SurfaceBiome[] = [
  'taiga', 'snowy_taiga', 'savanna', 'jungle', 'swamp', 'windswept_hills', 'stony_shore', 'volcano', 'stony_peaks', 'frozen_peaks',
];
const PATCH_BIOME_IDS: ReadonlySet<number> = new Set(PATCH_BIOMES.map((b) => BIOME_ID(b)));
/** The column's 25 quart corners (i, j ∈ 0 … 4) as lattice indices. */
const CORNERS: readonly number[] = Array.from({ length: 25 }, (_, n) => LATTICE(n % 5, Math.floor(n / 5)));
/** The prefilters' y margin (blocks) and the snowline band (|T_top − snowline| ≤ 0.1). */
const PREFILTER_Y = 8;
const SNOW_BAND = 0.1;
/** Acceptance checks a surface slot makes before it stays empty. */
const MAX_CHECKS = 64;

/** The leaves a surface slot serves (SP3c spec §3.5 "Leaves per class"). */
export function surfaceSlotLeaves(cls: SurfaceClass): readonly string[] {
  return SURFACE_SLOT_LEAVES[cls];
}

/**
 * The corner prefilter of a surface slot (SP3c spec §3.5) on a column's ColumnSample, at its 25 quart corners, with
 * `ctx.params.surface`: a dry corner (surfaceWaterLevel −∞) where, with T_top = T − lapse·max(0, surfaceEst − lapseBase),
 * - cliffY: steep ≥ 0.85·cliffSteep and surfaceEst ∈ [0.85·cliffMinY − 8, 1.15·cliffMinY + 8];
 * - cliffSteep: steep ≥ 0.85·cliffSteep and surfaceEst ≥ cliffMinY − 8;
 * - snowline: steep < cliffSteep, surfaceEst ≥ lapseBase and |T_top − snowline| ≤ 0.1;
 * - patch: steep < cliffSteep, T_top ≥ snowline and a 2D biome with top patches.
 */
export function surfacePrefilter(ctx: GenContext, cls: SurfaceClass, s: ColumnSample): boolean {
  const p = ctx.params.surface;
  const f = s.f;
  const steepMin = (1 - STEP) * p.cliffSteep;
  for (const k of CORNERS) {
    if (f.surfaceWaterLevel[k]! > -Infinity) continue;
    const steep = f.steep[k]!;
    const est = f.surfaceEst[k]!;
    const tTop = f.T[k]! - p.lapse * Math.max(0, est - p.lapseBase);
    let ok: boolean;
    switch (cls) {
      case 'cliffY':
        ok = steep >= steepMin && est >= (1 - STEP) * p.cliffMinY - PREFILTER_Y && est <= (1 + STEP) * p.cliffMinY + PREFILTER_Y;
        break;
      case 'cliffSteep':
        ok = steep >= steepMin && est >= p.cliffMinY - PREFILTER_Y;
        break;
      case 'snowline':
        ok = steep < p.cliffSteep && est >= p.lapseBase && Math.abs(tTop - p.snowline) <= SNOW_BAND;
        break;
      case 'patch':
        ok = steep < p.cliffSteep && tTop >= p.snowline && PATCH_BIOME_IDS.has(s.biome[k]!);
        break;
    }
    if (ok) return true;
  }
  return false;
}

/** One U2 perturbation of a surface leaf: its SurfaceContext (built apart) and the tree's maxSurfaceDepth. */
interface SurfaceVariant { readonly sc: SurfaceContext; readonly maxDepth: number }

function maxSurfaceDepthOf(sc: SurfaceContext): number {
  const fp = sc.compiled.fastPath;
  if (fp === null) throw new Error('U2: the default surface tree has no fast path');
  return fp.maxSurfaceDepth;
}

/** Acceptance checks over one base context; the variants' SurfaceContexts are built once per leaf. */
export interface SurfaceAcceptance {
  /** True when perturbing `path` (some U2 perturbation) changes the state of a voxel near a sky-open top of (cx, cz). */
  leafActs(path: string, cx: number, cz: number): boolean;
  /** The acceptance check of slot `cls` on column (cx, cz): every leaf the slot serves acts there. */
  accepts(cls: SurfaceClass, cx: number, cz: number): boolean;
}

/**
 * SP3c spec §3.5's acceptance check. Column (cx, cz) is generated once at `base`'s params (the T stage's density fill,
 * water v0 and biome buffer, `surfaceProbeColumn`) and scanned; a leaf acts when, for one of its U2 perturbations (the
 * other leaves at `base`'s values), some solid voxel within maxSurfaceDepth (the larger of the base tree's and the
 * variant's) of the top of a sky-open run gets a different state from the reference evaluator than at `base`. No
 * `surface.*` leaf changes solidity, water or the biomes, so a variant re-runs only the scan (its settings) and its
 * rules (its tree) on the base fill.
 */
export function surfaceAcceptance(base: GenContext): SurfaceAcceptance {
  const sc = SURFACE_CONTEXT(base);
  const baseDepth = maxSurfaceDepthOf(sc);
  const variants = new Map<string, readonly SurfaceVariant[]>();
  const vscan: SurfaceScan = NEW_SCAN();
  const variantsOf = (path: string): readonly SurfaceVariant[] => {
    let v = variants.get(path);
    if (v === undefined) {
      v = variantContexts(base, leafInfo(path)).map((c) => {
        const vsc = CREATE_SURFACE(c);
        return { sc: vsc, maxDepth: Math.max(baseDepth, maxSurfaceDepthOf(vsc)) };
      });
      variants.set(path, v);
    }
    return v;
  };
  const leafActs = (path: string, cx: number, cz: number): boolean => {
    if (!path.startsWith('surface.')) throw new Error(`U2: ${path} is not a surface leaf`);
    const col = PROBE_COLUMN(sc, cx, cz);
    const scan = col.scan;
    const s = sc.density.columns.get(cx, cz);
    for (const v of variantsOf(path)) {
      SCAN_COLUMN(vscan, v.sc.settings, s, col.solid, col.water, col.biomes);
      for (let p = 0; p < 256; p++) {
        const r0 = scan.runFirst[p]!;
        if (r0 === scan.runFirst[p + 1]) continue;
        const top = scan.runTop[r0]!;
        for (let y = top; y >= Math.max(-63, top - v.maxDepth); y--) {
          if (col.solid[((y + 64) << 8) | p] === 0) continue;
          if (sc.reference.state(scan, sc.settings, p, y) !== v.sc.reference.state(vscan, v.sc.settings, p, y)) return true;
        }
      }
    }
    return false;
  };
  return { leafActs, accepts: (cls, cx, cz) => SURFACE_SLOT_LEAVES[cls].every((path) => leafActs(path, cx, cz)) };
}

interface Slot {
  readonly cls: LivenessClass;
  readonly gate: Gate | null;
  readonly test: (L: Lattice, cx: number, cz: number) => boolean;
}

/**
 * The class columns, scanning samplePoints('sp2b.liveness', 200000). First SP2b's 16 of spec §7: 2 land, 2 coast,
 * 2 channel (one with a land point in the wetMargin band), 2 gorge, 2 basin, 2 rim and one threshold column per
 * lake-gate leaf; rarer classes take a column first; a gate whose band a variant closes is never met in the scan
 * falls back to the band a variant opens. Then SP3c's third pass (SP3c spec §3.5) over the same stream, skipping every
 * column already taken: each column is offered to the open surface slots in `SURFACE_CLASSES` order and the first
 * whose corner prefilter and acceptance check both hold takes it; a slot makes at most 64 acceptance checks, then
 * stays empty. A column fills one slot. Returned in class order; an empty class is missing. `streamLength` shortens
 * the scan (tests only).
 */
export function livenessColumns(ctx: GenContext, streamLength = STREAM_N): LivenessColumn[] {
  const pts = POINTS(STREAM, streamLength);
  const gates = gatesOf(ctx.params);
  const lakes = ctx.params.lakes;
  const maxP = Math.max(lakes.p, ...gates.flatMap((g) => g.variants.map((v) => v.p)));
  const variantCtxs = new Map<string, GenContext>();
  const variantCtx = (g: Gate) => (v: number): GenContext => {
    const key = `${g.path}|${v}`;
    let c = variantCtxs.get(key);
    if (c === undefined) { c = CREATE(ctx.seed, withLeaf(ctx.params, g.path, g.values[v])); variantCtxs.set(key, c); }
    return c;
  };
  const other = (cls: LivenessClass, test: (L: Lattice, cx: number, cz: number) => boolean): Slot => ({ cls, gate: null, test });
  const slots: Slot[] = [
    ...gates.map((g): Slot => ({ cls: g.cls, gate: g, test: (L) => hasGate(ctx, L, g, 1, variantCtx(g)) })),
    other('rim', (L) => hasRim(ctx, L)), other('rim', (L) => hasRim(ctx, L)),
    other('basin', hasBasin), other('basin', hasBasin),
    other('gorge', (L) => hasGorge(ctx, L)), other('gorge', (L) => hasGorge(ctx, L)),
    other('channel', (L) => hasChannel(ctx, L) && hasWetBand(ctx, L)), other('channel', (L) => hasChannel(ctx, L)),
    other('coast', hasCoast), other('coast', hasCoast),
    other('land', (L, cx, cz) => isLand(ctx, L, cx, cz)), other('land', (L, cx, cz) => isLand(ctx, L, cx, cz)),
  ];
  const chosen: (LivenessColumn | null)[] = slots.map(() => null);
  const used = new Set<number>();
  const L = newLattice();
  const scan = (band: number, candidates: readonly number[]): void => {
    for (let n = 0; n < streamLength; n++) {
      const open = candidates.filter((s) => chosen[s] === null);
      if (open.length === 0) return;
      const cx = Math.floor(pts.x[n]! / 16);
      const cz = Math.floor(pts.z[n]! / 16);
      const key = (cx + 32768) * 65536 + (cz + 32768);
      if (used.has(key)) continue;
      const openGates = open.map((s) => slots[s]!.gate);
      if (openGates.every((g) => g !== null)) {
        const inBand = (i: number, j: number): boolean => {
          if (cellRoll(ctx, i, j) >= maxP) return false;
          const probe = cellProbe(ctx, CELL(ctx, i, j));
          return openGates.some((g) => bandOf(g!, probe, lakes) === band);
        };
        if (!someReachableCell(ctx, cx, cz, inBand)) continue;
      }
      evalLattice(ctx, cx, cz, L);
      for (const s of open) {
        const slot = slots[s]!;
        const ok = band === 1 || slot.gate === null ? slot.test(L, cx, cz) : hasGate(ctx, L, slot.gate, 2, variantCtx(slot.gate));
        if (ok) {
          chosen[s] = { cx, cz, cls: slot.cls };
          used.add(key);
          break;
        }
      }
    }
  };
  scan(1, slots.map((_, s) => s));
  scan(2, slots.map((_, s) => s).filter((s) => slots[s]!.gate !== null));
  // The third pass: SP3c's surface slots (SP2b's 16 columns, and every verdict decided on them, stay).
  const acceptance = surfaceAcceptance(ctx);
  const checks = new Map<SurfaceClass, number>(SURFACE_CLASSES.map((c) => [c, 0]));
  for (let n = 0; n < streamLength; n++) {
    const open = SURFACE_CLASSES.filter((c) => checks.get(c)! < MAX_CHECKS && !chosen.some((x) => x !== null && x.cls === c));
    if (open.length === 0) break;
    const cx = Math.floor(pts.x[n]! / 16);
    const cz = Math.floor(pts.z[n]! / 16);
    const key = (cx + 32768) * 65536 + (cz + 32768);
    if (used.has(key)) continue;
    const s = BUILD(ctx, cx, cz, SAMPLE);
    for (const cls of open) {
      if (!surfacePrefilter(ctx, cls, s)) continue;
      checks.set(cls, checks.get(cls)! + 1);
      if (acceptance.accepts(cls, cx, cz)) {
        chosen.push({ cx, cz, cls });
        used.add(key);
        break;
      }
    }
  }
  const out: LivenessColumn[] = [];
  for (const cls of CLASS_ORDER) for (const c of chosen) if (c !== null && c.cls === cls) out.push(c);
  return out;
}

// ---------------------------------------------------------------- witnesses and U2

const isGate = (path: string): boolean => GATE_KEYS.some((k) => path === `lakes.${k}`);

function stageOf(info: LeafInfo): OutputStage {
  const s = info.meta.stage;
  if (s === undefined || !OUTPUT_STAGES.includes(s)) throw new Error(`${info.path} is not a leaf of a stage U2 covers`);
  return s as OutputStage;
}

/** The leaves U2 decides, in schema order: home stage climate, shape, biome2d or terrain (SP3b spec §3.3). */
export function u2Leaves(): readonly LeafInfo[] {
  return SCHEMA_.leaves.filter((l) => l.meta.stage !== undefined && OUTPUT_STAGES.includes(l.meta.stage));
}

/** Cells of a square spiral from (0, 0): ring r ≥ 1 has 8r cells, from (−r, −r) along j = −r, then i = r, j = r, i = −r. */
function someSpiralCell(max: number, visit: (i: number, j: number) => boolean): boolean {
  if (visit(0, 0)) return true;
  let n = 1;
  for (let r = 1; n < max; r++) {
    for (let i = -r; i <= r && n < max; i++, n++) if (visit(i, -r)) return true;
    for (let j = 1 - r; j <= r && n < max; j++, n++) if (visit(r, j)) return true;
    for (let i = r - 1; i >= -r && n < max; i--, n++) if (visit(i, r)) return true;
    for (let j = r - 1; j > -r && n < max; j--, n++) if (visit(-r, j)) return true;
  }
  return false;
}

type BaseHash = (stage: OutputStage, cx: number, cz: number) => string;

/** Memoised stage output hashes of the base context (shared by every leaf of one U2 run). */
function baseHasher(base: GenContext): BaseHash {
  const memo = new Map<string, string>();
  return (stage, cx, cz) => {
    const key = `${stage}|${cx}|${cz}`;
    let h = memo.get(key);
    if (h === undefined) { h = stageOutputHash(base, stage, cx, cz); memo.set(key, h); }
    return h;
  };
}

function witnessOf(base: GenContext, info: LeafInfo, variants: readonly GenContext[], skip: readonly LivenessColumn[], baseHash: BaseHash): string | null {
  if (variants.length === 0) return null;
  const stage = stageOf(info);
  const changes = (cx: number, cz: number): boolean => {
    const h = baseHash(stage, cx, cz);
    return variants.some((v) => stageOutputHash(v, stage, cx, cz) !== h);
  };
  let found: string | null = null;
  if (isGate(info.path)) {
    const maxP = Math.max(base.params.lakes.p, ...variants.map((v) => v.params.lakes.p));
    someSpiralCell(WITNESS_CELLS, (i, j) => {
      if (cellRoll(base, i, j) >= maxP) return false;
      const cell = CELL(base, i, j);
      const probe = cellProbe(base, cell);
      const now = ELIGIBLE(probe, base.params.lakes);
      if (!variants.some((v) => ELIGIBLE(probe, v.params.lakes) !== now)) return false;
      const cx = Math.floor(cell.cx / 16);
      const cz = Math.floor(cell.cz / 16);
      if (!changes(cx, cz)) return false;
      found = `witness cell (${i}, ${j}) → column (${cx}, ${cz})`;
      return true;
    });
    return found;
  }
  const pts = POINTS(STREAM, STREAM_N);
  const seen = new Set<number>(skip.map((c) => (c.cx + 32768) * 65536 + (c.cz + 32768)));
  let tried = 0;
  for (let n = 0; n < STREAM_N && tried < WITNESS_COLUMNS; n++) {
    const cx = Math.floor(pts.x[n]! / 16);
    const cz = Math.floor(pts.z[n]! / 16);
    const key = (cx + 32768) * 65536 + (cz + 32768);
    if (seen.has(key)) continue;
    seen.add(key);
    tried++;
    if (changes(cx, cz)) return `witness column (${cx}, ${cz})`;
  }
  return null;
}

/**
 * The witness search of spec §7 for a leaf dead on the class columns. Lake-gate leaves: lake cells in a spiral
 * from (0, 0), up to 16 384, whose cellEligible differs between the base and a variant; the column holding the
 * cell centre is the witness if its hash changes, else the spiral goes on. Other leaves: the stream columns that
 * are not in `skip`, up to 2048. Returns the deciding column's description, or null.
 */
export function findWitness(base: GenContext, path: string, skip: readonly LivenessColumn[] = []): string | null {
  const info = leafInfo(path);
  return witnessOf(base, info, variantContexts(base, info), skip, baseHasher(base));
}

function decide(base: GenContext, info: LeafInfo, columns: readonly LivenessColumn[], baseHash: BaseHash): LivenessResult {
  const stage = stageOf(info);
  const intended = intendedClass(info.path);
  const variants = variantContexts(base, info);
  const tried = stage === 'terrain' ? columns.filter((c) => TERRAIN_CLASSES.includes(c.cls)) : columns;
  const order = [...tried.filter((c) => c.cls === intended), ...tried.filter((c) => c.cls !== intended)];
  const hit = order.find((c) => variants.some((v) => stageOutputHash(v, stage, c.cx, c.cz) !== baseHash(stage, c.cx, c.cz)));
  if (hit !== undefined) return { path: info.path, live: true, via: `${hit.cls} column (${hit.cx}, ${hit.cz})`, cls: hit.cls };
  const w = stage === 'terrain' ? null : witnessOf(base, info, variants, columns, baseHash);
  return w !== null ? { path: info.path, live: true, via: w, cls: null } : { path: info.path, live: false, via: null, cls: intended };
}

/**
 * One leaf's U2 verdict over `columns` (the class columns of `base`): its stage output hash on the class columns (the
 * intended class first; a `terrain` leaf only on the land, coast and surface ones), then, except for a `terrain` leaf,
 * the witness search.
 */
export function leafLiveness(base: GenContext, path: string, columns: readonly LivenessColumn[]): LivenessResult {
  return decide(base, leafInfo(path), columns, baseHasher(base));
}

/**
 * U2 for every leaf of `u2Leaves()`: live when a perturbation changes the leaf's stage output hash on a class
 * column (its intended class first) or on its witness. value = live leaves / those leaves.
 */
export function u2(seedText = '42'): { readonly value: number; readonly results: readonly LivenessResult[] } {
  const base = CREATE(SEED(seedText), RESOLVE('default'));
  const columns = livenessColumns(base);
  const baseHash = baseHasher(base);
  const results = u2Leaves().map((info) => decide(base, info, columns, baseHash));
  const live = results.filter((r) => r.live).length;
  return { value: results.length > 0 ? live / results.length : 0, results };
}

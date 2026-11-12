/**
 * The cave-biome picker (SP6b spec §1.2-§1.5, D2, D3, D16): per block, from per-position fields. A column pass computes
 * the perturbed climate C′, E′, H′ and the depth origin Y0 at the (16 + 2J)² positions the per-voxel jitter can reach
 * (J = `edgeJitter` ≤ 4, the ColumnSample halo's limit), each from `readFieldHalo` and the border and depth noises in
 * one fixed operation order, so two columns compute the same doubles for a shared position (DT1, the rule of
 * columnStage.ts); a voxel's biome is then O(1): §1.3's box choice at its jittered position and height. Pure: it takes
 * its values as arguments (the per-GenContext inputs from `caves.biomes.*` arrive with the leaves).
 */
import { hash3 } from '../../core/hash';
import { readFieldHalo, type ColumnSample } from '../column/columnStage';
import { pickCaveBiome, type CaveBiomeSettings } from './caveRegistry';

const HASH3 = hash3;
const READ = readFieldHalo;
const PICK = pickCaveBiome;

/** A 2D noise sampled as z2 (clamped to ±clamp); a `NormalNoise` satisfies it. */
export interface Noise2 {
  z2(x: number, z: number): number;
  readonly clamp: number;
}

export interface CavePickerInputs {
  readonly settings: CaveBiomeSettings;
  readonly borderC: Noise2;
  readonly borderE: Noise2;
  readonly borderH: Noise2;
  readonly depth: Noise2;
  /** `deriveSeed(seed, 'caveBiome.jitter')`. */
  readonly jitterSeed: number;
}

/**
 * One column's fields at the positions (x, z) within J of it, J the `edgeJitter` the pass was filled with: C′, E′, H′
 * and Y0, 576 entries each (24 × 24, J ≤ 4), position (x, z) at `(z − 16·cz + 4)·24 + (x − 16·cx + 4)`.
 */
export interface CaveColumnPass {
  cx: number;
  cz: number;
  j: number;
  readonly c: Float64Array;
  readonly e: Float64Array;
  readonly h: Float64Array;
  readonly y0: Float64Array;
}

export function newCaveColumnPass(): CaveColumnPass {
  return { cx: 0, cz: 0, j: 0, c: new Float64Array(576), e: new Float64Array(576), h: new Float64Array(576), y0: new Float64Array(576) };
}

/** z2 / clamp clamped to [−1, 1]. */
function unit(n: Noise2, x: number, z: number): number {
  const v = n.z2(x, z) / n.clamp;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * The border and depth noises at (x, z), normalised: out = [Nb_C, Nb_E, Nb_H, Nd], each z2 / clamp clamped to [−1, 1]
 * (§1.2), in the column pass's order. The map layer, the hover, the finder and B3's zones read them here, never
 * sampling the noises themselves.
 */
export function caveBiomeInputsAt(inp: CavePickerInputs, x: number, z: number, out: Float64Array): Float64Array {
  out[0] = unit(inp.borderC, x, z);
  out[1] = unit(inp.borderE, x, z);
  out[2] = unit(inp.borderH, x, z);
  out[3] = unit(inp.depth, x, z);
  return out;
}

/** The depth origin Y0 = surfaceEst + depthWarp · Nd (§1.2); depth at y is (Y0 − y) / depthScale. */
export function caveY0(settings: CaveBiomeSettings, surfaceEst: number, nd: number): number {
  return surfaceEst + settings.depthWarp * nd;
}

const INPUTS_AT = caveBiomeInputsAt;
const Y0 = caveY0;
const NB = new Float64Array(4);

/**
 * Fills the pass for s's column at the (16 + 2J)² positions, z then x: C, E, H and surfaceEst by `readFieldHalo`; the
 * normalised border and depth noises (`caveBiomeInputsAt`); C′ = C + w·Nb_C, E′ = E + w·Nb_E, H′ = H + w·Nb_H (w the
 * `borderWarp`); Y0 = surfaceEst + dW·Nd (`caveY0`). This operation order is fixed.
 */
export function fillCaveColumnPass(inp: CavePickerInputs, s: ColumnSample, pass: CaveColumnPass): CaveColumnPass {
  const st = inp.settings;
  const j = st.edgeJitter;
  if (!(j >= 0 && j <= 4 && Math.floor(j) === j)) throw new RangeError(`fillCaveColumnPass: edgeJitter ${j} is not an integer in 0 … 4`);
  const w = st.borderWarp;
  const x0 = 16 * s.cx;
  const z0 = 16 * s.cz;
  pass.cx = s.cx;
  pass.cz = s.cz;
  pass.j = j;
  const pc = pass.c;
  const pe = pass.e;
  const ph = pass.h;
  const py = pass.y0;
  for (let z = z0 - j; z < z0 + 16 + j; z++) {
    const row = (z - z0 + 4) * 24 + 4 - x0;
    for (let x = x0 - j; x < x0 + 16 + j; x++) {
      const c = READ(s, 'C', x, z);
      const e = READ(s, 'E', x, z);
      const h = READ(s, 'H', x, z);
      const se = READ(s, 'surfaceEst', x, z);
      INPUTS_AT(inp, x, z, NB);
      const k = row + x;
      pc[k] = c + w * NB[0]!;
      pe[k] = e + w * NB[1]!;
      ph[k] = h + w * NB[2]!;
      py[k] = Y0(st, se, NB[3]!);
    }
  }
  return pass;
}

/** One jitter offset in [−j, j] from a 10-bit field f (§1.4): ((f · (2j + 1)) >>> 10) − j. */
export function caveJitterOffset(f: number, j: number): number {
  return ((f * (2 * j + 1)) >>> 10) - j;
}

const OFFSET = caveJitterOffset;

/**
 * The voxel's jitter (§1.4): h = hash3(jitterSeed, x, y, z) >>> 0; out = [jx, jy, jz] from bits 0-9, 10-19 and 20-29
 * of h, each in [−j, j].
 */
export function caveJitter(jitterSeed: number, j: number, x: number, y: number, z: number, out: Int32Array): void {
  const h = HASH3(jitterSeed, x, y, z) >>> 0;
  out[0] = OFFSET(h & 1023, j);
  out[1] = OFFSET((h >>> 10) & 1023, j);
  out[2] = OFFSET((h >>> 20) & 1023, j);
}

const JITTER = caveJitter;
const J3 = new Int32Array(3);

/** §1.3's choice from the pass at a position (x, z) within its J and height y. */
function pickAt(st: CaveBiomeSettings, pass: CaveColumnPass, x: number, y: number, z: number): number {
  const k = (z - 16 * pass.cz + 4) * 24 + (x - 16 * pass.cx + 4);
  return PICK(st, pass.c[k]!, pass.e[k]!, pass.h[k]!, (pass.y0[k]! - y) / st.depthScale);
}

/**
 * The cave biome of voxel (x, y, z) of the pass's column (§1.4): §1.3's choice at the jittered position
 * (x + jx, z + jz) and height y + jy, with depth (Y0 − (y + jy)) / D. Pure in (seed, settings, x, y, z).
 */
export function caveBiomeOfPass(inp: CavePickerInputs, pass: CaveColumnPass, x: number, y: number, z: number): number {
  JITTER(inp.jitterSeed, pass.j, x, y, z, J3);
  return pickAt(inp.settings, pass, x + J3[0]!, y + J3[1]!, z + J3[2]!);
}

/** The no-jitter form at a position (x, z) within the pass's J (the map's, the finder's and the probe's). */
export function caveBiomeUnjittered(inp: CavePickerInputs, pass: CaveColumnPass, x: number, y: number, z: number): number {
  return pickAt(inp.settings, pass, x, y, z);
}

/**
 * One position from exact values (the map layer's and the hover's): C, E, H and surfaceEst as `readFieldHalo` reads
 * them, nb = [Nb_C, Nb_E, Nb_H] and nd the normalised noises (`caveBiomeInputsAt`); the same doubles as the pass, so
 * the same biome as `caveBiomeUnjittered` and depth = (Y0 − y) / D.
 */
export function caveBiomePoint(
  b: CaveBiomeSettings, c: number, e: number, h: number, surfaceEst: number, nb: readonly [number, number, number], nd: number, y: number,
): { biome: number; depth: number } {
  const w = b.borderWarp;
  const depth = (Y0(b, surfaceEst, nd) - y) / b.depthScale;
  return { biome: PICK(b, c + w * nb[0], e + w * nb[1], h + w * nb[2], depth), depth };
}

const PT = new Float64Array(4);

/**
 * `caveBiomePoint` sampling the noises itself (`caveBiomeInputsAt` at (x, z)), with Y0: the form the map layer, the
 * hover's point job and B3's zones call with `readFieldHalo`'s C, E, H and surfaceEst at (x, z).
 */
export function caveBiomeAtPoint(
  inp: CavePickerInputs, c: number, e: number, h: number, surfaceEst: number, x: number, z: number, y: number,
): { biome: number; depth: number; y0: number } {
  const b = inp.settings;
  const w = b.borderWarp;
  INPUTS_AT(inp, x, z, PT);
  const y0 = Y0(b, surfaceEst, PT[3]!);
  const depth = (y0 - y) / b.depthScale;
  return { biome: PICK(b, c + w * PT[0]!, e + w * PT[1]!, h + w * PT[2]!, depth), depth, y0 };
}

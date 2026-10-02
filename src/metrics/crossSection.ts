/**
 * The cross-section (SP2b spec §4.5): the columns along a segment A → B of the world, at CROSS_SECTION_POINTS
 * points from A to B inclusive, each sampled with samplePoint (without steep). Shared by the pool's
 * `crossSection` stats job (one job, never split) and the tests; follows the core determinism rules
 * (arch-tested).
 *
 * A sum is a Float64Array of crossSectionLength() values: one block of CROSS_SECTION_POINTS values per field of
 * CROSS_SECTION_FIELDS, in that order (field f of point i at f·512 + i): offset0, offset, sigma and jag in
 * blocks, the river's wet and gorge flags (1 or 0), the lake level (−∞ outside a lake basin) and the surface
 * water level (−∞ on dry land). A range [from, to) writes its own points only, so the sums of disjoint ranges
 * into zeroed arrays add element-wise to the whole line. Sea level is the constant SEA_LEVEL (63).
 */
import type { GenContext } from '../gen/context';
import { newPointRecord, samplePoint } from '../gen/column/columnPoint';
import { WINDOW } from './noiseStats';

const SAMPLE = samplePoint;
const NEW_RECORD = newPointRecord;
const W = WINDOW;

/** Points along a line, A and B included. */
export const CROSS_SECTION_POINTS = 512;
const N = CROSS_SECTION_POINTS;
/** Points between two calls of `stop` (spec §2.2). */
const STOP_EVERY = 256;

export type CrossSectionField = 'offset0' | 'offset' | 'sigma' | 'jag' | 'riverWet' | 'gorge' | 'lakeLevel' | 'surfaceWaterLevel';
/** The fields of a sum, in block order. */
export const CROSS_SECTION_FIELDS: readonly CrossSectionField[] = Object.freeze(['offset0', 'offset', 'sigma', 'jag', 'riverWet', 'gorge', 'lakeLevel', 'surfaceWaterLevel']);
const LEN = CROSS_SECTION_FIELDS.length * N;

/** A segment of the world from A = (ax, az) to B = (bx, bz), in blocks. */
export interface Segment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
}

/** Length of a cross-section sum: 8 fields × 512 points. */
export function crossSectionLength(): number {
  return LEN;
}

const inWindow = (x: number, z: number): boolean => x >= -W && x < W && z >= -W && z < W;

/**
 * Why the segment has no profile, or null: both ends must lie in the half-open world window [−2^19, 2^19)
 * (NaN and ±∞ do not) and A must differ from B. The stats handler replies BAD_ARGS with this text.
 */
export function segmentProblem(s: Segment): string | null {
  const bounds = `[-${W}, ${W})`;
  if (!inWindow(s.ax, s.az)) return `A (${s.ax}, ${s.az}) is outside the world window ${bounds}`;
  if (!inWindow(s.bx, s.bz)) return `B (${s.bx}, ${s.bz}) is outside the world window ${bounds}`;
  if (s.ax === s.bx && s.az === s.bz) return `A and B are the same point (${s.ax}, ${s.az})`;
  return null;
}

/** The length of A → B in blocks. */
export function segmentLength(s: Segment): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Point i (0 … 511) of the segment: A + (B − A) · i/511, kept within the segment's bounding box, so a rounding
 * overshoot never leaves the window.
 */
export function segmentPointAt(s: Segment, i: number): [number, number] {
  const t = i / (N - 1);
  const x = s.ax + (s.bx - s.ax) * t;
  const z = s.az + (s.bz - s.az) * t;
  return [Math.min(Math.max(x, Math.min(s.ax, s.bx)), Math.max(s.ax, s.bx)), Math.min(Math.max(z, Math.min(s.az, s.bz)), Math.max(s.az, s.bz))];
}

const REC = NEW_RECORD();

/**
 * Writes the fields of points [from, to) of the segment into `out` (its other points are left as they are).
 * Calls `stop` before every 256 points and returns false as soon as it returns true, leaving the rest of the
 * range unwritten; returns true when the range is done. Throws RangeError on a segment with a problem, a bad
 * output length or a bad range.
 */
export function crossSectionInto(ctx: GenContext, s: Segment, from: number, to: number, out: Float64Array, stop?: () => boolean): boolean {
  const problem = segmentProblem(s);
  if (problem !== null) throw new RangeError(`cross-section: ${problem}`);
  if (out.length !== LEN) throw new RangeError(`cross-section: output length ${out.length}, expected ${LEN}`);
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= N)) {
    throw new RangeError(`cross-section: bad point range [${from}, ${to}) of ${N}`);
  }
  for (let i = from; i < to; i++) {
    if (stop !== undefined && (i - from) % STOP_EVERY === 0 && stop()) return false;
    const [x, z] = segmentPointAt(s, i);
    const p = SAMPLE(ctx, x, z, false, REC);
    out[i] = p.offset0;
    out[N + i] = p.offset;
    out[2 * N + i] = p.sigma;
    out[3 * N + i] = p.jag;
    out[4 * N + i] = p.riverWet ? 1 : 0;
    out[5 * N + i] = p.gorge ? 1 : 0;
    out[6 * N + i] = p.lakeLevel;
    out[7 * N + i] = p.surfaceWaterLevel;
  }
  return true;
}

/** The profile of a line (spec §4.5), one value per point and field. */
export interface CrossSectionProfile {
  readonly segment: Segment;
  /** Length of A → B in blocks. */
  readonly length: number;
  /** Distance of each point from A in blocks: length · i/511. */
  readonly distance: Float64Array;
  readonly offset0: Float64Array;
  readonly offset: Float64Array;
  readonly sigma: Float64Array;
  readonly jag: Float64Array;
  /** 1 in a wet river channel (water at sea level), else 0. */
  readonly riverWet: Uint8Array;
  /** 1 in a dry gorge, else 0. */
  readonly gorge: Uint8Array;
  /** The lake's water level inside a lake basin, else −∞. */
  readonly lakeLevel: Float64Array;
  /** Sea level (63) for the ocean and river channels, the lake level in a lake, else −∞. */
  readonly surfaceWaterLevel: Float64Array;
}

/** The profile of a line from its sum. */
export function summarizeCrossSection(sum: Float64Array, s: Segment): CrossSectionProfile {
  if (sum.length !== LEN) throw new RangeError(`cross-section: sum length ${sum.length}, expected ${LEN}`);
  const block = (f: number): Float64Array => sum.slice(f * N, (f + 1) * N);
  const flags = (f: number): Uint8Array => Uint8Array.from(block(f), (v) => (v !== 0 ? 1 : 0));
  const length = segmentLength(s);
  const distance = new Float64Array(N);
  for (let i = 0; i < N; i++) distance[i] = (length * i) / (N - 1);
  return {
    segment: { ax: s.ax, az: s.az, bx: s.bx, bz: s.bz }, length, distance,
    offset0: block(0), offset: block(1), sigma: block(2), jag: block(3), riverWet: flags(4), gorge: flags(5), lakeLevel: block(6), surfaceWaterLevel: block(7),
  };
}

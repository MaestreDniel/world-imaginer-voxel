/**
 * `A5.waterfalls`' sample (SP7a spec §13.1, as corrected by rulings R20 at Task 27b): visible water falls per km² of
 * steep land read on a fixed set of default-profile columns that holds steep land, instead of the caves passes' default
 * regions (whose interiors hold 0.00056 km² of it, so one fall moves the reading by about 1,800 per km²).
 * - **The columns** (`waterfallSampleChunks`, independent of the springs): a fixed-stride scan of the chunk lattice
 *   (cx, cz) = (`WATERFALL_SAMPLE_STRIDE`·a, `WATERFALL_SAMPLE_STRIDE`·b), a and b from −`WATERFALL_SAMPLE_HALF` up to
 *   `WATERFALL_SAMPLE_HALF` − 1, row by row (b outer); a chunk is in the sample when its column sample (`readField`)
 *   reads at least `WATERFALL_SAMPLE_MIN_STEEP` steep positions: `steep` ≥ 1.2 and `offset` ≥ 80 (A5's steep land,
 *   `STEEP_MIN`, `STEEP_OFFSET_MIN`; the regions' ground top ≥ 63 is not read, `offset` ≥ 80 standing for it). The steep
 *   land is the sampled chunks' steep positions, at 1 m² each.
 * - **The falls** (`waterfallSampleCounts`, from T and its probes, no settle): each sampled chunk's water springs (kind
 *   0, `terrainSpringsDebug`, T's own springs step) whose outlet (the neighbour in the spring's direction) has no solid
 *   voxel above it up to y 319 (`terrainSolidAt`, T's solidity with its barriers) and a straight fall ≥ `A5_WATER_FALL`
 *   (8): the consecutive voxels below the outlet that are non-solid with no proto fluid (`fluidAt`), where a lone
 *   spring's water falls (§3.2: outlet open to the sky, straight fall ≥ 8).
 * - **The reading**: the visible falls over the steep land in km², pooled over the sample, recorded per quadrant of the
 *   lattice (the sample's "regions": a < 0 or ≥ 0, b < 0 or ≥ 0) with the falls' heights.
 */
import { MIN_Y } from '../../src/core/constants';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { buildColumnSample, newColumnSample, readField } from '../../src/gen/column/columnStage';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { createDensityContext } from '../../src/gen/density/context';
import { aquiferOf, fluidAt } from '../../src/gen/fluids/aquifer';
import { terrainSolidAt } from '../../src/gen/fluids/solidAt';
import { newSpringList } from '../../src/gen/fluids/springs';
import { terrainSpringsDebug } from '../../src/gen/pipeline/terrainStage';
import { A5_WATER_FALL, STEEP_MIN, STEEP_OFFSET_MIN } from './water';

/** The lattice's stride in chunks and its half-width in lattice steps (so the scan covers ±stride·half chunks). */
export const WATERFALL_SAMPLE_STRIDE = 4;
export const WATERFALL_SAMPLE_HALF = 240;
/** A chunk's least steep positions (of its 256) to be in the sample. */
export const WATERFALL_SAMPLE_MIN_STEEP = 1;
/** The least steep land the sample must hold (rulings R20), in positions (m²). */
export const WATERFALL_SAMPLE_MIN_AREA = 1_000_000;

/** One sampled chunk: its coordinates, its steep positions and its lattice quadrant (0 … 3: (b ≥ 0)·2 + (a ≥ 0)). */
export interface SampleChunk {
  readonly cx: number;
  readonly cz: number;
  readonly steep: number;
  readonly quadrant: number;
}

/** The sample's chunks of (seed, params), in the scan's order (see the header); `half` narrows the scan (tests). */
export function waterfallSampleChunks(seed: string, params: Params, half = WATERFALL_SAMPLE_HALF): SampleChunk[] {
  const ctx = createGenContext(seedFromInput(seed), params);
  const sample = newColumnSample();
  const out: SampleChunk[] = [];
  for (let b = -half; b < half; b++) {
    for (let a = -half; a < half; a++) {
      const cx = WATERFALL_SAMPLE_STRIDE * a;
      const cz = WATERFALL_SAMPLE_STRIDE * b;
      buildColumnSample(ctx, cx, cz, sample);
      let steep = 0;
      for (let z = 16 * cz; z < 16 * cz + 16; z++) {
        for (let x = 16 * cx; x < 16 * cx + 16; x++) {
          if (readField(sample, 'steep', x, z) >= STEEP_MIN && readField(sample, 'offset', x, z) >= STEEP_OFFSET_MIN) steep++;
        }
      }
      if (steep >= WATERFALL_SAMPLE_MIN_STEEP) out.push({ cx, cz, steep, quadrant: (b >= 0 ? 2 : 0) + (a >= 0 ? 1 : 0) });
    }
  }
  return out;
}

/** The face directions of `springs.ts` (N −z, E +x, S +z, W −x). */
const DX = [0, 1, 0, -1] as const;
const DZ = [-1, 0, 1, 0] as const;

/** A part of the sample's counts: its chunks, steep land, water springs and visible falls with their heights. */
export interface SampleCounts {
  readonly chunks: number;
  readonly steepKm2: number;
  readonly waterSprings: number;
  readonly visibleFalls: number;
  /** Visible falls per km² of steep land (NaN with no steep land). */
  readonly waterfalls: number;
  /** Fall height → visible falls. */
  readonly fallHeights: Readonly<Record<string, number>>;
}

/** The sample's reading, pooled, and per quadrant (see the header). */
export interface WaterfallSample {
  readonly pooled: SampleCounts;
  readonly quadrants: readonly SampleCounts[];
}

/**
 * The visible fall of a water spring at (x, y, z) facing `dir`, from T's point probes (`probesOf`): its straight fall when
 * its outlet is open to the sky and the fall is at least `A5_WATER_FALL`, else 0.
 */
export function visibleFallOf(probe: SampleProbes, x: number, y: number, z: number, dir: number): number {
  const ox = x + DX[dir]!;
  const oz = z + DZ[dir]!;
  for (let q = y + 1; q <= 319; q++) if (probe.solid(ox, q, oz)) return 0;
  let fall = 0;
  while (y - fall - 1 > MIN_Y && !probe.solid(ox, y - fall - 1, oz) && probe.fluid(ox, y - fall - 1, oz) === 0) fall++;
  return fall >= A5_WATER_FALL ? fall : 0;
}

/** T's solidity (barriers included) and proto fluid at world voxels. */
export interface SampleProbes {
  solid(x: number, y: number, z: number): boolean;
  fluid(x: number, y: number, z: number): number;
}

/** `SampleProbes` of `ctx` on a DensityContext of their own (`terrainSolidAt`, `fluidAt`). */
export function probesOf(ctx: GenContext): SampleProbes {
  const dc = createDensityContext(ctx);
  const inp = aquiferOf(ctx);
  return { solid: (x, y, z) => terrainSolidAt(inp, dc, x, y, z), fluid: (x, y, z) => fluidAt(inp, dc, x, y, z) };
}

/** The sample's reading over `chunks` (`waterfallSampleChunks`') on (seed, params). */
export function waterfallSampleCounts(seed: string, params: Params, chunks: readonly SampleChunk[]): WaterfallSample {
  const ctx = createGenContext(seedFromInput(seed), params);
  const probe = probesOf(ctx);
  const list = newSpringList();
  const acc = [0, 1, 2, 3, 4].map(() => ({ chunks: 0, steep: 0, waterSprings: 0, visibleFalls: 0, heights: {} as Record<string, number> }));
  for (const c of chunks) {
    terrainSpringsDebug(ctx, c.cx, c.cz, list);
    for (const a of [acc[c.quadrant]!, acc[4]!]) {
      a.chunks++;
      a.steep += c.steep;
    }
    for (let k = 0; k < list.n; k++) {
      if (list.kind[k] !== 0) continue;
      const j = list.pos[k]!;
      const x = 16 * c.cx + (j & 15);
      const z = 16 * c.cz + ((j >> 4) & 15);
      const y = (j >> 8) + MIN_Y;
      const fall = visibleFallOf(probe, x, y, z, list.dir[k]!);
      for (const a of [acc[c.quadrant]!, acc[4]!]) {
        a.waterSprings++;
        if (fall > 0) {
          a.visibleFalls++;
          a.heights[fall] = (a.heights[fall] ?? 0) + 1;
        }
      }
    }
  }
  const counts = (a: (typeof acc)[number]): SampleCounts => ({
    chunks: a.chunks, steepKm2: a.steep / 1e6, waterSprings: a.waterSprings, visibleFalls: a.visibleFalls,
    waterfalls: a.steep === 0 ? Number.NaN : a.visibleFalls / (a.steep / 1e6), fallHeights: a.heights,
  });
  return { pooled: counts(acc[4]!), quadrants: acc.slice(0, 4).map(counts) };
}

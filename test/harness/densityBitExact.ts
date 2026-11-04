/**
 * SP6a ruling R13 (Task 15e): the bit-exactness check of an output-keeping speedup of T. Over 64 columns — 48 of
 * `terrain.real`'s candidate sequence on the default params, 8 amplified mountain columns (`offset` ≥ 150 at the centre
 * block, as the bench's D25 lines pick them) and 8 floating-islands cluster columns (`islandMask` ≥ 0.5, as
 * `terrain.islands` picks them) — the density fill and the cave tag of a pair of bounds (the speedup on, and off) give
 * the same solidity, the same `cells`, the same tag and, at every voxel both evaluated, the same value (Object.is), so
 * the stored blocks and the cave channel are kept bit for bit (the T stage derives the blocks from the solidity).
 */
import { DEFAULTS } from '../../src/core/params/defaults';
import { resolveProfile } from '../../src/core/params/profiles';
import type { Params } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { caveReadersOf, tagColumn } from '../../src/gen/caves/tags';
import { columnPoint } from '../../src/gen/column/columnPoint';
import { buildColumnSample, newColumnSample } from '../../src/gen/column/columnStage';
import { createGenContext, type GenContext } from '../../src/gen/context';
import { fillDensityColumn, type DensityBounds } from '../../src/gen/density/bounds';

const NEVER = (): boolean => false;

/** The `t`-th candidate column of `terrain.real`'s sequence (test/bench/noise.bench.ts). */
export function candidateColumn(t: number): readonly [number, number] {
  return [(t * 7919) % 60000 - 30000, (t * 104729) % 60000 - 30000];
}

/** One profile's columns for the check. */
export interface BitExactSet {
  readonly name: string;
  readonly params: Params;
  readonly columns: readonly (readonly [number, number])[];
}

/** The 64 columns: 48 default, 8 amplified mountain, 8 floating-islands cluster columns. */
export function bitExactSets(): BitExactSet[] {
  const pick = (params: Params, count: number, keep: (ctx: GenContext, cx: number, cz: number) => boolean): (readonly [number, number])[] => {
    const probe = createGenContext(seedFromInput('42'), params);
    const out: (readonly [number, number])[] = [];
    for (let t = 1; out.length < count; t++) {
      const [cx, cz] = candidateColumn(t);
      if (keep(probe, cx, cz)) out.push([cx, cz]);
    }
    return out;
  };
  const amplified = resolveProfile('amplified');
  const islands = resolveProfile('floating_islands');
  return [
    { name: 'default', params: DEFAULTS, columns: pick(DEFAULTS, 48, () => true) },
    { name: 'amplified', params: amplified, columns: pick(amplified, 8, (g, cx, cz) => columnPoint(g, 16 * cx + 8, 16 * cz + 8).offset >= 150) },
    { name: 'floating_islands', params: islands, columns: pick(islands, 8, (g, cx, cz) => columnPoint(g, 16 * cx + 8, 16 * cz + 8).islandMask >= 0.5) },
  ];
}

/** What the check compared. */
export interface BitExactStats {
  columns: number;
  /** Voxels both fills evaluated (values compared). */
  voxels: number;
  /** Voxels the speedup's fill evaluated, and the reference fill. */
  voxelsOn: number;
  voxelsOff: number;
  /** Voxels with a non-zero tag. */
  tagged: number;
}

/**
 * Runs the check: `pair(ctx)` gives the bounds with the speedup (`on`) and without it (`off`) for one GenContext; both
 * fill and tag every column, and the first difference throws (naming the profile, the column and the voxel). With
 * `sameMask` the two fills must also evaluate the same voxels.
 */
export function checkBitExact(
  pair: (ctx: GenContext) => { readonly on: DensityBounds; readonly off: DensityBounds },
  sameMask: boolean,
): BitExactStats {
  const stats: BitExactStats = { columns: 0, voxels: 0, voxelsOn: 0, voxelsOff: 0, tagged: 0 };
  const sample = newColumnSample();
  const solid = [new Uint8Array(98304), new Uint8Array(98304)];
  const values = [new Float64Array(98304), new Float64Array(98304)];
  const mask = [new Uint8Array(98304), new Uint8Array(98304)];
  const cells = [new Uint8Array(768), new Uint8Array(768)];
  const tags = [new Uint8Array(98304), new Uint8Array(98304)];
  for (const set of bitExactSets()) {
    const ctx = createGenContext(seedFromInput('42'), set.params);
    const { on, off } = pair(ctx);
    const th = set.params.caves.pillars.threshold;
    for (const [cx, cz] of set.columns) {
      buildColumnSample(ctx, cx, cz, sample);
      [on, off].forEach((b, k) => {
        if (!fillDensityColumn(b, sample, solid[k]!, values[k]!, mask[k]!, NEVER, cells[k]!)) throw new Error('the fill stopped');
        tagColumn(b.compiled, caveReadersOf(b.compiled), th, solid[k]!, cells[k]!, tags[k]!, b);
      });
      const where = (i: number): string => `${set.name} (${cx}, ${cz}) voxel ${i} (y ${(i >> 8) - 64})`;
      for (let i = 0; i < 98304; i++) {
        if (solid[0]![i] !== solid[1]![i]) throw new Error(`${where(i)}: solid ${solid[0]![i]} with the speedup, ${solid[1]![i]} without`);
        if (tags[0]![i] !== tags[1]![i]) throw new Error(`${where(i)}: tag ${tags[0]![i]} with the speedup, ${tags[1]![i]} without`);
        if (sameMask && mask[0]![i] !== mask[1]![i]) throw new Error(`${where(i)}: evaluated ${mask[0]![i]} with the speedup, ${mask[1]![i]} without`);
        stats.voxelsOn += mask[0]![i]!;
        stats.voxelsOff += mask[1]![i]!;
        if (tags[0]![i] !== 0) stats.tagged++;
        if (mask[0]![i] === 0 || mask[1]![i] === 0) continue;
        stats.voxels++;
        if (!Object.is(values[0]![i], values[1]![i])) throw new Error(`${where(i)}: ${values[0]![i]} with the speedup, ${values[1]![i]} without`);
      }
      for (let cell = 0; cell < 768; cell++) {
        if (cells[0]![cell] !== cells[1]![cell]) throw new Error(`${set.name} (${cx}, ${cz}) cell ${cell}: cells ${cells[0]![cell]} with the speedup, ${cells[1]![cell]} without`);
      }
      stats.columns++;
    }
  }
  return stats;
}

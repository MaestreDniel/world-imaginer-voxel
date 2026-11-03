/**
 * The heavy density tree of the slice work bound's calibration (SP3d spec §5.2 "Calibration", §9 `slice.partWorst`):
 * an `interpolated` `add` of `noise detail` leaves with `density.noises.detail` at 16 octaves, double (the noise's
 * static maximum weight, 4 × 16 × 2 = 128 work units). Its `workCost` per sample is 1 + 8 × (129·L − 1) for L leaves
 * (L − 1 `add` nodes and L noises of 128 under `interpolated`); with the reference's corner memo (SP6a §7.4) a 32-sample
 * vertical sample column costs 32 × 1 + 196 × (129·L − 1) + COLUMN_SAMPLE_COST (`memoWorkCost`: 1 per sample, 129·L − 1
 * per corner, at the 196 corners its 32 rows read). With `PART_WORST_LEAVES` = 330 that is 8,376,324 units, the
 * largest that fits PART_BUDGET (331 leaves: 8,401,608; 253 leaves were the largest before the memo-aware bound, at
 * 32 × 261,089 + COLUMN_SAMPLE_COST = 8,387,616). The `add` nodes form a balanced binary tree (depth ⌈log2 L⌉), so
 * tier 2's depth bounds hold. Used by the real-thread abort test (a part at the part bound) and the calibration
 * (`test/integration/fieldSliceCalibration.test.ts`); Task 28's `slice.partWorst` bench row reads the same tree.
 */
import type { Params } from '../../src/core/params/schema';
import { paramsWith } from './gen';

/** The leaf count of `slice.partWorst`'s tree: the largest L whose 32-sample vertical column fits PART_BUDGET. */
export const PART_WORST_LEAVES = 330;

type Node = Readonly<Record<string, unknown>>;

/** A balanced binary `add` of `leaves` `noise detail` nodes (built level by level: no recursion). */
function noiseSum(leaves: number): Node {
  if (!Number.isInteger(leaves) || leaves < 1) throw new RangeError(`noiseSum: ${leaves} leaves`);
  let level: Node[] = Array.from({ length: leaves }, () => ({ op: 'noise', id: 'detail' }));
  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push({ op: 'add', a: level[i]!, b: level[i + 1]! });
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}

/** The `density.defs` source `{root: interpolated(noiseSum(leaves)), defs: {}}`. */
export function noiseSumTree(leaves: number = PART_WORST_LEAVES): Node {
  return { root: { op: 'interpolated', x: noiseSum(leaves) }, defs: {} };
}

/** DEFAULTS with `density.noises.detail` at 16 octaves, double, and `density.defs` = `noiseSumTree(leaves)`. */
export function partWorstParams(leaves: number = PART_WORST_LEAVES): Params {
  return paramsWith({ density: { noises: { detail: { octaves: 16, double: true } }, defs: noiseSumTree(leaves) } } as never);
}

/**
 * SP3b golden digests (SP3b spec §9): the density machinery at fixed points, world seed '42', default profile.
 * - `sp3b.density.ops`: a fixture expression that uses every op (its noise ids are the schema's `density.noises.*`),
 *   compiled; per column of a fixed list, its 1225 corner values and the voxel values at 32 fixed points.
 * - `sp3b.density.default`: the default expression at column (0, 0): its 1225 corner values and all 98,304 voxel
 *   values through the probe path (no early-outs).
 * Corners are written per interpolated slot in slot order, each in `cornerValueIndex` order (i fastest, then j, then k);
 * voxels of a whole column in `((y + 64)·16 + lz)·16 + lx` order. Every value is hashed as its IEEE double bits
 * (`hashF64`, so −0 ≠ +0). Chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`) after SP3a's, so the
 * unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. Follows the core determinism rules (in
 * `DET_FILES`, arch-tested). Every value is hex64.
 */
import { fnv1a32, hashF64, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import type { SampleField } from '../gen/column/columnStage';
import { createGenContext } from '../gen/context';
import type { GenContext as GenContextT } from '../gen/context';
import { cornerValueIndex } from '../gen/density/compile';
import { createDensityContext } from '../gen/density/context';
import type { DensityContext as DensityContextT } from '../gen/density/context';
import type { DensityExpr, Expr, SlideKnot } from '../gen/density/expr';
import { probe } from '../gen/density/probe';

const FNV32 = fnv1a32;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const CORNER_INDEX = cornerValueIndex;
const CREATE_DC = createDensityContext;
const PROBE = probe;

const CORNERS = 1225;
const VOXELS = 98304;
/** Land (0, 0) and (5, −7), mountains (−68, 100) and (−1022, −786), ocean (205, −181) (SP3b Task 6's columns). */
const OPS_COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [5, -7], [-68, 100], [-1022, -786], [205, -181]];
const OPS_POINTS_PER_COLUMN = 32;
const SLIDE: readonly SlideKnot[] = [[-64, 0], [-40, 1], [240, 1], [320, 0]];

const ctx42 = (): GenContextT => CREATE_CTX(SEED('42'), RESOLVE('default'));

const k = (v: number): Expr => ({ op: 'const', v });
const Y: Expr = { op: 'y' };
const col = (field: SampleField): Expr => ({ op: 'col', field });
const add = (a: Expr, b: Expr): Expr => ({ op: 'add', a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: 'mul', a, b });

/**
 * The ops fixture: every op of §1.1 once at least, over the schema noises jag (2D), overhang and detail (3D):
 * defs `J` = (1 − |jag · 1/3|)² and `base` = offset − y; root = max(tap('shape', interpolated(base + jag·ref J
 * + σ·slide(overhang))), rangeChoice(detail, −1, 1, min(detail · clamp(E, −0.5, 0.5), 0.75), −40 + 0.25·y)).
 */
export function densityOpsExpr(): DensityExpr {
  const J: Expr = { op: 'square', x: add(k(1), { op: 'neg', x: { op: 'abs', x: mul({ op: 'noise2', id: 'jag' }, k(1 / 3)) } }) };
  const base: Expr = add(col('offset'), { op: 'neg', x: Y });
  const detail: Expr = { op: 'noise', id: 'detail' };
  const shape: Expr = {
    op: 'tap', name: 'shape',
    x: {
      op: 'interpolated',
      x: add(add({ op: 'ref', name: 'base' }, mul(col('jag'), { op: 'ref', name: 'J' })), mul(col('sigma'), { op: 'slide', x: { op: 'noise', id: 'overhang' }, knots: SLIDE })),
    },
  };
  const choice: Expr = {
    op: 'rangeChoice', x: detail, lo: -1, hi: 1,
    inside: { op: 'min', a: mul(detail, { op: 'clamp', x: col('E'), lo: -0.5, hi: 0.5 }), b: k(0.75) },
    outside: add(k(-40), mul(k(0.25), Y)),
  };
  return { defs: { J, base }, root: { op: 'max', a: shape, b: choice } };
}

/**
 * The ops fixture's points, world [x, y, z]: 32 per column of the list, in list order, drawn from
 * `Xoshiro128(fnv1a32('sp3b.density.ops'))` as lx, lz (`nextU32() & 15`) and y (−64 + `nextU32() % 384`).
 */
export function densityOpsPoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp3b.density.ops'));
  const out: Array<[number, number, number]> = [];
  for (const [cx, cz] of OPS_COLUMNS) {
    for (let p = 0; p < OPS_POINTS_PER_COLUMN; p++) {
      const lx = r.nextU32() & 15;
      const lz = r.nextU32() & 15;
      const y = -64 + (r.nextU32() % 384);
      out.push([16 * cx + lx, y, 16 * cz + lz]);
    }
  }
  return out;
}

/** Writes the current column's corner values (every interpolated slot, slot outer) at `values[o …]`; returns the end. */
function writeCorners(dc: DensityContextT, values: Float64Array, o: number): number {
  const c = dc.compiled;
  for (let idx = 0; idx < CORNERS; idx++) c.cornerFn(idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5);
  for (let slot = 0; slot < c.interpolatedSlotCount; slot++) {
    for (let idx = 0; idx < CORNERS; idx++) values[o++] = c.cornerValues[CORNER_INDEX(slot, idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5)]!;
  }
  return o;
}

/** Per column of the list: its corner values, then the voxel values at its 32 points (compiled, no early-outs). */
export function densityOpsValues(): Float64Array {
  const dc = CREATE_DC(ctx42(), densityOpsExpr());
  const points = densityOpsPoints();
  const values = new Float64Array(OPS_COLUMNS.length * (dc.compiled.interpolatedSlotCount * CORNERS + OPS_POINTS_PER_COLUMN));
  let o = 0;
  for (let n = 0; n < OPS_COLUMNS.length; n++) {
    const [cx, cz] = OPS_COLUMNS[n]!;
    dc.column(cx, cz);
    o = writeCorners(dc, values, o);
    for (let p = n * OPS_POINTS_PER_COLUMN; p < (n + 1) * OPS_POINTS_PER_COLUMN; p++) {
      const [x, y, z] = points[p]!;
      values[o++] = PROBE(dc, x, y, z);
    }
  }
  return values;
}

/** The default expression at column (0, 0): its corner values, then the probe at every voxel. */
export function densityDefaultValues(): Float64Array {
  const dc = CREATE_DC(ctx42());
  const values = new Float64Array(dc.compiled.interpolatedSlotCount * CORNERS + VOXELS);
  dc.column(0, 0);
  let o = writeCorners(dc, values, 0);
  for (let y = -64; y <= 319; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) values[o++] = PROBE(dc, lx, y, lz);
    }
  }
  return values;
}

export function sp3bGoldenKeys(): string[] {
  return ['sp3b.density.ops', 'sp3b.density.default'];
}

export function computeSp3bGolden(key: string): string {
  if (key === 'sp3b.density.ops') return HEX64(HASH_F64(densityOpsValues()));
  if (key === 'sp3b.density.default') return HEX64(HASH_F64(densityDefaultValues()));
  throw new Error(`unknown golden ${key}`);
}

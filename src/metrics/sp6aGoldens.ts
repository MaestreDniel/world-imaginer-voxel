/**
 * SP6a golden digests (SP6a spec §12.3, D28), chained last into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`),
 * so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. Push A adds `sp6a.density.ops`; push B
 * appends `sp6a.carver.paths` and `sp6a.region.T.caves`.
 * - `sp6a.density.ops`: the `noiseScaled` op (D18, spec §1.5) at fixed points, world seed '42', default profile. The
 *   fixture is a density source tree that uses `noiseScaled` inside and outside `interpolated`, with literal scales and a
 *   `{param}` scale (`density.noises.detail.clampSigma`, static range [1, 8]: before the cave parameters only the
 *   `*.clampSigma` targets lie inside [1/16, 16]), resolved for the profile's params (`resolveDensity`) and compiled. At
 *   column (0, 0), as `sp3b.density.ops` is evaluated: its 1225 corner values (every interpolated slot in slot order,
 *   each in `cornerValueIndex` order: i fastest, then j, then k), then the voxel values (compiled, no early-outs) at 32
 *   points drawn from `Xoshiro128(fnv1a32('sp6a.density.ops'))` as lx, lz (`nextU32() & 15`) and y
 *   (−64 + `nextU32() % 384`). Every value is hashed as its IEEE double bits (`hashF64`, so −0 ≠ +0).
 * Follows the core determinism rules (in `DET_FILES`, arch-tested). Every value is hex64.
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
import type { DensityExpr } from '../gen/density/expr';
import { probe } from '../gen/density/probe';
import { resolveDensity } from '../gen/density/source';
import type { DensitySource, SourceExpr, SourceNumber } from '../gen/density/source';

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
const RESOLVE_DENSITY = resolveDensity;

const CORNERS = 1225;
/** The column the ops fixture is evaluated over. */
const OPS_COLUMN: readonly [number, number] = [0, 0];
const OPS_POINTS = 32;
/** The fixture's `{param}` scale: a noise clampSigma, static range [1, 8]. */
const PARAM_SCALE = 'density.noises.detail.clampSigma';

const ctx42 = (): GenContextT => CREATE_CTX(SEED('42'), RESOLVE('default'));

const k = (v: number): SourceExpr => ({ op: 'const', v });
const col = (field: SampleField): SourceExpr => ({ op: 'col', field });
const add = (a: SourceExpr, b: SourceExpr): SourceExpr => ({ op: 'add', a, b });
const mul = (a: SourceExpr, b: SourceExpr): SourceExpr => ({ op: 'mul', a, b });
const scaled = (id: string, s: SourceNumber): SourceExpr => ({ op: 'noiseScaled', id, s });

/**
 * The ops fixture's source: root = tap('scaled', interpolated(noiseScaled(overhang, 1.5) + E · noiseScaled(detail,
 * {param})) ) + (noiseScaled(detail, 0.75) + 0.5 · noiseScaled(islands, {param})), the `{param}` being
 * `density.noises.detail.clampSigma`; no defs.
 */
export function densityScaledSource(): DensitySource {
  const p: SourceNumber = { param: PARAM_SCALE };
  const inner = add(scaled('overhang', 1.5), mul(col('E'), scaled('detail', p)));
  const outer = add(scaled('detail', 0.75), mul(k(0.5), scaled('islands', p)));
  return { root: add({ op: 'tap', name: 'scaled', x: { op: 'interpolated', x: inner } }, outer), defs: {} };
}

/** The fixture resolved for the default profile's params (the `{param}` scale written as its value). */
export function densityScaledExpr(): DensityExpr {
  return RESOLVE_DENSITY(densityScaledSource(), ctx42().params);
}

/** The fixture's points, world [x, y, z]: 32 in column (0, 0), drawn as the module comment states. */
export function densityScaledPoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp6a.density.ops'));
  const [cx, cz] = OPS_COLUMN;
  const out: Array<[number, number, number]> = [];
  for (let n = 0; n < OPS_POINTS; n++) {
    const lx = r.nextU32() & 15;
    const lz = r.nextU32() & 15;
    const y = -64 + (r.nextU32() % 384);
    out.push([16 * cx + lx, y, 16 * cz + lz]);
  }
  return out;
}

/** Column (0, 0)'s corner values (every interpolated slot, slot outer), then the voxel values at the 32 points. */
export function densityScaledValues(): Float64Array {
  const ctx = ctx42();
  const dc = CREATE_DC(ctx, RESOLVE_DENSITY(densityScaledSource(), ctx.params));
  const c = dc.compiled;
  const values = new Float64Array(c.interpolatedSlotCount * CORNERS + OPS_POINTS);
  dc.column(OPS_COLUMN[0], OPS_COLUMN[1]);
  for (let idx = 0; idx < CORNERS; idx++) c.cornerFn(idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5);
  let o = 0;
  for (let slot = 0; slot < c.interpolatedSlotCount; slot++) {
    for (let idx = 0; idx < CORNERS; idx++) values[o++] = c.cornerValues[CORNER_INDEX(slot, idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5)]!;
  }
  for (const [x, y, z] of densityScaledPoints()) values[o++] = PROBE(dc, x, y, z);
  return values;
}

export function sp6aGoldenKeys(): string[] {
  return ['sp6a.density.ops'];
}

export function computeSp6aGolden(key: string): string {
  if (key === 'sp6a.density.ops') return HEX64(HASH_F64(densityScaledValues()));
  throw new Error(`unknown golden ${key}`);
}

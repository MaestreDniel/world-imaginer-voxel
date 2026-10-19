/**
 * The column-point digest (SP2a spec §7.4), moved unchanged from `sp2aGoldens.ts` (SP3e spec §6): `sp2a.column.point.*`
 * and `sp3e.column.point.*` both hash it, and `sp2aGoldens.ts` imports `sp3eGoldens.ts` for the golden chain, so the
 * digest lives in its own module to keep the imports acyclic. Follows the core determinism rules (in `DET_FILES`,
 * arch-tested). Every value is hex64.
 */
import { fnv1a32, hashF64, hex64 } from '../core/hash';
import { resolveProfile, type ProfileId } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { createGenContext } from '../gen/context';
import { columnPoint, type ColumnPoint } from '../gen/column/columnPoint';

const FNV32 = fnv1a32;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE = createGenContext;
const POINT = columnPoint;

const N_POINTS = 4096;

/** Every ColumnPoint field in a fixed order (booleans as 0/1). */
export function pointValues(p: ColumnPoint, out: Float64Array, o: number): void {
  const v = [p.C, p.E, p.W, p.T, p.H, p.R, p.PV, p.offset0, p.sigma0, p.jag0, p.steep, p.riverDist, p.riverStrength, p.riverWet ? 1 : 0, p.gorge ? 1 : 0,
    p.lakeMask, p.lakeLevel, p.lakeFloor, p.offset, p.sigma, p.jag, p.surfaceWaterLevel, p.surfaceEst, p.islandMask, p.biome];
  for (let k = 0; k < 25; k++) out[o + k] = v[k]!;
}

/** columnPoint at 4096 points from Xoshiro128(fnv1a32('sp2a.point')) in the colKey window, world seed '42'. */
export function pointDigest(profile: ProfileId): string {
  const ctx = CREATE(SEED('42'), RESOLVE(profile));
  const r = new Rng(FNV32('sp2a.point'));
  const out = new Float64Array(N_POINTS * 25);
  for (let i = 0; i < N_POINTS; i++) {
    const x = -524288 + 1048576 * r.nextFloat();
    const z = -524288 + 1048576 * r.nextFloat();
    pointValues(POINT(ctx, x, z), out, 25 * i);
  }
  return HEX64(HASH_F64(out));
}

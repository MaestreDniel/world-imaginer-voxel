/**
 * SP7a golden digests (SP7a spec §15.3, D33), chained last into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`),
 * so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. The generator push adds
 * `sp7a.aquifer.points` (Task 14); `sp7a.springs` (Task 21) and `sp7a.region.D.water` (Task 32) follow.
 * - `sp7a.aquifer.points` (SP7a spec §1, §13.4, §15.3): the aquifer's point functions at 256 fixed 3D points, world seed
 *   '42', default profile: `fluidAt` (the proto fluid byte T writes there) and `barrierAt` (whether T makes it barrier
 *   rock) over `aquiferOf(ctx)` and a DensityContext of `ctx`. The points are drawn from
 *   `Xoshiro128(fnv1a32('sp7a.aquifer.points'))` as x = −4096 + nextInt(8193), z = −4096 + nextInt(8193),
 *   y = −63 + nextInt(184) (within ±4,096 blocks, y −63 … 120), in that order; the digest is the FNV-1a 64 of two bytes
 *   per point in draw order, the `fluidAt` byte then the `barrierAt` bit (1 or 0).
 * Follows the core determinism rules (in `DET_FILES`, arch-tested). Every value is hex64.
 */
import { fnv1a32, fnv1a64Bytes, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { createGenContext } from '../gen/context';
import { createDensityContext } from '../gen/density/context';
import { aquiferOf, barrierAt, fluidAt } from '../gen/fluids/aquifer';

const FNV32 = fnv1a32;
const FNV64 = fnv1a64Bytes;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const CREATE_DC = createDensityContext;
const AQUIFER_OF = aquiferOf;
const FLUID_AT = fluidAt;
const BARRIER_AT = barrierAt;

const POINTS = 256;
/** The points' horizontal reach (±4,096 blocks) and height range (y −63 … 120). */
const POINT_REACH = 4096;
const POINT_Y_LO = -63;
const POINT_Y_HI = 120;

/** `sp7a.aquifer.points`' 256 points, world [x, y, z], drawn as the module comment states. */
export function aquiferPoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp7a.aquifer.points'));
  const out: Array<[number, number, number]> = [];
  for (let n = 0; n < POINTS; n++) {
    const x = -POINT_REACH + r.nextInt(2 * POINT_REACH + 1);
    const z = -POINT_REACH + r.nextInt(2 * POINT_REACH + 1);
    const y = POINT_Y_LO + r.nextInt(POINT_Y_HI - POINT_Y_LO + 1);
    out.push([x, y, z]);
  }
  return out;
}

/** `sp7a.aquifer.points`: the FNV-1a 64 of the `fluidAt` byte and the `barrierAt` bit at each point (seed '42', default profile). */
export function aquiferPointsDigest(): string {
  const ctx = CREATE_CTX(SEED('42'), RESOLVE('default'));
  const inp = AQUIFER_OF(ctx);
  const dc = CREATE_DC(ctx);
  const bytes = new Uint8Array(2 * POINTS);
  let n = 0;
  for (const [x, y, z] of aquiferPoints()) {
    bytes[n++] = FLUID_AT(inp, dc, x, y, z);
    bytes[n++] = BARRIER_AT(inp, dc, x, y, z) ? 1 : 0;
  }
  return HEX64(FNV64(bytes));
}

export function sp7aGoldenKeys(): string[] {
  return ['sp7a.aquifer.points'];
}

export function computeSp7aGolden(key: string): string {
  if (key === 'sp7a.aquifer.points') return aquiferPointsDigest();
  throw new Error(`unknown golden ${key}`);
}

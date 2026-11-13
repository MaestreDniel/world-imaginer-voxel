/**
 * SP6b golden digests (SP6b spec §14.3, D28), chained last into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`),
 * so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. The blocks (Task 7) add
 * `sp6b.registry`; the generator push appends `sp6b.caveBiome.points` (Task 17) and `sp6b.region.T.biomes`.
 * - `sp6b.registry`: SP3a §6.4's registry byte stream over SP6b's seven types, states 58 … 64 (SP6b spec §4, D36), a
 *   fixed range as `sp3c.registry`'s (`sp3cGoldens.ts`), so states appended later never change it.
 * - `sp6b.caveBiome.points` (the generator push, Task 17; SP6b spec §1, §14.3): the cave-biome picker at 64 fixed 3D
 *   points, world seed '42', default profile: `caveBiomeOfPass` over `cavePickerOf(ctx)` with the pass of the point's
 *   chunk column (`fillCaveColumnPass` on its ColumnSample). The points are drawn from
 *   `Xoshiro128(fnv1a32('sp6b.caveBiome.points'))` as x = −4096 + nextInt(8193), z = −4096 + nextInt(8193),
 *   y = −63 + nextInt(184) (within ±4,096 blocks, y −63 … 120), in that order; the digest is the FNV-1a 64 of the 64
 *   biome ids, one byte each, in draw order.
 * Follows the core determinism rules (in `DET_FILES`, arch-tested). Every value is hex64.
 */
import { fnv1a32, fnv1a64Bytes, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { caveBiomeOfPass, cavePickerOf, fillCaveColumnPass, newCaveColumnPass } from '../gen/biomes/cavePicker';
import { buildColumnSample, newColumnSample } from '../gen/column/columnStage';
import { createGenContext } from '../gen/context';
import { REGISTRY } from '../world/blocks/index';
import type { BlockRegistry as BlockRegistryT } from '../world/blocks/registry';
import { registryStatesDigest } from './sp3aGoldens';

const REG = REGISTRY;
const STATES_DIGEST = registryStatesDigest;
const FNV32 = fnv1a32;
const FNV64 = fnv1a64Bytes;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const PICKER_OF = cavePickerOf;
const FILL_PASS = fillCaveColumnPass;
const BIOME_OF_PASS = caveBiomeOfPass;
const NEW_PASS = newCaveColumnPass;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;

const POINTS = 64;
/** The points' horizontal reach (±4,096 blocks) and height range (y −63 … 120). */
const POINT_REACH = 4096;
const POINT_Y_LO = -63;
const POINT_Y_HI = 120;

/** SP6b's cave-biome types: states 58 … 64 (SP6b spec §4). */
const SP6B_FIRST_STATE = 58;
const SP6B_STATES = 7;

/** `sp6b.registry`: SP3a §6.4's byte stream over states 58 … 64 of `reg`; a RangeError when it has fewer states. */
export function sp6bRegistryDigest(reg: BlockRegistryT = REG): string {
  return STATES_DIGEST(reg, SP6B_FIRST_STATE, SP6B_STATES);
}

/** `sp6b.caveBiome.points`' 64 points, world [x, y, z], drawn as the module comment states. */
export function caveBiomePoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp6b.caveBiome.points'));
  const out: Array<[number, number, number]> = [];
  for (let n = 0; n < POINTS; n++) {
    const x = -POINT_REACH + r.nextInt(2 * POINT_REACH + 1);
    const z = -POINT_REACH + r.nextInt(2 * POINT_REACH + 1);
    const y = POINT_Y_LO + r.nextInt(POINT_Y_HI - POINT_Y_LO + 1);
    out.push([x, y, z]);
  }
  return out;
}

/** `sp6b.caveBiome.points`: the FNV-1a 64 of the picker's biome at each point, one byte each (seed '42', default profile). */
export function caveBiomePointsDigest(): string {
  const ctx = CREATE_CTX(SEED('42'), RESOLVE('default'));
  const inp = PICKER_OF(ctx);
  const s = NEW_SAMPLE();
  const pass = NEW_PASS();
  const ids = new Uint8Array(POINTS);
  let n = 0;
  for (const [x, y, z] of caveBiomePoints()) {
    FILL_PASS(inp, BUILD(ctx, Math.floor(x / 16), Math.floor(z / 16), s), pass);
    ids[n++] = BIOME_OF_PASS(inp, pass, x, y, z);
  }
  return HEX64(FNV64(ids));
}

export function sp6bGoldenKeys(): string[] {
  return ['sp6b.registry', 'sp6b.caveBiome.points'];
}

export function computeSp6bGolden(key: string): string {
  if (key === 'sp6b.registry') return sp6bRegistryDigest();
  if (key === 'sp6b.caveBiome.points') return caveBiomePointsDigest();
  throw new Error(`unknown golden ${key}`);
}

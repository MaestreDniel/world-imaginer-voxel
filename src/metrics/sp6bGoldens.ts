/**
 * SP6b golden digests (SP6b spec §14.3, D28), chained last into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`),
 * so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. The blocks (Task 7) add
 * `sp6b.registry`; the generator push appends `sp6b.caveBiome.points` and `sp6b.region.T.biomes`.
 * - `sp6b.registry`: SP3a §6.4's registry byte stream over SP6b's seven types, states 58 … 64 (SP6b spec §4, D36), a
 *   fixed range as `sp3c.registry`'s (`sp3cGoldens.ts`), so states appended later never change it.
 * Follows the core determinism rules (in `DET_FILES`, arch-tested). Every value is hex64.
 */
import { REGISTRY } from '../world/blocks/index';
import type { BlockRegistry as BlockRegistryT } from '../world/blocks/registry';
import { registryStatesDigest } from './sp3aGoldens';

const REG = REGISTRY;
const STATES_DIGEST = registryStatesDigest;

/** SP6b's cave-biome types: states 58 … 64 (SP6b spec §4). */
const SP6B_FIRST_STATE = 58;
const SP6B_STATES = 7;

/** `sp6b.registry`: SP3a §6.4's byte stream over states 58 … 64 of `reg`; a RangeError when it has fewer states. */
export function sp6bRegistryDigest(reg: BlockRegistryT = REG): string {
  return STATES_DIGEST(reg, SP6B_FIRST_STATE, SP6B_STATES);
}

export function sp6bGoldenKeys(): string[] {
  return ['sp6b.registry'];
}

export function computeSp6bGolden(key: string): string {
  if (key === 'sp6b.registry') return sp6bRegistryDigest();
  throw new Error(`unknown golden ${key}`);
}

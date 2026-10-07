/**
 * SP3a golden digests (SP3a spec §6.4): the block registry's first states and the T region per profile
 * (the real T and aux B since GENERATOR_VERSION 4, SP3b spec §9).
 * Chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`), so the unit tests, `?selftest=1` and
 * `test/tools/goldensJsc.ts` all check them. Follows the core determinism rules (in `DET_FILES`, arch-tested).
 * Every value is hex64.
 */
import { createFnv64, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import type { ProfileId as ProfileIdT } from '../core/params/profiles';
import { seedFromInput } from '../core/seed';
import { createGenContext } from '../gen/context';
import { REGISTRY } from '../world/blocks/index';
import type { BlockRegistry as BlockRegistryT } from '../world/blocks/registry';
import { createStore } from '../world/store/store';
import { genRegionInProcess, regionHash } from './region';

const CREATE_FNV = createFnv64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const REG = REGISTRY;
const CREATE_STORE = createStore;
const GEN_REGION = genRegionInProcess;
const REGION_HASH = regionHash;

/** The states SP3a registers (air, stone, bedrock): a fixed count, so appended states never change the digest. */
const SP3A_STATES = 3;
const REGION_PROFILES: readonly ProfileIdT[] = ['default', 'large_biomes'];
/** 64 proto columns need at most 1,536 block and 1,664 byte slots (12 and 6.5 MiB; 26 byte slots per column with SP3b's aux B). */
const MiB = 1048576;

/**
 * FNV-1a 64 over states 0 … 2 of `reg`: per state, its canonical key's ASCII bytes and a 0 byte, then `STATE_TYPE`
 * (u16 LE), `OPACITY`, `PASS`, `SHAPE`, `FULL_FACES`, `EMIT`, `CARVABLE`, `REPLACEABLE`, `COLLIDE`, `FLUID_MODE`,
 * `TINT`, `SOUND` (u8 each) and the six `FACE_TEX` entries (u16 LE). Throws when `reg` has fewer states.
 */
export function registryDigest(reg: BlockRegistryT = REG): string {
  if (reg.stateCount < SP3A_STATES) throw new RangeError(`registryDigest: the registry has ${reg.stateCount} states, fewer than ${SP3A_STATES}`);
  const fnv = CREATE_FNV();
  for (let s = 0; s < SP3A_STATES; s++) {
    const key = reg.stateKey(s);
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c > 127) throw new Error(`registryDigest: state key ${key} is not ASCII`);
      fnv.updateU8(c);
    }
    fnv.updateU8(0);
    fnv.updateU16LE(reg.STATE_TYPE[s]!);
    for (const t of [reg.OPACITY, reg.PASS, reg.SHAPE, reg.FULL_FACES, reg.EMIT, reg.CARVABLE, reg.REPLACEABLE, reg.COLLIDE, reg.FLUID_MODE, reg.TINT, reg.SOUND]) {
      fnv.updateU8(t[s]!);
    }
    for (let f = 0; f < 6; f++) fnv.updateU16LE(reg.FACE_TEX[6 * s + f]!);
  }
  return HEX64(fnv.digest());
}

/**
 * `regionHash` of the 8 × 8 region at (−4, −4), world seed '42', `profile`, generated in process on a fresh
 * `ArrayBuffer` store (never the region cache).
 */
export function regionDigest(profile: ProfileIdT): string {
  const store = CREATE_STORE({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  GEN_REGION(store, CREATE_CTX(SEED('42'), RESOLVE(profile)), -4, -4, 8, 8);
  return HEX64(REGION_HASH(store, -4, -4, 8, 8));
}

export function sp3aGoldenKeys(): string[] {
  return ['sp3a.registry', ...REGION_PROFILES.map((p) => `sp3a.region.T.${p}`)];
}

export function computeSp3aGolden(key: string): string {
  if (key === 'sp3a.registry') return registryDigest();
  const m = /^sp3a\.region\.T\.(.+)$/.exec(key);
  if (m !== null && (REGION_PROFILES as readonly string[]).includes(m[1]!)) return regionDigest(m[1] as ProfileIdT);
  throw new Error(`unknown golden ${key}`);
}

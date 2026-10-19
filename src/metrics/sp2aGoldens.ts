/**
 * SP2a golden digests (SP2a spec §7.4), shared by test/unit/goldens.sp2a.test.ts, the ?selftest=1 worker
 * and test/tools/goldensJsc.ts, and the chain of every golden of the build (`allGoldenKeys`/`computeAnyGolden`:
 * SP1, SP2a, then SP3a, SP3a spec §6.4, then SP3b, SP3b spec §9, then SP3c, SP3c spec §7, then SP3e, SP3e spec §6). The column-point
 * digest lives in `pointDigest.ts` (SP3e spec §6: `sp3eGoldens.ts` hashes it too). Follows the core determinism rules (arch-tested).
 * Every value is hex64.
 */
import { MAP_LEVELS, type MapLevel } from '../core/constants';
import { fnv1a32, fnv1a64Bytes, hashF64, hex64 } from '../core/hash';
import { resolveProfile, type ProfileId } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { createGenContext, type GenContext } from '../gen/context';
import { buildColumnSample, LEVEL_FIELDS, newColumnSample, SAMPLE_FIELDS } from '../gen/column/columnStage';
import { findSpawn } from '../gen/column/spawn';
import type { LayerId } from '../gen/map/layers';
import { paintTile } from '../gen/map/tile';
import { pointDigest } from './pointDigest';
import { computeGolden as computeSp1, goldenKeys as sp1Keys } from './sp1Goldens';
import { computeSp3aGolden, sp3aGoldenKeys } from './sp3aGoldens';
import { computeSp3bGolden, sp3bGoldenKeys } from './sp3bGoldens';
import { computeSp3cGolden, sp3cGoldenKeys } from './sp3cGoldens';
import { computeSp3eGolden, sp3eGoldenKeys } from './sp3eGoldens';

const FNV32 = fnv1a32;
const FNV_BYTES = fnv1a64Bytes;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE = createGenContext;
const POINT_DIGEST = pointDigest;
const BUILD = buildColumnSample;
const NEW_SAMPLE = newColumnSample;
const SPAWN = findSpawn;
const PAINT = paintTile;
const LEVELS = MAP_LEVELS;
const FIELDS = SAMPLE_FIELDS;
const LEVEL_F = LEVEL_FIELDS;
const SP1 = computeSp1;
const SP1_KEYS = sp1Keys;
const SP3A = computeSp3aGolden;
const SP3A_KEYS = sp3aGoldenKeys;
const SP3B = computeSp3bGolden;
const SP3B_KEYS = sp3bGoldenKeys;
const SP3C = computeSp3cGolden;
const SP3C_KEYS = sp3cGoldenKeys;
const SP3E = computeSp3eGolden;
const SP3E_KEYS = sp3eGoldenKeys;

const POINT_PROFILES: readonly ProfileId[] = ['default', 'large_biomes'];
const TILE_LAYERS: readonly LayerId[] = ['biome', 'relief', 'rivers', 'C'];

const ctxFor = (profile: ProfileId): GenContext => CREATE(SEED('42'), RESOLVE(profile));

/** 64 full ColumnSamples at columns from Xoshiro128(fnv1a32('sp2a.sample')), default profile. */
export function sampleDigest(): string {
  const ctx = ctxFor('default');
  const r = new Rng(FNV32('sp2a.sample'));
  const s = NEW_SAMPLE();
  const per = (FIELDS.length + LEVEL_F.length + 2) * 49;
  const out = new Float64Array(64 * per);
  for (let c = 0; c < 64; c++) {
    BUILD(ctx, r.nextInt(65536) - 32768, r.nextInt(65536) - 32768, s);
    let o = c * per;
    for (const f of [...FIELDS, ...LEVEL_F]) for (let k = 0; k < 49; k++) out[o++] = s.f[f][k]!;
    for (let k = 0; k < 49; k++) out[o++] = s.flags[k]!;
    for (let k = 0; k < 49; k++) out[o++] = s.biome[k]!;
  }
  return HEX64(HASH_F64(out));
}

/** RGBA digest of tile (1, −1) of `layer` at `level`, default profile. */
export function tileDigest(layer: LayerId, level: MapLevel): string {
  return HEX64(FNV_BYTES(new Uint8Array(PAINT(ctxFor('default'), layer, level, 1, -1, new Uint8ClampedArray(262144)).buffer)));
}

/** Spawns of seeds 1..64 (x, z, y, biome, fallback), default profile. */
export function spawnDigest(): string {
  const params = RESOLVE('default');
  const out = new Float64Array(64 * 5);
  for (let s = 1; s <= 64; s++) {
    const sp = SPAWN(CREATE(SEED(String(s)), params));
    out.set([sp.x, sp.z, sp.y, sp.biome, sp.fallback ? 1 : 0], 5 * (s - 1));
  }
  return HEX64(HASH_F64(out));
}

export function sp2aGoldenKeys(): string[] {
  return [
    ...POINT_PROFILES.map((p) => `sp2a.column.point.${p}`),
    'sp2a.column.sample',
    ...TILE_LAYERS.flatMap((l) => LEVELS.map((b) => `sp2a.tile.${l}.${b}`)),
    'sp2a.spawn',
  ];
}

export function computeSp2aGolden(key: string): string {
  const m = /^sp2a\.(column\.point|column\.sample|tile|spawn)(?:\.(.+))?$/.exec(key);
  if (m !== null) {
    if (m[1] === 'column.point' && (POINT_PROFILES as readonly string[]).includes(m[2] ?? '')) return POINT_DIGEST(m[2] as ProfileId);
    if (m[1] === 'column.sample' && m[2] === undefined) return sampleDigest();
    if (m[1] === 'spawn' && m[2] === undefined) return spawnDigest();
    if (m[1] === 'tile') {
      const [layer, level] = (m[2] ?? '').split('.');
      if ((TILE_LAYERS as readonly string[]).includes(layer ?? '') && (LEVELS as readonly number[]).includes(Number(level))) return tileDigest(layer as LayerId, Number(level) as MapLevel);
    }
  }
  throw new Error(`unknown golden ${key}`);
}

/** Every golden key of the build (SP1, SP2a, SP3a, SP3b, SP3c, then SP3e). */
export function allGoldenKeys(): string[] {
  return [...SP1_KEYS(), ...sp2aGoldenKeys(), ...SP3A_KEYS(), ...SP3B_KEYS(), ...SP3C_KEYS(), ...SP3E_KEYS()];
}

export function computeAnyGolden(key: string): string {
  if (key.startsWith('sp3a.')) return SP3A(key);
  if (key.startsWith('sp3b.')) return SP3B(key);
  if (key.startsWith('sp3c.')) return SP3C(key);
  if (key.startsWith('sp3e.')) return SP3E(key);
  return key.startsWith('sp2a.') ? computeSp2aGolden(key) : SP1(key);
}

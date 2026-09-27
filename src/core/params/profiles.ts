import type { SubProjectId } from '../ids';
import { DEFAULTS } from './defaults';
import { applyPatch } from './kit';
import { SCHEMA, type Params, type ParamsPatch } from './schema';

export type ProfileId = 'default' | 'large_biomes' | 'archipelago' | 'amplified' | 'floating_islands' | 'cave_heavy';

export interface Profile {
  readonly overlay: ParamsPatch;
  /** Hidden in the UI until this sub-project has started. */
  readonly readyFrom: SubProjectId;
}

export const PROFILE_IDS: readonly ProfileId[] = ['default', 'large_biomes', 'archipelago', 'amplified', 'floating_islands', 'cave_heavy'];

/** Built-in world presets (master §3.15) as overlays over the defaults (SP1 spec §4.4). */
export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
  default: { overlay: {}, readyFrom: 'SP1' },
  large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2' },
  archipelago: { overlay: { climate: { C: { wavelength: 840 } } }, readyFrom: 'SP3' },
  amplified: { overlay: {}, readyFrom: 'SP3' },
  floating_islands: { overlay: {}, readyFrom: 'SP3' },
  cave_heavy: { overlay: {}, readyFrom: 'SP6' },
};

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v);
}

/** DEFAULTS ⊕ overlay; throws on an invalid overlay (every profile is resolved by a unit test). */
export function resolveProfile(id: ProfileId): Params {
  const r = applyPatch(SCHEMA, DEFAULTS, PROFILES[id].overlay);
  if (!r.ok) throw new Error(`profile ${id} has an invalid overlay: ${r.issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
  return r.value;
}

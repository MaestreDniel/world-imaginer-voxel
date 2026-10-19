import { CURRENT_SP, SUB_PROJECTS, type SubProjectId } from '../ids';
import { DEFAULTS } from './defaults';
import { ARCHIPELAGO_BIOME_TABLE } from './biomeDefaults';
import { applyPatch } from './kit';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE, FLOATING_SURFACE_RULES } from './presetTrees';
import { SCHEMA, type Params, type ParamsPatch } from './schema';
import { ARCHIPELAGO_JAG, ARCHIPELAGO_OFFSET, ARCHIPELAGO_SIGMA } from './shapeDefaults';

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
  large_biomes: { overlay: { climate: { scaleMul: 4 } }, readyFrom: 'SP2a' },
  archipelago: {
    overlay: {
      climate: { C: { wavelength: 840 } },
      shape: { offset: ARCHIPELAGO_OFFSET, sigma: ARCHIPELAGO_SIGMA, jag: ARCHIPELAGO_JAG },
      rivers: { coastFadeLo: 0.3, coastFadeHi: 0.4 },
      lakes: { minC: 0.32 },
      biomes: { table: ARCHIPELAGO_BIOME_TABLE },
    },
    readyFrom: 'SP3e',
  },
  amplified: { overlay: { density: { defs: AMPLIFIED_DENSITY_TREE } }, readyFrom: 'SP3e' },
  floating_islands: {
    overlay: { islands: { enabled: true }, density: { defs: FLOATING_DENSITY_TREE }, surface: { rules: FLOATING_SURFACE_RULES } },
    readyFrom: 'SP3e',
  },
  cave_heavy: { overlay: {}, readyFrom: 'SP6' },
};

/** A profile is selectable once its readyFrom is at or before `current` in master §10 order. */
export function isProfileReady(id: ProfileId, current: SubProjectId = CURRENT_SP): boolean {
  return SUB_PROJECTS.indexOf(PROFILES[id].readyFrom) <= SUB_PROJECTS.indexOf(current);
}

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v);
}

/** DEFAULTS ⊕ overlay; throws on an invalid overlay (every profile is resolved by a unit test). */
export function resolveProfile(id: ProfileId): Params {
  const r = applyPatch(SCHEMA, DEFAULTS, PROFILES[id].overlay);
  if (!r.ok) throw new Error(`profile ${id} has an invalid overlay: ${r.issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
  return r.value;
}

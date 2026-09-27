import { applyPatch, diffParams, isObj, type Issue, type Result } from './kit';
import { migrate, MIGRATIONS, type JsonObject, type Migration } from './migrate';
import { isProfileId, resolveProfile, type ProfileId } from './profiles';
import { SCHEMA, type Params, type ParamsPatch } from './schema';

export interface PresetDoc {
  readonly format: 'wi10-preset';
  readonly schemaVersion: number;
  readonly name: string;
  readonly profile: ProfileId;
  readonly params: ParamsPatch;
}

const ENVELOPE_KEYS = ['format', 'schemaVersion', 'name', 'profile', 'params'];

/** params = the minimal patch over the profile (SP1 spec §4.5). */
export function exportPreset(name: string, profile: ProfileId, draft: Params): PresetDoc {
  return { format: 'wi10-preset', schemaVersion: MIGRATIONS.length + 1, name: name.trim(), profile, params: diffParams(SCHEMA, resolveProfile(profile), draft) };
}

/**
 * Unknown envelope keys first (all), then format → name → profile → schemaVersion (stop at the first
 * failure), then migrate, then every applyPatch issue with a `params.` prefix. Nothing is applied on error.
 */
export function importPreset(doc: unknown, migrations: readonly Migration[] = MIGRATIONS): Result<{ name: string; profile: ProfileId; params: Params }> {
  if (!isObj(doc)) return { ok: false, issues: [{ path: '', code: 'NOT_OBJECT', message: 'a preset must be a JSON object' }] };
  const issues: Issue[] = [];
  for (const k of Object.keys(doc)) if (!ENVELOPE_KEYS.includes(k)) issues.push({ path: k, code: 'UNKNOWN_KEY', message: `unknown key "${k}"` });
  const stop = (i: Issue) => ({ ok: false as const, issues: [...issues, i] });
  if (doc['format'] !== 'wi10-preset') return stop({ path: 'format', code: 'BAD_FORMAT', message: 'format must be "wi10-preset"' });
  const rawName = doc['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length < 1 || name.length > 64) return stop({ path: 'name', code: 'BAD_NAME', message: 'a name has 1-64 characters after trimming' });
  if (isProfileId(name)) return stop({ path: 'name', code: 'RESERVED_NAME', message: `"${name}" is a built-in profile name` });
  const profile = doc['profile'];
  if (!isProfileId(profile)) return stop({ path: 'profile', code: 'UNKNOWN_PROFILE', message: `unknown profile ${JSON.stringify(profile)}` });
  const version = doc['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return stop({ path: 'schemaVersion', code: 'BAD_SCHEMA_VERSION', message: 'schemaVersion must be an integer ≥ 1' });
  const current = migrations.length + 1;
  if (version > current) return stop({ path: 'schemaVersion', code: 'NEWER_SCHEMA_VERSION', message: `schemaVersion ${version} is newer than this build (${current})` });
  const params = doc['params'];
  if (!isObj(params)) return stop({ path: 'params', code: 'NOT_OBJECT', message: 'params must be an object' });
  const m = migrate(params as JsonObject, version, migrations);
  if (!m.ok) return stop({ path: 'params', code: 'MIGRATION_FAILED', message: m.issues[0]!.message });
  const r = applyPatch(SCHEMA, resolveProfile(profile), m.value);
  if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: i.path === '' ? 'params' : `params.${i.path}` })));
  if (issues.length > 0 || !r.ok) return { ok: false, issues };
  return { ok: true, value: { name, profile, params: r.value } };
}

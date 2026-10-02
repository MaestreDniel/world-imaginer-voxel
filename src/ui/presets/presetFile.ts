/**
 * Preset files (SP2b spec §3.4), the pure part of the Presets tab: name checks, file names, the file
 * text of the SP1 `wi10-preset` envelope, and reading a file back to `{name, profile, patch}` with the
 * minimal patch over a ready profile, or the issues to list.
 */
import { diffParams, type Issue } from '../../core/params/kit';
import { exportPreset, importPreset } from '../../core/params/presets';
import { isProfileId, isProfileReady, PROFILES, resolveProfile, type ProfileId } from '../../core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';

const NAME_MAX = 64;
const FILE_SUFFIX = '.wi10-preset.json';

/**
 * Why `name` cannot be exported, or null. It accepts exactly the names `importPreset` accepts (SP1
 * spec §4.5): the trim is 1-64 UTF-16 units and not a profile id (case-sensitive).
 */
export function presetNameProblem(name: string): string | null {
  const t = name.trim();
  if (t.length === 0) return 'enter a name';
  if (t.length > NAME_MAX) return `the name has ${t.length} characters; the limit is ${NAME_MAX}`;
  if (isProfileId(t)) return `"${t}" is a built-in profile name`;
  return null;
}

/**
 * `<stem>.wi10-preset.json`: the trimmed name with every code point outside `[A-Za-z0-9 _.-]` replaced
 * by `_`, at most 64 characters (`preset` when nothing is left).
 */
export function presetFileName(name: string): string {
  const stem = name.trim().replace(/[^A-Za-z0-9 _.-]/gu, '_').slice(0, NAME_MAX);
  return `${stem === '' ? 'preset' : stem}${FILE_SUFFIX}`;
}

/** The file text: `exportPreset(name, profile, params)` as 2-space JSON in envelope order, newline-terminated. */
export function presetText(name: string, profile: ProfileId, params: Params): string {
  const problem = presetNameProblem(name);
  if (problem !== null) throw new Error(`invalid preset name: ${problem}`);
  return `${JSON.stringify(exportPreset(name, profile, params), null, 2)}\n`;
}

export type PresetRead =
  | { readonly ok: true; readonly name: string; readonly profile: ProfileId; readonly patch: ParamsPatch }
  | { readonly ok: false; readonly issues: readonly string[] };

const issueLine = (i: Issue): string => `${i.path === '' ? 'file' : i.path}: ${i.code} — ${i.message}`;

/**
 * JSON.parse → importPreset → the profile must be ready → the minimal patch over the profile, so the
 * caller's `session.load({profile, patch})` stores what the session itself would store.
 */
export function readPresetText(text: string): PresetRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [`file is not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const r = importPreset(doc);
  if (!r.ok) return { ok: false, issues: r.issues.map(issueLine) };
  const { name, profile, params } = r.value;
  if (!isProfileReady(profile)) return { ok: false, issues: [`profile ${profile} arrives in ${PROFILES[profile].readyFrom}`] };
  return { ok: true, name, profile, patch: diffParams(SCHEMA, resolveProfile(profile), params) };
}

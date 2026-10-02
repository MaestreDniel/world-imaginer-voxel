/**
 * Preset files (SP2b spec §3.4), the pure part of the Presets tab: name checks, file names, the file
 * text of the SP1 `wi10-preset` envelope, and reading a file back to `{name, profile, patch}` with the
 * minimal patch over a ready profile, or the issues to list. The tab's logic over the session is here
 * too: export of the draft, import as one `load`, and the advanced JSON patch box.
 */
import { canonicalJSON } from '../../core/params/canonical';
import { diffParams, type Issue } from '../../core/params/kit';
import { exportPreset, importPreset } from '../../core/params/presets';
import { isProfileId, isProfileReady, PROFILES, resolveProfile, type ProfileId } from '../../core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';
import type { WorldSession } from '../../engine/session';

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

/** 'PATH: CODE — message'; the root path prints as `root` ('file' for a preset, 'patch' for the patch box). */
const issueLineAt = (root: string) => (i: Issue): string => `${i.path === '' ? root : i.path}: ${i.code} — ${i.message}`;
const issueLine = issueLineAt('file');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * JSON.parse → importPreset → the profile must be ready → the minimal patch over the profile, so the
 * caller's `session.load({profile, patch})` stores what the session itself would store.
 */
export function readPresetText(text: string): PresetRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [`file is not JSON: ${messageOf(e)}`] };
  }
  const r = importPreset(doc);
  if (!r.ok) return { ok: false, issues: r.issues.map(issueLine) };
  const { name, profile, params } = r.value;
  if (!isProfileReady(profile)) return { ok: false, issues: [`profile ${profile} arrives in ${PROFILES[profile].readyFrom}`] };
  return { ok: true, name, profile, patch: diffParams(SCHEMA, resolveProfile(profile), params) };
}

// ---------------------------------------------------------------- the tab's logic over the session

/** The part of the session the Presets tab reads and loads. */
export type PresetSession = Pick<WorldSession, 'state' | 'load'>;

/** What the export row shows under the name field: the file it saves, a request for a name, or why the name is refused. */
export interface NameHint {
  readonly kind: 'ok' | 'empty' | 'problem';
  readonly text: string;
}

export function presetNameHint(name: string): NameHint {
  const problem = presetNameProblem(name);
  if (problem === null) return { kind: 'ok', text: `saves ${presetFileName(name)}` };
  return { kind: name.trim() === '' ? 'empty' : 'problem', text: problem };
}

export type PresetExport =
  | { readonly ok: true; readonly fileName: string; readonly text: string }
  | { readonly ok: false; readonly problem: string };

/** Export (§3.4): `exportPreset(name, session profile, session params)` as the file text, with its file name; or the name's problem. */
export function exportDraft(name: string, session: PresetSession): PresetExport {
  const problem = presetNameProblem(name);
  if (problem !== null) return { ok: false, problem };
  const { profile, params } = session.state;
  return { ok: true, fileName: presetFileName(name), text: presetText(name, profile, params) };
}

export type PresetLoad =
  | { readonly ok: true; readonly name: string; readonly changed: boolean }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Import (§3.4): `readPresetText`, then one `session.load({profile, patch})` without a seed, so the seed
 * is kept and the load is one undo step when it changes the draft (`changed`). On failure nothing changes.
 */
export function loadPresetText(session: PresetSession, text: string): PresetLoad {
  const r = readPresetText(text);
  if (!r.ok) return r;
  const before = session.state;
  const loaded = session.load({ profile: r.profile, patch: r.patch });
  if (!loaded.ok) return { ok: false, issues: loaded.issues.map(issueLine) };
  return { ok: true, name: r.name, changed: session.state !== before };
}

/** The notice after an import. */
export const loadedNotice = (name: string): string => `loaded preset ${name}`;

/** The advanced JSON patch box shows `canonicalJSON` of the draft's minimal patch. */
export function patchBoxText(patch: ParamsPatch): string {
  return canonicalJSON(patch);
}

export type PatchApply = { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly issues: readonly string[] };

const patchIssueLine = issueLineAt('patch');

/**
 * Apply of the patch box: the text (empty = `{}`) replaces the whole patch over the session's profile
 * with one `session.load({profile, patch})`, which keeps the seed and is one undo step when it changes
 * the draft. JSON errors and the validator's issues are returned as lines; on failure nothing changes.
 */
export function applyPatchText(session: PresetSession, text: string): PatchApply {
  let patch: unknown;
  try {
    patch = text.trim() === '' ? {} : JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [`patch is not JSON: ${messageOf(e)}`] };
  }
  const before = session.state;
  const r = session.load({ profile: before.profile, patch });
  if (!r.ok) return { ok: false, issues: r.issues.map(patchIssueLine) };
  return { ok: true, changed: session.state !== before };
}

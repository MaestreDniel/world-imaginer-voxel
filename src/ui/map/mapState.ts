/**
 * The ?map URL state (SP2a spec §6.3, SP2b spec §1.4): {v: 1, seed, profile, patch, view: {x, z, bpp,
 * layer}} as canonical JSON in base64url, with the session's minimal patch. A bad hash opens the defaults
 * with a notice; a `hashchange` applies the view, then loads the draft in one session step. The page's session comes
 * from `openMapSession`, which wires tier 2 of the trees (SP3d spec §1.8): `decodeMapState` checks tier 1 only, so
 * the session refuses a semantically invalid tree in a link, at the constructor (a fresh tab) or at `load` (a
 * `hashchange`). A saved world's session comes from its record instead (`openSavedSession`, SP5b), with the same tier 2.
 */
import { utf8Bytes, type Seed64 } from '../../core/hash';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { applyPatch, diffParams, isObj } from '../../core/params/kit';
import { isProfileId, isProfileReady, resolveProfile, type ProfileId } from '../../core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';
import { WorldSession, type SessionResult } from '../../engine/session';
import type { WorldRecord } from '../../persist/saves';
import { isLayerId, type LayerId } from '../../gen/map/layers';
import { validateParamTrees } from '../../gen/trees';
import { base64urlDecode, base64urlEncode } from '../common/base64url';

export interface MapView {
  readonly x: number;
  readonly z: number;
  /** Display scale in blocks per screen pixel. */
  readonly bpp: number;
  readonly layer: LayerId;
}

export interface MapState {
  readonly v: 1;
  readonly seed: string;
  readonly profile: ProfileId;
  readonly patch: ParamsPatch;
  readonly view: MapView;
}

export const MAP_MIN_BPP = 0.25;
export const MAP_MAX_BPP = 256;
const WINDOW = 524288;
/** A hash longer than this (1 MiB of text) is refused before it is decoded (SP3d spec §1.12). */
export const MAP_HASH_READ_MAX = 1048576;
export const DEFAULT_MAP_STATE: MapState = { v: 1, seed: '42', profile: 'default', patch: {}, view: { x: 0, z: 0, bpp: 64, layer: 'biome' } };

const q = (v: number) => q15(v) + 0;

export function encodeMapState(s: MapState): string {
  const view = { x: q(s.view.x), z: q(s.view.z), bpp: q(s.view.bpp), layer: s.view.layer };
  return base64urlEncode(utf8Bytes(canonicalJSON({ ...s, seed: s.seed.trim(), view })));
}

const KEYS = ['v', 'seed', 'profile', 'patch', 'view'];
const VIEW_KEYS = ['x', 'z', 'bpp', 'layer'];

function reason(j: unknown): string | null {
  if (!isObj(j)) return 'not an object';
  const extra = Object.keys(j).find((k) => !KEYS.includes(k));
  if (extra !== undefined) return `unknown key ${extra}`;
  if (j['v'] !== 1) return 'unsupported version';
  if (typeof j['seed'] !== 'string' || j['seed'].trim() === '' || /[\r\n]/.test(j['seed'])) return 'bad seed';
  if (!isProfileId(j['profile'])) return 'unknown profile';
  if (!isProfileReady(j['profile'])) return `profile ${j['profile']} is not available yet`;
  if (!isObj(j['patch'])) return 'patch is not an object';
  const r = applyPatch(SCHEMA, resolveProfile(j['profile']), j['patch']);
  if (!r.ok) return `invalid patch (${r.issues[0]!.path} ${r.issues[0]!.code})`;
  const v = j['view'];
  if (!isObj(v) || Object.keys(v).some((k) => !VIEW_KEYS.includes(k))) return 'bad view';
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!fin(v['x']) || !fin(v['z']) || Math.abs(v['x']) > WINDOW || Math.abs(v['z']) > WINDOW) return 'view outside the window';
  if (!fin(v['bpp']) || v['bpp'] < MAP_MIN_BPP || v['bpp'] > MAP_MAX_BPP) return 'zoom out of range';
  if (!isLayerId(v['layer'])) return 'unknown layer';
  return null;
}

export function decodeMapState(hash: string): { state: MapState; error: string | null } {
  const text = hash.replace(/^#/, '');
  if (text === '') return { state: DEFAULT_MAP_STATE, error: null };
  const fail = (why: string) => ({ state: DEFAULT_MAP_STATE, error: `map URL ignored: ${why}` });
  if (text.length > MAP_HASH_READ_MAX) return fail(`too long (${text.length} characters, limit ${MAP_HASH_READ_MAX})`);
  const bytes = base64urlDecode(text);
  if (bytes === null) return fail('not base64url');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('not JSON');
  }
  const why = reason(json);
  if (why !== null) return fail(why);
  const s = json as MapState;
  return { state: { ...s, seed: s.seed.trim() }, error: null };
}

/**
 * The ?map page's WorldSession for the decoded (or perf-pinned) start state, with tier 2 of the trees as its
 * `validateParams` (SP3d spec §1.8, D2): an initial patch whose trees tier 2 refuses opens the default profile with
 * no changes and `initNotice` `invalid patch (<path> <code>); opened the default profile with no changes`, and
 * `setProfile`, the commits, `load` (so a `hashchange`) and undo/redo run the same check. Every page session is built
 * here (the arch test greps `new WorldSession(` under src/ui/ for `validateParams`).
 */
export function openMapSession(decoded: MapState, random: () => Seed64): WorldSession {
  return new WorldSession(random, { seedText: decoded.seed, profile: decoded.profile, patch: decoded.patch, validateParams: validateParamTrees });
}

/**
 * A saved world's session (SP5b spec §2.1, §3.4 step 2): the record's seed text and profile, and `params` (the record's
 * `loadParams`) as the minimal patch over the profile, with tier 2 of the trees as `openMapSession`'s. A saved document
 * tier 2 refuses opens `default` with `{}` and the session's `initNotice`, which the page takes as a refusal.
 */
export function openSavedSession(params: Params, w: Pick<WorldRecord, 'seedText' | 'profile'>, random: () => Seed64): WorldSession {
  return new WorldSession(random, {
    seedText: w.seedText, profile: w.profile, patch: diffParams(SCHEMA, resolveProfile(w.profile), params), validateParams: validateParamTrees,
  });
}

/** The session call a hash load needs (WorldSession satisfies it). */
export interface HashTarget {
  load(s: { readonly seedText?: string; readonly profile: ProfileId; readonly patch: unknown }): SessionResult;
}

/**
 * A `hashchange` (SP2b spec §1.4, SP1 minor 5): decodes `hash`. An invalid hash returns the SP2a notice and
 * changes nothing. Otherwise the view goes to `setView` (never a history step), then seed, profile and patch
 * go to one `load` (urgent, one step; a no-op when they are unchanged). The raw decoded patch only reaches
 * the session, which stores its minimal form, so a −0 in it never reaches canonicalJSON. An empty hash is
 * the defaults, as when the page opens. Returns null, or a notice when the load is refused: a hash whose trees pass
 * tier 1 but not tier 2 (SP3d spec §1.8) is refused by the session's validator, after the view was applied, so the
 * view moves and the draft does not.
 */
export function applyMapHash(hash: string, session: HashTarget, setView: (v: MapView) => void): string | null {
  const d = decodeMapState(hash);
  if (d.error !== null) return d.error;
  setView(d.state.view);
  const r = session.load({ seedText: d.state.seed, profile: d.state.profile, patch: d.state.patch });
  if (r.ok) return null;
  const i = r.issues[0]!;
  return `map URL ignored: ${i.path === '' ? '<root>' : i.path} ${i.code}`;
}

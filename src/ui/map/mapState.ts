/**
 * The ?map URL state (SP2a spec §6.3, SP2b spec §1.4): {v: 1, seed, profile, patch, view: {x, z, bpp,
 * layer}} as canonical JSON in base64url, with the session's minimal patch. A bad hash opens the defaults
 * with a notice; a `hashchange` applies the view, then loads the draft in one session step.
 */
import { utf8Bytes } from '../../core/hash';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { applyPatch, isObj } from '../../core/params/kit';
import { isProfileId, isProfileReady, resolveProfile, type ProfileId } from '../../core/params/profiles';
import { SCHEMA, type ParamsPatch } from '../../core/params/schema';
import type { SessionResult } from '../../engine/session';
import { isLayerId, type LayerId } from '../../gen/map/layers';
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

/** The session call a hash load needs (WorldSession satisfies it). */
export interface HashTarget {
  load(s: { readonly seedText?: string; readonly profile: ProfileId; readonly patch: unknown }): SessionResult;
}

/**
 * A `hashchange` (SP2b spec §1.4, SP1 minor 5): decodes `hash`. An invalid hash returns the SP2a notice and
 * changes nothing. Otherwise the view goes to `setView` (never a history step), then seed, profile and patch
 * go to one `load` (urgent, one step; a no-op when they are unchanged). The raw decoded patch only reaches
 * the session, which stores its minimal form, so a −0 in it never reaches canonicalJSON. An empty hash is
 * the defaults, as when the page opens. Returns null, or a notice when the load is refused.
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

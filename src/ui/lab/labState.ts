import { utf8Bytes } from '../../core/hash';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { DEFAULTS } from '../../core/params/defaults';
import { applyPatch, isObj, patchAt, type Issue } from '../../core/params/kit';
import { SCHEMA, type Params, type ParamsPatch } from '../../core/params/schema';
import { WINDOW } from '../../metrics/noiseStats';

export type LabMode = 'z' | 'u';
export type LabPlane = 'xz' | 'xy';

export interface LabView {
  readonly x: number;
  readonly z: number;
  readonly bpp: number;
  readonly mode: LabMode;
  readonly plane?: LabPlane;
  readonly slice?: number;
}

export interface LabB {
  readonly seed?: string;
  readonly patch?: ParamsPatch;
}

/** The lab's URL state (SP1 spec §6). `seed` is the trimmed box text; `noise` a seed name; patches are over DEFAULTS. */
export interface LabState {
  readonly v: 1;
  readonly seed: string;
  readonly noise: string;
  readonly patch: ParamsPatch;
  readonly view: LabView;
  readonly b?: LabB;
}

export const MIN_BPP = 0.0625;
export const MAX_BPP = 1024;
export const DEFAULT_LAB_STATE: LabState = { v: 1, seed: '42', noise: 'climate.C', patch: {}, view: { x: 0, z: 0, bpp: 64, mode: 'u' } };

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  const b64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Deep merge of plain objects; arrays and scalars in `b` replace. */
export function mergePatch(a: unknown, b: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(a) ? { ...a } : {};
  if (!isObj(b)) return out;
  for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(out[k]) ? mergePatch(out[k], b[k]) : b[k];
  return out;
}

const q = (v: number) => q15(v) + 0;

function normalize(s: LabState): LabState {
  const v = s.view;
  const view: LabView = {
    x: q(v.x), z: q(v.z), bpp: q(v.bpp), mode: v.mode,
    ...(v.plane !== undefined ? { plane: v.plane } : {}),
    ...(v.slice !== undefined ? { slice: q(v.slice) } : {}),
  };
  return { ...s, seed: s.seed.trim(), view };
}

export function encodeLabState(s: LabState): string {
  return base64urlEncode(utf8Bytes(canonicalJSON(normalize(s))));
}

/** A: DEFAULTS ⊕ patch; B: A ⊕ b.patch (null when A/B is off). Throws only on states that bypassed decode. */
export function labParams(s: LabState): { a: Params; b: Params | null } {
  const a = applyPatch(SCHEMA, DEFAULTS, s.patch);
  if (!a.ok) throw new Error('invalid lab patch');
  if (s.b === undefined) return { a: a.value, b: null };
  const b = applyPatch(SCHEMA, a.value, s.b.patch ?? {});
  if (!b.ok) throw new Error('invalid lab B patch');
  return { a: a.value, b: b.value };
}

const formatIssues = (prefix: string, issues: readonly Issue[]) => issues.map((i) => `${prefix}${i.path}: ${i.code} — ${i.message}`);

/**
 * One NoiseDef field edit on side A or B (B only while A/B is on). Rejected, with the state unchanged, when
 * it would make A invalid or make B (= A ⊕ b.patch) invalid, so `labParams` stays total for edited states.
 * B issues are prefixed `B: `.
 */
export function applyLabEdit(s: LabState, target: 'A' | 'B', path: string, field: string, value: unknown): { ok: true; state: LabState } | { ok: false; issues: string[] } {
  const delta = patchAt(path, { [field]: value });
  if (target === 'B' && s.b !== undefined) {
    const a = applyPatch(SCHEMA, DEFAULTS, s.patch);
    if (!a.ok) return { ok: false, issues: formatIssues('', a.issues) };
    const nextB = mergePatch(s.b.patch ?? {}, delta) as ParamsPatch;
    const b = applyPatch(SCHEMA, a.value, nextB);
    return b.ok ? { ok: true, state: { ...s, b: { ...s.b, patch: nextB } } } : { ok: false, issues: formatIssues('B: ', b.issues) };
  }
  const next = mergePatch(s.patch, delta) as ParamsPatch;
  const a = applyPatch(SCHEMA, DEFAULTS, next);
  if (!a.ok) return { ok: false, issues: formatIssues('', a.issues) };
  if (s.b?.patch !== undefined) {
    const b = applyPatch(SCHEMA, a.value, s.b.patch);
    if (!b.ok) return { ok: false, issues: formatIssues('B: ', b.issues) };
  }
  return { ok: true, state: { ...s, patch: next } };
}

const STATE_KEYS = ['v', 'seed', 'noise', 'patch', 'view', 'b'];
const VIEW_KEYS = ['x', 'z', 'bpp', 'mode', 'plane', 'slice'];
const B_KEYS = ['seed', 'patch'];

function reason(j: unknown): string | null {
  if (!isObj(j)) return 'not an object';
  const extra = Object.keys(j).find((k) => !STATE_KEYS.includes(k));
  if (extra !== undefined) return `unknown key ${extra}`;
  if (j['v'] !== 1) return 'unsupported version';
  if (typeof j['seed'] !== 'string' || j['seed'].trim() === '') return 'empty seed';
  if (typeof j['noise'] !== 'string' || j['noise'] === '') return 'no noise';
  if (!isObj(j['patch'])) return 'patch is not an object';
  const a = applyPatch(SCHEMA, DEFAULTS, j['patch']);
  if (!a.ok) return `invalid patch (${a.issues[0]!.path} ${a.issues[0]!.code})`;
  const v = j['view'];
  if (!isObj(v)) return 'view is not an object';
  if (Object.keys(v).some((k) => !VIEW_KEYS.includes(k))) return 'unknown view key';
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!fin(v['x']) || !fin(v['z']) || Math.abs(v['x']) > WINDOW || Math.abs(v['z']) > WINDOW) return 'view outside the window';
  if (!fin(v['bpp']) || v['bpp'] < MIN_BPP || v['bpp'] > MAX_BPP) return 'zoom out of range';
  if (v['mode'] !== 'z' && v['mode'] !== 'u') return 'bad mode';
  if (v['plane'] !== undefined && v['plane'] !== 'xz' && v['plane'] !== 'xy') return 'bad plane';
  if (v['slice'] !== undefined && !fin(v['slice'])) return 'bad slice';
  const b = j['b'];
  if (b !== undefined) {
    if (!isObj(b) || Object.keys(b).some((k) => !B_KEYS.includes(k))) return 'bad B state';
    if (b['seed'] !== undefined && (typeof b['seed'] !== 'string' || b['seed'].trim() === '')) return 'empty B seed';
    if (b['patch'] !== undefined) {
      if (!isObj(b['patch'])) return 'B patch is not an object';
      const bb = applyPatch(SCHEMA, a.value, b['patch']);
      if (!bb.ok) return `invalid B patch (${bb.issues[0]!.path} ${bb.issues[0]!.code})`;
    }
  }
  return null;
}

export function decodeLabState(hash: string): { state: LabState; error: string | null } {
  const text = hash.replace(/^#/, '');
  if (text === '') return { state: DEFAULT_LAB_STATE, error: null };
  const fail = (why: string) => ({ state: DEFAULT_LAB_STATE, error: `lab URL ignored: ${why}` });
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
  return { state: normalize(json as LabState), error: null };
}

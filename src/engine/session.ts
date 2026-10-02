/**
 * WorldSession (SP2b spec §1): the single owner of the draft — seed text, profile, a minimal canonical
 * patch over the profile, the resolved params and an epoch that bumps only when the seed or the params
 * change. Every editor, the biome-size slider, the URL and preset loads go through it.
 */
import { hex64, type Seed64 } from '../core/hash';
import { canonicalJSON } from '../core/params/canonical';
import { applyPatch, checkLeaf, deepFreeze, diffParams, getPath, isObj, patchAt, type Issue, type Node } from '../core/params/kit';
import { isProfileId, isProfileReady, resolveProfile, type ProfileId } from '../core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../core/params/schema';
import { resolveSeedText } from '../core/seed';
import { paramsHash } from '../core/stage/hash';

export interface SessionState {
  readonly seedText: string;
  readonly seed: Seed64;
  readonly profile: ProfileId;
  /** Always `diffParams(SCHEMA, resolveProfile(profile), params)`, deep-frozen (spec §1.1). */
  readonly patch: ParamsPatch;
  readonly params: Params;
  readonly epoch: number;
}

export type SessionResult = { readonly ok: true; readonly state: SessionState } | { readonly ok: false; readonly issues: readonly Issue[] };

/** The draft without its derived fields: what `load` takes and history records. */
export interface SessionSnapshot {
  readonly seedText: string;
  readonly profile: ProfileId;
  readonly patch: ParamsPatch;
}

function profileIssue(id: unknown): Issue | null {
  if (!isProfileId(id)) return { path: 'profile', code: 'BAD_ENUM', message: `unknown profile ${String(id)}` };
  if (!isProfileReady(id)) return { path: 'profile', code: 'BAD_ENUM', message: `profile ${id} is not available yet` };
  return null;
}

/** The schema node at a group or leaf path ('' is the root); any other path is a programming error. */
function nodeAt(path: string): Node {
  const n = SCHEMA.byPath.get(path);
  if (n === undefined) throw new Error(`unknown param path ${JSON.stringify(path)}`);
  return n;
}

/**
 * Deep-merges `delta` into the patch `base` the way applyPatch reads a patch: groups and noise leaves
 * merge per key; other leaves, arrays and anything that is not an object replace. Undefined keys are
 * skipped (applyPatch ignores them too). Returns new objects; validation happens afterwards.
 */
function mergeInto(node: Node | undefined, base: unknown, delta: unknown): unknown {
  if (node === undefined || (node.tag === 'leaf' && node.merge === 'atomic') || !isObj(base) || !isObj(delta)) return delta;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(delta)) {
    const d = delta[k];
    if (d === undefined) continue;
    const child = node.tag === 'group' && Object.hasOwn(node.children, k) ? node.children[k] : undefined;
    out[k] = mergeInto(child, base[k], d);
  }
  return out;
}

/** A copy of `patch` without the subtree at `keys`. */
function withoutPath(patch: unknown, keys: readonly string[]): unknown {
  const k = keys[0]!;
  if (!isObj(patch) || !Object.hasOwn(patch, k)) return patch;
  const out: Record<string, unknown> = { ...patch };
  if (keys.length === 1) delete out[k];
  else out[k] = withoutPath(patch[k], keys.slice(1));
  return out;
}

/** `set(path, undefined)` is refused with the issue the node's own check gives. */
function undefinedIssues(node: Node, path: string): Issue[] {
  const out: Issue[] = [];
  if (node.tag === 'leaf') checkLeaf(node, undefined, path, out);
  else out.push({ path, code: 'NOT_OBJECT', message: 'expected an object, got undefined' });
  return out;
}

const epochKeyOf = (seed: Seed64, params: Params): string => `${seed[0]}|${seed[1]}|${hex64(paramsHash(params))}`;
const draftKeyOf = (s: SessionSnapshot): string => canonicalJSON({ seedText: s.seedText, profile: s.profile, patch: s.patch });

export class WorldSession {
  /** Non-null when the initial profile or patch was refused and the session opened `default` with `{}` (SP2a minor 8). */
  readonly initNotice: string | null;
  private readonly random: () => Seed64;
  private s: SessionState;
  /** Seed and params hash: the epoch bumps when it changes. */
  private epochKey: string;
  /** canonicalJSON of the snapshot: the draft changed when it changes (the patch is minimal, so it never throws). */
  private draftKey: string;

  constructor(random: () => Seed64, init: { readonly seedText?: string; readonly profile?: ProfileId; readonly patch?: unknown } = {}) {
    this.random = random;
    const seed = resolveSeedText(init.seedText ?? '', random);
    const wanted = init.profile ?? 'default';
    let profile: ProfileId = 'default';
    let params = resolveProfile('default');
    let notice: string | null = null;
    const bad = profileIssue(wanted);
    if (bad !== null) notice = `${bad.message}; opened the default profile with no changes`;
    else {
      const r = applyPatch(SCHEMA, resolveProfile(wanted), init.patch === undefined ? {} : init.patch);
      if (r.ok) {
        profile = wanted;
        params = r.value;
      } else {
        const i = r.issues[0]!;
        notice = `invalid patch (${i.path === '' ? '<root>' : i.path} ${i.code}); opened the default profile with no changes`;
      }
    }
    this.initNotice = notice;
    const patch = deepFreeze(diffParams(SCHEMA, resolveProfile(profile), params));
    this.s = Object.freeze({ seedText: seed.text, seed: seed.seed, profile, patch, params, epoch: 0 });
    this.epochKey = epochKeyOf(seed.seed, params);
    this.draftKey = draftKeyOf(this.s);
  }

  get state(): SessionState {
    return this.s;
  }

  get snapshot(): SessionSnapshot {
    return { seedText: this.s.seedText, profile: this.s.profile, patch: this.s.patch };
  }

  /** SP1 seed rule: trimmed text, or a random seed written back for empty text. */
  setSeedText(text: string): SessionState {
    const r = resolveSeedText(text, this.random);
    return this.commit(r.text, r.seed, this.s.profile, resolveProfile(this.s.profile), this.s.params);
  }

  /** Draws a random seed and writes its text back (the "New seed" button). */
  newSeed(): SessionState {
    return this.setSeedText('');
  }

  /** Switches to a ready profile and clears the patch. The page asks for confirmation, never the session. */
  setProfile(id: ProfileId): SessionResult {
    const bad = profileIssue(id);
    if (bad !== null) return { ok: false, issues: [bad] };
    const base = resolveProfile(id);
    return { ok: true, state: this.commit(this.s.seedText, this.s.seed, id, base, base) };
  }

  /**
   * Deep-merges `patchAt(path, value)` into the patch and validates it over the profile. `path` is a
   * group or leaf path; on a noise leaf `value` is a partial NoiseDef. On failure nothing changes.
   */
  set(path: string, value: unknown): SessionResult {
    const node = nodeAt(path);
    if (value === undefined) return { ok: false, issues: undefinedIssues(node, path) };
    return this.commitPatch(mergeInto(SCHEMA.root, this.s.patch, path === '' ? value : patchAt(path, value)));
  }

  /** Returns a group or a leaf (a noise leaf as a whole) to the profile's value. */
  reset(path: string): SessionResult {
    nodeAt(path);
    return this.commitPatch(path === '' ? {} : withoutPath(this.s.patch, path.split('.')));
  }

  /**
   * Atomic load: resolves `seedText` when given (otherwise keeps the seed), validates the patch over a
   * ready profile, then replaces seed, profile and patch in one commit. On failure nothing changes.
   */
  load(s: { readonly seedText?: string; readonly profile: ProfileId; readonly patch: unknown }): SessionResult {
    const bad = profileIssue(s.profile);
    if (bad !== null) return { ok: false, issues: [bad] };
    const base = resolveProfile(s.profile);
    const r = applyPatch(SCHEMA, base, s.patch);
    if (!r.ok) return { ok: false, issues: r.issues };
    const seed = s.seedText === undefined ? { text: this.s.seedText, seed: this.s.seed } : resolveSeedText(s.seedText, this.random);
    return { ok: true, state: this.commit(seed.text, seed.seed, s.profile, base, r.value) };
  }

  /** Whether the draft differs from the profile at a group or leaf path. */
  modified(path: string): boolean {
    return this.modifiedCount(path) > 0;
  }

  /** How many leaves at or under a group or leaf path differ from the profile. */
  modifiedCount(path: string): number {
    nodeAt(path);
    const prefix = path === '' ? '' : `${path}.`;
    let n = 0;
    for (const l of SCHEMA.leaves) {
      if ((l.path === path || l.path.startsWith(prefix)) && getPath(this.s.patch, l.path) !== undefined) n++;
    }
    return n;
  }

  private commitPatch(patch: unknown): SessionResult {
    const base = resolveProfile(this.s.profile);
    const r = applyPatch(SCHEMA, base, patch);
    if (!r.ok) return { ok: false, issues: r.issues };
    return { ok: true, state: this.commit(this.s.seedText, this.s.seed, this.s.profile, base, r.value) };
  }

  /** Stores the minimal frozen patch; keeps the state object when the draft is unchanged. */
  private commit(seedText: string, seed: Seed64, profile: ProfileId, base: Params, params: Params): SessionState {
    const patch = deepFreeze(diffParams(SCHEMA, base, params));
    const draftKey = draftKeyOf({ seedText, profile, patch });
    if (draftKey === this.draftKey) return this.s;
    const epochKey = epochKeyOf(seed, params);
    this.s = Object.freeze({ seedText, seed, profile, patch, params, epoch: epochKey === this.epochKey ? this.s.epoch : this.s.epoch + 1 });
    this.epochKey = epochKey;
    this.draftKey = draftKey;
    return this.s;
  }
}

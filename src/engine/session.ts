/**
 * WorldSession (SP2b spec §1): the single owner of the draft — seed text, profile, a minimal canonical
 * patch over the profile, the resolved params and an epoch that bumps only when the seed or the params
 * change. Every editor, the biome-size slider, the URL and preset loads go through it; gestures, a
 * global undo/redo history and change notifications sit on top (§1.3).
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

export type ChangeKind = 'seed' | 'profile' | 'set' | 'reset' | 'load' | 'undo' | 'redo' | 'gestureBegin' | 'gestureEnd';

/** `urgent`: preview at once (every edit outside a gesture); `gesture`: an edit or the start of a drag in progress. */
export interface SessionChange {
  readonly kind: ChangeKind;
  readonly urgent: boolean;
  readonly gesture: boolean;
}

export type SessionListener = (state: SessionState, change: SessionChange) => void;

/** Undo steps kept: the history holds up to HISTORY_STEPS + 1 snapshots. */
export const HISTORY_STEPS = 100;

interface HistoryEntry {
  readonly snap: SessionSnapshot;
  readonly key: string;
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
  /** history[cursor] equals the draft except inside a gesture that changed it. */
  private readonly history: HistoryEntry[];
  private cursor = 0;
  private gesture = false;
  private readonly listeners = new Set<SessionListener>();

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
    this.history = [this.entry()];
  }

  get state(): SessionState {
    return this.s;
  }

  get snapshot(): SessionSnapshot {
    return { seedText: this.s.seedText, profile: this.s.profile, patch: this.s.patch };
  }

  get inGesture(): boolean {
    return this.gesture;
  }

  /** Whether undo() would change the cursor (inside a changed gesture it first records the gesture). */
  get canUndo(): boolean {
    return this.cursor > 0 || this.draftKey !== this.history[this.cursor]!.key;
  }

  /** Whether redo() would change the cursor (a gesture that changed the draft drops the redo tail when it ends). */
  get canRedo(): boolean {
    return this.cursor < this.history.length - 1 && this.draftKey === this.history[this.cursor]!.key;
  }

  /** Listeners run after every change of the draft, on undo and redo, and at gesture boundaries. */
  subscribe(l: SessionListener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  /** Starts a drag: edits until endGesture() are non-urgent and form one history step. No-op inside a gesture. */
  beginGesture(): void {
    if (this.gesture) return;
    this.gesture = true;
    this.emit('gestureBegin');
  }

  /** Records the gesture's step (if the draft changed) and always notifies an urgent gestureEnd. No-op outside a gesture. */
  endGesture(): void {
    if (!this.gesture) return;
    this.gesture = false;
    this.recordStep();
    this.emit('gestureEnd');
  }

  undo(): boolean {
    this.endGesture();
    if (this.cursor === 0) return false;
    this.cursor--;
    this.restore('undo');
    return true;
  }

  redo(): boolean {
    this.endGesture();
    if (this.cursor === this.history.length - 1) return false;
    this.cursor++;
    this.restore('redo');
    return true;
  }

  /** SP1 seed rule: trimmed text, or a random seed written back for empty text. */
  setSeedText(text: string): SessionState {
    this.endGesture();
    const r = resolveSeedText(text, this.random);
    return this.commit('seed', r.text, r.seed, this.s.profile, resolveProfile(this.s.profile), this.s.params);
  }

  /** Draws a random seed and writes its text back (the "New seed" button). */
  newSeed(): SessionState {
    return this.setSeedText('');
  }

  /** Switches to a ready profile and clears the patch. The page asks for confirmation, never the session. */
  setProfile(id: ProfileId): SessionResult {
    this.endGesture();
    const bad = profileIssue(id);
    if (bad !== null) return { ok: false, issues: [bad] };
    const base = resolveProfile(id);
    return { ok: true, state: this.commit('profile', this.s.seedText, this.s.seed, id, base, base) };
  }

  /**
   * Deep-merges `patchAt(path, value)` into the patch and validates it over the profile. `path` is a
   * group or leaf path; on a noise leaf `value` is a partial NoiseDef. On failure nothing changes.
   */
  set(path: string, value: unknown): SessionResult {
    const node = nodeAt(path);
    if (value === undefined) return { ok: false, issues: undefinedIssues(node, path) };
    return this.commitPatch('set', mergeInto(SCHEMA.root, this.s.patch, path === '' ? value : patchAt(path, value)));
  }

  /** Returns a group or a leaf (a noise leaf as a whole) to the profile's value. */
  reset(path: string): SessionResult {
    nodeAt(path);
    return this.commitPatch('reset', path === '' ? {} : withoutPath(this.s.patch, path.split('.')));
  }

  /**
   * Atomic load: resolves `seedText` when given (otherwise keeps the seed), validates the patch over a
   * ready profile, then replaces seed, profile and patch in one commit (one notification, at most one
   * epoch bump). Records one history step unless `record` is false; then the change replaces the step at
   * the cursor instead. On failure nothing changes.
   */
  load(s: { readonly seedText?: string; readonly profile: ProfileId; readonly patch: unknown }, opts: { readonly record?: boolean } = {}): SessionResult {
    this.endGesture();
    const bad = profileIssue(s.profile);
    if (bad !== null) return { ok: false, issues: [bad] };
    const base = resolveProfile(s.profile);
    const r = applyPatch(SCHEMA, base, s.patch);
    if (!r.ok) return { ok: false, issues: r.issues };
    const seed = s.seedText === undefined ? { text: this.s.seedText, seed: this.s.seed } : resolveSeedText(s.seedText, this.random);
    return { ok: true, state: this.commit('load', seed.text, seed.seed, s.profile, base, r.value, opts.record ?? true) };
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

  private commitPatch(kind: 'set' | 'reset', patch: unknown): SessionResult {
    const base = resolveProfile(this.s.profile);
    const r = applyPatch(SCHEMA, base, patch);
    if (!r.ok) return { ok: false, issues: r.issues };
    return { ok: true, state: this.commit(kind, this.s.seedText, this.s.seed, this.s.profile, base, r.value) };
  }

  /** Writes a validated draft; outside a gesture records it (or replaces the cursor's step), then notifies. Unchanged drafts do nothing. */
  private commit(kind: ChangeKind, seedText: string, seed: Seed64, profile: ProfileId, base: Params, params: Params, record = true): SessionState {
    if (!this.write(seedText, seed, profile, base, params)) return this.s;
    if (!this.gesture) {
      if (record) this.recordStep();
      else this.history[this.cursor] = this.entry();
    }
    this.emit(kind);
    return this.s;
  }

  /** Stores the minimal frozen patch; false (and the state object kept) when the draft is unchanged. */
  private write(seedText: string, seed: Seed64, profile: ProfileId, base: Params, params: Params): boolean {
    const patch = deepFreeze(diffParams(SCHEMA, base, params));
    const draftKey = draftKeyOf({ seedText, profile, patch });
    if (draftKey === this.draftKey) return false;
    const epochKey = epochKeyOf(seed, params);
    this.s = Object.freeze({ seedText, seed, profile, patch, params, epoch: epochKey === this.epochKey ? this.s.epoch : this.s.epoch + 1 });
    this.epochKey = epochKey;
    this.draftKey = draftKey;
    return true;
  }

  private entry(): HistoryEntry {
    return { snap: this.snapshot, key: this.draftKey };
  }

  /** A step when the draft differs from the cursor's snapshot: drops the redo tail, keeps HISTORY_STEPS steps. */
  private recordStep(): void {
    if (this.draftKey === this.history[this.cursor]!.key) return;
    this.history.length = this.cursor + 1;
    this.history.push(this.entry());
    if (this.history.length > HISTORY_STEPS + 1) this.history.shift();
    this.cursor = this.history.length - 1;
  }

  /** Applies the snapshot at the cursor as load(snapshot, {record: false}) does; always notifies (the cursor moved). */
  private restore(kind: 'undo' | 'redo'): void {
    const { snap } = this.history[this.cursor]!;
    const base = resolveProfile(snap.profile);
    const r = applyPatch(SCHEMA, base, snap.patch);
    if (!r.ok) throw new Error(`history snapshot no longer loads: ${r.issues[0]!.path} ${r.issues[0]!.code}`);
    const seed = resolveSeedText(snap.seedText, this.random);
    this.write(seed.text, seed.seed, snap.profile, base, r.value);
    this.emit(kind);
  }

  /** Inside a gesture every change is non-urgent; gestureEnd and everything outside a gesture are urgent. */
  private emit(kind: ChangeKind): void {
    const change: SessionChange = { kind, urgent: !this.gesture, gesture: this.gesture };
    for (const l of [...this.listeners]) l(this.s, change);
  }
}

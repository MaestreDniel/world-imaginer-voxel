/**
 * The Density tab's JSON editor model (SP3d spec §3.5, §1.8 "in the editors", D18): one per tree leaf, pure, with an
 * injected clock and session. It holds the buffer and decides when it is clean (equal to the print of the session's
 * current tree), validates as you type after a 150 ms debounce without applying (parse, then tier 1 `checkJson` and
 * tier 2 `validateParamTrees`, the functions the session runs), lists the issues as `<node path>: CODE — message` (at
 * most 50 lines and an "N more" line), refuses a buffer over 512 KiB ("too large to validate"), and implements Apply
 * (one `session.set(<leaf>, tree)`; an invalid tree is never sent), Reset (`session.reset(<leaf>)`) and Escape (revert
 * the buffer). The dirty-buffer rule: when the leaf's value changes from elsewhere (undo, a form edit, a preset load) a
 * clean buffer is re-printed and a dirty one is kept with `stale` set ("Revert to the current tree"); other leaves
 * never touch it. Every re-print restores the caret and the scroll anchor on the same node path. `jsonEditor.ts`
 * binds it to the DOM.
 */
import { checkJson, type JsonFormat, type JsonValue } from '../../core/params/json';
import type { Issue } from '../../core/params/kit';
import type { Params } from '../../core/params/schema';
import type { SessionResult } from '../../engine/session';
import { validateParamTrees } from '../../gen/trees';
import { nodeAt, parseTree, printTree, type SyntaxIssue, type TreeRanges } from './jsonText';

/** The two tree leaves (§1.2). */
export type TreeLeaf = 'density.defs' | 'surface.rules';
export const TREE_LEAVES: readonly TreeLeaf[] = Object.freeze(['density.defs', 'surface.rules']);

/** A buffer longer than this (UTF-16 units, 512 KiB) is not parsed (§3.5). */
export const EDITOR_TEXT_MAX = 512 * 1024;
/** Issue lines shown before one "N more" line (§3.5). */
export const EDITOR_ISSUE_LINES = 50;
/** Validation runs this long after the last keystroke (§3.5). */
export const EDITOR_DEBOUNCE_MS = 150;

export const TOO_LARGE_TEXT = 'too large to validate';

export function formatOfLeaf(leaf: TreeLeaf): JsonFormat {
  return leaf === 'density.defs' ? 'density' : 'surfaceRules';
}

/** The leaf's value in a params document. */
export function leafValue(params: Params, leaf: TreeLeaf): JsonValue {
  return leaf === 'density.defs' ? params.density.defs : params.surface.rules;
}

/** `params` with the leaf's value replaced by `value` (the other leaf and groups shared). */
function withLeaf(params: Params, leaf: TreeLeaf, value: JsonValue): Params {
  if (leaf === 'density.defs') return { ...params, density: { ...params.density, defs: value } };
  return { ...params, surface: { ...params.surface, rules: value } };
}

export interface EditorClock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** The part of `WorldSession` the editor uses. */
export interface EditorSession {
  readonly state: { readonly params: Params };
  set(path: string, value: unknown): SessionResult;
  reset(path: string): SessionResult;
}

/**
 * `clean`: the buffer is the print of the session's tree; `pending`: typed, validation not run yet; `valid` / `invalid`:
 * validated (issues listed); `syntax`: does not parse; `tooLarge`: over EDITOR_TEXT_MAX, not parsed.
 */
export type EditorStatus = 'clean' | 'pending' | 'valid' | 'invalid' | 'syntax' | 'tooLarge';

/** An issue at a node path inside the leaf ('' is the value itself); `code` is a tier-1, tier-2 or session code. */
export interface EditorIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface EditorState {
  readonly leaf: TreeLeaf;
  readonly text: string;
  readonly clean: boolean;
  readonly status: EditorStatus;
  /** At most EDITOR_ISSUE_LINES, never a TOO_MANY_ISSUES entry (counted in `more`). */
  readonly issues: readonly EditorIssue[];
  /** Issues not listed (the validators' "N more" included). */
  readonly more: number;
  readonly syntax: SyntaxIssue | null;
  /** The ranges of `text` when it is clean or parses, else null (highlighting and caret → node, §3.2). */
  readonly ranges: TreeRanges | null;
  /** The leaf changed elsewhere while the buffer was dirty: offer "Revert to the current tree" (§3.5). */
  readonly stale: boolean;
  /** Caret and scroll anchor offsets in `text` (the DOM reports them; a re-print maps them by node path). */
  readonly caret: number;
  readonly scrollAnchor: number;
  /** Bumps whenever the model replaces the text itself (a re-print), so the DOM rewrites the textarea. */
  readonly revision: number;
}

export interface EditorModel {
  readonly state: EditorState;
  subscribe(listener: (s: EditorState) => void): () => void;
  /** Typed text (an `input` event) with the caret after it. */
  edit(text: string, caret: number): void;
  /** The caret moved or the text scrolled (`scrollAnchor`: the offset of the first visible line). */
  setCaret(caret: number, scrollAnchor?: number): void;
  /** Validates now if a validation is pending, then sends a valid dirty tree; false when nothing was applied. */
  apply(): boolean;
  /** The profile's tree (`session.reset`); false when the session refused. */
  reset(): boolean;
  /** Escape / "Revert to the current tree": the buffer becomes the session's tree, clean. */
  revert(): void;
  /** Call on every session notification: reacts only when this leaf's value changed (the dirty-buffer rule). */
  sessionChanged(): void;
  dispose(): void;
}

/** An issue path inside the leaf: the `<leaf>.` prefix removed, '' for the leaf itself; other paths unchanged. */
export function stripLeaf(path: string, leaf: TreeLeaf): string {
  if (path === leaf) return '';
  if (path.startsWith(`${leaf}.`)) return path.slice(leaf.length + 1);
  if (path.startsWith(`${leaf}[`)) return path.slice(leaf.length);
  return path;
}

/** `<node path>: CODE — message`; an issue at the value itself is shown at the leaf path. */
export function issueText(i: EditorIssue, leaf: TreeLeaf): string {
  return `${i.path === '' ? leaf : i.path}: ${i.code} — ${i.message}`;
}

/** The lines the editor lists: a syntax error or the size refusal alone, else the issues and "N more". */
export function issueLines(s: EditorState): string[] {
  if (s.status === 'tooLarge') return [TOO_LARGE_TEXT];
  if (s.syntax !== null) return [`line ${s.syntax.line}, column ${s.syntax.column}: ${s.syntax.message}`];
  const lines = s.issues.map((i) => issueText(i, s.leaf));
  if (s.more > 0) lines.push(`${s.more} more`);
  return lines;
}

/** A candidate value for a tree leaf after both tiers: the registered tier-1 clone, or null and the issues. */
export interface CheckedCandidate {
  readonly value: JsonValue | null;
  /** Node paths inside the leaf ('' = the value); tier 1's when it fails, else tier 2's for this leaf. */
  readonly issues: readonly EditorIssue[];
}

/**
 * Validates `value` as the leaf's new value the way the session will (§1.8 "in the editors"): tier 1 (`checkJson`),
 * then tier 2 (`validateParamTrees` on `params` with the leaf replaced, keeping only this leaf's issues). The editor's
 * validate-as-you-type and the node form's commit (`form.ts`) both call it.
 */
export function checkLeafCandidate(params: Params, leaf: TreeLeaf, value: unknown): CheckedCandidate {
  const tier1: Issue[] = [];
  const clone = checkJson(value, '', tier1, formatOfLeaf(leaf));
  if (clone === undefined) return { value: null, issues: tier1 };
  const tier2 = validateParamTrees(withLeaf(params, leaf, clone))
    .filter((i) => i.path === leaf || i.path.startsWith(`${leaf}.`) || i.path.startsWith(`${leaf}[`))
    .map((i) => ({ path: stripLeaf(i.path, leaf), code: i.code, message: i.message }));
  return tier2.length > 0 ? { value: null, issues: tier2 } : { value: clone, issues: [] };
}

/** Caps a validator's list at EDITOR_ISSUE_LINES; a TOO_MANY_ISSUES entry ("<n> more") adds its n to `more`. */
function capIssues(all: readonly EditorIssue[]): { issues: EditorIssue[]; more: number } {
  const issues: EditorIssue[] = [];
  let more = 0;
  for (const i of all) {
    if (i.code === 'TOO_MANY_ISSUES') {
      const m = /^(\d+) more$/.exec(i.message);
      more += m === null ? 1 : Number(m[1]);
    } else if (issues.length < EDITOR_ISSUE_LINES) issues.push(i);
    else more++;
  }
  return { issues, more };
}

/**
 * Maps `offset` from a text with `from` ranges to the same place in a text with `to` ranges: the innermost node holding
 * it, else its longest ancestor path that still names a node in `to` (the new text's root when none), the offset kept
 * at the same distance from that node's start (clamped to the node). Without `from` (a buffer that did not parse) the
 * offset is clamped to `length`.
 */
export function mapOffset(from: TreeRanges | null, offset: number, to: TreeRanges, length: number): number {
  const clamp = (v: number): number => (v < 0 ? 0 : v > length ? length : v);
  if (from === null) return clamp(offset);
  const path = nodeAt(from, offset);
  if (path === null) return clamp(offset);
  const toNodes = new Set(to.nodes);
  let p: string | null = path;
  while (p !== null && !toNodes.has(p)) {
    const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['));
    p = cut > 0 ? p.slice(0, cut) : null;
  }
  const target = p === null ? to.nodes[0] : p;
  if (target === undefined) return clamp(offset);
  const r = to.byPath.get(target)!;
  const delta = p === path ? offset - from.byPath.get(path)!.start : 0;
  return Math.min(r.start + Math.max(0, delta), r.end);
}

type Mutable = { -readonly [K in keyof EditorState]: EditorState[K] };

/** The editor model of `leaf` over `session`, starting clean on the session's tree. */
export function createEditorModel(leaf: TreeLeaf, session: EditorSession, clock: EditorClock): EditorModel {
  const format = formatOfLeaf(leaf);
  const listeners = new Set<(s: EditorState) => void>();
  let shown: JsonValue = leafValue(session.state.params, leaf);
  let printed = printTree(shown, format);
  /** The tier-1 clone of a `valid` buffer: what Apply sends. */
  let candidate: JsonValue | null = null;
  let timer: number | null = null;
  /** Set while Apply or Reset runs, so their own session notification is not "from elsewhere". */
  let busy = false;
  const s: Mutable = {
    leaf, text: printed.text, clean: true, status: 'clean', issues: [], more: 0, syntax: null, ranges: printed.ranges,
    stale: false, caret: 0, scrollAnchor: 0, revision: 0,
  };
  let snapshot: EditorState = Object.freeze({ ...s });
  const emit = (): void => {
    snapshot = Object.freeze({ ...s });
    for (const l of listeners) l(snapshot);
  };
  const cancel = (): void => {
    if (timer !== null) { clock.clearTimeout(timer); timer = null; }
  };
  const showIssues = (all: readonly EditorIssue[], status: EditorStatus): void => {
    const { issues, more } = capIssues(all);
    s.issues = issues;
    s.more = more;
    s.syntax = null;
    s.status = status;
  };
  /** The buffer equals the print of the session's tree. */
  const markClean = (): void => {
    cancel();
    candidate = null;
    s.clean = true;
    s.stale = false;
    s.status = 'clean';
    s.issues = [];
    s.more = 0;
    s.syntax = null;
    s.ranges = printed.ranges;
  };
  /** Replaces the buffer by the print of the session's current tree, caret and scroll kept on their node paths. */
  const reprint = (): void => {
    const old = s.ranges;
    shown = leafValue(session.state.params, leaf);
    printed = printTree(shown, format);
    s.caret = mapOffset(old, s.caret, printed.ranges, printed.text.length);
    s.scrollAnchor = mapOffset(old, s.scrollAnchor, printed.ranges, printed.text.length);
    s.text = printed.text;
    s.revision++;
    markClean();
  };
  const validate = (): void => {
    cancel();
    candidate = null;
    s.ranges = null;
    if (s.text.length > EDITOR_TEXT_MAX) {
      s.status = 'tooLarge';
      s.issues = [];
      s.more = 0;
      s.syntax = null;
      return;
    }
    const parsed = parseTree(s.text, format);
    if (!parsed.ok) {
      s.status = 'syntax';
      s.issues = [];
      s.more = 0;
      s.syntax = parsed.error;
      return;
    }
    s.ranges = parsed.ranges;
    const checked = checkLeafCandidate(session.state.params, leaf, parsed.value);
    if (checked.value === null) { showIssues(checked.issues, 'invalid'); return; }
    candidate = checked.value;
    showIssues([], 'valid');
  };
  const refused = (r: SessionResult): boolean => {
    if (r.ok) return false;
    showIssues(r.issues.map((i) => ({ path: stripLeaf(i.path, leaf), code: i.code, message: i.message })), 'invalid');
    return true;
  };

  return {
    get state() { return snapshot; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    edit(text, caret) {
      s.text = text;
      s.caret = caret;
      if (text === printed.text) {
        markClean();
      } else {
        s.clean = false;
        s.status = 'pending';
        s.ranges = null;
        candidate = null;
        cancel();
        timer = clock.setTimeout(() => { timer = null; validate(); emit(); }, EDITOR_DEBOUNCE_MS);
      }
      emit();
    },
    setCaret(caret, scrollAnchor) {
      s.caret = caret;
      if (scrollAnchor !== undefined) s.scrollAnchor = scrollAnchor;
      emit();
    },
    apply() {
      if (s.clean) return false;
      if (s.status === 'pending') validate();
      if (candidate === null) { emit(); return false; }
      busy = true;
      let r: SessionResult;
      try { r = session.set(leaf, candidate); } finally { busy = false; }
      if (refused(r)) { emit(); return false; }
      reprint();
      emit();
      return true;
    },
    reset() {
      busy = true;
      let r: SessionResult;
      try { r = session.reset(leaf); } finally { busy = false; }
      if (refused(r)) { emit(); return false; }
      reprint();
      emit();
      return true;
    },
    revert() {
      reprint();
      emit();
    },
    sessionChanged() {
      if (busy) return;
      const v = leafValue(session.state.params, leaf);
      if (v === shown) return;
      if (s.clean) { reprint(); emit(); return; }
      shown = v;
      printed = printTree(shown, format);
      if (s.text === printed.text) markClean();
      else s.stale = true;
      emit();
    },
    dispose() {
      cancel();
      listeners.clear();
    },
  };
}

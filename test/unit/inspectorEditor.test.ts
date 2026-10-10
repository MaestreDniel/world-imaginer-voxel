/**
 * The Density tab's JSON editor model (SP3d spec §3.5, §6 `inspectorEditor.test.ts`): validate-as-you-type issues with
 * their node paths after the 150 ms debounce (injected clock), the 50-issue cap, the 512 KiB buffer cap, Apply / Reset /
 * Escape (a successful Apply or Reset leaves a clean buffer with the caret on the same node path), and the dirty-buffer
 * rule for changes from elsewhere. Runs on a real `WorldSession` with `validateParamTrees`, as the page wires it.
 */
import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import type { SessionResult } from '../../src/engine/session';
import { WorldSession } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import {
  createEditorModel, EDITOR_DEBOUNCE_MS, EDITOR_ISSUE_LINES, EDITOR_TEXT_MAX, issueLines, mapOffset, stripLeaf, TREE_LEAVES,
  type EditorClock, type EditorSession, type TreeLeaf,
} from '../../src/ui/inspector/editorModel';
import { nodeAt, printTree } from '../../src/ui/inspector/jsonText';

/** A clock whose timers run only when the test advances it. */
function fakeClock(): EditorClock & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

const random = (): Seed64 => [5, 11];
const session = (): WorldSession => new WorldSession(random, { validateParams: validateParamTrees });

/** A model on `w` whose `sessionChanged` is called on every notification, as the page binds it. */
function open(w: WorldSession, leaf: TreeLeaf = 'density.defs') {
  const clock = fakeClock();
  const model = createEditorModel(leaf, w, clock);
  w.subscribe(() => model.sessionChanged());
  return { model, clock };
}

const DENSITY_TEXT = printTree(DEFAULT_DENSITY_TREE, 'density').text;
const RULES_TEXT = printTree(DEFAULT_SURFACE_RULES, 'surfaceRules').text;
const ISLANDS = '{ "op": "const", "v": -1000000 }';

describe('the buffer and validation as you type', () => {
  test('opens clean on the session tree, for both leaves', () => {
    const w = session();
    const d = open(w).model.state;
    expect([d.text, d.clean, d.status, d.issues, d.stale, d.revision]).toEqual([DENSITY_TEXT, true, 'clean', [], false, 0]);
    expect(d.ranges).toEqual(printTree(DEFAULT_DENSITY_TREE, 'density').ranges);
    const r = open(w, 'surface.rules').model.state;
    expect([r.text, r.clean, r.status]).toEqual([RULES_TEXT, true, 'clean']);
    expect(TREE_LEAVES).toEqual(['density.defs', 'surface.rules']);
  });

  test('a typed tree is validated 150 ms after the last keystroke, with tier-2 issues at node paths', () => {
    const w = session();
    const { model, clock } = open(w);
    const seen: string[] = [];
    model.subscribe((s) => seen.push(s.status));
    const broken = DENSITY_TEXT.replace(ISLANDS, '{ "op": "bogus" }');
    model.edit(broken.slice(0, -1), 0);
    clock.advance(EDITOR_DEBOUNCE_MS - 1);
    model.edit(broken, 0);
    expect(model.state.status).toBe('pending');
    expect(model.state.clean).toBe(false);
    expect(model.state.ranges).toBeNull();
    clock.advance(EDITOR_DEBOUNCE_MS - 1);
    expect(model.state.status).toBe('pending');
    clock.advance(1);
    expect(model.state.status).toBe('invalid');
    expect(model.state.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['root.b.x UNKNOWN_OP']);
    expect(issueLines(model.state)[0]).toMatch(/^root\.b\.x: UNKNOWN_OP — /);
    expect(model.state.ranges).not.toBeNull();
    expect(seen).toEqual(['pending', 'pending', 'invalid']);
    // Nothing was applied.
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
    expect(w.canUndo).toBe(false);
  });

  test('tier-1 issues (−0, a "__proto__" def, Infinity) at node paths; syntax errors with line and column', () => {
    const { model, clock } = open(session());
    model.edit(DENSITY_TEXT.replace('"defs": {}', '"defs": { "__proto__": { "op": "y" } }').replace(ISLANDS, '{ "op": "const", "v": -0 }'), 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['defs."__proto__" BAD_KEY', 'root.b.x.v NEGATIVE_ZERO']);
    model.edit(DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": 1e999 }'), 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.issues.map((i) => `${i.path} ${i.code}`)).toEqual(['root.b.x.v NOT_FINITE']);
    model.edit('{\n  "root": { "op": "y" }\n  "defs": {}\n}', 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.status).toBe('syntax');
    expect(model.state.ranges).toBeNull();
    expect(issueLines(model.state)).toEqual(["line 3, column 3: expected ',' or '}', got '\"'"]);
    // A value-level issue shows the leaf path.
    model.edit('[]', 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(issueLines(model.state)[0]).toMatch(/^density\.defs: NOT_OBJECT — /);
  });

  test('rule trees: NOT_SOLID at the block state; a valid edit is valid', () => {
    const { model, clock } = open(session(), 'surface.rules');
    const at = RULES_TEXT.indexOf('"state": "stone"');
    model.edit(`${RULES_TEXT.slice(0, at)}"state": "air"${RULES_TEXT.slice(at + '"state": "stone"'.length)}`, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.issues).toHaveLength(1);
    expect(model.state.issues[0]!.code).toBe('NOT_SOLID');
    expect(model.state.issues[0]!.path).toMatch(/^root\.rules\[\d+\](\.then|\.rules\[\d+\])*\.state$/);
    model.edit(RULES_TEXT.replace('"trueAtAndBelow": 0, "falseAtAndAbove": 8', '"trueAtAndBelow": 0, "falseAtAndAbove": 12'), 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect([model.state.status, model.state.issues]).toEqual(['valid', []]);
  });

  test('at most 50 issue lines and one "N more" line, the validators\' own "N more" included', () => {
    const { model, clock } = open(session());
    model.edit(`{ "root": { "op": "y" }, "defs": {}, "pad": [${Array(60).fill('1e999').join(', ')}] }`, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.issues).toHaveLength(EDITOR_ISSUE_LINES);
    expect(model.state.more).toBe(10);
    const lines = issueLines(model.state);
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe('pad[0]: NOT_FINITE — expected a finite number, got Infinity');
    expect(lines[50]).toBe('10 more');
    // Tier 2: 60 unknown ops in one tree (its validator caps at 50 + TOO_MANY_ISSUES).
    const ops = Array.from({ length: 30 }, () => '{ "op": "add", "a": { "op": "bogus" }, "b": { "op": "bogus" } }');
    let root = ops[0]!;
    for (let k = 1; k < ops.length; k++) root = `{ "op": "max", "a": ${root}, "b": ${ops[k]} }`;
    model.edit(`{ "root": ${root}, "defs": {} }`, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.issues).toHaveLength(EDITOR_ISSUE_LINES);
    expect(model.state.issues.every((i) => i.code === 'UNKNOWN_OP')).toBe(true);
    expect(issueLines(model.state).at(-1)).toBe('10 more');
  });

  test('a buffer over 512 KiB is not parsed ("too large to validate") and cannot be applied; 512 KiB is', () => {
    const w = session();
    const { model, clock } = open(w);
    const valid = DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -10 }');
    const padded = valid + ' '.repeat(EDITOR_TEXT_MAX - valid.length);
    expect(padded).toHaveLength(512 * 1024);
    model.edit(padded, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.status).toBe('valid');
    model.edit(`${padded} `, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.status).toBe('tooLarge');
    expect(issueLines(model.state)).toEqual(['too large to validate']);
    expect(model.apply()).toBe(false);
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
  });

  test('typing the printed text back makes the buffer clean again and cancels the pending validation', () => {
    const { model, clock } = open(session());
    model.edit(`${DENSITY_TEXT} `, 3);
    expect(clock.pending()).toBe(1);
    model.edit(DENSITY_TEXT, 3);
    expect([model.state.clean, model.state.status, clock.pending()]).toEqual([true, 'clean', 0]);
    expect(model.state.ranges).toEqual(printTree(DEFAULT_DENSITY_TREE, 'density').ranges);
  });
});

describe('Apply, Reset and Escape', () => {
  test('Apply sends the tree as one session step and re-prints it clean, the caret on the same node path', () => {
    const w = session();
    const { model, clock } = open(w);
    const typed = DENSITY_TEXT.replace(ISLANDS, '{"v":-10,"op":"const"}');
    const caret = typed.indexOf('"v":-10') + 4;
    model.edit(typed, caret);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.status).toBe('valid');
    expect(nodeAt(model.state.ranges!, caret)).toBe('root.b.x');
    expect(model.apply()).toBe(true);
    const tree = w.state.params.density.defs as { root: { b: { x: { v: number } } } };
    expect(tree.root.b.x.v).toBe(-10);
    expect(w.modified('density.defs')).toBe(true);
    expect(w.canUndo).toBe(true);
    const s = model.state;
    expect(s.text).toBe(printTree(tree, 'density').text);
    expect(s.text).toContain('"x": { "op": "const", "v": -10 }');
    expect([s.clean, s.status, s.stale, s.issues, s.revision]).toEqual([true, 'clean', false, [], 1]);
    expect(nodeAt(s.ranges!, s.caret)).toBe('root.b.x');
    // Applying a clean buffer does nothing.
    expect(model.apply()).toBe(false);
  });

  test('Apply while the validation is pending validates first; an invalid tree is never sent', () => {
    const w = session();
    const { model, clock } = open(w);
    model.edit(DENSITY_TEXT.replace(ISLANDS, '{ "op": "bogus" }'), 0);
    expect(model.apply()).toBe(false);
    expect(model.state.status).toBe('invalid');
    expect(clock.pending()).toBe(0);
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
    model.edit(DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -10 }'), 0);
    expect(model.apply()).toBe(true);
    expect(model.state.clean).toBe(true);
  });

  test("a session refusal keeps the buffer dirty and lists the session's issues without the leaf prefix", () => {
    const w = session();
    const refusing: EditorSession = {
      get state() { return w.state; },
      set: (): SessionResult => ({ ok: false, issues: [{ path: 'density.defs.root.b', code: 'OUT_OF_RANGE', message: 'refused' }, { path: 'density.defs', code: 'NOT_JSON', message: 'top' }] }),
      reset: (p) => w.reset(p),
    };
    const clock = fakeClock();
    const model = createEditorModel('density.defs', refusing, clock);
    const typed = DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -10 }');
    model.edit(typed, 0);
    expect(model.apply()).toBe(false);
    expect([model.state.text, model.state.clean, model.state.status]).toEqual([typed, false, 'invalid']);
    expect(issueLines(model.state)).toEqual(['root.b: OUT_OF_RANGE — refused', 'density.defs: NOT_JSON — top']);
    expect(stripLeaf('surface.rules.root.rules[1]', 'surface.rules')).toBe('root.rules[1]');
    expect(stripLeaf('density.defs[0]', 'density.defs')).toBe('[0]');
    expect(stripLeaf('climate.scaleMul', 'density.defs')).toBe('climate.scaleMul');
  });

  test("Reset restores the profile's tree, clean, the caret on the same node path", () => {
    const w = session();
    const { model, clock } = open(w);
    model.edit(DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -10 }'), 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    model.apply();
    const at = model.state.text.indexOf('"name": "terrain"');
    model.setCaret(at, at);
    expect(nodeAt(model.state.ranges!, at)).toBe('root.a.a');
    expect(model.reset()).toBe(true);
    expect(w.state.params.density.defs).toBe(DEFAULT_DENSITY_TREE);
    expect(w.modified('density.defs')).toBe(false);
    const s = model.state;
    expect([s.text, s.clean, s.stale]).toEqual([DENSITY_TEXT, true, false]);
    expect(s.caret).toBe(DENSITY_TEXT.indexOf('"name": "terrain"'));
    expect(nodeAt(s.ranges!, s.scrollAnchor)).toBe('root.a.a');
  });

  test('Escape reverts a dirty buffer, broken or not, to the current tree', () => {
    const w = session();
    const { model, clock } = open(w);
    model.edit('{ "root": ', 4);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.state.status).toBe('syntax');
    model.revert();
    expect([model.state.text, model.state.clean, model.state.status, issueLines(model.state)]).toEqual([DENSITY_TEXT, true, 'clean', []]);
    expect(model.state.caret).toBe(4);
    expect(w.canUndo).toBe(false);
  });
});

describe('the dirty-buffer rule', () => {
  test('a clean buffer follows changes of its leaf from elsewhere (a form edit, undo), the caret kept by node path', () => {
    const w = session();
    const { model } = open(w);
    const at = DENSITY_TEXT.indexOf('"name": "islands"');
    model.setCaret(at);
    const edited = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { b: { x: { v: number } } } };
    edited.root.b.x.v = -10;
    expect(w.set('density.defs', edited).ok).toBe(true);
    let s = model.state;
    expect(s.text).toContain('"x": { "op": "const", "v": -10 }');
    expect([s.clean, s.stale, s.revision]).toEqual([true, false, 1]);
    expect(nodeAt(s.ranges!, s.caret)).toBe('root.b');
    w.undo();
    s = model.state;
    expect([s.text, s.clean, s.revision]).toEqual([DENSITY_TEXT, true, 2]);
  });

  test('a dirty buffer is kept when its leaf changes elsewhere, with "stale"; Escape then shows the current tree', () => {
    const w = session();
    const { model, clock } = open(w);
    const typed = DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -5 }');
    model.edit(typed, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    const edited = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { b: { x: { v: number } } } };
    edited.root.b.x.v = -10;
    w.set('density.defs', edited);
    expect([model.state.text, model.state.clean, model.state.stale, model.state.revision]).toEqual([typed, false, true, 0]);
    model.revert();
    expect(model.state.text).toContain('"v": -10 }');
    expect([model.state.clean, model.state.stale]).toEqual([true, false]);
  });

  test('typing the current tree back clears "stale"; Apply of a stale buffer replaces the tree', () => {
    const w = session();
    const { model, clock } = open(w);
    model.edit(`${DENSITY_TEXT}\n`, 0);
    const edited = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { b: { x: { v: number } } } };
    edited.root.b.x.v = -10;
    w.set('density.defs', edited);
    expect(model.state.stale).toBe(true);
    const current = printTree(w.state.params.density.defs, 'density').text;
    model.edit(current, 0);
    expect([model.state.clean, model.state.stale]).toEqual([true, false]);
    model.edit(DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -7 }'), 0);
    w.undo();
    expect(model.state.stale).toBe(true);
    clock.advance(EDITOR_DEBOUNCE_MS);
    expect(model.apply()).toBe(true);
    expect((w.state.params.density.defs as { root: { b: { x: { v: number } } } }).root.b.x.v).toBe(-7);
    expect([model.state.clean, model.state.stale]).toEqual([true, false]);
  });

  test('changes of other leaves never touch the buffer, clean or dirty', () => {
    const w = session();
    const { model, clock } = open(w);
    const rules = open(w, 'surface.rules').model;
    w.set('density.detailAmpLo', 0.8);
    w.set('climate.scaleMul', 2);
    expect([model.state.text, model.state.revision, rules.state.revision]).toEqual([DENSITY_TEXT, 0, 0]);
    model.edit(`${DENSITY_TEXT} `, 0);
    clock.advance(EDITOR_DEBOUNCE_MS);
    const before = model.state;
    w.set('surface.snowline', -0.5);
    w.undo();
    expect(model.state).toBe(before);
    // The density editor's Apply does not re-print the rules editor.
    model.revert();
    model.edit(DENSITY_TEXT.replace(ISLANDS, '{ "op": "const", "v": -10 }'), 0);
    model.apply();
    expect(rules.state.revision).toBe(0);
  });
});

describe('mapOffset', () => {
  test('keeps an offset inside the same node, falls back to the longest surviving ancestor, clamps without ranges', () => {
    const a = printTree({ root: { op: 'add', a: { op: 'y' }, b: { op: 'neg', x: { op: 'y' } } }, defs: {} }, 'density');
    const b = printTree({ root: { op: 'add', a: { op: 'const', v: 12345 }, b: { op: 'y' } }, defs: {} }, 'density');
    const inA = a.ranges.byPath.get('root.a')!.start + 3;
    expect(mapOffset(a.ranges, inA, b.ranges, b.text.length)).toBe(b.ranges.byPath.get('root.a')!.start + 3);
    const inNegX = a.ranges.byPath.get('root.b.x')!.start + 2;
    expect(mapOffset(a.ranges, inNegX, b.ranges, b.text.length)).toBe(b.ranges.byPath.get('root.b')!.start);
    expect(mapOffset(null, 10_000, b.ranges, b.text.length)).toBe(b.text.length);
    expect(mapOffset(a.ranges, 0, b.ranges, b.text.length)).toBe(0);
  });
});

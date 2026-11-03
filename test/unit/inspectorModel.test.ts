/**
 * The Density tab's tree model (SP3d spec §3.2, §6 `inspectorModel.test.ts`): rows and summaries of both default trees,
 * the three-level initial expansion and "expand to selection", the 8 px × 12-level indentation cap, the key strings the
 * DOM re-renders on, the selection following the longest prefix that still names a node after undo and renumbering,
 * and the caret → node mapping (only on a clean or parsing buffer, only for paths of the session's tree).
 */
import { describe, expect, test } from 'vitest';
import type { Seed64 } from '../../src/core/hash';
import { DEFAULT_DENSITY_TREE, DEFAULT_SURFACE_RULES } from '../../src/core/params/defaultTrees';
import { countTreeNodes, type JsonValue } from '../../src/core/params/json';
import { DEFAULTS } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { WorldSession } from '../../src/engine/session';
import { validateParamTrees } from '../../src/gen/trees';
import { createEditorModel, type EditorClock } from '../../src/ui/inspector/editorModel';
import { printTree } from '../../src/ui/inspector/jsonText';
import {
  caretTarget, DEFAULT_SELECTION, expandToSelection, findNode, followNode, highlightRange, indentOf, INDENT_LEVELS,
  INDENT_PX, inspectorTree, isExpanded, NO_EXPANSION, nodePaths, toggleExpansion, type Expansion, type InspectorTree,
  type Selection, type TreeRow,
} from '../../src/ui/inspector/model';

const random = (): Seed64 => [5, 11];
const session = (): WorldSession => new WorldSession(random, { validateParams: validateParamTrees });

/** A clock whose timers run only when the test advances it. */
function fakeClock(): EditorClock & { advance(ms: number): void } {
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
  };
}

const withDensity = (tree: unknown, base: Params = DEFAULTS): Params =>
  ({ ...base, density: { ...base.density, defs: tree as JsonValue } });
const withRules = (tree: unknown, base: Params = DEFAULTS): Params =>
  ({ ...base, surface: { ...base.surface, rules: tree as JsonValue } });

/** Every node expanded. */
function expandAll(params: Params): Expansion {
  let e: Expansion = NO_EXPANSION;
  for (const p of nodePaths(params.density.defs, 'density')) e = new Map([...e, [`density.defs|${p}`, true]]);
  for (const p of nodePaths(params.surface.rules, 'surfaceRules')) e = new Map([...e, [`surface.rules|${p}`, true]]);
  return e;
}

const rowsOf = (t: InspectorTree, leaf: 'density.defs' | 'surface.rules'): readonly TreeRow[] =>
  t.groups.find((g) => g.leaf === leaf)!.rows;
const brief = (r: TreeRow): string =>
  `${r.depth} ${r.path} | ${r.tail} | ${r.summary}${r.expandable ? (r.expanded ? ' [-]' : ' [+]') : ''}`;

/** The default density's path down to the `clampSigma` param (13 levels from `defs.body`, SP6a §1.1; §3.2). */
const PARAM_PATH = 'defs.body.a.a.a.a.b.b.x.b.x.x.b.x';

describe('rows and summaries', () => {
  test('both default trees at the initial three-level expansion', () => {
    const t = inspectorTree(DEFAULTS, NO_EXPANSION, null);
    expect(t.groups.map((g) => [g.leaf, g.label])).toEqual([['density.defs', 'Density'], ['surface.rules', 'Surface rules']]);
    expect(rowsOf(t, 'density.defs').map(brief)).toEqual([
      // SP6a §1.1: max(min(min(tap precave(…), caves slot), noodle slot), tap islands), then the def body.
      '0 root | root | max [-]',
      '1 root.a | a | min [-]',
      '2 root.a.a | a | min [+]',
      '2 root.a.b | b | const 1000000',
      '1 root.b | b | tap islands [-]',
      '2 root.b.x | x | const -1000000',
      '0 defs.body | defs.body | add [-]',
      '1 defs.body.a | a | add [-]',
      '2 defs.body.a.a | a | add [+]',
      '2 defs.body.a.b | b | mul [+]',
      '1 defs.body.b | b | neg [-]',
      '2 defs.body.b.x | x | mul [+]',
      // SP6a's pillars def (the caves slot reads it twice).
      '0 defs.pillars | defs.pillars | tap pillars [-]',
      '1 defs.pillars.x | x | interpolated [-]',
      '2 defs.pillars.x.x | x | mul [+]',
    ]);
    expect(rowsOf(t, 'surface.rules').map(brief)).toEqual([
      '0 root | root | sequence 3 [-]',
      '1 root.rules[0] | rules[0] | if verticalGradient -64 … -59 → bedrock [-]',
      '2 root.rules[0].if | if | verticalGradient -64 … -59',
      '2 root.rules[0].then | then | block bedrock',
      '1 root.rules[1] | rules[1] | if skyOpen [-]',
      '2 root.rules[1].if | if | skyOpen',
      '2 root.rules[1].then | then | sequence 5 [+]',
      '1 root.rules[2] | rules[2] | if verticalGradient 0 … 8 → deepslate [-]',
      '2 root.rules[2].if | if | verticalGradient 0 … 8',
      '2 root.rules[2].then | then | block deepslate',
    ]);
    const root = rowsOf(t, 'density.defs')[0]!;
    expect([root.kind, root.title, root.leaf]).toEqual(['max', 'density.defs.root', 'density.defs']);
    expect(rowsOf(t, 'surface.rules')[1]!.title).toBe('surface.rules.root.rules[0]');
  });

  test('every node is a row when fully expanded, in pre-order, with the summaries of §3.2', () => {
    const t = inspectorTree(DEFAULTS, expandAll(DEFAULTS), null);
    const d = rowsOf(t, 'density.defs');
    const r = rowsOf(t, 'surface.rules');
    expect(d.length).toBe(countTreeNodes(DEFAULT_DENSITY_TREE, 'density'));
    expect(r.length).toBe(countTreeNodes(DEFAULT_SURFACE_RULES, 'surfaceRules'));
    expect(d.map((x) => x.path)).toEqual(nodePaths(DEFAULT_DENSITY_TREE, 'density'));
    const sum = new Map(d.map((x) => [x.path, x.summary]));
    expect(sum.get(PARAM_PATH)).toBe('param density.noises.jag.clampSigma = 3');
    expect(sum.get('defs.body.a.a.a.a.b.b.x.b.x.x.b')).toBe('recip');
    expect(sum.get('defs.body.a.a.a.a.b.b.x.b.x.x.a')).toBe('noise2 jag');
    expect(sum.get('defs.body.a.a.a.a.a')).toBe('col offset');
    expect(sum.get('defs.body.a.a.b.b')).toBe('slide 4 knots');
    expect(sum.get('defs.body.a.a.b.b.x')).toBe('noise overhang');
    expect(sum.get('defs.body.a.a.a.b')).toBe('neg');
    expect(sum.get('defs.body.a.a.a.b.x')).toBe('y');
    expect(sum.get('root.a.a.a.x.a.x')).toBe('interpolated');
    expect(sum.get('root.a.a.a.x.b.inside.b.a')).toBe('param density.detailAmpLo = 0.6');
    expect(sum.get('root.a.a.a.x.b.inside.b.b.b')).toBe('clamp 0 … 1');
    expect(sum.get('root.a.a.a.x.b.inside.b.b.b.x.b')).toBe('const 0.5');
    // SP6a's cave terms: detailG, a family tap, a cave param, keep's ref bound.
    expect(sum.get('root.a.a.a.x.b')).toBe('rangeChoice -1000000000 … 16');
    expect(sum.get('root.a.a.b.a.a')).toBe('tap entrances');
    expect(sum.get('root.a.a.b.a.a.x.x.a.b.a.a.b')).toBe('param caves.entrances.offset = 0.37');
    const rules = new Map(r.map((x) => [x.path, x.summary]));
    const sky = 'root.rules[1].then.rules';
    expect(rules.get(`${sky}[0]`)).toBe('if not');
    expect(rules.get(`${sky}[0].if.if`)).toBe('water 0');
    expect(rules.get(`${sky}[0].then`)).toBe('if stoneDepth floor 0+sd');
    expect(rules.get(`${sky}[0].then.then.rules[0]`)).toBe('if biome(warm_ocean, beach, …) → sand');
    expect(rules.get(`${sky}[0].then.then.rules[2].then.if`)).toBe('noiseThreshold patch surface.patchThreshold … 8');
    expect(rules.get(`${sky}[0].then.then.rules[5].then.if`)).toBe('water -2 runTop');
    expect(rules.get(`${sky}[0].then.then.rules[8]`)).toBe('block gravel');
    expect(rules.get(`${sky}[1].if`)).toBe('steep surface.cliffSteep');
    expect(rules.get(`${sky}[1].then.if`)).toBe('yAbove surface.cliffMinY runTop');
    expect(rules.get(`${sky}[2].then.if`)).toBe('temperatureBelow surface.snowline');
    expect(rules.get(`${sky}[3].then.rules[1]`)).toBe('if biome(badlands)');
    expect(rules.get(`${sky}[3].then.rules[1].then.rules[1]`)).toBe('bandlands');
    expect(rules.get(`${sky}[3].then.rules[6].then.rules[1].then.if`)).toBe('noiseThreshold patch -8 … −surface.patchThreshold');
    expect(rules.get(`${sky}[3].then.rules[7]`)).toBe('block dirt');
    expect(rules.get(`${sky}[4]`)).toBe('if stoneDepth floor 4+sd');
    // Conditions are rows of their rule: `.if` (and a `not`'s `.if.if`) before `.then`.
    const at = r.findIndex((x) => x.path === `${sky}[0]`);
    expect(r.slice(at, at + 4).map((x) => [x.path, x.depth])).toEqual([
      [`${sky}[0]`, 3], [`${sky}[0].if`, 4], [`${sky}[0].if.if`, 5], [`${sky}[0].then`, 4],
    ]);
  });

  test('defs after the root in key order; refs, mutes, dimmed subtrees and literal or ref fields', () => {
    const tree = {
      root: { op: 'add', a: { op: 'ref', name: 'base' }, b: { op: 'tap', name: 'terrain', mute: 0, x: { op: 'mul', a: { op: 'y' }, b: { op: 'ref', name: 'alpha' } } } },
      defs: {
        base: { op: 'clamp', x: { op: 'noise', id: 'detail' }, lo: { param: 'density.detailAmpLo', neg: true }, hi: 2.5 },
        alpha: { op: 'tap', name: 'k', mute: { param: 'density.detailAmpHi' }, x: { op: 'const', v: -0.25 } },
        constructor: { op: 'rangeChoice', x: { op: 'y' }, lo: 0, hi: 10, inside: { op: 'const', v: 1 }, outside: { op: 'const', v: 2 } },
      },
    };
    const p = withDensity(tree);
    const rows = rowsOf(inspectorTree(p, expandAll(p), null), 'density.defs');
    expect(rows.map((r) => `${r.depth} ${r.path} | ${r.tail} | ${r.summary}${r.muted ? ' M' : ''}${r.dimmed ? ' D' : ''}`)).toEqual([
      '0 root | root | add',
      '1 root.a | a | ref base',
      '1 root.b | b | tap terrain muted 0 M',
      '2 root.b.x | x | mul D',
      '3 root.b.x.a | a | y D',
      '3 root.b.x.b | b | ref alpha D',
      '0 defs.alpha | defs.alpha | tap k muted density.detailAmpHi M',
      '1 defs.alpha.x | x | const -0.25 D',
      '0 defs.base | defs.base | clamp −density.detailAmpLo … 2.5',
      '1 defs.base.x | x | noise detail',
      '0 defs.constructor | defs.constructor | rangeChoice 0 … 10',
      '1 defs.constructor.x | x | y',
      '1 defs.constructor.inside | inside | const 1',
      '1 defs.constructor.outside | outside | const 2',
    ]);
    // A tap is the row that carries the mute toggle.
    expect(rows.filter((r) => r.tap).map((r) => r.path)).toEqual(['root.b', 'defs.alpha']);
  });

  test('a noiseScaled row reads noiseScaled <id> /<s>, s a literal or a ref (SP6a §1.5)', () => {
    const tree = { root: { op: 'add', a: { op: 'noiseScaled', id: 'detail', s: 0.75 }, b: { op: 'noiseScaled', id: 'overhang', s: { param: 'density.noises.detail.clampSigma' } } }, defs: {} };
    const p = withDensity(tree);
    const rows = rowsOf(inspectorTree(p, expandAll(p), null), 'density.defs');
    expect(rows.map((r) => `${r.path} | ${r.summary}`)).toEqual([
      'root | add',
      'root.a | noiseScaled detail /0.75',
      'root.b | noiseScaled overhang /density.noises.detail.clampSigma',
    ]);
  });

  test('param rows read the session value, so a slider move changes their summary and the key', () => {
    const w = session();
    const sel: Selection = { leaf: 'density.defs', path: 'root.a.a.a.x.b.inside.b.a' };
    const exp = expandToSelection(w.state.params, NO_EXPANSION, sel);
    const before = inspectorTree(w.state.params, exp, sel);
    expect(rowsOf(before, 'density.defs').find((r) => r.path === sel.path)!.summary).toBe('param density.detailAmpLo = 0.6');
    expect(w.set('density.detailAmpLo', 1.25).ok).toBe(true);
    const after = inspectorTree(w.state.params, exp, sel);
    expect(rowsOf(after, 'density.defs').find((r) => r.path === sel.path)!.summary).toBe('param density.detailAmpLo = 1.25');
    expect(after.key).not.toBe(before.key);
  });
});

describe('expansion, expand to selection and the indentation cap', () => {
  test('the initial expansion opens levels 0 and 1 (three levels shown); a toggle overrides it', () => {
    expect([0, 1, 2, 3].map((d) => isExpanded(NO_EXPANSION, 'density.defs', 'root', d))).toEqual([true, true, false, false]);
    // Closing the root hides its subtree only: the defs body and pillars (their own top-level rows) stay as they were.
    const rootRows = (e: Expansion): string[] => rowsOf(inspectorTree(DEFAULTS, e, null), 'density.defs').map((r) => r.path).filter((p) => p.startsWith('root'));
    let e = toggleExpansion(NO_EXPANSION, 'density.defs', 'root', 0);
    expect(rootRows(e)).toEqual(['root']);
    expect(rowsOf(inspectorTree(DEFAULTS, e, null), 'density.defs').filter((r) => r.path.startsWith('defs.'))).toHaveLength(9);
    expect(rowsOf(inspectorTree(DEFAULTS, e, null), 'surface.rules')).toHaveLength(10);
    e = toggleExpansion(e, 'density.defs', 'root.a.a', 2);
    expect(rootRows(e)).toEqual(['root']);
    e = toggleExpansion(e, 'density.defs', 'root', 0);
    expect(rowsOf(inspectorTree(DEFAULTS, e, null), 'density.defs').map(brief).slice(0, 5)).toEqual([
      '0 root | root | max [-]',
      '1 root.a | a | min [-]',
      '2 root.a.a | a | min [-]',
      '3 root.a.a.a | a | tap precave [+]',
      '3 root.a.a.b | b | max [+]',
    ]);
    expect(NO_EXPANSION.size).toBe(0);
  });

  test('"Expand to selection" opens every ancestor of the selected node and nothing else', () => {
    const sel: Selection = { leaf: 'density.defs', path: PARAM_PATH };
    const e = expandToSelection(DEFAULTS, NO_EXPANSION, sel);
    const rows = rowsOf(inspectorTree(DEFAULTS, e, sel), 'density.defs');
    const param = rows.find((r) => r.path === PARAM_PATH)!;
    expect(param.selected).toBe(true);
    expect(param.depth).toBe(12);
    expect(rows.filter((r) => r.selected)).toHaveLength(1);
    // The siblings along the way are shown, collapsed: 13 ancestors-or-self + their visible siblings.
    expect(rows.find((r) => r.path === 'defs.body.a.a.a.b')!.expanded).toBe(false);
    expect(rows.find((r) => r.path === 'defs.body.a.a.a.a.b.b.x.b.x.x.b')!.expanded).toBe(true);
    const rules: Selection = { leaf: 'surface.rules', path: 'root.rules[1].then.rules[0].if.if' };
    const er = expandToSelection(DEFAULTS, NO_EXPANSION, rules);
    const rr = rowsOf(inspectorTree(DEFAULTS, er, rules), 'surface.rules');
    expect(rr.find((r) => r.selected)!.path).toBe(rules.path);
    expect([...er.keys()].sort()).toEqual([
      'surface.rules|root.rules[1].then', 'surface.rules|root.rules[1].then.rules[0]', 'surface.rules|root.rules[1].then.rules[0].if',
    ]);
    // A selection that names no node changes nothing.
    expect(expandToSelection(DEFAULTS, er, { leaf: 'surface.rules', path: 'root.rules[7]' })).toBe(er);
  });

  test('8 px per level, capped at 12 levels', () => {
    expect([INDENT_PX, INDENT_LEVELS]).toEqual([8, 12]);
    expect([0, 1, 11, 12, 13, 16, 40].map(indentOf)).toEqual([0, 8, 88, 96, 96, 96, 96]);
    const sel: Selection = { leaf: 'density.defs', path: PARAM_PATH };
    const rows = rowsOf(inspectorTree(DEFAULTS, expandToSelection(DEFAULTS, NO_EXPANSION, sel), sel), 'density.defs');
    // The param sits 12 levels below defs.body (SP6a §1.1), the deepest level of the default tree: at the cap.
    expect(rows.filter((r) => PARAM_PATH.startsWith(r.path)).map((r) => r.indent)).toEqual(
      [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96],
    );
  });

  test('the key string changes exactly when a shown row or the selection changes', () => {
    const a = inspectorTree(DEFAULTS, NO_EXPANSION, null);
    const copy = withDensity(JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)));
    expect(inspectorTree(copy, NO_EXPANSION, null).key).toBe(a.key);
    // A change below the collapsed rows is not shown: same key.
    // (SP6a §1.1: the precave tap, at depth 3 under the collapsed root.a.a, gets a plain y as its detail term.)
    const terrain = { op: 'tap', name: 'terrain', x: { op: 'interpolated', x: { op: 'ref', name: 'body' } } };
    const slot = { op: 'const', v: 1000000 };
    const deep = withDensity({ ...(DEFAULT_DENSITY_TREE as { root: object }), root: { op: 'max',
      a: { op: 'min', a: { op: 'min', a: { op: 'tap', name: 'precave', x: { op: 'add', a: terrain, b: { op: 'y' } } }, b: slot }, b: slot },
      b: { op: 'tap', name: 'islands', x: { op: 'const', v: -1000000 } } } });
    expect(inspectorTree(deep, NO_EXPANSION, null).key).toBe(a.key);
    expect(inspectorTree(DEFAULTS, NO_EXPANSION, DEFAULT_SELECTION).key).not.toBe(a.key);
    expect(inspectorTree(DEFAULTS, toggleExpansion(NO_EXPANSION, 'density.defs', 'root.a.a', 2), null).key).not.toBe(a.key);
    const islands = withDensity({ ...(DEFAULT_DENSITY_TREE as object), root: { ...(DEFAULT_DENSITY_TREE as { root: object }).root,
      b: { op: 'tap', name: 'islands', x: { op: 'const', v: -10 } } } });
    expect(inspectorTree(islands, NO_EXPANSION, null).key).not.toBe(a.key);
    expect(rowsOf(inspectorTree(islands, NO_EXPANSION, null), 'density.defs').every((r) => r.key.length > 0)).toBe(true);
  });
});

describe('selection follows the longest prefix that still names a node', () => {
  test('after undo, redo and reset of the session', () => {
    const w = session();
    const edited = JSON.parse(JSON.stringify(DEFAULT_DENSITY_TREE)) as { root: { b: unknown } };
    edited.root.b = { op: 'tap', name: 'islands', x: { op: 'add', a: { op: 'const', v: 1 }, b: { op: 'neg', x: { op: 'const', v: 2 } } } };
    expect(w.set('density.defs', edited).ok).toBe(true);
    const sel: Selection = { leaf: 'density.defs', path: 'root.b.x.b.x' };
    expect(followNode(w.state.params, sel)).toEqual(sel);
    expect(w.undo()).toBe(true);
    expect(followNode(w.state.params, sel)).toEqual({ leaf: 'density.defs', path: 'root.b.x' });
    expect(w.redo()).toBe(true);
    expect(followNode(w.state.params, sel)).toBe(sel);
    expect(w.reset('density.defs').ok).toBe(true);
    expect(followNode(w.state.params, sel)).toEqual({ leaf: 'density.defs', path: 'root.b.x' });
  });

  test('after a deletion that renumbers a sequence, and when a def disappears', () => {
    const rules = (n: number) => ({ kind: 'sequence', rules: [
      ...(n === 3 ? [{ kind: 'block', state: 'stone' }] : []),
      { kind: 'condition', if: { kind: 'skyOpen' }, then: { kind: 'block', state: 'dirt' } },
      { kind: 'block', state: 'grass_block' },
    ] });
    const three = withRules(rules(3));
    const two = withRules(rules(2));
    const atThen: Selection = { leaf: 'surface.rules', path: 'root.rules[1].then' };
    expect(followNode(three, atThen)).toBe(atThen);
    // rules[0] deleted: rules[1] is now the grass block, which has no `then`.
    expect(followNode(two, atThen)).toEqual({ leaf: 'surface.rules', path: 'root.rules[1]' });
    expect(followNode(two, { leaf: 'surface.rules', path: 'root.rules[2]' })).toEqual({ leaf: 'surface.rules', path: 'root' });
    const withDef = withDensity({ root: { op: 'ref', name: 'd' }, defs: { d: { op: 'neg', x: { op: 'y' } } } });
    const sel: Selection = { leaf: 'density.defs', path: 'defs.d.x' };
    expect(followNode(withDef, sel)).toBe(sel);
    expect(followNode(DEFAULTS, sel)).toEqual(DEFAULT_SELECTION);
    expect(DEFAULT_SELECTION).toEqual({ leaf: 'density.defs', path: 'root' });
    // Paths that name no node of the format fall back to the tree's root.
    expect(followNode(DEFAULTS, { leaf: 'density.defs', path: 'root.a.a.a.x.b.inside.b.b.b.lo' })).toEqual({ leaf: 'density.defs', path: 'root.a.a.a.x.b.inside.b.b.b' });
    expect(followNode(DEFAULTS, { leaf: 'density.defs', path: 'defs' })).toEqual(DEFAULT_SELECTION);
    expect(followNode(DEFAULTS, { leaf: 'surface.rules', path: 'rules[0]' })).toEqual({ leaf: 'surface.rules', path: 'root' });
    expect(followNode(DEFAULTS, { leaf: 'density.defs', path: 'root.constructor' })).toEqual(DEFAULT_SELECTION);
  });

  test('findNode reads own properties only', () => {
    expect(findNode(DEFAULT_DENSITY_TREE, 'density', 'root.b')).toEqual({ op: 'tap', name: 'islands', x: { op: 'const', v: -1000000 } });
    expect(findNode(DEFAULT_SURFACE_RULES, 'surfaceRules', 'root.rules[2].if')).toEqual({ kind: 'verticalGradient', trueAtAndBelow: 0, falseAtAndAbove: 8 });
    expect(findNode(DEFAULT_SURFACE_RULES, 'surfaceRules', 'root')).toBe(DEFAULT_SURFACE_RULES);
    for (const p of ['root.toString', 'defs.constructor', 'root.__proto__', 'root.a.knots', 'root.rules[3]', '']) {
      expect(findNode(DEFAULT_DENSITY_TREE, 'density', p)).toBeUndefined();
    }
    expect(findNode(DEFAULT_SURFACE_RULES, 'surfaceRules', 'root.rules.length')).toBeUndefined();
    expect(findNode(DEFAULT_SURFACE_RULES, 'surfaceRules', 'root.rules[-1]')).toBeUndefined();
  });
});

describe('caret → node and selection → highlight', () => {
  const density = (text: string, at: string): number => text.indexOf(at);

  test('a clean buffer: the innermost node at the caret, selected when the session has it', () => {
    const w = session();
    const m = createEditorModel('density.defs', w, fakeClock());
    const { text, ranges } = printTree(DEFAULT_DENSITY_TREE, 'density');
    const overhang = 'defs.body.a.a.b.b.x';
    m.setCaret(ranges.byPath.get(overhang)!.start + 3);
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: overhang, select: { leaf: 'density.defs', path: overhang } });
    // On a field of a node: that node.
    // The body's slide (SP6a's entrances print their yGrad slide's knots earlier, under the root).
    m.setCaret(density(text, '"knots": [[-64'));
    expect(caretTarget(m.state, w.state.params).select).toEqual({ leaf: 'density.defs', path: 'defs.body.a.a.b.b' });
    // Outside every node (the value's own braces, the "defs" key): nothing.
    m.setCaret(0);
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: null, select: null });
    m.setCaret(density(text, '"defs"'));
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: null, select: null });
  });

  test('a typed buffer: nothing while it is pending or does not parse; buffer-only paths highlight without selecting', () => {
    const w = session();
    const clock = fakeClock();
    const m = createEditorModel('density.defs', w, clock);
    const base = m.state.text;
    // A def added before the default's one def, body (SP6a §1.1).
    const typed = base.replace('"defs": {\n', '"defs": {\n    "extra": { "op": "neg", "x": { "op": "y" } },\n');
    expect(typed).not.toBe(base);
    const extra = typed.indexOf('"extra"') + 12;
    m.edit(typed, extra);
    expect(m.state.status).toBe('pending');
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: null, select: null });
    clock.advance(150);
    expect(m.state.ranges).not.toBeNull();
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: 'defs.extra', select: null });
    m.setCaret(typed.indexOf('"op": "y"', extra) + 2);
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: 'defs.extra.x', select: null });
    m.setCaret(typed.indexOf('"islands"'));
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: 'root.b', select: { leaf: 'density.defs', path: 'root.b' } });
    // A syntax error: nothing, also after the debounce.
    m.edit(`${typed},`, 5);
    clock.advance(150);
    expect(m.state.status).toBe('syntax');
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: null, select: null });
  });

  test('the rules editor selects rule and condition paths', () => {
    const w = session();
    const m = createEditorModel('surface.rules', w, fakeClock());
    const at = m.state.text.indexOf('"kind": "skyOpen"');
    m.setCaret(at);
    expect(caretTarget(m.state, w.state.params)).toEqual({ highlight: 'root.rules[1].if', select: { leaf: 'surface.rules', path: 'root.rules[1].if' } });
  });

  test('selecting a row highlights its range in the editor of its root', () => {
    const w = session();
    const m = createEditorModel('density.defs', w, fakeClock());
    const { ranges } = printTree(DEFAULT_DENSITY_TREE, 'density');
    expect(highlightRange(m.state, { leaf: 'density.defs', path: 'root.b' })).toEqual(ranges.byPath.get('root.b'));
    expect(highlightRange(m.state, { leaf: 'surface.rules', path: 'root' })).toBeNull();
    expect(highlightRange(m.state, { leaf: 'density.defs', path: 'root.zz' })).toBeNull();
    m.edit('{', 1);
    expect(highlightRange(m.state, { leaf: 'density.defs', path: 'root.b' })).toBeNull();
  });
});

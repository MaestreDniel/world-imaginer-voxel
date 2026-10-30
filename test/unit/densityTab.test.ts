/**
 * The Density tab's DOM rules, extracted as pure helpers (SP3d spec §3.1, §3.3, §3.5; the DOM is densityTab.ts and
 * jsonEditor.ts): the layout mode by drawer width (grid ≥ 1,200 px, Slice/JSON sub-tabs below, stacked below 900 px),
 * the sub-tab shown first ("Slice") and which panes each mode shows; the JSON editor's line arithmetic (offset → line,
 * line → offset, a range scrolled into view by its line index × the line height, the scroll anchor), the mirror's
 * highlight split and its keys (Ctrl/Cmd+Enter applies, Escape reverts); and the target slider of a ref field (the
 * parameter panel's row of the target, written on its leaf, a noise's clampSigma as a partial noise).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getPath } from '../../src/core/params/kit';
import { DEFAULTS } from '../../src/core/params/defaults';
import { WorldSession } from '../../src/engine/session';
import { ALLOWED_REF_TARGETS } from '../../src/gen/density/source';
import { validateParamTrees } from '../../src/gen/trees';
import { createDensityTab } from '../../src/ui/inspector/densityTab';
import {
  anchorOfScroll, createScrollKeeper, EDITOR_LINE_PX, editorKeyAction, highlightParts, lineIndexAt, lineStart, scrollOfAnchor,
  scrollTarget, scrollTopForLine,
} from '../../src/ui/inspector/editorModel';
import { printTree } from '../../src/ui/inspector/jsonText';
import {
  DEFAULT_SUB_TAB, DENSITY_STACK_PX, DENSITY_SUB_TAB_LABELS, DENSITY_SUB_TABS, DENSITY_WIDE_PX, densityLayout, shownPanes,
} from '../../src/ui/inspector/model';
import { refTargetControl, refTargetWrite, sliderToValue } from '../../src/ui/paramPanel/model';
import { installDom, type FakeElement } from './fixtures/domShim';

describe('layout mode by drawer width (§3.1)', () => {
  test('the four columns from 1,200 px, the Slice/JSON sub-tabs below, stacked below 900 px', () => {
    expect([DENSITY_WIDE_PX, DENSITY_STACK_PX]).toEqual([1200, 900]);
    expect(densityLayout(1920)).toBe('grid');
    expect(densityLayout(1200)).toBe('grid');
    expect(densityLayout(1199.5)).toBe('tabs');
    expect(densityLayout(900)).toBe('tabs');
    expect(densityLayout(899)).toBe('stack');
    expect(densityLayout(320)).toBe('stack');
  });

  test('a hidden tab (width 0 or not a number) keeps the last mode', () => {
    expect(densityLayout(0)).toBe('grid');
    expect(densityLayout(0, 'stack')).toBe('stack');
    expect(densityLayout(Number.NaN, 'tabs')).toBe('tabs');
    expect(densityLayout(1000, 'stack')).toBe('tabs');
  });

  test('the sub-tab shown first is "Slice"; the grid shows both panes, the other modes the selected one', () => {
    expect(DEFAULT_SUB_TAB).toBe('slice');
    expect(DENSITY_SUB_TABS).toEqual(['slice', 'json']);
    expect(DENSITY_SUB_TABS.map((t) => DENSITY_SUB_TAB_LABELS[t])).toEqual(['Slice', 'JSON']);
    expect(shownPanes('grid', 'slice')).toEqual({ slice: true, json: true, subTabs: false });
    expect(shownPanes('grid', 'json')).toEqual({ slice: true, json: true, subTabs: false });
    expect(shownPanes('tabs', 'slice')).toEqual({ slice: true, json: false, subTabs: true });
    expect(shownPanes('tabs', 'json')).toEqual({ slice: false, json: true, subTabs: true });
    expect(shownPanes('stack', DEFAULT_SUB_TAB)).toEqual({ slice: true, json: false, subTabs: true });
    expect(shownPanes('stack', 'json')).toEqual({ slice: false, json: true, subTabs: true });
  });
});

describe('JSON editor lines (§3.5)', () => {
  const text = '{\n  "a": 1,\n  "b": [1, 2]\n}';

  test('offset → line index and line → offset', () => {
    expect([0, 1, 2, 3, 4, 13, 26, text.length].map((o) => lineIndexAt(text, o))).toEqual([0, 0, 1, 1, 1, 2, 3, 3]);
    expect([0, 1, 2, 3, 4, 99].map((l) => lineStart(text, l))).toEqual([0, 2, 12, 26, text.length, text.length]);
    expect(lineIndexAt(text, -5)).toBe(0);
    expect(lineIndexAt('', 0)).toBe(0);
    for (let l = 0; l < 4; l++) expect(lineIndexAt(text, lineStart(text, l))).toBe(l);
  });

  test('a range is scrolled into view by its line index × the line height; a visible line keeps the scroll', () => {
    expect(EDITOR_LINE_PX).toBe(16);
    // view of 10 lines (160 px) at the top: lines 0-9 are fully visible.
    expect(scrollTopForLine(0, 16, 160, 0)).toBe(0);
    expect(scrollTopForLine(9, 16, 160, 0)).toBe(0);
    // line 10 is below: it is placed a third of the view (3 lines) from the top.
    expect(scrollTopForLine(10, 16, 160, 0)).toBe((10 - 3) * 16);
    expect(scrollTopForLine(500, 16, 160, 0)).toBe(497 * 16);
    // above the view, and a line half hidden at the top.
    expect(scrollTopForLine(2, 16, 160, 400)).toBe(0);
    expect(scrollTopForLine(24, 16, 160, 390)).toBe(21 * 16);
    expect(scrollTopForLine(25, 16, 160, 390)).toBe(390);
    // a view shorter than a line.
    expect(scrollTopForLine(4, 16, 8, 0)).toBe(64);
  });

  test('the scroll anchor is the first visible line\'s offset, and maps back to its line × the line height', () => {
    const big = printTree(DEFAULTS.density.defs, 'density').text;
    const lines = big.split('\n');
    expect(lines.length).toBeGreaterThan(40);
    expect(anchorOfScroll(big, 0, 16)).toBe(0);
    expect(anchorOfScroll(big, 16 * 7 + 5, 16)).toBe(lineStart(big, 7));
    expect(anchorOfScroll(big, 1e9, 16)).toBe(lineStart(big, lines.length - 1));
    for (const l of [0, 7, 30, lines.length - 1]) expect(scrollOfAnchor(big, lineStart(big, l), 16)).toBe(l * 16);
    // an anchor inside a line scrolls to that line.
    expect(scrollOfAnchor(big, lineStart(big, 12) + 3, 16)).toBe(12 * 16);
  });

  test('a scroll request made while the view height is 0 is kept and applied on show', () => {
    // Below 1,200 px the Slice sub-tab hides the JSON pane: a row selected there scrolls the text when JSON is shown.
    const big = printTree(DEFAULTS.density.defs, 'density');
    const r = big.ranges.byPath.get('root.a.a.x.x.b')!;
    const line = lineIndexAt(big.text, r.start);
    expect(line).toBeGreaterThan(20);
    const hidden = { height: 0, top: 0, left: 0 };
    const k = createScrollKeeper();
    expect(k.request({ kind: 'line', line }, big.text, hidden)).toBeNull();
    expect(k.owed).toEqual({ kind: 'line', line });
    // Still hidden (the drawer tab shown while the Slice sub-tab is up): still owed.
    expect(k.shown(big.text, hidden)).toBeNull();
    const shownView = { height: 160, top: 0, left: 0 };
    const to = k.shown(big.text, shownView);
    expect(to).toEqual({ top: scrollTopForLine(line, EDITOR_LINE_PX, 160, 0), left: 0 });
    // The marked range's first line lies inside the view's rect.
    expect(line * EDITOR_LINE_PX).toBeGreaterThanOrEqual(to!.top);
    expect((line + 1) * EDITOR_LINE_PX).toBeLessThanOrEqual(to!.top + 160);
    expect([k.owed, k.shown(big.text, shownView)]).toEqual([null, null]);
    // The latest request wins; one made while displayed is written at once and owes nothing.
    k.request({ kind: 'line', line: 3 }, big.text, hidden);
    k.request({ kind: 'line', line }, big.text, hidden);
    expect(k.shown(big.text, { height: 160, top: 9999, left: 4 })).toEqual({ top: scrollTopForLine(line, EDITOR_LINE_PX, 160, 9999), left: 4 });
    expect(k.request({ kind: 'line', line: 0 }, big.text, { height: 160, top: 400, left: 0 })).toEqual({ top: 0, left: 0 });
    expect(k.owed).toBeNull();
  });

  test('a re-print while hidden restores the mapped anchor, not the saved pixels', () => {
    const big = printTree(DEFAULTS.density.defs, 'density').text;
    const k = createScrollKeeper();
    // Hiding a displayed view keeps its offsets, which come back on show when nothing else is owed.
    k.hidden({ height: 160, top: 200, left: 30 });
    expect(k.owed).toEqual({ kind: 'offset', top: 200, left: 30 });
    expect(k.shown(big, { height: 160, top: 0, left: 0 })).toEqual({ top: 200, left: 30 });
    // A re-print while hidden (the toolbar's undo on another drawer tab): its anchor replaces the kept pixels.
    k.hidden({ height: 160, top: 200, left: 30 });
    const anchor = lineStart(big, 30);
    expect(k.request({ kind: 'anchor', anchor }, big, { height: 0, top: 0, left: 0 })).toBeNull();
    expect(k.shown(big, { height: 160, top: 0, left: 0 })).toEqual({ top: scrollOfAnchor(big, anchor, EDITOR_LINE_PX), left: 0 });
    // Hiding while a request is owed keeps the request; hiding an undisplayed view keeps nothing.
    k.request({ kind: 'line', line: 40 }, big, { height: 0, top: 0, left: 0 });
    k.hidden({ height: 160, top: 16, left: 0 });
    expect(k.owed).toEqual({ kind: 'line', line: 40 });
    const fresh = createScrollKeeper();
    fresh.hidden({ height: 0, top: 0, left: 0 });
    expect(fresh.owed).toBeNull();
    expect(scrollTarget({ kind: 'offset', top: 5, left: 6 }, big, { height: 160, top: 0, left: 0 })).toEqual({ top: 5, left: 6 });
  });

  test('the mirror splits the text around the highlighted range', () => {
    expect(highlightParts('abcdef', { start: 2, end: 4 })).toEqual(['ab', 'cd', 'ef']);
    expect(highlightParts('abcdef', null)).toEqual(['abcdef', '', '']);
    expect(highlightParts('abc', { start: 1, end: 99 })).toEqual(['a', 'bc', '']);
    expect(highlightParts('abc', { start: 5, end: 9 })).toEqual(['abc', '', '']);
    const printed = printTree(DEFAULTS.density.defs, 'density');
    const r = printed.ranges.byPath.get('root.b')!;
    const [before, mark, after] = highlightParts(printed.text, r);
    expect(before + mark + after).toBe(printed.text);
    expect(mark.startsWith('{') && mark.endsWith('}')).toBe(true);
  });

  test('Ctrl+Enter and Cmd+Enter apply, Escape reverts, anything else is left to the textarea', () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
      editorKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
    expect(k('Enter', { ctrlKey: true })).toBe('apply');
    expect(k('Enter', { metaKey: true })).toBe('apply');
    expect(k('Enter')).toBeNull();
    expect(k('Enter', { ctrlKey: true, altKey: true })).toBeNull();
    expect(k('Escape')).toBe('revert');
    expect(k('Escape', { ctrlKey: true })).toBeNull();
    expect(k('z', { ctrlKey: true })).toBeNull();
    expect(k('a')).toBeNull();
  });
});

describe('the target slider of a ref field (§3.3)', () => {
  test('a number or int leaf: its own panel spec, written on the leaf', () => {
    const t = refTargetControl('density.detailAmpLo');
    expect(t.leaf).toBe('density.detailAmpLo');
    expect(t.field).toBeNull();
    expect(t.spec.path).toBe('density.detailAmpLo');
    expect(t.spec.kind).toBe('number');
    expect(refTargetWrite(t, 0.8)).toBe(0.8);
    const i = refTargetControl('surface.cliffMinY');
    expect(i.spec.kind).toBe('int');
    expect(sliderToValue(i.spec, 0.5)).toBe(Math.round(sliderToValue(i.spec, 0.5)));
  });

  test('a noise clampSigma: the noise sub-block\'s slider, written as a partial noise on the noise leaf', () => {
    const t = refTargetControl('density.noises.jag.clampSigma');
    expect(t.leaf).toBe('density.noises.jag');
    expect(t.field).toBe('clampSigma');
    expect(t.spec.path).toBe('density.noises.jag.clampSigma');
    expect(t.spec.label).toBe('clampSigma');
    expect(refTargetWrite(t, 3)).toEqual({ clampSigma: 3 });
  });

  test('every allowed target has a slider, whose range is the target\'s static range, and the write moves it in a session', () => {
    const s = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    for (const [path, range] of ALLOWED_REF_TARGETS) {
      const t = refTargetControl(path);
      expect(t.spec.path).toBe(path);
      expect([t.spec.min, t.spec.max]).toEqual([range.lo, range.hi]);
      const v = sliderToValue(t.spec, 1);
      const r = s.set(t.leaf, refTargetWrite(t, v));
      expect(r.ok, path).toBe(true);
      expect(getPath(s.state.params, path)).toBe(v);
    }
  });

  test('a path that is no ref target is a RangeError', () => {
    for (const p of ['density.defs', 'climate.T.wavelength', 'density.noises.jag.octaves.x', 'nope', 'density.noises.jag.remap']) {
      expect(() => refTargetControl(p), p).toThrow(RangeError);
    }
  });
});

describe('the Density tab in a saved world\'s modification mode (SP5b spec D10)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Every descendant of `e`. */
  const all = (e: FakeElement): FakeElement[] => e.children.flatMap((c) => [c, ...all(c)]);

  test('`setEditable(false)`: the form\'s inputs disabled, the tree, the selection and the slices still work', () => {
    const dom = installDom();
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
    const session = new WorldSession(() => [1, 2], { validateParams: validateParamTrees });
    const host = dom.document.createElement('div');
    const tab = createDensityTab(host as unknown as HTMLElement, { session, edit: (_e, fn) => fn(), clock: { setTimeout: () => 0, clearTimeout: () => {} } });
    const of = (cls: string): FakeElement[] => all(host).filter((e) => e.className.split(' ').includes(cls));
    const form = of('it-form')[0]!;
    const formControls = (): FakeElement[] => ['input', 'select', 'button', 'textarea'].flatMap((t) => form.querySelectorAll(t));
    const json = of('je-bar')[0]!;
    const jsonButton = (t: string): FakeElement => json.children.find((b) => b.textContent === t)!;
    expect(formControls().length).toBeGreaterThan(0);
    expect(formControls().filter((c) => c.disabled)).toEqual([]);

    tab.setEditable(false);
    expect(formControls().filter((c) => !c.disabled)).toEqual([]);
    // The JSON editor: its text read-only, Apply and Reset disabled.
    expect((of('je-text')[0] as unknown as { readOnly: boolean }).readOnly).toBe(true);
    expect([jsonButton('Apply').disabled, jsonButton('Reset').disabled]).toEqual([true, true]);
    // The tree: a row's button selects its node and the selection's listeners (the slice viewer) hear it; the form shown
    // for it is disabled too.
    const heard: string[] = [];
    tab.onSelect((sel) => heard.push(`${sel.leaf}.${sel.path}`));
    const was = tab.selection;
    const other = of('it-node').find((b) => b.getAttribute('aria-current') !== 'true')!;
    other.click();
    expect(tab.selection).not.toEqual(was);
    expect(heard).toEqual([`${tab.selection.leaf}.${tab.selection.path}`]);
    expect(formControls().length).toBeGreaterThan(0);
    expect(formControls().filter((c) => !c.disabled)).toEqual([]);
    // Looking stays: the tree's buttons, Expand to selection, the Slice and JSON sub-tabs, the slice cell.
    expect(of('it-node').every((b) => !b.disabled)).toBe(true);
    expect(of('it-toggle').filter((t) => t.textContent !== '').every((t) => !t.disabled)).toBe(true);
    expect(all(of('it-tree-head')[0]!).every((b) => !b.disabled)).toBe(true);
    expect(of('it-subtabs')[0]!.children.every((b) => !b.disabled)).toBe(true);
    expect(tab.sliceHost.hidden).toBe(false);
    // A tap's mute in the tree is an edit: disabled.
    expect(of('it-mute').length).toBeGreaterThan(0);
    expect(of('it-mute').every((m) => m.disabled)).toBe(true);

    tab.setEditable(true);
    expect(formControls().filter((c) => c.disabled)).toEqual([]);
    expect((of('je-text')[0] as unknown as { readOnly: boolean }).readOnly).toBe(false);
    expect(jsonButton('Reset').disabled).toBe(false);
    // Apply keeps its own reason: the buffer is the current tree.
    expect(jsonButton('Apply').disabled).toBe(true);
    expect(of('it-mute').every((m) => !m.disabled)).toBe(true);
  });
});

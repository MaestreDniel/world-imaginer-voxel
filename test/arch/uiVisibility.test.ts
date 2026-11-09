/**
 * No UI element sets `visibility: visible` (SP6a, Task 48f). The map overlay premounts its tool under a host with
 * `visibility: hidden` (`src/ui/world/mapOverlay.ts`), and `visibility` is inherited but can be overridden: a
 * descendant set to `visible` is painted and hit-testable through its hidden ancestor. A mark that shows and hides
 * itself writes `hidden` when off and nothing (CSS: `:not(.on) { visibility: hidden }`) or `inherit` (an SVG
 * attribute) when on, so it can never escape a hidden ancestor.
 */
import { describe, expect, test } from 'vitest';
import { lineAt, ROOT, scanTree } from './scan';

/** A CSS declaration `visibility: visible` (comments blanked). */
const CSS_VISIBLE = /(?<![\w-])visibility\s*:\s*visible\b/g;
/**
 * A script writing `visible` to a visibility: `setAttribute('visibility', 'visible')`, `{ visibility: 'visible' }`,
 * `style.visibility = 'visible'`, `setProperty('visibility', 'visible')` (matched on the text with strings kept,
 * comments blanked). A comparison (`=== 'visible'`) and `visibilityState` are not writes.
 */
const JS_VISIBLE = /(?<![\w$-])visibility['"`]?\s*(?:,|:|=(?!=))\s*['"`]visible['"`]/g;

const cssUses = (code: string) => [...code.matchAll(CSS_VISIBLE)].map((m) => lineAt(code, m.index));
const jsUses = (code: string) => [...code.matchAll(JS_VISIBLE)].map((m) => lineAt(code, m.index));

describe('visibility: visible detector', () => {
  test('CSS declarations and script writes of visible are reported', () => {
    expect(cssUses(['.a { visibility: hidden; }', '.a.on { visibility: visible; }', '.b{visibility:visible}'].join('\n'))).toEqual([2, 3]);
    expect(jsUses([
      "el.setAttribute('visibility', 'visible');",
      "svg('line', { visibility: 'visible' });",
      "el.style.visibility = 'visible';",
      "el.style.setProperty('visibility', \"visible\");",
    ].join('\n'))).toEqual([1, 2, 3, 4]);
  });

  test('hidden, inherit, comparisons and visibilityState are not', () => {
    expect(cssUses(['.a:not(.on) { visibility: hidden; }', '.b { visibility: inherit; }', '.c { content-visibility: visible; }'].join('\n'))).toEqual([]);
    expect(jsUses([
      "el.setAttribute('visibility', 'hidden');",
      "el.setAttribute('visibility', 'inherit');",
      "if (document.visibilityState === 'visible') read();",
      "if (el.style.visibility === 'visible') read();",
    ].join('\n'))).toEqual([]);
  });
});

test('no element under src/ui sets visibility: visible (it would escape the premounted map host\'s visibility: hidden)', () => {
  const found = scanTree(ROOT)
    .filter((f) => f.path.startsWith('src/ui/'))
    .flatMap((f) => {
      if (f.path.endsWith('.css')) return cssUses(f.code).map((line) => `${f.path}:${line}`);
      if (/\.[cm]?[jt]s$/.test(f.path)) return jsUses(f.codeKeepStrings).map((line) => `${f.path}:${line}`);
      return [];
    });
  expect(found).toEqual([]);
});

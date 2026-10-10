/**
 * Text reaches the page only through `textContent` (SP3d spec §3, the Density tab shows tree names, def names and
 * typed JSON that come from URLs and preset files): no HTML sink under src/ui — `innerHTML`, `outerHTML`,
 * `insertAdjacentHTML`, `document.write` / `writeln`, `createContextualFragment` and `srcdoc` — read or written.
 */
import { describe, expect, test } from 'vitest';
import { blankJs, lineAt, ROOT, scanTree } from './scan';

const SINKS = /(?<![\w$])(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|srcdoc)\b|\bdocument\s*\??\.\s*write(?:ln)?\b/g;
/** The same names by index (`el['innerHTML']`), matched on the text with strings kept. */
const INDEXED = /\[\s*(['"`])(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\1\s*\]/g;

/** Line numbers of every HTML sink in one file (`code`: comments and strings blanked; `keepStrings`: comments only). */
function sinkUses(code: string, keepStrings: string): number[] {
  const lines = new Set<number>();
  for (const m of code.matchAll(SINKS)) lines.add(lineAt(code, m.index));
  for (const m of keepStrings.matchAll(INDEXED)) if (code[m.index] === keepStrings[m.index]) lines.add(lineAt(code, m.index));
  return [...lines].sort((a, b) => a - b);
}

const uses = (src: string) => sinkUses(blankJs(src, { strings: true }), blankJs(src, { strings: false }));

describe('HTML sink detector', () => {
  test('writes, reads, indexed access and the other sinks are reported', () => {
    const src = [
      "row.innerHTML = '<b>' + name + '</b>';",
      'const h = box.innerHTML;',
      "el.outerHTML = '';",
      "el.insertAdjacentHTML('beforeend', text);",
      'document.write(text);',
      'document.writeln(text);',
      'range.createContextualFragment(text);',
      'frame.srcdoc = text;',
      "el['innerHTML'] = text;",
      'el?.innerHTML;',
    ].join('\n');
    expect(uses(src)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('textContent, comments, strings and similar names are not', () => {
    const src = [
      'row.textContent = name;',
      '// never row.innerHTML = name',
      "const s = 'innerHTML';",
      'const t = `document.write(x)`;',
      'const myinnerHTMLish = 1;',
      'el.title = text;',
      'writer.write(text);',
    ].join('\n');
    expect(uses(src)).toEqual([]);
  });
});

test('no HTML sink under src/ui, the Density tab\'s DOM included', () => {
  const files = scanTree(ROOT).filter((f) => f.path.startsWith('src/ui/') && /\.[cm]?[jt]s$/.test(f.path));
  const found = files.flatMap((f) => sinkUses(f.code, f.codeKeepStrings).map((line) => `${f.path}:${line}`));
  expect(found).toEqual([]);
  // The tab's DOM files show tree content (names, paths, typed JSON): the scan must see them.
  const paths = new Set(files.map((f) => f.path));
  expect(['src/ui/inspector/densityTab.ts', 'src/ui/inspector/jsonEditor.ts'].filter((p) => !paths.has(p))).toEqual([]);
});

/**
 * No browser dialogs in the UI (SP2b spec §1.5): prompt(), alert() and confirm() block the page; the editor
 * uses the inline notices and the inline confirmation of ui/common/notice.ts instead.
 */
import { describe, expect, test } from 'vitest';
import { blankJs, lineAt, ROOT, scanTree } from './scan';

const DIALOG = 'prompt|alert|confirm';
const GLOBALS = 'window|globalThis|self|top|parent|frames|opener';
/** A bare call `confirm(` (never a member call such as `notices.confirm(`), or `confirm.call(` / `.apply(` / `.bind(`. */
const BARE = new RegExp(String.raw`(?<![\w$.])(?:${DIALOG})\s*(\(|\.\s*(?:call|apply|bind)\b)`, 'g');
/** A dialog reached through a global object, called or not: `window.confirm`, `globalThis?.alert`. */
const GLOBAL_MEMBER = new RegExp(String.raw`(?<![\w$.])(?:${GLOBALS})\s*\??\.\s*(?:${DIALOG})\b`, 'g');
/** The same by index: `window['confirm']` (matched on the text with strings kept). */
const GLOBAL_INDEX = new RegExp(String.raw`(?<![\w$.])(?:${GLOBALS})\s*(?:\?\.\s*)?\[\s*(['"\x60])(?:${DIALOG})\1\s*\]`, 'g');
/** What may precede a member name that is being defined rather than called. */
const MEMBER_START = /(?:^|[{};,])$|(?:^|[^\w$])(?:function|async|static|public|private|protected|readonly|declare|get|set)$/;

/** `confirm(…) {` or `confirm(…): T` at the start of a member (object or class method, interface member, function declaration) defines the name. */
function isDefinition(code: string, nameAt: number, openParen: number): boolean {
  let depth = 0;
  let i = openParen;
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) break;
  }
  let j = i + 1;
  while (j < code.length && /\s/.test(code[j]!)) j++;
  if (code[j] !== '{' && code[j] !== ':') return false;
  return MEMBER_START.test(code.slice(0, nameAt).trimEnd());
}

/**
 * Line numbers of every browser-dialog use in one file. `code` has comments and strings blanked, `keepStrings`
 * only comments (the two texts of `scanFile`); a position is code, not string text, where the two agree.
 */
function dialogUses(code: string, keepStrings: string): number[] {
  const lines = new Set<number>();
  for (const m of code.matchAll(BARE)) {
    if (m[1] === '(' && isDefinition(code, m.index, m.index + m[0].length - 1)) continue;
    lines.add(lineAt(code, m.index));
  }
  for (const m of code.matchAll(GLOBAL_MEMBER)) lines.add(lineAt(code, m.index));
  for (const m of keepStrings.matchAll(GLOBAL_INDEX)) if (code[m.index] === keepStrings[m.index]) lines.add(lineAt(code, m.index));
  return [...lines].sort((a, b) => a - b);
}

const uses = (src: string) => dialogUses(blankJs(src, { strings: true }), blankJs(src, { strings: false }));

describe('dialog detector', () => {
  test('bare calls, calls through a global object (member or index, called or not) and call/apply/bind are reported', () => {
    const src = [
      "confirm('Continue?');",
      "if (!confirm('Switching profile clears the patch. Continue?')) return;",
      'alert(1);',
      "const name = prompt ('name');",
      "window.confirm('a');",
      "globalThis.alert('b');",
      "self.prompt('c');",
      'const f = window.confirm;',
      "window['alert']('d');",
      "window?.confirm('e');",
      "const r = ok ? confirm('f') : false;",
      "confirm.call(null, 'g');",
      'const x = {',
      "  ok: confirm('h'),",
      '};',
    ].join('\n');
    expect(uses(src)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]);
  });

  test('comments, strings, member calls, similar names and definitions named confirm are not', () => {
    const src = [
      "// confirm('in a comment')",
      "/* alert('in a block comment') */",
      "const s = 'confirm(1) alert(2) prompt(3)';",
      "const t = `window.confirm('x')`;",
      'const u = "window[\'alert\']";',
      "notices.confirm('Switching to large_biomes clears 2 modified parameters', 'Switch');",
      "this.confirm('a', 'b');",
      "showAlert('x'); promptText('y'); confirmLabel('z');",
      'const v = obj.alert;',
      'interface Notices {',
      '  clear(): void;',
      '  confirm(text: string, confirmLabel: string): Promise<boolean>;',
      '}',
      'const n = {',
      '  show() {},',
      '  confirm(text: string, label: string) { return Promise.resolve(text === label); },',
      '};',
      'const m = { confirm: (text: string) => text };',
      'class C { async confirm(text: string): Promise<boolean> { return text === \'\'; } }',
    ].join('\n');
    expect(uses(src)).toEqual([]);
  });
});

test('no prompt(), alert() or confirm() under src/ui', () => {
  const found = scanTree(ROOT)
    .filter((f) => f.path.startsWith('src/ui/') && /\.[cm]?[jt]s$/.test(f.path))
    .flatMap((f) => dialogUses(f.code, f.codeKeepStrings).map((line) => `${f.path}:${line}`));
  expect(found).toEqual([]);
});

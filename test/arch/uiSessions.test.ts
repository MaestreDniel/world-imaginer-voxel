/**
 * Every page session runs tier 2 of the trees (SP3d spec §1.8, D2): each `new WorldSession(` under src/ui/ passes
 * `validateParams` in its arguments (the ?map page builds its session through `openMapSession`, which passes
 * `validateParamTrees`). The engine's own tests may leave the option out.
 */
import { describe, expect, test } from 'vitest';
import { blankJs, lineAt, ROOT, scanTree } from './scan';

const NEW_SESSION = /\bnew\s+WorldSession\s*\(/g;

/** The text between the call's parentheses (`open` is the index of its `(`), or the rest of the file if unbalanced. */
function argsOf(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** Line numbers of every `new WorldSession(…)` whose arguments do not name `validateParams` (`code`: comments and strings blanked). */
function unvalidatedSessions(code: string): number[] {
  const lines: number[] = [];
  for (const m of code.matchAll(NEW_SESSION)) {
    if (!/\bvalidateParams\b/.test(argsOf(code, m.index + m[0].length - 1))) lines.push(lineAt(code, m.index));
  }
  return lines;
}

const found = (src: string) => unvalidatedSessions(blankJs(src, { strings: true }));

describe('session detector', () => {
  test('a session built without validateParams is reported, on its own line', () => {
    const src = [
      'const a = new WorldSession(random);',
      'const b = new WorldSession(random, { seedText: s, patch: p });',
      'const c = new WorldSession(',
      '  random,',
      '  { seedText: f(x), profile },',
      ');',
      "const d = new WorldSession(random, { seedText: 'validateParams' });",
      'const e = new WorldSession(random, { seedText: s /* validateParams */ });',
    ].join('\n');
    expect(found(src)).toEqual([1, 2, 3, 7, 8]);
  });

  test('a session that passes validateParams, comments, strings and other classes are not', () => {
    const src = [
      'const a = new WorldSession(random, { seedText: s, validateParams: validateParamTrees });',
      'const b = new WorldSession(random, { ...init, validateParams });',
      'const c = new WorldSession(',
      '  random,',
      '  { seedText: f(x), validateParams: (p) => check(p) },',
      ');',
      '// const d = new WorldSession(random);',
      "const e = 'new WorldSession(random)';",
      'const f = new WorldSessionLike(random);',
      'const g: WorldSession = open();',
    ].join('\n');
    expect(found(src)).toEqual([]);
  });
});

test('every new WorldSession( under src/ui passes validateParams', () => {
  const files = scanTree(ROOT).filter((f) => f.path.startsWith('src/ui/') && /\.[cm]?[jt]s$/.test(f.path));
  const bad = files.flatMap((f) => unvalidatedSessions(f.code).map((line) => `${f.path}:${line}`));
  expect(bad).toEqual([]);
  // The ?map page's session is built in mapState.ts (openMapSession); the scan must see it.
  expect(files.some((f) => f.path === 'src/ui/map/mapState.ts' && f.code.match(NEW_SESSION) !== null)).toBe(true);
});

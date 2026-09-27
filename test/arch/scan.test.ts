import { describe, expect, test } from 'vitest';
import { blankJs, extractEdges, layerOf, resolveTarget } from './scan';

describe('blankJs', () => {
  test('blanks comments and optionally string contents, keeping line numbers', () => {
    const src = "a // c\nb /* x\ny */ 'str' `t`";
    expect(blankJs(src, { strings: false })).toBe("a     \nb     \n     'str' `t`");
    expect(blankJs(src, { strings: true })).toBe("a     \nb     \n     '   ' ` `");
  });

  test('// inside a string is not a comment', () => {
    expect(blankJs("x = 'http://a'; // c", { strings: false })).toBe("x = 'http://a';     ");
  });
});

describe('layerOf', () => {
  test('first segment under src, main.ts is main, others null', () => {
    expect(layerOf('src/gen/density/x.ts')).toBe('gen');
    expect(layerOf('src/main.ts')).toBe('main');
    expect(layerOf('src/other.ts')).toBeNull();
    expect(layerOf('test/x.ts')).toBeNull();
  });
});

describe('extractEdges', () => {
  test('static, type-only, inline type, side-effect, export-from and multi-line imports', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from './b';",
      "import { type C } from './c';",
      "import './d.css';",
      "export * from './e';",
      "export type { F } from './f';",
      'import {',
      '  g,',
      "} from './g';",
    ].join('\n');
    expect(extractEdges('src/ui/x.ts', src)).toEqual([
      { spec: './a', kind: 'value', line: 1 },
      { spec: './b', kind: 'type', line: 2 },
      { spec: './c', kind: 'value', line: 3 },
      { spec: './g', kind: 'value', line: 7 },
      { spec: './d.css', kind: 'value', line: 4 },
      { spec: './e', kind: 'value', line: 5 },
      { spec: './f', kind: 'type', line: 6 },
    ]);
  });

  test('dynamic, type-import expression, non-literal, worker, url, glob and reference edges', () => {
    const src = [
      "const m = await import('./m');",
      "type T = import('./t').T;",
      'const n = import(name);',
      "new Worker(new URL('../workers/w.worker.ts', import.meta.url), { type: 'module' });",
      "const u = new URL('./asset.png', import.meta.url);",
      "import.meta.glob('./g/*.ts');",
      '/// <reference path="./r.d.ts" />',
    ].join('\n');
    expect(extractEdges('src/engine/x.ts', src)).toEqual([
      { spec: './m', kind: 'value', line: 1 },
      { spec: './t', kind: 'type-import-expr', line: 2 },
      { spec: '', kind: 'dynamic-nonliteral', line: 3 },
      { spec: '../workers/w.worker.ts', kind: 'worker', line: 4 },
      { spec: './asset.png', kind: 'url', line: 5 },
      { spec: './g/*.ts', kind: 'glob', line: 6 },
      { spec: './r.d.ts', kind: 'reference', line: 7 },
    ]);
  });

  test('imports mentioned in comments are ignored', () => {
    expect(extractEdges('src/ui/x.ts', "// import { a } from './a';\n/* import './b'; */")).toEqual([]);
  });

  test('css and html edges', () => {
    expect(extractEdges('src/ui/s.css', "@import './base.css';\n.a { background: url('./i.png'); }")).toEqual([
      { spec: './base.css', kind: 'css', line: 1 },
      { spec: './i.png', kind: 'css', line: 2 },
    ]);
    expect(extractEdges('index.html', '<script type="module" src="/src/main.ts"></script>')).toEqual([
      { spec: '/src/main.ts', kind: 'html', line: 1 },
    ]);
  });
});

describe('resolveTarget', () => {
  test('relative specifiers resolve to repo paths with .ts appended', () => {
    expect(resolveTarget('src/gen/x.ts', '../world/store/api', 'type')).toEqual({ kind: 'repo', path: 'src/world/store/api.ts' });
    expect(resolveTarget('src/ui/x.ts', './styles.css', 'value')).toEqual({ kind: 'repo', path: 'src/ui/styles.css' });
    expect(resolveTarget('src/main.ts', '../test/goldens.json', 'value')).toEqual({ kind: 'repo', path: 'test/goldens.json' });
    expect(resolveTarget('src/render/x.ts', './shader.glsl?raw', 'value')).toEqual({ kind: 'repo', path: 'src/render/shader.glsl' });
  });

  test('escapes, urls, absolute paths, builtins and bare names', () => {
    expect(resolveTarget('src/core/a.ts', '../../../outside', 'value')).toEqual({ kind: 'escape' });
    expect(resolveTarget('src/core/a.ts', 'https://esm.sh/three', 'value')).toEqual({ kind: 'url' });
    expect(resolveTarget('src/core/a.ts', '//cdn.example.com/x.js', 'value')).toEqual({ kind: 'url' });
    expect(resolveTarget('src/core/a.ts', '/abs/x', 'value')).toEqual({ kind: 'absolute' });
    expect(resolveTarget('index.html', '/src/main.ts', 'html')).toEqual({ kind: 'repo', path: 'src/main.ts' });
    expect(resolveTarget('test/x.ts', 'node:fs', 'value')).toEqual({ kind: 'builtin' });
    expect(resolveTarget('src/render/x.ts', 'three/addons/x.js', 'value')).toEqual({ kind: 'bare', name: 'three/addons/x.js' });
  });
});

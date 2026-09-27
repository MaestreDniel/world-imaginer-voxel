import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkConfigHygiene, checkResolution, repositoryFiles } from './rules/resolution';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const brief = (v: ReturnType<typeof checkResolution>) => sortViolations(v).map((x) => `${x.file}:${x.line} ${x.rule}`);

test('bad specifiers are reported', () => {
  const root = fixture('resolution/bad');
  expect(brief(checkResolution(root, scanTree(root)))).toEqual([
    'src/core/a.ts:1 escapes-root',
    'src/core/a.ts:2 url-specifier',
    'src/core/a.ts:3 url-specifier',
    'src/core/a.ts:4 absolute-specifier',
    'src/core/a.ts:5 src-bare-not-three',
  ]);
});

test('symlinks cannot escape the repository', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'evil.ts'), 'export const evil = 1;');
  mkdirSync(join(outside, 'three'));
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(root, 'src/core'), { recursive: true });
  mkdirSync(join(root, 'src/render'), { recursive: true });
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(outside, 'evil.ts'), join(root, 'src/core/link.ts'));
  symlinkSync(join(outside, 'three'), join(root, 'node_modules/three'));
  writeFileSync(join(root, 'src/core/uses.ts'), "import { evil } from './link';\nexport const x = evil;");
  writeFileSync(join(root, 'src/render/r.ts'), "import 'three';");
  expect(brief(checkResolution(root, scanTree(root)).filter((v) => v.file !== 'src/core/link.ts'))).toEqual([
    'src/core/uses.ts:1 escapes-root',
    'src/render/r.ts:1 bare-outside-node-modules',
  ]);
});

test('config hygiene: aliases, tsconfig paths, non-registry and extra runtime deps', () => {
  expect(brief(checkConfigHygiene(fixture('hygiene/bad')))).toEqual([
    'package.json:1 non-registry-dep',
    'package.json:1 runtime-deps',
    'tsconfig.json:1 tsconfig-paths',
    'vite.config.ts:1 alias',
  ]);
  expect(checkConfigHygiene(fixture('hygiene/good'))).toEqual([]);
});

test('the repository resolves everything inside itself and keeps its configs clean', () => {
  expect(sortViolations(checkResolution(ROOT, repositoryFiles(ROOT)))).toEqual([]);
  expect(checkConfigHygiene(ROOT)).toEqual([]);
});

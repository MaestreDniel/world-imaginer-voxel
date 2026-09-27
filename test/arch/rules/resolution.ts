import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { blankJs, listFiles, resolveTarget, scanFile, SOURCE_EXTS, type ScannedFile, type Violation } from '../scan';

const CONFIG_FILES = ['vite.config.ts', 'vitest.config.ts'];

export function repositoryFiles(root: string): ScannedFile[] {
  const paths = [
    ...listFiles(root, 'src', SOURCE_EXTS),
    ...listFiles(root, 'test', SOURCE_EXTS, ['test/arch/fixtures', 'test/.cache', 'test/metrics/.out']),
    ...['index.html', ...CONFIG_FILES].filter((p) => existsSync(join(root, p))),
  ];
  return paths.map((p) => scanFile(root, p));
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

export function checkResolution(root: string, files: readonly ScannedFile[]): Violation[] {
  const realRoot = realpathSync(root);
  const nodeModules = join(root, 'node_modules');
  const realNodeModules = existsSync(nodeModules) ? realpathSync(nodeModules) : null;
  const out: Violation[] = [];
  for (const f of files) {
    for (const e of f.edges) {
      if (e.kind === 'dynamic-nonliteral' || e.kind === 'type-import-expr') continue;
      const at = (rule: string, message: string) => out.push({ file: f.path, line: e.line, rule, message });
      const t = resolveTarget(f.path, e.spec, e.kind);
      const inSrc = f.path.startsWith('src/');
      if (t.kind === 'url') { at('url-specifier', `${e.spec} is a URL`); continue; }
      if (t.kind === 'absolute') { at('absolute-specifier', `${e.spec} is an absolute path`); continue; }
      if (t.kind === 'escape') { at('escapes-root', `${e.spec} leaves the repository`); continue; }
      if (t.kind === 'builtin') { if (inSrc) at('src-bare-not-three', `${e.spec} is a Node builtin`); continue; }
      if (t.kind === 'repo') {
        const abs = join(root, t.path);
        if (existsSync(abs) && !inside(realpathSync(abs), realRoot)) at('escapes-root', `${e.spec} resolves outside through a symlink`);
        continue;
      }
      if (inSrc && t.name !== 'three' && !t.name.startsWith('three/')) { at('src-bare-not-three', `src imports ${t.name}`); continue; }
      const dir = join(nodeModules, packageName(t.name));
      if (!existsSync(dir) || realNodeModules === null) { at('bare-unresolved', `${t.name} is not installed`); continue; }
      if (!inside(realpathSync(dir), realNodeModules)) at('bare-outside-node-modules', `${t.name} resolves outside node_modules`);
    }
  }
  return out;
}

const REGISTRY_RANGE = /^[\^~<>=\s\d.x*|-]+$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export function checkConfigHygiene(root: string): Violation[] {
  const out: Violation[] = [];
  const at = (file: string, rule: string, message: string) => out.push({ file, line: 1, rule, message });
  for (const file of CONFIG_FILES) {
    const abs = join(root, file);
    if (existsSync(abs) && /\balias\s*:/.test(blankJs(readFileSync(abs, 'utf8'), { strings: true }))) {
      at(file, 'alias', 'resolve.alias is not allowed');
    }
  }
  for (const file of readdirSync(root).filter((n) => /^tsconfig.*\.json$/.test(n)).sort()) {
    const opts = (JSON.parse(readFileSync(join(root, file), 'utf8')) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
    if ('paths' in opts || 'baseUrl' in opts) at(file, 'tsconfig-paths', 'paths/baseUrl are not allowed');
  }
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (!REGISTRY_RANGE.test(range)) at('package.json', 'non-registry-dep', `${field}.${name} = ${range}`);
      }
    }
    const runtime = Object.keys(pkg.dependencies ?? {});
    if (runtime.length !== 1 || runtime[0] !== 'three') at('package.json', 'runtime-deps', `dependencies must be exactly three (got ${runtime.join(', ')})`);
  }
  return out;
}

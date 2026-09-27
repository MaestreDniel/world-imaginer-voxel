import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export type EdgeKind =
  | 'value' | 'type' | 'worker' | 'url' | 'glob' | 'reference' | 'css' | 'html'
  | 'type-import-expr' | 'dynamic-nonliteral';

export interface Edge { spec: string; kind: EdgeKind; line: number }

export interface ScannedFile {
  path: string;
  layer: string | null;
  raw: string;
  code: string;
  codeKeepStrings: string;
  edges: Edge[];
}

export interface Violation { file: string; line: number; rule: string; message: string }

export const SOURCE_EXTS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.css', '.html', '.glsl', '.vert', '.frag', '.wgsl'] as const;
const JS_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SHADER_EXTS = new Set(['.glsl', '.vert', '.frag', '.wgsl']);
const KNOWN_EXTS = new Set([...SOURCE_EXTS, '.json', '.png', '.svg', '.jpg', '.webp']);

export function blankJs(text: string, opts: { strings: boolean }): string {
  const out = text.split('');
  const n = text.length;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      fill(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      fill(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(n, j + 1);
      if (opts.strings) fill(i + 1, stop - 1);
      i = stop;
    } else {
      i++;
    }
  }
  return out.join('');
}

function blankBlock(text: string, open: string, close: string): string {
  const out = text.split('');
  let i = text.indexOf(open);
  while (i !== -1) {
    const end = text.indexOf(close, i + open.length);
    const stop = end === -1 ? text.length : end + close.length;
    for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
    i = text.indexOf(open, stop);
  }
  return out.join('');
}

export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

export function layerOf(path: string): string | null {
  if (path === 'src/main.ts') return 'main';
  const parts = path.split('/');
  if (parts[0] !== 'src' || parts.length < 3) return null;
  return parts[1]!;
}

const THEN_LIKE = new Set(['then', 'catch', 'finally']);

export function extractEdges(path: string, raw: string): Edge[] {
  const ext = extname(path);
  const edges: Edge[] = [];
  const push = (spec: string, kind: EdgeKind, text: string, index: number) => edges.push({ spec, kind, line: lineAt(text, index) });
  if (ext === '.css') {
    const code = blankBlock(raw, '/*', '*/');
    for (const m of code.matchAll(/@import\s+(['"])([^'"]+)\1/g)) push(m[2]!, 'css', code, m.index);
    for (const m of code.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g)) push(m[2]!, 'css', code, m.index);
    return edges;
  }
  if (ext === '.html') {
    const code = blankBlock(raw, '<!--', '-->');
    for (const m of code.matchAll(/\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/g)) push(m[2]!, 'html', code, m.index);
    return edges;
  }
  if (!JS_EXTS.has(ext)) return edges;
  const code = blankJs(raw, { strings: false });
  for (const m of code.matchAll(/\bimport\s+(type\s+)?(?![('"])[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\2/g)) {
    push(m[3]!, m[1] ? 'type' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) push(m[2]!, 'value', code, m.index);
  for (const m of code.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g)) {
    push(m[3]!, m[1] ? 'type' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)(\s*\.\s*([\w$]+))?/g)) {
    const member = m[4];
    push(m[2]!, member !== undefined && !THEN_LIKE.has(member) ? 'type-import-expr' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*(?!['"`])/g)) push('', 'dynamic-nonliteral', code, m.index);
  const workerUrlStarts = new Set<number>();
  for (const m of code.matchAll(/\bnew\s+(?:Shared)?Worker\s*\(\s*(new\s+URL)\s*\(\s*(['"])([^'"\n]+)\2\s*,\s*import\.meta\.url\s*\)/g)) {
    workerUrlStarts.add(m.index + m[0].indexOf(m[1]!));
    push(m[3]!, 'worker', code, m.index);
  }
  for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    if (!workerUrlStarts.has(m.index)) push(m[2]!, 'url', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\.meta\.glob\s*\(\s*(['"])([^'"\n]+)\1/g)) push(m[2]!, 'glob', code, m.index);
  for (const m of raw.matchAll(/^\s*\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/gm)) push(m[2]!, 'reference', raw, m.index);
  return edges;
}

export function listFiles(root: string, dir: string, exts: readonly string[], excludePrefixes: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const childRel = posix.join(rel, name);
      if (excludePrefixes.some((p) => childRel === p || childRel.startsWith(`${p}/`))) continue;
      if (statSync(join(root, childRel)).isDirectory()) walk(childRel);
      else if (exts.includes(extname(name).toLowerCase())) out.push(childRel);
    }
  };
  walk(dir);
  return out;
}

export function scanFile(root: string, path: string): ScannedFile {
  const raw = readFileSync(join(root, path), 'utf8');
  const ext = extname(path);
  const isJs = JS_EXTS.has(ext);
  const commentsOnly = isJs ? blankJs(raw, { strings: false })
    : ext === '.css' || SHADER_EXTS.has(ext) ? blankBlock(raw, '/*', '*/')
    : ext === '.html' ? blankBlock(raw, '<!--', '-->') : raw;
  return {
    path,
    layer: layerOf(path),
    raw,
    code: isJs ? blankJs(raw, { strings: true }) : commentsOnly,
    codeKeepStrings: commentsOnly,
    edges: extractEdges(path, raw),
  };
}

export function scanTree(root: string): ScannedFile[] {
  const paths = listFiles(root, 'src', SOURCE_EXTS);
  if (existsSync(join(root, 'index.html'))) paths.push('index.html');
  return paths.map((p) => scanFile(root, p));
}

export type Target =
  | { kind: 'repo'; path: string }
  | { kind: 'bare'; name: string }
  | { kind: 'builtin' }
  | { kind: 'url' }
  | { kind: 'absolute' }
  | { kind: 'escape' };

function withExtension(path: string): string {
  return KNOWN_EXTS.has(extname(path).toLowerCase()) ? path : `${path}.ts`;
}

export function resolveTarget(fromPath: string, spec: string, edgeKind: EdgeKind): Target {
  const clean = spec.replace(/[?#].*$/, '');
  if (spec.startsWith('node:') || builtinModules.includes(clean)) return { kind: 'builtin' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('//')) return { kind: 'url' };
  if (spec.startsWith('/')) {
    return edgeKind === 'html' ? { kind: 'repo', path: withExtension(clean.slice(1)) } : { kind: 'absolute' };
  }
  if (spec.startsWith('.')) {
    const joined = posix.normalize(posix.join(posix.dirname(fromPath), clean));
    if (joined === '..' || joined.startsWith('../')) return { kind: 'escape' };
    return { kind: 'repo', path: withExtension(joined) };
  }
  return { kind: 'bare', name: spec };
}

export function sortViolations(v: Violation[]): Violation[] {
  return [...v].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

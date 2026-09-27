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

const REGEX_PUNCT_TRIGGERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_WORD_TRIGGERS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw']);

export function blankJs(text: string, opts: { strings: boolean }): string {
  const out = text.split('');
  const n = text.length;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  const isRegexContext = (i: number): boolean => {
    let k = i - 1;
    while (k >= 0 && /[ \t\r\n]/.test(out[k]!)) k--;
    if (k < 0) return true;
    const ch = out[k]!;
    if (REGEX_PUNCT_TRIGGERS.has(ch)) return true;
    if (!/[A-Za-z0-9_$]/.test(ch)) return false;
    let wStart = k + 1;
    while (wStart > 0 && /[A-Za-z0-9_$]/.test(out[wStart - 1]!)) wStart--;
    return REGEX_WORD_TRIGGERS.has(out.slice(wStart, k + 1).join(''));
  };

  const scanRegex = (start: number): number => {
    let i = start + 1;
    let inClass = false;
    while (i < n) {
      const c = text[i];
      if (c === '\n') return start + 1;
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { inClass = true; i++; continue; }
      if (c === ']') { inClass = false; i++; continue; }
      if (c === '/' && !inClass) {
        i++;
        while (i < n && /[a-zA-Z]/.test(text[i]!)) i++;
        return i;
      }
      i++;
    }
    return start + 1;
  };

  const scanTemplate = (start: number): number => {
    let i = start;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        if (opts.strings) {
          if (text[i] !== '\n') out[i] = ' ';
          if (i + 1 < n && text[i + 1] !== '\n') out[i + 1] = ' ';
        }
        i += 2;
        continue;
      }
      if (c === '`') return i + 1;
      if (c === '$' && text[i + 1] === '{') {
        i = scanCode(i + 2, true);
        continue;
      }
      if (opts.strings && c !== '\n') out[i] = ' ';
      i++;
    }
    return i;
  };

  function scanCode(start: number, untilCloseBrace: boolean): number {
    let i = start;
    let depth = 0;
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
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
        const stop = Math.min(n, j + 1);
        if (opts.strings) fill(i + 1, stop - 1);
        i = stop;
      } else if (c === '`') {
        i = scanTemplate(i + 1);
      } else if (c === '/' && d !== '/' && d !== '*' && isRegexContext(i)) {
        i = scanRegex(i);
      } else if (untilCloseBrace && c === '}' && depth === 0) {
        return i + 1;
      } else if (c === '{') {
        depth++;
        i++;
      } else if (c === '}') {
        depth--;
        i++;
      } else {
        i++;
      }
    }
    return i;
  }

  scanCode(0, false);
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

function precedesTypePosition(code: string, importIndex: number): boolean {
  let k = importIndex - 1;
  while (k >= 0 && /\s/.test(code[k]!)) k--;
  if (k < 0) return false;
  const ch = code[k]!;
  if (/[A-Za-z_$]/.test(ch)) {
    let wStart = k + 1;
    while (wStart > 0 && /[A-Za-z0-9_$]/.test(code[wStart - 1]!)) wStart--;
    const word = code.slice(wStart, k + 1);
    if (word === 'typeof' || word === 'extends') return true;
  }
  if (ch === '=') {
    let s = k - 1;
    while (s >= 0 && !';{}'.includes(code[s]!)) s--;
    const stmt = code.slice(s + 1, k + 1);
    if (/^\s*type\s+[A-Za-z_$][\w$]*\s*(<[^=]*>)?\s*=\s*$/.test(stmt)) return true;
  }
  return false;
}

function scanDynamicImports(code: string, push: (spec: string, kind: EdgeKind, text: string, index: number) => void): void {
  for (const m of code.matchAll(/\bimport\s*\(/g)) {
    const callStart = m.index;
    let i = callStart + m[0].length;
    while (i < code.length && /\s/.test(code[i]!)) i++;
    const qc = code[i];
    if (qc !== "'" && qc !== '"' && qc !== '`') {
      push('', 'dynamic-nonliteral', code, callStart);
      continue;
    }
    let j = i + 1;
    let content = '';
    let closed = false;
    while (j < code.length) {
      const cj = code[j]!;
      if (cj === '\\') { content += cj + (code[j + 1] ?? ''); j += 2; continue; }
      if (cj === qc) { closed = true; j++; break; }
      if (cj === '\n' && qc !== '`') break;
      content += cj;
      j++;
    }
    let k = j;
    while (k < code.length && /\s/.test(code[k]!)) k++;
    const interpolated = qc === '`' && content.includes('${');
    if (closed && !interpolated && (code[k] === ')' || code[k] === ',')) {
      if (code[k] === ')') {
        const rest = code.slice(k + 1, k + 81);
        const memberMatch = /^\s*\.\s*([\w$]+)/.exec(rest);
        const member = memberMatch?.[1];
        const kind: EdgeKind = member !== undefined
          ? (THEN_LIKE.has(member) ? 'value' : 'type-import-expr')
          : (precedesTypePosition(code, callStart) ? 'type-import-expr' : 'value');
        push(content, kind, code, callStart);
      } else {
        push(content, 'value', code, callStart);
      }
      continue;
    }
    push('', 'dynamic-nonliteral', code, callStart);
  }
}

export function extractEdges(path: string, raw: string): Edge[] {
  const ext = extname(path).toLowerCase();
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
  // `code` only blanks comments, so import-like text sitting inside a string or template
  // literal (outside any `${}` interpolation) still reads as a match. `inert` additionally
  // blanks string/template contents, so comparing the two tells real code from string text:
  // a position that differs between them was blanked only because it lives inside a string.
  const inert = blankJs(raw, { strings: true });
  const isReal = (index: number) => code[index] === inert[index];
  for (const m of code.matchAll(/\bimport\s+(type\s+)?(?![('"])[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\2/g)) {
    if (isReal(m.index)) push(m[3]!, m[1] ? 'type' : 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) {
    if (isReal(m.index)) push(m[2]!, 'value', code, m.index);
  }
  for (const m of code.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g)) {
    if (isReal(m.index)) push(m[3]!, m[1] ? 'type' : 'value', code, m.index);
  }
  scanDynamicImports(code, (spec, kind, text, index) => { if (isReal(index)) push(spec, kind, text, index); });
  const workerUrlStarts = new Set<number>();
  for (const m of code.matchAll(/\bnew\s+(?:Shared)?Worker\s*\(\s*(new\s+URL)\s*\(\s*(['"])([^'"\n]+)\2\s*,\s*import\.meta\.url\s*\)/g)) {
    if (!isReal(m.index)) continue;
    workerUrlStarts.add(m.index + m[0].indexOf(m[1]!));
    push(m[3]!, 'worker', code, m.index);
  }
  for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    if (!workerUrlStarts.has(m.index) && isReal(m.index)) push(m[2]!, 'url', code, m.index);
  }
  for (const m of code.matchAll(/\bimport\.meta\.glob\s*\(\s*(['"])([^'"\n]+)\1/g)) {
    if (isReal(m.index)) push(m[2]!, 'glob', code, m.index);
  }
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
  const ext = extname(path).toLowerCase();
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

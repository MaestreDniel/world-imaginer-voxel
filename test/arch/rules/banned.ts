import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { lineAt, type ScannedFile, type Violation } from '../scan';

const JS_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SHADER_EXTS = new Set(['.glsl', '.vert', '.frag', '.wgsl']);
const ND_LAYERS = new Set(['core', 'world', 'gen']);
const PURE_LAYERS = new Set(['core', 'world', 'gen', 'textures', 'audio', 'light', 'mesh', 'sim', 'persist', 'metrics', 'daynight']);
const MATH_ALLOWED = new Set(['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'imul', 'clz32', 'sqrt',
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
/**
 * Files outside core/ and gen/ that follow the core determinism rules: the golden digests (SP1 spec §1.8), the
 * SP2b metrics shared by the tests, the workers and the UI (SP2b spec §5.4), the SP3a region core (SP3a spec §6.1) and
 * the SP3a, SP3b and SP3c golden digests (SP3a spec §6.4, SP3b spec §9, SP3c spec §7). Exported for the master-spec
 * check (`masterSpec.test.ts`: master "Banned APIs" lists exactly these).
 */
export const DET_FILES: ReadonlySet<string> = new Set(['metrics/sp1Goldens.ts', 'metrics/sp1Fixtures.ts', 'metrics/sp2aGoldens.ts', 'metrics/biomeShares.ts', 'metrics/liveness.ts', 'metrics/splineStats.ts', 'metrics/crossSection.ts',
  'metrics/region.ts', 'metrics/sp3aGoldens.ts', 'metrics/sp3bGoldens.ts', 'metrics/sp3cGoldens.ts']);
/**
 * Directories outside core/ and gen/ that follow the core determinism rules: the block registry, whose ids and tables
 * are hashed into goldens (SP3a spec §2.5). The rest of world/ (the store) keeps the ND bans only.
 */
const DET_DIRS = ['world/blocks/'];
/** Modules whose hot loops must not read imported bindings (vitest turns them into getters; SP1 spec §1.8, SP2a spec §8). */
const HOT_PREFIXES = ['core/noise/', 'core/spline/', 'metrics/', 'gen/', ...DET_DIRS];
/** Matches the member name alone, so `.normalize.call(…)` and `.localeCompare.bind(…)` are caught too (SP1 review minor). */
const ENGINE_DEPENDENT = /\bIntl\b|\.\s*(?:localeCompare|toLocale\w*|normalize)\b|\bTextEncoder\b|\bTextDecoder\b/g;
const IMPORT_STMT = /\bimport\s+(type\s+)?([\w$*{},\s]+?)\s+from\s*(['"])[^'"\n]+\3\s*;?/g;
const THREE_AUDIO = new Set(['Audio', 'AudioListener', 'PositionalAudio', 'AudioLoader', 'AudioAnalyser']);
const AUDIO_EXTS = new Set(['.ogg', '.oga', '.mp3', '.wav', '.flac', '.m4a', '.aac', '.opus', '.weba']);

const NUM = String.raw`(?:0x[\da-f_]+n?|0b[01_]+n?|0o[0-7_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[-+]?\d+)?n?|\.\d[\d_]*(?:e[-+]?\d+)?)`;
const NUMERIC_EXPR = new RegExp(String.raw`^[-+(]*${NUM}\)*(?:[-+*/%][-+(]*${NUM}\)*)*$`, 'i');

export function isNumericExpr(init: string): boolean {
  const s = init.trim().replace(/\s+as\s+const\s*$/, '').replace(/\s+satisfies\s+[\w$.<>[\]]+\s*$/, '').replace(/\s+/g, '');
  return NUMERIC_EXPR.test(s);
}

function continuesAcrossNewline(code: string, from: number, upTo: number): boolean {
  const soFar = code.slice(from, upTo).trim();
  if (/[=,]$/.test(soFar)) return true;
  let j = upTo + 1;
  while (j < code.length && /\s/.test(code[j]!)) j++;
  return j < code.length && /[+\-*/%.?:=]/.test(code[j]!);
}

function readStatement(code: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ';') break;
    else if (depth === 0 && c === '\n') {
      if (continuesAcrossNewline(code, start, i)) continue;
      break;
    }
  }
  return code.slice(start, i);
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(from, i)); from = i + 1; }
  }
  parts.push(s.slice(from));
  return parts;
}

function numericExportViolations(f: ScannedFile, srcRel: string): Violation[] {
  const out: Violation[] = [];
  const dataAllowed = /^gen\/(?:.*\/)?defaults\.ts$/.test(srcRel) || srcRel.startsWith('gen/structures/templates/');
  const at = (index: number, rule: string, message: string) => out.push({ file: f.path, line: lineAt(f.code, index), rule, message });
  for (const m of f.code.matchAll(/\bexport\s+(?:const|let|var)\s+/g)) {
    for (const decl of splitTopLevel(readStatement(f.code, m.index + m[0].length))) {
      const d = /^\s*([\w$]+)\s*(?::[^=]+)?=\s*([\s\S]*)$/.exec(decl);
      if (!d) continue;
      const init = d[2]!.trim();
      if (isNumericExpr(init)) at(m.index, 'numeric-export', `exported numeric constant ${d[1]} (use ParamSchema or core/constants)`);
      else if (!dataAllowed && /^[{[]/.test(init) && /(?<![\w$])\d/.test(init)) at(m.index, 'numeric-data-export', `exported data with numbers ${d[1]} outside defaults.ts/templates`);
    }
  }
  for (const m of f.code.matchAll(/\bexport\s+default\s+([^;\n]+)/g)) {
    if (isNumericExpr(m[1]!)) at(m.index, 'numeric-export', 'exported default numeric constant');
  }
  const numericBindings = new Set<string>();
  for (const m of f.code.matchAll(/(?:^|\n)[ \t]*(?:const|let|var)\s+/g)) {
    for (const decl of splitTopLevel(readStatement(f.code, m.index + m[0].length))) {
      const d = /^\s*([\w$]+)\s*(?::[^=]+)?=\s*([\s\S]*)$/.exec(decl);
      if (!d) continue;
      if (isNumericExpr(d[2]!.trim())) numericBindings.add(d[1]!);
    }
  }
  for (const m of f.code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const item of m[1]!.split(',')) {
      const local = item.trim().split(/\s+as\s+/)[0]!;
      if (numericBindings.has(local)) at(m.index, 'numeric-export', `exported numeric constant ${local}`);
    }
  }
  return out;
}

/** Value bindings of an import clause (`d, { a, b as c, type T }` → a, c, d); inline `type` specifiers are skipped. */
export function importClauseBindings(clause: string): { names: string[]; namespace: boolean } {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const item of braces[1]!.split(',')) {
      const t = item.trim();
      if (t === '' || /^type\s/.test(t)) continue;
      const parts = t.split(/\s+as\s+/);
      names.push((parts[1] ?? parts[0]!).trim());
    }
  }
  const namespace = /\*\s*as\s+[\w$]+/.test(clause);
  const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '');
  for (const part of head.split(',')) {
    const t = part.trim();
    if (/^[\w$]+$/.test(t)) names.push(t);
  }
  return { names, namespace };
}

function hotImportViolations(f: ScannedFile): Violation[] {
  const out: Violation[] = [];
  const spans: Array<[number, number]> = [];
  const names: string[] = [];
  for (const m of f.codeKeepStrings.matchAll(IMPORT_STMT)) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[1]) continue;
    const b = importClauseBindings(m[2]!);
    if (b.namespace) {
      out.push({ file: f.path, line: lineAt(f.codeKeepStrings, m.index), rule: 'hot-import-namespace', message: 'namespace import in a hot module (import the bindings and alias them)' });
    }
    names.push(...b.names);
  }
  const lines = f.code.split('\n');
  for (const name of names) {
    const esc = name.replace(/\$/g, '\\$');
    const alias = new RegExp(String.raw`^const\s+[\w$]+\s*=\s*${esc}\s*;?\s*$`);
    for (const m of f.code.matchAll(new RegExp(String.raw`(?<![\w$.])${esc}(?![\w$])`, 'g'))) {
      const i = m.index;
      if (spans.some(([a, b]) => i >= a && i < b)) continue;
      const line = lineAt(f.code, i);
      if (alias.test(lines[line - 1]!)) continue;
      const before = f.code.slice(0, i).trimEnd();
      const after = f.code.slice(i + name.length).trimStart();
      if (after.startsWith(':') && (before.endsWith('{') || before.endsWith(','))) continue;
      out.push({ file: f.path, line, rule: 'hot-import-reference', message: `imported binding ${name} used outside a top-level const alias (vitest turns it into a getter)` });
    }
  }
  return out;
}

export function checkBanned(files: readonly ScannedFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.path.startsWith('src/')) continue;
    const srcRel = f.path.slice('src/'.length);
    const layer = f.layer ?? '';
    const ext = extname(f.path);
    const found = new Map<string, Violation>();
    const at = (text: string, index: number, rule: string, message: string) => {
      const line = lineAt(text, index);
      const key = `${rule}:${line}`;
      if (!found.has(key)) found.set(key, { file: f.path, line, rule, message });
    };
    if (SHADER_EXTS.has(ext)) { at(f.raw, 0, 'raw-shader-file', 'GLSL lives in render/materials/*.glsl.ts template literals'); }
    for (const e of f.edges) {
      if (e.spec.includes('?raw')) found.set(`raw-import:${e.line}`, { file: f.path, line: e.line, rule: 'raw-import', message: `${e.spec}: ?raw imports are not allowed` });
    }
    if (JS_EXTS.has(ext)) {
      const { code, codeKeepStrings } = f;
      const detFile = DET_FILES.has(srcRel) || DET_DIRS.some((p) => srcRel.startsWith(p));
      if (ND_LAYERS.has(layer) || detFile) {
        for (const m of code.matchAll(/\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|\bconsole\s*\./g)) at(code, m.index, 'nondeterministic', `${m[0]} in ${layer}/`);
      }
      if (layer === 'gen' || layer === 'core' || detFile) {
        for (const m of code.matchAll(ENGINE_DEPENDENT)) at(code, m.index, 'engine-dependent-api', `${m[0].trim()} in ${layer}/ (engine-dependent; SP1 spec §1.8)`);
      }
      if (HOT_PREFIXES.some((p) => srcRel.startsWith(p))) {
        for (const v of hotImportViolations(f)) found.set(`${v.rule}:${v.line}`, v);
      }
      if (layer === 'gen' || layer === 'core' || detFile) {
        for (const m of code.matchAll(/\bMath\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
          if (!MATH_ALLOWED.has(m[1]!) && m[1] !== 'random') at(code, m.index, 'math-member', `Math.${m[1]} (use core/detMath)`);
        }
        for (const m of code.matchAll(/\bMath\s*\[/g)) at(code, m.index, 'math-computed', 'computed Math access');
        for (const m of code.matchAll(/\bMath\b(?!\s*[.[])/g)) at(code, m.index, 'math-as-value', 'Math used as a value');
        for (const m of code.matchAll(/\*\*/g)) at(code, m.index, 'math-pow-operator', '** operator (use detMath)');
      }
      if (layer === 'gen') for (const v of numericExportViolations(f, srcRel)) found.set(`${v.rule}:${v.line}`, v);
      if (PURE_LAYERS.has(layer)) {
        for (const m of code.matchAll(/(?<![\w$.])(document|window|indexedDB|localStorage|sessionStorage)\b/g)) {
          if (!(srcRel === 'persist/idb.ts' && m[1] === 'indexedDB')) at(code, m.index, 'dom-global', `${m[1]} in pure layer ${layer}/`);
        }
      }
      if (layer === 'core') {
        for (const m of code.matchAll(/(?<![\w$.])(self|postMessage|importScripts|onmessage)\b|\bnew\s+(?:Shared)?Worker\b/g)) at(code, m.index, 'worker-api', `${m[0]} in core/`);
      }
      if (!srcRel.startsWith('render/materials/')) {
        for (const m of code.matchAll(/\b(ShaderMaterial|RawShaderMaterial|onBeforeCompile|ShaderChunk|ShaderLib|glslVersion)\b/g)) at(code, m.index, 'glsl-outside-materials', `${m[1]} outside render/materials/`);
        for (const m of codeKeepStrings.matchAll(/#version\b|\bgl_Position\b|\bgl_FragColor\b|\bgl_FragCoord\b|\bprecision\s+(?:highp|mediump|lowp)\b/g)) at(codeKeepStrings, m.index, 'glsl-outside-materials', `GLSL (${m[0]}) outside render/materials/`);
      }
      if (layer !== 'sound') {
        for (const m of code.matchAll(/\b(AudioContext|webkitAudioContext|OfflineAudioContext|AudioWorklet|AudioWorkletNode|AudioWorkletProcessor|registerProcessor|decodeAudioData)\b/g)) at(code, m.index, 'webaudio-outside-sound', `${m[1]} outside sound/`);
      }
      const threeAudioMessage = 'three audio classes are not used (audio lives in sound/)';
      for (const m of codeKeepStrings.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]three(?:\/[^'"]*)?['"]/g)) {
        const names = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!);
        if (names.some((n) => THREE_AUDIO.has(n))) at(codeKeepStrings, m.index, 'three-audio', threeAudioMessage);
      }
      for (const m of codeKeepStrings.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]three(?:\/[^'"]*)?['"]/g)) {
        const names = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!);
        if (names.some((n) => THREE_AUDIO.has(n))) at(codeKeepStrings, m.index, 'three-audio', threeAudioMessage);
      }
      const threeBindings: string[] = [];
      for (const m of codeKeepStrings.matchAll(/\bimport\s+(?:type\s+)?(\*\s*as\s+[\w$]+|[\w$]+)\s*from\s*['"]three(?:\/[^'"]*)?['"]/g)) {
        const raw = m[1]!;
        threeBindings.push(raw.startsWith('*') ? raw.replace(/^\*\s*as\s+/, '') : raw);
      }
      for (const binding of threeBindings) {
        const re = new RegExp(String.raw`\b${binding}\s*\.\s*(Audio|AudioListener|PositionalAudio|AudioLoader|AudioAnalyser)\b`, 'g');
        for (const m of code.matchAll(re)) at(code, m.index, 'three-audio', threeAudioMessage);
      }
    }
    out.push(...found.values());
  }
  return out;
}

function walkFiles(root: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(root, rel))) {
    const child = rel === '' ? name : posix.join(rel, name);
    if (['node_modules', 'dist', '.git'].includes(name) || child === 'test/.cache') continue;
    const st = lstatSync(join(root, child));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(root, child, out);
    else out.push(child);
  }
}

export function listAudioFiles(root: string): string[] {
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter((f) => f.length > 0);
  } catch {
    files = [];
    walkFiles(root, '', files);
  }
  return files.filter((f) => AUDIO_EXTS.has(extname(f).toLowerCase())).sort();
}

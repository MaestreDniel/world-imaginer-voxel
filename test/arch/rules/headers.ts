import { extname } from 'node:path';
import { lineAt, type ScannedFile, type Violation } from '../scan';

export const ISOLATION_HEADERS_EXPECTED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

interface VercelJson { headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }> }

export function vercelHeaders(json: unknown): Record<string, string> | null {
  const entry = (json as VercelJson).headers?.find((h) => h.source === '/(.*)');
  if (!entry) return null;
  return Object.fromEntries(entry.headers.map((h) => [h.key, h.value]));
}

const OTHER_ORIGIN = String.raw`(?:https?:)?\/\/`;
const PATTERNS: Record<string, RegExp[]> = {
  '.html': [
    new RegExp(String.raw`<(?:script|img)\b[^>]*\bsrc\s*=\s*['"]${OTHER_ORIGIN}`, 'gi'),
    new RegExp(String.raw`<link\b[^>]*\bhref\s*=\s*['"]${OTHER_ORIGIN}`, 'gi'),
  ],
  '.css': [
    new RegExp(String.raw`@import\s+(?:url\()?\s*['"]?${OTHER_ORIGIN}`, 'gi'),
    new RegExp(String.raw`url\(\s*['"]?${OTHER_ORIGIN}`, 'gi'),
  ],
  '.ts': [new RegExp(String.raw`\b(?:fetch|import|importScripts|new\s+URL|new\s+Worker)\s*\(\s*['"\x60]${OTHER_ORIGIN}`, 'g')],
};

export function findCrossOriginSubresources(files: readonly Pick<ScannedFile, 'path' | 'raw' | 'codeKeepStrings'>[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    const patterns = PATTERNS[extname(f.path)];
    if (!patterns) continue;
    const lines = new Set<number>();
    for (const re of patterns) for (const m of f.codeKeepStrings.matchAll(re)) lines.add(lineAt(f.codeKeepStrings, m.index));
    for (const line of [...lines].sort((a, b) => a - b)) {
      out.push({ file: f.path, line, rule: 'cross-origin-subresource', message: 'COEP require-corp forbids loading from other origins' });
    }
  }
  return out;
}

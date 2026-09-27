import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import viteConfig from '../../vite.config';
import { findCrossOriginSubresources, ISOLATION_HEADERS_EXPECTED, vercelHeaders } from './rules/headers';
import { ROOT, scanTree } from './scan';

describe('isolation headers', () => {
  test('vite server and preview send exactly COOP/COEP on 5183 with strictPort, ES workers', () => {
    expect(viteConfig.server?.headers).toEqual(ISOLATION_HEADERS_EXPECTED);
    expect(viteConfig.preview?.headers).toEqual(ISOLATION_HEADERS_EXPECTED);
    expect(viteConfig.server?.port).toBe(5183);
    expect(viteConfig.preview?.port).toBe(5183);
    expect(viteConfig.server?.strictPort).toBe(true);
    expect(viteConfig.preview?.strictPort).toBe(true);
    expect(viteConfig.worker?.format).toBe('es');
  });

  test('vercel.json sends the same headers for every route', () => {
    const json: unknown = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    expect(vercelHeaders(json)).toEqual(ISOLATION_HEADERS_EXPECTED);
  });
});

describe('cross-origin subresources', () => {
  const file = (path: string, text: string) => ({ path, raw: text, codeKeepStrings: text });

  test('script/link/img/css/fetch/import/worker URLs to other origins are reported', () => {
    const found = findCrossOriginSubresources([
      file('index.html', '<link href="https://fonts.googleapis.com/css2">\n<script src="//cdn.x/y.js"></script>'),
      file('src/ui/s.css', "@import 'https://x/y.css';\n.a { background: url(//x/i.png); }"),
      file('src/ui/a.ts', "fetch('https://api.x/y');\nnew Worker('https://x/w.js');"),
    ]).map((v) => `${v.file}:${v.line}`);
    expect(found).toEqual(['index.html:1', 'index.html:2', 'src/ui/s.css:1', 'src/ui/s.css:2', 'src/ui/a.ts:1', 'src/ui/a.ts:2']);
  });

  test('plain text mentioning a URL is allowed', () => {
    expect(findCrossOriginSubresources([file('src/engine/r.ts', "const hint = 'open via http://localhost:<port> or HTTPS';")])).toEqual([]);
  });

  test('the repository loads nothing from other origins', () => {
    expect(findCrossOriginSubresources(scanTree(ROOT))).toEqual([]);
  });
});

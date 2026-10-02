/**
 * Bundles the pure task handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2), so
 * integration tests run the handler as a real worker. Each test file builds into its own directory under
 * test/.cache/ because vitest runs test files in parallel.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ENTRY = fileURLToPath(new URL('../../src/workers/taskHandler.ts', import.meta.url));

/**
 * Builds into test/.cache/<dir>/ and returns the path of the worker script. With `stamp`, each reply also carries
 * `handledAt`: the time `handle` returned, in ms on `process.hrtime` (the monotonic clock every thread of the
 * process shares, so the main thread compares it with its own reading). A test can then time the handler itself,
 * without the delivery of the reply to its own event loop.
 */
export async function buildNodeTaskWorker(dir: string, opts: { readonly stamp?: boolean } = {}): Promise<string> {
  const out = fileURLToPath(new URL(`../.cache/${dir}/`, import.meta.url));
  mkdirSync(out, { recursive: true });
  await build({
    configFile: false, logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: ENTRY, formats: ['es'], fileName: () => 'taskHandler.mjs' } },
  });
  writeFileSync(`${out}node-worker.mjs`, [
    "import { parentPort } from 'node:worker_threads';",
    "import { createTaskHandler } from './taskHandler.mjs';",
    'const h = createTaskHandler();',
    opts.stamp === true
      ? "parentPort.on('message', (m) => { const r = h.handle(m); const handledAt = Number(process.hrtime.bigint()) / 1e6; parentPort.postMessage({ ...r.msg, handledAt }, r.transfer); });"
      : "parentPort.on('message', (m) => { const r = h.handle(m); parentPort.postMessage(r.msg, r.transfer); });",
  ].join('\n'));
  return `${out}node-worker.mjs`;
}

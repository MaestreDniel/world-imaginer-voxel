/**
 * Bundles a pure task handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2, SP3a §6.1), so
 * integration tests run the handler as a real worker. The default entry is `src/workers/taskHandler.ts`; harness
 * entries (`test/harness/fuzzWorker.ts`, `regionWorker.ts`) follow the same contract: the module exports
 * `createTaskHandler()`, whose `handle(message)` returns `{msg, transfer}`, and never imports `node:` modules
 * (the wrapper owns `parentPort`). Each test file builds into its own directory under test/.cache/ because
 * vitest runs test files in parallel.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/** The default entry, relative to the repository root. */
const DEFAULT_ENTRY = 'src/workers/taskHandler.ts';

export interface NodeWorkerOptions {
  /** The module to bundle, relative to the repository root (default `src/workers/taskHandler.ts`). */
  readonly entry?: string;
  readonly stamp?: boolean;
}

/**
 * Builds into test/.cache/<dir>/ and returns the path of the worker script. With `stamp`, each reply also carries
 * `handledAt`: the time `handle` returned, in ms on `process.hrtime` (the monotonic clock every thread of the
 * process shares, so the main thread compares it with its own reading). A test can then time the handler itself,
 * without the delivery of the reply to its own event loop.
 */
export async function buildNodeTaskWorker(dir: string, opts: NodeWorkerOptions = {}): Promise<string> {
  const out = fileURLToPath(new URL(`../.cache/${dir}/`, import.meta.url));
  const entry = fileURLToPath(new URL(`../../${opts.entry ?? DEFAULT_ENTRY}`, import.meta.url));
  if (!existsSync(entry)) throw new Error(`buildNodeTaskWorker: no entry ${opts.entry ?? DEFAULT_ENTRY}`);
  const bundle = `${basename(entry).replace(/\.ts$/, '')}.mjs`;
  mkdirSync(out, { recursive: true });
  await build({
    configFile: false, logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry, formats: ['es'], fileName: () => bundle } },
  });
  writeFileSync(`${out}node-worker.mjs`, [
    "import { parentPort } from 'node:worker_threads';",
    `import { createTaskHandler } from './${bundle}';`,
    'const h = createTaskHandler();',
    opts.stamp === true
      ? "parentPort.on('message', (m) => { const r = h.handle(m); const handledAt = Number(process.hrtime.bigint()) / 1e6; parentPort.postMessage({ ...r.msg, handledAt }, r.transfer); });"
      : "parentPort.on('message', (m) => { const r = h.handle(m); parentPort.postMessage(r.msg, r.transfer); });",
  ].join('\n'));
  return `${out}node-worker.mjs`;
}

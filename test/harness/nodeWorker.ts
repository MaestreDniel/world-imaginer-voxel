/**
 * Bundles a pure task handler with Vite and wraps it for Node's worker_threads (SP2a spec §7.2, SP3a §6.1), so
 * integration tests run the handler as a real worker. The default entry is `src/workers/taskHandler.ts`; harness
 * entries (`test/harness/fuzzWorker.ts`, `regionWorker.ts`) follow the same contract: the module exports
 * `createTaskHandler()`, whose `handle(message)` returns `{msg, transfer}`, and never imports `node:` modules
 * (the wrapper owns `parentPort`). Each test file builds into its own directory under test/.cache/ because
 * vitest runs test files in parallel.
 * SP4b (spec §2.5): after each reply the wrapper drains the handler's limbo and retries every `LIMBO_RETRY_MS` while
 * entries are left, as `task.worker.ts` does through `drainAfterReply`, mirrored in plain JS (the script cannot import
 * the helper). It calls `h.drain?.()`, so the harness entries, which have no `drain`, keep working.
 * SP5a (spec §6.3): `factory` names the entry's handler factory (default `createTaskHandler`) and `retryMs` the retry
 * interval (default `LIMBO_RETRY_MS`), so the sim's own entry runs as `sim.worker.ts` wires it:
 * `{ entry: 'src/workers/simHandler.ts', factory: 'createSimHandler', retryMs: SIM_DRAIN_MS }`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { LIMBO_RETRY_MS } from '../../src/workers/taskHandler';

/**
 * Posts one message to `w` and waits for its single reply (the one shared helper of every worker-thread test, SP3b
 * spec §7). Rejects with the worker's error when it throws, or when it exits before replying; every listener it adds
 * is removed when it settles. One outstanding `ask` per worker: concurrent asks on the same worker would race for
 * its replies.
 */
export function ask<R = Record<string, unknown>>(w: Worker, msg: unknown): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const off = () => { w.off('error', onError); w.off('exit', onExit); w.off('message', onMessage); };
    const onError = (e: Error) => { off(); reject(e); };
    const onExit = (code: number) => { off(); reject(new Error(`worker exited (${code}) before replying`)); };
    const onMessage = (r: R) => { off(); resolve(r); };
    w.on('error', onError);
    w.on('exit', onExit);
    w.on('message', onMessage);
    w.postMessage(msg);
  });
}

/** The default entry, relative to the repository root. */
const DEFAULT_ENTRY = 'src/workers/taskHandler.ts';

export interface NodeWorkerOptions {
  /** The module to bundle, relative to the repository root (default `src/workers/taskHandler.ts`). */
  readonly entry?: string;
  /** The entry's exported handler factory, called once with no arguments (default `createTaskHandler`). */
  readonly factory?: string;
  /** The limbo retry interval in ms while entries are left (default `LIMBO_RETRY_MS`). */
  readonly retryMs?: number;
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
  const factory = opts.factory ?? 'createTaskHandler';
  if (!/^[A-Za-z_$][\w$]*$/.test(factory)) throw new Error(`buildNodeTaskWorker: factory '${factory}' is not an identifier`);
  const retryMs = opts.retryMs ?? LIMBO_RETRY_MS;
  if (!Number.isInteger(retryMs) || retryMs < 1) throw new RangeError(`buildNodeTaskWorker: retryMs ${retryMs} (an integer ≥ 1)`);
  const bundle = `${basename(entry).replace(/\.ts$/, '')}.mjs`;
  mkdirSync(out, { recursive: true });
  await build({
    configFile: false, logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry, formats: ['es'], fileName: () => bundle } },
  });
  writeFileSync(`${out}node-worker.mjs`, [
    "import { parentPort } from 'node:worker_threads';",
    `import { ${factory} } from './${bundle}';`,
    `const h = ${factory}();`,
    // drainAfterReply (src/workers/taskHandler.ts): drain now, then every retryMs while entries are left, one timer at a time.
    'let retrying = false;',
    `const retry = () => { if ((h.drain?.() ?? 0) > 0) setTimeout(retry, ${retryMs}); else retrying = false; };`,
    `const drainAfterReply = () => { if ((h.drain?.() ?? 0) === 0 || retrying) return; retrying = true; setTimeout(retry, ${retryMs}); };`,
    opts.stamp === true
      ? "parentPort.on('message', (m) => { const r = h.handle(m); const handledAt = Number(process.hrtime.bigint()) / 1e6; parentPort.postMessage({ ...r.msg, handledAt }, r.transfer); drainAfterReply(); });"
      : "parentPort.on('message', (m) => { const r = h.handle(m); parentPort.postMessage(r.msg, r.transfer); drainAfterReply(); });",
  ].join('\n'));
  return `${out}node-worker.mjs`;
}

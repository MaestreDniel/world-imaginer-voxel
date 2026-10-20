/**
 * The browser tools' process and DevTools-protocol helpers (SP4a ruling P4), moved out of uiSmoke.ts so that
 * measureChrome.ts (and SP4a's panoramas.ts) drive Chrome the same way: our own `npm run build`, our own
 * `vite preview` on a free port (never the dev server's 5183), our own Chrome with a temporary profile, and CDP over
 * Node's global WebSocket. Nothing is added to the dependencies; mapLatency.ts keeps its own copy (SP4a spec §8.3).
 *
 * Each tool is its own process, so the module-level `started` registry holds exactly what that tool started, and
 * `stopStarted()` stops exactly those, never another process.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_PORT = 5183;
export const CHROME = '/usr/bin/google-chrome';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every child this tool started, so the cleanup stops exactly those. */
const started: ChildProcess[] = [];

export function start(cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  const c = spawn(cmd, args, opts);
  c.on('error', (e) => console.error(`${cmd}: ${e.message}`));
  started.push(c);
  return c;
}

export const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;

/** SIGTERM, then SIGKILL after 5 s; only ever called on a child this tool started. */
export async function stopChild(c: ChildProcess): Promise<void> {
  if (!running(c)) return;
  const exited = new Promise<void>((r) => c.once('exit', () => r()));
  c.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return;
  c.kill('SIGKILL');
  await exited;
}

/** Stops every child in the registry, in start order. */
export async function stopStarted(): Promise<void> {
  for (const c of started) await stopChild(c);
}

export async function npmBuild(): Promise<void> {
  const c = start('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  const code = await new Promise<number | null>((r) => c.once('exit', (n) => r(n)));
  if (code !== 0) throw new Error(`npm run build exited with ${code}`);
}

/** A free TCP port on 127.0.0.1 (bind port 0, read it, release it), never the dev server's 5183. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address();
        const p = typeof a === 'object' && a !== null ? a.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port !== 0 && port !== DEV_PORT) return port;
  }
}

/** Our own `vite preview` on `port`: ready when it prints its URL; an exit first (for example a taken port) fails. */
export async function startPreview(port: number): Promise<{ readonly proc: ChildProcess; readonly url: string }> {
  const url = `http://127.0.0.1:${port}/`;
  const proc = start(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vite preview did not print ${url} within 30 s:\n${out}`)), 30000);
    const seen = () => {
      if (out.replace(/\x1b\[[0-9;]*m/g, '').includes(url)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); seen(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`vite preview exited (${code ?? signal}) before it was ready:\n${out}`));
    });
  });
  return { proc, url };
}

/** How a tool launches its Chrome: headless or headful, its own profile, extra flags and extra environment. */
export interface ChromeLaunch {
  readonly headless: boolean;
  readonly profileDir: string;
  readonly args: readonly string[];
  /** Added over `process.env` (for example the PRIME offload variables, ruling P6). */
  readonly env: Readonly<Record<string, string>>;
}

export interface ChromeHandle {
  readonly proc: ChildProcess;
  /** The DevTools HTTP port (`/json/version`, `/json/list`). */
  readonly port: number;
  /** The browser target's WebSocket URL. */
  readonly wsUrl: string;
}

/** Our own Chrome; it binds a free DevTools port and writes it into the profile's DevToolsActivePort. */
export async function startChrome(o: ChromeLaunch): Promise<ChromeHandle> {
  const proc = start(CHROME, [
    `--user-data-dir=${o.profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...(o.headless ? ['--headless=new'] : []), ...o.args, 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, ...o.env } });
  const file = join(o.profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (!running(proc)) throw new Error('Chrome exited during start-up');
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split('\n');
      if (port !== undefined && port !== '' && path !== undefined && path !== '') return { proc, port: Number(port), wsUrl: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  throw new Error('Chrome did not open its DevTools port within 15 s');
}

/** A page log entry the tools do not count: the favicon.ico 404 (index.html declares no icon). */
export function ignoredLog(text: string, url: string | undefined): boolean {
  return url !== undefined && /\/favicon\.ico(\?|$)/.test(url) && text.includes('404');
}

export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(method: string, fn: (params: Record<string, unknown>) => void): void;
  close(): void;
}

export async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Array<(p: Record<string, unknown>) => void>>();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result ?? {});
    } else if (m.method !== undefined) for (const fn of listeners.get(m.method) ?? []) fn(m.params ?? {});
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    on(method, fn) { listeners.set(method, [...(listeners.get(method) ?? []), fn]); },
    close() { ws.close(); },
  };
}

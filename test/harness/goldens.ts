import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR_VERSION } from '../../src/core/constants';

export const GOLDENS_PATH = fileURLToPath(new URL('../goldens.json', import.meta.url));
export const OBSERVATIONS_DIR = fileURLToPath(new URL('../.cache/goldens-obs/', import.meta.url));

export interface GoldensFile {
  generatorVersion: number;
  entries: Record<string, string>;
}

export interface Observation {
  key: string;
  hash: string;
}

export interface GoldenStore {
  check(key: string, hash: string): void;
}

const HINT = 'run npm run test:goldens';

export function createGoldenStore(opts: {
  path: string;
  generatorVersion: number;
  mode: 'check' | 'record';
  observationsDir: string;
}): GoldenStore {
  return {
    check(key, hash) {
      if (opts.mode === 'record') {
        mkdirSync(opts.observationsDir, { recursive: true });
        const name = createHash('sha256').update(`${key}\n${hash}`).digest('hex').slice(0, 32);
        writeFileSync(join(opts.observationsDir, `${name}.json`), JSON.stringify({ key, hash }));
        return;
      }
      const file = JSON.parse(readFileSync(opts.path, 'utf8')) as GoldensFile;
      if (file.generatorVersion !== opts.generatorVersion) {
        throw new Error(`goldens.json is for GENERATOR_VERSION ${file.generatorVersion}, code is ${opts.generatorVersion}: ${HINT}`);
      }
      const expected = file.entries[key];
      if (expected === undefined) throw new Error(`missing golden ${key}: ${HINT}`);
      if (expected !== hash) throw new Error(`golden ${key} changed: ${expected} → ${hash}`);
    },
  };
}

let defaultStore: GoldenStore | null = null;

export function expectGolden(key: string, hash: string): void {
  defaultStore ??= createGoldenStore({
    path: GOLDENS_PATH,
    generatorVersion: GENERATOR_VERSION,
    mode: process.env.UPDATE_GOLDENS === '1' ? 'record' : 'check',
    observationsDir: OBSERVATIONS_DIR,
  });
  defaultStore.check(key, hash);
}

export function readObservations(dir: string): Observation[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Observation)
    .sort((a, b) => (a.key === b.key ? a.hash.localeCompare(b.hash) : a.key.localeCompare(b.key)));
}

export function mergeObservations(
  base: GoldensFile,
  observations: readonly Observation[],
  currentVersion: number,
): { ok: true; next: GoldensFile } | { ok: false; errors: string[] } {
  if (currentVersion < base.generatorVersion) {
    return { ok: false, errors: [`code GENERATOR_VERSION ${currentVersion} is older than goldens.json (${base.generatorVersion})`] };
  }
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const o of observations) {
    const prev = seen.get(o.key);
    if (prev !== undefined && prev !== o.hash) errors.push(`nondeterministic golden ${o.key}: ${prev} vs ${o.hash}`);
    seen.set(o.key, o.hash);
  }
  if (errors.length > 0) return { ok: false, errors };
  const changed = [...seen].filter(([k, h]) => base.entries[k] !== undefined && base.entries[k] !== h).map(([k]) => k).sort();
  if (changed.length > 0 && currentVersion <= base.generatorVersion) {
    return { ok: false, errors: [`changed without a GENERATOR_VERSION bump: ${changed.join(', ')}`] };
  }
  const merged: Record<string, string> = { ...base.entries };
  for (const [k, h] of seen) merged[k] = h;
  const entries: Record<string, string> = {};
  for (const k of Object.keys(merged).sort()) entries[k] = merged[k]!;
  return { ok: true, next: { generatorVersion: currentVersion, entries } };
}

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Group, Schema } from '../../src/core/params/kit';

export interface ShapeLock {
  schemaVersion: number;
  leaves: Record<string, string>;
}

export const SHAPE_LOCK_PATH = fileURLToPath(new URL('../schema-shape.lock.json', import.meta.url));
export const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));
const ACCEPT = 'run npm run test:accept-schema';
const BUMP = 'bump SCHEMA_VERSION and add a migration';
const BEGIN = '<!-- params:begin -->';
const END = '<!-- params:end -->';

export function currentShape<R extends Group>(schema: Schema<R>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { path, meta } of schema.leaves) out[path] = meta.kind;
  return out;
}

export function readShapeLock(path = SHAPE_LOCK_PATH): ShapeLock | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ShapeLock) : null;
}

function breaking(lock: ShapeLock, current: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, kind] of Object.entries(lock.leaves)) {
    if (!(path in current)) out.push(`${path} removed or renamed: ${BUMP}`);
    else if (current[path] !== kind) out.push(`${path} changed kind ${kind} → ${current[path]}: ${BUMP}`);
  }
  return out;
}

/** U4 shapeLockViolations (SP1 spec §4.6). */
export function shapeViolations(lock: ShapeLock | null, current: Record<string, string>, schemaVersion: number): string[] {
  if (lock === null) return [`test/schema-shape.lock.json is missing: ${ACCEPT}`];
  if (schemaVersion > lock.schemaVersion) return [`SCHEMA_VERSION ${schemaVersion} is ahead of the lock (${lock.schemaVersion}): ${ACCEPT}`];
  const out = breaking(lock, current);
  const added = Object.keys(current).filter((p) => !(p in lock.leaves));
  if (added.length > 0) out.push(`leaves added (${added.join(', ')}): ${ACCEPT}`);
  return out;
}

export function acceptShape(lock: ShapeLock | null, current: Record<string, string>, schemaVersion: number): { ok: true; next: ShapeLock } | { ok: false; errors: string[] } {
  if (lock !== null && schemaVersion === lock.schemaVersion) {
    const errors = breaking(lock, current);
    if (errors.length > 0) return { ok: false, errors };
  }
  const leaves: Record<string, string> = {};
  for (const p of Object.keys(current).sort()) leaves[p] = current[p]!;
  return { ok: true, next: { schemaVersion, leaves } };
}

export function readmeBlock(readme: string): string | null {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) return null;
  return readme.slice(a + BEGIN.length, b).replace(/^\n/, '').replace(/\n$/, '');
}

export function replaceReadmeBlock(readme: string, table: string): string {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error('README.md has no params block markers');
  return `${readme.slice(0, a + BEGIN.length)}\n${table}\n${readme.slice(b)}`;
}

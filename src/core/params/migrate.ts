import type { Result } from './kit';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type Migration = (doc: JsonObject) => JsonObject;

export const SCHEMA_VERSION = 1;
/** MIGRATIONS[v - 1] upgrades a version-v document to v + 1; invariant: length === SCHEMA_VERSION - 1. */
export const MIGRATIONS: readonly Migration[] = [];

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Upgrades a document from `from` to migrations.length + 1 (SP1 spec §4.6). */
export function migrate(doc: JsonObject, from: number, migrations: readonly Migration[] = MIGRATIONS): Result<JsonObject> {
  const current = migrations.length + 1;
  if (!Number.isInteger(from) || from < 1 || from > current) {
    return { ok: false, issues: [{ path: '', code: 'MIGRATION_FAILED', message: `cannot migrate from version ${from} (current ${current})` }] };
  }
  let d = doc;
  for (let v = from; v < current; v++) {
    try {
      d = migrations[v - 1]!(d);
    } catch (e) {
      return { ok: false, issues: [{ path: '', code: 'MIGRATION_FAILED', message: `migration ${v} → ${v + 1} failed: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
  return { ok: true, value: d };
}

function getAt(doc: JsonObject, keys: readonly string[]): { found: boolean; value: JsonValue } {
  let cur: JsonValue = doc;
  for (const k of keys) {
    if (!isObject(cur) || !Object.hasOwn(cur, k)) return { found: false, value: null };
    cur = cur[k]!;
  }
  return { found: true, value: cur };
}

function setAt(doc: JsonObject, keys: readonly string[], value: JsonValue | undefined): JsonObject {
  const [k, ...rest] = keys;
  const out: Record<string, JsonValue> = { ...doc };
  if (rest.length === 0) {
    if (value === undefined) delete out[k!];
    else out[k!] = value;
    return out;
  }
  const child = doc[k!];
  out[k!] = setAt(isObject(child) ? child : {}, rest, value);
  return out;
}

export function deletePath(doc: JsonObject, path: string): JsonObject {
  const keys = path.split('.');
  return getAt(doc, keys).found ? setAt(doc, keys, undefined) : doc;
}

export function mapPath(doc: JsonObject, path: string, fn: (v: JsonValue) => JsonValue): JsonObject {
  const keys = path.split('.');
  const at = getAt(doc, keys);
  return at.found ? setAt(doc, keys, fn(at.value)) : doc;
}

export function renamePath(doc: JsonObject, from: string, to: string): JsonObject {
  const at = getAt(doc, from.split('.'));
  return at.found ? setAt(deletePath(doc, from), to.split('.'), at.value) : doc;
}

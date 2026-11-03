import { fnv1a64, hex64 } from '../hash';
import { canonicalJSON } from './canonical';
import { DEFAULT_DENSITY_TREE } from './defaultTrees';
import type { Result } from './kit';
import { AMPLIFIED_DENSITY_TREE, FLOATING_DENSITY_TREE } from './presetTrees';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type Migration = (doc: JsonObject) => JsonObject;

export const SCHEMA_VERSION = 3;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The three SP5c built-in density trees (default, amplified, floating_islands, as at 5631c45), by
 * `hex64(fnv1a64(canonicalJSON(tree)))`, each mapped to today's tree of the same kind (SP6a D36, spec §12.4). The SP5c
 * trees themselves are not kept in the code: `test/fixtures/sp5c-density-trees.json` holds them, and
 * `test/unit/sp5cTrees.test.ts` pins the same three hashes.
 */
const SP5C_TREE_HASHES: ReadonlyMap<string, JsonValue> = new Map<string, JsonValue>([
  ['601ec40ff887ce6b', DEFAULT_DENSITY_TREE as JsonValue],
  ['21a5b1125d506c73', AMPLIFIED_DENSITY_TREE as JsonValue],
  ['ee32a0fee794e90b', FLOATING_DENSITY_TREE as JsonValue],
]);

/**
 * 2 → 3 (SP6a D36): a stored `density.defs` canonically equal to one of SP5c's built-in trees becomes today's tree of
 * that kind (the registered frozen tree itself); any other tree (a user's edit) and every other leaf are kept. A
 * document whose `density.defs` is absent, not an object, or not an SP5c tree is returned as is; the input is never
 * mutated (`mapPath` copies along the path).
 */
function builtInTrees(doc: JsonObject): JsonObject {
  const density = doc['density'];
  if (!isObject(density) || !Object.hasOwn(density, 'defs') || !isObject(density['defs'])) return doc;
  const today = SP5C_TREE_HASHES.get(hex64(fnv1a64(canonicalJSON(density['defs']))));
  return today === undefined ? doc : mapPath(doc, 'density.defs', () => today);
}

/**
 * MIGRATIONS[v - 1] upgrades a version-v document to v + 1; invariant: length === SCHEMA_VERSION - 1.
 * 1 → 2 (SP3d spec §1.11): the identity — version 2 adds the `json` leaves `density.defs` and `surface.rules`, which a
 * version-1 document lacks, and a missing leaf takes the profile's value.
 * 2 → 3 (SP6a D36): SP5c's built-in density trees become today's (`builtInTrees`), so a world saved before SP6a opens
 * with the caves tree; an edited tree is kept.
 */
export const MIGRATIONS: readonly Migration[] = [(doc) => doc, builtInTrees];

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

/**
 * The append-only state-id lock (SP3a spec §2.3): `test/stateIds.lock.json` maps every published state's canonical key
 * to its id. The lock test fails when an entry is missing from the registry or has another id, and when a state is not
 * yet in the lock; `npm run test:accept-state-ids` appends the new states of new types and refuses everything else: it
 * never rewrites or removes an entry, and a type that already has entries never gains states (a new property or value
 * on a locked type is a new type, §2.2).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BlockRegistry } from '../../src/world/blocks/registry';

/** Canonical key → state id, in id order. */
export type StateIdLock = Record<string, number>;

export const STATE_LOCK_PATH = fileURLToPath(new URL('../stateIds.lock.json', import.meta.url));
const ACCEPT = 'run npm run test:accept-state-ids';
const NAME = '[a-z][a-z0-9_]*';
const KEY_RE = new RegExp(`^${NAME}(\\[${NAME}=[a-z0-9_]+(,${NAME}=[a-z0-9_]+)*\\])?$`);

/** The type name of a canonical key: the bare name, or the part before `[`. */
export const lockTypeName = (key: string): string => {
  const i = key.indexOf('[');
  return i < 0 ? key : key.slice(0, i);
};

/** Every state of the registry as a lock: canonical key → id, in id order. */
export function registryStateIds(reg: BlockRegistry): StateIdLock {
  const out: StateIdLock = {};
  for (let s = 0; s < reg.stateCount; s++) out[reg.stateKey(s)] = s;
  return out;
}

/** Shape errors of a parsed lock file: an object of canonical-looking ASCII keys to unique integer ids. */
export function lockFormatErrors(json: unknown): string[] {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return ['the lock is not a JSON object of key → id'];
  const out: string[] = [];
  const seen = new Map<number, string>();
  for (const [key, id] of Object.entries(json as Record<string, unknown>)) {
    if (!KEY_RE.test(key)) out.push(`${JSON.stringify(key)} is not a canonical state key`);
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > 0xffff) {
      out.push(`${key}: id ${JSON.stringify(id)} is not a u16`);
      continue;
    }
    const other = seen.get(id);
    if (other !== undefined) out.push(`${key}: id ${id} is also ${other}`);
    seen.set(id, key);
  }
  return out;
}

/** Reads and validates the lock; null when the file does not exist. */
export function readStateLock(path = STATE_LOCK_PATH): StateIdLock | null {
  if (!existsSync(path)) return null;
  const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const errors = lockFormatErrors(json);
  if (errors.length > 0) throw new Error(`${path}:\n${errors.join('\n')}`);
  return json as StateIdLock;
}

interface Comparison {
  /** Changed ids, removed entries and new states of locked types: never accepted. */
  refusals: string[];
  /** States of types without lock entries, in id order: appended by the accept command. */
  appendable: string[];
}

function compare(lock: StateIdLock, reg: BlockRegistry): Comparison {
  // Maps, not `in` or indexing: a type may be named like an Object.prototype member (`constructor`).
  const live = new Map(Object.entries(registryStateIds(reg)));
  const locked = new Map(Object.entries(lock));
  const refusals = lockFormatErrors(lock);
  const lockedTypes = new Set<string>();
  for (const [key, id] of locked) {
    lockedTypes.add(lockTypeName(key));
    const now = live.get(key);
    if (now === undefined) refusals.push(`${key} (id ${id}) is no longer registered: a locked state never goes away`);
    else if (now !== id) refusals.push(`${key} is id ${now}, locked as ${id}: locked ids never change (append new types at the end)`);
  }
  const appendable: string[] = [];
  for (const [key, id] of live) {
    if (locked.has(key)) continue;
    const type = lockTypeName(key);
    if (lockedTypes.has(type)) {
      refusals.push(`${key} (id ${id}) is a new state of the locked type ${type}: a locked type never gains properties or values (append a new type; withType converts)`);
    } else {
      appendable.push(key);
    }
  }
  return { refusals, appendable };
}

/** The lock test: [] when the lock and the registry agree exactly. */
export function stateLockViolations(lock: StateIdLock | null, reg: BlockRegistry): string[] {
  if (lock === null) return [`test/stateIds.lock.json is missing: ${ACCEPT}`];
  const { refusals, appendable } = compare(lock, reg);
  if (appendable.length > 0) refusals.push(`states not yet in the lock (${appendable.join(', ')}): ${ACCEPT}`);
  return refusals;
}

/** `npm run test:accept-state-ids`: the lock with the new types' states appended, or the refusals. */
export function acceptStateIds(
  lock: StateIdLock | null,
  reg: BlockRegistry,
): { ok: true; next: StateIdLock; appended: string[] } | { ok: false; errors: string[] } {
  const base = lock ?? {};
  const { refusals, appendable } = compare(base, reg);
  if (refusals.length > 0) return { ok: false, errors: refusals };
  const next: StateIdLock = { ...base };
  for (const key of appendable) next[key] = reg.parseStateKey(key);
  return { ok: true, next, appended: appendable };
}

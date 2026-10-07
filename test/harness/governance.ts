import type { GoldensFile } from './goldens';
import type { StateIdLock } from './stateLock';

export interface GovernanceInput {
  baseGoldens: GoldensFile | null;
  headGoldens: GoldensFile;
  baseVersion: number | null;
  headVersion: number;
  changedFiles: readonly string[];
  /** `test/stateIds.lock.json` at the base ref and at HEAD (null when the file does not exist there). */
  baseStateIds: StateIdLock | null;
  headStateIds: StateIdLock | null;
}

/**
 * The state-id lock is append-only against the base ref (SP3a spec §2.3; SP3b spec §7): every locked entry keeps its
 * id and new entries come after the locked ids. The local lock test compares the lock with the registry only, so a
 * hand edit of both passes it; this compares the lock with its own history.
 */
function stateIdErrors(base: StateIdLock | null, head: StateIdLock | null): string[] {
  if (base === null) return [];
  if (head === null) return ['the lock was deleted'];
  const headMap = new Map(Object.entries(head));
  const out: string[] = [];
  let maxBase = -1;
  for (const [key, id] of Object.entries(base)) {
    maxBase = Math.max(maxBase, id);
    const now = headMap.get(key);
    if (now === undefined) out.push(`${key} (id ${id}) removed`);
    else if (now !== id) out.push(`${key} id ${id} → ${now}`);
  }
  const baseMap = new Map(Object.entries(base));
  for (const [key, id] of headMap) {
    if (!baseMap.has(key) && id <= maxBase) out.push(`${key} (id ${id}) is not after the locked ids (≤ ${maxBase})`);
  }
  return out;
}

export function parseGeneratorVersion(source: string): number | null {
  const m = /GENERATOR_VERSION\s*(?::\s*number\s*)?=\s*(\d+)/.exec(source);
  return m ? Number(m[1]) : null;
}

export function checkGovernance(input: GovernanceInput): string[] {
  const errors: string[] = [];
  if (input.baseGoldens) {
    const changed = Object.entries(input.baseGoldens.entries)
      .filter(([k, h]) => input.headGoldens.entries[k] !== h)
      .map(([k]) => k)
      .sort();
    const bumped = input.baseVersion !== null && input.headVersion > input.baseVersion;
    if (changed.length > 0 && !bumped) errors.push(`goldens changed or removed without a GENERATOR_VERSION bump: ${changed.join(', ')}`);
  }
  if (input.changedFiles.includes('test/thresholds.lock.json') && !input.changedFiles.some((f) => f.startsWith('docs/superpowers/specs/'))) {
    errors.push('test/thresholds.lock.json changed without a change under docs/superpowers/specs/');
  }
  const ids = stateIdErrors(input.baseStateIds, input.headStateIds);
  if (ids.length > 0) errors.push(`test/stateIds.lock.json is append-only against GOVERNANCE_BASE: ${ids.join(', ')}`);
  return errors;
}

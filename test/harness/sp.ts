import type { SubProjectId } from '../../src/core/ids';

/** Dependencies transcribed from the §10 headers of the master spec. */
export const SP_DEPS: Readonly<Record<SubProjectId, readonly SubProjectId[]>> = {
  SP0: [],
  SP1: ['SP0'],
  SP2a: ['SP1'],
  SP2b: ['SP2a'],
  SP3: ['SP2b'],
  SP4: ['SP3'],
  SP5: ['SP4'],
  SP6: ['SP3', 'SP5'],
  SP7: ['SP6', 'SP5'],
  SP8a: ['SP4'],
  SP8b: ['SP7', 'SP8a'],
  SP8c: ['SP7', 'SP5'],
  SP9: ['SP8b', 'SP8a'],
  SP10: ['SP9'],
  SP11: ['SP10'],
  SP12: ['SP11'],
};

export const SP_ORDER = Object.keys(SP_DEPS) as SubProjectId[];

/**
 * Append-only list of sub-projects whose first commit has landed.
 * Each SP appends its id in its first commit. Part of the locked governance state.
 */
export const STARTED_SPS: readonly SubProjectId[] = ['SP0', 'SP1', 'SP2a', 'SP2b'];

export function spIndex(sp: SubProjectId): number {
  return SP_ORDER.indexOf(sp);
}

export function validateStarted(
  started: readonly string[],
  deps: Readonly<Record<SubProjectId, readonly SubProjectId[]>> = SP_DEPS,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const sp of started) {
    if (seen.has(sp)) { errors.push(`duplicate ${sp}`); continue; }
    if (!(sp in deps)) { errors.push(`unknown ${sp}`); continue; }
    for (const dep of deps[sp as SubProjectId]) {
      if (!seen.has(dep)) errors.push(`${sp} started before its dependency ${dep}`);
    }
    seen.add(sp);
  }
  return errors;
}

import type { GoldensFile } from './goldens';

export interface GovernanceInput {
  baseGoldens: GoldensFile | null;
  headGoldens: GoldensFile;
  baseVersion: number | null;
  headVersion: number;
  changedFiles: readonly string[];
}

export function parseGeneratorVersion(source: string): number | null {
  const m = /GENERATOR_VERSION\s*=\s*(\d+)/.exec(source);
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
  return errors;
}

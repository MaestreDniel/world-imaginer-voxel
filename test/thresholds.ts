import type { MetricId, SubProjectId } from '../src/core/ids';

export interface ThresholdPart {
  min?: number;
  max?: number;
  /** First sub-project that gates this part (per-part, master §10 Definition of done). */
  activeFrom: SubProjectId;
}

/** One entry per metric id; part keys are stable slugs, one per threshold cell of the §6.4 row. */
export type ThresholdTable = Partial<Record<MetricId, Record<string, ThresholdPart>>>;

/** Locked by test/thresholds.lock.json — change only with `npm run test:accept-thresholds` and a spec amendment. */
export const THRESHOLDS: ThresholdTable = {
  N1: { ksD: { max: 0.015, activeFrom: 'SP1' }, sdErr: { max: 0.02, activeFrom: 'SP1' } },
  N2: { value: { max: 0.02, activeFrom: 'SP1' } },
  N3: { value: { min: 0.9, activeFrom: 'SP1' } },
  N5: { horizontal: { max: 1.15, activeFrom: 'SP1' }, vertical: { max: 1.15, activeFrom: 'SP1' } },
  N6: { value: { max: 0.001, activeFrom: 'SP1' } },
  U4: {
    registryIssues: { max: 0, activeFrom: 'SP1' },
    migrationFailures: { max: 0, activeFrom: 'SP1' },
    shapeLockViolations: { max: 0, activeFrom: 'SP1' },
    readmeStale: { max: 0, activeFrom: 'SP1' },
  },
};

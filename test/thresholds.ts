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
  B1: {
    minShare: { min: 0.003, activeFrom: 'SP2a' }, minRareShare: { min: 0.001, activeFrom: 'SP2a' }, largestLand: { max: 0.16, activeFrom: 'SP2a' },
    oceanFamilyMin: { min: 0.25, activeFrom: 'SP2a' }, oceanFamilyMax: { max: 0.45, activeFrom: 'SP2a' }, ties: { max: 0, activeFrom: 'SP2a' }, outside: { max: 0.02, activeFrom: 'SP2a' },
  },
  B4: { hotColdSpruceWindswept: { max: 0.01, activeFrom: 'SP2a' }, coastBandBeach: { min: 0.7, activeFrom: 'SP2a' } },
  N4: { originSdRatio: { min: 0.8, activeFrom: 'SP2a' }, spawnTopShare: { max: 0.3, activeFrom: 'SP2a' }, spawnDistinct: { min: 8, activeFrom: 'SP2a' }, spawnOnLand: { min: 1, activeFrom: 'SP2a' } },
  T6: { minGain: { min: 8.5, activeFrom: 'SP2a' }, maxGain: { max: 11.5, activeFrom: 'SP2a' } },
  T7: { value: { min: 0.9, max: 1.1, activeFrom: 'SP2a' }, borderMismatch: { max: 0, activeFrom: 'SP2a' } },
  T8: { E: { min: 10, activeFrom: 'SP2a' }, PV: { min: 10, activeFrom: 'SP2a' } },
  T1lowland: { value: { max: 0.4, activeFrom: 'SP2a' } },
  B2: {
    medianLength: { min: 300, activeFrom: 'SP2a' }, landShareMin: { min: 0.02, activeFrom: 'SP2a' }, landShareMax: { max: 0.07, activeFrom: 'SP2a' },
    mouths: { min: 0.5, activeFrom: 'SP2a' }, gorgesPer100km2: { min: 1, activeFrom: 'SP2a' }, dryRiverBiome: { max: 0, activeFrom: 'SP2a' },
  },
  B5: { perKm2Min: { min: 0.2, activeFrom: 'SP2a' }, perKm2Max: { max: 2, activeFrom: 'SP2a' }, highShare: { min: 0.3, activeFrom: 'SP2a' } },
  U2: { value: { min: 1, activeFrom: 'SP2b' } },
  U4: {
    registryIssues: { max: 0, activeFrom: 'SP1' },
    migrationFailures: { max: 0, activeFrom: 'SP1' },
    shapeLockViolations: { max: 0, activeFrom: 'SP1' },
    readmeStale: { max: 0, activeFrom: 'SP1' },
  },
};

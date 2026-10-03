import { expect } from 'vitest';
import { REGISTRY } from '../../src/world/blocks/index';
import { buildRegistry } from '../../src/world/blocks/registry';
import { FIXTURE_DEFS } from '../harness/blockFixtures';
import { metricTest } from '../harness/metric';
import { registryRoundTripFailures } from '../harness/registryChecks';
import { readStateLock, stateLockViolations } from '../harness/stateLock';

/**
 * M1, registry parts (SP3a spec §2.4, §9; master §6.4), the same on every tier: the used block states fit in
 * `MAX_STATES`; rotations, mirrors and round trips are exact over the real registry and the fixture registry; the
 * entries of `test/stateIds.lock.json` are unchanged. The shape-grid part arrives with SP8a.
 */
metricTest('M1', ['states', 'roundTripFailures', 'lockChanges'], () => {
  const roundTrips = [
    ...registryRoundTripFailures(REGISTRY).map((m) => `real: ${m}`),
    ...registryRoundTripFailures(buildRegistry(FIXTURE_DEFS)).map((m) => `fixture: ${m}`),
  ];
  const lock = stateLockViolations(readStateLock(), REGISTRY);
  expect.soft(roundTrips, 'rotation, mirror and round-trip failures').toEqual([]);
  expect.soft(lock, 'stateIds.lock.json violations').toEqual([]);
  return { states: REGISTRY.stateCount, roundTripFailures: roundTrips.length, lockChanges: lock.length };
});

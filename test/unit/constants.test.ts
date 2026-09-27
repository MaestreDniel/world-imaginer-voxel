import { expect, test } from 'vitest';
import { GENERATOR_VERSION } from '../../src/core/constants';

test('GENERATOR_VERSION is a non-negative integer', () => {
  expect(Number.isInteger(GENERATOR_VERSION)).toBe(true);
  expect(GENERATOR_VERSION).toBeGreaterThanOrEqual(0);
});

import { expect, test } from 'vitest';
import { MEDIUM } from '../../src/core/params/graphicsPresets';

test('MEDIUM holds the SP4a fields of the Medium row (SP4a spec §6.10, D17)', () => {
  expect(MEDIUM).toEqual({
    rd: 12, uploadBudgetMs: 2, uploadSections: 32, ao: true, smoothLight: true, water: 'fancy', pixelRatioCap: 1, fogBand: 64,
  });
});

test('MEDIUM.water is \'fancy\': the Medium row\'s water tier (master §4.16; SP7a spec §7, D10)', () => {
  expect(MEDIUM.water).toBe('fancy');
});

test('MEDIUM is frozen', () => {
  expect(Object.isFrozen(MEDIUM)).toBe(true);
});

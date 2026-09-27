import { expect, test } from 'vitest';
import { seedFromInput } from '../../src/core/seed';
import { cryptoSeed, resolveSeedText } from '../../src/ui/seedBox';

test('non-empty text is trimmed and parsed', () => {
  expect(resolveSeedText('  hello ', () => { throw new Error('no random'); })).toEqual({ text: 'hello', seed: seedFromInput('hello') });
  expect(resolveSeedText('-1').seed).toEqual([4294967295, 4294967295]);
});

test('empty or whitespace-only text draws a random seed and writes it back as decimal text', () => {
  const r = resolveSeedText('   ', () => [7, 1]);
  expect(r).toEqual({ text: '4294967303', seed: [7, 1] });
  expect(seedFromInput(r.text)).toEqual(r.seed);
});

test('cryptoSeed returns two u32 words', () => {
  const s = cryptoSeed();
  expect(s.every((w) => Number.isInteger(w) && w >= 0 && w < 2 ** 32)).toBe(true);
});

import { expect, test } from 'vitest';
import { fnv1a64 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import { seedFromInput, seedToText } from '../../src/core/seed';

test.each([
  ['007', [7, 0]],
  ['+5', [5, 0]],
  [' 42 ', [42, 0]],
  ['-1', [4294967295, 4294967295]],
  ['18446744073709551615', [4294967295, 4294967295]],
  ['-9223372036854775808', [0, 2147483648]],
  ['9007199254740993', [1, 2097152]],
])('numeric seed %j', (text, seed) => {
  expect(seedFromInput(text)).toEqual(seed);
});

test.each(['18446744073709551616', '-9223372036854775809', '1e5', '0x10', 'Hello', 'é', ''])('text seed %j hashes the trimmed text', (text) => {
  expect(seedFromInput(text)).toEqual(fnv1a64(text.trim()));
});

test('whitespace-only text is the empty-string hash (the UI replaces it with a random seed)', () => {
  expect(seedFromInput('   ')).toEqual(fnv1a64(''));
});

test('seedToText round-trips 100k random seeds', () => {
  const r = new Xoshiro128(5);
  for (let i = 0; i < 100000; i++) {
    const s = [r.nextU32(), r.nextU32()] as const;
    expect(seedFromInput(seedToText(s))).toEqual(s);
  }
  expect(seedToText([7, 0])).toBe('7');
  expect(seedToText([4294967295, 4294967295])).toBe('18446744073709551615');
});

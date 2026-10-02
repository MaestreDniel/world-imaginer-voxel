import { expect, test } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../../src/ui/common/base64url';

test('base64url helpers', () => {
  expect(base64urlEncode(Uint8Array.of(251, 255))).toBe('-_8');
  expect(Array.from(base64urlDecode('-_8')!)).toEqual([251, 255]);
  expect(base64urlDecode('a b')).toBeNull();
});

test('round trip at every padding length; the decoder accepts padding and refuses misplaced padding', () => {
  for (let n = 0; n <= 4; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => 250 + i);
    const text = base64urlEncode(bytes);
    expect(text).not.toMatch(/[=+/]/);
    expect(Array.from(base64urlDecode(text)!)).toEqual(Array.from(bytes));
    expect(Array.from(base64urlDecode(text + '='.repeat((4 - (text.length % 4)) % 4))!)).toEqual(Array.from(bytes));
  }
  expect(base64urlDecode('-=_8')).toBeNull();
});

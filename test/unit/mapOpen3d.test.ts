import { describe, expect, test } from 'vitest';
import { open3dHref } from '../../src/ui/map/toolbar';

const HASH = '#v1.s42.pdefault.x0.z0';

describe('"Open in 3D" on ?map (SP4a spec §8.2; ruling P51)', () => {
  test('with a pin, the link uses the rounded pin', () => {
    expect(open3dHref([120.4, -77.6], [10.6, -3.4], HASH)).toBe(`/?at=120,-78${HASH}`);
  });

  test('without a pin, it uses the rounded view centre', () => {
    expect(open3dHref(null, [10.6, -3.4], HASH)).toBe(`/?at=11,-3${HASH}`);
  });

  test('the hash is kept unchanged', () => {
    const hash = '#v1.s%20my%20seed.pamplified.x-640.z0.b2.5.lheight';
    expect(open3dHref(null, [0, 0], hash)).toBe(`/?at=0,0${hash}`);
    expect(open3dHref([5, 5], [0, 0], hash).endsWith(hash)).toBe(true);
  });
});

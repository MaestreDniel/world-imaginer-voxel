import { describe, expect, test, vi } from 'vitest';
import { evaluateFieldSlice, probeField, sliceSampleVoxel, type SliceGeometry } from '../../src/gen/inspect/fieldSlice';
import { segmentPointAt } from '../../src/metrics/crossSection';
import { ctxFor } from '../harness/gen';

// A valid tree never evaluates to NaN or ±∞ (SP3d spec §1.9), so the reference is wrapped to return them: the slice and
// the probe must hand such values on unchanged (§3.6 shows NaN, +∞ and −∞; §5.3's reply guard accepts any number).
vi.mock('../../src/gen/density/reference', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/gen/density/reference')>();
  const odd = (x: number, y: number, z: number): number | null => {
    const k = (Math.imul(x ^ Math.imul(z, 0x27d4eb2f), 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) >>> 30;
    return k === 0 ? Number.NaN : k === 1 ? Number.POSITIVE_INFINITY : k === 2 ? Number.NEGATIVE_INFINITY : null;
  };
  return {
    ...real,
    createDensityReference: (...args: Parameters<typeof real.createDensityReference>) => {
      const ref = real.createDensityReference(...args);
      return { ...ref, voxel: (s, x, y, z, e) => odd(x, y, z) ?? ref.voxel(s, x, y, z, e) } satisfies typeof ref;
    },
  };
});

const NEVER = (): boolean => false;
/** The voxels the wrapped reference answers with a non-finite value (a hash of x, y and z; about a quarter stay finite). */
const odd = (x: number, y: number, z: number): number | null => {
  const k = (Math.imul(x ^ Math.imul(z, 0x27d4eb2f), 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) >>> 30;
  return k === 0 ? Number.NaN : k === 1 ? Number.POSITIVE_INFINITY : k === 2 ? Number.NEGATIVE_INFINITY : null;
};

describe('non-finite values pass through unchanged (SP3d spec §3.6, §5.3)', () => {
  const ctx = ctxFor('42');
  const planes: Array<[string, SliceGeometry]> = [
    ['vertical', { plane: 'vertical', n: 32, pointAt: (i) => segmentPointAt({ ax: -1664, az: 8, bx: -640, bz: 8 }, i, 32) }],
    ['horizontal', { plane: 'horizontal', n: 32, cx: 0, cz: 0, y: 64, extent: 256 }],
  ];

  test.each(planes)('%s slice and probe: NaN, +∞ and −∞ as the reference returns them', (_name, g) => {
    for (const [field, path] of [['density', ''], ['node', 'root.a']] as const) {
      const r = evaluateFieldSlice(ctx, { geometry: g, field, path, from: 0, to: 32 }, NEVER)!;
      const seen = new Set<string>();
      for (let c = 0; c < 32; c++) {
        for (let k = 0; k < 32; k++) {
          const [x, y, z] = sliceSampleVoxel(g, c, k);
          const v = r.values[c * 32 + k]!;
          const want = odd(x, y, z);
          if (want !== null) {
            expect(Object.is(v, want)).toBe(true);
            seen.add(String(v));
          } else {
            expect(Number.isFinite(v)).toBe(true);
          }
          if ((c + k) % 9 === 0) expect(Object.is(probeField(ctx, field, path, x, y, z, NEVER), v)).toBe(true);
        }
      }
      expect([...seen].sort()).toEqual(['-Infinity', 'Infinity', 'NaN']);
    }
  });
});

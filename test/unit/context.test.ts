import { expect, test } from 'vitest';
import { BOX_BIOMES } from '../../src/core/params/biomeDefaults';
import { DEFAULTS } from '../../src/core/params/defaults';
import { noiseInstances } from '../../src/core/params/noises';
import { SCHEMA } from '../../src/core/params/schema';
import { evalSpline } from '../../src/core/spline/hermite';
import { noiseFor } from '../../src/gen/context';
import { ctxFor } from '../harness/gen';

test('GenContext prepares every schema noise, the three splines and the biome boxes', () => {
  const ctx = ctxFor('42');
  expect([...ctx.noise.keys()]).toEqual(noiseInstances(SCHEMA, DEFAULTS).map((i) => i.seedName));
  expect(() => noiseFor(ctx, 'nope')).toThrow(/no schema noise nope/);
  expect(ctx.scale).toBe(1);
  expect(evalSpline(ctx.offset, Float64Array.of(-1, 0, 0, 0, 0, 0))).toBe(16);
  expect(ctx.boxes.map((b) => b.index)).toEqual(BOX_BIOMES.map((_, i) => i));
  const v = ctx.boxes[BOX_BIOMES.indexOf('volcano')]!;
  expect([Array.from(v.lo), Array.from(v.hi), v.wSign, v.priority]).toEqual([[-0.1, -1, 0.7, 0.6, -1], [1, -0.375, 1, 1, 1], 0, 26]);
  expect(ctxFor('42').lakeSeed).toBe(ctx.lakeSeed);
  expect(ctxFor('43').lakeSeed).not.toBe(ctx.lakeSeed);
});

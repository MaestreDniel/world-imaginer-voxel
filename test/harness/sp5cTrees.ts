/**
 * The SP5c built-in density trees (`test/fixtures/sp5c-density-trees.json`, written by `test/unit/sp5cTrees.test.ts`
 * from the code at c64b4a9, SP6a Task 4) and the value checks that tie today's trees to them: SP6a moved the default's
 * body into `defs.body` and gave the root its `precave` tap and cave slots, with every density value and every bounds
 * decision unchanged until the cave terms land.
 */
import { readFileSync } from 'node:fs';
import type { Params } from '../../src/core/params/schema';
import { fillDensityColumn } from '../../src/gen/density/bounds';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { resolveDensity } from '../../src/gen/density/source';
import type { GenContext } from '../../src/gen/context';

export type Sp5cKind = 'default' | 'amplified' | 'floating_islands';

const FIXTURE = new URL('../fixtures/sp5c-density-trees.json', import.meta.url);

/** The fixture's three trees (fresh, unfrozen copies on every call). */
export function sp5cTrees(): Record<Sp5cKind, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<Sp5cKind, unknown>;
}

/** The columns the value checks run on: the origin, a far negative column and a mountain-side one. */
export const SP5C_COLUMNS: ReadonlyArray<readonly [number, number]> = [[0, 0], [-1667, -2000], [40, 900]];

/** Two DensityContexts on `ctx`: `today` over the source tree `source`, `sp5c` over the fixture's tree `kind`. */
export function sp5cPair(ctx: GenContext, source: unknown, kind: Sp5cKind, params: Params = ctx.params): { today: DensityContext; sp5c: DensityContext } {
  return {
    today: createDensityContext(ctx, resolveDensity(source, params)),
    sp5c: createDensityContext(ctx, resolveDensity(sp5cTrees()[kind], params)),
  };
}

/**
 * The first difference between `a` and `b` on column (cx, cz), or null: the root value at every one of the 98,304
 * voxels (`Object.is`), then `fillDensityColumn`'s per-cell decisions (the root's interval before and after the
 * corners, each read as solid, air or undecided) and its solid and evaluated-voxel arrays.
 */
export function columnDiff(a: DensityContext, b: DensityContext, cx: number, cz: number): string | null {
  a.column(cx, cz);
  b.column(cx, cz);
  for (let v = 0; v < 98304; v++) {
    const lx = v & 15, lz = (v >> 4) & 15, y = (v >> 8) - 64;
    const va = a.compiled.voxelFn(lx, y, lz), vb = b.compiled.voxelFn(lx, y, lz);
    if (!Object.is(va, vb)) return `voxel (${lx}, ${y}, ${lz}) of (${cx}, ${cz}): ${va} vs ${vb}`;
  }
  const da = decisions(a, cx, cz), db = decisions(b, cx, cz);
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return `cell ${i} of (${cx}, ${cz}): decision ${da[i]} vs ${db[i]}`;
  const fill = (dc: DensityContext): [Uint8Array, Uint8Array] => {
    const solid = new Uint8Array(98304), mask = new Uint8Array(98304);
    fillDensityColumn(dc.bounds, dc.columns.get(cx, cz), solid, null, mask, () => false);
    return [solid, mask];
  };
  const [sa, ma] = fill(a), [sb, mb] = fill(b);
  for (let i = 0; i < 98304; i++) {
    if (sa[i] !== sb[i]) return `solid ${i} of (${cx}, ${cz})`;
    if (ma[i] !== mb[i]) return `evaluated ${i} of (${cx}, ${cz})`;
  }
  return null;
}

/** Per cell, 2 bits: the decision from the root's interval, then (when undecided) from its corner hull (0 air, 1 solid, 2 undecided, 3 not asked). */
function decisions(dc: DensityContext, cx: number, cz: number): Uint8Array {
  const out = new Uint8Array(768);
  const iv = new Float64Array(2);
  const c = dc.compiled, b = dc.bounds;
  c.columnFn(dc.columns.get(cx, cz));
  c.positionFn(dc.columns.get(cx, cz));
  b.beginColumn();
  const read = (): number => (iv[1]! < 0 ? 0 : iv[0]! > 0 ? 1 : 2);
  for (let ck = 0; ck < 48; ck++) {
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        b.cellInterval(ci, ck, cj, iv, 0);
        const first = read();
        let second = 3;
        if (first === 2 && c.interpolatedSlotCount > 0) {
          c.cellCorners(ci, ck, cj);
          b.cellIntervalCorners(ci, ck, cj, iv, 0);
          second = read();
        }
        out[(ck * 4 + cj) * 4 + ci] = first * 4 + second;
      }
    }
  }
  return out;
}

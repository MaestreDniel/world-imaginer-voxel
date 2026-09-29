/**
 * Column-stage rasters shared by the water metrics and later dashboards (SP2a spec §7.3): the water-only
 * pipeline (climate → shape → rivers → lakes) on a square grid, without steep and biome.
 */
import type { GenContext } from '../gen/context';
import { newClimate, sampleClimate } from '../gen/column/climate';
import { newLake, sampleLakes } from '../gen/column/lakes';
import { newRiver, sampleRivers } from '../gen/column/rivers';
import { newShape, sampleShape } from '../gen/column/shape';

const CLIMATE = sampleClimate;
const SHAPE = sampleShape;
const RIVERS = sampleRivers;
const LAKES = sampleLakes;
const NEW_CLIMATE = newClimate;
const NEW_SHAPE = newShape;
const NEW_RIVER = newRiver;
const NEW_LAKE = newLake;

export interface WaterRaster {
  readonly n: number;
  readonly step: number;
  readonly x0: number;
  readonly z0: number;
  readonly offset0: Float64Array;
  readonly offset: Float64Array;
  /** 1 = river wet, 2 = gorge. */
  readonly river: Uint8Array;
  readonly lakeInside: Uint8Array;
  readonly lakeLevel: Float64Array;
}

/** n × n cells of `step` blocks from (x0, z0), row-major (index = j·n + i). */
export function waterRaster(ctx: GenContext, x0: number, z0: number, n: number, step: number): WaterRaster {
  const r: WaterRaster = {
    n, step, x0, z0, offset0: new Float64Array(n * n), offset: new Float64Array(n * n), river: new Uint8Array(n * n),
    lakeInside: new Uint8Array(n * n), lakeLevel: new Float64Array(n * n),
  };
  const c = NEW_CLIMATE();
  const s = NEW_SHAPE();
  const rv = NEW_RIVER();
  const lk = NEW_LAKE();
  const coords = new Float64Array(6);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = x0 + i * step;
      const z = z0 + j * step;
      CLIMATE(ctx, x, z, c);
      SHAPE(ctx, c, coords, s);
      RIVERS(ctx, c, s, rv);
      LAKES(ctx, x, z, rv.offset, rv.sigma, rv.jag, lk);
      r.offset0[k] = s.offset0;
      r.offset[k] = lk.offset;
      r.river[k] = rv.wet ? 1 : rv.gorge ? 2 : 0;
      r.lakeInside[k] = lk.lakeMask === 1 ? 1 : 0;
      r.lakeLevel[k] = lk.lakeLevel;
    }
  }
  return r;
}

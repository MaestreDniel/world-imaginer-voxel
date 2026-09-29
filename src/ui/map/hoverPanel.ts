/** Side-panel readout of a ColumnPoint (SP2a spec §6.3). */
import { biomeName } from '../../gen/biomes/registry';
import type { ColumnPoint } from '../../gen/column/columnPoint';

const n = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : v > 0 ? '+∞' : v < 0 ? '−∞' : 'NaN');

export function formatPoint(p: ColumnPoint): string {
  return [
    `x ${n(p.x, 1)}  z ${n(p.z, 1)}`,
    `biome ${biomeName(p.biome)}`,
    `C ${n(p.C)}  E ${n(p.E)}  W ${n(p.W)}`,
    `T ${n(p.T)}  H ${n(p.H)}  R ${n(p.R)}  PV ${n(p.PV)}`,
    `offset0 ${n(p.offset0, 2)}  σ0 ${n(p.sigma0, 2)}  jag0 ${n(p.jag0, 2)}`,
    `steep ${n(p.steep, 3)}`,
    `riverDist ${n(p.riverDist, 1)}  strength ${n(p.riverStrength, 2)}${p.riverWet ? '  river' : ''}${p.gorge ? '  gorge' : ''}`,
    `lake ${n(p.lakeMask, 2)}  level ${n(p.lakeLevel, 0)}  floor ${n(p.lakeFloor, 1)}`,
    `offset ${n(p.offset, 2)}  σ ${n(p.sigma, 2)}  jag ${n(p.jag, 2)}`,
    `surfaceEst ${n(p.surfaceEst, 2)}  water ${n(p.surfaceWaterLevel, 0)}`,
  ].join('\n');
}

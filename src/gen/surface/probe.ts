/**
 * The surface probe (SP3c spec §3.6, master §5.5 "surface-rule branch path"): the final state of one voxel and the
 * rule ids from `root` to the leaf that yielded it. It rebuilds the voxel's column the way the T stage does (the
 * ColumnSample, the density fill on the SurfaceContext's DensityContext, water v0, the per-block surface biome buffer
 * and the §3.2 scan), reusing the SurfaceContext's one-column cache while the probes stay in one column, then walks
 * the reference evaluator, never the fast path (a fast-path voxel such as deepslate at y −30 still reports its rule).
 * `path` is [] for air and water (state air), at y −64 (the stage's bedrock) and for a solid voxel no rule matches
 * (stone). Follows the gen determinism rules.
 */
import { inWindow } from '../../core/coords';
import { AIR, BEDROCK } from '../../world/blocks/index';
import { fillDensityColumn } from '../density/bounds';
import { columnWaterV0 } from '../pipeline/terrainStage';
import type { SurfaceContext, SurfaceProbeColumn } from './context';
import type { SurfaceRuleResult } from './reference';
import { fillSurfaceBiomes, scanColumn } from './scan';

const IN_WINDOW = inWindow;
const AIR_ = AIR;
const BEDROCK_ = BEDROCK;
const FILL = fillDensityColumn;
const WATER_V0 = columnWaterV0;
const BIOMES = fillSurfaceBiomes;
const SCAN = scanColumn;

const NEVER = (): boolean => false;
const TOP = new Int32Array(256);
const WATER_TOP = new Int32Array(256);
const EMPTY: readonly string[] = Object.freeze([]);

/**
 * Column (cx, cz) of `sc` rebuilt as the T stage builds it (density fill, water v0, the biome buffer) and scanned with
 * `sc.settings`: the SurfaceContext's one-column cache, rebuilt unless it already holds (cx, cz).
 */
export function surfaceProbeColumn(sc: SurfaceContext, cx: number, cz: number): SurfaceProbeColumn {
  const c = sc.probeColumn;
  if (c.valid && c.cx === cx && c.cz === cz) return c;
  c.valid = false;
  const s = sc.density.columns.get(cx, cz);
  FILL(sc.density.bounds, s, c.solid, null, null, NEVER);
  WATER_V0(s, c.solid, TOP, WATER_TOP, c.water);
  BIOMES(s, sc.ctx, c.biomes);
  SCAN(c.scan, sc.settings, s, c.solid, c.water, c.biomes);
  c.cx = cx;
  c.cz = cz;
  c.valid = true;
  return c;
}

/**
 * The final state of world voxel (x, y, z) and its surface-rule branch path (rule ids from `root` to the yielding
 * `block` leaf; [] for air, water, y −64 and a stone no rule yields). x and z integers in the world window, y an
 * integer in −64 … 319; otherwise a RangeError.
 */
export function surfaceProbe(sc: SurfaceContext, x: number, y: number, z: number): SurfaceRuleResult {
  if (!Number.isInteger(x) || !Number.isInteger(z) || !IN_WINDOW(x, z)) throw new RangeError(`surfaceProbe (x, z) = (${x}, ${z}) is not an integer position in the world window`);
  if (!Number.isInteger(y) || y < -64 || y > 319) throw new RangeError(`surfaceProbe y ${y} is outside [-64, 319]`);
  if (y === -64) return { state: BEDROCK_, path: EMPTY };
  const cx = x >> 4, cz = z >> 4;
  const c = surfaceProbeColumn(sc, cx, cz);
  const p = ((z - 16 * cz) << 4) | (x - 16 * cx);
  if (c.solid[((y + 64) << 8) | p] === 0) return { state: AIR_, path: EMPTY };
  return sc.reference.evaluate(c.scan, sc.settings, p, y);
}

/**
 * The surface probe (SP3c spec §3.6, master §5.5 "surface-rule branch path"): the final state of one voxel and the
 * rule ids from `root` to the leaf that yielded it. It rebuilds the voxel's column the way the T stage does (the
 * ColumnSample, the density fill on the SurfaceContext's DensityContext, the carve (SP6a spec §3.4: `carveColumn`
 * through `carverCacheOf`, so the scan skins the carved column), the cave tag and the cave-biome step (SP6b spec §2.3:
 * `tagColumn` and `columnCaveBiomes`, so the scan reads each run's floor and ceiling cave biome and the picker's pass),
 * the aquifer step (SP7a spec §1.7: `aquiferColumn` on `aquiferOf`, so the scan sees cave water and barrier rock), the
 * per-block surface biome buffer and the §3.2 scan), reusing the SurfaceContext's one-column cache while
 * the probes stay in one column, then walks the reference evaluator, never the fast path (a fast-path voxel such as
 * deepslate at y −30 still reports its rule).
 * `path` is [] for air and fluid (state air), at y −64 (the stage's bedrock) and for a solid voxel no rule matches
 * (stone; a barrier is solid and walks the tree as any rock). Follows the gen determinism rules.
 */
import { inWindow } from '../../core/coords';
import { AIR, BEDROCK } from '../../world/blocks/index';
import { cavePickerOf } from '../biomes/cavePicker';
import { carveColumn, densityTopColumn } from '../caves/carve';
import { carverCacheOf } from '../caves/carverCache';
import { caveReadersOf, tagColumn } from '../caves/tags';
import { fillDensityColumn } from '../density/bounds';
import { aquiferColumn, aquiferOf, createAquiferScratch } from '../fluids/aquifer';
import { columnCaveBiomes } from '../pipeline/terrainStage';
import type { SurfaceContext, SurfaceProbeColumn } from './context';
import type { SurfaceRuleResult } from './reference';
import { fillSurfaceBiomes, scanColumn } from './scan';

const IN_WINDOW = inWindow;
const AIR_ = AIR;
const BEDROCK_ = BEDROCK;
const FILL = fillDensityColumn;
const AQUIFER_OF = aquiferOf;
const AQUIFER_COLUMN = aquiferColumn;
const NEW_AQUIFER_SCRATCH = createAquiferScratch;
const BIOMES = fillSurfaceBiomes;
const SCAN = scanColumn;
const CARVE = carveColumn;
const DENSITY_TOPS = densityTopColumn;
const CARVER_CACHE = carverCacheOf;
const READERS = caveReadersOf;
const TAG_COLUMN = tagColumn;
const PICKER_OF = cavePickerOf;
const CAVE_BIOMES = columnCaveBiomes;

const NEVER = (): boolean => false;
/** The aquifer step's fluid bytes and highest fluid voxels (the probe reads its water scratch only) and its cache. */
const FLUID = new Uint8Array(98304);
const TOP_FLUID = new Int32Array(256);
const AQUIFER_SCRATCH = NEW_AQUIFER_SCRATCH();
const DENSITY_TOP = new Int16Array(256);
const EMPTY: readonly string[] = Object.freeze([]);

/**
 * Column (cx, cz) of `sc` rebuilt as the T stage builds it (density fill, the carve, the tag, the cave-biome step, the
 * aquifer step with its barriers, the biome buffer) and scanned with `sc.settings`, the cave bytes and the picker's pass: the SurfaceContext's
 * one-column cache, rebuilt unless it already holds (cx, cz). With `stop`, the density fill polls it (every 8 corner
 * rows, as the T stage's) and the build returns null when it fires, leaving the cache empty: a slice's `rule` part on a
 * tree near the column-cost maximum stops within §4.5's 50 ms.
 */
export function surfaceProbeColumn(sc: SurfaceContext, cx: number, cz: number): SurfaceProbeColumn;
export function surfaceProbeColumn(sc: SurfaceContext, cx: number, cz: number, stop: () => boolean): SurfaceProbeColumn | null;
export function surfaceProbeColumn(sc: SurfaceContext, cx: number, cz: number, stop: () => boolean = NEVER): SurfaceProbeColumn | null {
  const c = sc.probeColumn;
  if (c.valid && c.cx === cx && c.cz === cz) return c;
  c.valid = false;
  const s = sc.density.columns.get(cx, cz);
  const bounds = sc.density.bounds;
  if (!FILL(bounds, s, c.solid, null, null, stop, c.cells)) return null;
  const islands = sc.ctx.params.islands.enabled;
  DENSITY_TOPS(c.solid, islands, DENSITY_TOP);
  const cache = CARVER_CACHE(sc.ctx);
  c.tags.fill(0);
  CARVE(cache, cache.params, s, cx, cz, c.solid, DENSITY_TOP, c.tags);
  const compiled = bounds.compiled;
  TAG_COLUMN(compiled, READERS(compiled), sc.ctx.params.caves.pillars.threshold, c.solid, c.cells, c.tags, bounds, true);
  const inputs = PICKER_OF(sc.ctx);
  CAVE_BIOMES(inputs, s, c.tags, c.pass);
  AQUIFER_COLUMN(AQUIFER_OF(sc.ctx), s, inputs, c.pass, c.solid, c.tags, c.water, FLUID, TOP_FLUID, AQUIFER_SCRATCH);
  BIOMES(s, sc.ctx, c.biomes);
  SCAN(c.scan, sc.settings, s, c.solid, c.water, c.biomes, c.tags, { inputs, pass: c.pass });
  c.cx = cx;
  c.cz = cz;
  c.valid = true;
  return c;
}

/**
 * The final state of world voxel (x, y, z) and its surface-rule branch path (rule ids from `root` to the yielding
 * `block` leaf; [] for air, fluid, y −64 and a stone no rule yields). x and z integers in the world window, y an
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

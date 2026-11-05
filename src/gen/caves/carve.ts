/**
 * Carving a column (SP6a spec §2.4, D6, D7, D8): the carvers' paths through the window open the voxels the density
 * fill left solid, after the fill and before the tag (§3.1).
 * - **The window's order**: the sources sz from cz − R to cz + R, within each sx from cx − R to cx + R, within each the
 *   kinds worm, ravine, underground worm (R = `CARVER_WINDOW_R`); each path's ellipsoids in index order. A voxel two
 *   sources carve keeps the kind of the first (§3.2 step 4): a carved voxel is no longer solid, so no later source
 *   touches it or its tag.
 * - **The per-voxel test** (`carveTest`, the one implementation `carveColumn`, `carvedKind` and the tests share): with
 *   the ellipsoid (cx, cy, cz, rh, rv, floor), `d = dx·dx·w + dz·dz·w + dy·dy`, dx = (x + 0.5 − cx)/rh,
 *   dz = (z + 0.5 − cz)/rh, dy = (y + 0.5 − cy)/rv, w = 1 for worms and the ravine's f² at the voxel's y, in that
 *   operation order (world coordinates, so two columns compute the same doubles for one voxel); the voxel is carved when
 *   y > −64 (the bedrock stays), `d < 1 − σ`, and for worms `dy > floor`.
 * - **The shrink** σ = max(σ_w, σ_i, σ_u), each linear in [0, 1], so a carver narrows to nothing over a span:
 *   σ_w = wet′·clamp((waterDepth + 8 + bandSpan − (densityTop − y))·(1/(8 + bandSpan)), 0, 1) (the wet roof: nothing
 *   within 16 blocks of a wet position's density top, full size from 40 below it at the defaults);
 *   σ_i = clamp((y − capTop + 8 + bandSpan)·(1/bandSpan), 0, 1) (the island cap: 1 from y 172 when capTop is 180);
 *   σ_u = clamp((y − maxY + 16)·(1/16), 0, 1) for underground worms only (nothing from maxY, full size below maxY − 16).
 * - **wet′** = clamp(4·wetMask, 0, 1) with `wetMask` the column sample's bilinear readout at the voxel's (x, z), in the
 *   default tree's operation order (`defs.wetSteep`'s wet′, `core/params/defaultTrees.ts`; a unit test pins them equal).
 * - **The density top** (`densityTopOf`) of a position: its highest solid voxel after the density fill, before carving
 *   (y −64, the bedrock, never counts; −65 when there is none); with `islands.enabled` the top of its highest maximal
 *   solid run whose bottom lies below `ISLAND_RUN_MIN_BOTTOM` (water v0's base rule, `columnWaterV0`), so σ_w sees the
 *   sea bed under an island over the sea, where water v0 fills.
 * - Only solid voxels are carved: the fill's solid voxel is stone until the surface pass, a `CARVABLE` state; the check
 *   stays in the loop for SP9's structure blocks.
 * Per cache, the window's paths that meet the current column are kept as one list of (path, ellipsoid, voxel range)
 * entries in the window's order, rebuilt when the column changes (ruling P22): `carvedKind` probes voxel by voxel and
 * reuses it while its calls stay in one column. The list is a pure function of the cache's paths, so it changes no
 * output. Follows the gen determinism rules.
 */
import { CARVER_WINDOW_R, CAVE_KIND, HEIGHT, ISLAND_RUN_MIN_BOTTOM, MIN_Y } from '../../core/constants';
import { CARVABLE, STONE } from '../../world/blocks/index';
import { readField, type ColumnSample } from '../column/columnStage';
import { valClamp } from '../density/nodes';
import type { CarverCache } from './carverCache';
import type { CarverKind, CarverParams, CarverPath } from './carvers';

const R = CARVER_WINDOW_R;
const Y0 = MIN_Y;
const ROWS = HEIGHT;
const TOP_Y = Y0 + ROWS - 1;
const ISLAND_BOTTOM = ISLAND_RUN_MIN_BOTTOM;
const READ_FIELD = readField;
const CLAMP = valClamp;
const KIND = CAVE_KIND;
const K_WORM: number = KIND.worm;
const K_RAVINE: number = KIND.ravine;
const K_UNDER: number = KIND.undergroundWorm;
const CARVABLE_ = CARVABLE;
const STONE_ = STONE;
/** The window's kinds, in its order. */
const KINDS: readonly CarverKind[] = ['worm', 'ravine', 'undergroundWorm'];
/** No density top: the position holds no solid voxel above the bedrock (or, with islands, no ground run). */
const NO_TOP = Y0 - 1;
/** `carveTest`'s answer when it needs the voxel's density top and was given NaN. */
const NEED_TOP = -1;
/** The underground worms' span below `maxY` (spec §2.4): σ_u rises from 0 at maxY − 16 to 1 at maxY. */
const UNDER_SPAN = 16;
/**
 * Per value of the fill's solidity: 1 where that voxel may be carved. The fill's 1 is stone until the surface pass
 * (`CARVABLE`, `world/blocks/registry.ts`); every other state T can hold at the carve step is carvable too.
 */
const CARVES = new Uint8Array(256);
CARVES[1] = CARVABLE_[STONE_]!;
/** `carveColumn`'s wet′ per column position `lz·16 + lx`. */
const WET = new Float64Array(256);

/** The carver kind's tag (`CAVE_KIND`). */
function tagOf(kind: CarverKind): number {
  return kind === 'worm' ? K_WORM : kind === 'ravine' ? K_RAVINE : K_UNDER;
}

/** wet′ at world (x, z) of the sample's column: clamp(4·wetMask, 0, 1), the default tree's wet′ at voxel level. */
export function wetAt(s: ColumnSample, x: number, z: number): number {
  return CLAMP(4 * READ_FIELD(s, 'wetMask', x, z), 0, 1);
}

/** max(σ_i, σ_u) at y for a path of `kind` (σ_u for underground worms only). */
function shrinkIU(p: CarverParams, kind: CarverKind, y: number): number {
  const lim = p.limits;
  const si = CLAMP((y - lim.capTop + 8 + lim.bandSpan) * (1 / lim.bandSpan), 0, 1);
  if (kind !== 'undergroundWorm') return si;
  const su = CLAMP((y - p.undergroundWorms.maxY + UNDER_SPAN) * (1 / UNDER_SPAN), 0, 1);
  return su > si ? su : si;
}

/** σ_w at y, for wet′ `wet` and the position's density top `densityTop`. */
function shrinkW(p: CarverParams, y: number, wet: number, densityTop: number): number {
  const lim = p.limits;
  return wet * CLAMP((lim.waterDepth + 8 + lim.bandSpan - (densityTop - y)) * (1 / (8 + lim.bandSpan)), 0, 1);
}

/**
 * The shrink σ = max(σ_w, σ_i, σ_u) (spec §2.4) at y for a path of `kind`, with wet′ `wet` at the voxel's (x, z) and
 * its position's density top `densityTop`: the carve test is `d < 1 − σ`.
 */
export function carveShrink(p: CarverParams, kind: CarverKind, y: number, wet: number, densityTop: number): number {
  const siu = shrinkIU(p, kind, y);
  const sw = shrinkW(p, y, wet, densityTop);
  return sw > siu ? sw : siu;
}

/**
 * The per-voxel carve test (spec §2.4): 1 when ellipsoid `e` of `path` carves voxel (x, y, z), else 0, with `wet` the
 * voxel's wet′ (`wetAt`) and `densityTop` its position's density top. With `densityTop` NaN, −1 when the answer needs
 * it (wet′ > 0 and the ellipsoid holds the voxel under σ_i and σ_u alone), so a probe reads the top only then. The
 * voxel's solidity is the caller's to check.
 */
export function carveTest(
  p: CarverParams, path: CarverPath, e: number, x: number, y: number, z: number, wet: number, densityTop: number,
): number {
  if (y <= Y0) return 0;
  const ell = path.ell;
  const o = 6 * e;
  const rh = ell[o + 3]!;
  const rv = ell[o + 4]!;
  const dx = (x + 0.5 - ell[o]!) / rh;
  const dz = (z + 0.5 - ell[o + 2]!) / rh;
  const dy = (y + 0.5 - ell[o + 1]!) / rv;
  const ws = path.widthSq;
  const w = ws === null ? 1 : ws[y - Y0]!;
  const d = dx * dx * w + dz * dz * w + dy * dy;
  // σ ≥ 0, so 1 − σ ≤ 1: d ≥ 1 is never carved.
  if (!(d < 1)) return 0;
  if (path.kind !== 'ravine' && !(dy > ell[o + 5]!)) return 0;
  const siu = shrinkIU(p, path.kind, y);
  if (!(d < 1 - siu)) return 0;
  if (wet > 0) {
    if (densityTop !== densityTop) return NEED_TOP;
    const sw = shrinkW(p, y, wet, densityTop);
    if (!(d < 1 - (sw > siu ? sw : siu))) return 0;
  }
  return 1;
}

/**
 * The density top of a position (spec §2.4), from its solidity after the density fill `isSolid(y)` (y −63 … 319): the
 * highest solid y, −65 when there is none (y −64, the bedrock, never counts); with `islands` (`islands.enabled`) the
 * top of the highest maximal solid run whose bottom lies below `ISLAND_RUN_MIN_BOTTOM` (water v0's base rule), −65 when
 * there is none. One implementation for T (a reader over its filled solidity), the point probes and the reference.
 */
export function densityTopOf(isSolid: (y: number) => boolean, islands: boolean): number {
  if (!islands) {
    for (let y = TOP_Y; y > Y0; y--) if (isSolid(y)) return y;
    return NO_TOP;
  }
  // The highest solid voxel at y ≤ 180 lies in that run (a run with a lower bottom has a voxel there); then up its run.
  let y = ISLAND_BOTTOM - 1;
  while (y > Y0 && !isSolid(y)) y--;
  if (y === Y0) return NO_TOP;
  while (y < TOP_Y && isSolid(y + 1)) y++;
  return y;
}

/** The window's paths that meet one column, as (path, ellipsoid, voxel range) entries in the window's order. */
interface ColumnPaths {
  valid: boolean;
  cx: number;
  cz: number;
  count: number;
  readonly paths: CarverPath[];
  readonly ells: number[];
  /** 6 per entry: xlo, xhi, ylo, yhi, zlo, zhi (world coordinates, inclusive; a superset of the voxels it can carve). */
  readonly ranges: number[];
}

const LISTS = new WeakMap<CarverCache, ColumnPaths>();

/**
 * The entries of column (cx, cz) through `cache`, rebuilt when the column changes. An ellipsoid's range holds every
 * voxel of the column whose centre lies within (centre ± rh) horizontally and (centre ± rv) vertically, widened by a
 * block (the test decides: a voxel outside the open box has d ≥ 1), clipped to the column and to y −63 … 319.
 */
function columnPaths(cache: CarverCache, cx: number, cz: number): ColumnPaths {
  let L = LISTS.get(cache);
  if (L === undefined) {
    L = { valid: false, cx: 0, cz: 0, count: 0, paths: [], ells: [], ranges: [] };
    LISTS.set(cache, L);
  }
  if (L.valid && L.cx === cx && L.cz === cz) return L;
  const x0 = 16 * cx, z0 = 16 * cz;
  const x1 = x0 + 15, z1 = z0 + 15;
  const paths = L.paths, ells = L.ells, ranges = L.ranges;
  let n = 0;
  for (let sz = cz - R; sz <= cz + R; sz++) {
    for (let sx = cx - R; sx <= cx + R; sx++) {
      for (let k = 0; k < 3; k++) {
        const path = cache.path(KINDS[k]!, sx, sz);
        if (path === null) continue;
        const b = path.box;
        if (b[3]! < x0 - 1 || b[0]! > x1 + 1 || b[5]! < z0 - 1 || b[2]! > z1 + 1 || b[4]! < Y0 || b[1]! > TOP_Y + 1) continue;
        const ell = path.ell;
        for (let e = 0; e < path.count; e++) {
          const o = 6 * e;
          const ex = ell[o]!, ey = ell[o + 1]!, ez = ell[o + 2]!, rh = ell[o + 3]!, rv = ell[o + 4]!;
          const xlo = Math.max(x0, Math.floor(ex - rh) - 1), xhi = Math.min(x1, Math.ceil(ex + rh) + 1);
          if (xlo > xhi) continue;
          const zlo = Math.max(z0, Math.floor(ez - rh) - 1), zhi = Math.min(z1, Math.ceil(ez + rh) + 1);
          if (zlo > zhi) continue;
          const ylo = Math.max(Y0 + 1, Math.floor(ey - rv) - 1), yhi = Math.min(TOP_Y, Math.ceil(ey + rv) + 1);
          if (ylo > yhi) continue;
          paths[n] = path;
          ells[n] = e;
          const r = 6 * n;
          ranges[r] = xlo;
          ranges[r + 1] = xhi;
          ranges[r + 2] = ylo;
          ranges[r + 3] = yhi;
          ranges[r + 4] = zlo;
          ranges[r + 5] = zhi;
          n++;
        }
      }
    }
  }
  paths.length = n;
  ells.length = n;
  ranges.length = 6 * n;
  L.count = n;
  L.cx = cx;
  L.cz = cz;
  L.valid = true;
  return L;
}

/**
 * Carves column (cx, cz) (spec §2.4): every voxel the density fill left solid in `solid` (98,304 entries, 1 solid, in
 * `fillDensityColumn`'s index `((y + 64)·16 + lz)·16 + lx`) that a path of the window carves becomes 0, and its entry
 * of `tags` (same index; when not null) takes the kind of the first such source in the window's order unless it is
 * already non-zero. `s` is the column's sample (for wet′), `densityTop[lz·16 + lx]` each position's density top
 * (`densityTopOf` over the fill, before carving). No `stop()`: the T stage polls once before calling it. Throws a
 * RangeError on other sizes.
 */
export function carveColumn(
  cache: CarverCache, p: CarverParams, s: ColumnSample, cx: number, cz: number, solid: Uint8Array, densityTop: Int16Array,
  tags: Uint8Array | null,
): void {
  if (solid.length !== 98304 || densityTop.length !== 256 || (tags !== null && tags.length !== 98304)) {
    throw new RangeError('carveColumn: solid and tags need 98,304 entries, densityTop 256');
  }
  const x0 = 16 * cx, z0 = 16 * cz;
  for (let q = 0; q < 256; q++) WET[q] = wetAt(s, x0 + (q & 15), z0 + (q >> 4));
  const L = columnPaths(cache, cx, cz);
  const paths = L.paths, ells = L.ells, ranges = L.ranges;
  for (let k = 0; k < L.count; k++) {
    const path = paths[k]!;
    const e = ells[k]!;
    const tag = tagOf(path.kind);
    const r = 6 * k;
    const xlo = ranges[r]!, xhi = ranges[r + 1]!, ylo = ranges[r + 2]!, yhi = ranges[r + 3]!, zlo = ranges[r + 4]!, zhi = ranges[r + 5]!;
    for (let y = ylo; y <= yhi; y++) {
      const row = (y - Y0) << 8;
      for (let z = zlo; z <= zhi; z++) {
        const zq = (z - z0) << 4;
        for (let x = xlo; x <= xhi; x++) {
          const q = zq | (x - x0);
          const v = row | q;
          if (CARVES[solid[v]!] !== 1) continue;
          if (carveTest(p, path, e, x, y, z, WET[q]!, densityTop[q]!) !== 1) continue;
          solid[v] = 0;
          if (tags !== null && tags[v] === 0) tags[v] = tag;
        }
      }
    }
  }
}

/**
 * The carver kind that carves voxel (x, y, z) (`CAVE_KIND`'s worm, ravine or underground worm: the first source in the
 * window's order whose ellipsoid carves it), 0 when none; `s` is the voxel's column sample and `densityTopAt()` its
 * position's density top, called only when some ellipsoid holds the voxel and its wet′ is above 0. The result means
 * anything only for a voxel the density fill leaves solid (ruling P19): it then equals `carveColumn`'s tag there.
 */
export function carvedKind(
  cache: CarverCache, p: CarverParams, s: ColumnSample, x: number, y: number, z: number, densityTopAt: () => number,
): number {
  if (y <= Y0 || y > TOP_Y) return 0;
  const L = columnPaths(cache, Math.floor(x / 16), Math.floor(z / 16));
  const paths = L.paths, ells = L.ells, ranges = L.ranges;
  const wet = wetAt(s, x, z);
  let top = Number.NaN;
  for (let k = 0; k < L.count; k++) {
    const r = 6 * k;
    if (x < ranges[r]! || x > ranges[r + 1]! || y < ranges[r + 2]! || y > ranges[r + 3]! || z < ranges[r + 4]! || z > ranges[r + 5]!) continue;
    const path = paths[k]!;
    let hit = carveTest(p, path, ells[k]!, x, y, z, wet, top);
    if (hit === NEED_TOP) {
      top = densityTopAt();
      hit = carveTest(p, path, ells[k]!, x, y, z, wet, top);
    }
    if (hit === 1) return tagOf(path.kind);
  }
  return 0;
}

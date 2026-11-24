/**
 * The cave tag (SP6a spec §3.2, D17, D20): the cave kind T writes per voxel into the store's `cave` channel, a pure
 * function of the voxel (`CAVE_KIND`, `core/constants.ts`). Steps 1-3 here (the noise kinds and 9); step 4, the carver
 * kinds, is the carve's (`carveColumn` tags the voxels it carves before the tag pass, which skips them; `caveTagAt`
 * reads it through `carvedAt`).
 * 1. a solid final block is 0; y −64 is always bedrock, so 0;
 * 2. pre-cave solidity is `precave > 0` (T + detailG), else `terrain > 0` without a `precave` tap; with neither tap it is
 *    unknown and density air is 0 (only carver kinds are tagged); air that is not pre-cave solid (sky, surface air) is 0;
 * 3. density air: keep = −1e6 where pillars·(1/16) < `caves.pillars.threshold`, else pillars (−∞ without a `pillars`
 *    tap), caves = max(min(the present E, C, S3, S2), keep); the candidates are those families when caves ≤ 0 and the
 *    noodle when noodle ≤ 0, the lowest value wins, ties in the order E, C, S3, S2, noodle (so pillar rock a noodle opens
 *    is a noodle); density air no candidate explains is 9;
 * 4. a voxel the density left solid and a carver carved: the kind of the first source in the window's order whose
 *    ellipsoid carved it (worm, ravine or underground worm).
 * The values come through the compiled tap readers (`CompiledDensity.tapReader`) at the voxel registers `atVoxel` sets:
 * a cell the fill evaluated voxel by voxel or decided air after its corners has its corners, and a cell decided air
 * before them is sky wherever the pre-cave tap's interval there is ≤ 0 (its voxels 0 without evaluation); otherwise (a
 * tree whose muted taps decide cells air before their corners) the tag evaluates the cell's corners first.
 * `caveTagAt` is the rule at one voxel (SP6a spec §3.4, D22), equal to T's stored tag voxel for voxel (DT2's `tagProbe`).
 * `caveTagBatch` is the slice's `caves` field (SP6a spec §7.4, D13): per sample the tag, or `CAVE_SLICE_SOLID` for a
 * solid voxel, evaluated chunk column by chunk column so that a column's ColumnSample, corners, carver window and path
 * list are shared by all its samples: `chunkColumnOrder` groups the samples and `caveTagRun` tags a run of the order
 * (the slice's part calls the two itself, polling its stop between columns).
 *
 * The cell tags (SP6a ruling R13, output-keeping). With the compile's bounds (`cellTags`), corners, and the taps
 * `precave`, the four families, `pillars` and `noodle` all outside `interpolated`, a cell to tag that holds density air
 * first takes its nodes' intervals from its corner hulls (`cellIntervalCorners`): they hold each tap's value at every
 * voxel of the cell. Where they decide steps 2 and 3 alike at every voxel (the pre-cave tap ≤ 0 everywhere: 0; else
 * > 0 everywhere, one family strictly below the other three, the pillar keep and the `caves ≤ 0` test one-sided, and the
 * noodle above 0, or at most 0 and below the lowest family), every density-air voxel of the cell takes that kind
 * without reading its taps; otherwise each is tagged by `tagVoxel`. The comparisons that decide are strict where the
 * rule's are, so no voxel is a tie, and the kind is `tagVoxel`'s.
 * The pre-tags (Task 31p, output-keeping). The T stage passes a `PreTags` to its density fill as the fill's hooks
 * (`FillHooks`): at each cell whose corner interval the fill computes it records the cell's kind, and at each air voxel the fill evaluates in a cell with no kind it records the voxel's kind while the compile's
 * registers still hold that voxel, so the taps `voxelFn` just evaluated are read from its memo. `tagColumn` given them
 * runs neither the cell's interval nor those voxels' taps again: a cell's corner interval is a function of the cell
 * and its corners alone, and a voxel's kind of the voxel alone, so the tags are the same.
 * `nearestCave` is the Caves tab's finder (SP6a spec §7.3, D12, D16): the search core of the pool's `findCave` job, its
 * clock, its stop and its loaded columns injected; `nearestCaveBiome` is its biome form (SP6b spec §9.3, D11), on the
 * same rings (`searchRings`), the core of a `findCave` with a `biome`.
 * Follows the gen determinism rules.
 */
import { CARVER_WINDOW_R, CAVE_BIOME, CAVE_KIND, CAVE_SLICE_SOLID, caveBiomeOf, caveKindOf } from '../../core/constants';
import { inWindow } from '../../core/coords';
import type { ColumnView } from '../../world/store/api';
import { caveBiomeAt, caveBiomeInputsAt, caveY0, cavePickerOf } from '../biomes/cavePicker';
import { newPointRecord, samplePoint } from '../column/columnPoint';
import type { DensityBounds, FillHooks } from '../density/bounds';
import type { CompiledDensity } from '../density/compile';
import type { DensityContext } from '../density/context';
import { probe } from '../density/probe';
import { findTap } from '../density/reference';
import { carvedAt } from './carve';
import { carverCacheOf } from './carverCache';
import type { CarverKind } from './carvers';

const KIND = CAVE_KIND;
const KIND_OF = caveKindOf;
const CAVE_BIOME_OF = caveBiomeOf;
const K_CHEESE: number = KIND.cheese;
const K_SPAG3D: number = KIND.spaghetti3d;
const K_SPAG2D: number = KIND.spaghetti2d;
const K_NOODLE: number = KIND.noodle;
const K_ENTRANCE: number = KIND.entrance;
const K_OTHER: number = KIND.other;
const SOLID_CODE = CAVE_SLICE_SOLID;
const FIND_TAP = findTap;
const PROBE = probe;
const CARVED_AT = carvedAt;
const FINITE = Number.isFinite;
const IN_WINDOW = inWindow;
const CACHE_OF = carverCacheOf;
const WINDOW_R = CARVER_WINDOW_R;
const K_WORM: number = KIND.worm;
const K_RAVINE: number = KIND.ravine;
const K_UNDER: number = KIND.undergroundWorm;

/** The taps of the cell tags, in `cellKind`'s order. */
const CELL_TAPS = ['precave', 'entrances', 'cheese', 'spag3d', 'spag2d', 'pillars', 'noodle'] as const;
/** The family kinds by `CELL_TAPS` index (1 … 4: E, C, S3, S2). */
const FAMILY_KINDS = Int32Array.of(0, K_ENTRANCE, K_CHEESE, K_SPAG3D, K_SPAG2D);

/** The interval scratch of `tagColumn`'s pre-cave check. */
const IV = new Float64Array(2);

/** The tap readers the tag reads (null where the tree has no such tap reachable from its root). */
export interface CaveReaders {
  readonly precave: (() => number) | null;
  readonly terrain: (() => number) | null;
  readonly entrances: (() => number) | null;
  readonly cheese: (() => number) | null;
  readonly spaghetti3d: (() => number) | null;
  readonly spaghetti2d: (() => number) | null;
  readonly pillars: (() => number) | null;
  readonly noodle: (() => number) | null;
}

/** The readers of one compile and the node of its pre-cave tap (`precave`, else `terrain`; −1 for neither). */
interface Resolved {
  readonly readers: CaveReaders;
  readonly preNode: number;
  /** The cell tags' tap nodes (`CELL_TAPS`), each outside `interpolated`; null when one is missing or inside. */
  readonly cellNodes: Int32Array | null;
}

const RESOLVED = new WeakMap<CompiledDensity, Resolved>();

/** The node of tap `name` that its reader reads (its first occurrence reachable from the root, by placement), or −1. */
function tapNode(c: CompiledDensity, name: string): number {
  const found = FIND_TAP(c.expr, name);
  if (found === undefined) return -1;
  // A tap name is unique in a tree, so the tap and the placement name one node.
  for (let id = 0; id < c.nodes.length; id++) {
    const n = c.nodes[id]!;
    if (n.op === 'tap' && n.inside === found.inside && (n.expr as { name: string }).name === name) return id;
  }
  return -1;
}

function resolve(c: CompiledDensity): Resolved {
  let r = RESOLVED.get(c);
  if (r === undefined) {
    const readers: CaveReaders = Object.freeze({
      precave: c.tapReader('precave'),
      terrain: c.tapReader('terrain'),
      entrances: c.tapReader('entrances'),
      cheese: c.tapReader('cheese'),
      spaghetti3d: c.tapReader('spag3d'),
      spaghetti2d: c.tapReader('spag2d'),
      pillars: c.tapReader('pillars'),
      noodle: c.tapReader('noodle'),
    });
    const pre = tapNode(c, 'precave');
    const ids = CELL_TAPS.map((name) => tapNode(c, name));
    const cellNodes = ids.every((id) => id >= 0 && !c.nodes[id]!.inside) ? Int32Array.from(ids) : null;
    r = { readers, preNode: pre >= 0 ? pre : tapNode(c, 'terrain'), cellNodes };
    RESOLVED.set(c, r);
  }
  return r;
}

/**
 * The readers of the taps `precave`, `terrain`, `entrances`, `cheese`, `spag3d`, `spag2d`, `pillars` and `noodle` of
 * `c` (memoised per compile: the same object on every call).
 */
export function caveReadersOf(c: CompiledDensity): CaveReaders {
  return resolve(c).readers;
}

/**
 * §3.2's steps 2-3 at voxel (lx, y, lz) of `c`'s current column: a voxel above y −64 that the density made air, whose
 * cell's corners are ready (or of a tree without slots). Sets the voxel registers (`atVoxel`), then reads the taps
 * through `r` (`caveReadersOf(c)`); `pillarThreshold` is `caves.pillars.threshold`. Returns the kind (0 for air that is
 * not pre-cave solid, or whose pre-cave solidity no tap tells).
 */
export function tagVoxel(c: CompiledDensity, r: CaveReaders, pillarThreshold: number, lx: number, y: number, lz: number): number {
  c.atVoxel(lx, y, lz);
  return tagCurrentVoxel(r, pillarThreshold);
}

/**
 * `tagVoxel` at the voxel the compile's registers hold (its last `voxelFn` or `atVoxel` call), without setting them
 * again: right after `voxelFn` there, the taps it evaluated are read from its memo, not evaluated again.
 */
function tagCurrentVoxel(r: CaveReaders, pillarThreshold: number): number {
  const pre = r.precave ?? r.terrain;
  if (pre === null || !(pre() > 0)) return 0;
  const fe = r.entrances, fc = r.cheese, f3 = r.spaghetti3d, f2 = r.spaghetti2d, fp = r.pillars, fn = r.noodle;
  const e = fe === null ? Infinity : fe();
  const ch = fc === null ? Infinity : fc();
  const s3 = f3 === null ? Infinity : f3();
  const s2 = f2 === null ? Infinity : f2();
  let lowest = e, kind = fe === null ? K_OTHER : K_ENTRANCE;
  if (fc !== null && ch < lowest) { lowest = ch; kind = K_CHEESE; }
  if (f3 !== null && s3 < lowest) { lowest = s3; kind = K_SPAG3D; }
  if (f2 !== null && s2 < lowest) { lowest = s2; kind = K_SPAG2D; }
  let keep = -Infinity;
  if (fp !== null) {
    const pv = fp();
    keep = pv * 0.0625 < pillarThreshold ? -1e6 : pv;
  }
  // max(min(E, C, S3, S2), keep) as the tree's `max` evaluates it (`b > a ? b : a`).
  const caves = keep > lowest ? keep : lowest;
  let best = Infinity, out = K_OTHER;
  if (caves <= 0) { best = lowest; out = kind; }
  if (fn !== null) {
    const nv = fn();
    if (nv <= 0 && nv < best) out = K_NOODLE;
  }
  return out;
}

/**
 * The kind §3.2's rule gives every density-air voxel of a cell whose tap intervals are `iv` at nodes `nd` (`CELL_TAPS`),
 * or −1 when they do not decide one (the header's "cell tags").
 */
function cellKind(iv: Float64Array, nd: Int32Array, th: number): number {
  for (let q = 0; q < 7; q++) {
    const o = 2 * nd[q]!;
    if (!(FINITE(iv[o]!) && FINITE(iv[o + 1]!))) return -1;
  }
  const pre = 2 * nd[0]!;
  if (iv[pre + 1]! <= 0) return 0;
  if (!(iv[pre]! > 0)) return -1;
  // The lowest of E, C, S3, S2: the family whose high end is below every other's low end.
  let fam = -1;
  for (let q = 1; q <= 4 && fam < 0; q++) {
    const h = iv[2 * nd[q]! + 1]!;
    let below = true;
    for (let o = 1; o <= 4; o++) if (o !== q && !(h < iv[2 * nd[o]!]!)) { below = false; break; }
    if (below) fam = q;
  }
  if (fam < 0) return -1;
  const lLo = iv[2 * nd[fam]!]!, lHi = iv[2 * nd[fam]! + 1]!;
  const pLo = iv[2 * nd[5]!]!, pHi = iv[2 * nd[5]! + 1]!;
  // caves = max(lowest, keep): keep −1e6 where pillars·(1/16) < th (a product by a power of 2, monotone), else pillars.
  let cLo: number, cHi: number;
  if (pHi * 0.0625 < th) {
    if (!(lLo > -1e6)) return -1;
    cLo = lLo;
    cHi = lHi;
  } else if (pLo * 0.0625 >= th) {
    if (pHi < lLo) { cLo = lLo; cHi = lHi; } else if (pLo > lHi) { cLo = pLo; cHi = pHi; } else return -1;
  } else return -1;
  let kind: number, bestLo: number;
  if (cHi <= 0) { kind = FAMILY_KINDS[fam]!; bestLo = lLo; } else if (cLo > 0) { kind = K_OTHER; bestLo = Infinity; } else return -1;
  const nLo = iv[2 * nd[6]!]!, nHi = iv[2 * nd[6]! + 1]!;
  if (nLo > 0) return kind;
  if (nHi <= 0 && nHi < bestLo) return K_NOODLE;
  return -1;
}

/** `PreTags.kinds`' entry for a cell whose corner interval the fill did not compute. */
const NOT_COMPUTED = -2;
/** `PreTags.voxels`' entry for a voxel the fill did not tag. */
const NO_TAG = 255;

/**
 * The tag pass's work done during the density fill (Task 31p, output-keeping): the `FillHooks` of a `fillDensityColumn`
 * call, recording per cell whose corner interval the fill computed its cell kind (`cellKind` on that interval, −1 when
 * it decides none, or always −1 without the cell tags), and at each air voxel the fill evaluated in a cell with no kind
 * its `tagVoxel` kind, read from what `voxelFn` memoised. A cell's corner interval is a function of the cell and its
 * corners alone, and a voxel's kind of the voxel alone, so `tagColumn` given them tags exactly as without them, but
 * runs neither again.
 */
export interface PreTags extends FillHooks {
  /** Per cell `(ck·4 + cj)·4 + ci`: its kind as the fill found it, or NOT_COMPUTED (−2). */
  readonly kinds: Int8Array;
  /** Per voxel `((y + 64)·16 + lz)·16 + lx`: its kind as the fill found it, or NO_TAG (255). */
  readonly voxels: Uint8Array;
  /** Clears both and binds the hooks to `bounds` (its compile's tap readers) and `pillarThreshold`: call before each fill. */
  begin(bounds: DensityBounds, pillarThreshold: number): void;
}

/** A fresh `PreTags` (98,304 + 768 bytes). */
export function createPreTags(): PreTags {
  const kinds = new Int8Array(768), voxels = new Uint8Array(98304);
  let ivs: Float64Array | null = null, readers: CaveReaders | null = null, nodes: Int32Array | null = null, th = 0;
  return {
    kinds,
    voxels,
    begin(bounds, pillarThreshold) {
      kinds.fill(NOT_COMPUTED);
      voxels.fill(NO_TAG);
      const c = bounds.compiled, res = resolve(c);
      ivs = bounds.nodeIntervals;
      readers = res.readers;
      th = pillarThreshold;
      nodes = c.interpolatedSlotCount > 0 && bounds.cellTags ? res.cellNodes : null;
    },
    corners(cell) {
      kinds[cell] = nodes === null ? -1 : cellKind(ivs!, nodes, th);
    },
    air(j) {
      // The cell (j >> 11, (j >> 6) & 3, (j >> 2) & 3): a cell with a kind tags its voxels without their taps.
      if (kinds[((j >> 11) << 4) | (((j >> 6) & 3) << 2) | ((j >> 2) & 3)]! >= 0) return;
      voxels[j] = tagCurrentVoxel(readers!, th);
    },
  };
}

/** Whether cell (ci, ck, cj) holds a density-air voxel above y −64: air in `solid` that the carve did not tag in `out`. */
function hasAir(solid: Uint8Array, out: Uint8Array, ci: number, ck: number, cj: number): boolean {
  const y0 = -64 + 8 * ck;
  for (let y = y0 < -63 ? -63 : y0; y < y0 + 8; y++) {
    for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
      const row = ((y + 64) * 16 + lz) * 16 + 4 * ci;
      for (let v = row; v < row + 4; v++) if (solid[v] === 0 && out[v] === 0) return true;
    }
  }
  return false;
}

/**
 * The tag pass of one column (§3.2), right after `fillDensityColumn` on `c`'s bounds left the column current: `solid`
 * (98,304 entries, `((y + 64)·16 + lz)·16 + lx`) and `cells` (768 entries, 1 where the fill evaluated the cell's corners
 * or its voxels) are the fill's; `out` (98,304 entries) is cleared, then receives `tagVoxel` at each density-air voxel
 * above y −64 that may be pre-cave solid. A cell the fill decided solid is skipped; a cell decided air before its corners
 * is skipped where the pre-cave tap's interval over it (`bounds.nodeInterval`, the compile's own bounds) is ≤ 0, and
 * otherwise has its corners evaluated first (always so without `bounds`: exact, only slower). With `carved` (the T
 * stage, after `carveColumn`), `solid` is the carved solidity and `out` already holds the carve's tags (§3.2 step 4: a
 * carver kind exactly at the voxels it carved, 0 elsewhere) and is not cleared: a voxel is density air where it is air
 * and untagged, and a carved voxel keeps its carver kind. A non-null `pre` (`PreTags`, begun with `bounds` and
 * `pillarThreshold` before the fill that left `solid` and `cells`, and passed to it as its hooks) gives the cell kinds and
 * voxel kinds that fill computed, which are used instead of computing them again (the same tags). Throws a RangeError
 * on other sizes, an Error when `bounds` is not `c`'s.
 */
export function tagColumn(
  c: CompiledDensity, r: CaveReaders, pillarThreshold: number, solid: Uint8Array, cells: Uint8Array, out: Uint8Array,
  bounds: DensityBounds | null = null, carved = false, pre: PreTags | null = null,
): void {
  if (solid.length !== 98304 || out.length !== 98304 || cells.length !== 768) {
    throw new RangeError('tagColumn: solid and out need 98,304 entries, cells 768');
  }
  if (bounds !== null && bounds.compiled !== c) throw new Error('tagColumn: the bounds are not the compiled density\'s');
  if (!carved) out.fill(0);
  if (r.precave === null && r.terrain === null) return;
  const res = resolve(c), preNode = res.preNode;
  const slots = c.interpolatedSlotCount > 0;
  // The cell tags: with the compile's bounds, corners and the seven taps outside `interpolated`.
  const cellNodes = slots && bounds !== null && bounds.cellTags ? res.cellNodes : null;
  for (let ck = 0; ck < 48; ck++) {
    const y0 = -64 + 8 * ck;
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        const cell = (ck * 4 + cj) * 4 + ci;
        if (cells[cell] === 0) {
          // Decided before its corners: uniformly solid (tag 0, or the carve's), or air.
          const first = ((y0 + 64) * 16 + 4 * cj) * 16 + 4 * ci;
          if (solid[first] !== 0 || out[first] !== 0) continue;
          if (bounds !== null && preNode >= 0) {
            bounds.nodeInterval(ci, ck, cj, preNode, IV, 0);
            if (IV[1]! <= 0) continue;
          }
          if (slots) c.cellCorners(ci, ck, cj);
        }
        let kind = -1;
        if (cellNodes !== null) {
          // A cell decided solid after its corners has nothing to tag.
          if (!hasAir(solid, out, ci, ck, cj)) continue;
          kind = pre !== null ? pre.kinds[cell]! : NOT_COMPUTED;
          if (kind === NOT_COMPUTED) {
            bounds!.cellIntervalCorners(ci, ck, cj, IV, 0);
            kind = cellKind(bounds!.nodeIntervals, cellNodes, pillarThreshold);
          }
        }
        for (let y = y0 < -63 ? -63 : y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            const row = ((y + 64) * 16 + lz) * 16;
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              if (solid[row + lx] !== 0 || out[row + lx] !== 0) continue;
              if (kind >= 0) out[row + lx] = kind;
              else if (pre !== null && pre.voxels[row + lx] !== NO_TAG) out[row + lx] = pre.voxels[row + lx]!;
              else out[row + lx] = tagVoxel(c, r, pillarThreshold, lx, y, lz);
            }
          }
        }
      }
    }
  }
}

/**
 * The cave tag of world voxel (x, y, z) (SP6a spec §3.2, §3.4, D22): 0 at y −64; where the final density is > 0 (`probe`
 * on `dc`, which makes the column current and readies the voxel's cell corners) the carver kind that carved it (step 4,
 * `carvedAt`; 0 where none did); else `tagVoxel` with `dc`'s `caves.pillars.threshold`. Equals the T stage's stored tag
 * at every voxel. Integers only, y in −64 … 319, (x, z) in the world window, as `probe` (a RangeError otherwise).
 */
export function caveTagAt(dc: DensityContext, x: number, y: number, z: number): number {
  const v = PROBE(dc, x, y, z);
  if (y === -64) return 0;
  if (v > 0) return CARVED_AT(dc, x, y, z);
  const c = dc.compiled;
  return tagVoxel(c, resolve(c).readers, dc.ctx.params.caves.pillars.threshold, x & 15, y, z & 15);
}

/**
 * The `caves` slice field at the samples (xs[q], ys[q], zs[q]) (SP6a spec §7.4, D13), into `out[q]`: the cave tag where
 * it is not 0 (`caveTagAt`: a noise kind 1-5, 9, or a carver kind 6-8), else `CAVE_SLICE_SOLID` where the voxel is solid
 * (`solidAt`, and y −64, which T always makes bedrock), else 0 (open air: sky, surface air, water's air). The samples are
 * visited grouped by chunk column (one sort of their indices by column), so that each column is made current once
 * (`dc.column`: its ColumnSample, columnFn and positionFn), its cell corners are evaluated once, and the carvers' window,
 * sources and path list (`carvedAt`) and the density-top memo are built once for all its samples; the values are those
 * of `caveTagAt` and `solidAt` at each sample, whatever the order (pure). Integers only, y in −64 … 319, (x, z) in the
 * world window (a RangeError otherwise, as `probe`); the four arrays of one length (a RangeError otherwise).
 */
export function caveTagBatch(dc: DensityContext, xs: Int32Array, ys: Int32Array, zs: Int32Array, out: Uint8Array): void {
  const count = xs.length;
  if (ys.length !== count || zs.length !== count || out.length !== count) throw new RangeError('caveTagBatch: xs, ys, zs and out need one length');
  caveTagRun(dc, xs, ys, zs, chunkColumnOrder(xs, zs).order, 0, count, out);
}

/**
 * The samples (xs[q], zs[q]) grouped by chunk column (Task 52, minors-13: one grouping for `caveTagBatch` and the slice's
 * `caves` part, `gen/inspect/fieldSlice.ts`): `keys[q]` = (cx + 2^15)·2^16 + (cz + 2^15) (chunk coordinates of the world
 * window lie in [−2^15, 2^15)), and `order` the indices 0 … n − 1 sorted by key, then index, so each column's samples are
 * one run of `order`, in index order.
 */
export function chunkColumnOrder(xs: Int32Array, zs: Int32Array): { keys: Float64Array; order: Int32Array } {
  const count = xs.length;
  const keys = new Float64Array(count);
  const order = new Int32Array(count);
  for (let q = 0; q < count; q++) {
    keys[q] = ((xs[q]! >> 4) + 32768) * 65536 + ((zs[q]! >> 4) + 32768);
    order[q] = q;
  }
  order.sort((a, b) => keys[a]! - keys[b]! || a - b);
  return { keys, order };
}

/**
 * `caveTagBatch`'s codes at the samples order[from … to), into out[q] for each such q (every other out[q] untouched):
 * visited in that order, so a run of one chunk column (`chunkColumnOrder`) makes the column current once. The same
 * values in any order (pure). Throws a RangeError, before writing anything, unless xs, ys, zs, order and out have one
 * length n, from and to are integers with 0 ≤ from ≤ to ≤ n and order[from … to) lie in 0 … n − 1 (Task 52c, as
 * `caveTagBatch`); a sample's coordinates are checked by `probe` (a RangeError otherwise).
 */
export function caveTagRun(
  dc: DensityContext, xs: Int32Array, ys: Int32Array, zs: Int32Array, order: Int32Array, from: number, to: number, out: Uint8Array,
): void {
  const count = xs.length;
  if (ys.length !== count || zs.length !== count || order.length !== count || out.length !== count) {
    throw new RangeError('caveTagRun: xs, ys, zs, order and out need one length');
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > count) {
    throw new RangeError(`caveTagRun: [${from}, ${to}) is not a range of the ${count} order entries`);
  }
  for (let t = from; t < to; t++) {
    const q = order[t]!;
    if (q < 0 || q >= count) throw new RangeError(`caveTagRun: order[${t}] = ${q} is not a sample index 0 … ${count - 1}`);
  }
  const c = dc.compiled;
  const readers = resolve(c).readers;
  const th = dc.ctx.params.caves.pillars.threshold;
  for (let t = from; t < to; t++) {
    const q = order[t]!;
    const x = xs[q]!, y = ys[q]!, z = zs[q]!;
    const v = PROBE(dc, x, y, z);
    if (y === -64) out[q] = SOLID_CODE;
    else if (v > 0) {
      const k = CARVED_AT(dc, x, y, z);
      out[q] = k !== 0 ? k : SOLID_CODE;
    } else out[q] = tagVoxel(c, readers, th, x & 15, y, z & 15);
  }
}

/** A cave the finder found (SP6a spec §7.3): the air voxel (x, y, z) and a yaw along the cave, in degrees (0 faces −z). */
export interface CaveHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

/**
 * Why a search ended: `found` (a hit), `radius` (none within the radius), `budget` (the deadline passed before a hit) or
 * `stopped` (`stop()` turned true).
 */
export type FindReason = 'found' | 'radius' | 'budget' | 'stopped';

/** A search's outcome: the hit (only with `found`) and the reason it ended. */
export interface FindResult {
  readonly hit: CaveHit | null;
  readonly reason: FindReason;
}

/**
 * What a search is given: its `radius` in blocks (an integer ≥ 1; the Caves tab's is 512 for a kind, 1,024 for a cave
 * biome); its `deadline` on the clock `now` (the job's is the time it started plus 2 s); `stop`, true once the search
 * must end (the job's epoch cell moved); and `loaded`, the stored view of a column the world holds, or null (the job's
 * shared store: its final set, else its proto set). A view `loaded` returns is read only until the next call of `loaded`
 * or `stop` (the job's read section ends there).
 */
export interface FindOptions {
  readonly radius: number;
  readonly deadline: number;
  now(): number;
  stop(): boolean;
  loaded(cx: number, cz: number): ColumnView | null;
}

/** The finder's ring width in blocks (SP6a spec §7.3). */
const RING = 64;
const STOPPED: FindResult = Object.freeze({ hit: null, reason: 'stopped' });
const BUDGET: FindResult = Object.freeze({ hit: null, reason: 'budget' });
const RADIUS: FindResult = Object.freeze({ hit: null, reason: 'radius' });

/** A column's key in the finder's sets: (cx + 2^15)·2^16 + (cz + 2^15), exact for the world window's columns. */
const colKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

/** The carver kind of cave kind `kind` (worm, ravine, underground worm), or null for a noise kind. */
function carverOf(kind: number): CarverKind | null {
  return kind === K_WORM ? 'worm' : kind === K_RAVINE ? 'ravine' : kind === K_UNDER ? 'undergroundWorm' : null;
}

/** The index of the finder's ring that holds horizontal squared distance `d2` (integer arithmetic, exact). */
function ringOf(d2: number): number {
  let k = Math.floor(Math.sqrt(d2) / RING);
  while ((k + 1) * RING * (k + 1) * RING <= d2) k++;
  while (k > 0 && k * RING * k * RING > d2) k--;
  return k;
}

/** The best hit of a ring search so far: its squared 3D distance from the start (Infinity: none yet) and its voxel. */
interface Best {
  d2: number;
  x: number;
  y: number;
  z: number;
}

/**
 * One ring of a search (`searchRings`): its index, its outer radius (cut at the search's), its squared bounds and its
 * columns nearest first, as triples (the column's nearest squared horizontal distance to the start, cx, cz).
 */
interface Ring {
  readonly index: number;
  readonly rOut: number;
  readonly in2: number;
  readonly out2: number;
  readonly cols: readonly number[];
}

/** What a ring's search beyond the loaded columns asks of `searchRings`: go on, end `stopped`, or end at the deadline. */
const GO = 0;
const HALT = 1;
const LATE = 2;
type Step = typeof GO | typeof HALT | typeof LATE;

/**
 * The finders' rings (SP6a spec §7.3; SP6b spec §9.3): outward from the voxel (x, y, z) in rings of 64 blocks of
 * horizontal distance (ring k holds the voxels whose horizontal distance d from (x, z) lies in [64k, 64k + 64), the last
 * ring cut at `o.radius`), and in each ring 1. its loaded columns' stored cave bytes (`sectionCave`; a voxel matches
 * where `(byte >> shift) & 15` is `want`: the kind at shift 0, the cave biome at shift 4; a uniform section's byte holds
 * at every voxel), then 2. `beyond`, the ring's other columns (the start's searcher; it reads and writes `best` and skips
 * the columns in `loadedCols`). The columns are visited nearest first, and nothing farther than the best hit so far is
 * read. The first ring with a hit returns the hit nearest (x, y, z) (ties keep the first found) with its `yaw` (given the
 * hit's stored view when its column is loaded, else null). `now()` and `stop()` are polled every loaded column: `stop()`
 * true returns `stopped`; `now() ≥ deadline` returns the best hit so far, else `budget`; `beyond` asks the same through its
 * Step. No ring reaches past `radius`: no hit returns `radius`.
 */
function searchRings(
  x: number, y: number, z: number, o: FindOptions, shift: number, want: number,
  beyond: (g: Ring, best: Best, loadedCols: ReadonlySet<number>) => Step,
  yaw: (hx: number, hy: number, hz: number, view: ColumnView | null) => number,
): FindResult {
  const radius = o.radius;
  const loadedCols = new Set<number>();
  const best: Best = { d2: Infinity, x: 0, y: 0, z: 0 };

  /** The best hit so far as a result, with its yaw. */
  const found = (): FindResult => {
    const { x: bx, y: by, z: bz } = best;
    return { hit: { x: bx, y: by, z: bz, yaw: yaw(bx, by, bz, loadedCols.has(colKey(bx >> 4, bz >> 4)) ? o.loaded(bx >> 4, bz >> 4) : null) }, reason: 'found' };
  };
  /** The result once the deadline passed: the ring's best hit so far, else `budget`. */
  const late = (): FindResult => (best.d2 < Infinity ? found() : BUDGET);

  for (let r = 0, ring = 0; r < radius; r += RING, ring++) {
    const rOut = r + RING < radius ? r + RING : radius;
    const in2 = r * r, out2 = rOut * rOut;
    // The ring's columns: those holding a voxel at a horizontal distance in [r, rOut), with their nearest squared distance.
    const found3: number[] = [];
    for (let cz = (z - rOut + 1) >> 4; cz <= (z + rOut - 1) >> 4; cz++) {
      const z0 = 16 * cz, z1 = z0 + 15;
      const dzMin = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
      const dzMax = z - z0 > z1 - z ? z - z0 : z1 - z;
      for (let cx = (x - rOut + 1) >> 4; cx <= (x + rOut - 1) >> 4; cx++) {
        const x0 = 16 * cx, x1 = x0 + 15;
        if (!IN_WINDOW(x0, z0) || !IN_WINDOW(x1, z1)) continue;
        const dxMin = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        const dxMax = x - x0 > x1 - x ? x - x0 : x1 - x;
        const dMin = dxMin * dxMin + dzMin * dzMin;
        if (dMin < out2 && dxMax * dxMax + dzMax * dzMax >= in2) found3.push(dMin, cx, cz);
      }
    }
    const n = found3.length / 3;
    const order: number[] = [];
    for (let q = 0; q < n; q++) order.push(q);
    order.sort((a, b) => found3[3 * a]! - found3[3 * b]! || a - b);
    const cols: number[] = [];
    for (let t = 0; t < n; t++) {
      const q = 3 * order[t]!;
      cols.push(found3[q]!, found3[q + 1]!, found3[q + 2]!);
    }

    // 1. The loaded columns' stored bytes.
    for (let q = 0; q < cols.length; q += 3) {
      const dMin = cols[q]!;
      if (dMin >= best.d2) break;
      if (o.stop()) return STOPPED;
      if (o.now() >= o.deadline) return late();
      const cx = cols[q + 1]!, cz = cols[q + 2]!;
      const v = o.loaded(cx, cz);
      if (v === null) continue;
      loadedCols.add(colKey(cx, cz));
      for (let sy = 0; sy < 24; sy++) {
        const y0 = -64 + 16 * sy;
        const dyMin = y < y0 ? y0 - y : y > y0 + 15 ? y - y0 - 15 : 0;
        if (dMin + dyMin * dyMin >= best.d2) continue;
        const sec = v.sectionCave(sy);
        if (typeof sec === 'number' && ((sec >> shift) & 15) !== want) continue;
        const arr = typeof sec === 'number' ? null : sec;
        for (let i = sy === 0 ? 256 : 0; i < 4096; i++) {
          if (arr !== null && ((arr[i]! >> shift) & 15) !== want) continue;
          const vx = 16 * cx + (i & 15), vz = 16 * cz + ((i >> 4) & 15), vy = y0 + (i >> 8);
          const dx = vx - x, dz = vz - z;
          const dh2 = dx * dx + dz * dz;
          if (dh2 < in2 || dh2 >= out2) continue;
          const dy = vy - y;
          const d2 = dh2 + dy * dy;
          if (d2 < best.d2) { best.d2 = d2; best.x = vx; best.y = vy; best.z = vz; }
        }
      }
    }

    // 2. The ring's other columns.
    const step = beyond({ index: ring, rOut, in2, out2, cols }, best, loadedCols);
    if (step === HALT) return STOPPED;
    if (step === LATE) return late();
    if (best.d2 < Infinity) return found();
  }
  return RADIUS;
}

/** Throws the finders' RangeError unless (x, y, z) is an integer voxel with (x, z) in the world window and the radius an integer ≥ 1. */
function checkStart(name: string, x: number, y: number, z: number, o: FindOptions): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !IN_WINDOW(x, z)) {
    throw new RangeError(`${name}: (${x}, ${y}, ${z}) is not an integer voxel with (x, z) in the world window`);
  }
  if (!Number.isInteger(o.radius) || o.radius < 1) throw new RangeError(`${name}: radius ${o.radius} is not an integer ≥ 1`);
}

/**
 * The nearest cave of kind `kind` (1-9, `CAVE_KIND`) from the voxel (x, y, z) (integers, (x, z) in the world window), the
 * Caves tab's finder (SP6a spec §7.3, D12, D16). It searches outward in rings of 64 blocks of horizontal distance (ring
 * k holds the voxels whose horizontal distance d from (x, z), d² = (vx − x)² + (vz − z)², lies in [64k, 64k + 64), the
 * last ring cut at `radius`; `searchRings`), and in each ring:
 * 1. the ring's loaded columns (`loaded`): their stored tags (`sectionCave`, the kind read through `caveKindOf`: bits
 *    4-7 hold the cave biome, SP6b spec §2.1; a uniform section of the kind holds it at every voxel);
 * 2. for a carver kind (worm, ravine, underground worm), candidates from the paths of the path cache with no density
 *    over the ring: the ellipsoid centres (each floored to its voxel) of the sources whose paths can reach the ring
 *    (the sources within `CARVER_WINDOW_R` chunks of the ring's chunks, visited once each, in shells around (x, z)'s
 *    chunk), nearest (x, y, z) first, each in a column not loaded confirmed by one `caveTagAt` at that voxel: a centre in
 *    density air, where a noise kind wins (§3.2 step 3), above the ground, where nothing is carved, or carved first by
 *    another kind fails and the next is tried, so density is evaluated only at the candidates tried;
 * 3. for a noise kind, in the ring's columns not loaded, `caveTagAt` at one voxel per density cell (the 4 × 8 × 4
 *    lattice: (4i + 2, −60 + 8k, 4j + 2) of each column) whose horizontal distance lies in the ring.
 * The columns are visited nearest first, and nothing farther from (x, y, z) than the best hit so far is read. The first
 * ring with a hit returns the hit nearest (x, y, z) (squared 3D distance; ties keep the first found), its yaw along the
 * cave: the horizontal axis with the longer run of the same kind from the hit inside its column (x on a tie), facing
 * the longer side (+x 90, −x 270, +z 180, −z 0; the positive side on a tie). `now()` and `stop()` are polled every
 * column (and every candidate): `stop()` true returns `stopped`; `now() ≥ deadline` returns the best hit of the ring so
 * far, else `budget`. No ring reaches past `radius`: no hit returns `radius`. Throws a RangeError on other arguments.
 */
export function nearestCave(dc: DensityContext, kind: number, x: number, y: number, z: number, o: FindOptions): FindResult {
  if (!Number.isInteger(kind) || kind < 1 || kind > 9) throw new RangeError(`nearestCave: kind ${kind} is not a cave kind 1-9`);
  checkStart('nearestCave', x, y, z, o);
  const radius = o.radius;
  const carver = carverOf(kind);
  const cache = carver === null ? null : CACHE_OF(dc.ctx);
  const scx = x >> 4, scz = z >> 4;
  const r2Max = radius * radius;
  // The carver candidates per ring: d², x, y, z.
  const pending: number[][] = [];
  for (let r = 0; r < radius; r += RING) pending.push([]);
  let shells = -1;

  /** Visits the sources of shell `s` (Chebyshev chunk distance s from (x, z)'s chunk), queueing their centres. */
  const visitShell = (s: number): void => {
    for (let sz = scz - s; sz <= scz + s; sz++) {
      const edge = sz === scz - s || sz === scz + s;
      for (let sx = scx - s; sx <= scx + s; sx += edge || s === 0 ? 1 : 2 * s) {
        const path = cache!.path(carver!, sx, sz);
        if (path === null) continue;
        const ell = path.ell;
        for (let e = 0; e < path.count; e++) {
          const ex = Math.floor(ell[6 * e]!), ey = Math.floor(ell[6 * e + 1]!), ez = Math.floor(ell[6 * e + 2]!);
          if (ey <= -64 || ey > 319 || !IN_WINDOW(ex, ez)) continue;
          const dx = ex - x, dz = ez - z;
          const dh2 = dx * dx + dz * dz;
          if (dh2 >= r2Max) continue;
          const dy = ey - y;
          pending[ringOf(dh2)]!.push(dh2 + dy * dy, ex, ey, ez);
        }
      }
    }
  };

  const beyond = (g: Ring, best: Best, loadedCols: ReadonlySet<number>): Step => {
    if (carver !== null) {
      // 2. The carver candidates: every source that can reach this ring visited, then its centres nearest first.
      const need = ((g.rOut + 15) >> 4) + 1 + WINDOW_R;
      while (shells < need) {
        if (o.stop()) return HALT;
        if (o.now() >= o.deadline) return LATE;
        visitShell(++shells);
      }
      const cand = pending[g.index]!;
      const m = cand.length / 4;
      const byDist: number[] = [];
      for (let q = 0; q < m; q++) byDist.push(q);
      byDist.sort((a, b) => cand[4 * a]! - cand[4 * b]! || a - b);
      for (let t = 0; t < m; t++) {
        const q = 4 * byDist[t]!;
        if (cand[q]! >= best.d2) break;
        const vx = cand[q + 1]!, vy = cand[q + 2]!, vz = cand[q + 3]!;
        // A loaded column's stored tags were read in 1.
        if (loadedCols.has(colKey(vx >> 4, vz >> 4))) continue;
        if (o.stop()) return HALT;
        if (o.now() >= o.deadline) return LATE;
        if (caveTagAt(dc, vx, vy, vz) === kind) {
          best.d2 = cand[q]!;
          best.x = vx; best.y = vy; best.z = vz;
          break;
        }
      }
      return GO;
    }
    // 3. The noise kinds: one voxel per density cell of the columns not loaded.
    const { cols, in2, out2 } = g;
    for (let q = 0; q < cols.length; q += 3) {
      if (cols[q]! >= best.d2) break;
      const cx = cols[q + 1]!, cz = cols[q + 2]!;
      if (loadedCols.has(colKey(cx, cz))) continue;
      if (o.stop()) return HALT;
      if (o.now() >= o.deadline) return LATE;
      for (let cj = 0; cj < 4; cj++) {
        const vz = 16 * cz + 4 * cj + 2;
        for (let ci = 0; ci < 4; ci++) {
          const vx = 16 * cx + 4 * ci + 2;
          const dx = vx - x, dz = vz - z;
          const dh2 = dx * dx + dz * dz;
          if (dh2 < in2 || dh2 >= out2 || dh2 >= best.d2) continue;
          for (let vy = -60; vy < 320; vy += 8) {
            const dy = vy - y;
            const d2 = dh2 + dy * dy;
            if (d2 >= best.d2) continue;
            if (caveTagAt(dc, vx, vy, vz) === kind) { best.d2 = d2; best.x = vx; best.y = vy; best.z = vz; }
          }
        }
      }
    }
    return GO;
  };

  // The yaw: runs of the same kind, read from the stored view through `caveKindOf`, else through `caveTagAt`.
  return searchRings(x, y, z, o, 0, kind, beyond, (hx, hy, hz, view) => yawAt(hx, hz, (px, pz) =>
    (view !== null ? KIND_OF(view.cave(px & 15, hy, pz & 15)) : caveTagAt(dc, px, hy, pz)) === kind));
}

/**
 * The biome finder's prefilter slack in the perturbed climate's uniform units, beside `borderWarp` × 2 (the border
 * noises' whole range): the most C, E or H moves between a column's centre and any position within 4 blocks of the
 * column (J's limit) is 0.24 (measured at seed '42' over 600 columns spread over ±32,000 blocks; p99 0.17).
 */
const FIND_CLIMATE_SLACK = 0.25;
/**
 * The prefilter's slack in blocks on the depth window, beside depthWarp × 2 (the depth noise's whole range) and
 * edgeJitter (the voxel's jy): the most surfaceEst moves between a column's centre and any position within 4 blocks of
 * the column is 43.5 (measured with `FIND_CLIMATE_SLACK`; p99 36.5).
 */
const FIND_SURFACE_SLACK = 48;
const PICKER_OF = cavePickerOf;
const INPUTS_AT = caveBiomeInputsAt;
const Y0_OF = caveY0;
const BIOME_AT = caveBiomeAt;
const SAMPLE = samplePoint;
const NEW_POINT = newPointRecord;
const BIOME = CAVE_BIOME;
const B_LUSH: number = BIOME.lush;
const B_DRIPSTONE: number = BIOME.dripstone;
const B_ABYSS: number = BIOME.abyss;
/** The prefilter's point and noise scratch. */
const FIND_POINT = NEW_POINT();
const FIND_NB = new Float64Array(4);

/**
 * The nearest cave voxel of cave biome `biome` (1 lush, 2 dripstone, 3 abyss; `CAVE_BIOME`) from the voxel (x, y, z)
 * (integers, (x, z) in the world window), the Caves tab's biome finder (SP6b spec §9.3, D11), on `nearestCave`'s rings
 * (`searchRings`, with its polls, its `budget`, `stopped` and `radius`), and in each ring:
 * 1. the ring's loaded columns: their stored bytes whose bits 4-7 (`caveBiomeOf`) hold the biome (T writes it only at
 *    tagged voxels; a uniform section of it holds it at every voxel);
 * 2. beyond them, a 2D prefilter on a 16-block grid of column-stage points: each column's centre (16·cx + 8, 16·cz + 8),
 *    a quart corner where `samplePoint` equals the column's ColumnSample, with the border and depth noises
 *    (`caveBiomeInputsAt`) and Y0 (`caveY0`); the column is kept when its perturbed climate meets the biome's box (lush
 *    H′ ≥ hMin, dripstone C′ ≥ cMin, abyss E′ ≤ eMax and C′ > cMin) within `FIND_CLIMATE_SLACK` + 2·borderWarp, and its
 *    depth window [Y0 − D·depthMax, Y0 − D·depthMin] (the abyss: below Y0 − D·depthMin), widened by
 *    `FIND_SURFACE_SLACK` + 2·depthWarp + edgeJitter blocks, meets −64 … 319; then, at the density-cell lattice voxels
 *    (4i + 2, −60 + 8k, 4j + 2) of a kept column inside that window and the ring, a hit is a voxel whose `caveBiomeAt` is
 *    the biome (the nibble T writes at a tagged voxel) and whose `caveTagAt` is not 0 (tagged).
 * The hit's yaw follows the runs of the biome from it inside its column (the stored nibble, else a tagged voxel with that
 * `caveBiomeAt`), as `nearestCave`'s. Throws a RangeError on other arguments.
 */
export function nearestCaveBiome(dc: DensityContext, biome: number, x: number, y: number, z: number, o: FindOptions): FindResult {
  if (!Number.isInteger(biome) || biome < B_LUSH || biome > B_ABYSS) throw new RangeError(`nearestCaveBiome: biome ${biome} is not a cave biome 1-3`);
  checkStart('nearestCaveBiome', x, y, z, o);
  const inp = PICKER_OF(dc.ctx);
  const st = inp.settings;
  const w = st.borderWarp;
  const climateSlack = FIND_CLIMATE_SLACK + 2 * w;
  const ySlack = FIND_SURFACE_SLACK + 2 * st.depthWarp + st.edgeJitter;
  // The depth window's bounds below Y0, in blocks, widened by the slack: the top at D·depthMin, the bottom at D·depthMax
  // (the abyss: none).
  const depthMin = biome === B_LUSH ? st.lush.depthMin : biome === B_DRIPSTONE ? st.dripstone.depthMin : st.abyss.depthMin;
  const depthMax = biome === B_LUSH ? st.lush.depthMax : biome === B_DRIPSTONE ? st.dripstone.depthMax : Infinity;
  const belowTop = st.depthScale * depthMin - ySlack;
  const belowBottom = st.depthScale * depthMax + ySlack;
  /** Whether a perturbed climate (C′, E′, H′) meets the biome's box within the slack. */
  const climateMeets = (c: number, e: number, h: number): boolean =>
    biome === B_LUSH ? h >= st.lush.hMin - climateSlack
      : biome === B_DRIPSTONE ? c >= st.dripstone.cMin - climateSlack
        : e <= st.abyss.eMax + climateSlack && c > st.abyss.cMin - climateSlack;
  /** Whether voxel (vx, vy, vz) is a tagged voxel of the biome. */
  const isBiome = (vx: number, vy: number, vz: number): boolean => BIOME_AT(dc, vx, vy, vz) === biome && caveTagAt(dc, vx, vy, vz) !== 0;

  const beyond = (g: Ring, best: Best, loadedCols: ReadonlySet<number>): Step => {
    const { cols, in2, out2 } = g;
    for (let q = 0; q < cols.length; q += 3) {
      if (cols[q]! >= best.d2) break;
      const cx = cols[q + 1]!, cz = cols[q + 2]!;
      if (loadedCols.has(colKey(cx, cz))) continue;
      if (o.stop()) return HALT;
      if (o.now() >= o.deadline) return LATE;
      // The prefilter at the column's centre.
      const px = 16 * cx + 8, pz = 16 * cz + 8;
      const p = SAMPLE(dc.ctx, px, pz, false, FIND_POINT);
      INPUTS_AT(inp, px, pz, FIND_NB);
      if (!climateMeets(p.C + w * FIND_NB[0]!, p.E + w * FIND_NB[1]!, p.H + w * FIND_NB[2]!)) continue;
      const y0 = Y0_OF(st, p.surfaceEst, FIND_NB[3]!);
      const top = y0 - belowTop, bottom = y0 - belowBottom;
      if (top < -64 || bottom > 319) continue;
      for (let cj = 0; cj < 4; cj++) {
        const vz = 16 * cz + 4 * cj + 2;
        for (let ci = 0; ci < 4; ci++) {
          const vx = 16 * cx + 4 * ci + 2;
          const dx = vx - x, dz = vz - z;
          const dh2 = dx * dx + dz * dz;
          if (dh2 < in2 || dh2 >= out2 || dh2 >= best.d2) continue;
          for (let vy = -60; vy < 320; vy += 8) {
            if (vy < bottom || vy > top) continue;
            const dy = vy - y;
            const d2 = dh2 + dy * dy;
            if (d2 >= best.d2) continue;
            if (isBiome(vx, vy, vz)) { best.d2 = d2; best.x = vx; best.y = vy; best.z = vz; }
          }
        }
      }
    }
    return GO;
  };

  // The yaw: runs of the biome, read from the stored view's nibbles, else tagged voxels with that `caveBiomeAt`.
  return searchRings(x, y, z, o, 4, biome, beyond, (hx, hy, hz, view) => yawAt(hx, hz, (px, pz) =>
    (view !== null ? CAVE_BIOME_OF(view.cave(px & 15, hy, pz & 15)) === biome : isBiome(px, hy, pz))));
}

/**
 * The finders' yaw at hit (x, ·, z) (`nearestCave`, `nearestCaveBiome`): the runs from the hit along ±x and ±z inside its
 * column of the voxels at the hit's height where `is(px, pz)` holds, the axis with the longer total run (x on a tie),
 * facing its longer side (the positive one on a tie): +x 90, −x 270, +z 180, −z 0.
 */
function yawAt(x: number, z: number, is: (px: number, pz: number) => boolean): number {
  const cx = x >> 4, cz = z >> 4;
  const run = (sx: number, sz: number): number => {
    let n = 0;
    for (let s = 1; s < 16; s++) {
      const px = x + s * sx, pz = z + s * sz;
      if (px >> 4 !== cx || pz >> 4 !== cz) break;
      if (!is(px, pz)) break;
      n++;
    }
    return n;
  };
  const px = run(1, 0), nx = run(-1, 0), pz = run(0, 1), nz = run(0, -1);
  if (px + nx >= pz + nz) return px >= nx ? 90 : 270;
  return pz >= nz ? 180 : 0;
}

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
 * list are shared by all its samples.
 *
 * The cell tags (SP6a ruling R13, output-keeping). With the compile's bounds (`cellTags`), corners, and the taps
 * `precave`, the four families, `pillars` and `noodle` all outside `interpolated`, a cell to tag that holds density air
 * first takes its nodes' intervals from its corner hulls (`cellIntervalCorners`): they hold each tap's value at every
 * voxel of the cell. Where they decide steps 2 and 3 alike at every voxel (the pre-cave tap ≤ 0 everywhere: 0; else
 * > 0 everywhere, one family strictly below the other three, the pillar keep and the `caves ≤ 0` test one-sided, and the
 * noodle above 0, or at most 0 and below the lowest family), every density-air voxel of the cell takes that kind
 * without reading its taps; otherwise each is tagged by `tagVoxel`. The comparisons that decide are strict where the
 * rule's are, so no voxel is a tie, and the kind is `tagVoxel`'s.
 * Follows the gen determinism rules.
 */
import { CAVE_KIND, CAVE_SLICE_SOLID } from '../../core/constants';
import type { DensityBounds } from '../density/bounds';
import type { CompiledDensity } from '../density/compile';
import type { DensityContext } from '../density/context';
import { probe } from '../density/probe';
import { findTap } from '../density/reference';
import { carvedAt } from './carve';

const KIND = CAVE_KIND;
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
 * and untagged, and a carved voxel keeps its carver kind. Throws a RangeError on other sizes, an Error when `bounds` is
 * not `c`'s.
 */
export function tagColumn(
  c: CompiledDensity, r: CaveReaders, pillarThreshold: number, solid: Uint8Array, cells: Uint8Array, out: Uint8Array,
  bounds: DensityBounds | null = null, carved = false,
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
          bounds!.cellIntervalCorners(ci, ck, cj, IV, 0);
          kind = cellKind(bounds!.nodeIntervals, cellNodes, pillarThreshold);
        }
        for (let y = y0 < -63 ? -63 : y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            const row = ((y + 64) * 16 + lz) * 16;
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              if (solid[row + lx] !== 0 || out[row + lx] !== 0) continue;
              out[row + lx] = kind >= 0 ? kind : tagVoxel(c, r, pillarThreshold, lx, y, lz);
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
  const keys = new Float64Array(count);
  const order = new Int32Array(count);
  for (let q = 0; q < count; q++) {
    // (cx + 2^15)·2^16 + (cz + 2^15): chunk coordinates of the world window lie in [−2^15, 2^15).
    keys[q] = ((xs[q]! >> 4) + 32768) * 65536 + ((zs[q]! >> 4) + 32768);
    order[q] = q;
  }
  order.sort((a, b) => keys[a]! - keys[b]! || a - b);
  const c = dc.compiled;
  const readers = resolve(c).readers;
  const th = dc.ctx.params.caves.pillars.threshold;
  for (let t = 0; t < count; t++) {
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

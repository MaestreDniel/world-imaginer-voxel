/**
 * The cave tag (SP6a spec §3.2, D17, D20): the cave kind T writes per voxel into the store's `cave` channel, a pure
 * function of the voxel (`CAVE_KIND`, `core/constants.ts`). Steps 1-3 here (the noise kinds and 9); step 4, the carver
 * kinds, comes with the carvers.
 * 1. a solid final block is 0; y −64 is always bedrock, so 0;
 * 2. pre-cave solidity is `precave > 0` (T + detailG), else `terrain > 0` without a `precave` tap; with neither tap it is
 *    unknown and density air is 0 (only carver kinds are tagged); air that is not pre-cave solid (sky, surface air) is 0;
 * 3. density air: keep = −1e6 where pillars·(1/16) < `caves.pillars.threshold`, else pillars (−∞ without a `pillars`
 *    tap), caves = max(min(the present E, C, S3, S2), keep); the candidates are those families when caves ≤ 0 and the
 *    noodle when noodle ≤ 0, the lowest value wins, ties in the order E, C, S3, S2, noodle (so pillar rock a noodle opens
 *    is a noodle); density air no candidate explains is 9.
 * The values come through the compiled tap readers (`CompiledDensity.tapReader`) at the voxel registers `atVoxel` sets:
 * a cell the fill evaluated voxel by voxel or decided air after its corners has its corners, and a cell decided air
 * before them is sky wherever the pre-cave tap's interval there is ≤ 0 (its voxels 0 without evaluation); otherwise (a
 * tree whose muted taps decide cells air before their corners) the tag evaluates the cell's corners first.
 * Follows the gen determinism rules.
 */
import { CAVE_KIND } from '../../core/constants';
import type { DensityBounds } from '../density/bounds';
import type { CompiledDensity } from '../density/compile';
import { findTap } from '../density/reference';

const KIND = CAVE_KIND;
const K_CHEESE: number = KIND.cheese;
const K_SPAG3D: number = KIND.spaghetti3d;
const K_SPAG2D: number = KIND.spaghetti2d;
const K_NOODLE: number = KIND.noodle;
const K_ENTRANCE: number = KIND.entrance;
const K_OTHER: number = KIND.other;
const FIND_TAP = findTap;

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
    r = { readers, preNode: pre >= 0 ? pre : tapNode(c, 'terrain') };
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
 * The tag pass of one column (§3.2), right after `fillDensityColumn` on `c`'s bounds left the column current: `solid`
 * (98,304 entries, `((y + 64)·16 + lz)·16 + lx`) and `cells` (768 entries, 1 where the fill evaluated the cell's corners
 * or its voxels) are the fill's; `out` (98,304 entries) is cleared, then receives `tagVoxel` at each density-air voxel
 * above y −64 that may be pre-cave solid. A cell the fill decided solid is skipped; a cell decided air before its corners
 * is skipped where the pre-cave tap's interval over it (`bounds.nodeInterval`, the compile's own bounds) is ≤ 0, and
 * otherwise has its corners evaluated first (always so without `bounds`: exact, only slower). Throws a RangeError on
 * other sizes, an Error when `bounds` is not `c`'s.
 */
export function tagColumn(
  c: CompiledDensity, r: CaveReaders, pillarThreshold: number, solid: Uint8Array, cells: Uint8Array, out: Uint8Array,
  bounds: DensityBounds | null = null,
): void {
  if (solid.length !== 98304 || out.length !== 98304 || cells.length !== 768) {
    throw new RangeError('tagColumn: solid and out need 98,304 entries, cells 768');
  }
  if (bounds !== null && bounds.compiled !== c) throw new Error('tagColumn: the bounds are not the compiled density\'s');
  out.fill(0);
  if (r.precave === null && r.terrain === null) return;
  const preNode = resolve(c).preNode;
  const slots = c.interpolatedSlotCount > 0;
  for (let ck = 0; ck < 48; ck++) {
    const y0 = -64 + 8 * ck;
    for (let cj = 0; cj < 4; cj++) {
      for (let ci = 0; ci < 4; ci++) {
        const cell = (ck * 4 + cj) * 4 + ci;
        if (cells[cell] === 0) {
          // Decided before its corners: uniformly solid (tag 0), or air.
          if (solid[((y0 + 64) * 16 + 4 * cj) * 16 + 4 * ci] !== 0) continue;
          if (bounds !== null && preNode >= 0) {
            bounds.nodeInterval(ci, ck, cj, preNode, IV, 0);
            if (IV[1]! <= 0) continue;
          }
          if (slots) c.cellCorners(ci, ck, cj);
        }
        for (let y = y0 < -63 ? -63 : y0; y < y0 + 8; y++) {
          for (let lz = 4 * cj; lz < 4 * cj + 4; lz++) {
            const row = ((y + 64) * 16 + lz) * 16;
            for (let lx = 4 * ci; lx < 4 * ci + 4; lx++) {
              if (solid[row + lx] !== 0) continue;
              out[row + lx] = tagVoxel(c, r, pillarThreshold, lx, y, lz);
            }
          }
        }
      }
    }
  }
}

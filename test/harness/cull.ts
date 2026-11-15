/**
 * R3's regions, poses, paths and replay (SP6b spec §12.4, D22): the harness side of `R3.wronglyCulled` and `R3.popIn`
 * in `test/metrics/caves.metric.ts`' biomes group. The walk under test is `src/render/culling/caveCulling.ts`'
 * culler, driven here as the renderer drives it; the reference is `raycastVisible` (`refs.ts`).
 *
 * - `r3Region`: one T region of the job (its proto blocks, read once and then released): the opacity bit per voxel
 *   (connectivity's predicate, PASS opaque with `fullFaces` 63), each section's `connectivity15` from its padded copy
 *   (the padding is not read), its fully-opaque flag, its non-empty flag (a non-air voxel with a non-opaque face
 *   neighbour, from the blocks without meshing; §12.4's `culledUnderground`), the pre-cave top per position, and
 *   sampled candidates in the central 8 × 8 chunks (tagged cave air, no fluid; opaque voxels ≥ 16 deep).
 * - `r3Poses` (plan): fast 8, quick 32, full 64 poses over the regions in turn, deterministic, all in the central
 *   8 × 8 chunks so RD 12's disc lies in the region: tagged cave air at several depths and kinds (eye ≥ 16 below the
 *   pre-cave top: underground; pitch +90 and −90 among them), surface poses, eyes within 0.5 block of a section face,
 *   edge and corner, an eye inside an opaque voxel, an eye above y 319 and one below −64 (`drawAll`), a sealed room
 *   opened by an edited wall (where the region allows, the room's far section reachable only through it), a pose with
 *   one disc column not revealed (counted open, §8.2; the column outside the seed box whose closing would hide the most
 *   seen sections).
 * - `r3Paths`: the five pose paths on one region: a walk through a doorway into a cavern (carved in solid rock),
 *   flight at two sections per walk at the median pre-cave top (in and out of hills), flight y 300 → 400 → 300, a
 *   teleport from inside rock to the surface (the new disc streaming in), a wall dug open into a sealed cave (at the
 *   room site with the longest walk). Pop-in can only show where the eye sees, at once, sections a fresh walk's first
 *   2,000 pops do not reach (they are breadth-first from the seed box), hence the flight and the teleport's choices.
 * - `r3PoseCounts`, `r3PathCounts`: the replay. Every column within RD (`dx² + dz² ≤ 12.5²` from the eye's column)
 *   is revealed (at once; after a teleport 32 a frame, nearest first) with its 24 `connectivity15` values, and retired
 *   beyond 14.5 (the removal lag); an edit is a swap of its column. Each frame: the reveals, `setCamera`, then
 *   `frame(n · 16.7 ms, 2,000 pops, no clock)` (the walk sliced at a fixed budget, deterministic in Node). The
 *   reference's rays pass through a column not revealed (it draws nothing, §8.2) and count only revealed columns'
 *   sections; a ray leaving the box of the revealed columns stops (it never re-enters a box).
 *   `wronglyCulled`: after the walk settles, the seen sections the culler does not draw. `popIn`: per frame, the seen
 *   sections the draw rule hides that frame (a frame with `drawAll`, or hiding nothing, reads 0 without casting).
 */
import { caveKindOf } from '../../src/core/constants';
import { connectivity15 } from '../../src/mesh/connectivity';
import { DEFAULT_MESH_TABLES, type MeshTables } from '../../src/mesh/greedy';
import { createCaveCuller, torusSlot, type CaveCuller } from '../../src/render/culling/caveCulling';
import { hasFluid } from '../../src/world/blocks/fluid';
import { AIR, BEDROCK } from '../../src/world/blocks/index';
import { ALL_FACES, PASS_OPAQUE } from '../../src/world/blocks/kinds';
import { createPaddedSection, padIndex, type PaddedSection } from '../../src/world/store/padded';
import type { CaveTier } from './caveSites';
import { raycastVisible } from './refs';
import type { RegionView } from './regionView';

/** RD of the replay (§12.4: poses in the central 8 × 8 chunks so RD 12 fits). */
export const R3_RD = 12;
/** The reference's cube-map resolution (§12.4: 6 × 128² directions). */
export const R3_FACE_RES = 128;
/** The walk's fixed budget per frame (§12.4). */
export const R3_POPS = 2000;
/** The poses per tier (§12.4). */
export const R3_POSE_COUNTS: Readonly<Record<CaveTier, number>> = { fast: 8, quick: 32, full: 64 };
/** A frame at 60 Hz, the replay's clock. */
const FRAME_MS = 1000 / 60;
/** Revealed columns are retired beyond RD + 2 (the removal lag). */
const RETIRE_R = R3_RD + 2.5;
/** After a teleport the new disc streams in this many columns a frame, nearest first. */
const STREAM_PER_FRAME = 32;
/** The central chunks, as offsets from the region's first chunk: 12 … 19 of 32. */
const CENTRE_LO = 12;
const CENTRE_HI = 19;
/** "Underground": the eye at least this far below the pre-cave top (§12.4). */
const UNDERGROUND = 16;
/** An eye's height above the voxel it stands on (surface poses). */
const EYE_HEIGHT = 1.62;
const SECTIONS = 24;
const Y_MIN = -64;
const HEIGHT = 384;
const OPEN = 0x7FFF;

/** One region of the job, read once from its proto blocks (see the header). */
export interface CaveRegion {
  readonly label: string;
  readonly cx0: number;
  readonly cz0: number;
  /** Columns per side (the region is square). */
  readonly size: number;
  /** The opacity bit per voxel, bit `((y + 64)·W + (z − 16·cz0))·W + (x − 16·cx0)`, W = 16·size. */
  readonly opaque: Uint32Array;
  /** `connectivity15` per section, `((cz − cz0)·size + (cx − cx0))·24 + sy`. */
  readonly conn: Uint16Array;
  /** 1 where every voxel of the section is opaque, by section. */
  readonly solid: Uint8Array;
  /** 1 where the section holds a non-air voxel with a non-opaque face neighbour, by section. */
  readonly nonEmpty: Uint8Array;
  /** The pre-cave top per position `(z − 16·cz0)·W + (x − 16·cx0)` (the highest voxel not air or tagged), −65 none. */
  readonly top: Int16Array;
  /**
   * Tagged cave air (no fluid) in the central chunks, sampled (on each axis a section-boundary voxel, local 0 or 15, or
   * one ≡ 1 mod 4): five ints per voxel, x, y, z, the cave kind, and how many of its coordinates lie on a section
   * boundary (0 … 3).
   */
  readonly caveAir: Int32Array;
  /** Opaque voxels at the central chunks' section centres (local 8, 8, 8) ≥ 16 below the pre-cave top: x, y, z. */
  readonly opaqueDeep: Int32Array;
}

/** The opacity of every block state (connectivity's predicate). */
function opaqueStates(t: MeshTables): Uint8Array {
  const out = new Uint8Array(t.pass.length);
  for (let s = 0; s < out.length; s++) out[s] = t.pass[s] === PASS_OPAQUE && t.fullFaces[s] === ALL_FACES ? 1 : 0;
  return out;
}

/** The 18 opacity bits of the row at x `lx0 − 1 … lx0 + 16` (lx0 a multiple of 16), y index Y, z index lz. */
function row18(bits: Uint32Array, W: number, lx0: number, Y: number, lz: number): number {
  // Below the world is bedrock (opaque), above it air; outside the region's x and z counts opaque.
  if (Y < 0 || lz < 0 || lz >= W) return 0x3FFFF;
  if (Y >= HEIGHT) return 0;
  const base = (Y * W + lz) * W;
  const b = base + lx0;
  const mid = (bits[b >>> 5]! >>> (b & 31)) & 0xFFFF;
  const l = lx0 === 0 ? 1 : (bits[(b - 1) >>> 5]! >>> ((b - 1) & 31)) & 1;
  const r = lx0 + 16 >= W ? 1 : (bits[(b + 16) >>> 5]! >>> ((b + 16) & 31)) & 1;
  return l | (mid << 1) | (r << 17);
}

/** The voxels of a 16-voxel row with a non-opaque face neighbour (bit k: x lx0 + k). */
function exposedRow(bits: Uint32Array, W: number, lx0: number, Y: number, lz: number): number {
  const c = row18(bits, W, lx0, Y, lz);
  const left = c & 0xFFFF;
  const right = (c >>> 2) & 0xFFFF;
  const up = (row18(bits, W, lx0, Y + 1, lz) >>> 1) & 0xFFFF;
  const down = (row18(bits, W, lx0, Y - 1, lz) >>> 1) & 0xFFFF;
  const north = (row18(bits, W, lx0, Y, lz - 1) >>> 1) & 0xFFFF;
  const south = (row18(bits, W, lx0, Y, lz + 1) >>> 1) & 0xFFFF;
  return ~(left & right & up & down & north & south) & 0xFFFF;
}

/** The opacity bits of a row (bit k: x lx0 + k). */
const opaqueRow = (bits: Uint32Array, W: number, lx0: number, Y: number, lz: number): number => {
  const b = (Y * W + lz) * W + lx0;
  return (bits[b >>> 5]! >>> (b & 31)) & 0xFFFF;
};

/**
 * Whether section (i, sy, k) of a region (column indices from the region's corner) is non-empty: some row's non-air
 * voxels (`nonAir(y, z)`, 16 bits) meet its exposed voxels.
 */
function sectionNonEmpty(bits: Uint32Array, W: number, i: number, sy: number, k: number, nonAir: (y: number, z: number) => number): boolean {
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      const n = nonAir(y, z);
      if (n !== 0 && (n & exposedRow(bits, W, 16 * i, 16 * sy + y, 16 * k + z)) !== 0) return true;
    }
  }
  return false;
}

/**
 * Reads one T region of the job (see the header): `view` covers it whole (its proto or final sets); the result holds
 * no reference to the store.
 */
export function r3Region(view: RegionView, label: string, t: MeshTables = DEFAULT_MESH_TABLES): CaveRegion {
  if (view.w !== view.h) throw new Error(`r3Region: ${label} is ${view.w} × ${view.h} (square only)`);
  const size = view.w;
  const W = 16 * size;
  const { cx0, cz0 } = view;
  const opaqueOf = opaqueStates(t);
  const opaque = new Uint32Array((HEIGHT * W * W) >>> 5);
  const conn = new Uint16Array(size * size * SECTIONS);
  const solid = new Uint8Array(size * size * SECTIONS);
  const nonEmpty = new Uint8Array(size * size * SECTIONS);
  const top = new Int16Array(W * W).fill(Y_MIN - 1);
  const caveAir: number[] = [];
  const opaqueDeep: number[] = [];
  const padded = createPaddedSection();
  const column = (cx: number, cz: number) => {
    const v = view.store.final(cx, cz) ?? view.store.proto(cx, cz);
    if (v === null) throw new Error(`r3Region: ${label}: column (${cx}, ${cz}) has no set`);
    return v;
  };
  for (let k = 0; k < size; k++) {
    for (let i = 0; i < size; i++) {
      const v = column(cx0 + i, cz0 + k);
      // The pre-cave top per position: the highest voxel not air or tagged.
      let found = 0;
      for (let sy = SECTIONS - 1; sy >= 0 && found < 256; sy--) {
        const b = v.sectionBlocks(sy);
        const c = v.sectionCave(sy);
        if (b === AIR && c === 0) continue;
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const q = (16 * k + z) * W + 16 * i + x;
            if (top[q] !== Y_MIN - 1) continue;
            for (let y = 15; y >= 0; y--) {
              const j = (y << 8) | (z << 4) | x;
              const blk = typeof b === 'number' ? b : b[j]!;
              const cav = typeof c === 'number' ? c : c[j]!;
              if (blk !== AIR || cav !== 0) {
                top[q] = 16 * sy + y + Y_MIN;
                found++;
                break;
              }
            }
          }
        }
      }
      const central = i >= CENTRE_LO && i <= CENTRE_HI && k >= CENTRE_LO && k <= CENTRE_HI;
      for (let sy = 0; sy < SECTIONS; sy++) {
        const s = (k * size + i) * SECTIONS + sy;
        const b = v.sectionBlocks(sy);
        if (typeof b === 'number') {
          const o = opaqueOf[b]!;
          solid[s] = o;
          conn[s] = o === 1 ? 0 : OPEN;
          if (o === 1) {
            for (let y = 0; y < 16; y++) {
              for (let z = 0; z < 16; z++) {
                const bit = ((16 * sy + y) * W + 16 * k + z) * W + 16 * i;
                opaque[bit >>> 5]! |= 0xFFFF << (bit & 31);
              }
            }
          }
        } else {
          let n = 0;
          for (let y = 0; y < 16; y++) {
            for (let z = 0; z < 16; z++) {
              const row = padIndex(0, y, z);
              const j0 = (y << 8) | (z << 4);
              let mask = 0;
              for (let x = 0; x < 16; x++) {
                const st = b[j0 | x]!;
                padded.blocks[row + x] = st;
                if (opaqueOf[st] === 1) mask |= 1 << x;
              }
              if (mask !== 0) {
                const bit = ((16 * sy + y) * W + 16 * k + z) * W + 16 * i;
                opaque[bit >>> 5]! |= mask << (bit & 31);
                for (let m = mask; m !== 0; m &= m - 1) n++;
              }
            }
          }
          solid[s] = n === 4096 ? 1 : 0;
          conn[s] = connectivity15(padded, t);
        }
        if (!central) continue;
        // Candidates: sampled tagged cave air with no fluid, and the opaque section centres (depth checked below).
        const c = v.sectionCave(sy);
        const f = v.sectionFluid(sy);
        if (typeof b === 'number' ? opaqueOf[b] === 1 : opaqueOf[b[(8 << 8) | (8 << 4) | 8]!] === 1) {
          opaqueDeep.push(16 * (cx0 + i) + 8, 16 * sy + Y_MIN + 8, 16 * (cz0 + k) + 8);
        }
        if (c === 0) continue;
        for (let j = 0; j < 4096; j++) {
          const x = j & 15;
          const z = (j >> 4) & 15;
          const y = j >> 8;
          const ex = x === 0 || x === 15;
          const ey = y === 0 || y === 15;
          const ez = z === 0 || z === 15;
          if ((!ex && (x & 3) !== 1) || (!ey && (y & 3) !== 1) || (!ez && (z & 3) !== 1)) continue;
          const kind = caveKindOf(typeof c === 'number' ? c : c[j]!);
          if (kind === 0) continue;
          if ((typeof b === 'number' ? b : b[j]!) !== AIR) continue;
          if (hasFluid(typeof f === 'number' ? f : f[j]!)) continue;
          caveAir.push(16 * (cx0 + i) + x, 16 * sy + Y_MIN + y, 16 * (cz0 + k) + z, kind, (ex ? 1 : 0) + (ey ? 1 : 0) + (ez ? 1 : 0));
        }
      }
    }
  }
  // Non-empty sections, over the finished opacity bits.
  const rows = new Uint16Array(256);
  for (let k = 0; k < size; k++) {
    for (let i = 0; i < size; i++) {
      const v = column(cx0 + i, cz0 + k);
      for (let sy = 0; sy < SECTIONS; sy++) {
        const b = v.sectionBlocks(sy);
        if (b === AIR) continue;
        if (typeof b === 'number') rows.fill(0xFFFF);
        else {
          for (let r = 0; r < 256; r++) {
            let m = 0;
            for (let x = 0; x < 16; x++) if (b[(r << 4) | x] !== AIR) m |= 1 << x;
            rows[r] = m;
          }
        }
        // rows[y·16 + z] is the row (y, z): the section layout's index over 16.
        if (sectionNonEmpty(opaque, W, i, sy, k, (y, z) => rows[(y << 4) | z]!)) nonEmpty[(k * size + i) * SECTIONS + sy] = 1;
      }
    }
  }
  const deep: number[] = [];
  for (let n = 0; n < opaqueDeep.length; n += 3) {
    const x = opaqueDeep[n]!, y = opaqueDeep[n + 1]!, z = opaqueDeep[n + 2]!;
    if (top[(z - 16 * cz0) * W + x - 16 * cx0]! - y >= UNDERGROUND) deep.push(x, y, z);
  }
  return {
    label, cx0, cz0, size, opaque, conn, solid, nonEmpty, top, caveAir: Int32Array.from(caveAir), opaqueDeep: Int32Array.from(deep),
  };
}

// ---------------------------------------------------------------- poses and paths

export type R3PoseKind = 'cave' | 'face' | 'edge' | 'corner' | 'surface' | 'opaque' | 'above' | 'below' | 'sealedRoom' | 'unrevealed';

/** A sealed room: the voxels carved before the first walk, and the wall voxel dug open after it (x, y, z triples). */
export interface R3Room {
  readonly carve: Int32Array;
  readonly dig: Int32Array;
}

export interface R3Pose {
  readonly kind: R3PoseKind;
  /** The index of its region in `r3Poses`' list. */
  readonly region: number;
  readonly eye: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  /** The eye ≥ 16 below the pre-cave top at its position. */
  readonly underground: boolean;
  /** The cave kind of the voxel the eye is in (0: none). */
  readonly caveKind: number;
  /** The disc column left unrevealed (§8.2: counted open), or null. */
  readonly unrevealed: readonly [cx: number, cz: number] | null;
  readonly room: R3Room | null;
}

/** The kinds in order: fast takes the first 8, quick the first 32, full 64 (the rest cycling). */
const FIRST_KINDS: readonly R3PoseKind[] = ['cave', 'sealedRoom', 'unrevealed', 'corner', 'surface', 'opaque', 'above', 'below'];
const MORE_KINDS: readonly R3PoseKind[] = [
  'cave', 'face', 'edge', 'cave', 'surface', 'corner', 'cave', 'face', 'unrevealed', 'edge', 'cave', 'sealedRoom',
  'opaque', 'cave', 'face', 'surface', 'edge', 'cave', 'corner', 'cave', 'face', 'edge', 'unrevealed', 'cave',
];
/** A deterministic spread over [0, 1): the k-th pick of a list. */
const spread = (k: number, phase: number): number => (k * 0.6180339887 + phase) % 1;
const pickIndex = (k: number, phase: number, n: number): number => Math.min(n - 1, Math.floor(spread(k, phase) * n));

/** The pre-cave top at (x, z) of `r`. */
const topAt = (r: CaveRegion, x: number, z: number): number => r.top[(z - 16 * r.cz0) * 16 * r.size + x - 16 * r.cx0]!;
/** Section index of chunk (cx, cz), section sy, in `r`. */
const sectionOf = (r: CaveRegion, cx: number, sy: number, cz: number): number => ((cz - r.cz0) * r.size + (cx - r.cx0)) * SECTIONS + sy;

/** A cave-air candidate: [x, y, z, kind, boundary count]. */
type Candidate = readonly [number, number, number, number, number];

/** The region's underground cave-air candidates with `nb` boundary coordinates (any with nb null). */
function underground(r: CaveRegion, nb: number | null): Candidate[] {
  const out: Candidate[] = [];
  const a = r.caveAir;
  for (let n = 0; n < a.length; n += 5) {
    const c: Candidate = [a[n]!, a[n + 1]!, a[n + 2]!, a[n + 3]!, a[n + 4]!];
    if (nb !== null && c[4] !== nb) continue;
    if (topAt(r, c[0], c[2]) - (c[1] + 0.5) < UNDERGROUND) continue;
    out.push(c);
  }
  return out;
}

/** The k-th cave pose of `r`: cycling the cave kinds present, at spread depths. */
function cavePick(r: CaveRegion, k: number): Candidate {
  const all = underground(r, null);
  if (all.length === 0) throw new Error(`r3Poses: ${r.label} has no underground cave air`);
  const kinds = [...new Set(all.map((c) => c[3]))].sort((a, b) => a - b);
  const kind = kinds[k % kinds.length]!;
  const ofKind = all.filter((c) => c[3] === kind)
    .sort((a, b) => (topAt(r, a[0], a[2]) - a[1]) - (topAt(r, b[0], b[2]) - b[1]) || a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  return ofKind[pickIndex(Math.floor(k / kinds.length), 0.25, ofKind.length)]!;
}

/** The eye in a candidate voxel: its centre, or 0.25 from each section face it lies on. */
function eyeIn(c: Candidate): [number, number, number] {
  const off = (v: number, local: number): number => v + (local === 0 ? 0.25 : local === 15 ? 0.75 : 0.5);
  return [off(c[0], c[0] & 15), off(c[1], (c[1] - Y_MIN) & 15), off(c[2], c[2] & 15)];
}

/**
 * The sealed-room sites: four fully opaque sections S, E, N, M in a row along +x, S's column central, underground;
 * `strict`, with M's other five neighbours fully opaque too, so that M (outside the seed box) is entered only through
 * N: a fully opaque section outside the box has no exit (`connectivity15` 0).
 */
function roomSites(r: CaveRegion, strict: boolean): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let sy = 1; sy <= 20; sy++) {
    for (let k = CENTRE_LO; k <= CENTRE_HI; k++) {
      for (let i = CENTRE_LO; i <= CENTRE_HI; i++) {
        const cx = r.cx0 + i, cz = r.cz0 + k;
        let ok = true;
        for (let d = 0; d < 4 && ok; d++) ok = r.solid[sectionOf(r, cx + d, sy, cz)] === 1;
        const around: ReadonlyArray<readonly [number, number, number]> = [[4, 0, 0], [3, 1, 0], [3, -1, 0], [3, 0, 1], [3, 0, -1]];
        if (strict) for (const [dx, dy, dz] of around) if (ok) ok = r.solid[sectionOf(r, cx + dx, sy + dy, cz + dz)] === 1;
        if (!ok) continue;
        if (topAt(r, 16 * cx + 8, 16 * cz + 7) - (16 * sy + Y_MIN + 7.5) < UNDERGROUND) continue;
        out.push([cx, sy, cz]);
      }
    }
  }
  return out;
}

/** Pushes every voxel of the box [x0, x1) × [y0, y1) × [z0, z1) onto `out`. */
function box(out: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) out.push(x, y, z);
}

/**
 * The sealed room at site (cx, sy, cz) (sections S, E, N, M along +x, all opaque): a 3 × 3 corridor from S's local
 * x 4 through E, a wall at N's local x 0, and a room through N into M's local x 0 … 3, both strictly inside the
 * sections' y and z (sealed); the dig opens the wall's middle voxel. The eye stands in S's corridor, two sections
 * before N, so the bit the dig adds (N's west to east) lies outside the seed box and decides whether M is reached.
 */
function sealedRoom(cx: number, sy: number, cz: number): { eye: [number, number, number]; room: R3Room } {
  const X = 16 * cx, Y = 16 * sy + Y_MIN, Z = 16 * cz;
  const carve: number[] = [];
  box(carve, X + 4, X + 32, Y + 6, Y + 9, Z + 6, Z + 9);
  box(carve, X + 33, X + 52, Y + 5, Y + 10, Z + 5, Z + 10);
  return { eye: [X + 8.5, Y + 7.5, Z + 7.5], room: { carve: Int32Array.from(carve), dig: Int32Array.of(X + 32, Y + 7, Z + 7) } };
}

/** 24 sections with no face joined: a column read as closed. */
const CLOSED = new Uint16Array(SECTIONS);

/**
 * The seen sections the settled walk from `eye` does not draw when column (cx, cz) is left unrevealed for the
 * reference (its rays pass through it) but given to the walk as revealed and closed: how much the pose depends on the
 * walk counting an unrevealed column open (§8.2).
 */
function closedMisses(r: CaveRegion, eye: readonly [number, number, number], cx: number, cz: number): number {
  const rp = newReplay(r, NONE, [cx, cz]);
  syncColumns(rp, eye);
  rp.culler.onReveal(columnKey(cx, cz), cx, cz, CLOSED);
  settle(rp, eye, 0, () => undefined);
  let n = 0;
  castSeen(rp, eye, (_s, sx, sy, sz) => { if (!rp.culler.drawn(sx, sy, sz)) n++; });
  return n;
}

/**
 * The column to leave unrevealed for an eye: of the disc's columns outside the seed box (≥ 2 columns from the eye's on
 * x or z), the eight holding the most sections the reference sees with every column revealed (row order on a tie),
 * the one whose closing would hide the most seen sections (`closedMisses`; the first of the eight on a tie), so the
 * pose depends on the walk counting it open; the column two east of the eye's when nothing beyond the box is seen.
 */
function openRuleColumn(r: CaveRegion, eye: readonly [number, number, number]): [number, number] {
  const rp = newReplay(r, NONE, null);
  syncColumns(rp, eye);
  const counts = new Map<number, number>();
  const ecx = Math.floor(eye[0]) >> 4, ecz = Math.floor(eye[2]) >> 4;
  castSeen(rp, eye, (_s, cx, _sy, cz) => {
    if (Math.max(Math.abs(cx - ecx), Math.abs(cz - ecz)) < 2) return;
    const col = (cz - r.cz0) * r.size + (cx - r.cx0);
    counts.set(col, (counts.get(col) ?? 0) + 1);
  });
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 8).map(([col]) => [r.cx0 + (col % r.size), r.cz0 + Math.floor(col / r.size)] as [number, number]);
  if (top.length === 0) return [ecx + 2, ecz];
  let best = top[0]!, most = -1;
  for (const c of top) {
    const n = closedMisses(r, eye, c[0], c[1]);
    if (n > most) { most = n; best = c; }
  }
  return best;
}

/**
 * R3's poses for `tier` over `regions` (see the header): pose n in region n mod the regions' count, its kind the n-th
 * of FIRST_KINDS then MORE_KINDS (cycling), the k-th of a kind in a region the k-th spread pick of its candidates.
 * Throws when a region has no candidate for a kind it is given.
 */
export function r3Poses(tier: CaveTier, regions: readonly CaveRegion[]): R3Pose[] {
  if (regions.length === 0) throw new Error('r3Poses: no region');
  const n = R3_POSE_COUNTS[tier];
  const counts = regions.map(() => new Map<R3PoseKind, number>());
  const out: R3Pose[] = [];
  let caves = 0;
  for (let p = 0; p < n; p++) {
    const kind = p < FIRST_KINDS.length ? FIRST_KINDS[p]! : MORE_KINDS[(p - FIRST_KINDS.length) % MORE_KINDS.length]!;
    const ri = p % regions.length;
    const r = regions[ri]!;
    const k = counts[ri]!.get(kind) ?? 0;
    counts[ri]!.set(kind, k + 1);
    const yaw = (p * 47) % 360;
    const W = 16 * r.size;
    const midX = 16 * r.cx0 + W / 2 + 0.5;
    const midZ = 16 * r.cz0 + W / 2 + 0.5;
    const pose = (eye: readonly [number, number, number], over: Partial<R3Pose> = {}): R3Pose => {
      const depth = topAt(r, Math.floor(eye[0]), Math.floor(eye[2])) - eye[1];
      return {
        kind, region: ri, eye, yaw, pitch: 0, underground: eye[1] >= Y_MIN && depth >= UNDERGROUND, caveKind: 0, unrevealed: null, room: null,
        ...over,
      };
    };
    switch (kind) {
      case 'cave': {
        const c = cavePick(r, k);
        // The first cave poses look straight up and straight down (pitch ±90).
        const pitch = caves === 0 ? 90 : caves === 1 ? -90 : 0;
        caves++;
        out.push(pose(eyeIn(c), { pitch, caveKind: c[3] }));
        break;
      }
      case 'face': case 'edge': case 'corner': {
        const nb = kind === 'face' ? 1 : kind === 'edge' ? 2 : 3;
        const list = underground(r, nb).sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
        if (list.length === 0) throw new Error(`r3Poses: ${r.label} has no underground cave air on a section ${kind}`);
        const c = list[pickIndex(k, 0.4, list.length)]!;
        out.push(pose(eyeIn(c), { caveKind: c[3] }));
        break;
      }
      case 'surface': {
        const x = 16 * (r.cx0 + CENTRE_LO + ((3 * k) % 8)) + 8;
        const z = 16 * (r.cz0 + CENTRE_LO + ((5 * k + 2) % 8)) + 8;
        out.push(pose([x + 0.5, Math.min(topAt(r, x, z) + 1 + EYE_HEIGHT, 319.5), z + 0.5]));
        break;
      }
      case 'opaque': {
        const d = r.opaqueDeep;
        if (d.length === 0) throw new Error(`r3Poses: ${r.label} has no deep opaque voxel`);
        const m = pickIndex(k, 0.55, d.length / 3);
        out.push(pose([d[3 * m]! + 0.5, d[3 * m + 1]! + 0.5, d[3 * m + 2]! + 0.5]));
        break;
      }
      case 'above': out.push(pose([midX, 330.5, midZ])); break;
      case 'below': out.push(pose([midX, -70.5, midZ])); break;
      case 'sealedRoom': {
        // The strict sites where the region has them (`cave_heavy`'s regions may not), else the four sections alone.
        const strict = roomSites(r, true);
        const sites = strict.length > 0 ? strict : roomSites(r, false);
        if (sites.length === 0) throw new Error(`r3Poses: ${r.label} has no four opaque sections in a row for a sealed room`);
        const [cx, sy, cz] = sites[pickIndex(k, 0.3, sites.length)]!;
        const s = sealedRoom(cx, sy, cz);
        out.push(pose(s.eye, { room: s.room }));
        break;
      }
      case 'unrevealed': {
        const c = cavePick(r, k + 7);
        const eye = eyeIn(c);
        out.push(pose(eye, { caveKind: c[3], unrevealed: openRuleColumn(r, eye) }));
        break;
      }
    }
  }
  return out;
}

export type R3PathName = 'doorway' | 'flight' | 'flightHigh' | 'teleport' | 'digOpen';

/** A step of a path, replayed frame by frame. */
export type R3Step =
  /** Frames until the walk has settled (no walk for two frames, every reveal done), then `extra` frames more. */
  | { readonly kind: 'settle'; readonly extra: number }
  /** One frame per `perFrame` blocks along the line to `to`. */
  | { readonly kind: 'move'; readonly to: readonly [number, number, number]; readonly perFrame: number }
  /** A teleport: the eye at `to` from this frame on, the new disc streaming in. */
  | { readonly kind: 'jump'; readonly to: readonly [number, number, number] }
  /** The path's `dig` voxels opened (a swap of their columns) at this frame. */
  | { readonly kind: 'dig' };

export interface R3Path {
  readonly name: R3PathName;
  readonly start: readonly [number, number, number];
  readonly steps: readonly R3Step[];
  /** Voxels carved before the first frame, and dug at the 'dig' step (x, y, z triples). */
  readonly carve: Int32Array;
  readonly dig: Int32Array;
}

const NONE = new Int32Array(0);

/**
 * The doorway path's site: six fully opaque sections (x bx … bx + 2, y by, z bz … bz + 1), bx, bx + 1 (the eye walks
 * into it) and bz, bz + 1 central, underground; of those, the one with the most fully opaque sections in the ring
 * around them (the first in scan order on a tie), so the cavern is seen mostly through its doorway.
 */
function doorwaySite(r: CaveRegion): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let most = -1;
  for (let sy = 1; sy <= 20; sy++) {
    for (let k = CENTRE_LO; k < CENTRE_HI; k++) {
      for (let i = CENTRE_LO; i < CENTRE_HI; i++) {
        const cx = r.cx0 + i, cz = r.cz0 + k;
        let ok = true;
        for (let dx = 0; dx < 3 && ok; dx++) for (let dz = 0; dz < 2 && ok; dz++) ok = r.solid[sectionOf(r, cx + dx, sy, cz + dz)] === 1;
        if (!ok) continue;
        if (topAt(r, 16 * cx + 4, 16 * cz + 16) - (16 * sy + Y_MIN + 7.5) < UNDERGROUND) continue;
        let ring = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 2; dz++) {
            for (let dx = -1; dx <= 3; dx++) {
              if (dy === 0 && dx >= 0 && dx <= 2 && dz >= 0 && dz <= 1) continue;
              ring += r.solid[sectionOf(r, cx + dx, sy + dy, cz + dz)]!;
            }
          }
        }
        if (ring > most) { most = ring; best = [cx, sy, cz]; }
      }
    }
  }
  return best;
}

/** The frames a full walk from `eye` takes at 2,000 pops a frame (the walk's own length, for the flight's speed). */
function walkFrames(r: CaveRegion, eye: readonly [number, number, number]): number {
  const rp = newReplay(r, NONE, null);
  let frames = 0;
  syncColumns(rp, eye);
  rp.culler.setCamera(eye[0], eye[1], eye[2]);
  do {
    rp.culler.frame(frames * FRAME_MS, R3_POPS, null, 0);
    frames++;
  } while (rp.culler.walk.running && frames < 10_000);
  return frames;
}

/**
 * The five paths on `r` (see the header). The flight's speed is two sections per walk: 32 blocks over the frames a
 * full walk from its start takes. Throws when `r` has no site for the carved paths.
 */
export function r3Paths(r: CaveRegion): R3Path[] {
  const W = 16 * r.size;
  const x0 = 16 * r.cx0, z0 = 16 * r.cz0;
  const lo = 16 * CENTRE_LO + 8, hi = 16 * CENTRE_HI + 8;
  const mid = W / 2 + 8;
  // A walk through a doorway into a cavern: a 1 × 2 corridor through a 2-high doorway into a 28 × 12 × 24 cavern.
  const door = doorwaySite(r);
  if (door === null) throw new Error(`r3Paths: ${r.label} has no six opaque sections for the doorway path`);
  const [bx, by, bz] = door;
  const X = 16 * bx, Y = 16 * by + Y_MIN, Z = 16 * bz;
  const doorCarve: number[] = [];
  box(doorCarve, X + 4, X + 16, Y + 6, Y + 8, Z + 15, Z + 17);
  box(doorCarve, X + 16, X + 44, Y + 2, Y + 14, Z + 4, Z + 28);
  // Flight at two sections per walk (flight has no collision and no altitude clamp) at the central chunks' median
  // pre-cave top, so the eye passes in and out of hills: a walk from inside a hill reaches little of what the eye sees
  // two sections on, in the open.
  const tops: number[] = [];
  for (let z = z0 + lo - 8; z < z0 + hi + 8; z++) for (let x = x0 + lo - 8; x < x0 + hi + 8; x++) tops.push(topAt(r, x, z));
  tops.sort((a, b) => a - b);
  const flightY = Math.min(tops[tops.length >> 1]! + 0.5, 319.5);
  const flightStart = [x0 + lo + 0.5, flightY, z0 + mid + 0.5] as const;
  const perFrame = 32 / walkFrames(r, flightStart);
  // A teleport (a review link) from an eye inside rock deep under the central chunks' near corner, whose walk reaches
  // little, to a surface pose at their far corner, which sees far at once.
  const d = r.opaqueDeep;
  if (d.length === 0) throw new Error(`r3Paths: ${r.label} has no deep opaque voxel`);
  let near = 0;
  const nx = x0 + lo, nz = z0 + lo;
  for (let m = 3; m < d.length; m += 3) {
    const dm = (d[m]! - nx) ** 2 + (d[m + 2]! - nz) ** 2, dn = (d[near]! - nx) ** 2 + (d[near + 2]! - nz) ** 2;
    if (dm < dn || (dm === dn && d[m + 1]! < d[near + 1]!)) near = m;
  }
  const teleportStart = [d[near]! + 0.5, d[near + 1]! + 0.5, d[near + 2]! + 0.5] as const;
  const fx = x0 + hi, fz = z0 + hi;
  const landing = [fx + 0.5, Math.min(topAt(r, fx, fz) + 1 + EYE_HEIGHT, 319.5), fz + 0.5] as const;
  // A wall dug open into a sealed cave, at the room site whose walk before the dig is longest (more than a frame's
  // 2,000 pops where the region allows), so the walk after the dig runs over several frames.
  const sites = roomSites(r, true);
  if (sites.length === 0) throw new Error(`r3Paths: ${r.label} has no sealed-room site (four opaque sections in a row, the last walled in)`);
  let room = sealedRoom(...sites[0]!);
  let longest = -1;
  for (const site of sites) {
    const s = sealedRoom(...site);
    const rp = newReplay(r, s.room.carve, null);
    settle(rp, s.eye, 0, () => undefined);
    if (rp.culler.walk.qHead > longest) { longest = rp.culler.walk.qHead; room = s; }
  }
  return [
    {
      name: 'doorway', start: [X + 4.5, Y + 7.5, Z + 16], carve: Int32Array.from(doorCarve), dig: NONE,
      steps: [{ kind: 'settle', extra: 2 }, { kind: 'move', to: [X + 30, Y + 7.5, Z + 16], perFrame: 0.25 }, { kind: 'settle', extra: 2 }],
    },
    {
      name: 'flight', start: flightStart, carve: NONE, dig: NONE,
      steps: [{ kind: 'settle', extra: 2 }, { kind: 'move', to: [x0 + hi + 0.5, flightY, z0 + mid + 0.5], perFrame }, { kind: 'settle', extra: 2 }],
    },
    {
      name: 'flightHigh', start: [x0 + mid + 0.5, 300.5, z0 + mid + 0.5], carve: NONE, dig: NONE,
      steps: [
        { kind: 'settle', extra: 2 }, { kind: 'move', to: [x0 + mid + 0.5, 400.5, z0 + mid + 0.5], perFrame: 4 }, { kind: 'settle', extra: 2 },
        { kind: 'move', to: [x0 + mid + 0.5, 300.5, z0 + mid + 0.5], perFrame: 4 }, { kind: 'settle', extra: 2 },
      ],
    },
    {
      name: 'teleport', start: teleportStart, carve: NONE, dig: NONE,
      steps: [{ kind: 'settle', extra: 2 }, { kind: 'jump', to: landing }, { kind: 'settle', extra: 2 }],
    },
    {
      name: 'digOpen', start: room.eye, carve: room.room.carve, dig: room.room.dig,
      steps: [{ kind: 'settle', extra: 2 }, { kind: 'dig' }, { kind: 'settle', extra: 2 }],
    },
  ];
}

// ---------------------------------------------------------------- the replay

/** A column key, as the renderer's (`src/render/regionGrid.ts`). */
const columnKey = (cx: number, cz: number): number => (cx + 1_048_576) * 2_097_152 + (cz + 1_048_576);

interface Replay {
  readonly r: CaveRegion;
  readonly culler: CaveCuller;
  /** The opacity bits, `conn` and `nonEmpty` with the edits (the region's own arrays when there are none). */
  bits: Uint32Array;
  conn: Uint16Array;
  nonEmpty: Uint8Array;
  readonly revealed: Uint8Array;
  /** The column never revealed (index), or −1. */
  readonly excluded: number;
  /** Columns revealed per frame (Infinity, or the streaming rate after a teleport). */
  limit: number;
  frame: number;
  /** Per section: the cast that last counted it (dedup per cast). */
  readonly castStamp: Uint32Array;
  cast: number;
  readonly padded: PaddedSection;
}

function newReplay(r: CaveRegion, carve: Int32Array, unrevealed: readonly [number, number] | null): Replay {
  const culler = createCaveCuller();
  culler.setRadius(R3_RD);
  const n = r.size * r.size;
  const rp: Replay = {
    r, culler, bits: r.opaque, conn: r.conn, nonEmpty: r.nonEmpty, revealed: new Uint8Array(n),
    excluded: unrevealed === null ? -1 : (unrevealed[1] - r.cz0) * r.size + (unrevealed[0] - r.cx0),
    limit: Infinity, frame: 0, castStamp: new Uint32Array(n * SECTIONS), cast: 0, padded: createPaddedSection(),
  };
  if (carve.length > 0) openVoxels(rp, carve);
  return rp;
}

/**
 * Opens `voxels` (x, y, z triples; each in a fully opaque section of the region, so its non-air voxels stay its opaque
 * ones) and re-derives the touched sections' `connectivity15` and non-empty flags; returns the touched columns.
 */
function openVoxels(rp: Replay, voxels: Int32Array): Set<number> {
  const r = rp.r;
  const W = 16 * r.size;
  const x0 = 16 * r.cx0, z0 = 16 * r.cz0;
  if (rp.bits === r.opaque) {
    rp.bits = r.opaque.slice();
    rp.conn = r.conn.slice();
    rp.nonEmpty = r.nonEmpty.slice();
  }
  const touched = new Set<number>();
  for (let n = 0; n < voxels.length; n += 3) {
    const lx = voxels[n]! - x0, Y = voxels[n + 1]! - Y_MIN, lz = voxels[n + 2]! - z0;
    if (lx < 0 || lx >= W || lz < 0 || lz >= W || Y < 0 || Y >= HEIGHT) throw new RangeError(`r3: edit (${voxels[n]}, ${voxels[n + 1]}, ${voxels[n + 2]}) outside ${r.label}`);
    const s = ((lz >> 4) * r.size + (lx >> 4)) * SECTIONS + (Y >> 4);
    if (r.solid[s] !== 1) throw new Error(`r3: edit (${voxels[n]}, ${voxels[n + 1]}, ${voxels[n + 2]}) in a section of ${r.label} that is not fully opaque`);
    const bit = (Y * W + lz) * W + lx;
    rp.bits[bit >>> 5]! &= ~(1 << (bit & 31));
    touched.add(s);
  }
  const p = rp.padded;
  const columns = new Set<number>();
  for (const s of touched) {
    const col = Math.floor(s / SECTIONS);
    const sy = s - col * SECTIONS;
    const i = col % r.size, k = Math.floor(col / r.size);
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        const row = opaqueRow(rp.bits, W, 16 * i, 16 * sy + y, 16 * k + z);
        const at = padIndex(0, y, z);
        for (let x = 0; x < 16; x++) p.blocks[at + x] = (row >>> x) & 1 ? BEDROCK : AIR;
      }
    }
    rp.conn[s] = connectivity15(p);
    const bits = rp.bits;
    rp.nonEmpty[s] = sectionNonEmpty(bits, W, i, sy, k, (y, z) => opaqueRow(bits, W, 16 * i, 16 * sy + y, 16 * k + z)) ? 1 : 0;
    columns.add(col);
  }
  return columns;
}

/** The column's 24 `connectivity15` values. */
const columnConn = (rp: Replay, col: number): Uint16Array => rp.conn.subarray(col * SECTIONS, col * SECTIONS + SECTIONS);

/**
 * Brings the revealed columns to the eye's disc: retires those beyond RETIRE_R, reveals the disc's others (nearest
 * first, at most `limit`, never the excluded one); returns how many disc columns stay unrevealed (the excluded one
 * not counted).
 */
function syncColumns(rp: Replay, eye: readonly [number, number, number]): number {
  const r = rp.r;
  const ecx = Math.floor(eye[0]) >> 4, ecz = Math.floor(eye[2]) >> 4;
  const want: Array<[number, number]> = [];
  for (let k = 0; k < r.size; k++) {
    for (let i = 0; i < r.size; i++) {
      const col = k * r.size + i;
      const dx = r.cx0 + i - ecx, dz = r.cz0 + k - ecz;
      const d2 = dx * dx + dz * dz;
      if (rp.revealed[col] === 1) {
        if (d2 > RETIRE_R * RETIRE_R) {
          rp.revealed[col] = 0;
          rp.culler.onRetire(columnKey(r.cx0 + i, r.cz0 + k), r.cx0 + i, r.cz0 + k);
        }
      } else if (d2 <= (R3_RD + 0.5) * (R3_RD + 0.5) && col !== rp.excluded) want.push([col, d2]);
    }
  }
  // The disc must lie in the region (poses and paths keep the eye in the central chunks).
  const reach = Math.floor(R3_RD + 0.5);
  if (ecx - reach < r.cx0 || ecx + reach >= r.cx0 + r.size || ecz - reach < r.cz0 || ecz + reach >= r.cz0 + r.size) {
    throw new RangeError(`r3: the eye's column (${ecx}, ${ecz}) leaves RD 12's disc outside ${r.label}`);
  }
  want.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const n = Math.min(want.length, rp.limit);
  for (let m = 0; m < n; m++) {
    const col = want[m]![0];
    const i = col % r.size, k = Math.floor(col / r.size);
    rp.revealed[col] = 1;
    rp.culler.onReveal(columnKey(r.cx0 + i, r.cz0 + k), r.cx0 + i, r.cz0 + k, columnConn(rp, col));
  }
  return want.length - n;
}

/** One frame: the reveals, the camera, the culler's frame. Returns the disc columns still unrevealed. */
function stepFrame(rp: Replay, eye: readonly [number, number, number]): number {
  const pending = syncColumns(rp, eye);
  rp.culler.setCamera(eye[0], eye[1], eye[2]);
  rp.culler.frame(rp.frame * FRAME_MS, R3_POPS, null, 0);
  rp.frame++;
  return pending;
}

/** Whether the culler hides any section of a revealed column. */
function hidesAny(rp: Replay): boolean {
  if (rp.culler.drawAll) return false;
  const r = rp.r;
  for (let col = 0; col < rp.revealed.length; col++) {
    if (rp.revealed[col] !== 1) continue;
    const cx = r.cx0 + (col % r.size), cz = r.cz0 + Math.floor(col / r.size);
    for (let sy = 0; sy < SECTIONS; sy++) if (!rp.culler.drawn(cx, sy, cz)) return true;
  }
  return false;
}

/**
 * The reference from `eye` over the replay's world: `visit(section)` once per seen section of a revealed column. Rays
 * pass through unrevealed columns and stop on leaving the revealed columns' box.
 */
function castSeen(rp: Replay, eye: readonly [number, number, number], visit: (s: number, cx: number, sy: number, cz: number) => void): void {
  const r = rp.r;
  const W = 16 * r.size;
  const x0 = 16 * r.cx0, z0 = 16 * r.cz0;
  let i0 = r.size, i1 = -1, k0 = r.size, k1 = -1;
  for (let col = 0; col < rp.revealed.length; col++) {
    if (rp.revealed[col] !== 1) continue;
    const i = col % r.size, k = Math.floor(col / r.size);
    i0 = Math.min(i0, i); i1 = Math.max(i1, i); k0 = Math.min(k0, k); k1 = Math.max(k1, k);
  }
  if (i1 < 0) return;
  const bx0 = 16 * i0, bx1 = 16 * i1 + 16, bz0 = 16 * k0, bz1 = 16 * k1 + 16;
  const bits = rp.bits;
  const revealed = rp.revealed;
  const size = r.size;
  const opaqueAt = (x: number, y: number, z: number): boolean => {
    const lx = x - x0, lz = z - z0;
    if (lx < bx0 || lx >= bx1 || lz < bz0 || lz >= bz1) return true;
    if (revealed[(lz >> 4) * size + (lx >> 4)] !== 1) return false;
    const bit = ((y - Y_MIN) * W + lz) * W + lx;
    return ((bits[bit >>> 5]! >>> (bit & 31)) & 1) === 1;
  };
  const id = ++rp.cast;
  raycastVisible(opaqueAt, eye, 4096, R3_FACE_RES, (cx, sy, cz) => {
    const i = cx - r.cx0, k = cz - r.cz0;
    if (i < 0 || i >= size || k < 0 || k >= size) return;
    const col = k * size + i;
    if (revealed[col] !== 1) return;
    const s = col * SECTIONS + sy;
    if (rp.castStamp[s] === id) return;
    rp.castStamp[s] = id;
    visit(s, cx, sy, cz);
  });
}

/** Frames until the walk has settled (see `R3Step`), then `extra` frames; `each` after every frame. */
function settle(rp: Replay, eye: readonly [number, number, number], extra: number, each: () => void): void {
  let quiet = 0;
  for (let guard = 0; quiet < 2; guard++) {
    if (guard > 5000) throw new Error(`r3: the walk did not settle in 5,000 frames at (${eye.join(', ')})`);
    const pending = stepFrame(rp, eye);
    each();
    quiet = !rp.culler.walk.running && pending === 0 ? quiet + 1 : 0;
  }
  for (let n = 0; n < extra; n++) {
    stepFrame(rp, eye);
    each();
  }
}

/** Opens the dig voxels and swaps their columns (revealed ones) into the culler. */
function dig(rp: Replay, voxels: Int32Array): void {
  const r = rp.r;
  for (const col of openVoxels(rp, voxels)) {
    if (rp.revealed[col] !== 1) continue;
    const i = col % r.size, k = Math.floor(col / r.size);
    rp.culler.onSwap(columnKey(r.cx0 + i, r.cz0 + k), r.cx0 + i, r.cz0 + k, columnConn(rp, col));
  }
}

/** One pose's counts (§12.4): after the walk settles (and, for a sealed room, after the dig and a second settle). */
export interface R3PoseCounts {
  /** Sections of revealed columns the reference sees. */
  readonly seen: number;
  /** Seen sections the culler does not draw (`R3.wronglyCulled`'s share of this pose). */
  readonly wronglyCulled: number;
  /** Sections of revealed columns the last walk stamped (NaN when no walk ran: the eye out of range). */
  readonly stamped: number;
  /** Non-empty sections of revealed columns, and those drawn. */
  readonly nonEmpty: number;
  readonly nonEmptyDrawn: number;
  /** 1 − nonEmptyDrawn / nonEmpty (NaN with no non-empty section). */
  readonly culledShare: number;
  /** The pops of the last walk (NaN when no walk ran). */
  readonly pops: number;
  readonly frames: number;
  readonly drawAll: boolean;
}

export function r3PoseCounts(r: CaveRegion, pose: R3Pose): R3PoseCounts {
  const rp = newReplay(r, pose.room?.carve ?? NONE, pose.unrevealed);
  const nothing = (): void => undefined;
  settle(rp, pose.eye, 0, nothing);
  if (pose.room !== null) {
    dig(rp, pose.room.dig);
    settle(rp, pose.eye, 0, nothing);
  }
  const c = rp.culler;
  let seen = 0;
  let wrong = 0;
  castSeen(rp, pose.eye, (_s, cx, sy, cz) => {
    seen++;
    if (!c.drawn(cx, sy, cz)) wrong++;
  });
  const walked = c.walk.walkId > 0 && !c.walk.running && c.shown === c.walk.walkId;
  let stamped = 0;
  let nonEmpty = 0;
  let nonEmptyDrawn = 0;
  for (let col = 0; col < rp.revealed.length; col++) {
    if (rp.revealed[col] !== 1) continue;
    const cx = r.cx0 + (col % r.size), cz = r.cz0 + Math.floor(col / r.size);
    for (let sy = 0; sy < SECTIONS; sy++) {
      const s = col * SECTIONS + sy;
      if (walked && c.walk.stamp[torusSlot(cx, cz) * SECTIONS + sy] === c.shown) stamped++;
      if (rp.nonEmpty[s] !== 1) continue;
      nonEmpty++;
      if (c.drawn(cx, sy, cz)) nonEmptyDrawn++;
    }
  }
  return {
    seen, wronglyCulled: wrong, stamped: walked && !c.drawAll ? stamped : Number.NaN, nonEmpty, nonEmptyDrawn,
    culledShare: nonEmpty === 0 ? Number.NaN : 1 - nonEmptyDrawn / nonEmpty, pops: walked && !c.drawAll ? c.walk.qHead : Number.NaN,
    frames: rp.frame, drawAll: c.drawAll,
  };
}

/** One path's counts (§12.4). */
export interface R3PathCounts {
  /** Over the frames, the seen sections the draw rule hid that frame (`R3.popIn`'s share of this path). */
  readonly popIn: number;
  readonly frames: number;
  /** Frames with `drawAll` set, and frames the reference was cast on (the culler hid something). */
  readonly drawAllFrames: number;
  readonly castFrames: number;
  /** The largest pop-in of one frame. */
  readonly maxFramePopIn: number;
  /** The first frame with pop-in (−1: none). */
  readonly firstPopInFrame: number;
}

export function r3PathCounts(r: CaveRegion, path: R3Path): R3PathCounts {
  const rp = newReplay(r, path.carve, null);
  let eye: readonly [number, number, number] = path.start;
  let popIn = 0, drawAllFrames = 0, castFrames = 0, maxFrame = 0, first = -1;
  const measure = (): void => {
    const c = rp.culler;
    if (c.drawAll) { drawAllFrames++; return; }
    if (!hidesAny(rp)) return;
    castFrames++;
    let n = 0;
    castSeen(rp, eye, (_s, cx, sy, cz) => { if (!c.drawn(cx, sy, cz)) n++; });
    if (n > 0 && first < 0) first = rp.frame - 1;
    popIn += n;
    maxFrame = Math.max(maxFrame, n);
  };
  for (const step of path.steps) {
    switch (step.kind) {
      case 'settle': settle(rp, eye, step.extra, measure); break;
      case 'move': {
        const from = eye;
        const len = Math.hypot(step.to[0] - from[0], step.to[1] - from[1], step.to[2] - from[2]);
        const frames = Math.max(1, Math.ceil(len / step.perFrame));
        for (let f = 1; f <= frames; f++) {
          const a = f / frames;
          eye = [from[0] + (step.to[0] - from[0]) * a, from[1] + (step.to[1] - from[1]) * a, from[2] + (step.to[2] - from[2]) * a];
          stepFrame(rp, eye);
          measure();
        }
        break;
      }
      case 'jump':
        eye = step.to;
        rp.limit = STREAM_PER_FRAME;
        stepFrame(rp, eye);
        measure();
        break;
      case 'dig':
        dig(rp, path.dig);
        stepFrame(rp, eye);
        measure();
        break;
    }
  }
  return { popIn, frames: rp.frame, drawAllFrames, castFrames, maxFramePopIn: maxFrame, firstPopInFrame: first };
}

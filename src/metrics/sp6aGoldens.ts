/**
 * SP6a golden digests (SP6a spec §12.3, D28), chained into `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`)
 * before SP6b's, so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts` all check them. Push A adds
 * `sp6a.density.ops`; push B appends `sp6a.carver.paths` (Task 27) and `sp6a.region.T.caves` (Task 39).
 * - `sp6a.density.ops`: the `noiseScaled` op (D18, spec §1.5) at fixed points, world seed '42', default profile. The
 *   fixture is a density source tree that uses `noiseScaled` inside and outside `interpolated`, with literal scales and a
 *   `{param}` scale (`density.noises.detail.clampSigma`, static range [1, 8]: before the cave parameters only the
 *   `*.clampSigma` targets lie inside [1/16, 16]), resolved for the profile's params (`resolveDensity`) and compiled. At
 *   column (0, 0), as `sp3b.density.ops` is evaluated: its 1225 corner values (every interpolated slot in slot order,
 *   each in `cornerValueIndex` order: i fastest, then j, then k), then the voxel values (compiled, no early-outs) at 32
 *   points drawn from `Xoshiro128(fnv1a32('sp6a.density.ops'))` as lx, lz (`nextU32() & 15`) and y
 *   (−64 + `nextU32() % 384`). Every value is hashed as its IEEE double bits (`hashF64`, so −0 ≠ +0).
 * - `sp6a.carver.paths` (push B, Task 27): the carvers' paths (spec §2.1-§2.3, D21, D35), world seed '42', the default
 *   profile's carver leaves (`carverParamsOf`). Per kind, in the order worm, ravine, underground worm, the first 64
 *   source chunks whose roll passes, scanning a square spiral of chunks from (0, 0) (ring r ≥ 1: from (−r, −r) along
 *   sz = −r, then sx = r, sz = r, sx = −r, as `liveness.ts`' lake-cell spiral); per path, in that order: sx, sz, its
 *   ellipsoid count, its box (6 values), its ellipsoids (6 values each: x, y, z, rh, rv, floor) and, for a ravine, its
 *   384 f² values. Every value is hashed as its IEEE double bits in one array (`hashF64`).
 * - `sp6a.region.T.caves` (push B, Task 39; §10.8): `regionHash` of an 8 × 8-chunk window, world seed '42', default
 *   profile, generated up to T in process on a fresh `ArrayBuffer` store (as `regionDigest`, `sp3aGoldens.ts`), so the
 *   digest covers the window's blocks, fluid, cave tags and aux. The window is the first of the scan's candidates
 *   holding at least one voxel of each cave kind 1-8 (`CAVE_KIND` cheese … undergroundWorm, the store's tag; ruling
 *   P36). The candidates, in this fixed order: the 8 × 8 tiles of the default quick regions of `caves.metric.ts` at seed
 *   '42', the 32 × 32 chunks at (−16, −16), then at (16, −16); within a region, its four rows of tiles from low z to
 *   high z, each from low x to high x (tile (i, j) at chunk (cx0 + 8i, cz0 + 8j)). The scan, run once at push B's tree
 *   (the tuning fb1e5d1), found the first candidate, chunks (−16, −16) … (−9, −9); it is pinned in `CAVES_WINDOW`, and
 *   `goldens.sp6a.test.ts` checks that it is the first candidate and holds every kind.
 * Follows the core determinism rules (in `DET_FILES`, arch-tested). Every value is hex64.
 */
import { fnv1a32, hashF64, hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import { Xoshiro128 } from '../core/rng';
import { seedFromInput } from '../core/seed';
import { carverParamsOf, carverPath, type CarverKind, type CarverPath } from '../gen/caves/carvers';
import type { SampleField } from '../gen/column/columnStage';
import { createGenContext } from '../gen/context';
import type { GenContext as GenContextT } from '../gen/context';
import { cornerValueIndex } from '../gen/density/compile';
import { createDensityContext } from '../gen/density/context';
import type { DensityExpr } from '../gen/density/expr';
import { probe } from '../gen/density/probe';
import { resolveDensity } from '../gen/density/source';
import type { DensitySource, SourceExpr, SourceNumber } from '../gen/density/source';
import { createStore } from '../world/store/store';
import type { VoxelStore } from '../world/store/store';
import { genRegionInProcess, regionHash } from './region';

const FNV32 = fnv1a32;
const HASH_F64 = hashF64;
const HEX64 = hex64;
const RESOLVE = resolveProfile;
const Rng = Xoshiro128;
const SEED = seedFromInput;
const CREATE_CTX = createGenContext;
const CORNER_INDEX = cornerValueIndex;
const CREATE_DC = createDensityContext;
const PROBE = probe;
const RESOLVE_DENSITY = resolveDensity;
const CARVER_PATH = carverPath;
const CARVER_PARAMS_OF = carverParamsOf;
const CREATE_STORE = createStore;
const GEN_REGION = genRegionInProcess;
const REGION_HASH = regionHash;

const CORNERS = 1225;
/** The column the ops fixture is evaluated over. */
const OPS_COLUMN: readonly [number, number] = [0, 0];
const OPS_POINTS = 32;
/** The fixture's `{param}` scale: a noise clampSigma, static range [1, 8]. */
const PARAM_SCALE = 'density.noises.detail.clampSigma';

const ctx42 = (): GenContextT => CREATE_CTX(SEED('42'), RESOLVE('default'));

const k = (v: number): SourceExpr => ({ op: 'const', v });
const col = (field: SampleField): SourceExpr => ({ op: 'col', field });
const add = (a: SourceExpr, b: SourceExpr): SourceExpr => ({ op: 'add', a, b });
const mul = (a: SourceExpr, b: SourceExpr): SourceExpr => ({ op: 'mul', a, b });
const scaled = (id: string, s: SourceNumber): SourceExpr => ({ op: 'noiseScaled', id, s });

/**
 * The ops fixture's source: root = tap('scaled', interpolated(noiseScaled(overhang, 1.5) + E · noiseScaled(detail,
 * {param})) ) + (noiseScaled(detail, 0.75) + 0.5 · noiseScaled(islands, {param})), the `{param}` being
 * `density.noises.detail.clampSigma`; no defs.
 */
export function densityScaledSource(): DensitySource {
  const p: SourceNumber = { param: PARAM_SCALE };
  const inner = add(scaled('overhang', 1.5), mul(col('E'), scaled('detail', p)));
  const outer = add(scaled('detail', 0.75), mul(k(0.5), scaled('islands', p)));
  return { root: add({ op: 'tap', name: 'scaled', x: { op: 'interpolated', x: inner } }, outer), defs: {} };
}

/** The fixture resolved for the default profile's params (the `{param}` scale written as its value). */
export function densityScaledExpr(): DensityExpr {
  return RESOLVE_DENSITY(densityScaledSource(), ctx42().params);
}

/** The fixture's points, world [x, y, z]: 32 in column (0, 0), drawn as the module comment states. */
export function densityScaledPoints(): Array<[number, number, number]> {
  const r = new Rng(FNV32('sp6a.density.ops'));
  const [cx, cz] = OPS_COLUMN;
  const out: Array<[number, number, number]> = [];
  for (let n = 0; n < OPS_POINTS; n++) {
    const lx = r.nextU32() & 15;
    const lz = r.nextU32() & 15;
    const y = -64 + (r.nextU32() % 384);
    out.push([16 * cx + lx, y, 16 * cz + lz]);
  }
  return out;
}

/** Column (0, 0)'s corner values (every interpolated slot, slot outer), then the voxel values at the 32 points. */
export function densityScaledValues(): Float64Array {
  const ctx = ctx42();
  const dc = CREATE_DC(ctx, RESOLVE_DENSITY(densityScaledSource(), ctx.params));
  const c = dc.compiled;
  const values = new Float64Array(c.interpolatedSlotCount * CORNERS + OPS_POINTS);
  dc.column(OPS_COLUMN[0], OPS_COLUMN[1]);
  for (let idx = 0; idx < CORNERS; idx++) c.cornerFn(idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5);
  let o = 0;
  for (let slot = 0; slot < c.interpolatedSlotCount; slot++) {
    for (let idx = 0; idx < CORNERS; idx++) values[o++] = c.cornerValues[CORNER_INDEX(slot, idx % 5, (idx / 25) | 0, ((idx / 5) | 0) % 5)]!;
  }
  for (const [x, y, z] of densityScaledPoints()) values[o++] = PROBE(dc, x, y, z);
  return values;
}

/** The kinds of `sp6a.carver.paths`, in its order. */
const CARVER_KINDS: readonly CarverKind[] = ['worm', 'ravine', 'undergroundWorm'];
/** Paths per kind in `sp6a.carver.paths`. */
const CARVER_SOURCES = 64;

/** Chunks of a square spiral from (0, 0) (ring r ≥ 1: from (−r, −r) along sz = −r, then sx = r, sz = r, sx = −r) until `visit` says stop. */
function spiral(visit: (sx: number, sz: number) => boolean): void {
  if (visit(0, 0)) return;
  for (let r = 1; ; r++) {
    for (let i = -r; i <= r; i++) if (visit(i, -r)) return;
    for (let j = 1 - r; j <= r; j++) if (visit(r, j)) return;
    for (let i = r - 1; i >= -r; i--) if (visit(i, r)) return;
    for (let j = r - 1; j > -r; j--) if (visit(-r, j)) return;
  }
}

/** The 64 fixed sources' paths of `kind` (seed '42', the default profile's carver leaves): the first 64 whose roll passes, in spiral order. */
export function carverGoldenPaths(kind: CarverKind): CarverPath[] {
  const ctx = ctx42();
  const p = CARVER_PARAMS_OF(ctx.params);
  const out: CarverPath[] = [];
  spiral((sx, sz) => {
    const path = CARVER_PATH(ctx.seed, kind, sx, sz, p);
    if (path !== null) out.push(path);
    return out.length === CARVER_SOURCES;
  });
  return out;
}

/** `sp6a.carver.paths`' values: per kind (worm, ravine, underground worm), per path, sx, sz, count, box, ellipsoids and f². */
export function carverPathsValues(): Float64Array {
  const parts: number[] = [];
  for (const kind of CARVER_KINDS) {
    for (const path of carverGoldenPaths(kind)) {
      parts.push(path.sx, path.sz, path.count);
      for (let k = 0; k < 6; k++) parts.push(path.box[k]!);
      for (let k = 0; k < 6 * path.count; k++) parts.push(path.ell[k]!);
      const ws = path.widthSq;
      if (ws !== null) for (let k = 0; k < ws.length; k++) parts.push(ws[k]!);
    }
  }
  return Float64Array.from(parts);
}

/** The side of `sp6a.region.T.caves`' window, in chunks. */
const CAVES_WINDOW_SIZE = 8;
/** The default quick regions of `caves.metric.ts` at seed '42' (chunk origins; 32 × 32 chunks each), the scan's order. */
const CAVES_SCAN_REGIONS: ReadonlyArray<readonly [number, number]> = [[-16, -16], [16, -16]];
const CAVES_SCAN_REGION_SIZE = 32;
/** `sp6a.region.T.caves`' window, its first chunk (the scan's first candidate, module comment). */
export const CAVES_WINDOW: readonly [number, number] = [-16, -16];
const MiB = 1048576;

/** The scan's candidates for `sp6a.region.T.caves`, each window's first chunk, in the module comment's order. */
export function cavesWindowCandidates(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const tiles = CAVES_SCAN_REGION_SIZE / CAVES_WINDOW_SIZE;
  for (const [rx, rz] of CAVES_SCAN_REGIONS) {
    for (let j = 0; j < tiles; j++) {
      for (let i = 0; i < tiles; i++) out.push([rx + CAVES_WINDOW_SIZE * i, rz + CAVES_WINDOW_SIZE * j]);
    }
  }
  return out;
}

/** The 8 × 8 window at chunk (cx0, cz0), seed '42', default profile, generated up to T in process on a fresh store. */
export function cavesWindowStore(cx0 = CAVES_WINDOW[0], cz0 = CAVES_WINDOW[1]): VoxelStore {
  const store = CREATE_STORE({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  GEN_REGION(store, ctx42(), cx0, cz0, CAVES_WINDOW_SIZE, CAVES_WINDOW_SIZE);
  return store;
}

/** `sp6a.region.T.caves`: `regionHash` of the pinned window. */
function cavesWindowDigest(): string {
  const [cx0, cz0] = CAVES_WINDOW;
  return HEX64(REGION_HASH(cavesWindowStore(cx0, cz0), cx0, cz0, CAVES_WINDOW_SIZE, CAVES_WINDOW_SIZE));
}

export function sp6aGoldenKeys(): string[] {
  return ['sp6a.density.ops', 'sp6a.carver.paths', 'sp6a.region.T.caves'];
}

export function computeSp6aGolden(key: string): string {
  if (key === 'sp6a.density.ops') return HEX64(HASH_F64(densityScaledValues()));
  if (key === 'sp6a.carver.paths') return HEX64(HASH_F64(carverPathsValues()));
  if (key === 'sp6a.region.T.caves') return cavesWindowDigest();
  throw new Error(`unknown golden ${key}`);
}

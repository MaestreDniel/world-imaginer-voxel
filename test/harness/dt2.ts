import { fnv1a32, hash2 } from '../../src/core/hash';
import { Xoshiro128 } from '../../src/core/rng';
import type { GenContext } from '../../src/gen/context';
import { cornerValueIndex } from '../../src/gen/density/compile';
import { createDensityContext, type DensityContext } from '../../src/gen/density/context';
import { probe } from '../../src/gen/density/probe';
import { createDensityReference, interpolatedNodes, type DensityReference } from '../../src/gen/density/reference';
import { terrainDensityDebug, terrainSurfaceDebug } from '../../src/gen/pipeline/terrainStage';
import { createSurfaceContext, surfaceContextOf, type SurfaceContext } from '../../src/gen/surface/context';
import { surfaceProbe } from '../../src/gen/surface/probe';
import { newSurfaceScan, runAt } from '../../src/gen/surface/scan';
import { fillColumnT } from '../../src/metrics/region';
import { AIR } from '../../src/world/blocks/index';
import type { ColumnView } from '../../src/world/store/api';
import { createStore, type VoxelStore } from '../../src/world/store/store';

/**
 * DT2's per-column checks (SP3e spec §5.1 "Extractions", D18), moved out of `test/metrics/region.metric.ts`:
 * `dt2Column(ctx, cx, cz, r, acc)` generates one column and runs `probeBulk`, `compiledReference` (incl. the cell
 * corners of every `interpolated` node), `surfaceProbeBulk` and `surfaceReference` on its 16 voxels drawn from `r`,
 * plus the 8 skin voxels of its own `DT2.surface` stream, adding into `acc`. Definitions: region.metric.ts' DT2
 * comment (SP3b spec §8.2, SP3c spec §5.2). region.metric.ts keeps its profiles, its shared `fnv1a32('DT2')` stream,
 * `DT2_RANGE` and the edited parts, and calls this per column, so its draws and outputs are unchanged (spec §5.7).
 * SP3e's `DT2.presets` (spec §5.2, `test/metrics/presets.metric.ts`) passes the optional trailing `Dt2Extension`:
 * extra voxels in a y range (amplified's slide and ceiling) and observers for its non-finite, heightmap and population
 * values; without it a call draws and counts exactly as before.
 */

export const DT2_VOXELS_PER_COLUMN = 16;

/** The stratum a checked voxel was drawn in: DT2's three (6 uniform, 5 bulk-evaluated, 5 near the top), or an extra. */
export type Dt2Stratum = 'uniform' | 'bulk' | 'top' | 'extra';

/** One checked voxel, as `Dt2Extension.voxel` sees it. */
export interface Dt2Voxel {
  readonly stratum: Dt2Stratum;
  /** World coordinates and the column index `((y + 64) << 8) | p`. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly index: number;
  /** The compiled probe's value and the reference interpreter's. */
  readonly value: number;
  readonly reference: number;
  /** The stored block. */
  readonly block: number;
  /** The bottom voxel's y of the voxel's solid run on the stage's scan; null when the scan has it in no run. */
  readonly runBottom: number | null;
}

/**
 * The optional trailing argument of `dt2Column` (SP3e spec §5.2): `extra` draws `count` more voxels from `r` after the
 * 16 (each a uniform position, then y uniform in yLo … yHi) and checks them as DT2 voxels, cell corners included;
 * `voxel` and `corner` observe every checked voxel and corner value (compiled and reference); `column` sees the
 * generated column before it is freed.
 */
export interface Dt2Extension {
  readonly extra?: { readonly count: number; readonly yLo: number; readonly yHi: number };
  readonly voxel?: (v: Dt2Voxel) => void;
  readonly corner?: (compiled: number, reference: number) => void;
  readonly column?: (view: ColumnView) => void;
}

/** DT2's counters (the metric's parts and populations) and its mismatch texts. */
export interface Dt2Acc {
  /** The prefix of every problem text and refusal, e.g. "profile default, seed '42'"; the caller may change it. */
  label: string;
  readonly problems: string[];
  probeBulk: number;
  compiledReference: number;
  surfaceProbeBulk: number;
  surfaceReference: number;
  voxels: number;
  maskedVoxels: number;
  corners: number;
  columns: number;
  surfaceVoxels: number;
  surfaceExtraVoxels: number;
  surfaceExtraSkipped: number;
}

export function newDt2Acc(label = ''): Dt2Acc {
  return {
    label, problems: [], probeBulk: 0, compiledReference: 0, surfaceProbeBulk: 0, surfaceReference: 0, voxels: 0,
    maskedVoxels: 0, corners: 0, columns: 0, surfaceVoxels: 0, surfaceExtraVoxels: 0, surfaceExtraSkipped: 0,
  };
}

/**
 * What `dt2Column` reads of a GenContext, built once per context (as DT2 built it once per profile and seed): a
 * DensityContext compiled apart from the stage's and its reference interpreter, the `interpolated` nodes' corner
 * slots, the stage's compiled rule tree (`surfaceContextOf(ctx).compiled`) and a SurfaceContext built apart (the
 * probe and the reference evaluator). The fields are writable so a test can inject a wrong reference.
 */
export interface Dt2Setup {
  dc: DensityContext;
  ref: DensityReference;
  interp: { readonly inner: Parameters<DensityReference['corner']>[1]; readonly slot: number }[];
  compiled: SurfaceContext['compiled'];
  sc: SurfaceContext;
  /** The stage tree's fast-path `maxSurfaceDepth` (the skin voxels' depth range). */
  maxSurfaceDepth: number;
}

const SETUPS = new WeakMap<GenContext, Dt2Setup>();

/**
 * `ctx`'s Dt2Setup, built on first use and memoised per GenContext. Throws "DT2: <label>: the default tree has no fast
 * path" when the stage's rule tree has none (DT2 needs its `maxSurfaceDepth`).
 */
export function dt2Setup(ctx: GenContext, label: string): Dt2Setup {
  let setup = SETUPS.get(ctx);
  if (setup !== undefined) return setup;
  const dc = createDensityContext(ctx);
  const ref = createDensityReference(dc.expr, dc.noises);
  const c = dc.compiled;
  const interp = interpolatedNodes(dc.expr).map((n) => ({ inner: n.x, slot: c.interpolatedSlot(n) }));
  const compiled = surfaceContextOf(ctx).compiled;
  const sc = createSurfaceContext(ctx);
  if (compiled.fastPath === null) throw new Error(`DT2: ${label}: the default tree has no fast path`);
  setup = { dc, ref, interp, compiled, sc, maxSurfaceDepth: compiled.fastPath.maxSurfaceDepth };
  SETUPS.set(ctx, setup);
  return setup;
}

// Scratch shared by every call (one column at a time; freed after its checks).
let store: VoxelStore | null = null;
const OUT = new Float64Array(98304);
const MASK = new Uint8Array(98304);
const MASKED = new Int32Array(98304);
const SCAN = newSurfaceScan();
const SURFACE_SEED = fnv1a32('DT2.surface');

/**
 * DT2's checks on chunk column (cx, cz) of `ctx`: the column is generated with `fillColumnT` on a fresh column of an
 * `ArrayBuffer` store and run through `terrainDensityDebug` and `terrainSurfaceDebug`; its 16 voxels are drawn from
 * `r` (6 uniform over y −63 … 319; 5 uniform over the bulk-evaluated voxels, or the column when there are none; 5 at
 * a uniform position and `OCEAN_FLOOR_WG − 1 + d`, d in −4 … 4), then `ext.extra`'s voxels, and 8 skin voxels from
 * `Xoshiro128(hash2(fnv1a32('DT2.surface'), cx, cz))`. Adds the counts and mismatch texts to `acc` and returns the
 * voxel indices (`((y + 64) << 8) | p`, in draw order: the 16, then the extras). Throws when the column cannot be
 * generated or `ext.extra`'s range is not integers within y −63 … 319.
 */
export function dt2Column(ctx: GenContext, cx: number, cz: number, r: Xoshiro128, acc: Dt2Acc, ext?: Dt2Extension): number[] {
  const { dc, ref, interp, compiled, sc, maxSurfaceDepth } = dt2Setup(ctx, acc.label);
  const c = dc.compiled;
  const at = `${acc.label}, column (${cx}, ${cz})`;
  const extra = ext?.extra;
  if (extra !== undefined && !(Number.isInteger(extra.count) && extra.count >= 0 && Number.isInteger(extra.yLo)
    && Number.isInteger(extra.yHi) && -63 <= extra.yLo && extra.yLo <= extra.yHi && extra.yHi <= 319)) {
    throw new RangeError(`DT2: ${at}: extra voxels ${JSON.stringify(extra)} (count ≥ 0, −63 ≤ yLo ≤ yHi ≤ 319, integers)`);
  }
  const onVoxel = ext?.voxel;
  const onCorner = ext?.corner;
  store ??= createStore({ shared: false, maxBlockBytes: 4 << 20, maxByteBytes: 4 << 20 });
  if (!fillColumnT(store, ctx, cx, cz, () => false)) throw new Error(`DT2: ${at}: fillColumnT did not complete`);
  const view = store.proto(cx, cz)!;
  terrainDensityDebug(ctx, cx, cz, OUT, MASK);
  let m = 0;
  for (let i = 256; i < 98304; i++) if (MASK[i] === 1) MASKED[m++] = i;
  const s = dc.column(cx, cz);
  terrainSurfaceDebug(ctx, cx, cz, SCAN);
  acc.columns++;
  const indices: number[] = [];
  /** surfaceReference at column index p, height y: counted when solid on the stage's scan. */
  const checkSurface = (p: number, y: number, what: string): boolean => {
    if (runAt(SCAN, p, y) < 0) return false;
    acc.surfaceVoxels++;
    const cs = compiled.state(SCAN, p, y);
    const rs = sc.reference.state(SCAN, sc.settings, p, y);
    if (cs !== rs) {
      acc.surfaceReference++;
      acc.problems.push(`${at}: ${what} (${16 * cx + (p & 15)}, ${y}, ${16 * cz + (p >> 4)}) compiled state ${cs} ≠ reference ${rs}`);
    }
    return true;
  };
  const total = DT2_VOXELS_PER_COLUMN + (extra?.count ?? 0);
  for (let v = 0; v < total; v++) {
    let i: number;
    if (v >= DT2_VOXELS_PER_COLUMN) {
      const p = r.nextInt(256);
      const y = extra!.yLo + r.nextInt(extra!.yHi - extra!.yLo + 1);
      i = ((y + 64) << 8) | p;
    } else if (v >= 11) {
      const p = r.nextInt(256);
      const y = Math.min(319, Math.max(-63, view.aux()!.oceanFloorWG[p]! - 1 + r.nextInt(9) - 4));
      i = ((y + 64) << 8) | p;
    } else {
      i = v >= 6 && m > 0 ? MASKED[r.nextInt(m)]! : 256 + r.nextInt(98304 - 256);
    }
    indices.push(i);
    const lx = i & 15, lz = (i >> 4) & 15, y = (i >> 8) - 64;
    const x = 16 * cx + lx, z = 16 * cz + lz;
    const value = probe(dc, x, y, z);
    const block = view.block(lx, y, lz);
    acc.voxels++;
    if ((value > 0) !== (block !== AIR)) {
      acc.probeBulk++;
      acc.problems.push(`${at}: (${x}, ${y}, ${z}) probe ${value}, block ${block}`);
    }
    const surfaceState = surfaceProbe(sc, x, y, z).state;
    if (surfaceState !== block) {
      acc.surfaceProbeBulk++;
      acc.problems.push(`${at}: (${x}, ${y}, ${z}) surfaceProbe state ${surfaceState} ≠ block ${block}`);
    }
    checkSurface(i & 255, y, 'DT2 voxel');
    if (MASK[i] === 1) {
      acc.maskedVoxels++;
      if (!Object.is(value, OUT[i])) {
        acc.probeBulk++;
        acc.problems.push(`${at}: (${x}, ${y}, ${z}) probe ${value} ≠ bulk ${OUT[i]}`);
      }
    }
    const rv = ref.voxel(s, x, y, z);
    if (!Object.is(value, rv)) {
      acc.compiledReference++;
      acc.problems.push(`${at}: (${x}, ${y}, ${z}) compiled ${value} ≠ reference ${rv}`);
    }
    if (onVoxel !== undefined) {
      const k = runAt(SCAN, i & 255, y);
      const stratum: Dt2Stratum = v >= DT2_VOXELS_PER_COLUMN ? 'extra' : v >= 11 ? 'top' : v >= 6 ? 'bulk' : 'uniform';
      onVoxel({ stratum, x, y, z, index: i, value, reference: rv, block, runBottom: k >= 0 ? SCAN.runBottom[k]! : null });
    }
    const ci = lx >> 2, ck = (y + 64) >> 3, cj = lz >> 2;
    c.cellCorners(ci, ck, cj);
    for (const { inner, slot } of interp) {
      for (let d = 0; d < 8; d++) {
        const ii = ci + (d & 1), kk = ck + ((d >> 2) & 1), jj = cj + ((d >> 1) & 1);
        const cv = c.cornerValues[cornerValueIndex(slot, ii, kk, jj)]!;
        const rc = ref.corner(s, inner, ii, kk, jj);
        acc.corners++;
        onCorner?.(cv, rc);
        if (!Object.is(cv, rc)) {
          acc.compiledReference++;
          acc.problems.push(`${at}: corner (${ii}, ${kk}, ${jj}) compiled ${cv} ≠ reference ${rc}`);
        }
      }
    }
  }
  const rSurface = new Xoshiro128(hash2(SURFACE_SEED, cx, cz));
  for (let k = 0; k < 8; k++) {
    const p = rSurface.nextInt(256);
    const d = rSurface.nextInt(maxSurfaceDepth + 1);
    const first = SCAN.runFirst[p]!;
    if (first < SCAN.runFirst[p + 1]! && checkSurface(p, SCAN.runTop[first]! - d, `skin voxel depth ${d}`)) acc.surfaceExtraVoxels++;
    else acc.surfaceExtraSkipped++;
  }
  ext?.column?.(view);
  store.freeColumn(cx, cz);
  return indices;
}

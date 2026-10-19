/**
 * SP3e golden digests (SP3e spec §6, D14): the preset windows and the five `sp3e.*` keys, chained last into
 * `allGoldenKeys`/`computeAnyGolden` (`sp2aGoldens.ts`), so the unit tests, `?selftest=1` and `test/tools/goldensJsc.ts`
 * all check them.
 *
 * Window w(a, b) is the 8 × 8 chunks from chunk (8a − 4, 8b − 4) (w(0, 0) is SP3a's window), centre block (128a, 128b).
 * Candidates run in rings r = 0, 1, …, 64 (max(|a|, |b|) = r), within a ring by a then b ascending; the first candidate
 * whose predicate holds through `columnPoint` on the preset's ctx is the preset's window:
 * - amplified: offset0 ≥ 180 at the centre;
 * - archipelago: among the centre and the two blocks (128a ± 60, 128b) on the review line both offset0 < 63 and
 *   offset0 ≥ 63 occur (Checkpoint M: the diagonal probes placed the line on land, 4 sea positions of 512);
 * - floating_islands: islandMask ≥ 0.9 and offset0 < 63 at the centre (an island cluster over the sea).
 * No candidate up to r = 64 throws `no window for <preset>`. The search on seed '42' and the approved values found the
 * windows `sp3eWindow` returns; they are frozen here as constants (the review lines and the region goldens use them;
 * `goldens.sp3e.test.ts` re-runs the search and checks it still finds them).
 *
 * Keys: `sp3e.region.T.<preset>` = `regionHash` of the preset's window, seed '42', generated in process on a fresh
 * `ArrayBuffer` store (as `regionDigest`, `sp3aGoldens.ts`); `sp3e.column.point.<preset>` = `pointDigest` on archipelago
 * and floating_islands (amplified's column points are the default's). Follows the core determinism rules (in
 * `DET_FILES`, arch-tested). Every value is hex64.
 */
import { hex64 } from '../core/hash';
import { resolveProfile } from '../core/params/profiles';
import type { ProfileId as ProfileIdT } from '../core/params/profiles';
import { seedFromInput } from '../core/seed';
import { columnPoint } from '../gen/column/columnPoint';
import { createGenContext } from '../gen/context';
import type { GenContext as GenContextT } from '../gen/context';
import { createStore } from '../world/store/store';
import { pointDigest } from './pointDigest';
import { genRegionInProcess, regionHash } from './region';

const HEX64 = hex64;
const RESOLVE = resolveProfile;
const SEED = seedFromInput;
const POINT = columnPoint;
const CREATE_CTX = createGenContext;
const CREATE_STORE = createStore;
const POINT_DIGEST = pointDigest;
const GEN_REGION = genRegionInProcess;
const REGION_HASH = regionHash;

/** The three draft presets the windows are searched for. */
export type Sp3ePreset = Extract<ProfileIdT, 'archipelago' | 'amplified' | 'floating_islands'>;

/** In `PROFILE_IDS` order. */
export const WINDOW_PRESETS: readonly Sp3ePreset[] = ['archipelago', 'amplified', 'floating_islands'];
const PRESET_SET: ReadonlySet<string> = new Set(WINDOW_PRESETS);

const MAX_RING = 64;
const SEA = 63;
const AMPLIFIED_MIN_OFFSET = 180;
const ISLAND_MIN_MASK = 0.9;
/** Archipelago's two off-centre probes on the review line (along x), blocks from the centre. */
const ARCHIPELAGO_PROBE = 60;

export interface PresetWindow {
  readonly a: number;
  readonly b: number;
  /** The window's first chunk: (8a − 4, 8b − 4). */
  readonly chunkX: number;
  readonly chunkZ: number;
  /** The centre block: (128a, 128b). */
  readonly centreX: number;
  readonly centreZ: number;
}

/** Ring r's candidates (a, b) with max(|a|, |b|) = r, a then b ascending. RangeError outside the integers 0 … 64. */
export function ringCandidates(r: number): Array<[number, number]> {
  if (!Number.isInteger(r) || r < 0 || r > MAX_RING) throw new RangeError(`window ring ${r} is outside 0 … ${MAX_RING}`);
  if (r === 0) return [[0, 0]];
  const out: Array<[number, number]> = [];
  for (let a = -r; a <= r; a++) {
    if (a === -r || a === r) {
      for (let b = -r; b <= r; b++) out.push([a, b]);
    } else {
      out.push([a, -r], [a, r]);
    }
  }
  return out;
}

/** The first candidate (rings 0 … 64) for which `holds(a, b)` is true; throws `no window for <name>` if none. */
export function findWindow(name: string, holds: (a: number, b: number) => boolean): PresetWindow {
  for (let r = 0; r <= MAX_RING; r++) {
    for (const [a, b] of ringCandidates(r)) {
      if (holds(a, b)) return windowAt(a, b);
    }
  }
  throw new Error(`no window for ${name}`);
}

function checkPreset(preset: string): void {
  if (!PRESET_SET.has(preset)) throw new RangeError(`no window search for profile ${preset}`);
}

/** Whether w(a, b) satisfies `preset`'s predicate on `ctx` (which must be the preset's ctx). */
export function windowHolds(preset: Sp3ePreset, ctx: GenContextT, a: number, b: number): boolean {
  checkPreset(preset);
  const x = 128 * a;
  const z = 128 * b;
  if (preset === 'amplified') return POINT(ctx, x, z).offset0 >= AMPLIFIED_MIN_OFFSET;
  if (preset === 'floating_islands') {
    const p = POINT(ctx, x, z);
    return p.islandMask >= ISLAND_MIN_MASK && p.offset0 < SEA;
  }
  let sea = false;
  let land = false;
  const d = ARCHIPELAGO_PROBE;
  for (const [dx, dz] of [[0, 0], [-d, 0], [d, 0]] as const) {
    if (POINT(ctx, x + dx, z + dz).offset0 < SEA) sea = true;
    else land = true;
  }
  return sea && land;
}

/** `preset`'s window on world seed `seedText` (seed '42' for the goldens and the review lines). */
export function presetWindow(preset: Sp3ePreset, seedText = '42'): PresetWindow {
  checkPreset(preset);
  const ctx = CREATE_CTX(SEED(seedText), RESOLVE(preset));
  return findWindow(preset, (a, b) => windowHolds(preset, ctx, a, b));
}

/** The window w(a, b): chunk origin (8a − 4, 8b − 4), centre block (128a, 128b). */
function windowAt(a: number, b: number): PresetWindow {
  return { a, b, chunkX: 8 * a - 4, chunkZ: 8 * b - 4, centreX: 128 * a, centreZ: 128 * b };
}

/**
 * The windows of seed '42' on the approved values, frozen when the goldens were recorded (SP3e spec §6): archipelago
 * w(1, −1), amplified w(−5, 0), floating_islands w(−6, −11). A change of a preset's generation that moves one also
 * changes its `sp3e.*` goldens, so it needs a `GENERATOR_VERSION` bump.
 */
const WINDOWS: ReadonlyMap<string, PresetWindow> = new Map([
  ['archipelago', windowAt(1, -1)],
  ['amplified', windowAt(-5, 0)],
  ['floating_islands', windowAt(-6, -11)],
]);

/** `preset`'s frozen window (seed '42'); RangeError for any other profile. */
export function sp3eWindow(preset: Sp3ePreset): PresetWindow {
  const w = WINDOWS.get(preset);
  if (w === undefined) throw new RangeError(`no window for profile ${preset}`);
  return w;
}

/** The window is 8 × 8 chunks: 64 proto columns, at most 1,536 block and 1,664 byte slots (as SP3a's region golden). */
const WINDOW_CHUNKS = 8;
const MiB = 1048576;

/**
 * `regionHash` of `preset`'s window, world seed '42', generated in process on a fresh `ArrayBuffer` store (never the
 * region cache).
 */
export function sp3eRegionDigest(preset: Sp3ePreset): string {
  const w = sp3eWindow(preset);
  const store = CREATE_STORE({ shared: false, maxBlockBytes: 32 * MiB, maxByteBytes: 16 * MiB });
  GEN_REGION(store, CREATE_CTX(SEED('42'), RESOLVE(preset)), w.chunkX, w.chunkZ, WINDOW_CHUNKS, WINDOW_CHUNKS);
  return HEX64(REGION_HASH(store, w.chunkX, w.chunkZ, WINDOW_CHUNKS, WINDOW_CHUNKS));
}

const REGION_PRESETS: readonly Sp3ePreset[] = ['amplified', 'archipelago', 'floating_islands'];
const POINT_PRESETS: readonly Sp3ePreset[] = ['archipelago', 'floating_islands'];
const REGION_SET: ReadonlySet<string> = new Set(REGION_PRESETS);
const POINT_SET: ReadonlySet<string> = new Set(POINT_PRESETS);

/** The five SP3e keys, in this order (SP3e spec §6). */
export function sp3eGoldenKeys(): string[] {
  return [...REGION_PRESETS.map((p) => `sp3e.region.T.${p}`), ...POINT_PRESETS.map((p) => `sp3e.column.point.${p}`)];
}

export function computeSp3eGolden(key: string): string {
  const region = /^sp3e\.region\.T\.(.+)$/.exec(key);
  if (region !== null && REGION_SET.has(region[1]!)) return sp3eRegionDigest(region[1] as Sp3ePreset);
  const point = /^sp3e\.column\.point\.(.+)$/.exec(key);
  if (point !== null && POINT_SET.has(point[1]!)) return POINT_DIGEST(point[1] as Sp3ePreset);
  throw new Error(`unknown golden ${key}`);
}

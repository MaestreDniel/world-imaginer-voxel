/**
 * SP3e golden module (SP3e spec §6, D14). For now it holds the preset window search only: window w(a, b) is the
 * 8 × 8 chunks from chunk (8a − 4, 8b − 4) (w(0, 0) is SP3a's window), centre block (128a, 128b). Candidates run in
 * rings r = 0, 1, …, 64 (max(|a|, |b|) = r), within a ring by a then b ascending; the first candidate whose predicate
 * holds through `columnPoint` on the preset's ctx is the preset's window:
 * - amplified: offset0 ≥ 180 at the centre;
 * - archipelago: among the centre and the four blocks (128a ± 60, 128b ± 60) both offset0 < 63 and offset0 ≥ 63 occur;
 * - floating_islands: islandMask ≥ 0.9 and offset0 < 63 at the centre (an island cluster over the sea).
 * No candidate up to r = 64 throws `no window for <preset>`. The found centres place the review lines of every tuning
 * set (§1.5 step 1, §8); the goldens commit freezes them as constants and adds the `sp3e.*` keys. Follows the core
 * determinism rules (in `DET_FILES`, arch-tested).
 */
import { resolveProfile } from '../core/params/profiles';
import type { ProfileId as ProfileIdT } from '../core/params/profiles';
import { seedFromInput } from '../core/seed';
import { columnPoint } from '../gen/column/columnPoint';
import { createGenContext } from '../gen/context';
import type { GenContext as GenContextT } from '../gen/context';

const RESOLVE = resolveProfile;
const SEED = seedFromInput;
const POINT = columnPoint;
const CREATE_CTX = createGenContext;

/** The three draft presets the windows are searched for. */
export type Sp3ePreset = Extract<ProfileIdT, 'archipelago' | 'amplified' | 'floating_islands'>;

/** In `PROFILE_IDS` order. */
export const WINDOW_PRESETS: readonly Sp3ePreset[] = ['archipelago', 'amplified', 'floating_islands'];
const PRESET_SET: ReadonlySet<string> = new Set(WINDOW_PRESETS);

const MAX_RING = 64;
const SEA = 63;
const AMPLIFIED_MIN_OFFSET = 180;
const ISLAND_MIN_MASK = 0.9;
/** Archipelago's four off-centre probes, blocks from the centre on each axis. */
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
      if (holds(a, b)) return { a, b, chunkX: 8 * a - 4, chunkZ: 8 * b - 4, centreX: 128 * a, centreZ: 128 * b };
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
  for (const [dx, dz] of [[0, 0], [-d, -d], [-d, d], [d, -d], [d, d]] as const) {
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

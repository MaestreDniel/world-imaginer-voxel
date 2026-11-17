import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Column slices of the scattered metrics (SP6b spec §13 Stage 2 item 1; the user's ruling U15): CI runs
 * `terrain.metric.ts` and `surface.metric.ts` with the large_biomes profile in two slice jobs each and one merge job
 * (`metrics-merge`). `METRICS_SLICE`, read once per file (`columnSlice`):
 * - absent: the whole run (every column, every gated part), as before;
 * - `k/n` (0 ≤ k < n, n ≥ 2): a slice run. The file draws every column and T4 site exactly as the whole run does, keeps
 *   draws k, k + n, k + 2n, … of each list (`sliceOf`), generates and analyses only those, writes its partial
 *   accumulators (`writeSlice`) and gates nothing: its metric tests are skipped;
 * - `merge/n`: the merge run. It reads the n slices' records (`readSlices`), adds them up and runs every metric test of
 *   the whole run on the sums; it generates nothing.
 * Every accumulator the slices hand over is a sum of integer counts, a list the parts sort, or a per-site record the
 * merge folds in site order, so the merge run's records equal the whole run's (timing keys aside).
 */

/** A slice run (draws k, k + n, …) or the merge run of n slices. */
export type ColumnSlice = { readonly kind: 'slice'; readonly k: number; readonly n: number } | { readonly kind: 'merge'; readonly n: number };

/** `METRICS_SLICE` read: absent, the whole run (null); `k/n` a slice; `merge/n` the merge run; anything else throws. */
export function columnSlice(raw: string | undefined): ColumnSlice | null {
  if (raw === undefined) return null;
  const m = /^(\d+|merge)\/(\d+)$/.exec(raw);
  const n = m === null ? NaN : Number(m[2]);
  if (m !== null && Number.isSafeInteger(n) && n >= 2) {
    if (m[1] === 'merge') return { kind: 'merge', n };
    const k = Number(m[1]);
    if (k < n) return { kind: 'slice', k, n };
  }
  throw new Error(`METRICS_SLICE '${raw}' (k/n with 0 ≤ k < n and n ≥ 2, or merge/n)`);
}

/** Slice k of n of a draw list: draws k, k + n, k + 2n, … in list order (the n slices partition the list). */
export const sliceOf = <T>(list: readonly T[], s: { readonly k: number; readonly n: number }): T[] => list.filter((_, i) => i % s.n === s.k);

/** Where a slice run writes its record and the merge run reads them (CI hands them over as artifacts). */
export const SLICES_DIR = fileURLToPath(new URL('../.cache/slices/', import.meta.url));

/** JSON with the two values it would lose: a Float64Array (as `{ $f64 }`) and a non-finite number (as `{ $num }`). */
const replacer = (_: string, v: unknown): unknown =>
  v instanceof Float64Array ? { $f64: Array.from(v) } : typeof v === 'number' && !Number.isFinite(v) ? { $num: String(v) } : v;

const reviver = (_: string, v: unknown): unknown => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === '$f64') return Float64Array.from(o.$f64 as number[]);
  if (keys.length === 1 && keys[0] === '$num') return Number(o.$num);
  return v;
};

const fileOf = (dir: string, name: string, k: number, n: number): string => join(dir, `${name}.${k}of${n}.json`);

/**
 * Writes slice `s`'s record of `name` (the file and its run, e.g. `terrain-quick-large_biomes`): `meta` the run's
 * constants (tier, profiles, seeds, sizes), which the merge run checks, and `data` the partial accumulators. Returns
 * the file written.
 */
export function writeSlice(name: string, s: { readonly k: number; readonly n: number }, meta: unknown, data: unknown, dir = SLICES_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, name, s.k, s.n);
  writeFileSync(file, JSON.stringify({ k: s.k, n: s.n, meta, data }, replacer));
  return file;
}

/**
 * The n slices' records of `name`, in slice order (their `data`). Throws when a slice's record is missing, was written
 * by a run with other constants than `meta`, or names another slice.
 */
export function readSlices(name: string, n: number, meta: unknown, dir = SLICES_DIR): unknown[] {
  const want = JSON.stringify(meta, replacer);
  return Array.from({ length: n }, (_, k) => {
    const file = fileOf(dir, name, k, n);
    if (!existsSync(file)) throw new Error(`readSlices ${name}: no record of slice ${k}/${n} (${file})`);
    const r = JSON.parse(readFileSync(file, 'utf8'), reviver) as { k: number; n: number; meta: unknown; data: unknown };
    if (r.k !== k || r.n !== n) throw new Error(`readSlices ${name}: the record of slice ${k}/${n} says it is slice ${r.k}/${r.n}`);
    if (JSON.stringify(r.meta, replacer) !== want) throw new Error(`readSlices ${name}: slice ${k}/${n} was written by another run`);
    return r.data;
  });
}

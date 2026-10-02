/**
 * Biome table model (SP2b spec §5.2, §5.3), pure: the rows of the Biomes tab (sorted and filtered) and the edits
 * of one row. Every edit returns a new table, sharing the untouched rows and never mutating its input, which the
 * page writes whole with `session.set(BIOME_TABLE_PATH, table)`; when nothing changes it returns the input
 * table itself. Typed values are checked by the schema's own validator, so a refusal carries the code, path
 * and message `session.set` would give, except a duplicate priority, which is reported on the edited row
 * whatever the row order (the validator names the later row). The rest serves the table's DOM (table.ts):
 * the text of the typed cells, the bar geometry of the interval drags, the modified cells, the issue line under
 * a row, the swatch colour and what hovering a row does on the map. The last part serves the biome share
 * preview (§5.5, shares.ts): its requests, its bars and its B1-style warnings.
 */
import { BOX_BIOMES, type BoxBiome } from '../../core/params/biomeDefaults';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { BOX_AXES, checkLeaf, type BoxAxis, type BoxRow, type BoxTable, type Interval, type Issue, type Leaf } from '../../core/params/kit';
import { SCHEMA } from '../../core/params/schema';
import { JobCancelled, type WorkerPool } from '../../engine/workerPool';
import { biomeColor, biomeFamily, biomeId, SURFACE_BIOMES, type BiomeFamily, type SurfaceBiome } from '../../gen/biomes/registry';
import type { LayerId } from '../../gen/map/layers';
import { BIOME_SHARES_POINTS, biomeSharesLength, summarizeBiomeShares, type BiomeShareSummary } from '../../metrics/biomeShares';
import { parseFieldText } from '../paramPanel/model';

export const BIOME_TABLE_PATH = 'biomes.table';

export type TableSort = 'priority' | 'name' | 'family';
export interface RowView { readonly name: BoxBiome; readonly biome: number; readonly family: BiomeFamily; readonly row: BoxRow }
export type TableEdit = { readonly ok: true; readonly table: BoxTable<BoxBiome> } | { readonly ok: false; readonly issue: Issue };

/** The families of the box rows, in registry order: the family sort order and the filter's options. */
export const TABLE_FAMILIES: readonly BiomeFamily[] = [...new Set(BOX_BIOMES.map((n) => biomeFamily(biomeId(n))))];

/** Narrowest interval a bar drag leaves (spec §5.2). */
const DRAG_GAP = 1 / 1024;

const TABLE_LEAF: Leaf<unknown, unknown> = SCHEMA.leaves.find((l) => l.path === BIOME_TABLE_PATH)!.leaf;

const byPriority = (a: RowView, b: RowView): number => a.row.priority - b.row.priority;
const byName = (a: RowView, b: RowView): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byFamily = (a: RowView, b: RowView): number =>
  TABLE_FAMILIES.indexOf(a.family) - TABLE_FAMILIES.indexOf(b.family) || byPriority(a, b);

/** One view per box row, keeping the rows of `family` (all when null), sorted by `sort`. */
export function tableRows(t: BoxTable<BoxBiome>, sort: TableSort, family: BiomeFamily | null): RowView[] {
  const rows: RowView[] = [];
  for (const name of BOX_BIOMES) {
    const biome = biomeId(name);
    const fam = biomeFamily(biome);
    if (family === null || fam === family) rows.push({ name, biome, family: fam, row: t[name] });
  }
  return rows.sort(sort === 'priority' ? byPriority : sort === 'name' ? byName : byFamily);
}

/** `t` with `name`'s row replaced, or `t` itself when the row is unchanged. */
function withRow(t: BoxTable<BoxBiome>, name: BoxBiome, row: BoxRow): BoxTable<BoxBiome> {
  return canonicalJSON(row) === canonicalJSON(t[name]) ? t : { ...t, [name]: row };
}

/** Validates `t` with `name`'s row replaced; `t` is a valid table (the session's), so any issue is the edit's. */
function checked(t: BoxTable<BoxBiome>, name: BoxBiome, row: Record<string, unknown>): Issue | null {
  const out: Issue[] = [];
  checkLeaf(TABLE_LEAF, { ...t, [name]: row }, BIOME_TABLE_PATH, out);
  return out[0] ?? null;
}

/** DUPLICATE_PRIORITY on `name`'s row when another row already uses `priority`. */
function duplicate(t: BoxTable<BoxBiome>, name: BoxBiome, priority: number): Issue | null {
  for (const other of BOX_BIOMES) {
    if (other !== name && t[other].priority === priority) {
      return { path: `${BIOME_TABLE_PATH}.${name}.priority`, code: 'DUPLICATE_PRIORITY', message: `priority ${priority} is also used by ${other}` };
    }
  }
  return null;
}

/** A typed interval: refused with the edited cell's issue (lo ≥ hi gives BAD_INTERVAL on the axis). */
export function setAxis(t: BoxTable<BoxBiome>, name: BoxBiome, axis: BoxAxis, lo: number, hi: number): TableEdit {
  const issue = checked(t, name, { ...t[name], [axis]: [lo, hi] });
  if (issue !== null) return { ok: false, issue };
  const iv: Interval = [q15(lo), q15(hi)];
  return { ok: true, table: withRow(t, name, { ...t[name], [axis]: iv }) };
}

/**
 * A bar-end drag: lo is clamped to [−1, hi − 2⁻¹⁰] and hi to [lo + 2⁻¹⁰, 1], then q15'd, so a drag never
 * gives BAD_INTERVAL. A NaN value changes nothing.
 */
export function dragAxisEnd(t: BoxTable<BoxBiome>, name: BoxBiome, axis: BoxAxis, end: 'lo' | 'hi', value: number): BoxTable<BoxBiome> {
  if (Number.isNaN(value)) return t;
  const [lo, hi] = t[name][axis];
  const iv: Interval = end === 'lo'
    ? [q15(Math.max(-1, Math.min(hi - DRAG_GAP, value))), hi]
    : [lo, q15(Math.min(1, Math.max(lo + DRAG_GAP, value)))];
  return withRow(t, name, { ...t[name], [axis]: iv });
}

export function setWSign(t: BoxTable<BoxBiome>, name: BoxBiome, s: -1 | 0 | 1): BoxTable<BoxBiome> {
  return withRow(t, name, { ...t[name], wSign: s === 0 ? 0 : s });
}

/** A typed priority: a duplicate is checked against the other 25 rows first, then the integer range 1-1000. */
export function setPriority(t: BoxTable<BoxBiome>, name: BoxBiome, priority: number): TableEdit {
  const issue = duplicate(t, name, priority) ?? checked(t, name, { ...t[name], priority });
  if (issue !== null) return { ok: false, issue };
  return { ok: true, table: withRow(t, name, { ...t[name], priority: q15(priority) }) };
}

/** `name`'s row back to the profile's (`from`); refused when another row now holds the profile's priority. */
export function resetRow(t: BoxTable<BoxBiome>, from: BoxTable<BoxBiome>, name: BoxBiome): TableEdit {
  const issue = duplicate(t, name, from[name].priority);
  if (issue !== null) return { ok: false, issue };
  return { ok: true, table: withRow(t, name, from[name]) };
}

/** The text of an interval cell, `lo, hi`, which setAxisText reads back. */
export function intervalText(iv: Interval): string {
  return `${iv[0]}, ${iv[1]}`;
}

/**
 * A typed interval cell: `lo, hi`, with optional brackets and a comma, a semicolon or spaces between the two
 * numbers. Text that is not two parts is refused with BAD_INTERVAL on the axis, a part that is not a number
 * with the validator's issue on its item (`….C[0]`); two numbers go through setAxis.
 */
export function setAxisText(t: BoxTable<BoxBiome>, name: BoxBiome, axis: BoxAxis, text: string): TableEdit {
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  const parts = body === '' ? [] : body.split(/\s*[,;]\s*|\s+/);
  if (parts.length !== 2) {
    return { ok: false, issue: { path: `${BIOME_TABLE_PATH}.${name}.${axis}`, code: 'BAD_INTERVAL', message: `expected "lo, hi", got ${JSON.stringify(text.trim())}` } };
  }
  const lo = parseFieldText(parts[0]!);
  const hi = parseFieldText(parts[1]!);
  if (typeof lo === 'number' && typeof hi === 'number') return setAxis(t, name, axis, lo, hi);
  // A part that is not a number: the validator's own issue on that item (NOT_NUMBER).
  return { ok: false, issue: checked(t, name, { ...t[name], [axis]: [lo, hi] })! };
}

/** A typed priority cell: a number goes through setPriority, other text gets the validator's issue (NOT_NUMBER). */
export function setPriorityText(t: BoxTable<BoxBiome>, name: BoxBiome, text: string): TableEdit {
  const v = parseFieldText(text);
  if (typeof v === 'number') return setPriority(t, name, v);
  return { ok: false, issue: checked(t, name, { ...t[name], priority: v })! };
}

/** The cells of a row: the five axes, then the sign filter and the priority. */
export type RowCell = BoxAxis | 'wSign' | 'priority';
const ROW_CELLS: readonly RowCell[] = [...BOX_AXES, 'wSign', 'priority'];

/** The cells of `row` that differ from the profile's row `from`, in ROW_CELLS order. */
export function rowChanges(row: BoxRow, from: BoxRow): RowCell[] {
  return row === from ? [] : ROW_CELLS.filter((k) => canonicalJSON(row[k]) !== canonicalJSON(from[k]));
}

/** The rows of `t` that differ from the profile's table `from`, in BOX_BIOMES order. */
export function modifiedRows(t: BoxTable<BoxBiome>, from: BoxTable<BoxBiome>): BoxBiome[] {
  return BOX_BIOMES.filter((n) => rowChanges(t[n], from[n]).length > 0);
}

/** A bar drag writes values on a 0.01 grid (one pixel of a bar is about 0.01 wide). */
const BAR_GRID = 100;

/** Where a bar over [−1, 1] shows `v`, as a fraction of its width. */
export function barFraction(v: number): number {
  return (v + 1) / 2;
}

/**
 * The value under a pointer `px` from the left edge of a bar `width` px wide, rounded to 0.01 (never −0) and
 * not clamped: dragAxisEnd clamps. NaN for a bar without width.
 */
export function barValue(px: number, width: number): number {
  if (!(width > 0)) return Number.NaN;
  return Math.round(((2 * px) / width - 1) * BAR_GRID) / BAR_GRID + 0;
}

/** The end of the bar of `iv` a press at `px` grabs: the nearer one within `slackPx` (a tie goes to hi), else null. */
export function hitBarEnd(iv: Interval, px: number, width: number, slackPx: number): 'lo' | 'hi' | null {
  if (!(width > 0)) return null;
  const dLo = Math.abs(px - barFraction(iv[0]) * width);
  const dHi = Math.abs(px - barFraction(iv[1]) * width);
  if (Math.min(dLo, dHi) > slackPx) return null;
  return dLo < dHi ? 'lo' : 'hi';
}

/** The issue line under `name`'s row: the issue's path relative to the row (`C: …`, `C[0]: …`), or `cannot reset: …`. */
export function rowIssueText(name: BoxBiome, issue: Issue, reset = false): string {
  if (reset) return `cannot reset: ${issue.message}`;
  const base = `${BIOME_TABLE_PATH}.${name}.`;
  return `${issue.path.startsWith(base) ? issue.path.slice(base.length) : issue.path}: ${issue.message}`;
}

/** The CSS colour of a biome's swatch: its map colour. */
export function swatchColor(biome: number): string {
  return `#${biomeColor(biome).toString(16).padStart(6, '0')}`;
}

/** Shown when a row is hovered while the map shows another layer (spec §5.3). */
export const HIGHLIGHT_NOTICE = 'switch to the biome layer to highlight';

/**
 * What hovering a row does on the map's `layer`: `biome` is the hovered row's (null when the pointer leaves the
 * rows) and `was` the one hovered before. The biome layer highlights it; another layer shows the notice once, as
 * the pointer enters the rows, not again for each row it crosses.
 */
export function rowHover(layer: LayerId, biome: number | null, was: number | null): { readonly highlight: number | null; readonly notice: boolean } {
  if (biome === null) return { highlight: null, notice: false };
  return layer === 'biome' ? { highlight: biome, notice: false } : { highlight: null, notice: was === null };
}

// ---------------------------------------------------------------- biome share preview (spec §5.5)

/** B1's thresholds (test/thresholds.ts), which the preview's warnings apply to the draft (a unit test pins them). */
export const SHARE_LIMITS = Object.freeze({ unreachable: 0.001, dominant: 0.16, oceanMin: 0.25, oceanMax: 0.45, ties: 0, outside: 0.02 });

/** A share as a percentage: two decimals from 1 %, three below (one point of the 100 000 is 0.001 %), `0 %` for none. */
export function shareText(share: number): string {
  const p = share * 100;
  return p === 0 ? '0 %' : `${p.toFixed(p >= 1 ? 2 : 3)} %`;
}

/** A limit as a percentage without trailing zeros: 0.001 → `0.1 %`. */
const limitText = (v: number): string => `${Number((v * 100).toFixed(3))} %`;
/** A count with its thousands separated by spaces: 100000 → `100 000`. */
export function countText(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
/** The families B1's largestLand covers: every family but ocean and river. */
const isLand = (f: BiomeFamily): boolean => f !== 'ocean' && f !== 'river';

export type ShareWarningKind = 'unreachable' | 'dominant' | 'ocean' | 'ties' | 'outside';
export interface ShareWarning {
  readonly kind: ShareWarningKind;
  /** The biome it is about (unreachable, dominant), else null. */
  readonly biome: number | null;
  readonly text: string;
}

/**
 * The B1-style warnings of a result (spec §5.5), in the spec's order: unreachable biomes (under 0.1 %, every
 * surface biome) and dominant ones (over 16 %, land biomes) in registry order, then the ocean family outside
 * 25-45 %, any tie and outside every box over 2 %. A limit itself passes, as in B1. An empty result has none.
 */
export function shareWarnings(s: BiomeShareSummary): ShareWarning[] {
  if (!(s.total > 0)) return [];
  const L = SHARE_LIMITS;
  const out: ShareWarning[] = [];
  SURFACE_BIOMES.forEach((name, biome) => {
    const share = s.shares[biome]!;
    if (share < L.unreachable) out.push({ kind: 'unreachable', biome, text: `${name} ${shareText(share)}: unreachable (below ${limitText(L.unreachable)})` });
  });
  SURFACE_BIOMES.forEach((name, biome) => {
    const share = s.shares[biome]!;
    if (isLand(biomeFamily(biome)) && share > L.dominant) {
      out.push({ kind: 'dominant', biome, text: `${name} ${shareText(share)}: dominant (above ${limitText(L.dominant)} for a land biome)` });
    }
  });
  if (s.oceanFamily < L.oceanMin || s.oceanFamily > L.oceanMax) {
    out.push({ kind: 'ocean', biome: null, text: `ocean family ${shareText(s.oceanFamily)}: outside ${Number((L.oceanMin * 100).toFixed(3))}-${limitText(L.oceanMax)}` });
  }
  if (s.ties > L.ties) {
    const n = Math.round(s.ties * s.total);
    out.push({ kind: 'ties', biome: null, text: `ties ${shareText(s.ties)} (${countText(n)} point${n === 1 ? '' : 's'}): two boxes fit equally and the priority decides` });
  }
  if (s.outside > L.outside) out.push({ kind: 'outside', biome: null, text: `outside every box ${shareText(s.outside)}: above ${limitText(L.outside)}` });
  return out;
}

/**
 * The chart's full scale: the largest share rounded up to a multiple of 5 %, at least 20 % (so the 16 % mark shows).
 * A share of exactly k/20 stays k/20: (k/20)·20 is exactly k for every k ≤ 20.
 */
export function shareScale(largest: number): number {
  return Math.max(0.2, Math.ceil(largest * 20) / 20);
}

export interface ShareBar {
  readonly biome: number;
  readonly name: SurfaceBiome;
  readonly family: BiomeFamily;
  /** The dominance limit applies (B1's largestLand families): the row shows the 16 % mark. */
  readonly land: boolean;
  readonly share: number;
  /** The bar's length as a fraction of the chart's scale. */
  readonly fraction: number;
  readonly text: string;
  readonly warning: 'unreachable' | 'dominant' | null;
}

export interface ShareChart {
  /** One bar per surface biome, in registry order (grouped by family). */
  readonly bars: readonly ShareBar[];
  /** The share at the full length of a bar. */
  readonly scale: number;
  /** Where the dominance limit (16 %) sits, as a fraction of the scale. */
  readonly dominantAt: number;
  readonly warnings: readonly ShareWarning[];
  /** `ocean family … · ties … · outside every box … · N points`. */
  readonly totals: string;
}

/** The chart of a result: its bars, scale, warnings and totals line. */
export function shareChart(s: BiomeShareSummary): ShareChart {
  const scale = shareScale(Math.max(...s.shares));
  const warnings = shareWarnings(s);
  const bars = SURFACE_BIOMES.map((name, biome): ShareBar => {
    const family = biomeFamily(biome);
    const share = s.shares[biome]!;
    const w = warnings.find((x) => x.biome === biome);
    return {
      biome, name, family, land: isLand(family), share, fraction: share / scale, text: shareText(share),
      warning: w !== undefined && (w.kind === 'unreachable' || w.kind === 'dominant') ? w.kind : null,
    };
  });
  const totals = `ocean family ${shareText(s.oceanFamily)} · ties ${shareText(s.ties)} · outside every box ${shareText(s.outside)} · ${countText(s.total)} points`;
  return { bars, scale, dominantAt: SHARE_LIMITS.dominant / scale, warnings, totals };
}

export type SharesView = 'none' | 'fresh' | 'stale';

/**
 * How the chart shows its last result: none before the first; fresh while it ran on the draft (same session
 * epoch) and no gesture is active; stale from the next session change, or during a gesture, until a new result.
 */
export function sharesView(shownEpoch: number | null, epoch: number, inGesture: boolean): SharesView {
  if (shownEpoch === null) return 'none';
  return !inGesture && shownEpoch === epoch ? 'fresh' : 'stale';
}

/** The status next to the chart's title; empty while fresh. */
export function sharesStatus(view: SharesView, pending: boolean): string {
  if (view === 'fresh') return '';
  if (view === 'none') return pending ? 'computing…' : 'shares follow when the preview settles';
  return pending ? 'stale: computing…' : 'stale: updates when the preview settles';
}

export interface ShareSource {
  /** The draft's session epoch and whether a gesture is active (a WorldSession). */
  readonly session: { readonly state: { readonly epoch: number }; readonly inGesture: boolean };
  readonly pool: Pick<WorkerPool, 'stats'>;
  /** Whether the chart is on screen: a hidden chart requests nothing. */
  visible(): boolean;
  /** The pending request or the shown result changed. */
  changed(): void;
  /** A request failed with something other than JobCancelled (the chart stays stale). */
  failed(message: string): void;
}

export interface ShareRequests {
  /**
   * Requests the shares of the draft (`biomeShares` over the whole §5.5 stream) when `settled`, the chart is on
   * screen and no gesture is active, unless the shown result or the pending request is already for this epoch.
   * The caller passes the driver's settled state (true from inside onSettled, whose status still reads false).
   */
  request(settled: boolean): void;
  /** The last result and the session epoch of the draft it ran on. */
  readonly shown: { readonly epoch: number; readonly summary: BiomeShareSummary } | null;
  /** The session epoch of the request in flight, if any. Only its result is shown. */
  readonly pending: number | null;
}

/**
 * The share preview's requests (spec §5.5): one `pool.stats('biomeShares', …)` per session epoch, made when the
 * preview driver settles, so it runs on the draft the map shows. JobCancelled (a newer configure) keeps the last
 * result silently, any other error reports it; either way the next settle requests again.
 */
export function createShareRequests(src: ShareSource): ShareRequests {
  let shown: ShareRequests['shown'] = null;
  let pending: number | null = null;
  return {
    request(settled) {
      if (!settled || src.session.inGesture || !src.visible()) return;
      const epoch = src.session.state.epoch;
      if (shown?.epoch === epoch || pending === epoch) return;
      pending = epoch;
      src.changed();
      src.pool.stats('biomeShares', BIOME_SHARES_POINTS, { len: biomeSharesLength() }).then((sum) => {
        if (pending !== epoch) return;
        pending = null;
        shown = { epoch, summary: summarizeBiomeShares(sum) };
        src.changed();
      }, (e: unknown) => {
        if (pending !== epoch) return;
        pending = null;
        if (!(e instanceof JobCancelled)) src.failed(e instanceof Error ? e.message : String(e));
        src.changed();
      });
    },
    get shown() { return shown; },
    get pending() { return pending; },
  };
}

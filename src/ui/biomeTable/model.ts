/**
 * Biome table model (SP2b spec §5.2, §5.3), pure: the rows of the Biomes tab (sorted and filtered) and the edits
 * of one row. Every edit returns a new table, sharing the untouched rows and never mutating its input, which the
 * page writes whole with `session.set(BIOME_TABLE_PATH, table)`; when nothing changes it returns the input
 * table itself. Typed values are checked by the schema's own validator, so a refusal carries the code, path
 * and message `session.set` would give, except a duplicate priority, which is reported on the edited row
 * whatever the row order (the validator names the later row). The rest serves the table's DOM (table.ts):
 * the text of the typed cells, the bar geometry of the interval drags, the modified cells, the issue line under
 * a row, the swatch colour and what hovering a row does on the map.
 */
import { BOX_BIOMES, type BoxBiome } from '../../core/params/biomeDefaults';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { BOX_AXES, checkLeaf, type BoxAxis, type BoxRow, type BoxTable, type Interval, type Issue, type Leaf } from '../../core/params/kit';
import { SCHEMA } from '../../core/params/schema';
import { biomeColor, biomeFamily, biomeId, type BiomeFamily } from '../../gen/biomes/registry';
import type { LayerId } from '../../gen/map/layers';
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

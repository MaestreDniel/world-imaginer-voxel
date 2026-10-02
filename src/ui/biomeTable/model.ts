/**
 * Biome table model (SP2b spec §5.2), pure: the rows of the Biomes tab (sorted and filtered) and the edits of
 * one row. Every edit returns a new table, sharing the untouched rows and never mutating its input, which the
 * page writes whole with `session.set(BIOME_TABLE_PATH, table)`; when nothing changes it returns the input
 * table itself. Typed values are checked by the schema's own validator, so a refusal carries the code, path
 * and message `session.set` would give, except a duplicate priority, which is reported on the edited row
 * whatever the row order (the validator names the later row).
 */
import { BOX_BIOMES, type BoxBiome } from '../../core/params/biomeDefaults';
import { canonicalJSON, q15 } from '../../core/params/canonical';
import { checkLeaf, type BoxAxis, type BoxRow, type BoxTable, type Interval, type Issue, type Leaf } from '../../core/params/kit';
import { SCHEMA } from '../../core/params/schema';
import { biomeFamily, biomeId, type BiomeFamily } from '../../gen/biomes/registry';

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

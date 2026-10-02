/**
 * Shape files (SP2b spec §4.4), the pure part of the drawer's export and import: `{format: 'wi10-shape',
 * leaf, spline}`. Import validates the spline against the open leaf's coords and range, whatever leaf the
 * file names; `leaf` is optional (the master's original format has none).
 */
import { isObj } from '../../core/params/kit';
import type { NestedSpline, SplineOpts } from '../../core/spline/types';
import { normalizeSpline, validateSpline } from '../../core/spline/validate';
import type { SplineLeaf } from '../../metrics/splineStats';

export const SHAPE_FORMAT = 'wi10-shape';
const SHAPE_KEYS = ['format', 'leaf', 'spline'];

export interface ShapeDoc {
  readonly format: typeof SHAPE_FORMAT;
  readonly leaf: SplineLeaf;
  readonly spline: NestedSpline;
}

/** `<leaf key>.wi10-shape.json`, e.g. `offset.wi10-shape.json`. */
export function shapeFileName(leaf: SplineLeaf): string {
  return `${leaf.slice(leaf.lastIndexOf('.') + 1)}.${SHAPE_FORMAT}.json`;
}

/** The file text: `{format, leaf, spline}` as 2-space JSON, newline-terminated. */
export function shapeText(leaf: SplineLeaf, spline: NestedSpline): string {
  const doc: ShapeDoc = { format: SHAPE_FORMAT, leaf, spline };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export type ShapeRead =
  | { readonly ok: true; readonly spline: NestedSpline; readonly notice: string | null }
  | { readonly ok: false; readonly issues: readonly string[] };

const line = (path: string, code: string, message: string): string => `${path === '' ? 'file' : path}: ${code} — ${message}`;

/**
 * JSON.parse → envelope (unknown keys, then the format, stopping there when it is wrong; `leaf`, when
 * present, must be a string) → validateSpline against `opts`, the open leaf's options, with issue paths
 * under `spline`. On success the spline is normalised (q15); a file naming another leaf gets a notice.
 */
export function readShapeText(text: string, leafPath: SplineLeaf, opts: SplineOpts): ShapeRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [`file is not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isObj(doc)) return { ok: false, issues: [line('', 'NOT_OBJECT', 'a shape file must be a JSON object')] };
  const issues: string[] = [];
  for (const k of Object.keys(doc)) if (!SHAPE_KEYS.includes(k)) issues.push(line(k, 'UNKNOWN_KEY', `unknown key "${k}"`));
  if (doc['format'] !== SHAPE_FORMAT) return { ok: false, issues: [...issues, line('format', 'BAD_FORMAT', `format must be "${SHAPE_FORMAT}"`)] };
  const leaf = doc['leaf'];
  if (Object.hasOwn(doc, 'leaf') && typeof leaf !== 'string') issues.push(line('leaf', 'BAD_FORMAT', 'leaf must be a parameter path such as shape.offset'));
  if (!Object.hasOwn(doc, 'spline')) return { ok: false, issues: [...issues, line('spline', 'MISSING_KEY', 'missing')] };
  const spline = doc['spline'];
  for (const i of validateSpline(spline, 'spline', opts)) issues.push(line(i.path, i.code, i.message));
  if (issues.length > 0) return { ok: false, issues };
  const notice = typeof leaf === 'string' && leaf !== leafPath ? `the file's shape is for ${JSON.stringify(leaf)}; imported into ${leafPath}` : null;
  return { ok: true, spline: normalizeSpline(spline as NestedSpline), notice };
}

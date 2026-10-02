import { q15 } from '../params/canonical';
import { SPLINE_COORDS, SPLINE_MAX_ABS_D, SPLINE_MAX_ABS_X, SPLINE_MAX_OBJECTS, SPLINE_MAX_POINTS, SPLINE_SLOT } from './types';
import type { NestedSpline, SplineOpts, SplinePoint } from './types';

const Q15 = q15;
const COORDS = SPLINE_COORDS;
const SLOT = SPLINE_SLOT;
const MAX_POINTS = SPLINE_MAX_POINTS;
const MAX_OBJECTS = SPLINE_MAX_OBJECTS;
const MAX_ABS_X = SPLINE_MAX_ABS_X;
const MAX_ABS_D = SPLINE_MAX_ABS_D;

export type SplineErrorCode =
  | 'NOT_OBJECT' | 'UNKNOWN_KEY' | 'BAD_COORD' | 'COORD_REUSED' | 'POINTS_NOT_ARRAY' | 'EMPTY' | 'TOO_MANY_POINTS'
  | 'POINT_NOT_OBJECT' | 'X_NOT_FINITE' | 'X_OUT_OF_RANGE' | 'D_NOT_FINITE' | 'D_OUT_OF_RANGE' | 'Y_NOT_FINITE'
  | 'Y_OUT_OF_RANGE' | 'Y_BAD_TYPE' | 'X_DUPLICATE' | 'X_UNSORTED' | 'PROGRAM_TOO_LARGE';

export interface SplineIssue {
  readonly path: string;
  readonly code: SplineErrorCode;
  readonly message: string;
}

export class SplineValidationError extends Error {
  readonly issues: readonly SplineIssue[];
  constructor(issues: readonly SplineIssue[]) {
    super(`invalid spline: ${issues.map((i) => `${i.path === '' ? '<root>' : i.path}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

const SPLINE_KEYS = ['coord', 'points'];
const POINT_KEYS = ['x', 'y', 'd'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The single spline validator (SP1 spec §3.2). Applies q15 before every check, collects every issue in
 * DFS pre-order and never throws; [] exactly when compileSpline(value, opts) succeeds. With |x| ≤ 2,
 * |d| ≤ 1e5 and a finite [yMin, yMax], [] also means every evaluation at finite coords is finite (SP2b §6.1).
 */
export function validateSpline(value: unknown, basePath = '', opts: SplineOpts = {}): SplineIssue[] {
  const issues: SplineIssue[] = [];
  const allowed = opts.coords ?? COORDS;
  const yMin = opts.yMin ?? -Infinity;
  const yMax = opts.yMax ?? Infinity;
  let objects = 0;
  const push = (code: SplineErrorCode, path: string, message: string) => issues.push({ path, code, message });
  const walk = (node: unknown, path: string, used: number): void => {
    const at = (k: string) => (path === '' ? k : `${path}.${k}`);
    if (!isRecord(node)) { push('NOT_OBJECT', path, 'a spline must be an object {coord, points}'); return; }
    objects++;
    for (const k of Object.keys(node)) if (!SPLINE_KEYS.includes(k)) push('UNKNOWN_KEY', at(k), `unknown key "${k}"`);
    const coord = node['coord'];
    let slot = -1;
    if (typeof coord === 'string' && (allowed as readonly string[]).includes(coord) && Object.hasOwn(SLOT, coord)) {
      slot = SLOT[coord as keyof typeof SLOT];
      if ((used >> slot) & 1) push('COORD_REUSED', at('coord'), `coord ${coord} is already used by an enclosing spline`);
    } else {
      push('BAD_COORD', at('coord'), `coord must be one of ${allowed.join('|')}`);
    }
    const pts = node['points'];
    if (!Array.isArray(pts)) { push('POINTS_NOT_ARRAY', at('points'), 'points must be an array'); return; }
    if (pts.length === 0) { push('EMPTY', at('points'), 'a spline needs at least 1 point'); return; }
    if (pts.length > MAX_POINTS) push('TOO_MANY_POINTS', at('points'), `at most ${MAX_POINTS} points`);
    const nextUsed = slot >= 0 ? used | (1 << slot) : used;
    let prevX = Number.NaN;
    for (let i = 0; i < pts.length; i++) {
      const p: unknown = pts[i];
      const pp = `${at('points')}[${i}]`;
      if (!isRecord(p)) { push('POINT_NOT_OBJECT', pp, 'a point must be an object {x, y, d}'); continue; }
      for (const k of Object.keys(p)) if (!POINT_KEYS.includes(k)) push('UNKNOWN_KEY', `${pp}.${k}`, `unknown key "${k}"`);
      if (!isFiniteNumber(p['x'])) {
        push('X_NOT_FINITE', `${pp}.x`, 'x must be a finite number');
      } else {
        const x = Q15(p['x']);
        if (Math.abs(x) > MAX_ABS_X) push('X_OUT_OF_RANGE', `${pp}.x`, `x = ${x} outside [${-MAX_ABS_X}, ${MAX_ABS_X}]`);
        if (x === prevX) push('X_DUPLICATE', `${pp}.x`, `x = ${x} duplicates the previous point`);
        else if (x < prevX) push('X_UNSORTED', `${pp}.x`, `x = ${x} is below the previous point (${prevX})`);
        prevX = x;
      }
      if (!isFiniteNumber(p['d'])) {
        push('D_NOT_FINITE', `${pp}.d`, 'd (tangent) must be a finite number');
      } else {
        const d = Q15(p['d']);
        if (Math.abs(d) > MAX_ABS_D) push('D_OUT_OF_RANGE', `${pp}.d`, `d = ${d} outside [${-MAX_ABS_D}, ${MAX_ABS_D}]`);
      }
      const y: unknown = p['y'];
      if (typeof y === 'number') {
        if (!Number.isFinite(y)) push('Y_NOT_FINITE', `${pp}.y`, 'y must be finite');
        else if (Q15(y) < yMin || Q15(y) > yMax) push('Y_OUT_OF_RANGE', `${pp}.y`, `y = ${y} outside [${yMin}, ${yMax}]`);
      } else if (isRecord(y)) {
        walk(y, `${pp}.y`, nextUsed);
      } else {
        push('Y_BAD_TYPE', `${pp}.y`, 'y must be a number or a nested spline');
      }
    }
  };
  walk(value, basePath, 0);
  if (objects > MAX_OBJECTS) push('PROGRAM_TOO_LARGE', basePath, `${objects} spline objects (max ${MAX_OBJECTS})`);
  return issues;
}

/** Every number replaced by q15(v) + 0 (assumes a valid spline). */
export function normalizeSpline(s: NestedSpline): NestedSpline {
  const points: SplinePoint[] = s.points.map((p) => ({
    x: Q15(p.x) + 0,
    y: typeof p.y === 'number' ? Q15(p.y) + 0 : normalizeSpline(p.y),
    d: Q15(p.d) + 0,
  }));
  return { coord: s.coord, points };
}

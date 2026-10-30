/**
 * The 3D page's query (SP4a spec §8.1; rulings P42, P48): `?at=x,z` (integers clamped to ±500,000, master §2.1),
 * `y` (clamped to −64 … 400), `yaw` and `pitch` in degrees (copied unchanged), `rd` (an integer clamped to 4 … 16),
 * `workers` (an integer clamped to 2 … 6), `renderer=batch|mesh` (§6.2), and the capture mode's `shot=1` and `time`
 * (hours in [0, 24)), and a saved world's `world=<id>` (SP5b spec §3.4, D4). A malformed value is null; it never throws.
 * Which keys skip the start screen is `startModeOf`'s (`startScreen.ts`).
 */
import { RD_MAX, RD_MIN } from '../../engine/renderDistance';
import type { SectionRendererKind } from '../../render/sectionRenderer';

export interface WorldQuery {
  readonly at: { readonly x: number; readonly z: number } | null;
  readonly y: number | null;
  /** Degrees (ruling P42: yaw 0 faces −z, 90 faces +x). */
  readonly yaw: number | null;
  readonly pitch: number | null;
  readonly rd: number | null;
  readonly workers: number | null;
  readonly renderer: SectionRendererKind | null;
  /** The capture mode (ruling P48): true only for `shot=1`. */
  readonly shot: boolean;
  /** Hours in [0, 24) for the capture mode's fixed clock; null otherwise (and ignored without `shot`). */
  readonly time: number | null;
  /** The saved world's id (SP5b spec §3.4): the page opens its records instead of the `#` hash; null when absent or empty. */
  readonly world: string | null;
}

/** The world's horizontal window (master §2.1). */
export const AT_LIMIT = 500_000;
/** The camera's vertical range (SP4a spec §7.5). */
export const Y_MIN = -64;
export const Y_MAX = 400;
/** The pool size's range (`poolSize`, SP4a spec §8.4). */
export const WORKERS_MIN = 2;
export const WORKERS_MAX = 6;

const INTEGER = /^[+-]?\d{1,15}$/;
/** A plain decimal: an optional sign, digits with an optional fraction (no exponent, no hex, no Infinity). */
const DECIMAL = /^[+-]?(?:\d{1,15}(?:\.\d*)?|\.\d+)$/;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The integer in `s`, or null when `s` is absent or not an integer. */
function integer(s: string | null): number | null {
  if (s === null) return null;
  const t = s.trim();
  return INTEGER.test(t) ? Number(t) + 0 : null;
}

/** The finite decimal number in `s`, or null. */
function decimal(s: string | null): number | null {
  if (s === null) return null;
  const t = s.trim();
  if (!DECIMAL.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v + 0 : null;
}

function atOf(s: string | null): WorldQuery['at'] {
  if (s === null) return null;
  const parts = s.split(',');
  if (parts.length !== 2) return null;
  const x = integer(parts[0]!);
  const z = integer(parts[1]!);
  if (x === null || z === null) return null;
  return { x: clamp(x, -AT_LIMIT, AT_LIMIT), z: clamp(z, -AT_LIMIT, AT_LIMIT) };
}

export function parseWorldQuery(q: URLSearchParams): WorldQuery {
  const y = decimal(q.get('y'));
  const rd = integer(q.get('rd'));
  const workers = integer(q.get('workers'));
  const renderer = q.get('renderer');
  const time = decimal(q.get('time'));
  const world = q.get('world');
  return {
    at: atOf(q.get('at')),
    y: y === null ? null : clamp(y, Y_MIN, Y_MAX),
    yaw: decimal(q.get('yaw')),
    pitch: decimal(q.get('pitch')),
    rd: rd === null ? null : clamp(rd, RD_MIN, RD_MAX),
    workers: workers === null ? null : clamp(workers, WORKERS_MIN, WORKERS_MAX),
    renderer: renderer === 'batch' || renderer === 'mesh' ? renderer : null,
    shot: q.get('shot') === '1',
    time: time !== null && time >= 0 && time < 24 ? time : null,
    world: world === null || world === '' ? null : world,
  };
}

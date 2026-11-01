/**
 * `ClipboardV1` (SP5c spec §4.1, D24): the selection tool's clipboard as `wi10`'s `meta['clipboard']` holds it. A box of
 * W (x) × H (y) × D (z) cells, sides 1-64, indexed `(y · d + z) · w + x`; `keys` the distinct state keys it uses
 * (`REGISTRY.stateKey`) in first-use order, at most 4,096 (`MAX_STATES`, master §2.2); per cell `states[i]` an index into
 * `keys` and `fluids[i]` the fluid byte. So it reads under any later registry, by key, as saves do (master §2.2; SP5b
 * D22): decode maps each key through `remapOf` (`saves.ts`) to today's id, and a key that no longer parses becomes air
 * (state 0, fluid 0), its cells counted in `unknown` (D15's notice). A field that fails a check makes the whole clipboard
 * unreadable (D15's "could not be read"), never a throw. At most 3 B per cell: 768 KiB at 64³.
 *
 * Pure: no DOM, no storage. The page writes `clipboardOps` through its `KV.write` and reads the one `get` back (§4.2).
 */
import { REGISTRY } from '../world/blocks';
import { MAX_STATES } from '../world/blocks/registry';
import type { WriteOp } from './kv';
import { remapOf } from './saves';

/** The stored clipboard (§4.1). */
export interface ClipboardV1 {
  readonly v: 1;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** The distinct state keys the cells use, in first-use order. */
  readonly keys: string[];
  /** Per cell, an index into `keys`. */
  readonly states: Uint16Array;
  /** Per cell, the fluid byte (`world/blocks/fluid.ts`). */
  readonly fluids: Uint8Array;
}

/** The clipboard's key in `wi10`'s `meta` store (§4.2). */
export const CLIPBOARD_KEY = 'clipboard';
/** At most this many keys: the registry's `MAX_STATES`. */
export const MAX_CLIPBOARD_KEYS = MAX_STATES;
/** A side of the box is an integer 1-64 (§2.1's selection limit). */
const MAX_SIDE = 64;
/** The fluid byte's reserved bit (`world/blocks/fluid.ts`): set, the clipboard is unreadable. */
const FLUID_RESERVED = 0x80;

/**
 * The clipboard of a W × H × D box of voxel values `state << 8 | fluid` (index `(y · d + z) · w + x`): `keys` the distinct
 * state keys in first-use order, `states[i]` an index into them, `fluids[i]` the fluid byte.
 */
export function encodeClipboard(w: number, h: number, d: number, values: Uint32Array): ClipboardV1 {
  const n = w * h * d;
  const states = new Uint16Array(n);
  const fluids = new Uint8Array(n);
  const keys: string[] = [];
  const indexOf = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    const s = v >>> 8;
    let k = indexOf.get(s);
    if (k === undefined) {
      k = keys.length;
      indexOf.set(s, k);
      keys.push(REGISTRY.stateKey(s));
    }
    states[i] = k;
    fluids[i] = v & 0xFF;
  }
  return { v: 1, w, h, d, keys, states, fluids };
}

/** A decoded clipboard: its values under today's ids and the count of cells whose key no longer parses, or unreadable. */
export type DecodedClipboard =
  | { readonly ok: true; readonly w: number; readonly h: number; readonly d: number; readonly values: Uint32Array; readonly unknown: number }
  | { readonly ok: false };

const UNREADABLE: DecodedClipboard = { ok: false };

const isSide = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= MAX_SIDE;

/**
 * Reads a stored clipboard (§4.1): each key through `remapOf` to today's id, an unknown key's cells air (state 0,
 * fluid 0) and counted in `unknown`. `{ ok: false }`, never a throw, when `raw` is not an object, `v` is not 1, a side is
 * not an integer in 1-64, `keys` is not an array of at most 4,096 strings, `states` is not a `Uint16Array` or `fluids`
 * not a `Uint8Array` of length w · h · d, an index is ≥ `keys.length` or a fluid byte has bit 7 set.
 */
export function decodeClipboard(raw: unknown): DecodedClipboard {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return UNREADABLE;
  const r = raw as Record<string, unknown>;
  const { v, w, h, d, keys, states, fluids } = r;
  if (v !== 1 || !isSide(w) || !isSide(h) || !isSide(d)) return UNREADABLE;
  if (!Array.isArray(keys) || keys.length > MAX_CLIPBOARD_KEYS) return UNREADABLE;
  for (const k of keys as unknown[]) if (typeof k !== 'string') return UNREADABLE;
  const n = w * h * d;
  if (!(states instanceof Uint16Array) || states.length !== n) return UNREADABLE;
  if (!(fluids instanceof Uint8Array) || fluids.length !== n) return UNREADABLE;
  const keyCount = keys.length;
  for (let i = 0; i < n; i++) {
    if (states[i]! >= keyCount || (fluids[i]! & FLUID_RESERVED) !== 0) return UNREADABLE;
  }
  const { to } = remapOf(keys as string[]);
  const values = new Uint32Array(n);
  let unknown = 0;
  for (let i = 0; i < n; i++) {
    const s = to[states[i]!]!;
    if (s < 0) {
      unknown++;
      continue; // air, fluid 0: the array's zero
    }
    values[i] = ((s << 8) | fluids[i]!) >>> 0;
  }
  return { ok: true, w, h, d, values, unknown };
}

/** The clipboard's write: one `put` of `meta['clipboard']` (§4.2). */
export function clipboardOps(c: ClipboardV1): WriteOp[] {
  return [{ op: 'put', store: 'meta', key: CLIPBOARD_KEY, value: c }];
}

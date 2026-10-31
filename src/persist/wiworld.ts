/**
 * `.wiworld` (SP5b spec §2.4, D15, D23; master §2.7): a world's last committed save as one file, and back.
 * A gzip `CompressionStream` over `"WI10"`, `u32 version` (`WIWORLD_VERSION`), `u32 headerLen`, the header as UTF-8
 * `canonicalJSON` `{format: 'wi10-world', world: the worlds record without id, state: the state record without worldId,
 * history}`, then one record per edited column by colKey, `i32 cx, i32 cz, u32 len, bytes` (the stored `ColumnDiffV1`,
 * not decoded); little-endian. The header's `world.stateTable` describes the records' ids (D22).
 *
 * Import (`readWiworld`) refuses the whole file, so nothing is written, on a bad magic or `format` ("Not a .wiworld
 * file"), a newer version, or a header, parameters or record framing that cannot be read ("The file is damaged"); a
 * record that does not decode is skipped and counted, as at an open. The state and history go through §2.1's
 * normaliser, the history remapped; each record is remapped to today's ids, keeping its decoded header genKey (D21), so
 * a file under today's table imports its records' bytes unchanged. The world gets today's `stateTable`, a new id and
 * the header's name, trimmed and cut to `MAX_NAME` code points as Rename's (D2; an empty one `newWorldName`'s
 * proposal), and keeps its genKey (an older one follows D8 at its open).
 *
 * E2's hash (`wiworldHash`, D23) reads the content, never the gzip bytes, which `CompressionStream` does not fix byte
 * for byte across engines.
 */
import { colKey, colKeyCx, colKeyCz, columnInWindow } from '../core/coords';
import { createFnv64, hex64, utf8Bytes } from '../core/hash';
import { canonicalJSON } from '../core/params/canonical';
import { isObj } from '../core/params/kit';
import { decodeColumnDiff, encodeColumnDiff } from './diffCodec';
import {
  loadParams, MAX_NAME, newWorldName, normalizeHistory, normalizeState, parseWorldRecord, remapDiff, remapOf, tableRelation,
  todayStateTable, type HistoryRecord, type StateBounds, type WorldDump,
} from './saves';

/** The file format's version; a file with a larger one is refused (D15). */
export const WIWORLD_VERSION = 1;
/** The header's `format`. */
export const WIWORLD_FORMAT = 'wi10-world';

/** Why an import added nothing (D15). */
export type WiworldRefusal = 'Not a .wiworld file' | 'Made by a newer version of world-imaginer-voxel' | 'The file is damaged';

export type WiworldRead =
  | { ok: true; dump: WorldDump; skippedColumns: number; unknownStates: number }
  | { ok: false; reason: WiworldRefusal };

/** "WI10" in ASCII. */
const MAGIC = [0x57, 0x49, 0x31, 0x30] as const;
/** The magic, the version and the header's length. */
const PREAMBLE = 12;
/** A record's `i32 cx, i32 cz, u32 len`. */
const FRAME = 12;
/** A gzip member's first two bytes (RFC 1952). */
const GZIP_ID = [0x1f, 0x8b] as const;

/** The header as written: the record without `id`, the state without `worldId`, the history as stored. */
function headerOf(d: WorldDump): Record<string, unknown> {
  const { id: _id, ...world } = d.world;
  const { worldId: _worldId, ...state } = d.state;
  return { format: WIWORLD_FORMAT, world, state, history: d.history };
}

/** A record's frame: `i32 cx, i32 cz, u32 len`. */
function frameOf(key: number, len: number): Uint8Array {
  const out = new Uint8Array(FRAME);
  const view = new DataView(out.buffer);
  view.setInt32(0, colKeyCx(key), true);
  view.setInt32(4, colKeyCz(key), true);
  view.setUint32(8, len, true);
  return out;
}

/** The columns in colKey order (a copy; `readAll` already reads them so). */
const sortedCols = (d: WorldDump): WorldDump['cols'] => [...d.cols].sort((a, b) => a.key - b.key);

/** The chunks `t` gives for `chunks`, in order; rejects with the stream's error. */
async function transform(chunks: readonly Uint8Array[], t: CompressionStream | DecompressionStream): Promise<Uint8Array[]> {
  const source = new ReadableStream<BufferSource>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk as Uint8Array<ArrayBuffer>);
      c.close();
    },
  });
  const reader = source.pipeThrough(t).getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The world's `.wiworld` (§2.4): the stored records' bytes go into the gzip stream as they are (the world is held once,
 * as `readAll` read it). Throws when the header cannot be written as canonical JSON (a non-finite number or −0).
 */
export async function writeWiworld(d: WorldDump): Promise<Blob> {
  const header = utf8Bytes(canonicalJSON(headerOf(d)));
  const preamble = new Uint8Array(PREAMBLE);
  preamble.set(MAGIC);
  const view = new DataView(preamble.buffer);
  view.setUint32(4, WIWORLD_VERSION, true);
  view.setUint32(8, header.length, true);
  const chunks: Uint8Array[] = [preamble, header];
  for (const c of sortedCols(d)) chunks.push(frameOf(c.key, c.bytes.length), c.bytes);
  const gz = await transform(chunks, new CompressionStream('gzip'));
  return new Blob(gz as BlobPart[], { type: 'application/gzip' });
}

/**
 * One stored record under today's ids (D22), or null when it does not decode against the stored table (`length`
 * states): the stored bytes when the table is today's or a prefix of it (ids map to themselves, and a record that
 * decodes is canonical, so re-encoding it gives the same bytes), else its entries remapped through `to` (an unknown
 * state → air, counted in `unknown`) and re-encoded with its decoded header genKey, the ticks dropped as the sim's
 * rewrite drops them (D21).
 */
function todayRecord(bytes: Uint8Array, length: number, to: Int32Array | null): { bytes: Uint8Array; unknown: number } | null {
  let decoded;
  try {
    decoded = decodeColumnDiff(bytes, length);
  } catch {
    return null;
  }
  if (to === null) return { bytes, unknown: 0 };
  const r = remapDiff(decoded.diff, to);
  return { bytes: encodeColumnDiff(r.diff, decoded.genKey), unknown: r.unknown };
}

/** The remap a stored table needs: null when it is today's or a prefix of it. */
const remapFor = (table: readonly string[]): Int32Array | null => (tableRelation(table) === 'other' ? remapOf(table).to : null);

/**
 * Reads a `.wiworld` (§2.4) into the world it adds, under `newId`, its `state.updated` `now`; any refusal returns its
 * reason and nothing to write. The checks, in order: the gzip stream (not gzip: "Not a .wiworld file"; a stream that
 * does not decompress: damaged), the magic, the version (newer refused), the header (UTF-8 JSON, `format`), the world
 * record (`parseWorldRecord`) and its parameters (`loadParams`), then every record's framing and bounds (a record past
 * the end, a column outside the world window, or columns not in increasing colKey order: damaged). A record that does
 * not decode against the header's table is skipped and counted in `skippedColumns`; `unknownStates` counts the entries
 * that became air. `taken`: every saved world's name, which an empty name's proposal avoids.
 */
export async function readWiworld(
  b: Blob | Uint8Array, bounds: StateBounds, newId: string, now: number, taken: readonly string[] = [],
): Promise<WiworldRead> {
  const gz = b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer());
  if (gz.length < 2 || gz[0] !== GZIP_ID[0] || gz[1] !== GZIP_ID[1]) return { ok: false, reason: 'Not a .wiworld file' };
  let raw: Uint8Array;
  try {
    raw = concat(await transform([gz], new DecompressionStream('gzip')));
  } catch {
    return { ok: false, reason: 'The file is damaged' };
  }
  if (raw.length < MAGIC.length || MAGIC.some((m, i) => raw[i] !== m)) return { ok: false, reason: 'Not a .wiworld file' };
  if (raw.length < PREAMBLE) return { ok: false, reason: 'The file is damaged' };
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(4, true);
  if (version > WIWORLD_VERSION) return { ok: false, reason: 'Made by a newer version of world-imaginer-voxel' };
  if (version < WIWORLD_VERSION) return { ok: false, reason: 'The file is damaged' };
  const headerLen = view.getUint32(8, true);
  if (PREAMBLE + headerLen > raw.length) return { ok: false, reason: 'The file is damaged' };

  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(PREAMBLE, PREAMBLE + headerLen)));
  } catch {
    return { ok: false, reason: 'The file is damaged' };
  }
  if (!isObj(header) || header['format'] !== WIWORLD_FORMAT) return { ok: false, reason: 'Not a .wiworld file' };
  const stored = isObj(header['world']) ? parseWorldRecord({ ...header['world'], id: newId }) : null;
  if (stored === null || !stored.ok || !loadParams(stored.world).ok) return { ok: false, reason: 'The file is damaged' };

  // Every record's framing and bounds first: a file whose records cannot be separated adds nothing (D15).
  const records: { key: number; bytes: Uint8Array }[] = [];
  for (let at = PREAMBLE + headerLen; at < raw.length;) {
    if (at + FRAME > raw.length) return { ok: false, reason: 'The file is damaged' };
    const cx = view.getInt32(at, true);
    const cz = view.getInt32(at + 4, true);
    const len = view.getUint32(at + 8, true);
    at += FRAME;
    if (at + len > raw.length || !columnInWindow(cx, cz)) return { ok: false, reason: 'The file is damaged' };
    const key = colKey(cx, cz);
    if (records.length > 0 && key <= records[records.length - 1]!.key) return { ok: false, reason: 'The file is damaged' };
    records.push({ key, bytes: raw.slice(at, at + len) });
    at += len;
  }

  const table = stored.world.stateTable;
  const to = remapFor(table);
  const cols: WorldDump['cols'] = [];
  let skippedColumns = 0;
  let unknownStates = 0;
  for (const r of records) {
    const today = todayRecord(r.bytes, table.length, to);
    if (today === null) {
      skippedColumns++;
      continue;
    }
    unknownStates += today.unknown;
    cols.push({ key: r.key, bytes: today.bytes });
  }

  const state = { ...normalizeState(header['state'], newId, bounds).state, updated: now };
  const rawHistory = header['history'];
  const history: HistoryRecord | null =
    rawHistory === null || rawHistory === undefined ? null : normalizeHistory(rawHistory, newId, to).history;
  const cut = Array.from(stored.world.name.trim()).slice(0, MAX_NAME).join('');
  const name = cut === '' ? newWorldName(taken) : cut;
  return {
    ok: true,
    dump: { world: { ...stored.world, name, stateTable: todayStateTable() }, state, history, cols },
    skippedColumns,
    unknownStates,
  };
}

/**
 * E2's hash (§2.4, D23): `hex64(fnv1a64(…))` over the header's canonical JSON with `id`, `worldId` and `updated`
 * removed, then every record in colKey order, framed as in the file (`i32 cx, i32 cz, u32 len`), decoded and
 * re-encoded under today's ids with its decoded genKey (a record that does not decode is left out, as an import skips
 * it). An export and its import hash equal, whatever the gzip bytes.
 */
export function wiworldHash(d: WorldDump): string {
  const header = headerOf(d);
  const { worldId: _worldId, updated: _updated, ...state } = d.state;
  header['state'] = state;
  if (d.history !== null) {
    const { worldId: _historyWorldId, ...history } = d.history;
    header['history'] = history;
  }
  const h = createFnv64().update(utf8Bytes(canonicalJSON(header)));
  const table = d.world.stateTable;
  const to = remapFor(table);
  for (const c of sortedCols(d)) {
    const today = todayRecord(c.bytes, table.length, to);
    if (today === null) continue;
    h.update(frameOf(c.key, today.bytes.length)).update(today.bytes);
  }
  return hex64(h.digest());
}

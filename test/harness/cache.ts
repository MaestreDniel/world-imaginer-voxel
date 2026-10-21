/**
 * The region cache (SP3a spec §6.1, SP4a spec §9.2): a dump of a generated region's columns under
 * `test/.cache/regions/<hex64 of the key>.bin`, keyed by `genKey + srcKey + REGION_CACHE_FORMAT + (cx0, cz0, w, h)
 * + upTo`. `srcKey` is the FNV-1a 64 of the sorted paths and bytes of the code the dump depends on, read at test
 * time, so any code change is a miss without a hand-bumped constant; `REGION_CACHE_FORMAT` changes with the dump
 * layout. A dump holds the region's w × h columns at the status their `upTo` reaches (T Proto, D Decorated, L
 * Published; ruling P31), never the rings around it; upTo 'MESH' is never dumped (`genRegion` meshes the cached
 * 'L' region grown by one ring). A hit rebuilds each column through the writer API, so uniform and dense decisions
 * are made again by the same code and the versions are bumped by the same commits as a generated column's:
 * `claimColumn`, `setProto` per section with the expanded data, the aux A and aux B bytes, `commit(1)`; then, at
 * Decorated or above, `reopenColumn(1)`, `shareFinal(sy, zeros)` per section (the D skeleton's share) and `commit(2)`;
 * then, at Published, `reopenColumn(2)`, `setLight` per section and `commit(3)`. A hit refreshes the dump's mtime, so
 * the prune grace below counts from its last use.
 *
 * Dump layout (little-endian): a 44-byte header (magic `WIRC`, format u32, genKey lo/hi u32, srcKey lo/hi u32,
 * cx0, cz0 i32, w, h u32, upTo as 4 ASCII bytes padded with 0), then per column, cz outer and cx inner: record ints
 * 0-15 (i32), the 24 proto descriptors (blocks, fluid: 48 i32), the dense slots they reference in descriptor order
 * (8192 bytes per block slot, 4096 per fluid slot); at Published only, the 24 final light descriptors (24 i32) and
 * the dense light slots they reference (4096 bytes each); then the 4096 aux A bytes (the whole slot: the T fields and
 * D's final heightmaps), then the 4096 aux B bytes (each zeros when the column has no such slot; the record ints say
 * whether it has one); last, the FNV-1a 64 (lo, hi u32) of every byte before it. The final blocks and fluid are not
 * dumped: SP4a's D shares the proto into the final set (SP4a spec §3.1), and a dump of a column whose final entries
 * are not its proto entries throws (a D that places blocks needs a new format). Format 1 had no aux B bytes (SP3a);
 * format 2 adds them (SP3b spec §7); format 3 adds the D and L statuses and the final light (SP4a spec §9.2).
 * Anything that disagrees with the expected header, the layout or the checksum is a miss (a damaged dump is never
 * rebuilt); the caller regenerates and overwrites.
 *
 * Every code change is a new `srcKey`, so the dumps of earlier code can never hit again: writing a dump deletes the
 * `.bin` files of its directory that are not dumps of this format and `srcKey` and were not modified for
 * `REGION_CACHE_PRUNE_MS` (the grace keeps a concurrent run of other code from losing the dump it just wrote).
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { createFnv64, fnv1a64, hex64, type Hash64 } from '../../src/core/hash';
import {
  finalAt, protoAt, REC_AUX_A, REC_AUX_B, REC_BLOCK_VERSION, REC_CLAIMED, REC_CX, REC_CZ, REC_LIGHT_VERSION, REC_STATUS,
  STATUS_DECORATED, STATUS_PROTO, STATUS_PUBLISHED,
} from '../../src/world/store/columnTable';
import { FINAL_BLOCKS, FINAL_FLUID, FINAL_LIGHT } from '../../src/world/store/section';
import type { VoxelStore } from '../../src/world/store/store';

/** Bumped whenever the dump layout changes. */
export const REGION_CACHE_FORMAT = 3;
/** A dump that cannot hit for the current code is deleted once it has not been modified for this long (15 min). */
export const REGION_CACHE_PRUNE_MS = 15 * 60 * 1000;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REGION_CACHE_DIR = fileURLToPath(new URL('../.cache/regions/', import.meta.url));

/** What `srcKey` hashes, relative to the repository root: directories end with '/'. */
export const SRC_KEY_SCOPE: readonly string[] = Object.freeze([
  'src/core/', 'src/world/', 'src/gen/', 'src/light/', 'src/mesh/', 'src/metrics/region.ts', 'src/workers/worldJobs.ts', 'test/harness/cache.ts',
]);

/** The last stage `genRegion` runs (SP4a spec §9.2): T, the D skeleton, the light, or the column meshes. */
export type RegionUpTo = 'T' | 'D' | 'L' | 'MESH';

/** The status a dump's columns hold for each `upTo` that is dumped ('MESH' never is). */
const DUMP_STATUS: Readonly<Record<string, number>> = Object.freeze({ T: STATUS_PROTO, D: STATUS_DECORATED, L: STATUS_PUBLISHED });
const STATUS_NAMES = ['Absent', 'Proto', 'Decorated', 'Published'] as const;

/** The status of the columns of a dump of `upTo`; throws for 'MESH', which is never dumped. */
function dumpStatus(upTo: RegionUpTo): number {
  const s = DUMP_STATUS[upTo];
  if (s === undefined) throw new Error(`region cache: upTo '${upTo}' is never dumped (MESH meshes the cached 'L' region)`);
  return s;
}

export interface RegionCacheHeader {
  readonly genKey: Hash64;
  readonly srcKey: Hash64;
  readonly cx0: number;
  readonly cz0: number;
  readonly w: number;
  readonly h: number;
  readonly upTo: RegionUpTo;
}

const MAGIC = 'WIRC';
const HEADER_BYTES = 44;
const RECORD_HEAD = 16;
const DESCRIPTORS = 48;
const COLUMN_HEAD_BYTES = 4 * (RECORD_HEAD + DESCRIPTORS);
/** The 24 final light descriptors of a Published column. */
const LIGHT_DESCRIPTORS = 24;
const LIGHT_HEAD_BYTES = 4 * LIGHT_DESCRIPTORS;
const BLOCK_SLOT = 8192;
const FLUID_SLOT = 4096;
const AUX_BYTES = 4096;
const LIGHT_SLOT = 4096;
/** The trailing FNV-1a 64 of the dump. */
const CHECKSUM_BYTES = 8;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * FNV-1a 64 over the files of `scope` under `root` (directories recursively), sorted by their '/'-separated path
 * relative to `root`: per file its path (UTF-8), a 0 byte, its length (u32 LE) and its bytes. Missing entries are
 * skipped.
 */
export function srcKeyOf(root: string, scope: readonly string[] = SRC_KEY_SCOPE): Hash64 {
  const files: string[] = [];
  for (const entry of scope) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    if (!entry.endsWith('/')) {
      files.push(entry);
      continue;
    }
    for (const rel of readdirSync(abs, { recursive: true, encoding: 'utf8' })) {
      if (statSync(join(abs, rel)).isFile()) files.push(entry + rel.split(sep).join('/'));
    }
  }
  files.sort();
  const fnv = createFnv64();
  for (const path of files) {
    const bytes = readFileSync(join(root, path));
    fnv.update(Buffer.from(path, 'utf8')).updateU8(0).updateU32LE(bytes.length).update(bytes);
  }
  return fnv.digest();
}

let repoSrcKey: Hash64 | null = null;

/** `srcKeyOf` the repository, computed once per process. */
export function srcKey(): Hash64 {
  repoSrcKey ??= srcKeyOf(ROOT);
  return repoSrcKey;
}

export function regionCacheKey(h: RegionCacheHeader): Hash64 {
  return fnv1a64(`${hex64(h.genKey)}|${hex64(h.srcKey)}|${REGION_CACHE_FORMAT}|${h.cx0}|${h.cz0}|${h.w}|${h.h}|${h.upTo}`);
}

export function regionCachePath(h: RegionCacheHeader, dir: string = REGION_CACHE_DIR): string {
  return join(dir, `${hex64(regionCacheKey(h))}.bin`);
}

function checkHost(): void {
  if (!LITTLE_ENDIAN) throw new Error('region cache: block slots are dumped as native u16, which needs a little-endian host');
}

function writeHeader(b: Buffer, h: RegionCacheHeader): void {
  b.write(MAGIC, 0, 'latin1');
  b.writeUInt32LE(REGION_CACHE_FORMAT, 4);
  b.writeUInt32LE(h.genKey[0], 8);
  b.writeUInt32LE(h.genKey[1], 12);
  b.writeUInt32LE(h.srcKey[0], 16);
  b.writeUInt32LE(h.srcKey[1], 20);
  b.writeInt32LE(h.cx0, 24);
  b.writeInt32LE(h.cz0, 28);
  b.writeUInt32LE(h.w, 32);
  b.writeUInt32LE(h.h, 36);
  b.write(h.upTo.padEnd(4, '\0'), 40, 'latin1');
}

/**
 * The record base of (cx, cz), which must hold it at `status` (what the dump's `upTo` leaves: Proto, Decorated or
 * Published) with, at Decorated or above, its final blocks and fluid shared with its proto entries.
 */
function columnBase(store: VoxelStore, cx: number, cz: number, status: number): number {
  const base = store.table.find(cx, cz);
  if (base < 0 || store.table.status(base) !== status) {
    throw new Error(`region cache: column (${cx}, ${cz}) is not at status ${STATUS_NAMES[status] ?? status}`);
  }
  if (status >= STATUS_DECORATED) {
    const ints = store.table.ints;
    for (let sy = 0; sy < 24; sy++) {
      const p = protoAt(base, sy);
      const f = finalAt(base, sy);
      if (ints[f + FINAL_BLOCKS] !== ints[p] || ints[f + FINAL_FLUID] !== ints[p + 1]) {
        throw new Error(`region cache: column (${cx}, ${cz}) section ${sy}: the final blocks or fluid are not the proto's (format ${REGION_CACHE_FORMAT} dumps a shared final set only)`);
      }
    }
  }
  return base;
}

/** The dump of the region `h` describes, read from `store`; its columns must be at `h.upTo`'s status. */
export function encodeRegionDump(store: VoxelStore, h: RegionCacheHeader): Uint8Array {
  checkHost();
  const status = dumpStatus(h.upTo);
  const lit = status === STATUS_PUBLISHED;
  const ints = store.table.ints;
  let size = HEADER_BYTES + CHECKSUM_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      const base = columnBase(store, cx, cz, status);
      size += COLUMN_HEAD_BYTES + 2 * AUX_BYTES + (lit ? LIGHT_HEAD_BYTES : 0);
      for (let sy = 0; sy < 24; sy++) {
        const p = protoAt(base, sy);
        if (ints[p]! >= 0) size += BLOCK_SLOT;
        if (ints[p + 1]! >= 0) size += FLUID_SLOT;
        if (lit && ints[finalAt(base, sy) + FINAL_LIGHT]! >= 0) size += LIGHT_SLOT;
      }
    }
  }
  const b = Buffer.alloc(size);
  writeHeader(b, h);
  let o = HEADER_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      const base = columnBase(store, cx, cz, status);
      for (let i = 0; i < RECORD_HEAD; i++, o += 4) b.writeInt32LE(Atomics.load(ints, base + i), o);
      const d0 = protoAt(base, 0);
      for (let i = 0; i < DESCRIPTORS; i++, o += 4) b.writeInt32LE(ints[d0 + i]!, o);
      for (let sy = 0; sy < 24; sy++) {
        const p = protoAt(base, sy);
        if (ints[p]! >= 0) {
          const v = store.blockPool.u16(ints[p]!);
          b.set(new Uint8Array(v.buffer, v.byteOffset, BLOCK_SLOT), o);
          o += BLOCK_SLOT;
        }
        if (ints[p + 1]! >= 0) {
          b.set(store.bytePool.u8(ints[p + 1]!), o);
          o += FLUID_SLOT;
        }
      }
      if (lit) {
        for (let sy = 0; sy < 24; sy++, o += 4) b.writeInt32LE(ints[finalAt(base, sy) + FINAL_LIGHT]!, o);
        for (let sy = 0; sy < 24; sy++) {
          const l = ints[finalAt(base, sy) + FINAL_LIGHT]!;
          if (l < 0) continue;
          b.set(store.bytePool.u8(l), o);
          o += LIGHT_SLOT;
        }
      }
      if (ints[base + REC_AUX_A]! >= 0) {
        const a = store.proto(cx, cz)!.aux()!.worldSurfaceWG;
        b.set(new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES), o);
      }
      o += AUX_BYTES;
      if (ints[base + REC_AUX_B]! >= 0) {
        // The aux B fields tile the slot from caveBiomeQ (offset 0) on.
        const a = store.proto(cx, cz)!.auxB()!.caveBiomeQ;
        b.set(new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES), o);
      }
      o += AUX_BYTES;
    }
  }
  const sum = checksum(b.subarray(0, o));
  b.writeUInt32LE(sum[0], o);
  b.writeUInt32LE(sum[1], o + 4);
  o += CHECKSUM_BYTES;
  if (o !== size) throw new Error(`region cache: wrote ${o} of ${size} bytes`);
  return b;
}

const checksum = (bytes: Uint8Array): Hash64 => createFnv64().update(bytes).digest();

interface DumpColumn {
  readonly cx: number;
  readonly cz: number;
  readonly record: Int32Array;
  readonly descriptors: Int32Array;
  /** Per section: the dense slot's bytes, or null for a uniform entry. */
  readonly blocks: Array<Uint8Array | null>;
  readonly fluid: Array<Uint8Array | null>;
  /** At Published: the 24 final light descriptors, and per section the dense light slot's bytes or null; else null. */
  readonly lightDescriptors: Int32Array | null;
  readonly light: Array<Uint8Array | null> | null;
  readonly aux: Uint8Array;
  readonly auxB: Uint8Array;
}

/** The columns of a dump whose header and layout agree with `h`, or null (a miss). Reads nothing into a store. */
export function parseRegionDump(bytes: Uint8Array, h: RegionCacheHeader): DumpColumn[] | null {
  const all = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (all.length < HEADER_BYTES + CHECKSUM_BYTES) return null;
  const want = Buffer.alloc(HEADER_BYTES);
  writeHeader(want, h);
  if (!all.subarray(0, HEADER_BYTES).equals(want)) return null;
  // The payload must be the bytes the writer summed: a damaged slot or aux byte of the right length is a miss too.
  const b = all.subarray(0, all.length - CHECKSUM_BYTES);
  const sum = checksum(b);
  if (all.readUInt32LE(b.length) !== sum[0] || all.readUInt32LE(b.length + 4) !== sum[1]) return null;
  const status = DUMP_STATUS[h.upTo];
  if (status === undefined) return null;
  const lit = status === STATUS_PUBLISHED;
  const out: DumpColumn[] = [];
  let o = HEADER_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      if (o + COLUMN_HEAD_BYTES > b.length) return null;
      const record = new Int32Array(RECORD_HEAD);
      for (let i = 0; i < RECORD_HEAD; i++, o += 4) record[i] = b.readInt32LE(o);
      const descriptors = new Int32Array(DESCRIPTORS);
      for (let i = 0; i < DESCRIPTORS; i++, o += 4) descriptors[i] = b.readInt32LE(o);
      if (record[REC_CX] !== cx || record[REC_CZ] !== cz || record[REC_STATUS] !== status || record[REC_CLAIMED] !== 1) return null;
      const blocks: Array<Uint8Array | null> = [];
      const fluid: Array<Uint8Array | null> = [];
      for (let sy = 0; sy < 24; sy++) {
        const bc = descriptors[2 * sy]!;
        const fc = descriptors[2 * sy + 1]!;
        if (bc < -0x10000 || fc < -0x100) return null;
        if (bc >= 0) {
          if (o + BLOCK_SLOT > b.length) return null;
          blocks.push(b.subarray(o, o + BLOCK_SLOT));
          o += BLOCK_SLOT;
        } else blocks.push(null);
        if (fc >= 0) {
          if (o + FLUID_SLOT > b.length) return null;
          fluid.push(b.subarray(o, o + FLUID_SLOT));
          o += FLUID_SLOT;
        } else fluid.push(null);
      }
      let lightDescriptors: Int32Array | null = null;
      let light: Array<Uint8Array | null> | null = null;
      if (lit) {
        if (o + LIGHT_HEAD_BYTES > b.length) return null;
        lightDescriptors = new Int32Array(LIGHT_DESCRIPTORS);
        for (let i = 0; i < LIGHT_DESCRIPTORS; i++, o += 4) lightDescriptors[i] = b.readInt32LE(o);
        light = [];
        for (let sy = 0; sy < 24; sy++) {
          const lc = lightDescriptors[sy]!;
          if (lc < -0x100) return null;
          if (lc >= 0) {
            if (o + LIGHT_SLOT > b.length) return null;
            light.push(b.subarray(o, o + LIGHT_SLOT));
            o += LIGHT_SLOT;
          } else light.push(null);
        }
      }
      if (o + 2 * AUX_BYTES > b.length) return null;
      out.push({
        cx, cz, record, descriptors, blocks, fluid, lightDescriptors, light,
        aux: b.subarray(o, o + AUX_BYTES), auxB: b.subarray(o + AUX_BYTES, o + 2 * AUX_BYTES),
      });
      o += 2 * AUX_BYTES;
    }
  }
  return o === b.length ? out : null;
}

/** The D skeleton's all-zero final light, which a rebuilt share stores as a uniform entry. */
const ZERO_LIGHT = new Uint8Array(4096);

/**
 * Rebuilds the parsed columns into `store` through the writer API (epoch from the dump; `commit(1)`, then the D share
 * and `commit(2)` at Decorated or above, then `setLight` and `commit(3)` at Published); returns the milliseconds per
 * column, in dump order (row-major). Throws when the store decides another uniform/dense layout, or ends at other
 * versions, than the dump records (a store change the format did not track).
 */
export function rebuildRegion(store: VoxelStore, cols: readonly DumpColumn[]): Float64Array {
  checkHost();
  const ms = new Float64Array(cols.length);
  const blocks = new Uint16Array(4096);
  const blockBytes = new Uint8Array(blocks.buffer);
  const fluid = new Uint8Array(4096);
  const light = new Uint8Array(4096);
  const ints = store.table.ints;
  cols.forEach((c, k) => {
    const t0 = performance.now();
    const w = store.claimColumn(c.cx, c.cz, c.record[3]!);
    for (let sy = 0; sy < 24; sy++) {
      const bs = c.blocks[sy]!;
      const fs = c.fluid[sy]!;
      if (bs === null) blocks.fill(-1 - c.descriptors[2 * sy]!);
      else blockBytes.set(bs);
      if (fs === null) fluid.fill(-1 - c.descriptors[2 * sy + 1]!);
      else fluid.set(fs);
      w.setProto(sy, blocks, fluid);
    }
    if (c.record[REC_AUX_A]! >= 0) {
      const a = w.aux().worldSurfaceWG;
      new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES).set(c.aux);
    }
    if (c.record[REC_AUX_B]! >= 0) {
      const a = w.auxB().caveBiomeQ;
      new Uint8Array(a.buffer, a.byteOffset, AUX_BYTES).set(c.auxB);
    }
    w.commit(1);
    const status = c.record[REC_STATUS]!;
    if (status >= STATUS_DECORATED) {
      const d = store.reopenColumn(c.cx, c.cz, 1);
      for (let sy = 0; sy < 24; sy++) d.shareFinal(sy, ZERO_LIGHT);
      d.commit(2);
    }
    if (status === STATUS_PUBLISHED) {
      const l = store.reopenColumn(c.cx, c.cz, 2);
      for (let sy = 0; sy < 24; sy++) {
        const ls = c.light![sy]!;
        if (ls === null) light.fill(-1 - c.lightDescriptors![sy]!);
        else light.set(ls);
        l.setLight(sy, light);
      }
      l.commit(3);
    }
    ms[k] = performance.now() - t0;
    const base = store.table.find(c.cx, c.cz);
    const d0 = protoAt(base, 0);
    const mismatch = (what: string, was: number, now: number): void => {
      if ((was >= 0) !== (now >= 0) || (was < 0 && was !== now)) {
        throw new Error(`region cache: column (${c.cx}, ${c.cz}) rebuilt ${what} as ${now}, the dump has ${was}`);
      }
    };
    for (let i = 0; i < DESCRIPTORS; i++) mismatch(`descriptor ${i}`, c.descriptors[i]!, ints[d0 + i]!);
    if (c.lightDescriptors !== null) {
      for (let sy = 0; sy < 24; sy++) mismatch(`light descriptor ${sy}`, c.lightDescriptors[sy]!, ints[finalAt(base, sy) + FINAL_LIGHT]!);
    }
    for (const at of [REC_BLOCK_VERSION, REC_LIGHT_VERSION]) {
      if (ints[base + at] !== c.record[at]) {
        throw new Error(`region cache: column (${c.cx}, ${c.cz}) rebuilt record int ${at} as ${ints[base + at]}, the dump has ${c.record[at]}`);
      }
    }
  });
  return ms;
}

/**
 * On a hit, rebuilds the dump at `path` into `store`, sets the file's mtime to now (so `pruneRegionDumps`' grace
 * counts from the last use) and returns the milliseconds per column (row-major); null on a miss (no file or one that
 * cannot be read, another header, a malformed layout, a wrong checksum), in which case `store` is untouched.
 */
export function readRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): Float64Array | null {
  if (!existsSync(path)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null; // deleted or replaced under us: a miss
  }
  const cols = parseRegionDump(bytes, h);
  if (cols === null) return null;
  const ms = rebuildRegion(store, cols);
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // deleted or replaced under us: the next run regenerates it
  }
  return ms;
}

/** The first HEADER_BYTES of a file, or null when it is shorter or cannot be read. */
function readHead(path: string): Buffer | null {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(HEADER_BYTES);
    return readSync(fd, head, 0, HEADER_BYTES, 0) === HEADER_BYTES ? head : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/**
 * Deletes the `.bin` files of `dir` that can never hit for code whose srcKey is `src` (not a dump of this format, or a
 * dump of another srcKey: an earlier version of the code) and that were last modified at least `REGION_CACHE_PRUNE_MS`
 * before `now`. Dumps of `src` (other regions, seeds or params) and every other file are kept. Returns the deleted
 * names, sorted.
 */
export function pruneRegionDumps(dir: string, src: Hash64, now: number = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.bin')) continue;
    const path = join(dir, name);
    const head = readHead(path);
    const live = head !== null && head.toString('latin1', 0, 4) === MAGIC && head.readUInt32LE(4) === REGION_CACHE_FORMAT
      && head.readUInt32LE(16) === src[0] && head.readUInt32LE(20) === src[1];
    if (live) continue;
    try {
      if (now - statSync(path).mtimeMs < REGION_CACHE_PRUNE_MS) continue;
      unlinkSync(path);
      out.push(name);
    } catch {
      // already gone (another process pruned it)
    }
  }
  return out.sort();
}

/**
 * Writes the dump of the region `h` describes to `path`, atomically (a temporary file, then a rename), then prunes the
 * dumps of its directory that can never hit again (`pruneRegionDumps`).
 */
export function writeRegionDump(store: VoxelStore, h: RegionCacheHeader, path: string): void {
  dumpStatus(h.upTo);
  const bytes = encodeRegionDump(store, h);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${threadId}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  pruneRegionDumps(dirname(path), h.srcKey);
}

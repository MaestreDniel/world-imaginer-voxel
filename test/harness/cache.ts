/**
 * The region cache (SP3a spec §6.1): a dump of a generated region's proto columns under
 * `test/.cache/regions/<hex64 of the key>.bin`, keyed by `genKey + srcKey + REGION_CACHE_FORMAT + (cx0, cz0, w, h)
 * + upTo`. `srcKey` is the FNV-1a 64 of the sorted paths and bytes of the code the dump depends on, read at test
 * time, so any code change is a miss without a hand-bumped constant; `REGION_CACHE_FORMAT` changes with the dump
 * layout. A hit rebuilds each column through the writer API (`claimColumn`, `setProto` per section with the
 * expanded data, the aux bytes, `commit(1)`), so uniform and dense decisions are made again by the same code.
 *
 * Dump layout (little-endian): a 44-byte header (magic `WIRC`, format u32, genKey lo/hi u32, srcKey lo/hi u32,
 * cx0, cz0 i32, w, h u32, upTo as 4 ASCII bytes padded with 0), then per column, cz outer and cx inner: record ints
 * 0-15 (i32), the 24 proto descriptors (blocks, fluid: 48 i32), the dense slots they reference in descriptor order
 * (8192 bytes per block slot, 4096 per fluid slot), and the 4096 aux A bytes (zeros when the column has none); last,
 * the FNV-1a 64 (lo, hi u32) of every byte before it. Anything that disagrees with the expected header, the layout or
 * the checksum is a miss (a damaged dump is never rebuilt); the caller regenerates and overwrites.
 *
 * Every code change is a new `srcKey`, so the dumps of earlier code can never hit again: writing a dump deletes the
 * `.bin` files of its directory that are not dumps of this format and `srcKey` and were not modified for
 * `REGION_CACHE_PRUNE_MS` (the grace keeps a concurrent run of other code from losing the dump it just wrote).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { createFnv64, fnv1a64, hex64, type Hash64 } from '../../src/core/hash';
import { protoAt, REC_AUX_A, REC_CLAIMED, REC_CX, REC_CZ, REC_STATUS, STATUS_PROTO } from '../../src/world/store/columnTable';
import type { VoxelStore } from '../../src/world/store/store';

/** Bumped whenever the dump layout changes. */
export const REGION_CACHE_FORMAT = 1;
/** A dump that cannot hit for the current code is deleted once it has not been modified for this long (15 min). */
export const REGION_CACHE_PRUNE_MS = 15 * 60 * 1000;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REGION_CACHE_DIR = fileURLToPath(new URL('../.cache/regions/', import.meta.url));

/** What `srcKey` hashes, relative to the repository root: directories end with '/'. */
export const SRC_KEY_SCOPE: readonly string[] = Object.freeze(['src/core/', 'src/world/', 'src/gen/', 'src/metrics/region.ts', 'test/harness/cache.ts']);

export type RegionUpTo = 'T';

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
const BLOCK_SLOT = 8192;
const FLUID_SLOT = 4096;
const AUX_BYTES = 4096;
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

/** The record base of (cx, cz), which must hold it at status Proto (what `upTo: 'T'` leaves). */
function protoBase(store: VoxelStore, cx: number, cz: number): number {
  const base = store.table.find(cx, cz);
  if (base < 0 || store.table.status(base) !== STATUS_PROTO) throw new Error(`region cache: column (${cx}, ${cz}) is not at status Proto`);
  return base;
}

/** The dump of the region `h` describes, read from `store`. */
export function encodeRegionDump(store: VoxelStore, h: RegionCacheHeader): Uint8Array {
  checkHost();
  const ints = store.table.ints;
  let size = HEADER_BYTES + CHECKSUM_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      const base = protoBase(store, cx, cz);
      size += COLUMN_HEAD_BYTES + AUX_BYTES;
      for (let sy = 0; sy < 24; sy++) {
        const p = protoAt(base, sy);
        if (ints[p]! >= 0) size += BLOCK_SLOT;
        if (ints[p + 1]! >= 0) size += FLUID_SLOT;
      }
    }
  }
  const b = Buffer.alloc(size);
  writeHeader(b, h);
  let o = HEADER_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      const base = protoBase(store, cx, cz);
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
      if (ints[base + REC_AUX_A]! >= 0) {
        const a = store.proto(cx, cz)!.aux()!.worldSurfaceWG;
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
  readonly aux: Uint8Array;
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
  const out: DumpColumn[] = [];
  let o = HEADER_BYTES;
  for (let cz = h.cz0; cz < h.cz0 + h.h; cz++) {
    for (let cx = h.cx0; cx < h.cx0 + h.w; cx++) {
      if (o + COLUMN_HEAD_BYTES > b.length) return null;
      const record = new Int32Array(RECORD_HEAD);
      for (let i = 0; i < RECORD_HEAD; i++, o += 4) record[i] = b.readInt32LE(o);
      const descriptors = new Int32Array(DESCRIPTORS);
      for (let i = 0; i < DESCRIPTORS; i++, o += 4) descriptors[i] = b.readInt32LE(o);
      if (record[REC_CX] !== cx || record[REC_CZ] !== cz || record[REC_STATUS] !== STATUS_PROTO || record[REC_CLAIMED] !== 1) return null;
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
      if (o + AUX_BYTES > b.length) return null;
      out.push({ cx, cz, record, descriptors, blocks, fluid, aux: b.subarray(o, o + AUX_BYTES) });
      o += AUX_BYTES;
    }
  }
  return o === b.length ? out : null;
}

/**
 * Rebuilds the parsed columns into `store` through the writer API (epoch from the dump, `commit(1)`); returns the
 * milliseconds per column, in dump order (row-major). Throws when the store decides another uniform/dense layout
 * than the dump records (a store change the format did not track).
 */
export function rebuildRegion(store: VoxelStore, cols: readonly DumpColumn[]): Float64Array {
  checkHost();
  const ms = new Float64Array(cols.length);
  const blocks = new Uint16Array(4096);
  const blockBytes = new Uint8Array(blocks.buffer);
  const fluid = new Uint8Array(4096);
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
    w.commit(1);
    ms[k] = performance.now() - t0;
    const d0 = protoAt(store.table.find(c.cx, c.cz), 0);
    for (let i = 0; i < DESCRIPTORS; i++) {
      const was = c.descriptors[i]!;
      const now = ints[d0 + i]!;
      if ((was >= 0) !== (now >= 0) || (was < 0 && was !== now)) {
        throw new Error(`region cache: column (${c.cx}, ${c.cz}) rebuilt descriptor ${i} as ${now}, the dump has ${was}`);
      }
    }
  });
  return ms;
}

/**
 * On a hit, rebuilds the dump at `path` into `store` and returns the milliseconds per column (row-major); null on a
 * miss (no file or one that cannot be read, another header, a malformed layout, a wrong checksum), in which case
 * `store` is untouched.
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
  return cols === null ? null : rebuildRegion(store, cols);
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
  const bytes = encodeRegionDump(store, h);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${threadId}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  pruneRegionDumps(dirname(path), h.srcKey);
}

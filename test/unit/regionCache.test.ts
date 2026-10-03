import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { fnv1a64, fnv1a64Bytes, hex64, type Hash64 } from '../../src/core/hash';
import { seedFromInput } from '../../src/core/seed';
import { genKey, stageHashes } from '../../src/core/stage/hash';
import {
  REGION_CACHE_DIR, REGION_CACHE_FORMAT, REGION_CACHE_PRUNE_MS, regionCacheKey, regionCachePath, SRC_KEY_SCOPE, srcKey, srcKeyOf,
  type RegionCacheHeader,
} from '../harness/cache';
import { paramsWith } from '../harness/gen';
import { genRegion, type GenRegionOptions } from '../harness/region';

const DIR = fileURLToPath(new URL('../.cache/regionCacheUnit/', import.meta.url));
const SCRATCH = fileURLToPath(new URL('../.cache/regionCacheUnitSrc/', import.meta.url));

/** Byte offset and size of the first dense slot (a block slot at an even descriptor, else fluid) of the dump's first column. */
function firstDenseSlot(b: Buffer): [number, number] {
  const d0 = 44 + 4 * 16;
  for (let i = 0; i < 48; i++) if (b.readInt32LE(d0 + 4 * i) >= 0) return [d0 + 4 * 48, i % 2 === 0 ? 8192 : 4096];
  throw new Error('the first column has no dense slot');
}

const header = (over: Partial<RegionCacheHeader> = {}): RegionCacheHeader => ({
  genKey: [1, 2], srcKey: [3, 4], cx0: -2, cz0: 5, w: 3, h: 2, upTo: 'T', ...over,
});

describe('the cache key (§6.1)', () => {
  test('REGION_CACHE_FORMAT starts at 1; the dumps live in test/.cache/regions/<hex64 of the key>.bin', () => {
    expect(REGION_CACHE_FORMAT).toBe(1);
    expect(REGION_CACHE_DIR).toBe(fileURLToPath(new URL('../.cache/regions/', import.meta.url)));
    const h = header();
    expect(regionCachePath(h)).toBe(join(REGION_CACHE_DIR, `${hex64(regionCacheKey(h))}.bin`));
    expect(regionCachePath(h, '/x/y')).toBe(join('/x/y', `${hex64(regionCacheKey(h))}.bin`));
  });

  test('the key is genKey + srcKey + format + region + upTo', () => {
    const h = header();
    expect(regionCacheKey(h)).toEqual(fnv1a64(`${hex64([1, 2])}|${hex64([3, 4])}|${REGION_CACHE_FORMAT}|-2|5|3|2|T`));
    const others: Array<Partial<RegionCacheHeader>> = [
      { genKey: [1, 3] }, { srcKey: [4, 4] }, { cx0: -1 }, { cz0: 6 }, { w: 2 }, { h: 3 },
    ];
    const all = new Set([hex64(regionCacheKey(h)), ...others.map((o) => hex64(regionCacheKey(header(o))))]);
    expect(all.size).toBe(others.length + 1);
  });
});

describe('srcKey (§6.1)', () => {
  test('the scope is src/core, src/world, src/gen, src/metrics/region.ts and test/harness/cache.ts', () => {
    expect([...SRC_KEY_SCOPE]).toEqual(['src/core/', 'src/world/', 'src/gen/', 'src/metrics/region.ts', 'test/harness/cache.ts']);
  });

  test('FNV-1a 64 of the sorted paths and bytes: any change in scope is a new key, outside scope none', () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    const put = (rel: string, text: string) => {
      mkdirSync(join(SCRATCH, rel, '..'), { recursive: true });
      writeFileSync(join(SCRATCH, rel), text);
    };
    put('src/core/a.ts', 'export const A = 1;\n');
    put('src/core/deep/b.ts', 'export const B = 2;\n');
    put('src/world/w.ts', 'w');
    put('src/gen/g.ts', 'g');
    put('src/metrics/region.ts', 'r');
    put('src/metrics/other.ts', 'o');
    put('src/ui/u.ts', 'u');
    put('test/harness/cache.ts', 'c');
    const k0 = hex64(srcKeyOf(SCRATCH));
    expect(hex64(srcKeyOf(SCRATCH))).toBe(k0);
    const changes: Array<[string, () => void, () => void, boolean]> = [
      ['a byte in src/core', () => put('src/core/deep/b.ts', 'export const B = 3;\n'), () => put('src/core/deep/b.ts', 'export const B = 2;\n'), true],
      ['a new file in src/gen', () => put('src/gen/h.ts', ''), () => rmSync(join(SCRATCH, 'src/gen/h.ts')), true],
      ['a renamed file', () => renameSync(join(SCRATCH, 'src/world/w.ts'), join(SCRATCH, 'src/world/v.ts')), () => renameSync(join(SCRATCH, 'src/world/v.ts'), join(SCRATCH, 'src/world/w.ts')), true],
      ['metrics/region.ts', () => put('src/metrics/region.ts', 'r2'), () => put('src/metrics/region.ts', 'r'), true],
      ['test/harness/cache.ts', () => put('test/harness/cache.ts', 'c2'), () => put('test/harness/cache.ts', 'c'), true],
      ['bytes moved across a file boundary', () => { put('src/core/a.ts', 'export const A = 1;\nx'); put('src/core/deep/b.ts', 'export const B = 2;'); },
        () => { put('src/core/a.ts', 'export const A = 1;\n'); put('src/core/deep/b.ts', 'export const B = 2;\n'); }, true],
      ['another metrics file', () => put('src/metrics/other.ts', 'o2'), () => put('src/metrics/other.ts', 'o'), false],
      ['src/ui', () => put('src/ui/u.ts', 'u2'), () => put('src/ui/u.ts', 'u'), false],
    ];
    for (const [what, change, undo, differs] of changes) {
      change();
      expect(hex64(srcKeyOf(SCRATCH)) !== k0, what).toBe(differs);
      undo();
      expect(hex64(srcKeyOf(SCRATCH)), `${what} undone`).toBe(k0);
    }
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  test('srcKey() is the repository key', () => {
    expect(srcKey()).toEqual(srcKeyOf(fileURLToPath(new URL('../../', import.meta.url))));
  });
});

describe('genRegion with the cache (§6.1)', () => {
  const params = paramsWith();
  const base: GenRegionOptions = {
    seed: '42', params, cx0: 3, cz0: -1, w: 2, h: 2, upTo: 'T', order: 'spiral', threads: 1, cache: true, cacheDir: DIR,
  };
  const keyOf = (o: GenRegionOptions, src: Hash64 = srcKey()): RegionCacheHeader => ({
    genKey: genKey(seedFromInput(o.seed), stageHashes(o.params)), srcKey: src, cx0: o.cx0, cz0: o.cz0, w: o.w, h: o.h, upTo: 'T',
  });
  const files = () => (existsSync(DIR) ? readdirSync(DIR).sort() : []);

  beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  test('cache: false (the default) never reads or writes a dump', async () => {
    const r = await genRegion({ ...base, cache: false });
    expect(r.cacheHit).toBe(false);
    const { cache: _c, ...noCache } = base;
    expect((await genRegion(noCache)).cacheHit).toBe(false);
    expect(files()).toEqual([]);
  });

  test('a miss generates and writes the dump; a hit rebuilds the same region through the writer API', async () => {
    const cold = await genRegion({ ...base, cache: false });
    const a = await genRegion(base);
    expect(a.cacheHit).toBe(false);
    expect(files()).toEqual([`${hex64(regionCacheKey(keyOf(base)))}.bin`]);
    const b = await genRegion(base);
    expect(b.cacheHit).toBe(true);
    expect(b.view.hash()).toBe(cold.view.hash());
    expect(b.columnsPerThread).toEqual([0]);
    expect(b.timings.perColumnMs.length).toBe(4);
    for (let cz = -1; cz < 1; cz++) {
      for (let cx = 3; cx < 5; cx++) {
        const dense = (d: Int32Array) => [...d].map((x) => (x >= 0 ? 'dense' : x));
        expect(dense(b.view.descriptors(cx, cz))).toEqual(dense(cold.view.descriptors(cx, cz)));
        const base2 = b.view.store.table.find(cx, cz);
        expect(b.view.store.table.status(base2)).toBe(1);
        expect(b.view.store.table.blockVersion(base2)).toBe(1);
      }
    }
    for (const [x, z] of [[48, -16], [79, 15], [60, -3]] as const) {
      for (let y = -64; y < 320; y += 7) expect(b.view.block(x, y, z)).toBe(cold.view.block(x, y, z));
      expect(b.view.biome(x, z)).toBe(cold.view.biome(x, z));
      expect(b.view.worldSurfaceWG(x, z)).toBe(cold.view.worldSurfaceWG(x, z));
    }
    // The live slots are exactly the dense entries plus the aux slots (nothing leaked by the rebuild).
    let dense = 0;
    let denseBytes = 0;
    for (let cz = -1; cz < 1; cz++) {
      for (let cx = 3; cx < 5; cx++) {
        const d = b.view.descriptors(cx, cz);
        for (let sy = 0; sy < 24; sy++) {
          if (d[2 * sy]! >= 0) dense++;
          if (d[2 * sy + 1]! >= 0) denseBytes++;
        }
      }
    }
    const s = b.view.store;
    expect(s.blockPool.slotCount() - s.blockPool.freeCount()).toBe(dense);
    expect(s.bytePool.slotCount() - s.bytePool.freeCount()).toBe(denseBytes + 4);
  });

  test('a changed srcKey is a miss and writes its own dump', async () => {
    await genRegion(base);
    const other: Hash64 = [0x12345678, 0x9abcdef0];
    const r = await genRegion({ ...base, srcKey: other });
    expect(r.cacheHit).toBe(false);
    expect(files()).toEqual([`${hex64(regionCacheKey(keyOf(base)))}.bin`, `${hex64(regionCacheKey(keyOf(base, other)))}.bin`].sort());
    expect((await genRegion({ ...base, srcKey: other })).cacheHit).toBe(true);
    expect((await genRegion(base)).cacheHit).toBe(true);
  });

  test('a header that disagrees with the key is a miss and the file is overwritten', async () => {
    const shifted = { ...base, cx0: 4 };
    await genRegion(shifted);
    const right = regionCachePath(keyOf(base), DIR);
    // The dump of another region under this key's name.
    copyFileSync(regionCachePath(keyOf(shifted), DIR), right);
    const wrong = readFileSync(right);
    const r = await genRegion(base);
    expect(r.cacheHit).toBe(false);
    expect(readFileSync(right).equals(wrong)).toBe(false);
    const again = await genRegion(base);
    expect(again.cacheHit).toBe(true);
    expect(again.view.hash()).toBe(r.view.hash());
  });

  test.each([
    ['a changed header field (format)', (b: Buffer) => { b.writeUInt32LE(b.readUInt32LE(4) + 1, 4); return b; }],
    ['a changed header field (w)', (b: Buffer) => { b.writeUInt32LE(3, 32); return b; }],
    ['a truncated file', (b: Buffer) => b.subarray(0, b.length - 1)],
    ['an empty file', () => Buffer.alloc(0)],
    ['a column record of another column', (b: Buffer) => { b.writeInt32LE(b.readInt32LE(44) + 64, 44); return b; }],
    ['a dense slot overwritten with one value (same length)', (b: Buffer) => { const [o, n] = firstDenseSlot(b); b.fill(0, o, o + n); return b; }],
    ['one flipped bit in a dense slot (same length)', (b: Buffer) => { b[firstDenseSlot(b)[0] + 100]! ^= 1; return b; }],
    ['one flipped bit in the last column\'s aux bytes (same length)', (b: Buffer) => { b[b.length - 2048]! ^= 4; return b; }],
    ['a trailing byte appended', (b: Buffer) => Buffer.concat([b, Buffer.alloc(1)])],
  ] as const)('%s is a miss and the file is rewritten', async (_what, damage) => {
    const first = await genRegion(base);
    const path = regionCachePath(keyOf(base), DIR);
    const good = readFileSync(path);
    const out = damage(Buffer.from(good));
    writeFileSync(path, out);
    const r = await genRegion(base);
    expect(r.cacheHit).toBe(false);
    expect(r.view.hash()).toBe(first.view.hash());
    expect(readFileSync(path).equals(good)).toBe(true);
    expect(statSync(path).size).toBe(good.length);
  });

  test('the header: magic, format, genKey, srcKey, cx0, cz0, w, h, upTo; then the first record', async () => {
    await genRegion(base);
    const b = readFileSync(regionCachePath(keyOf(base), DIR));
    const k = keyOf(base);
    expect(b.toString('latin1', 0, 4)).toBe('WIRC');
    expect([b.readUInt32LE(4), b.readUInt32LE(8), b.readUInt32LE(12), b.readUInt32LE(16), b.readUInt32LE(20)])
      .toEqual([REGION_CACHE_FORMAT, k.genKey[0], k.genKey[1], k.srcKey[0], k.srcKey[1]]);
    expect([b.readInt32LE(24), b.readInt32LE(28), b.readUInt32LE(32), b.readUInt32LE(36), b.toString('latin1', 40, 44)]).toEqual([3, -1, 2, 2, 'T\0\0\0']);
    // Column (3, −1) first: record ints 0-3 are cx, cz, status Proto, epoch 0.
    expect([b.readInt32LE(44), b.readInt32LE(48), b.readInt32LE(52), b.readInt32LE(56)]).toEqual([3, -1, 1, 0]);
    // The last 8 bytes are the FNV-1a 64 (lo, hi) of everything before them.
    expect([b.readUInt32LE(b.length - 8), b.readUInt32LE(b.length - 4)]).toEqual([...fnv1a64Bytes(b.subarray(0, b.length - 8))]);
  });

  test('writing a dump deletes the dumps of other srcKeys untouched for REGION_CACHE_PRUNE_MS; this srcKey\'s and recent ones stay', async () => {
    expect(REGION_CACHE_PRUNE_MS).toBe(15 * 60 * 1000);
    const k1: Hash64 = [1, 1];
    const k2: Hash64 = [2, 2];
    const at = (o: Partial<GenRegionOptions>, src: Hash64) => regionCachePath(keyOf({ ...base, ...o }, src), DIR);
    const age = (path: string) => { const t = new Date(Date.now() - 2 * REGION_CACHE_PRUNE_MS); utimesSync(path, t, t); };
    await genRegion({ ...base, srcKey: k1 });
    await genRegion({ ...base, cx0: 4, srcKey: k1 });
    await genRegion({ ...base, srcKey: k2 });
    // Every dump is recent: nothing is deleted, whatever its srcKey.
    expect(files()).toHaveLength(3);
    // An old dump of k1, an old dump of k2, an old file that is no dump, a foreign file and a temporary file.
    age(at({}, k1));
    age(at({}, k2));
    writeFileSync(join(DIR, 'junk.bin'), 'not a dump');
    age(join(DIR, 'junk.bin'));
    writeFileSync(join(DIR, 'notes.txt'), 'kept');
    age(join(DIR, 'notes.txt'));
    writeFileSync(join(DIR, 'x.bin.1.2.tmp'), 'in flight');
    age(join(DIR, 'x.bin.1.2.tmp'));
    // A miss of k2 writes its dump and deletes what can never hit again: the old k1 dump and the junk.
    expect((await genRegion({ ...base, cz0: 0, srcKey: k2 })).cacheHit).toBe(false);
    const left = [at({}, k2), at({ cx0: 4 }, k1), at({ cz0: 0 }, k2)].map((p) => p.slice(DIR.length)).concat(['notes.txt', 'x.bin.1.2.tmp']);
    expect(files()).toEqual(left.sort());
    // The old dump of k2 (this srcKey) stayed and still hits; k1's recent dump goes once it is old too.
    expect((await genRegion({ ...base, srcKey: k2 })).cacheHit).toBe(true);
    age(at({ cx0: 4 }, k1));
    await genRegion({ ...base, cx0: 5, srcKey: k2 });
    expect(existsSync(at({ cx0: 4 }, k1))).toBe(false);
    expect(existsSync(at({}, k2))).toBe(true);
  });
});

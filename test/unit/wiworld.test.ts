/**
 * `.wiworld` (SP5b spec §2.4, D15, D22, D23, E2): export → import over a `MemoryKV` (every saved part equal but the id
 * and `updated`, and `wiworldHash` equal), the hash's independence from the gzip bytes, each column's bytes and header
 * genKey kept, D15's refusals writing nothing, an undecodable record skipped and counted, the normaliser on the
 * imported `state` and `history`, and Review Focus 3: a file from another `stateTable` and an older generator.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, test, vi } from 'vitest';
import { GENERATOR_VERSION } from '../../src/core/constants';
import { colKey, colKeyCx, colKeyCz } from '../../src/core/coords';
import { hex64, parseHex64, type Hash64, type Seed64 } from '../../src/core/hash';
import { canonicalJSON } from '../../src/core/params/canonical';
import { SCHEMA_VERSION, type JsonObject } from '../../src/core/params/migrate';
import { resolveProfile, type ProfileId } from '../../src/core/params/profiles';
import { genKey, paramsHash, stageHashes } from '../../src/core/stage/hash';
import { decodeColumnDiff, encodeColumnDiff } from '../../src/persist/diffCodec';
import { createMemoryKV, type MemoryKV } from '../../src/persist/memory';
import {
  createSaves, DEFAULT_SPEED, DEFAULT_T, HISTORY_STEPS, loadParams, MAX_NAME, MAX_PLACES, NO_VALUE, normalizeHistory,
  normalizeState, olderGenerator, todayStateTable, type HistoryRecord, type WorldDump, type WorldRecord,
} from '../../src/persist/saves';
import { readWiworld, WIWORLD_VERSION, wiworldHash, writeWiworld } from '../../src/persist/wiworld';
import { STATE_BOUNDS } from '../../src/ui/world/stateBounds';
import { REGISTRY } from '../../src/world/blocks';

const S = (key: string): number => REGISTRY.parseStateKey(key);
const NOW = 1_900_000_000_000;

/** A saved world's record as the menu's Create writes it: the profile's parameters, their hash and genKey. */
function worldOf(id: string, profile: ProfileId, seed: Seed64): WorldRecord {
  const params = JSON.parse(canonicalJSON(resolveProfile(profile))) as JsonObject;
  const loaded = loadParams({ params, schemaVersion: SCHEMA_VERSION, profile });
  if (!loaded.ok) throw new Error('the profile does not load');
  return {
    id, name: 'Alpha', seedText: String(seed[0]), seed: [seed[0], seed[1]], profile, params, schemaVersion: SCHEMA_VERSION,
    paramsHash: hex64(paramsHash(loaded.value)), generatorVersion: GENERATOR_VERSION, genKey: hex64(genKey(seed, stageHashes(loaded.value))),
    stateTable: todayStateTable(), created: 1_600_000_000_000, backupOf: null,
  };
}

/** One column's `ColumnDiffV1` from `[sy, idx, value]` entries (any order). */
function column(entries: readonly (readonly [number, number, number])[], gk: Hash64): Uint8Array {
  return encodeColumnDiff({
    sy: Uint8Array.from(entries, (e) => e[0]), idx: Uint16Array.from(entries, (e) => e[1]), value: Uint32Array.from(entries, (e) => e[2]),
  }, gk);
}

/** A dense section's 3,000 entries of `value` at `sy`. */
const dense = (sy: number, value: number) => Array.from({ length: 3000 }, (_, i) => [sy, i, value] as const);

/**
 * The source world: amplified, a walking player, a time and a hotbar, two places, a history on both sides, and three
 * edited columns (one with a dense section, one with a water entry); every part as the normaliser leaves it.
 */
function sourceDump(id = 'source'): WorldDump {
  const world = worldOf(id, 'amplified', [42, 7]);
  const gk = parseHex64(world.genKey);
  const raw = {
    worldId: id, flushSeq: 9, updated: 1_700_000_000_000,
    player: { x: 10.5, y: 80, z: -20.25, yaw: 90, pitch: -10, mode: 'walk', speed: 30 },
    time: { t: 0.4, speedIndex: 2 },
    hotbar: { ...STATE_BOUNDS.normalizeHotbar(null), active: 3 },
    places: [
      { id: 'p1', name: 'Home', colour: 2, x: 1, y: 70, z: -1, yaw: 45, pitch: 0 },
      { id: 'p2', name: 'Peak', colour: 7, x: 900, y: 250, z: 300, yaw: -90, pitch: -30 },
    ],
  };
  const state = normalizeState(raw, id, STATE_BOUNDS).state;
  expect(state.player?.mode).toBe('walk');
  const history: HistoryRecord = {
    worldId: id,
    done: [{ edits: [{ x: 1, y: 64, z: 2, before: NO_VALUE, after: S('stone') << 8 }] }, { edits: [{ x: 3, y: 65, z: 2, before: S('dirt') << 8, after: 0 }] }],
    undone: [{ edits: [{ x: -5, y: 66, z: 9, before: NO_VALUE, after: S('oak_planks') << 8 }] }],
  };
  const cols = [
    { key: colKey(-3, 5), bytes: column([[4, 17, S('stone') << 8], [4, 18, 0], [10, 4095, S('glass') << 8]], gk) },
    { key: colKey(0, 0), bytes: column([...dense(5, S('dirt') << 8), [6, 0, S('stone') << 8]], gk) },
    { key: colKey(100, -200), bytes: column([[2, 1, (S('air') << 8) | 1]], gk) },
  ].sort((a, b) => a.key - b.key);
  return { world, state, history, cols };
}

/** The file's uncompressed content. */
const unzip = async (b: Blob): Promise<Uint8Array> => new Uint8Array(gunzipSync(new Uint8Array(await b.arrayBuffer())));

/** A file's content: the magic, `version`, the header text and the records' bytes (`raw` appended as is). */
function content(version: number, header: string, records: readonly { cx: number; cz: number; bytes: Uint8Array }[], raw?: Uint8Array): Uint8Array {
  const h = new TextEncoder().encode(header);
  const parts: Uint8Array[] = [];
  const pre = new Uint8Array(12);
  pre.set([0x57, 0x49, 0x31, 0x30]);
  new DataView(pre.buffer).setUint32(4, version, true);
  new DataView(pre.buffer).setUint32(8, h.length, true);
  parts.push(pre, h);
  for (const r of records) {
    const f = new Uint8Array(12);
    const v = new DataView(f.buffer);
    v.setInt32(0, r.cx, true);
    v.setInt32(4, r.cz, true);
    v.setUint32(8, r.bytes.length, true);
    parts.push(f, r.bytes);
  }
  if (raw !== undefined) parts.push(raw);
  return new Uint8Array(Buffer.concat(parts));
}

/** A header's text, as the export writes it. */
const headerText = (d: WorldDump, over: Record<string, unknown> = {}): string => {
  const { id: _id, ...world } = d.world;
  const { worldId: _w, ...state } = d.state;
  return canonicalJSON({ format: 'wi10-world', world, state, history: d.history, ...over });
};

const recordsOf = (d: WorldDump) => d.cols.map((c) => ({ cx: colKeyCx(c.key), cz: colKeyCz(c.key), bytes: c.bytes }));

/** The menu's Import over `kv`: `readWiworld`, then one `writeAll` when it reads. */
async function importInto(kv: MemoryKV, file: Blob | Uint8Array, newId = 'imported') {
  const r = await readWiworld(file, STATE_BOUNDS, newId, NOW);
  if (r.ok) expect((await createSaves(kv).writeAll(r.dump)).status).toBe('complete');
  return r;
}

describe('.wiworld export → import (SP5b spec §2.4, D15, D23, E2)', () => {
  test('export → import of a world with edits, places, history, a walking player and `amplified`: every saved part equal except `id` and `updated`, and `wiworldHash` equal', async () => {
    const kv = createMemoryKV();
    const saves = createSaves(kv);
    const src = sourceDump();
    expect((await saves.writeAll(src)).status).toBe('complete');
    const exported = await saves.readAll('source');
    expect(exported).not.toBeNull();
    const blob = await writeWiworld(exported!);
    const r = await importInto(kv, blob);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.skippedColumns, r.unknownStates]).toEqual([0, 0]);
    const back = await saves.readAll('imported');
    expect(back).not.toBeNull();
    expect(back!.world).toEqual({ ...src.world, id: 'imported' });
    expect(back!.state).toEqual({ ...src.state, worldId: 'imported', updated: NOW });
    expect(back!.history).toEqual({ ...src.history!, worldId: 'imported' });
    expect(back!.cols).toEqual(src.cols);
    expect(wiworldHash(back!)).toBe(wiworldHash(src));
    expect(wiworldHash(r.dump)).toBe(wiworldHash(src));
    // The hash is not blind: another place changes it.
    expect(wiworldHash({ ...src, state: { ...src.state, places: src.state.places.slice(1) } })).not.toBe(wiworldHash(src));
  });

  test('the file\'s content: "WI10", `version` 1, the header as canonical JSON (the record without `id`, the state without `worldId`), then the records by colKey', async () => {
    const src = sourceDump();
    const raw = await unzip(await writeWiworld({ ...src, cols: [...src.cols].reverse() }));
    expect(Buffer.from(raw).equals(Buffer.from(content(WIWORLD_VERSION, headerText(src), recordsOf(src))))).toBe(true);
    expect(WIWORLD_VERSION).toBe(1);
  });

  test('the gzip bytes are never hashed: the hash of a re-compressed file is equal', async () => {
    const src = sourceDump();
    const blob = await writeWiworld(src);
    const gz = new Uint8Array(await blob.arrayBuffer());
    const recompressed = new Uint8Array(gzipSync(gunzipSync(gz), { level: 1 }));
    expect(Buffer.from(recompressed).equals(Buffer.from(gz))).toBe(false);
    const a = await readWiworld(blob, STATE_BOUNDS, 'a', NOW);
    const b = await readWiworld(recompressed, STATE_BOUNDS, 'b', NOW);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(wiworldHash(b.dump)).toBe(wiworldHash(a.dump));
    expect(wiworldHash(a.dump)).toBe(wiworldHash(src));
  });

  test('a world with a column flushed before an Apply (its header the earlier genKey) and one after: export → import keeps each column\'s bytes and header genKey, and `wiworldHash` is equal', async () => {
    const src = sourceDump();
    const before: Hash64 = [0x11111111, 0x22222222];
    const after = parseHex64(src.world.genKey);
    const d: WorldDump = {
      ...src,
      cols: [
        { key: colKey(1, 1), bytes: column([[3, 9, S('stone') << 8]], before) },
        { key: colKey(1, 2), bytes: column([[3, 9, S('dirt') << 8]], after) },
      ],
    };
    const r = await importInto(createMemoryKV(), await writeWiworld(d));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dump.cols).toEqual(d.cols);
    expect(r.dump.cols.map((c) => decodeColumnDiff(c.bytes, REGISTRY.stateCount).genKey)).toEqual([before, after]);
    expect(wiworldHash(r.dump)).toBe(wiworldHash(d));
  });
});

describe('.wiworld refusals and repairs (SP5b spec §2.4, D15, §2.1)', () => {
  /** `importInto` that must refuse with `reason` and write nothing. */
  async function refused(file: Uint8Array, reason: string): Promise<void> {
    const kv = createMemoryKV();
    const write = vi.spyOn(kv, 'write');
    const r = await importInto(kv, file);
    expect(r).toEqual({ ok: false, reason });
    expect(write).not.toHaveBeenCalled();
    for (const store of ['worlds', 'state', 'history', 'diffs'] as const) expect(kv.dump(store)).toEqual([]);
  }

  test('bad magic → `Not a .wiworld file`; `version` 2 → `Made by a newer version of world-imaginer-voxel`; a truncated record → `The file is damaged`; each writes nothing', async () => {
    const src = sourceDump();
    const good = content(1, headerText(src), recordsOf(src));
    const badMagic = good.slice();
    badMagic[3] = 0x31;
    await refused(new Uint8Array(gzipSync(badMagic)), 'Not a .wiworld file');
    // Not gzip at all, and a header of another format.
    await refused(good, 'Not a .wiworld file');
    await refused(new Uint8Array(gzipSync(content(1, headerText(src, { format: 'wi10-preset' }), []))), 'Not a .wiworld file');
    await refused(new Uint8Array(gzipSync(content(2, headerText(src), recordsOf(src)))), 'Made by a newer version of world-imaginer-voxel');
    // The last record's bytes cut short: its `len` points past the end.
    await refused(new Uint8Array(gzipSync(good.subarray(0, good.length - 3))), 'The file is damaged');
    // A frame cut short, a header past the end, a header that is not JSON, parameters that do not load.
    await refused(new Uint8Array(gzipSync(content(1, headerText(src), recordsOf(src), new Uint8Array(5)))), 'The file is damaged');
    const longHeader = good.slice();
    new DataView(longHeader.buffer).setUint32(8, good.length, true);
    await refused(new Uint8Array(gzipSync(longHeader)), 'The file is damaged');
    await refused(new Uint8Array(gzipSync(content(1, '{"format":', []))), 'The file is damaged');
    await refused(new Uint8Array(gzipSync(content(1, headerText(src, { world: { ...src.world, id: undefined, schemaVersion: 99 } }), []))), 'The file is damaged');
    // A gzip stream cut short.
    const gz = gzipSync(good);
    await refused(new Uint8Array(gz.subarray(0, gz.length - 20)), 'The file is damaged');
  });

  test('a record that fails to decode is skipped and counted; the rest import', async () => {
    const src = sourceDump();
    const records = recordsOf(src);
    const broken = records[1]!.bytes.slice();
    broken[0] = 2; // `v` 2
    const kv = createMemoryKV();
    const r = await importInto(kv, new Uint8Array(gzipSync(content(1, headerText(src), [records[0]!, { ...records[1]!, bytes: broken }, records[2]!]))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skippedColumns).toBe(1);
    expect(r.dump.cols).toEqual([src.cols[0], src.cols[2]]);
    expect(kv.dump('diffs').map(([k]) => k)).toEqual([['imported', src.cols[0]!.key], ['imported', src.cols[2]!.key]]);
  });

  test('each `state` and `history` field §2.1 normalises arrives normalised', async () => {
    const src = sourceDump();
    const longName = 'x'.repeat(MAX_NAME + 10);
    const place = (i: number, over: Record<string, unknown> = {}) => ({ id: `p${i}`, name: `P${i}`, colour: i % 8, x: i, y: 70, z: 0, yaw: 0, pitch: 0, ...over });
    const badState = {
      flushSeq: -3, updated: 5,
      player: { x: 1, y: 70, z: 2, yaw: 0, pitch: 0, mode: 'swim', speed: 500 },
      time: { t: 1.5, speedIndex: 99 },
      hotbar: { v: 1, active: 42, slots: [{ type: 'nope' }] },
      places: [place(0, { colour: 9 }), place(1, { name: longName }), ...Array.from({ length: MAX_PLACES + 5 }, (_, i) => place(i + 2))],
    };
    const goodStep = { edits: [{ x: 1, y: 64, z: 2, before: NO_VALUE, after: S('stone') << 8 }] };
    const badHistory = {
      worldId: 'whatever',
      done: [{ edits: [{ x: 1, y: 1000, z: 2, before: NO_VALUE, after: S('stone') << 8 }] }, ...Array.from({ length: HISTORY_STEPS + 3 }, () => goodStep)],
      undone: [{ edits: [{ x: 1, y: 64, z: 2, before: NO_VALUE, after: REGISTRY.stateCount << 8 }] }],
    };
    const r = await importInto(createMemoryKV(), new Uint8Array(gzipSync(content(1, headerText(src, { state: badState, history: badHistory }), []))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.dump.state;
    expect(s).toEqual({ ...normalizeState(badState, 'imported', STATE_BOUNDS).state, updated: NOW });
    expect(s.worldId).toBe('imported');
    expect(s.flushSeq).toBe(0);
    expect([s.player?.mode, s.player?.speed]).toEqual(['fly', DEFAULT_SPEED]);
    expect(s.time).toEqual({ t: DEFAULT_T, speedIndex: 0 });
    expect(s.hotbar).toEqual(STATE_BOUNDS.normalizeHotbar({ v: 1, active: 0, slots: [] }));
    expect(s.places.length).toBe(MAX_PLACES);
    expect(s.places[0]!.id).toBe('p1');
    expect(s.places[0]!.name).toBe(longName.slice(0, MAX_NAME));
    expect(r.dump.history).toEqual(normalizeHistory(badHistory, 'imported', null).history);
    expect(r.dump.history!.worldId).toBe('imported');
    expect(r.dump.history!.done.length).toBe(HISTORY_STEPS);
    expect(r.dump.history!.undone).toEqual([]);
  });

  test('the header\'s name is trimmed and cut to `MAX_NAME` code points; an empty one becomes `newWorldName`\'s proposal among `taken` (D2, MENU-5)', async () => {
    const src = sourceDump();
    const named = async (name: string, taken?: readonly string[]) => {
      const r = await readWiworld(await writeWiworld({ ...src, world: { ...src.world, name } }), STATE_BOUNDS, 'imported', NOW, taken);
      if (!r.ok) throw new Error(r.reason);
      return r.dump.world.name;
    };
    expect(await named('')).toBe('New world 1');
    expect(await named('   ', ['New world 1', 'New world 2'])).toBe('New world 3');
    expect(await named(`  ${'é'.repeat(70)}  `)).toBe('é'.repeat(MAX_NAME));
    const astral = await named('😀'.repeat(70));
    expect([Array.from(astral).length, astral]).toEqual([MAX_NAME, '😀'.repeat(MAX_NAME)]);
    expect(await named('My world')).toBe('My world');
  });

  test('a header without a history imports with none', async () => {
    const src = sourceDump();
    const r = await readWiworld(await writeWiworld({ ...src, history: null }), STATE_BOUNDS, 'imported', NOW);
    expect(r.ok && r.dump.history).toBe(null);
  });

  test('Review Focus 3: a file whose header\'s `stateTable` is today\'s 58 keys permuted and cut to 55 plus one unknown key `nope[x=1]`, with a stored genKey of another generator: imports with every voxel equal by state key, the unknown key\'s 3 voxels air, the record\'s `stateTable` today\'s, its records re-encoded under today\'s ids, and `olderGenerator` true; a file whose `version` is 2 is refused with nothing written', async () => {
    const today = todayStateTable();
    expect(today.length).toBe(58);
    const table = [...[...today].reverse().slice(0, 55), 'nope[x=1]'];
    const unknownId = table.indexOf('nope[x=1]');
    const src = sourceDump();
    const storedKey: Hash64 = [0xdeadbeef, 0x01234567];
    const world: WorldRecord = { ...src.world, stateTable: table, genKey: hex64(storedKey) };
    // One entry per known stored id at sy 3 (a fluid byte on every 4th), and the unknown id's 3 voxels at sy 7.
    const entries: (readonly [number, number, number])[] = table.flatMap((_, id) => (id === unknownId ? [] : [[3, id, ((id << 8) | (id % 4 === 0 ? 1 : 0)) >>> 0] as const]));
    for (const idx of [100, 200, 300]) entries.push([7, idx, unknownId << 8]);
    const d: WorldDump = { world, state: src.state, history: null, cols: [{ key: colKey(2, -2), bytes: column(entries, storedKey) }] };
    const kv = createMemoryKV();
    const r = await importInto(kv, await writeWiworld(d));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknownStates).toBe(3);
    expect(r.skippedColumns).toBe(0);
    expect(r.dump.world.stateTable).toEqual(today);
    expect((await createSaves(kv).readAll('imported'))!.world.stateTable).toEqual(today);
    const [col] = r.dump.cols;
    const decoded = decodeColumnDiff(col!.bytes, REGISTRY.stateCount);
    expect(decoded.genKey).toEqual(storedKey);
    expect(encodeColumnDiff(decoded.diff, decoded.genKey)).toEqual(col!.bytes);
    const byVoxel = new Map<number, number>();
    for (let i = 0; i < decoded.diff.value.length; i++) byVoxel.set(decoded.diff.sy[i]! * 4096 + decoded.diff.idx[i]!, decoded.diff.value[i]!);
    expect(byVoxel.size).toBe(entries.length);
    for (const [sy, idx, value] of entries) {
      const got = byVoxel.get(sy * 4096 + idx)!;
      const key = table[value >>> 8]!;
      if (key === 'nope[x=1]') expect(got, `voxel ${sy}/${idx}`).toBe(0);
      else expect([REGISTRY.stateKey(got >>> 8), got & 0xFF], `voxel ${sy}/${idx}`).toEqual([key, value & 0xFF]);
    }
    const p = loadParams(r.dump.world);
    expect(p.ok).toBe(true);
    if (p.ok) expect(olderGenerator(r.dump.world, p.value)).toBe(true);

    const raw = await unzip(await writeWiworld(d));
    new DataView(raw.buffer, raw.byteOffset).setUint32(4, 2, true);
    const other = createMemoryKV();
    const write = vi.spyOn(other, 'write');
    expect(await importInto(other, new Uint8Array(gzipSync(raw)))).toEqual({ ok: false, reason: 'Made by a newer version of world-imaginer-voxel' });
    expect(write).not.toHaveBeenCalled();
  });
});
